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
  if (!fs.existsSync(lockFile)) {
    fs.writeFileSync(lockFile, "{}", "utf8");
  }
  await lockfile.lock(lockFile, { retries: 8 });
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