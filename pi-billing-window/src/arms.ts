/**
 * arms.ts -- per-conversation "continue after reset" arms for pi-billing-window.
 *
 * An arm is a one-shot request: "when the 2-hour billing window resets, wait
 * ~1 min, then send 'продолжи' into THIS window's active conversation so the
 * interrupted task resumes" (the task was stopped manually or because wormsoft
 * ran out of tokens for the current window).
 *
 * Concurrency model
 * -----------------
 * Every pi window is its own process. Each process only cares about ITS OWN
 * armed conversation, so arms are stored in a small JSON file keyed by the
 * conversation's session file. A process tracks the key of the conversation it
 * is currently showing (`currentKey`); arms belonging to OTHER conversations
 * never affect it.
 *
 * Keeping the flag alive across /new and restarts:
 *  - /new swaps the conversation in the SAME process. The in-memory `currentKey`
 *    is re-pointed and the armed record is MOVED to the new conversation key, so
 *    the arm survives /new (the spec requirement). It will fire into whatever
 *    conversation this window shows when the window resets -- the only chat a
 *    process can address.
 *  - Process restart: on session_start the window re-points `currentKey` to its
 *    conversation file; if that file had an unexpired armed record, the arm is
 *    picked up again.
 *
 * Semantics
 * ---------
 *  - One-shot: index.ts clears the arm right after sending "продолжи".
 *  - TTL: an arm expires ARMS_TTL_MS after arming; expired arms are ignored and
 *    pruned on the next write.
 *  - Trigger: a window reset is detected as state.lastResetAt advancing past the
 *    value recorded when the arm was created (lastResetAtAtArm). Only resets
 *    that happen AFTER arming fire. A pure decision helper resetReadyToFire()
 *    applies the grace period so tests can cover it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import lockfile from "proper-lockfile";

export type Arm = {
  armedAt: number;
  lastResetAtAtArm: number;
  expiresAt: number;
};

export type ArmMap = Record<string, Arm>;

/** How long an armed flag stays valid: 2h window + 10 min slack. */
export const ARMS_TTL_MS = (2 * 60 + 10) * 60 * 1000;
/** After a reset, wait this long before sending "продолжи". */
export const RESET_GRACE_MS = 60 * 1000;

let armsFile = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "pi-billing-window-arms.json",
);
let armsLock = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "pi-billing-window-arms.lock",
);

export function setPaths(newFile: string, newLock: string): void {
  armsFile = newFile;
  armsLock = newLock;
}

export function resetPaths(): void {
  armsFile = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "pi-billing-window-arms.json",
  );
  armsLock = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "pi-billing-window-arms.lock",
  );
}

/** Conversation (session file) this pi process is currently showing. */
let currentKey: string | null = null;

export function getKey(): string | null {
  return currentKey;
}

function readArmsSync(): ArmMap {
  try {
    if (!fs.existsSync(armsFile)) return {};
    return JSON.parse(fs.readFileSync(armsFile, "utf8")) as ArmMap;
  } catch {
    return {};
  }
}

function writeArmsSync(map: ArmMap): void {
  fs.mkdirSync(path.dirname(armsFile), { recursive: true });
  const tmp = armsFile + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), "utf8");
  fs.renameSync(tmp, armsFile);
}

async function withArmsLock<T>(fn: () => Promise<T> | T): Promise<T> {
  fs.mkdirSync(path.dirname(armsLock), { recursive: true });
  if (!fs.existsSync(armsLock)) fs.writeFileSync(armsLock, "{}", "utf8");
  await lockfile.lock(armsLock, { retries: 8 });
  try {
    return await fn();
  } finally {
    try {
      await lockfile.unlock(armsLock);
    } catch {
      // ignore unlock errors
    }
  }
}

function pruneExpired(map: ArmMap, now: number): void {
  for (const k of Object.keys(map)) {
    if (map[k].expiresAt <= now) delete map[k];
  }
}

/**
 * Re-point this window at `newKey` WITHOUT moving any armed record. Used on
 * /resume, /fork, /reload and fresh startup: an arm stays with the
 * conversation that created it, and is only picked up again if this window
 * returns to that conversation (isArmed/getArm read by currentKey).
 * Any unexpired record already stored under `newKey` is simply left in place
 * and picked up by isArmed()/getArm() (process-restart re-adoption).
 */
export function switchKey(newKey: string): void {
  currentKey = newKey;
}

/**
 * Carry the current conversation's armed record to `newKey`. Used on /new
 * (reason "new"), where the user starts a fresh conversation but wants the
 * armed "continue after reset" flag to keep working in this window. If there
 * is no armed record under the previous key, this is a no-op repoint.
 */
export async function carryArmTo(newKey: string): Promise<void> {
  const oldKey = currentKey;
  currentKey = newKey;
  if (oldKey === null || oldKey === newKey) return;
  await withArmsLock(() => {
    const now = Date.now();
    const map = readArmsSync();
    pruneExpired(map, now);
    if (map[oldKey] !== undefined) {
      map[newKey] = map[oldKey];
      delete map[oldKey];
      writeArmsSync(map);
    }
  });
}

function entryForKey(key: string, now: number): Arm | null {
  const a = readArmsSync()[key];
  if (!a) return null;
  if (a.expiresAt <= now) return null;
  return a;
}

/** Is the CURRENT conversation armed (and unexpired)? */
export function isArmed(now: number = Date.now()): boolean {
  const key = currentKey;
  if (!key) return false;
  const a = readArmsSync()[key];
  if (!a) return false;
  // Expired records are pruned on the next arm()/disarm()/carryArmTo() write;
  // no fire-and-forget cleanup here (would risk unhandled rejections).
  return a.expiresAt > now;
}

/** Current conversation's arm (unexpired) or null. */
export function getArm(now: number = Date.now()): Arm | null {
  const key = currentKey;
  if (!key) return null;
  return entryForKey(key, now);
}

/**
 * Arm "continue after reset" for the current conversation. Records the
 * current state.lastResetAt so only a reset happening AFTER this point fires.
 * Idempotent: if an unexpired arm already exists it is left untouched.
 */
export async function arm(
  lastResetAt: number,
  now: number = Date.now(),
): Promise<Arm | null> {
  const key = currentKey;
  if (!key) return null;
  await withArmsLock(() => {
    const map = readArmsSync();
    pruneExpired(map, now);
    if (map[key] && map[key].expiresAt > now) return; // already armed
    map[key] = {
      armedAt: now,
      lastResetAtAtArm: lastResetAt,
      expiresAt: now + ARMS_TTL_MS,
    };
    writeArmsSync(map);
  });
  return getArm(now);
}

/** Remove the current conversation's arm (if any). Returns true if removed. */
export async function disarm(now: number = Date.now()): Promise<boolean> {
  const key = currentKey;
  if (!key) return false;
  let removed = false;
  await withArmsLock(() => {
    const map = readArmsSync();
    pruneExpired(map, now);
    if (map[key] !== undefined) {
      delete map[key];
      removed = true;
      writeArmsSync(map);
    }
  });
  return removed;
}

/**
 * Pure decision helper (unit-testable): is it time to send "продолжи" for
 * this arm? Requires a reset that occurred AFTER arming (lastResetAt advanced
 * past lastResetAtAtArm) AND at least `graceMs` to have passed since that
 * reset. index.ts calls this on its armed poll loop.
 */
export function resetReadyToFire(
  a: Arm,
  st: { lastResetAt: number },
  now: number,
  graceMs: number = RESET_GRACE_MS,
): boolean {
  if (st.lastResetAt <= a.lastResetAtAtArm) return false;
  return now - st.lastResetAt >= graceMs;
}
