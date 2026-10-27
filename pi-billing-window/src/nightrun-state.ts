/**
 * nightrun-state.ts — durable state for /night-run backlog runner (spec 015, FR-015-2).
 *
 * Отдельный file+lock от pi-billing-window.json, pi-billing-window-nightplan.json,
 * arms.json. Atomic tmp+rename pattern (как state.ts/nightplan.ts). Версионирование
 * схемы; толерантное чтение; отдельность от дневных задач.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import lockfile from "proper-lockfile";

export type NightRunStatus =
  | "idle"
  | "running"
  | "awaiting-result"
  | "paused"
  | "stopped"
  | "failed"
  | "completed";

export type NightRunResult =
  | "PASS"
  | "FAIL"
  | "429"
  | "OWNER_BUSY"
  | "SWITCH_NEEDED"
  | "STOPPED"
  | "BOUNDARY_BLOCKED"
  | "AWAITING_RESULT"
  | null;

export type NightRunState = {
  /** Версия схемы (для будущих миграций). */
  version: number;
  /** Ключ ночного плана (nightDate из NightPlan). */
  plan: string;
  /** Путь к backlog файлу. */
  backlog: string;
  /** SHA256 hash содержимого backlog (защита от подмены). */
  backlogHash: string;
  /** Текущий номер задачи (1-based, индекс в tasks массиве). */
  currentTask: number;
  /** Статус runner-а. */
  status: NightRunStatus;
  /** Попытка текущей задачи (для bounded retry). */
  attempt: number;
  /** Максимум retry-попыток на задачу. */
  maxRetries: number;
  /** Результат последней попытки. */
  lastResult: NightRunResult;
  /** Epoch ms последнего изменения state. */
  updatedAt: number;
  /** User stop (сильнее auto-continuation). */
  userStop: boolean;
};

let stateFile = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "pi-billing-window-nightrun.json",
);
let lockFile = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "pi-billing-window-nightrun.lock",
);

let warnedBadState = false;
let warnedLockBusy = false;

export function setPaths(newStateFile: string, newLockFile: string): void {
  stateFile = newStateFile;
  lockFile = newLockFile;
  warnedBadState = false;
  warnedLockBusy = false;
}

export function resetPaths(): void {
  stateFile = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "pi-billing-window-nightrun.json",
  );
  lockFile = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "pi-billing-window-nightrun.lock",
  );
  warnedBadState = false;
  warnedLockBusy = false;
}

export function getStateFile(): string {
  return stateFile;
}

export function getLockFile(): string {
  return lockFile;
}

function warnBadStateOnce(): void {
  if (!warnedBadState) {
    warnedBadState = true;
    console.warn(
      "pi-billing-window: nightrun state повреждён или имеет чужую схему -- " +
        "state считается отсутствующим (тихая деградация)",
    );
  }
}

function warnLockBusyOnce(): void {
  if (!warnedLockBusy) {
    warnedLockBusy = true;
    console.warn(
      "pi-billing-window: nightrun lock занят дольше retry-бюджета (ELOCKED) -- " +
        "возможно, конфликт процессов или зависший lock",
    );
  }
}

function isValidState(s: unknown): s is NightRunState {
  if (typeof s !== "object" || s === null) return false;
  const o = s as Record<string, unknown>;
  if (typeof o.version !== "number" || o.version !== 1) return false;
  if (typeof o.plan !== "string") return false;
  if (typeof o.backlog !== "string") return false;
  if (typeof o.backlogHash !== "string") return false;
  if (typeof o.currentTask !== "number" || o.currentTask < 1) return false;
  if (typeof o.status !== "string") return false;
  if (typeof o.attempt !== "number" || o.attempt < 0) return false;
  if (typeof o.maxRetries !== "number" || o.maxRetries < 0) return false;
  if (typeof o.updatedAt !== "number") return false;
  if (typeof o.userStop !== "boolean") return false;
  // lastResult может быть null или строка.
  if (o.lastResult !== null && typeof o.lastResult !== "string") return false;
  return true;
}

/**
 * Толерантное чтение state: нет файла -> null (молча); битый JSON / чужая
 * схема -> null + ОДНОКРАТНЫЙ warn. Никогда не бросает.
 */
export function readState(): NightRunState | null {
  try {
    if (!fs.existsSync(stateFile)) return null;
    const raw = fs.readFileSync(stateFile, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnBadStateOnce();
      return null;
    }
    if (!isValidState(parsed)) {
      warnBadStateOnce();
      return null;
    }
    warnedBadState = false;
    return parsed;
  } catch {
    warnBadStateOnce();
    return null;
  }
}

/**
 * Записать state атомарно (tmp+rename).
 */
export function writeState(state: NightRunState): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = stateFile + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, stateFile);
}

/**
 * Удалить state файл.
 */
export function clearState(): boolean {
  try {
    if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Взять lock, выполнить fn, освободить lock. Retry budget 20 попыток
 * (как state.ts), ELOCKED → warn + throw.
 */
export async function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const dir = path.dirname(lockFile);
  fs.mkdirSync(dir, { recursive: true });
  // Pre-create marker file (как state.ts/nightplan.ts).
  if (!fs.existsSync(lockFile)) fs.writeFileSync(lockFile, "{}", "utf8");
  try {
    await lockfile.lock(lockFile, {
      retries: { retries: 20, factor: 1, minTimeout: 100, maxTimeout: 200 },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "ELOCKED") {
      warnLockBusyOnce();
      // Armslog diagnostic (optional, если нужен trace).
      import("./armslog.js")
        .then(({ armsLog }) =>
          armsLog(
            "nightrun-state-lock:ELOCKED",
            `retries исчерпаны, лок занят pid=${process.pid} file=${lockFile}`,
          ),
        )
        .catch(() => {});
    }
    throw err;
  }
  try {
    return await fn();
  } finally {
    try {
      await lockfile.unlock(lockFile);
    } catch {
      // Ignore unlock errors.
    }
  }
}

/**
 * Изменить state атомарно (read, transform, write под lock).
 */
export async function mutateState<T>(
  transform: (current: NightRunState | null) => {
    next: NightRunState | null;
    result?: T;
  },
): Promise<T | undefined> {
  return withLock(() => {
    const current = readState();
    const { next, result } = transform(current);
    if (next !== null) {
      writeState(next);
    } else {
      // next=null означает удаление state.
      clearState();
    }
    return result;
  });
}
