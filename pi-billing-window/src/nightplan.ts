/**
 * nightplan.ts -- ночной контракт pi-billing-window (spec 014).
 *
 * План -- это ВНЕШНИЙ (вне беседы) контракт страховки ночной сессии:
 * он переживает дисарм агента, инвариант в index.ts перевзводит флаг
 * cont-after-reset по мере необходимости, сюда пишется «ночная книга»
 * (ledger) и утренний отчёт.
 *
 * Три ответственности (паттерн wakeups.ts):
 *   (a) чистые функции интервальной математики (переход через полночь --
 *       from > to означает wrap) и сборки утреннего отчёта -- без I/O;
 *   (b) персистенция ОДНОГО активного плана в
 *       ~/.pi/agent/pi-billing-window-nightplan.json под proper-lockfile
 *       (паттерн state.ts/arms.ts: retry-бюджет, tmp+rename, толерантный
 *       парсинг -- битый/чужой файл тихо даёт null + однократный warn);
 *   (c) append-only ночная книга ~/.pi/agent/pi-billing-window-nights/
 *       ledger.csv (паттерн history.ts: BOM + header, лок на дописывание)
 *       и парсер history.csv для отчёта (фильтр по epoch-диапазону,
 *       суммы input/output/cache_read).
 *
 * Passive observer: ни одна ошибка файла/лока не бросается наружу --
 * warn + тихая деградация (NFR-014-2). Все пути -- параметры модуля
 * (setPaths/resetPaths, паттерн arms.ts:101) для тестов.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import lockfile from "proper-lockfile";
import { getHistoryFile, isoLocal } from "./history.js";

// ---- Types ----

/** Схема nightplan.json: один активный план на аккаунт (design §4). */
export type NightPlan = {
  /** Ключ сессии (путь к jsonl, как ключи arms.json). */
  key: string;
  /** "HH:MM" локального времени, начало интервала (может быть > toLocal -- wrap). */
  fromLocal: string;
  /** "HH:MM" локального времени, конец интервала (moment утреннего отчёта). */
  toLocal: string;
  /** Repeat-бюджет авто-перевзводов инварианта. */
  repeat: number;
  /** Только ссылка (механика очереди вне спеки), null = не задан. */
  backlogPath: string | null;
  /** epoch ms взвода плана. */
  createdAt: number;
  /** epoch ms авто-истечения (toLocal + 1 ч; план не живёт дольше ночи). */
  expiresAt: number;
  /** Дата, к которой относится ночь ("YYYY-MM-DD", design §4). */
  nightDate: string;
};

/** Строка ночной книги: один сброс окна в интервале плана (FR-014-4). */
export type LedgerRow = {
  tsIso: string;
  epochMs: number;
  nightDate: string;
  resetAt: number;
  callsInWindow: number;
  input: number;
  output: number;
  cacheRead: number;
  /** "unknown" — только у fallback-строк, восстановленных из history.csv. */
  armPhase: "armed" | "pending" | "none" | "unknown";
  verdict: "used" | "idle";
  /** Spec 015-fix: идемпотентность + диагностика (−1 = неизвестен). */
  resetCount: number;
  /** Spec 015-fix: windowStartedAt ПРЕДЫДУЩЕГО (завершившегося) окна. */
  prevWindowStartedAt: number;
};

/** Агрегируемая строка history.csv для отчёта (токены вызовов). */
export type HistoryAggRow = {
  epochMs: number;
  kind: string;
  input: number;
  output: number;
  cacheRead: number;
};

// ---- Pure functions: HH:MM + интервалы (NFR-014-3) ----

/**
 * "HH:MM" -> минуты с полуночи (0..1439) или null. Минуты -- строго две
 * цифры, часы -- одна-две ("7:30" легален, "7:5" -- нет).
 */
export function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Минуты с полуночи -> каноническое "HH:MM". */
export function fmtHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Локальные минуты с полуночи для epoch ms. */
function localMinutes(nowMs: number): number {
  const d = new Date(nowMs);
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Находимся ли локальным временем в интервале [from, to):
 *  - from < to -- обычный дневной интервал;
 *  - from > to -- переход через полночь (22:00-08:00): интервал
 *    [from, 24:00) ∪ [00:00, to);
 *  - from === to -- вырожденный (нулевой) интервал, всегда false.
 * Границы: момент from включён, to -- нет.
 */
export function inInterval(
  nowMs: number,
  fromLocal: string,
  toLocal: string,
): boolean {
  const from = parseHHMM(fromLocal);
  const to = parseHHMM(toLocal);
  if (from === null || to === null || from === to) return false;
  const cur = localMinutes(nowMs);
  if (from < to) return cur >= from && cur < to;
  return cur >= from || cur < to;
}

/** Момент локального календарного времени baseMs, установленный на minutes. */
function atLocalTime(baseMs: number, minutes: number): number {
  const d = new Date(baseMs);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d.getTime();
}

/**
 * Ближайший (>= now) момент, когда локальное время равно hhmm.
 * Ровно в hhmm возвращает now (таймер утреннего отчёта стреляет сразу).
 */
export function nextOccurrence(nowMs: number, hhmm: string): number | null {
  const m = parseHHMM(hhmm);
  if (m === null) return null;
  const candidate = atLocalTime(nowMs, m);
  if (candidate >= nowMs) return candidate;
  return atLocalTime(nowMs + 24 * 60 * 60 * 1000, m);
}

/** Недавний (<= now) момент, когда локальное время было равно hhmm. */
export function previousOccurrence(nowMs: number, hhmm: string): number | null {
  const m = parseHHMM(hhmm);
  if (m === null) return null;
  const candidate = atLocalTime(nowMs, m);
  if (candidate <= nowMs) return candidate;
  return atLocalTime(nowMs - 24 * 60 * 60 * 1000, m);
}

/** Локальная дата "YYYY-MM-DD" для epoch ms. */
function localDateStr(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Дата ночи, к которой относится момент now (design §4): ночь 22:00 25-го
 * -> 08:00 26-го имеет nightDate "25" и в 23:00 25-го, и в 02:00 26-го.
 *  - в интервале: wrap-ночь после полуночи (cur < to) относится ко вчерашнему
 *    началу; иначе -- сегодняшняя дата;
 *  - вне интервала: дата ближайшего НАСТУПАЮЩЕГО from: [to, from) при wrap --
 *    сегодня вечером; from < to и cur >= from... к следующему разу.
 */
export function nightDateFor(
  nowMs: number,
  fromLocal: string,
  toLocal: string,
): string | null {
  const from = parseHHMM(fromLocal);
  const to = parseHHMM(toLocal);
  if (from === null || to === null) return null;
  const cur = localMinutes(nowMs);
  if (inInterval(nowMs, fromLocal, toLocal)) {
    if (from > to && cur < to) {
      // после полуночи хвост wrap-ночи, начавшейся вчера
      return localDateStr(nowMs - 24 * 60 * 60 * 1000);
    }
    return localDateStr(nowMs);
  }
  if (from > to) {
    // [to, from): следующая ночь начинается сегодня в from
    return localDateStr(nowMs);
  }
  return cur < from
    ? localDateStr(nowMs)
    : localDateStr(nowMs + 24 * 60 * 60 * 1000);
}

// ---- Paths (тест-хуки, паттерн arms.ts) ----

let planFile = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "pi-billing-window-nightplan.json",
);
let planLock = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "pi-billing-window-nightplan.lock",
);
let nightsDir = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "pi-billing-window-nights",
);

/** Однократный warn на битый/чужой nightplan.json (NFR-014-2). */
let warnedBadPlan = false;
/** Однократный warn на занятый лок (ELOCKED после retry-бюджета). */
let warnedLockBusy = false;

/** Tests: перенаправить файл/лок плана и каталог ночей (сбрасывает warn-флаги). */
export function setPaths(
  newFile: string,
  newLock: string,
  newNightsDir: string,
): void {
  planFile = newFile;
  planLock = newLock;
  nightsDir = newNightsDir;
  warnedBadPlan = false;
  warnedLockBusy = false;
}

/** Tests: вернуть пути по умолчанию (сбрасывает warn-флаги). */
export function resetPaths(): void {
  planFile = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "pi-billing-window-nightplan.json",
  );
  planLock = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "pi-billing-window-nightplan.lock",
  );
  nightsDir = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "pi-billing-window-nights",
  );
  warnedBadPlan = false;
  warnedLockBusy = false;
}

export function getPlanFile(): string {
  return planFile;
}

export function getNightsDir(): string {
  return nightsDir;
}

/** Путь файла утреннего отчёта: nights/report-<nightDate>.md (FR-014-5). */
export function reportPathFor(nightDate: string): string {
  return path.join(nightsDir, `report-${nightDate}.md`);
}

// ---- Plan persistence (lock + tmp/rename, state.ts pattern) ----

/** Строгая валидация схемы: любое отклонение -> "нет плана" (null). */
function isValidPlan(p: unknown): p is NightPlan {
  if (typeof p !== "object" || p === null) return false;
  const o = p as Record<string, unknown>;
  if (typeof o.key !== "string" || o.key.length === 0) return false;
  if (parseHHMM(String(o.fromLocal)) === null) return false;
  if (parseHHMM(String(o.toLocal)) === null) return false;
  if (typeof o.repeat !== "number" || !Number.isFinite(o.repeat)) return false;
  if (typeof o.createdAt !== "number" || !Number.isFinite(o.createdAt)) {
    return false;
  }
  if (typeof o.expiresAt !== "number" || !Number.isFinite(o.expiresAt)) {
    return false;
  }
  if (typeof o.nightDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.nightDate)) {
    return false;
  }
  if (o.backlogPath !== null && typeof o.backlogPath !== "string") return false;
  return true;
}

function warnBadPlanOnce(): void {
  if (!warnedBadPlan) {
    warnedBadPlan = true;
    console.warn(
      "pi-billing-window: nightplan.json повреждён или имеет чужую схему -- " +
        "план считается отсутствующим (тихая деградация)",
    );
  }
}

/**
 * Толерантное чтение плана: нет файла -> null (молча); битый JSON / чужая
 * схема -> null + ОДНОКРАТНЫЙ warn. Никогда не бросает (NFR-014-2).
 */
export function readPlan(): NightPlan | null {
  try {
    if (!fs.existsSync(planFile)) return null;
    const raw = fs.readFileSync(planFile, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnBadPlanOnce();
      return null;
    }
    if (!isValidPlan(parsed)) {
      warnBadPlanOnce();
      return null;
    }
    warnedBadPlan = false;
    return parsed;
  } catch {
    warnBadPlanOnce();
    return null;
  }
}

/** tmp + renameSync -- атомарная запись (writeStateSync pattern). */
function writePlanSync(plan: NightPlan): void {
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  const tmp = planFile + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(plan, null, 2), "utf8");
  fs.renameSync(tmp, planFile);
}

/** Одна мутация плана под proper-lockfile (retry-бюджет как state.ts). */
async function withPlanLock<T>(fn: () => T): Promise<T> {
  const dir = path.dirname(planLock);
  fs.mkdirSync(dir, { recursive: true });
  // Marker FILE at the lock path itself (proven arms/history pattern):
  // proper-lockfile canonicalizes with realpath BEFORE creating the
  // `<lock>.lock` directory, so the target must exist.
  if (!fs.existsSync(planLock)) fs.writeFileSync(planLock, "{}", "utf8");
  await lockfile.lock(planLock, {
    retries: { retries: 20, factor: 1, minTimeout: 100, maxTimeout: 200 },
  });
  try {
    return fn();
  } finally {
    try {
      await lockfile.unlock(planLock);
    } catch {
      // ignore unlock errors
    }
  }
}

/**
 * Записать (перезаписать) активный план. Один план на аккаунт: новая
 * запись затирает старую (мусор не собираем, TTL в самом файле).
 * Возвращает true при успехе; ELOCKED -> тихий false + однократный warn.
 * Никогда не бросает.
 */
export async function writePlan(plan: NightPlan): Promise<boolean> {
  try {
    await withPlanLock(() => {
      writePlanSync(plan);
    });
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code === "ELOCKED") {
      if (!warnedLockBusy) {
        warnedLockBusy = true;
        console.warn(
          "pi-billing-window: nightplan-lock занят другим процессом, " +
            "запись плана пропущена",
        );
      }
      return false;
    }
    console.warn(
      "pi-billing-window: writePlan failed:",
      String((err as Error)?.message ?? err).slice(0, 160),
    );
    return false;
  }
}

/**
 * Снять план досрочно (/night-plan off). true -- файл был и удалён.
 * Никогда не бросает.
 */
export async function clearPlan(): Promise<boolean> {
  try {
    let removed = false;
    await withPlanLock(() => {
      if (fs.existsSync(planFile)) {
        fs.unlinkSync(planFile);
        removed = true;
      }
    });
    return removed;
  } catch (err) {
    console.warn(
      "pi-billing-window: clearPlan failed:",
      String((err as Error)?.message ?? err).slice(0, 160),
    );
    return false;
  }
}

// ---- Night ledger (append-only CSV, history.ts pattern) ----

const LEDGER_HEADER =
  "ts_iso,epoch_ms,night_date,reset_at,calls_in_window,input,output," +
  "cache_read,arm_phase,verdict,reset_count,prev_window_started_at";

function ledgerFile(): string {
  return path.join(nightsDir, "ledger.csv");
}

function ledgerLock(): string {
  return path.join(nightsDir, "ledger.lock");
}

function ledgerRowToLine(row: LedgerRow): string {
  return [
    row.tsIso,
    row.epochMs,
    row.nightDate,
    row.resetAt,
    row.callsInWindow,
    row.input,
    row.output,
    row.cacheRead,
    row.armPhase,
    row.verdict,
    row.resetCount,
    row.prevWindowStartedAt,
  ].join(",");
}

/** Статус дописывания строки книги (Spec 015-fix). */
export type LedgerAppendStatus = "appended" | "duplicate" | "error";

async function withLedgerLock<T>(fn: () => T): Promise<T> {
  fs.mkdirSync(nightsDir, { recursive: true });
  const lk = ledgerLock();
  if (!fs.existsSync(lk)) fs.writeFileSync(lk, "{}", "utf8");
  await lockfile.lock(lk, {
    retries: { retries: 20, factor: 1, minTimeout: 100, maxTimeout: 200 },
  });
  try {
    return fn();
  } finally {
    try {
      await lockfile.unlock(lk);
    } catch {
      // ignore unlock errors
    }
  }
}

/**
 * Дописать строку ночной книги (FR-014-4). Каталог nights/ и header
 * создаются при первой записи (BOM -- Excel на Windows, паттерн history.ts).
 * Спец 015-fix: ИДЕМПОТЕНТНОСТЬ по (nightDate, resetAt, resetCount) — проверка
 * дубля выполняется ПОД локом (после того, как конкурентная запись commit'нулась),
 * поэтому параллельные EventBus- и direct-пути одного сброса дают ровно одну
 * строку. Никогда не бросает; "error" при неудаче (warn).
 */
export async function appendLedger(row: LedgerRow): Promise<LedgerAppendStatus> {
  try {
    let status: LedgerAppendStatus = "appended";
    await withLedgerLock(() => {
      const file = ledgerFile();
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, "\uFEFF" + LEDGER_HEADER + "\n", "utf8");
      }
      // Дедуп под локом: (nightDate, resetAt, resetCount) уже в книге?
      const raw = fs.readFileSync(file, "utf8");
      for (const line of raw.split("\n")) {
        const cols = line.replace(/^\uFEFF/, "").trimEnd().split(",");
        if (cols.length < 10 || cols[0] === "ts_iso") continue;
        if (
          cols[2] === row.nightDate &&
          Number(cols[3]) === row.resetAt &&
          (cols.length < 11 || Number(cols[10]) === row.resetCount)
        ) {
          status = "duplicate";
          return;
        }
      }
      fs.appendFileSync(file, ledgerRowToLine(row) + "\n", "utf8");
    });
    return status;
  } catch (err) {
    console.warn(
      "pi-billing-window: appendLedger failed:",
      String((err as Error)?.message ?? err).slice(0, 160),
    );
    return "error";
  }
}

/**
 * Прочитать строки книги (все или одну ночь). Битые строки пропускаются
 * молча. Возвращает строки в порядке файла (хронология сбросов).
 */
export function readLedger(nightDate?: string): LedgerRow[] {
  try {
    const file = ledgerFile();
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n").map((l) => l.replace(/^\uFEFF/, "").trimEnd());
    const rows: LedgerRow[] = [];
    for (const line of lines) {
      if (line.trim() === "" || line.startsWith("ts_iso")) continue;
      const cols = line.split(",");
      if (cols.length < 10) continue;
      const epochMs = Number(cols[1]);
      const resetAt = Number(cols[3]);
      const calls = Number(cols[4]);
      const input = Number(cols[5]);
      const output = Number(cols[6]);
      const cacheRead = Number(cols[7]);
      const armPhase = cols[8];
      const verdict = cols[9];
      if (!Number.isFinite(epochMs) || !Number.isFinite(resetAt)) continue;
      if (armPhase !== "armed" && armPhase !== "pending" && armPhase !== "none" && armPhase !== "unknown") {
        continue;
      }
      if (verdict !== "used" && verdict !== "idle") continue;
      const row: LedgerRow = {
        tsIso: cols[0],
        epochMs,
        nightDate: cols[2],
        resetAt,
        callsInWindow: Number.isFinite(calls) ? calls : 0,
        input: Number.isFinite(input) ? input : 0,
        output: Number.isFinite(output) ? output : 0,
        cacheRead: Number.isFinite(cacheRead) ? cacheRead : 0,
        armPhase,
        verdict,
        // Спец 015-fix: новые колонки опциональны (старые строки без них).
        resetCount: cols.length >= 11 && Number.isFinite(Number(cols[10])) ? Number(cols[10]) : -1,
        prevWindowStartedAt:
          cols.length >= 12 && Number.isFinite(Number(cols[11])) ? Number(cols[11]) : 0,
      };
      if (nightDate === undefined || row.nightDate === nightDate) {
        rows.push(row);
      }
    }
    return rows;
  } catch {
    return [];
  }
}

// ---- history.csv parser (для утреннего отчёта) ----

/** RFC 4180: сплит строки с учётом кавычек (project-пути бывают с запятыми). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const numOr0 = (v: string): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Разобрать CSV history.csv в агрегируемые строки (epoch, kind, токены).
 * Header и битые строки пропускаются молча.
 */
export function parseHistoryCsv(raw: string): HistoryAggRow[] {
  const lines = raw.split("\n").map((l) => l.replace(/^\uFEFF/, "").trimEnd());
  const rows: HistoryAggRow[] = [];
  for (const line of lines) {
    if (line.trim() === "" || line.startsWith("ts_iso")) continue;
    const cols = parseCsvLine(line);
    if (cols.length < 13) continue;
    const epochMs = Number(cols[1]);
    if (!Number.isFinite(epochMs)) continue;
    rows.push({
      epochMs,
      kind: cols[2],
      input: numOr0(cols[7]),
      output: numOr0(cols[8]),
      cacheRead: numOr0(cols[9]),
    });
  }
  return rows;
}

/**
 * Строки history.csv в диапазоне [fromMs, toMs): вызовы ночи для отчёта.
 * Читает ТЕКУЩИЙ путь history (getHistoryFile -- тесты редиректят его
 * своим setPaths). Отсутствующий/битый файл -> [].
 */
export function readHistoryRows(
  fromMs: number,
  toMs: number,
): HistoryAggRow[] {
  try {
    const file = getHistoryFile();
    if (!fs.existsSync(file)) return [];
    return parseHistoryCsv(fs.readFileSync(file, "utf8"))
      .filter((r) => r.epochMs >= fromMs && r.epochMs < toMs);
  } catch {
    return [];
  }
}

/** Суммы токенов call-строк в диапазоне [fromMs, toMs). Чистая функция. */
export function sumTokensInRange(
  rows: HistoryAggRow[],
  fromMs: number,
  toMs: number,
): { input: number; output: number; cacheRead: number } {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  for (const r of rows) {
    if (r.epochMs < fromMs || r.epochMs >= toMs) continue;
    if (r.kind !== "call") continue;
    input += r.input;
    output += r.output;
    cacheRead += r.cacheRead;
  }
  return { input, output, cacheRead };
}

/**
 * Spec 015-fix (FR-015-R6): восстановить окна ночи из history.csv, когда
 * книга (ledger.csv) пуста — сбросы были, но строки книги не записались
 * (инцидент 25→26.10: подписка ledger умирает на session replacement).
 * Чистая функция: окно №i = вызовы в [prevReset | plan.createdAt, reset_i).
 * armPhase "unknown" — историю arm'а из history не восстановить.
 */
export function fallbackWindowsFromHistory(
  plan: NightPlan,
  rows: HistoryAggRow[],
): LedgerRow[] {
  const resets = rows
    .filter(
      (r) =>
        r.kind === "window_reset" &&
        r.epochMs >= plan.createdAt &&
        r.epochMs < plan.expiresAt,
    )
    .map((r) => r.epochMs)
    .sort((a, b) => a - b);
  const out: LedgerRow[] = [];
  for (let i = 0; i < resets.length; i++) {
    // A reset row describes the window that just ended: [previous reset,
    // resetAt), matching prevWindowCalls in State and buildMorningReport.
    // The first reset closes the interval from plan creation, so calls before
    // the first boundary are not lost in the morning total.
    const lower = i === 0 ? plan.createdAt : resets[i - 1];
    const calls = rows.filter(
      (r) => r.kind === "call" && r.epochMs >= lower && r.epochMs < resets[i],
    ).length;
    out.push({
      tsIso: isoLocal(new Date(resets[i])),
      epochMs: resets[i],
      nightDate: plan.nightDate,
      resetAt: resets[i],
      callsInWindow: calls,
      input: 0,
      output: 0,
      cacheRead: 0,
      armPhase: "unknown",
      verdict: calls > 0 ? "used" : "idle",
      resetCount: -1,
      prevWindowStartedAt: lower,
    });
  }
  return out;
}

// ---- Morning report (FR-014-5, чистая функция) ----

export type MorningReportOpts = {
  /** Version stamp (index.ts VERSION) -- шапка «ночь работала на коде N». */
  version: string;
  /** Момент генерации (для шапки); default Date.now(). */
  nowMs?: number;
  /** Счётчик auto-rearm событий ночи (in-memory из index.ts). */
  rearmCount?: number;
  /** Счётчик незастрахованных событий ночи. */
  uninsuredCount?: number;
};

/** Человекочитаемое локальное "HH:MM:SS" для epoch ms. */
function hhmmss(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Собрать markdown утреннего отчёта: таблица окон ночи (ledger + токены из
 * history.csv по интервалам [reset_i, reset_{i+1})), итоги, потери, backlog.
 * Причина простоя v1 -- частичная (без парсинга armslog, design §7):
 * idle + none -> "no-arm", idle + armed/pending -> "delivery: см. armslog".
 * Чистая: никакого I/O.
 */
export function buildMorningReport(
  plan: NightPlan,
  ledgerRows: LedgerRow[],
  historyRows: HistoryAggRow[],
  opts: MorningReportOpts,
): string {
  const nowMs = opts.nowMs ?? Date.now();
  const ledgerSorted = [...ledgerRows].sort((a, b) => a.resetAt - b.resetAt);
  // Spec 015-fix: книга пуста, но сбросы в history есть — восстанавливаем
  // окна и честно помечаем отчёт, вместо ложных «0 окон / 0 вызовов».
  const fallback =
    ledgerSorted.length === 0
      ? fallbackWindowsFromHistory(plan, historyRows)
      : [];
  const sorted = ledgerSorted.length > 0 ? ledgerSorted : fallback;
  const ledgerIncomplete = ledgerSorted.length === 0 && fallback.length > 0;
  const lines: string[] = [];
  lines.push(`# Ночной отчёт — ${plan.nightDate} (${plan.fromLocal}–${plan.toLocal})`);
  lines.push("");
  lines.push(`version: ${opts.version}`);
  lines.push(
    `план: key=${plan.key.split(/[\\/]/).pop() ?? plan.key} ` +
      `repeat=${plan.repeat} backlog=${plan.backlogPath ?? "—"}`,
  );
  lines.push(`сгенерирован: ${isoLocal(new Date(nowMs))}`);
  lines.push("");

  let usedCount = 0;
  let idleCount = 0;
  let idleNoArm = 0;
  let totCalls = 0;
  let totInput = 0;
  let totOutput = 0;
  let totCacheRead = 0;

  if (sorted.length === 0) {
    lines.push(" окон в книге нет — сбросов в интервале плана не зафиксировано.");
    lines.push("");
  } else {
    if (ledgerIncomplete) {
      lines.push(
        "⚠ LEDGER INCOMPLETE: книга ночи (ledger.csv) пуста — данные восстановлены из history.csv и armslog",
      );
      lines.push("");
    }
    lines.push(
      "| # | reset | вызовы | input | output | cache_read | arm | verdict | причина |",
    );
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (let i = 0; i < sorted.length; i++) {
      const row = sorted[i];
      const winStart = row.resetAt;
      const winEnd = i + 1 < sorted.length ? sorted[i + 1].resetAt : plan.expiresAt;
      const tok = sumTokensInRange(historyRows, winStart, Math.max(winEnd, winStart + 1));
      if (row.verdict === "used") usedCount++; else idleCount++;
      if (row.verdict === "idle" && row.armPhase === "none") idleNoArm++;
      totCalls += row.callsInWindow;
      totInput += tok.input;
      totOutput += tok.output;
      totCacheRead += tok.cacheRead;
      const cause =
        row.verdict === "used"
          ? ""
          : row.armPhase === "none"
            ? "no-arm (не был застрахован на момент сброса)"
            : row.armPhase === "unknown"
              ? "arm неизвестен (окно восстановлено из history)"
              : "delivery: см. armslog";
      lines.push(
        `| ${i + 1} | ${hhmmss(row.resetAt)} | ${row.callsInWindow} | ` +
          `${tok.input} | ${tok.output} | ${tok.cacheRead} | ${row.armPhase} | ` +
          `${row.verdict} | ${cause} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Итоги ночи");
  lines.push("");
  lines.push(
    `- окон: ${sorted.length}${ledgerIncomplete ? " (восстановлено из history.csv)" : ""} (использовано: ${usedCount}, простаивало: ${idleCount})`,
  );
  lines.push(`- вызовов за ночь: ${totCalls}`);
  lines.push(
    `- токены ночи: input ${totInput}, output ${totOutput}, cache_read ${totCacheRead}`,
  );
  lines.push(`- auto-rearm событий: ${opts.rearmCount ?? 0}`);
  lines.push(`- незастрахованных событий: ${opts.uninsuredCount ?? 0}`);
  lines.push("");
  if (idleNoArm > 0) {
    lines.push("## Потери");
    lines.push("");
    lines.push(
      `- незастрахованных простаивающих окон: ${idleNoArm} ` +
        `(оценка потерь ~${idleNoArm * 5}M кредитов — по ~5M на окно)`,
    );
    lines.push("");
  }
  if (plan.backlogPath !== null) {
    lines.push(`backlog: ${plan.backlogPath}`);
    lines.push("");
  }
  return lines.join("\n");
}
