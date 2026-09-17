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
    assert(
      raw1.slice(1).split("\n")[0] ===
        "ts_iso,epoch_ms,kind,project,session,calls_in_window,reset_count," +
        "input,output,cache_read,cache_write,note,model",
      "schema: first line (after BOM) is the 13-column header with model last",
    );
    assert(rows().length === 2, "append: BOM+header + 1 row after first append");

    await appendHistory(
      { kind: "window_reset", callsInWindow: 0, resetCount: 3, note: "auto" },
      1_000_000_500_000,
    );
    assert(rows().length === 3, "append: second append adds exactly one row");
    const second = rows()[2];
    assert(
      second.includes(",window_reset,") && second.endsWith(",auto,"),
      "append: reset row has kind and note with empty model cell",
    );
    assert(
      (second.match(/,/g) ?? []).length === 12,
      "schema: reset row has 13 cells (12 commas), empty model",
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

    // --- model column: call rows (FR-001) ------------------------------------
    const okModel = await appendHistory(
      { ...base, model: "zai/glm-5.3" },
      1_000_004_000_000,
    );
    assert(okModel === true, "model: append with model returns true");
    assert(
      rows().at(-1)!.endsWith(",zai/glm-5.3"),
      "model: call row ends with the model id",
    );
    await appendHistory({ ...base, model: undefined }, 1_000_004_000_001);
    assert(
      rows().at(-1)!.endsWith(","),
      "model: call row without model ends with empty 13th cell",
    );

    // --- model column: escaping (RFC 4180, shared csvEscape) ----------------
    await appendHistory(
      { ...base, model: 'a,b"c' },
      1_000_004_000_002,
    );
    assert(
      rows().at(-1)!.includes('"a,b""c"'),
      "model: comma/quote in model is escaped per RFC 4180",
    );

    // --- trim on the new 13-column format -------------------------------------
    const fileM = join(tmp, "trim-model.csv");
    const lockM = join(tmp, "trim-model.lock");
    setPaths(fileM, lockM);
    await appendHistory(
      { ...base, model: "zai/glm-5.3", note: "keep-model" },
      now - 1 * day,
    );
    await appendHistory(
      { ...base, model: "zai/glm-5.3", note: "drop-model" },
      now - (RETENTION_DAYS + 1) * day,
    );
    const droppedM = await trimHistory(now);
    const trimModelLines = fs
      .readFileSync(fileM, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    assert(droppedM === 1, "trim-model: reports 1 dropped row");
    assert(
      trimModelLines.length === 2 &&
        trimModelLines[0]!.endsWith(",note,model") &&
        trimModelLines[1]!.endsWith(",zai/glm-5.3"),
      "trim-model: header preserved as-is, kept row keeps its model",
    );
    setPaths(file, lock); // restore for later asserts

    // --- migration: legacy 12-column header (D-102) ---------------------------
    const LEGACY =
      "ts_iso,epoch_ms,kind,project,session,calls_in_window,reset_count," +
      "input,output,cache_read,cache_write,note";
    const legacyRows = [
      "2026-09-01T10:00:00+03:00,1756717200000,call,c:/p,s.jsonl,3,1,10,20,30,0,note1",
      "2026-09-02T10:00:00+03:00,1756803600000,call,c:/p,s.jsonl,4,1,11,21,31,0,note2",
    ];
    const legacyFile = join(tmp, "legacy.csv");
    const legacyLock = join(tmp, "legacy.lock");
    fs.writeFileSync(
      legacyFile,
      "\uFEFF" + LEGACY + "\n" + legacyRows.join("\n") + "\n",
      "utf8",
    );
    setPaths(legacyFile, legacyLock);
    const okMig = await appendHistory(base, 1_000_005_000_000);
    assert(okMig === true, "migration: append to legacy file returns true");
    const migLines = fs.readFileSync(legacyFile, "utf8").split("\n");
    assert(
      migLines[0] ===
        "\uFEFF" +
        "ts_iso,epoch_ms,kind,project,session,calls_in_window,reset_count," +
        "input,output,cache_read,cache_write,note,model",
      "migration: header upgraded to 13 columns, BOM preserved",
    );
    assert(
      migLines[1] === legacyRows[0] && migLines[2] === legacyRows[1],
      "migration: old rows preserved byte-for-byte",
    );
    assert(
      (migLines[3]!.match(/,/g) ?? []).length === 12,
      "migration: new row has 13 cells",
    );
    const okMig2 = await appendHistory(base, 1_000_005_000_001);
    assert(okMig2 === true, "migration: second append returns true");
    const migLines2 = fs.readFileSync(legacyFile, "utf8").split("\n");
    assert(
      migLines2.length === 6 &&
        migLines2[0] === migLines[0] &&
        migLines2[1] === legacyRows[0] &&
        migLines2[2] === legacyRows[1] &&
        migLines2.filter((l) => l.trim() !== "").length === 5,
      "migration: idempotent -- second append adds a row, header/old rows untouched",
    );

    // --- migration: CRLF legacy file stays uniformly CRLF (F1) ---------------
    const crlfFile = join(tmp, "legacy-crlf.csv");
    const crlfLock = join(tmp, "legacy-crlf.lock");
    fs.writeFileSync(
      crlfFile,
      "\uFEFF" + LEGACY + "\r\n" + legacyRows.join("\r\n") + "\r\n",
      "utf8",
    );
    setPaths(crlfFile, crlfLock);
    const okCrlf = await appendHistory(base, 1_000_006_500_000);
    assert(okCrlf === true, "migration-crlf: append returns true");
    const crlfRaw = fs.readFileSync(crlfFile, "utf8");
    const crlfParts = crlfRaw.split("\r\n");
    assert(
      !crlfParts.some((p) => p.includes("\n")),
      "migration-crlf: no bare-LF separators left (file uniformly CRLF)",
    );
    assert(
      crlfParts[0] === "\uFEFF" +
        "ts_iso,epoch_ms,kind,project,session,calls_in_window,reset_count," +
        "input,output,cache_read,cache_write,note,model",
      "migration-crlf: header upgraded, BOM preserved",
    );
    assert(
      crlfParts[1] === legacyRows[0] && crlfParts[2] === legacyRows[1],
      "migration-crlf: old row contents unchanged (byte-for-byte sans EOL)",
    );
    assert(
      crlfParts.filter((l) => l.trim() !== "").length === 4,
      "migration-crlf: header + 2 old + 1 new line",
    );
    assert(
      fs.readdirSync(tmp).filter((f) => f.includes(".tmp.")).length === 0,
      "migration-crlf: no orphan .tmp file after successful migration",
    );

    // --- migration: failed rename leaves no orphan .tmp (F2) ------------------
    // Read-only destination makes renameSync(tmp, file) fail with EPERM on
    // Windows -- a real mid-migration failure without monkey-patching fs.
    const roFile = join(tmp, "legacy-ro.csv");
    const roLock = join(tmp, "legacy-ro.lock");
    fs.writeFileSync(
      roFile,
      "\uFEFF" + LEGACY + "\n" + legacyRows.join("\n") + "\n",
      "utf8",
    );
    fs.chmodSync(roFile, 0o444); // read-only
    setPaths(roFile, roLock);
    const okRo = await appendHistory(base, 1_000_006_600_000);
    fs.chmodSync(roFile, 0o666); // restore for asserts/cleanup
    assert(okRo === false, "migration-fail: append returns false when rename fails");
    const roLeftovers = fs.readdirSync(tmp).filter((f) => f.includes(".tmp."));
    assert(
      roLeftovers.length === 0,
      `migration-fail: no orphan .tmp files (got: ${roLeftovers})`,
    );
    assert(
      fs.readFileSync(roFile, "utf8").split("\n")[0] === "\uFEFF" + LEGACY,
      "migration-fail: original file untouched after failed rename",
    );

    // --- migration: concurrency (5 parallel appends on a legacy file) ---------
    const concFile = join(tmp, "legacy-conc.csv");
    const concLock = join(tmp, "legacy-conc.lock");
    fs.writeFileSync(
      concFile,
      "\uFEFF" + LEGACY + "\n" + legacyRows.join("\n") + "\n",
      "utf8",
    );
    setPaths(concFile, concLock);
    const concResults = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        appendHistory({ ...base, model: "m/" + i }, 1_000_006_000_000 + i),
      ),
    );
    assert(
      concResults.every((r) => r === true),
      "migration-concurrency: all appends ok",
    );
    const concLines = fs
      .readFileSync(concFile, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    assert(
      concLines.filter((l) => l.replace(/^\uFEFF/, "").startsWith("ts_iso,")).length === 1,
      "migration-concurrency: exactly one header line",
    );
    assert(
      concLines.length === 8,
      "migration-concurrency: header + 2 old + 5 new lines",
    );
    assert(
      concLines[1] === legacyRows[0] && concLines[2] === legacyRows[1],
      "migration-concurrency: old rows preserved byte-for-byte",
    );

    // --- foreign header: never touched (design 5.1.4) -------------------------
    const foreignFile = join(tmp, "foreign.csv");
    const foreignLock = join(tmp, "foreign.lock");
    fs.writeFileSync(foreignFile, "foo,bar\nsome,data\n", "utf8");
    setPaths(foreignFile, foreignLock);
    const okForeign = await appendHistory(base, 1_000_007_000_000);
    assert(okForeign === true, "foreign header: append returns true (data kept)");
    const foreignLines = fs
      .readFileSync(foreignFile, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    assert(
      foreignLines[0] === "foo,bar" && foreignLines.length === 3,
      "foreign header: header untouched, row appended",
    );

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
