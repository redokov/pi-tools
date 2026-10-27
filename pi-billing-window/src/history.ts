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
 * billing, the wake scheduler, or the host pi process (same policy as notifier.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import lockfile from "proper-lockfile";

export type HistoryKind =
  | "call"
  | "window_reset"
  | "manual_reset"
  | "settimer"
  | "429"
  | "ping";

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
  warnedForeignHeader = false;
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
  warnedForeignHeader = false;
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
  // Retry budget: see arms.ts / state.ts -- tight factor-1 budget so a
  // same-process contention (appendHistory vs trim from one tick) resolves
  // within one ~100 ms step instead of a ~1s+ default backoff.
  await lockfile.lock(historyLock, {
    retries: { retries: 20, factor: 1, minTimeout: 100, maxTimeout: 200 },
  });
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
 * Foreign (unrecognized) header warning -- at most ONCE per process (spec 013
 * FR-003): the previous per-append warning spammed every pi window on every
 * event. Flag lives for the process lifetime and is reset by setPaths() /
 * resetPaths() so tests with multiple files start clean.
 */
let warnedForeignHeader = false;

/**
 * Silent repair of a NUL-corrupted history file (spec 013 FR-001/FR-002/FR-004).
 * Caller holds the lock. A leading run of NUL bytes is always the result of a
 * crashed write (NTFS zero-fills the allocation after power loss), never a
 * deliberate foreign format -- so we repair it WITHOUT any warning.
 *
 * Algorithm: strip the leading NUL block, restore the file head as BOM +
 * HEADER, keep the surviving data rows byte-for-byte, EOL style taken from the
 * surviving content (CRLF file stays CRLF). The rewrite goes through a tmp
 * file + renameSync (same pattern as the LEGACY migration), so a crash
 * mid-repair leaves either the old (corrupted) or the new (repaired) file,
 * never a mix. Never throws outward: on failure we warn and leave the file
 * untouched (passive observer policy).
 */
function repairNulPrefixLocked(buf: Buffer): void {
  const tmp = historyFile + ".tmp." + process.pid;
  try {
    // Strip the leading NUL block.
    let offset = 0;
    while (offset < buf.length && buf[offset] === 0) offset++;
    let rest = buf.subarray(offset).toString("utf8");
    // A stray BOM may have survived right before the first data row; the new
    // head always carries a fresh BOM, so cut the old one to avoid doubling.
    if (rest.startsWith("\uFEFF")) rest = rest.slice(1);
    // Pathological case: the first surviving line still contains NUL bytes
    // (non-leading corruption) -- that line is destroyed beyond repair, drop
    // it and keep everything after it.
    const firstNl = rest.indexOf("\n");
    const firstLine = firstNl === -1 ? rest : rest.slice(0, firstNl);
    if (firstLine.includes("\x00")) {
      rest = firstNl === -1 ? "" : rest.slice(firstNl + 1);
    }
    // EOL style from the surviving content (same rule as LEGACY migration).
    const eol = rest.includes("\r\n") ? "\r\n" : "\n";
    fs.writeFileSync(tmp, "\uFEFF" + HEADER + eol + rest, "utf8");
    fs.renameSync(tmp, historyFile);
  } catch (err) {
    console.warn("pi-billing-window: history NUL repair failed:", err);
  } finally {
    // Never leave an orphan .tmp behind (rename may have failed midway).
    try {
      fs.unlinkSync(tmp);
    } catch {
      // already renamed away or never written -- nothing to clean up
    }
  }
}

/**
 * Ensure the file exists AND carries the current schema. Caller holds the lock.
 *
 * - Missing file: create with BOM + HEADER.
 * - First line contains NUL bytes (crashed-write corruption, spec 013): silent
 *   repair via repairNulPrefixLocked() -- strip the NUL prefix, restore the
 *   BOM + HEADER head, keep surviving rows. No warning: this is damage
 *   recovery, not a foreign format.
 * - Legacy 12-column header (pre-model): one-time migration to the 13-column
 *   HEADER. Only the first line is replaced; data rows are copied untouched
 *   (old rows stay positionally valid: model is the LAST column). The rewrite
 *   goes through a tmp file + renameSync (same pattern as state.ts), so a
 *   crash mid-migration leaves either the old or the new file, never a mix.
 * - Current header: no-op (idempotent).
 * - Foreign header (no NUL): leave the file alone (fire-and-forget policy)
 *   and warn at most once per process.
 */
function ensureSchemaLocked(): void {
  if (!fs.existsSync(historyFile)) {
    fs.writeFileSync(historyFile, "\uFEFF" + HEADER + "\n", "utf8");
    return;
  }
  // Byte-level read (Buffer): the NUL detection below compares raw bytes, so
  // we never need to decode a multi-MB NUL block, and the same buffer feeds
  // every branch (repair / header / legacy / foreign) after one decode.
  const buf = fs.readFileSync(historyFile);
  const raw = buf.toString("utf8");
  // NUL detection: any 0x00 byte within the first line (up to the first \n;
  // a file without \n counts as one line). NUL is never valid in a UTF-8 CSV
  // header, so this cannot false-positive on a foreign-but-valid file.
  const nlIdx = buf.indexOf(0x0a);
  const firstLineBytes = buf.subarray(0, nlIdx === -1 ? buf.length : nlIdx);
  if (firstLineBytes.includes(0)) {
    repairNulPrefixLocked(buf);
    return; // the current append then writes into the repaired file
  }
  // Detect the file's EOL style BEFORE rewriting, so a CRLF legacy file stays
  // uniformly CRLF after migration (header and data rows share one EOL).
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const first = (lines[0] ?? "").replace(/^\uFEFF/, "");
  if (first === HEADER) return; // already current schema
  if (first !== LEGACY_HEADER) {
    if (!warnedForeignHeader) {
      console.warn(
        "pi-billing-window: unrecognized history header, skipping schema " +
          "migration; rows will still be APPENDED to this file with its " +
          "foreign header, so columns may not line up with the expected schema",
      );
      warnedForeignHeader = true;
    }
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
