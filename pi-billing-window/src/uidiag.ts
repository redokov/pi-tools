/**
 * uidiag.ts -- JSON-lines diagnostics for status-widget update failures.
 *
 * Spec 018 (FR-018-2, NFR-018-1/2/3): every failure to update the status
 * bar widget (a stale ctx throwing, a silent early return on an event path)
 * leaves one JSON line in ~/.pi/agent/pi-billing-window-uidiag.log so a
 * post-mortem of a "frozen indicator" incident comes down to reading one
 * small file.
 *
 * - Line: {"ts":"<ISO8601>","pid":<process.pid>,"reason":...,"detail":...}
 *   (detail truncated to 200 chars; line ~<=200 bytes).
 * - Rate-limit (D-003): one line per REASON EPISODE per process (an episode
 *   = consecutive events of the same reason in the process lifetime; a
 *   different reason starts a new episode).
 * - Cap (FR-018-2): once the file exceeds 400 lines it is trimmed to the
 *   last 200 -- the file never grows unbounded.
 * - Passive (NFR-018-1): the whole body is wrapped in try/catch -- any fs
 *   failure (no rights, disk gone) is swallowed silently; diagnostics must
 *   never crash the host process.
 *
 * Best-effort shared log for all pi windows on the machine: appending one
 * short line is OS-atomaric enough; `pid` in the line tells windows apart;
 * losing a line in a race window is acceptable (this is NOT state).
 *
 * Dependencies: node:fs / node:os / node:path only (no new deps, D-002).
 * Paths are exposed as set/reset functions so tests can override them
 * (the state.ts setPaths pattern).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "pi-billing-window-uidiag.log",
);

// Cap semantics: write the line first, then if the file has grown past
// MAX_LINES trim it to the last KEEP_LINES (FR-018-2: "при превышении 400
// строк файл обрезается до последних 200" -- after a capped write the file
// holds exactly KEEP_LINES lines).
const MAX_LINES = 400;
const KEEP_LINES = 200;
const MAX_DETAIL_CHARS = 200;

let uidiagFile = DEFAULT_PATH;

// Episode rate-limit state (D-003): the reason of the last ACCEPTED write.
// Lives with the process; stop/start of the status updater does NOT reset
// it (design §5). The *ForTests hooks reset it so every test starts a
// fresh episode against its own file.
let lastReason: string | null = null;

export function setUidiagPathForTests(p: string): void {
  uidiagFile = p;
  lastReason = null;
}

export function resetUidiagPathForTests(): void {
  uidiagFile = DEFAULT_PATH;
  lastReason = null;
}

export function uidiag(reason: string, detail?: string): void {
  try {
    // Episode rate-limit: consecutive identical reasons collapse to one
    // line (the repeating dead-ctx tick is the main flood source).
    if (reason === lastReason) return;

    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        reason,
        detail: (detail ?? "").slice(0, MAX_DETAIL_CHARS),
      }) + "\n";

    fs.appendFileSync(uidiagFile, line, "utf8");
    lastReason = reason;

    // Cap: rare (only failures are logged), the file is small -- a sync
    // read+rewrite is cheap (NFR-018-3).
    const raw = fs.readFileSync(uidiagFile, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    if (lines.length > MAX_LINES) {
      fs.writeFileSync(
        uidiagFile,
        lines.slice(-KEEP_LINES).join("\n") + "\n",
        "utf8",
      );
    }
  } catch {
    // NFR-018-1: diagnostics must never throw (no rights / disk gone /
    // directory missing). Swallow silently -- no console output either.
  }
}
