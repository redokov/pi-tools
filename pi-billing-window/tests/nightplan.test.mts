/**
 * nightplan.test.mts -- unit-тесты модуля src/nightplan.ts (spec 014, T1).
 *
 * Run: npx tsx tests/nightplan.test.mts
 *
 * Чистые функции (parseHHMM/inInterval/occurrences/nightDateFor) -- без
 * моков на фиксированных локальных датах; персистенция (план + ledger) --
 * реальные tmp-файлы (mkdtemp), парсер history.csv -- на синтетическом CSV.
 * Никаких реальных минут: wall-clock не участвует в ожиданиях.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseHHMM,
  fmtHHMM,
  inInterval,
  nextOccurrence,
  previousOccurrence,
  nightDateFor,
  setPaths as npSetPaths,
  resetPaths as npResetPaths,
  getPlanFile,
  getNightsDir,
  reportPathFor,
  readPlan,
  writePlan,
  clearPlan,
  appendLedger,
  readLedger,
  type NightPlan,
  type LedgerRow,
  parseHistoryCsv,
  readHistoryRows,
  sumTokensInRange,
  buildMorningReport,
} from "../src/nightplan.ts";
import {
  setPaths as historySetPaths,
  resetPaths as historyResetPaths,
  getHistoryFile,
} from "../src/history.ts";

// --- assert harness (tests/watchdog.test.mts style) ---------------------------

const results: string[] = [];
let passed = 0;
let failed = 0;

function assert(cond: boolean, name: string): void {
  if (cond) {
    passed++;
    results.push(`PASS: ${name}`);
  } else {
    failed++;
    results.push(`FAIL: ${name}`);
  }
}

/** Локальный Date на заданную дату-время (детерминизм без моков времени). */
function at(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

const tmp = mkdtempSync(join(tmpdir(), "pbi-nightplan-unit-"));
npSetPaths(
  join(tmp, "nightplan.json"),
  join(tmp, "nightplan.lock"),
  join(tmp, "nights"),
);
historySetPaths(join(tmp, "history.csv"), join(tmp, "history.lock"));

// --- 1. parseHHMM / fmtHHMM ----------------------------------------------------

assert(parseHHMM("22:00") === 22 * 60, "parseHHMM: 22:00 -> 1320");
assert(parseHHMM("08:05") === 8 * 60 + 5, "parseHHMM: 08:05 -> 485");
assert(parseHHMM("0:00") === 0, "parseHHMM: 0:00 -> 0 (одна цифра часа)");
assert(parseHHMM("7:30") === 450, "parseHHMM: 7:30 -> 450");
assert(parseHHMM("25:00") === null, "parseHHMM: 25:00 -> null (час > 23)");
assert(parseHHMM("22:60") === null, "parseHHMM: 22:60 -> null (мин > 59)");
assert(parseHHMM("8:5") === null, "parseHHMM: 8:5 -> null (минуты одной цифрой)");
assert(parseHHMM("abc") === null, "parseHHMM: мусор -> null");
assert(parseHHMM("") === null, "parseHHMM: пустая строка -> null");
assert(fmtHHMM(1320) === "22:00", "fmtHHMM: 1320 -> 22:00");
assert(fmtHHMM(0) === "00:00", "fmtHHMM: 0 -> 00:00");

// --- 2. inInterval (wrap, границы) --------------------------------------------

// Дневной интервал 09:00-17:00
assert(inInterval(at(2026, 10, 25, 12, 0), "09:00", "17:00"), "interval: 12:00 в 09-17");
assert(!inInterval(at(2026, 10, 25, 8, 59), "09:00", "17:00"), "interval: 08:59 вне 09-17");
assert(inInterval(at(2026, 10, 25, 9, 0), "09:00", "17:00"), "interval: граница from включена");
assert(!inInterval(at(2026, 10, 25, 17, 0), "09:00", "17:00"), "interval: граница to не включена");
// Wrap 22:00-08:00 (ночь через полночь)
assert(inInterval(at(2026, 10, 25, 23, 30), "22:00", "08:00"), "interval wrap: 23:30 в 22-08");
assert(inInterval(at(2026, 10, 26, 2, 0), "22:00", "08:00"), "interval wrap: 02:00 в 22-08");
assert(inInterval(at(2026, 10, 26, 0, 0), "22:00", "08:00"), "interval wrap: полночь 00:00 в 22-08");
assert(!inInterval(at(2026, 10, 26, 8, 0), "22:00", "08:00"), "interval wrap: 08:00 не включена");
assert(!inInterval(at(2026, 10, 25, 21, 59), "22:00", "08:00"), "interval wrap: 21:59 вне");
assert(!inInterval(at(2026, 10, 26, 12, 0), "22:00", "08:00"), "interval wrap: полдень вне");
// Вырожденный и битый
assert(!inInterval(at(2026, 10, 25, 12, 0), "10:00", "10:00"), "interval: from===to -> false");
assert(!inInterval(at(2026, 10, 25, 12, 0), "xx:00", "10:00"), "interval: битый from -> false");
assert(!inInterval(at(2026, 10, 25, 12, 0), "10:00", "yy:00"), "interval: битый to -> false");

// --- 3. nextOccurrence / previousOccurrence ------------------------------------

const tomorrow8 = nextOccurrence(at(2026, 10, 25, 22, 0), "08:00");
assert(tomorrow8 === at(2026, 10, 26, 8, 0), "next: 22:00 25-го -> 08:00 26-го");
assert(nextOccurrence(at(2026, 10, 25, 7, 0), "08:00") === at(2026, 10, 25, 8, 0), "next: 07:00 -> сегодня 08:00");
const exactNow = at(2026, 10, 25, 8, 0);
assert(nextOccurrence(exactNow, "08:00") === exactNow, "next: ровно в 08:00 -> сам момент (delay 0)");
assert(nextOccurrence(at(2026, 10, 25, 12, 0), "bad") === null, "next: битое HH:MM -> null");
assert(previousOccurrence(at(2026, 10, 26, 9, 0), "08:00") === at(2026, 10, 26, 8, 0), "prev: 09:00 26-го -> сегодня 08:00");
assert(previousOccurrence(at(2026, 10, 25, 7, 0), "08:00") === at(2026, 10, 24, 8, 0), "prev: 07:00 25-го -> вчера 08:00");
assert(previousOccurrence(exactNow, "08:00") === exactNow, "prev: ровно в момент -> сам момент");

// --- 4. nightDateFor -----------------------------------------------------------

assert(nightDateFor(at(2026, 10, 25, 22, 30), "22:00", "08:00") === "2026-10-25", "nightDate: 22:30 25-го -> 25");
assert(nightDateFor(at(2026, 10, 26, 2, 0), "22:00", "08:00") === "2026-10-25", "nightDate: 02:00 26-го (хвост wrap) -> 25");
assert(nightDateFor(at(2026, 10, 25, 20, 0), "22:00", "08:00") === "2026-10-25", "nightDate: 20:00 25-го (до from) -> 25");
assert(nightDateFor(at(2026, 10, 25, 12, 0), "09:00", "17:00") === "2026-10-25", "nightDate: день 09-17 в интервале -> 25");
assert(nightDateFor(at(2026, 10, 25, 8, 0), "09:00", "17:00") === "2026-10-25", "nightDate: до дневного from -> сегодня");
assert(nightDateFor(at(2026, 10, 25, 20, 0), "09:00", "17:00") === "2026-10-26", "nightDate: после дневного to -> завтра");
assert(nightDateFor(at(2026, 10, 26, 0, 30), "22:00", "08:00") === "2026-10-25", "nightDate: 00:30 26-го -> 25");

// --- 5. Plan CRUD под lock ------------------------------------------------------

function makePlan(overrides: Partial<NightPlan> = {}): NightPlan {
  const now = Date.now();
  return {
    key: "C:/tmp/sess-night.jsonl",
    fromLocal: "22:00",
    toLocal: "08:00",
    repeat: 6,
    backlogPath: null,
    createdAt: now,
    expiresAt: now + 12 * 60 * 60 * 1000,
    nightDate: "2026-10-25",
    ...overrides,
  };
}

assert(readPlan() === null, "plan: нет файла -> null (молча)");
writeFileSync(getPlanFile(), "{ это не json", "utf8");
assert(readPlan() === null, "plan: битый JSON -> null (тихая деградация)");
writeFileSync(getPlanFile(), JSON.stringify({ foo: "bar" }), "utf8");
assert(readPlan() === null, "plan: чужая схема -> null");
{
  const p = makePlan();
  const ok = await writePlan(p);
  assert(ok, "plan: writePlan -> true");
  const back = readPlan();
  assert(back !== null && back.key === p.key && back.repeat === 6, "plan: roundtrip ключ и repeat");
  assert(back !== null && back.fromLocal === "22:00" && back.toLocal === "08:00", "plan: roundtrip интервал");
  assert(back !== null && back.nightDate === "2026-10-25", "plan: roundtrip nightDate");
  // один активный план: перезапись затирает старый
  const ok2 = await writePlan(makePlan({ repeat: 3, key: "C:/tmp/sess-2.jsonl" }));
  assert(ok2, "plan: повторная запись -> true");
  const back2 = readPlan();
  assert(back2 !== null && back2.repeat === 3 && back2.key === "C:/tmp/sess-2.jsonl", "plan: один активный план (перезапись)");
  const removed = await clearPlan();
  assert(removed, "plan: clearPlan удалил файл");
  assert(readPlan() === null, "plan: после clearPlan -> null");
  assert(!(await clearPlan()), "plan: clearPlan без файла -> false (идемпотентно)");
}

// --- 6. Ledger roundtrip --------------------------------------------------------

function ledgerRow(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    tsIso: "2026-10-25T23:30:00+03:00",
    epochMs: Date.now(),
    nightDate: "2026-10-25",
    resetAt: Date.now() - 1000,
    callsInWindow: 4,
    input: 1_500_000,
    output: 200_000,
    cacheRead: 3_000_000,
    armPhase: "armed",
    verdict: "used",
    ...overrides,
  };
}

assert(readLedger().length === 0, "ledger: нет файла -> []");
assert(await appendLedger(ledgerRow()), "ledger: append -> true");
assert(await appendLedger(ledgerRow({ callsInWindow: 0, input: 0, output: 0, cacheRead: 0, armPhase: "none", verdict: "idle", nightDate: "2026-10-26" })), "ledger: вторая append -> true");
const all = readLedger();
assert(all.length === 2, "ledger: readLedger -> обе строки");
assert(all[0].verdict === "used" && all[0].armPhase === "armed", "ledger: строка 1 поля verdict/armPhase");
assert(all[1].verdict === "idle" && all[1].armPhase === "none", "ledger: строка 2 поля verdict/armPhase");
assert(readLedger("2026-10-25").length === 1, "ledger: фильтр по nightDate");
assert(readFileSync(join(getNightsDir(), "ledger.csv"), "utf8").includes("ts_iso,epoch_ms"), "ledger: header записан");
assert(readFileSync(join(getNightsDir(), "ledger.csv"), "utf8").charCodeAt(0) === 0xfeff, "ledger: BOM на месте (Excel-паттерн)");

// --- 7. history.csv parser + суммы ----------------------------------------------

const H = getHistoryFile();
const base = at(2026, 10, 25, 22, 30);
writeFileSync(
  H,
  "\uFEFF" +
    "ts_iso,epoch_ms,kind,project,session,calls_in_window,reset_count,input,output,cache_read,cache_write,note,model\n" +
    `t1,${base},call,"C:/a,b",s1,1,1,1000,200,5000,0,,m1\n` +
    `t2,${base + 1000},call,P2,s2,2,1,3000,400,7000,0,,m1\n` +
    `t3,${base + 2000},429,P3,s3,2,1,,,,,limit exhausted,\n` +
    `t4,${base + 10000},call,P4,s4,3,1,999999,1,1,0,,m1\n`,
  "utf8",
);
{
  const rows = parseHistoryCsv(readFileSync(H, "utf8"));
  assert(rows.length === 4, "history: разобраны 4 строки (header пропущен)");
  assert(rows[0].input === 1000 && rows[0].output === 200 && rows[0].cacheRead === 5000, "history: токены call-строки");
  assert(rows[2].kind === "429" && rows[2].input === 0, "history: 429-строка с пустыми токенами -> 0");
  const s1 = sumTokensInRange(rows, base, base + 2000);
  assert(s1.input === 4000 && s1.output === 600 && s1.cacheRead === 12000, "history: сумма в диапазоне (429 не считается)");
  const s2 = sumTokensInRange(rows, base, base + 100);
  assert(s2.input === 1000, "history: узкий диапазон");
  assert(sumTokensInRange(rows, base + 999999, base + 1000000).input === 0, "history: пустой диапазон -> 0");
  const rr = readHistoryRows(base, base + 2000);
  assert(rr.length === 2, "history: readHistoryRows фильтрует диапазон через текущий путь");
}

// --- 8. buildMorningReport ------------------------------------------------------

{
  const plan = makePlan({ createdAt: base, expiresAt: base + 12 * 3600_000 });
  const rows = parseHistoryCsv(readFileSync(H, "utf8"));
  const l1 = ledgerRow({ resetAt: base + 5000, callsInWindow: 2, verdict: "used", armPhase: "armed", nightDate: plan.nightDate });
  const l2 = ledgerRow({ resetAt: base + 9000, callsInWindow: 0, input: 0, output: 0, cacheRead: 0, verdict: "idle", armPhase: "none", nightDate: plan.nightDate, epochMs: base + 9000 });
  const md = buildMorningReport(plan, [l1, l2], rows, {
    version: "014.2026-10-25",
    nowMs: base + 11 * 3600_000,
    rearmCount: 2,
    uninsuredCount: 1,
  });
  assert(md.includes("# Ночной отчёт — 2026-10-25 (22:00–08:00)"), "report: шапка с nightDate и интервалом");
  assert(md.includes("version: 014.2026-10-25"), "report: version в шапке");
  assert(md.includes("| 1 |") && md.includes("| 2 |"), "report: обе строки таблицы");
  assert(md.includes("used") && md.includes("idle"), "report: verdict-колонка");
  assert(md.includes("no-arm (не был застрахован на момент сброса)"), "report: причина idle+none");
  assert(md.includes("использовано: 1, простаивало: 1"), "report: итоги used/idle");
  assert(md.includes("auto-rearm событий: 2"), "report: счётчик auto-rearm");
  assert(md.includes("~5M кредитов"), "report: блок потерь при незастрахованном окне");
  const tok = sumTokensInRange(rows, l1.resetAt, l2.resetAt);
  assert(md.includes(`| ${tok.input} |`), "report: токены окна из history.csv");
  // backlog
  const mdBacklog = buildMorningReport(
    makePlan({ backlogPath: "C:/tasks/night.md", createdAt: base, expiresAt: base + 12 * 3600_000 }),
    [l1],
    rows,
    { version: "014.2026-10-25", nowMs: base + 11 * 3600_000 },
  );
  assert(mdBacklog.includes("backlog: C:/tasks/night.md"), "report: строка backlog");
  assert(!mdBacklog.includes("Потери"), "report: без idle-окон блока потерь нет");
  // пустая книга
  const mdEmpty = buildMorningReport(makePlan(), [], [], { version: "014.2026-10-25" });
  assert(mdEmpty.includes("окон в книге нет"), "report: пустая книга -- честная пометка");
  assert(mdEmpty.includes("окна: 0") === false, "report: пустая книга не рисует нулевую таблицу итогов окон");
}

// --- 9. reportPathFor / getNightsDir --------------------------------------------

assert(reportPathFor("2026-10-25") === join(getNightsDir(), "report-2026-10-25.md"), "reportPath: nights/report-<date>.md");
assert(existsSync(getNightsDir()), "nightsDir: каталог создан appendLedger'ом");

// --- cleanup ---------------------------------------------------------------------

npResetPaths();
historyResetPaths();
rmSync(tmp, { recursive: true, force: true });

console.log("\n========================================");
for (const r of results) console.log(r);
console.log("========================================");
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
