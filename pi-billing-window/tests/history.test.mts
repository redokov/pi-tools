/**
 * history.test.mts -- unit tests for src/history.ts (CSV call/reset history).
 *
 * Run: .\node_modules\.bin\tsx.cmd tests/history.test.mts
 */

import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  setPaths,
  resetPaths,
  appendHistory,
  trimHistory,
  csvEscape,
  isoLocal,
  RETENTION_DAYS,
  type HistoryRow,
} from "../src/history.ts";

let tmp: string;
let pass = 0;
let fail = 0;

function assert(cond: boolean, name: string): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.error(`FAIL  ${name}`);
  }
}

function read(): string {
  return fs.readFileSync(join(tmp, "history.csv"), "utf8");
}

function rows(): string[] {
  return read().split("\n").filter((l) => l.trim() !== "");
}

const base: HistoryRow = {
  kind: "call",
  project: "c:/Tools",
  session: "abc.jsonl",
  callsInWindow: 5,
  resetCount: 2,
  usage: { input: 100, output: 50, cacheRead: 700, cacheWrite: 10 },
};

async function main(): Promise<void> {
  tmp = mkdtempSync(join(tmpdir(), "billing-history-"));
  const file = join(tmp, "history.csv");
  const lock = join(tmp, "history.lock");
  setPaths(file, lock);

  try {
    // --- creation: BOM + header exactly once -------------------------------
    const ok1 = await appendHistory(base, 1_000_000_000_000);
    assert(ok1 === true, "append: first append returns true");
    const raw1 = read();
    assert(raw1.charCodeAt(0) === 0xfeff, "append: file starts with UTF-8 BOM");
    assert(
      raw1.slice(1).startsWith("ts_iso,epoch_ms,kind,project,session,"),
      "append: header row is correct",
    );
    assert(rows().length === 2, "append: BOM+header + 1 row after first append");

    await appendHistory(
      { kind: "window_reset", callsInWindow: 0, resetCount: 3, note: "auto" },
      1_000_000_500_000,
    );
    assert(rows().length === 3, "append: second append adds exactly one row");
    const second = rows()[2];
    assert(
      second.includes(",window_reset,") && second.endsWith(",auto"),
      "append: reset row has kind and note",
    );
    assert(
      (second.match(/,/g) ?? []).length >= 11,
      "append: reset row has empty project/session/usage cells",
    );

    // --- csv escaping -------------------------------------------------------
    assert(csvEscape("plain") === "plain", "csvEscape: plain untouched");
    assert(csvEscape("a,b") === '"a,b"', "csvEscape: comma -> quoted");
    assert(csvEscape('say "hi"') === '"say ""hi"""', "csvEscape: quotes doubled");
    assert(csvEscape("new\nline") === '"new\nline"', "csvEscape: newline -> quoted");
    assert(csvEscape(undefined) === "", "csvEscape: undefined -> empty");

    const okEsc = await appendHistory(
      { kind: "settimer", project: "c:/проект, тест", note: 'sync "1h30m", x' },
      1_000_001_000_000,
    );
    assert(okEsc === true, "append: special chars accepted");
    const escRow = rows()[3];
    assert(
      escRow.includes('"c:/проект, тест"') && escRow.includes('"sync ""1h30m"", x"'),
      "append: comma/quote fields escaped per RFC 4180",
    );

    // --- isoLocal -----------------------------------------------------------
    const d = new Date(2026, 8, 12, 14, 3, 21); // local Sep 12 2026 14:03:21
    const iso = isoLocal(d);
    assert(
      iso.startsWith("2026-09-12T14:03:21") && /[+-]\d{2}:\d{2}$/.test(iso),
      "isoLocal: local date/time with UTC offset",
    );

    // --- concurrency: 5 parallel appends, no lost rows ----------------------
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        appendHistory({ ...base, callsInWindow: 10 + i }, 1_000_002_000_000 + i),
      ),
    );
    assert(results.every((r) => r === true), "concurrency: all appends ok");
    const dataRows = rows().length - 1; // minus header
    assert(
      dataRows === 8,
      `concurrency: 3 earlier + 5 parallel = 8 rows, got ${dataRows} (no loss)`,
    );

    // --- retention trim ------------------------------------------------------
    const now = 1_800_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    const file2 = join(tmp, "trim.csv");
    const lock2 = join(tmp, "trim.lock");
    setPaths(file2, lock2);
    await appendHistory({ ...base, note: "keep-recent" }, now - 1 * day);
    await appendHistory({ ...base, note: "drop-old" }, now - (RETENTION_DAYS + 1) * day);
    await appendHistory({ ...base, note: "keep-edge" }, now - (RETENTION_DAYS - 1) * day);
    const dropped = await trimHistory(now);
    const trimLines = fs.readFileSync(file2, "utf8").split("\n").filter((l) => l.trim() !== "");
    assert(dropped === 1, "trim: reports 1 dropped row");
    assert(trimLines.length === 3, "trim: header + 2 kept rows");
    assert(
      trimLines.some((l) => l.includes("keep-recent")) &&
        trimLines.some((l) => l.includes("keep-edge")) &&
        !trimLines.some((l) => l.includes("drop-old")),
      "trim: keeps rows newer than RETENTION_DAYS, drops older",
    );
    assert(
      (await trimHistory(now)) === 0,
      "trim: second run is a no-op (0 dropped)",
    );
    setPaths(file, lock); // restore for later asserts

    // --- failure tolerance ---------------------------------------------------
    const dirAsFile = join(tmp, "i-am-a-directory");
    fs.mkdirSync(dirAsFile);
    const lock3 = join(tmp, "bad.lock");
    setPaths(dirAsFile, lock3);
    const okBad = await appendHistory(base, 1_000_003_000_000);
    assert(okBad === false, "failure: append into invalid path returns false (no throw)");
    const okTrimBad = await trimHistory(1_000_003_000_000);
    assert(okTrimBad === 0, "failure: trim on invalid path returns 0 (no throw)");
    resetPaths();

    // --- resetPaths restores the real file location --------------------------
    assert(
      !getHistoryPath().includes(tmp),
      "resetPaths: real path restored",
    );
  } finally {
    resetPaths();
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log("========================================");
  console.log(`\n==== ${pass} passed, ${fail} failed ====\n`);
  if (fail > 0) process.exit(1);
}

import { getHistoryFile as getHistoryPath } from "../src/history.ts";

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
