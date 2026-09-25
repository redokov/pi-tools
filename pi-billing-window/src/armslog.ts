/**
 * armslog.ts -- persistent append-only diagnostic log for cont-after-reset.
 *
 * WHY: the armed poller ran for a whole night without firing and the only
 * traces were console.warn calls nobody saw (TUI). Without a persistent log
 * it is impossible to reconstruct AFTER THE FACT which silent guard blocked
 * the fire (not-idle / no-pi / epoch mismatch / stale send / send error).
 * This module writes one line per decision to
 * ~/.pi/agent/pi-billing-window-arms.log and never throws.
 *
 * Format: `2026-09-25T12:00:00.000Z | event | detail`
 * Rotation: when the file exceeds ARMSLOG_MAX_BYTES it is renamed to
 * `.1` (one previous generation is kept, older are dropped).
 *
 * Tests redirect the path via setArmsLogPath()/resetArmsLogPath().
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Rotate when the log grows past this. 512 KiB is ~5k lines. */
const ARMSLOG_MAX_BYTES = 512 * 1024;

let armsLogPath = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "pi-billing-window-arms.log",
);

export function setArmsLogPath(p: string): void {
  armsLogPath = p;
}

export function resetArmsLogPath(): void {
  armsLogPath = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "pi-billing-window-arms.log",
  );
}

export function getArmsLogPath(): string {
  return armsLogPath;
}

let warnLogged = false;

/**
 * Append one diagnostic line. NEVER throws: a logging failure must not
 * kill the poller (the bug we are fixing here was exactly a silent death).
 * A repeated failure is reported to console.warn once per process.
 */
export function armsLog(event: string, detail = ""): void {
  try {
    const dir = path.dirname(armsLogPath);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const size = fs.statSync(armsLogPath).size;
      if (size > ARMSLOG_MAX_BYTES) {
        const backup = armsLogPath + ".1";
        try {
          fs.rmSync(backup, { force: true });
        } catch {}
        try {
          fs.renameSync(armsLogPath, backup);
        } catch {}
      }
    } catch {
      // stat failed (file absent) -- nothing to rotate
    }
    const line = `${new Date().toISOString()} | ${event}${detail ? ` | ${detail}` : ""}\n`;
    fs.appendFileSync(armsLogPath, line, "utf8");
  } catch (err) {
    if (!warnLogged) {
      warnLogged = true;
      console.warn(
        "[pi-billing-window] armslog: запись лога не удалась (далее молча):",
        err,
      );
    }
  }
}
