/**
 * firelease.test.mts -- spec 006, задача T-03 (RED): юнит-ожидания межпроцессного
 * дедупа сброса (FR-201..204, D-604/D-605) через модуль src/firelease.ts.
 *
 * Run: npx tsx tests/firelease.test.mts
 *
 * RED-статус: модуль -- RED-stub (src/firelease.ts), acquire/release не имеют логики.
 * Сьют грузится и завершается process.exit(failed>0?1:0); FAIL — по ассертам (нет логики).
 * После GREEN (T-04) все asserts должны проходить без правки теста.
 *
 * Имитация «двух процессов» на юнит-уровне: держатель эмулируется рукописным
 * маркером в temp-каталоге (pid = наш живой pid = «другой процесс» / DEAD_PID = мёртвый).
 * Сценарии: O_EXCL-сагth -> ok; чужой живой маркер -> skip+holderPid; takeover по TTL
 * и по мёртвому pid; release compare-and-remove (pid+ep, не сносит аренду после takeover);
 * два keyId -> два независимых маркера; рестарт-имитация -> нет re-fire; TTL = 10 мин;
 * никаких persistent-таймеров (процесс сам завершается).
 */

import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

import {
  FIRE_LEASE_TTL_MS,
  acquireFireLease,
  releaseFireLease,
  setFiresDirPath,
  getFiresDirPath,
  type FireLeaseResult,
} from "../src/firelease.ts";

// --- tiny assert harness (tests/*.test.mts house style) -----------------------

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- фикстуры ------------------------------------------------------------------

const KEY_A = "C:\\Users\\dev\\pi\\sessions\\night-user.json";
const KEY_B = "C:\\Users\\dev\\pi\\sessions\\daily-user.json";
const RESET = 1790000000000; // st.lastResetAt: общий сброс для дедупа
const HOST = hostname().split(".")[0];
const DEAD_PID = 2_147_483_647; // максимальный pid int32: гарантированно не существует

let tmpRoot = "";
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "firelease-unit-"));
  return d;
}

/** keyId = sha1(key).slice(0,16) (design §6.1) — тест считает его независимо, чтобы
 *  уметь писать маркеры «чужого держателя» до вызова acquire. */
function keyIdOf(key: string): string {
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

function markerPath(dir: string, key: string, reset: number): string {
  return join(dir, keyIdOf(key), `${reset}.mark`);
}

function writeMarker(dir: string, key: string, reset: number, content: object): void {
  const p = markerPath(dir, key, reset);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(content), "utf8");
}

/** Безопасное чтение: null вместо исключения (stub не создаёт файлов). */
function readMarkerSafe(dir: string, key: string, reset: number): Record<string, unknown> | null {
  const p = markerPath(dir, key, reset);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// --- сценарии ------------------------------------------------------------------

/** S1/S2: поверхность API и константа TTL. */
async function testApiSurface(): Promise<void> {
  console.log("\n--- API surface + TTL const ---");
  assert(
    FIRE_LEASE_TTL_MS === 10 * 60_000,
    `TTL const = 10 минут (получено ${FIRE_LEASE_TTL_MS})`,
  );
  assert(typeof acquireFireLease === "function", "acquireFireLease экспортирована");
  assert(typeof releaseFireLease === "function", "releaseFireLease экспортирована");
  assert(typeof setFiresDirPath === "function", "setFiresDirPath экспортирован (хук каталога)");

  const a = freshDir();
  const b = freshDir();
  setFiresDirPath(a);
  assert(getFiresDirPath() === a, "setFiresDirPath переопределяет каталог маркеров");
  setFiresDirPath(b);
  assert(getFiresDirPath() === b, "каталог маркеров переопределяем повторно (сменяемый)");
}

/** S3: чистый каталог — первый acquire на (key, reset) успешен, маркер создан. */
async function testAcquireFresh(): Promise<void> {
  console.log("\n--- acquire на чистом каталоге (O_EXCL) ---");
  const dir = freshDir();
  setFiresDirPath(dir);
  const r: FireLeaseResult = acquireFireLease(KEY_A, RESET);
  assert(r.ok === true, "пустой каталог: acquire ok:true");
  assert(r.replaced === undefined, "первый acquire — НЕ takeover (replaced отсутствует)");
  const m = readMarkerSafe(dir, KEY_A, RESET);
  assert(m !== null, "маркер-файл создан по пути <keyId>/<reset>.mark");
  assert(m?.pid === process.pid, `маркер хранит pid держателя (${process.pid})`);
  assert(m?.key === KEY_A, "маркер хранит полный путь ключа (атрибуция)");
  assert(m?.reset === RESET, "маркер хранит lastResetAt");
  assert(typeof m?.ep === "number", "маркер хранит эпоху (ep: number)");
  assert(m?.mode === "planned", "маркер в режиме planned");
}

/** S4: чужой ЖИВОЙ маркер (TTL жив + pid жив) -> skip ok:false + holderPid, маркер цел. */
async function testForeignLive(): Promise<void> {
  console.log("\n--- чужой живой маркер (TTL жив + pid жив) ---");
  const dir = freshDir();
  setFiresDirPath(dir);
  writeMarker(dir, KEY_A, RESET, {
    locked_at: Date.now(),
    pid: process.pid, // «другой процесс», чей pid жив
    host: HOST,
    ep: 3,
    reset: RESET,
    key: KEY_A,
    mode: "planned",
  });
  const r: FireLeaseResult = acquireFireLease(KEY_A, RESET);
  assert(r.ok === false, "живой чужой маркер: acquire ok:false (skip)");
  assert(r.holderPid === process.pid, `skip возвращает holderPid живого держателя (${process.pid})`);
  assert(readMarkerSafe(dir, KEY_A, RESET)?.pid === process.pid, "живой маркер не перезаписан");
  assert(existsSync(markerPath(dir, KEY_A, RESET)), "живой маркер не удалён");
}

/** S5: takeover при ИСТЕКШЕМ TTL (pid жив, но locked_at старше TTL) -> ok:true, replaced:true. */
async function testTakeoverByTtl(): Promise<void> {
  console.log("\n--- takeover по истёкшему TTL ---");
  const dir = freshDir();
  setFiresDirPath(dir);
  const OLD_EP = 3;
  writeMarker(dir, KEY_A, RESET, {
    locked_at: Date.now() - FIRE_LEASE_TTL_MS - 60_000, // TTL давно истёк
    pid: process.pid, // pid формально жив — решает только TTL
    host: HOST,
    ep: OLD_EP,
    reset: RESET,
    key: KEY_A,
    mode: "planned",
  });
  const r: FireLeaseResult = acquireFireLease(KEY_A, RESET);
  assert(r.ok === true, "истёкший TTL: takeover ok:true");
  assert(r.replaced === true, "takeover помечен replaced:true");
  const m = readMarkerSafe(dir, KEY_A, RESET);
  assert(m?.pid === process.pid, `маркер после takeover принадлежит новому держателю (${process.pid})`);
  assert(
    typeof m?.locked_at === "number" && (m.locked_at as number) >= Date.now() - 5_000,
    "locked_at переустановлен на текущий момент (маркер «свежий»)",
  );
  assert(typeof m?.ep === "number" && m?.ep !== OLD_EP, "эпоха держателя после takeover сменилась");
}

/** S6: takeover при «мёртвом pid» (TTL жив, pid не существует) -> ok:true, replaced:true. */
async function testTakeoverDeadPid(): Promise<void> {
  console.log("\n--- takeover по мёртвому pid ---");
  const dir = freshDir();
  setFiresDirPath(dir);
  writeMarker(dir, KEY_A, RESET, {
    locked_at: Date.now(), // TTL жив
    pid: DEAD_PID, // процесса нет -> держатель мёртв
    host: HOST,
    ep: 1,
    reset: RESET,
    key: KEY_A,
    mode: "planned",
  });
  const r: FireLeaseResult = acquireFireLease(KEY_A, RESET);
  assert(r.ok === true, "мёртвый pid: takeover ok:true");
  assert(r.replaced === true, "takeover помечен replaced:true");
  assert(readMarkerSafe(dir, KEY_A, RESET)?.pid === process.pid, "маркер перезахвачен нашим pid");
}

/** S7: release compare-and-remove — сносит ТОЛЬКО свою аренду (pid+ep), чужие не трогает. */
async function testRelease(): Promise<void> {
  console.log("\n--- release compare-and-remove ---");
  const dir = freshDir();
  setFiresDirPath(dir);
  // 7a: свою аренду снимает (pid+ep совпадают) -> true, файл удалён.
  writeMarker(dir, KEY_A, RESET, {
    locked_at: Date.now(),
    pid: process.pid,
    host: HOST,
    ep: 5,
    reset: RESET,
    key: KEY_A,
    mode: "planned",
  });
  assert(
    releaseFireLease(KEY_A, RESET, process.pid) === true,
    `release своей аренды (pid=${process.pid}) -> true`,
  );
  assert(!existsSync(markerPath(dir, KEY_A, RESET)), "своя аренда снята: маркер удалён");
  // 7b: чужая аренда (чужой pid) не сносится -> false, маркер цел.
  writeMarker(dir, KEY_B, RESET, {
    locked_at: Date.now(),
    pid: DEAD_PID,
    host: HOST,
    ep: 2,
    reset: RESET,
    key: KEY_B,
    mode: "planned",
  });
  assert(
    releaseFireLease(KEY_B, RESET, process.pid) === false,
    "release чужим pid -> false (пид держателя не совпал)",
  );
  assert(existsSync(markerPath(dir, KEY_B, RESET)), "чужая аренда не снесена");
  // 7c: повторный release уже снятого маркера -> false (идемпотентно, отсутствие аренды).
  assert(
    releaseFireLease(KEY_A, RESET, process.pid) === false,
    "release несуществующей аренды -> false",
  );
}

/** S8: после takeover прежний держатель не может снести новую аренду. */
async function testReleaseAfterTakeover(): Promise<void> {
  console.log("\n--- старый держатель не сносит аренду после takeover ---");
  const dir = freshDir();
  setFiresDirPath(dir);
  writeMarker(dir, KEY_A, RESET, {
    locked_at: Date.now(),
    pid: DEAD_PID, // прежний держатель
    host: HOST,
    ep: 1,
    reset: RESET,
    key: KEY_A,
    mode: "planned",
  });
  const r: FireLeaseResult = acquireFireLease(KEY_A, RESET);
  assert(r.ok === true, "takeover мёртвого держателя ok:true");
  assert(
    releaseFireLease(KEY_A, RESET, DEAD_PID) === false,
    "прежний держатель (DEAD_PID) release -> false",
  );
  assert(
    readMarkerSafe(dir, KEY_A, RESET)?.pid === process.pid,
    "новая аренда (наш pid) не снесена release прежнего держателя",
  );
}

/** S9: два разных keyId -> два независимых маркера (два fire на общий сброс, FR-201). */
async function testTwoKeys(): Promise<void> {
  console.log("\n--- два ключа на общий сброс ---");
  const dir = freshDir();
  setFiresDirPath(dir);
  assert(keyIdOf(KEY_A) !== keyIdOf(KEY_B), "keyId разных ключей различны (sha1)");
  const rA: FireLeaseResult = acquireFireLease(KEY_A, RESET);
  const rB: FireLeaseResult = acquireFireLease(KEY_B, RESET);
  assert(rA.ok === true, "ключ A: acquire ok:true");
  assert(rB.ok === true, "ключ B: acquire ok:true (независим от A)");
  const dA = dirname(markerPath(dir, KEY_A, RESET));
  const dB = dirname(markerPath(dir, KEY_B, RESET));
  assert(dA !== dB, "маркеры живут в разных <keyId>/ каталогах");
  assert(existsSync(markerPath(dir, KEY_A, RESET)), "маркер A создан");
}

/** S10: рестарт-имитация — живой маркер на месте при повторном acquire (свежий инстанс) -> skip, без re-fire. */
async function testRestartSurvival(): Promise<void> {
  console.log("\n--- рестарт-имитация (маркер жив на месте) ---");
  const dir = freshDir();
  setFiresDirPath(dir);
  writeMarker(dir, KEY_A, RESET, {
    locked_at: Date.now(),
    pid: process.pid, // «живой держатель» другого (перезапущенного?) процесса
    host: HOST,
    ep: 9,
    reset: RESET,
    key: KEY_A,
    mode: "planned",
  });
  const r1: FireLeaseResult = acquireFireLease(KEY_A, RESET);
  const r2: FireLeaseResult = acquireFireLease(KEY_A, RESET); // «второй инстанс», маркер на месте
  assert(r1.ok === false, "живой маркер на месте: первый acquire skip");
  assert(r1.holderPid === process.pid, "skip атрибутирует holderPid живого держателя");
  assert(r2.ok === false, "повторный acquire того же (key,reset) тоже skip (без re-fire)");
  const marks = readdirSync(dirname(markerPath(dir, KEY_A, RESET)));
  assert(marks.length === 1, "маркеров остался ровно один (нет второго файла/повтора fire)");
}

/** S11: acquire/release синхронны и не оставляют persistent-хендлов (exit-parity, D-605). */
async function testNoTimers(): Promise<void> {
  console.log("\n--- синхронность / exit-parity ---");
  const r: FireLeaseResult = acquireFireLease(KEY_A, RESET);
  assert(!(r instanceof Promise), "acquire возвращает синхронный объект (не Promise)");
  assert(typeof r?.ok === "boolean", "acquire всегда возвращает объект с полем ok:boolean");
  // exit-parity: никаких persistent-таймеров/интервалов модуль не заводит — если бы заводил,
  // процесс после main() не завершился бы; завершение контролируется process.exit внизу.
}

// --- runner ----------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n=== firelease unit tests (spec 006 T-03 RED: межпроцессный дедуп) ===");
  tmpRoot = mkdtempSync(join(tmpdir(), "firelease-root-"));
  setFiresDirPath(join(tmpRoot, "default"));

  await testApiSurface();
  await testAcquireFresh();
  await testForeignLive();
  await testTakeoverByTtl();
  await testTakeoverDeadPid();
  await testRelease();
  await testReleaseAfterTakeover();
  await testTwoKeys();
  await testRestartSurvival();
  await testNoTimers();

  console.log("\n========================================");
  for (const r of results) console.log(r);
  console.log("======================================");
  console.log(`\n${passed} passed, ${failed} failed`);

  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* cleanup best-effort */
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* noop */
  }
  process.exit(1);
});
