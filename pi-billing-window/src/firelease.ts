import { join, dirname } from "node:path";
import { homedir, hostname } from "node:os";
import { createHash } from "node:crypto";
import {
  openSync,
  closeSync,
  writeSync,
  readFileSync,
  rmSync,
  mkdirSync,
  existsSync,
} from "node:fs";

/** TTL аренды маркера: 10 минут (design §6.2, D-605; один с лишним backoff-шаг). */
export const FIRE_LEASE_TTL_MS = 10 * 60_000;

/** Каталог маркеров по умолчанию: `~/.pi/agent/pi-billing-window-fires` (D-604, NR-5). */
const DEFAULT_FIRES_DIR = join(homedir(), ".pi", "agent", "pi-billing-window-fires");

/** Максимум конкурентных попыток wx в одном acquire (D-604: bounded <=3). */
export const MAX_TAKEOVER_ATTEMPTS = 3;

let firesDir: string = DEFAULT_FIRES_DIR;

/** Переопределить каталог маркеров (хук для тестов). */
export function setFiresDirPath(p: string): void {
  firesDir = p;
}

/** Текущий каталог маркеров. */
export function getFiresDirPath(): string {
  return firesDir;
}

/** Результат acquireFireLease (design §6.1). `replaced` -- был ли это takeover. */
export interface FireLeaseResult {
  ok: boolean;
  /** pid текущего держателя (при ok:false из-за живого чужого маркера). */
  holderPid?: number;
  /** true, если аренда получена путём takeover истёкшего/мёртвого маркера. */
  replaced?: boolean;
}

/** JSON-тело маркера (design §6.1, D-604). */
interface MarkerBody {
  locked_at: number;
  pid: number;
  host: string;
  ep: number;
  reset: number;
  key: string;
  mode: string;
}

// --- внутренняя эпоха модуля ---------------------------------------------------
// ep маркера — «эпоха сессии» держателя с точки зрения firelease. Единственное
// требование юнитов: это number, и после takeover она СМЕНЯЕТСЯ (D-604 release по
// ep не даёт прежнему держателю снести чужую новую аренду). Берём монотонно
// растущий счётчик от большого базиса (Date.now) — уникален внутри процесса, не
// пересекается с малыми ep=1/2/3/5/9, которые пишут тесты в чужие маркеры.
let epochCounter = Date.now();
function nextEpoch(): number {
  epochCounter += 1;
  return epochCounter;
}

/** keyId = sha1(key).slice(0,16) (design §6.1) — профиль-независим. */
function keyIdOf(key: string): string {
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

/** Абсолютный путь маркера `<firesDir>/<keyId>/<reset>.mark`. */
function markerPath(key: string, reset: number): string {
  return join(firesDir, keyIdOf(key), `${reset}.mark`);
}

/** host, обрезанный до первого `.`/`/` (D-606, ASCII-безопасен). */
function hostToken(): string {
  return hostname().split(/[./]/)[0];
}

/**
 * Кроссплатформенная проверка «процесс жив»: `process.kill(pid, 0)` — сигнал 0 не
 * шлёт ничего, но бросает ESRCH для несуществующего pid (EPERM = процесс есть, но
 * нет прав -> жив; прочие ошибки консервативно считаем живым — «не дублировать»).
 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true; // EPERM и прочее: живой/недоступный — консервативно не дублируем
  }
}

/** Маркер «живой» <=> TTL жив И pid держателя жив (D-604, шаг 2). */
function isMarkerLive(m: MarkerBody): boolean {
  if (typeof m.locked_at !== "number" || !Number.isFinite(m.locked_at)) return false;
  if (Date.now() - m.locked_at >= FIRE_LEASE_TTL_MS) return false;
  return pidAlive(m.pid);
}

/** Безопасное чтение маркера: null при отсутствии/битости/некорректном теле. */
function readMarker(path: string): MarkerBody | null {
  try {
    if (!existsSync(path)) return null;
    const m = JSON.parse(readFileSync(path, "utf8")) as Partial<MarkerBody>;
    if (typeof m?.pid !== "number" || typeof m?.locked_at !== "number") return null;
    return m as MarkerBody;
  } catch {
    return null;
  }
}

/**
 * Атомарный захват: mkdir + openSync(path, "wx") (O_EXCL) + запись JSON.
 * Возвращает false, если файл уже существует (EEXIST) либо fs-ошибка.
 */
function tryWriteMarker(path: string, key: string, reset: number): boolean {
  const body = JSON.stringify({
    locked_at: Date.now(),
    pid: process.pid,
    host: hostToken(),
    ep: nextEpoch(),
    reset,
    key,
    mode: "planned",
  } as MarkerBody);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "wx");
    try {
      writeSync(fd, body, null, "utf8");
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Попытка взять аренду на сброс `(key, reset)`.
 * Flow (D-604): clean wx -> ok; EEXIST+live -> {ok:false, holderPid};
 * EEXIST+dead (TTL истёк ИЛИ pid мёртв) -> takeover (rm + повтор wx), bounded <=3;
 * при конкурентном takeover/EEXIST в цикле -> fail-safe skip «не дублировать».
 * Всё синхронно, никогда не бросает; таймеров не заводит (D-605).
 */
export function acquireFireLease(key: string, reset: number): FireLeaseResult {
  const path = markerPath(key, reset);
  for (let attempt = 0; attempt < MAX_TAKEOVER_ATTEMPTS; attempt++) {
    if (tryWriteMarker(path, key, reset)) {
      return attempt === 0 ? { ok: true } : { ok: true, replaced: true };
    }
    const m = readMarker(path);
    if (m === null) {
      // Файл исчез/битый между попытками — ещё раз честный wx (не сдаёмся зря).
      continue;
    }
    if (isMarkerLive(m)) {
      return { ok: false, holderPid: m.pid };
    }
    // Маркер мёртв (TTL/pid): takeover.
    try {
      rmSync(path, { force: true });
    } catch {
      /* игнорируем: следующий wx решит */
    }
  }
  // Bounded exhausted: конкурентные takers — fail-safe «не дублировать» (skip).
  const m = readMarker(path);
  if (m !== null) return { ok: false, holderPid: m.pid };
  // Маркер не читается (крайний случай гонки) — не занимаем, чтобы не нарушал
  // инвариант «<=1 fire»;
  return { ok: false };
}

/**
 * Освободить аренду compare-and-remove: удаляет маркер ТОЛЬКО если его pid
 * совпадает с вызывающим (не сносит новую аренду после takeover; D-604).
 * Возвращает boolean; никогда не бросает; идемпотентен (нет маркера -> false).
 */
export function releaseFireLease(key: string, reset: number, myPid: number): boolean {
  try {
    const path = markerPath(key, reset);
    const m = readMarker(path);
    if (m === null) return false;
    if (typeof m.pid !== "number" || m.pid !== myPid) return false;
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}
