/**
 * wakeups.ts -- absolute wake scheduler core for pi-billing-window (spec 012).
 *
 * Три ответственности (TD-001):
 *   (a) чистые функции над таблицей точек пробуждения (без I/O);
 *   (b) персистенция таблицы в ~/.pi/agent/pi-billing-window-wakeups.json
 *       под proper-lockfile (паттерн state.ts: retry-бюджет, tmp+rename,
 *       парсинг-толерантность -- битый/чужой файл тихо даёт null);
 *   (c) one-shot wake-таймер-примитив armWakeTimer/clearWakeTimer
 *       (паттерн watchdog.ts: unref, self-correcting delay).
 *
 * Точка wake = anchor + windowMs + WAKE_MARGIN_MS (маржа 2 мин, D-003).
 * Passive observer: ни одна ошибка файла/лока не бросается наружу --
 * warn (однократный на процесс) + тихая деградация (NFR-012-2).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import lockfile from "proper-lockfile";

// ---- Constants ----

/** Маржа до границы окна: точка ставится на windowMs + 2 мин (FR-012-3). */
export const WAKE_MARGIN_MS = 2 * 60_000;
/** Глубина таблицы: максимум точек (FR-012-4, TD-004). */
export const WAKE_DEPTH = 12;
/** TTL сгоревшей точки: точка старше 30 мин гасится без стрельбы (FR-012-10). */
export const WAKE_BURNED_TTL_MS = 30 * 60_000;
/**
 * R1 (resolved): минимальный интервал между точками в appendAnchorPoint --
 * якорная точка ближе 60 с к существующей НЕ вставляется (reset-дедуп
 * остаётся страховкой).
 */
export const WAKE_APPEND_EPSILON_MS = 60_000;

// ---- Types ----

/** Схема wakeups.json (version 1, TD-003). points строго возрастающие. */
export type WakeTable = {
  version: 1;
  /** epoch ms, строго возрастающие, <= WAKE_DEPTH. Пустой массив легален. */
  points: number[];
  /** epoch ms последнего изменения. */
  updatedAt: number;
  /** Происхождение последней перестройки (информационное, TD-003). */
  source: "firstCall" | "settimer";
};

// ---- Pure functions (no I/O, unit-testable) ----

/**
 * Полная таблица от якоря: points = anchor + windowMs + margin + k*windowMs,
 * k = 0..depth-1 (FR-012-4; R2 -- одинаковые полные 12 точек для auto-якоря
 * и /settimer).
 */
export function computeTableFromAnchor(
  anchorTs: number,
  windowMs: number,
  marginMs: number = WAKE_MARGIN_MS,
  depth: number = WAKE_DEPTH,
  source: WakeTable["source"] = "firstCall",
): WakeTable {
  const first = anchorTs + windowMs + marginMs;
  const points: number[] = [];
  for (let k = 0; k < depth; k++) {
    points.push(first + k * windowMs);
  }
  return { version: 1, points, updatedAt: Date.now(), source };
}

/**
 * Ближайшая не-сгоревшая точка: минимальная p с p + WAKE_BURNED_TTL_MS > now.
 * null -- таблицы нет, она пуста или все точки сгорели (включая прошедшие
 * точки в пределах TTL -- они всё ещё "исполнимые", см. design §11).
 */
export function nextDuePoint(
  table: WakeTable | null,
  now: number,
): number | null {
  if (table === null || table.points.length === 0) return null;
  let min: number | null = null;
  for (const p of table.points) {
    if (p + WAKE_BURNED_TTL_MS > now && (min === null || p < min)) {
      min = p;
    }
  }
  return min;
}

/**
 * Чистая фильтрация сгоревших: выбрасывает точки с now > p + ttlMs (strict --
 * ровно на границе p + ttl точка ещё жива). Персистенция -- отдельно,
 * через mutateWakeTable.
 */
export function dropBurnedPoints(
  table: WakeTable,
  now: number,
  ttlMs: number = WAKE_BURNED_TTL_MS,
): WakeTable {
  return { ...table, points: table.points.filter((p) => now <= p + ttlMs) };
}

/**
 * Дописать якорную точку anchor + windowMs + margin (TD-004, операция 2):
 *   - вставка по возрастанию; R1: точка ближе WAKE_APPEND_EPSILON_MS к
 *     существующей НЕ вставляется;
 *   - top-up хвоста до depth (last + windowMs, пока длина < depth);
 *   - усечение свыше depth с конца (теряются только дальние спекулятивные
 *     точки, активная голова не теряется никогда).
 */
export function appendAnchorPoint(
  table: WakeTable,
  anchorTs: number,
  windowMs: number,
  marginMs: number = WAKE_MARGIN_MS,
  depth: number = WAKE_DEPTH,
): WakeTable {
  const target = anchorTs + windowMs + marginMs;
  const points = [...table.points];
  const tooClose = points.some((p) => Math.abs(p - target) < WAKE_APPEND_EPSILON_MS);
  if (!tooClose) {
    points.push(target);
    points.sort((a, b) => a - b);
  }
  // Top-up tail from the last point until the table is full again.
  while (points.length < depth) {
    points.push(points[points.length - 1] + windowMs);
  }
  // Truncate the far speculative tail, never the active head.
  const kept = points.length > depth ? points.slice(0, depth) : points;
  return { ...table, points: kept };
}

// ---- Persistence (lock + tmp/rename, state.ts pattern) ----

let wakeFile = path.join(os.homedir(), ".pi", "agent", "pi-billing-window-wakeups.json");
let wakeLockFile = path.join(os.homedir(), ".pi", "agent", "pi-billing-window-wakeups.lock");

/** "Уже жаловались на битый файл" -- однократный warn на процесс (TD-003). */
let warnedBadTable = false;
/** Однократный warn на занятый лок (ELOCKED после retry-бюджета). */
let warnedLockBusy = false;

/** Tests: redirect the wakeups file/lock (resets warn flags, history.ts pattern). */
export function setWakePaths(newFile: string, newLock: string): void {
  wakeFile = newFile;
  wakeLockFile = newLock;
  warnedBadTable = false;
  warnedLockBusy = false;
}

/** Tests: restore the default paths (resets warn flags). */
export function resetPaths(): void {
  wakeFile = path.join(os.homedir(), ".pi", "agent", "pi-billing-window-wakeups.json");
  wakeLockFile = path.join(os.homedir(), ".pi", "agent", "pi-billing-window-wakeups.lock");
  warnedBadTable = false;
  warnedLockBusy = false;
}

export function getWakeFile(): string {
  return wakeFile;
}

/** Строгая валидация схемы version 1 (любое отклонение -> null, TD-003). */
function isValidWakeTable(t: unknown): t is WakeTable {
  if (typeof t !== "object" || t === null) return false;
  const o = t as Record<string, unknown>;
  if (o.version !== 1) return false;
  if (!Array.isArray(o.points)) return false;
  for (const p of o.points) {
    if (typeof p !== "number" || !Number.isFinite(p)) return false;
  }
  for (let i = 1; i < o.points.length; i++) {
    if (!(o.points[i] > o.points[i - 1])) return false; // строго возрастающие
  }
  if (typeof o.updatedAt !== "number" || !Number.isFinite(o.updatedAt)) return false;
  if (o.source !== "firstCall" && o.source !== "settimer") return false;
  return true;
}

function warnBadTableOnce(): void {
  if (!warnedBadTable) {
    warnedBadTable = true;
    console.warn(
      "pi-billing-window: wakeups.json повреждён или имеет чужую схему -- " +
        "таблица будет тихо пересоздана при следующем якоре",
    );
  }
}

/**
 * Толерантный sync-read (паттерн readStateSync): нет файла -> null (молча);
 * битый JSON / version != 1 / points не числа -> null + ОДНОКРАТНЫЙ warn
 * (флаг сбрасывается при успешном чтении). points: [] легален.
 */
export function readWakeTable(): WakeTable | null {
  try {
    if (!fs.existsSync(wakeFile)) return null;
    const raw = fs.readFileSync(wakeFile, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnBadTableOnce();
      return null;
    }
    if (!isValidWakeTable(parsed)) {
      warnBadTableOnce();
      return null;
    }
    warnedBadTable = false;
    return parsed;
  } catch {
    // Any fs failure degrades to "no table" (NFR-012-2).
    warnBadTableOnce();
    return null;
  }
}

/** tmp + renameSync -- atomic write, exactly the writeStateSync pattern. */
function writeWakeTableSync(table: WakeTable): void {
  fs.mkdirSync(path.dirname(wakeFile), { recursive: true });
  const tmp = wakeFile + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(table, null, 2), "utf8");
  fs.renameSync(tmp, wakeFile);
}

/**
 * Одна мутация таблицы под proper-lockfile (retry-бюджет как state.ts:
 * retries 20, 100-200 ms). ELOCKED -> тихий пропуск без throw (NFR-012-2),
 * следующий якорь/тик повторит. Никогда не бросает -- warn + false.
 * Возвращает true, если мутация прошла (в т.ч. next:null no-op), false -- пропуск.
 */
export async function mutateWakeTable(
  transform: (current: WakeTable | null) => { next: WakeTable | null },
): Promise<boolean> {
  try {
    const dir = path.dirname(wakeLockFile);
    fs.mkdirSync(dir, { recursive: true });
    // Marker FILE at the lock path itself (proven arms/history pattern):
    // proper-lockfile canonicalizes with realpath BEFORE creating the
    // `<lock>.lock` directory, so the target must exist.
    if (!fs.existsSync(wakeLockFile)) fs.writeFileSync(wakeLockFile, "{}", "utf8");
    await lockfile.lock(wakeLockFile, {
      retries: { retries: 20, factor: 1, minTimeout: 100, maxTimeout: 200 },
    });
    try {
      const current = readWakeTable();
      const { next } = transform(current);
      if (next !== null) {
        // updatedAt always stamped at write time ("когда менялась таблица").
        writeWakeTableSync({ ...next, updatedAt: Date.now() });
      }
      return true;
    } finally {
      try {
        await lockfile.unlock(wakeLockFile);
      } catch {
        // Ignore unlock errors
      }
    }
  } catch (err) {
    if ((err as { code?: string })?.code === "ELOCKED") {
      // Тихий пропуск: лок держит другой процесс дольше retry-бюджета --
      // мутация не критична, следующий якорь/перевзвод повторит её.
      if (!warnedLockBusy) {
        warnedLockBusy = true;
        console.warn(
          "pi-billing-window: wake-lock занят другим процессом, мутация таблицы пропущена (повтор на следующем событии)",
        );
      }
      return false;
    }
    const msg = String((err as Error)?.message ?? err).slice(0, 160);
    console.warn("pi-billing-window: mutateWakeTable failed:", msg);
    return false;
  }
}

// ---- One-shot wake timer primitive (watchdog.ts pattern, TD-001) ----

let wakeTimerHandle: ReturnType<typeof setTimeout> | null = null;

/**
 * Взвести one-shot таймер на whenMs: повторный arm отменяет предыдущий
 * (cancel-before-arm), delay = max(0, whenMs - Date.now()) -- self-correcting
 * против дрейфа wall-clock. handle.unref() -- таймер не держит event loop
 * (NFR-012-1).
 */
export function armWakeTimer(whenMs: number, cb: () => void): void {
  clearWakeTimer();
  const delay = Math.max(0, whenMs - Date.now());
  wakeTimerHandle = setTimeout(() => {
    wakeTimerHandle = null;
    cb();
  }, delay);
  wakeTimerHandle.unref();
}

/** Снять взведённый таймер (идемпотентно, no-op если не взведён). */
export function clearWakeTimer(): void {
  if (wakeTimerHandle !== null) {
    clearTimeout(wakeTimerHandle);
    wakeTimerHandle = null;
  }
}

/**
 * Spec 012 (exit hygiene): test probe -- whether the armed timer is ref'd
 * (keeps the event loop alive). null = таймер не взведён.
 */
export function hasRefForTests(): boolean | null {
  return wakeTimerHandle === null ? null : wakeTimerHandle.hasRef();
}
