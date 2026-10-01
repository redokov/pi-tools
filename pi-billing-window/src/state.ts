/**
 * state.ts -- file-backed state for pi-billing-window.
 *
 * State is stored as JSON in ~/.pi/agent/pi-billing-window.json.
 * Concurrent writes are serialized via proper-lockfile.
 *
 * Paths are exposed as functions so tests can override them via setPaths().
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import lockfile from "proper-lockfile";

export type State = {
  provider: string;
  windowStartedAt: number;
  windowMs: number;
  lastResetAt: number;
  resetCount: number;
  callsInWindow: number;
  firstCallEmittedAt?: number;
  /** Timestamp of the most recent 429 (limit exhausted) from the provider. */
  last429At?: number;
};

let stateFile = path.join(os.homedir(), ".pi", "agent", "pi-billing-window.json");
let lockFile = path.join(os.homedir(), ".pi", "agent", "pi-billing-window.lock");

export function setPaths(newStateFile: string, newLockFile: string): void {
  stateFile = newStateFile;
  lockFile = newLockFile;
}

export function resetPaths(): void {
  stateFile = path.join(os.homedir(), ".pi", "agent", "pi-billing-window.json");
  lockFile = path.join(os.homedir(), ".pi", "agent", "pi-billing-window.lock");
}

export function getStateFile(): string {
  return stateFile;
}

export function getLockFile(): string {
  return lockFile;
}

export function readStateSync(): State | null {
  try {
    if (!fs.existsSync(stateFile)) return null;
    const raw = fs.readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw) as State;
    if (typeof parsed.windowStartedAt !== "number") return null;
    if (typeof parsed.windowMs !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeStateSync(state: State): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = stateFile + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, stateFile);
}

export async function withLock<T>(
  fn: () => Promise<T> | T,
): Promise<T> {
  const dir = path.dirname(lockFile);
  fs.mkdirSync(dir, { recursive: true });
  // NOTE: do NOT pre-create a marker FILE at lockFile -- proper-lockfile
  // creates the lock DIRECTORY at that path, and an existing FILE makes
  // mkdir fail with EEXIST, which proper-lockfile reads as "lock held" ->
  // ELOCKED even when nobody actually holds the lock (the incident of
  // 2026-10-01: checkAndReset failed ELOCKED while the marker file sat
  // untouched since 2026-08-27).
  // proper-lockfile retries: 8 was too few under contention (two windows
  // firing at the same window boundary) -- the lock was held longer than
  // the retry budget, so the lock call threw instead of waiting.
  try {
    await lockfile.lock(lockFile, {
      retries: { retries: 20, factor: 1, minTimeout: 100, maxTimeout: 200 },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "ELOCKED") {
      // Diagnostic (2026-10-01): the lock was held longer than the retry
      // budget -- log WHO failed to take it (pid + path) into the armslog
      // so the actual holder can be identified.
      import("./armslog.js")
        .then(({ armsLog }) =>
          armsLog(
            "state-lock:ELOCKED",
            `диагностика: retries исчерпаны, лок занят другим окном/процессом pid=${process.pid} file=${lockFile}`,
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
      // Ignore unlock errors
    }
  }
}

export async function mutateState<T>(
  transform: (current: State | null) => { next: State | null; result?: T },
): Promise<T | undefined> {
  return withLock(() => {
    const current = readStateSync();
    const { next, result } = transform(current);
    if (next !== null) {
      writeStateSync(next);
    }
    return result;
  });
}