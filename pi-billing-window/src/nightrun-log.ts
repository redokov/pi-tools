/**
 * nightrun-log.ts — transition log for /night-run (spec 015, FR-015-8).
 *
 * Append-only JSONL (каждая строка — JSON record). Фиксирует каждое изменение
 * status, причину простоя, попытки, результаты. Пишется атомарно (append
 * под lock). Separate from armslog (который для cont-after-reset), от
 * history.csv (который для токенов).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import lockfile from "proper-lockfile";
import type { NightRunStatus, NightRunResult } from "./nightrun-state.js";

export type TransitionAction =
  | "init"
  | "resume"
  | "dispatch"
  | "result"
  | "advance"
  | "retry"
  | "pause"
  | "skip"
  | "stop"
  | "complete"
  | "fail";

export type TransitionReason =
  | "user-init"
  | "user-pause"
  | "user-resume"
  | "user-skip"
  | "user-stop"
  | "dispatch-sent"
  | "pass"
  | "fail"
  | "429"
  | "owner-busy"
  | "switch-needed"
  | "stale"
  | "awaiting-result"
  | "after-boundary"
  | "state-lock-busy"
  | "backlog-invalid"
  | "backlog-hash-mismatch"
  | "retry-exhausted"
  | "task-oversized"
  | "recovery-unresolved"
  | "completed"
  | "unknown";

export type TransitionRecord = {
  timestamp: number;
  plan: string;
  task: number;
  fromStatus: NightRunStatus | null;
  toStatus: NightRunStatus;
  action: TransitionAction;
  reason: TransitionReason;
  attempt: number;
  result: NightRunResult;
};

let logFile = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "pi-billing-window-nights",
  "nightrun-transitions.jsonl",
);
let logLock = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "pi-billing-window-nights",
  "nightrun-transitions.lock",
);

export function setPaths(newLogFile: string, newLogLock: string): void {
  logFile = newLogFile;
  logLock = newLogLock;
}

export function resetPaths(): void {
  logFile = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "pi-billing-window-nights",
    "nightrun-transitions.jsonl",
  );
  logLock = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "pi-billing-window-nights",
    "nightrun-transitions.lock",
  );
}

export function getLogFile(): string {
  return logFile;
}

/**
 * Append transition record to log (under lock). Creates parent dir + file
 * if needed. Never throws — silent degrade on write failure.
 */
export async function appendTransition(
  record: TransitionRecord,
): Promise<void> {
  try {
    const dir = path.dirname(logFile);
    fs.mkdirSync(dir, { recursive: true });

    // Pre-create marker file for lock (pattern from nightplan.ts).
    const lockDir = path.dirname(logLock);
    fs.mkdirSync(lockDir, { recursive: true });
    if (!fs.existsSync(logLock)) fs.writeFileSync(logLock, "{}", "utf8");

    await lockfile.lock(logLock, {
      retries: { retries: 10, factor: 1, minTimeout: 50, maxTimeout: 100 },
    });

    try {
      const line = JSON.stringify(record) + "\n";
      fs.appendFileSync(logFile, line, "utf8");
    } finally {
      try {
        await lockfile.unlock(logLock);
      } catch {
        // Ignore unlock errors.
      }
    }
  } catch (err) {
    // Silent degrade: log append failure is not fatal.
    console.warn(
      "pi-billing-window: nightrun-log append failed:",
      (err as Error)?.message ?? String(err),
    );
  }
}

/**
 * Read all transition records from log. Returns empty array if log does not
 * exist or is unreadable. Never throws.
 */
export function readTransitions(): TransitionRecord[] {
  try {
    if (!fs.existsSync(logFile)) return [];
    const raw = fs.readFileSync(logFile, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const records: TransitionRecord[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as TransitionRecord;
        records.push(parsed);
      } catch {
        // Skip malformed lines.
      }
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * Clear the transition log file. Returns true if deleted, false if didn't
 * exist. Never throws.
 */
export function clearLog(): boolean {
  try {
    if (fs.existsSync(logFile)) {
      fs.unlinkSync(logFile);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
