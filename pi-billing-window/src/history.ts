/**
 * history.ts -- append-only CSV history of calls/resets for pi-billing-window.
 *
 * Every row records one event: a successful wormsoft call ("call"), a window
 * reset (auto / manual / settimer-triggered), or a timer sync ("settimer").
 * The file lives at ~/.pi/agent/pi-billing-window-history.csv and is shared by
 * ALL running pi processes (the wormsoft limit is account-wide, so per-project
 * AND total analytics both matter). Project attribution is a column, not a
 * file-per-project scheme.
 *
 * Concurrency: same proven pattern as state.ts/arms.ts -- proper-lockfile
 * serializes appends (critical section is one line write, ~ms; LLM calls take
 * seconds, so contention is nil). Naive cross-process append is NOT atomic on
 * Windows, hence the lock.
 *
 * Encoding: UTF-8 with BOM on file creation -- otherwise Excel on Windows
 * shows Cyrillic project paths (e.g. "Комус") as mojibake. pandas reads
 * utf-8-sig transparently.
 *
 * Retention: trimHistory() drops rows older than RETENTION_DAYS (30) and is
 * invoked on session_start under the same lock. The file is tiny, so a full
 * rewrite is cheap.
 *
 * Failure policy: appendHistory/trimHistory never throw -- they return
 * false / 0 and warn. History is a passive observer; it must never break
 * billing, the ticker, or the host pi process (same policy as notifier.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import lockfile from "proper-lockfile";

export type HistoryKind =
  | "call"
  | "window_reset"
  | "manual_reset"
  | "settimer";

/** Token usage of the LLM response, when the provider reports it. */
export type HistoryUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type HistoryRow = {
  kind: HistoryKind;
  /** Full cwd of the session that produced the event ("project"). */
  project?: string;
  /** Basename of the session file (distinguishes agents in the same cwd). */
  session?: string;
  /** ctx.model.id for "call" rows; other kinds leave it empty. */
  model?: string;
  callsInWindow?: number;
  resetCount?: number;
  usage?: HistoryUsage | null;
  note?: string;
};

/** Rows older than this are dropped by trimHistory(). */
export const RETENTION_DAYS = 30;

const HEADER =
  "ts_iso,epoch_ms,kind,project,session,calls_in_window,reset_count," +
  "input,output,cache_read,cache_write,note,model";

/** Pre-model 12-column header; used only to detect and upgrade legacy files. */
const LEGACY_HEADER =
  "ts_iso,epoch_ms,kind,project,session,calls_in_window,reset_count," +
  "input,output,cache_read,cache_write,note";

let historyFile = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "pi-billing-window-history.csv",
);
let historyLock = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "pi-billing-window-history.lock",
);

export function setPaths(newFile: string, newLock: string): void {
  historyFile = newFile;
  historyLock = newLock;
}

export function resetPaths(): void {
  historyFile = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "pi-billing-window-history.csv",
  );
  historyLock = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "pi-billing-window-history.lock",
  );
}

export function getHistoryFile(): string {
  return historyFile;
}

/** RFC 4180: quote a field if it contains quotes/commas/newlines. */
export function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** ISO-8601 with the local UTC offset (e.g. 2026-09-12T14:03:21+03:00). */
export function isoLocal(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const offH = Math.floor(Math.abs(off) / 60);
  const offM = Math.abs(off) % 60;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(offH)}:${pad(offM)}`
  );
}

function buildRow(row: HistoryRow, now: number): string {
  const u = row.usage ?? {};
  const cells: unknown[] = [
    isoLocal(new Date(now)),
    now,
    row.kind,
    row.project ?? "",
    row.session ?? "",
    row.callsInWindow ?? "",
    row.resetCount ?? "",
    u.input ?? "",
    u.output ?? "",
    u.cacheRead ?? "",
    u.cacheWrite ?? "",
    row.note ?? "",
    row.model ?? "",
  ];
  return cells.map(csvEscape).join(",");
}

async function withHistoryLock<T>(fn: () => T): Promise<T> {
  fs.mkdirSync(path.dirname(historyLock), { recursive: true });
  if (!fs.existsSync(historyLock)) fs.writeFileSync(historyLock, "{}", "utf8");
  await lockfile.lock(historyLock, { retries: 8 });
  try {
    return fn();
  } finally {
    try {
      await lockfile.unlock(historyLock);
    } catch {
      // ignore unlock errors
    }
  }
}

/**
 * Ensure the file exists AND carries the current schema. Caller holds the lock.
 *
 * - Missing file: create with BOM + HEADER.
 * - Legacy 12-column header (pre-model): one-time migration to the 13-column
 *   HEADER. Only the first line is replaced; data rows are copied untouched
 *   (old rows stay positionally valid: model is the LAST column). The rewrite
 *   goes through a tmp file + renameSync (same pattern as state.ts), so a
 *   crash mid-migration leaves either the old or the new file, never a mix.
 * - Current header: no-op (idempotent).
 * - Foreign header: warn and leave the file alone (fire-and-forget policy).
 */
function ensureSchemaLocked(): void {
  if (!fs.existsSync(historyFile)) {
    fs.writeFileSync(historyFile, "\uFEFF" + HEADER + "\n", "utf8");
    return;
  }
  const raw = fs.readFileSync(historyFile, "utf8");
  // Detect the file's EOL style BEFORE rewriting, so a CRLF legacy file stays
  // uniformly CRLF after migration (header and data rows share one EOL).
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const first = (lines[0] ?? "").replace(/^\uFEFF/, "");
  if (first === HEADER) return; // already current schema
  if (first !== LEGACY_HEADER) {
    console.warn(
      "pi-billing-window: unrecognized history header, skipping schema " +
        "migration; rows will still be APPENDED to this file with its " +
        "foreign header, so columns may not line up with the expected schema",
    );
    return;
  }
  const hadBom = (lines[0] ?? "").startsWith("\uFEFF");
  lines[0] = (hadBom ? "\uFEFF" : "") + HEADER;
  const tmp = historyFile + ".tmp." + process.pid;
  try {
    fs.writeFileSync(tmp, lines.join(eol), "utf8");
    fs.renameSync(tmp, historyFile);
  } finally {
    // Never leave an orphan .tmp behind (rename may have failed midway).
    try {
      fs.unlinkSync(tmp);
    } catch {
      // already renamed away or never written -- nothing to clean up
    }
  }
}

function detectEol(): string {
  try {
    const raw = fs.readFileSync(historyFile, "utf8");
    return raw.includes("\r\n") ? "\r\n" : "\n";
  } catch {
    return "\n";
  }
}

/**
 * Append one event row. Never throws; returns false on failure (warns).
 */
export async function appendHistory(
  row: HistoryRow,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const line = buildRow(row, now);
    await withHistoryLock(() => {
      ensureSchemaLocked();
      fs.appendFileSync(historyFile, line + detectEol(), "utf8");
    });
    return true;
  } catch (err) {
    console.warn("pi-billing-window: history append failed:", err);
    return false;
  }
}

/**
 * Drop rows older than RETENTION_DAYS. Returns the number of dropped rows
 * (0 also on failure). Never throws.
 */
export async function trimHistory(now: number = Date.now()): Promise<number> {
  try {
    let dropped = 0;
    await withHistoryLock(() => {
      if (!fs.existsSync(historyFile)) return;
      const raw = fs.readFileSync(historyFile, "utf8");
      const lines = raw.split("\n");
      // First physical line may carry the BOM; preserve the file's own head.
      const head = lines[0]?.includes("ts_iso,") ? lines[0] : "";
      const minEpoch = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
      const kept: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "") continue;
        if (i === 0 && head !== "") continue; // header handled below
        const cols = line.split(",");
        const epoch = Number(cols[1]);
        if (!Number.isFinite(epoch) || epoch >= minEpoch) {
          kept.push(line);
        } else {
          dropped++;
        }
      }
      if (dropped === 0) return;
      const out = (head !== "" ? head + "\n" : "") + kept.join("\n") + "\n";
      fs.writeFileSync(historyFile, out, "utf8");
    });
    return dropped;
  } catch (err) {
    console.warn("pi-billing-window: history trim failed:", err);
    return 0;
  }
}
