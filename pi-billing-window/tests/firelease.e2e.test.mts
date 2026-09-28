/**
 * firelease.e2e.test.mts -- spec 006, задача T-03 (RED): cross-process дедуп сброса (FR-201..204).
 *
 * Run: npx tsx tests/firelease.e2e.test.mts
 *
 * Две НАСТОЯЩИЕ «инстанции» = два независимых node/tsx-процесса (child), разделяющих ОДИН
 * маркер-каталог (арендная файловая модель D-604). Держатель A берёт аренду и ДЕРЖИТ её
 * (спит, pid жив), пока B пытается её взять -> ровно один fire:reset-ready на (key, reset).
 * Рестарт-имитация/сконкурентность и pid-живость проверяются настоящими pid'ами процессов.
 *
 * RED-статус: src/firelease.ts — RED-stub (acquire всегда {ok:false}), поэтому оба инстанса
 * в паре FAIL'ят: 0 успешных fire вместо 1. Сьют грузится и завершается process.exit(...).
 */

import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { FIRE_LEASE_TTL_MS } from "../src/firelease.ts";

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

// --- пути и фикстуры ------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MODULE = pathToFileURL(join(ROOT, "src", "firelease.ts")).href; // file:// URL для ESM-импорта из tmp-каталога
const TSX_CLI = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

const KEY_1 = "C:\\Users\\dev\\pi\\sessions\\night-user.json";
const KEY_2 = "C:\\Users\\dev\\pi\\sessions\\daily-user.json";
const RESET = 1790000000000;

let tmpRoot = "";
let childScript = "";
const instances: Array<{ pid: number; res: Record<string, unknown> | null }> = [];

function keyIdOf(key: string): string {
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}
function markPath(key: string, reset: number): string {
  return join(tmpRoot, keyIdOf(key), `${reset}.mark`);
}
function readMarkerSafe(key: string, reset: number): Record<string, unknown> | null {
  const p = markPath(key, reset);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
function countMarks(key: string): number {
  const d = join(tmpRoot, keyIdOf(key));
  if (!existsSync(d)) return 0;
  return readdirSync(d).filter((f) => f.endsWith(".mark")).length;
}

/**
 * Общий child-скрипт (генерируется в tmp, .mts для ESM+top-level await).
 * Параметры передаются ОДНИМ JSON-аргументом в последнем argv-элементе
 * (индексация argv через tsx-обёртку ненадёжна).
 * { dir, key, reset, action: "acquire"|"release", holdMs, pidArg }
 * Вывод: строка `__FIRERELEASE_RES__<json>`.
 */
function writeChildScript(): void {
  childScript = join(tmpRoot, "firelease-child.mts");
  const src = `
import {
  acquireFireLease,
  releaseFireLease,
  setFiresDirPath,
} from ${JSON.stringify(MODULE)};

const a = JSON.parse(process.argv[process.argv.length - 1]);
setFiresDirPath(a.dir);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Реальный pid внутреннего 1С-процесса (tsx-обёртка child.pid не совпадает
// с process.pid внутри модуля) — репортим его, чтобы харнесс сравнивал
// маркерный pid с faktическим pid держателя.
console.log("__FIRERELEASE_PID__" + process.pid);
let out: unknown = null;
if (a.action === "acquire") {
  const res = acquireFireLease(a.key, Number(a.reset));
  out = res;
  if (Number(a.holdMs) > 0) await sleep(Number(a.holdMs)); // держим аренду: pid жив
} else if (a.action === "release") {
  out = { released: releaseFireLease(a.key, Number(a.reset), Number(a.pidArg)) };
}
console.log("__FIRERELEASE_RES__" + JSON.stringify(out));
process.exit(0);
`;
  writeFileSync(childScript, src, "utf8");
}

function parseRes(raw: string): Record<string, unknown> | null {
  const line = raw
    .split(/\r?\n/)
    .find((l) => l.startsWith("__FIRERELEASE_RES__"));
  if (!line) return null;
  try {
    return JSON.parse(line.slice("__FIRERELEASE_RES__".length)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Реальный pid дочернего процесса из его stdout (не child.pid обёртки tsx). */
function parseRealPid(raw: string): number {
  const line = raw
    .split(/\r?\n/)
    .find((l) => l.startsWith("__FIRERELEASE_PID__"));
  if (!line) return 0;
  const n = Number(line.slice("__FIRERELEASE_PID__".length));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Запуск инстанции как асинхронный фоновый процесс (возвращает pid сразу). */
function spawnInstance(payload: Record<string, unknown>): Promise<{ pid: number; res: Record<string, unknown> | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX_CLI, childScript, JSON.stringify(payload)], { cwd: ROOT });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => {
      out += `[spawn err ${String(e)}]`;
      resolve({ pid: 0, res: null });
    });
    child.on("close", () => resolve({ pid: parseRealPid(out) || (child.pid ?? 0), res: parseRes(out) }));
  });
}

/** Запуск инстанции синхронно (блокирующе) — для «второго» в паре, пока держатель спит. */
function runInstanceSync(payload: Record<string, unknown>): { pid: number; res: Record<string, unknown> | null; raw: string } {
  const r = spawnSync(process.execPath, [TSX_CLI, childScript, JSON.stringify(payload)], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
  const raw = (r.stdout ?? "") + (r.stderr ?? "");
  return { pid: parseRealPid(raw) || ((r.pid as number) ?? 0), res: parseRes(raw), raw };
}

/** Пара «держатель A (фоновый, держит аренду) + конкурент B (блокирующе)». */
async function pair(key: string, reset: number): Promise<{
  a: { pid: number; res: Record<string, unknown> | null };
  b: { pid: number; res: Record<string, unknown> | null; raw: string };
}> {
  const a = spawnInstance({ dir: tmpRoot, key, reset, action: "acquire", holdMs: 3000 });
  await sleep(600); // даём A взять аренду (wx мгновенен) — он ещё спит (pid жив)
  const b = runInstanceSync({ dir: tmpRoot, key, reset, action: "acquire", holdMs: 0 });
  const aDone = await a; // A отпустит процесс только после holdMs
  return { a: aDone, b };
}

// --- сценарии ------------------------------------------------------------------

/** E1/E2: пара на (KEY_1, RESET) -> ровно 1 успешный fire; маркер один, принадлежит A. */
async function testExactlyOneFire(): Promise<void> {
  console.log("\n--- пара процессов, общий каталог: ровно 1 fire ---");
  const p = await pair(KEY_1, RESET);
  assert(p.a.res?.ok === true, `держатель A: acquire ok:true (pid ${p.a.pid})`);
  assert(p.a.res?.replaced === undefined, "первый из пары — не takeover (replaced отсутствует)");
  assert(p.a.pid !== p.b.pid, "A и B — разные процессы (разные pid)");
  assert(p.b.res?.ok === false, "конкурент B: acquire ok:false (skip, аренда занята)");
  assert(
    p.b.res?.holderPid === p.a.pid,
    `skip атрибутирует holderPid = pid A (${p.a.pid})`,
  );

  const successes = [p.a.res?.ok === true, p.b.res?.ok === true].filter(Boolean).length;
  assert(successes === 1, `ровно 1 успешный acquire в паре (получено ${successes})`);
  const m1 = readMarkerSafe(KEY_1, RESET);
  assert(countMarks(KEY_1) === 1, "в <keyId>/ ровно один .mark (нет второго/повторного fire)");
  assert(m1 !== null, "маркер A существует на диске");
  assert(m1?.pid === p.a.pid, `маркер принадлежит процессу A (pid ${p.a.pid})`);
  assert(
    typeof m1?.locked_at === "number" &&
      (m1.locked_at as number) >= Date.now() - FIRE_LEASE_TTL_MS,
    "маркер внутри TTL (10 мин), pid-держатель жив во время пары",
  );
}

/** E3: два КЛЮЧА на ОБЩИЙ сброс -> 2 fire (FR-201), маркер-каталоги независимы. */
async function testTwoKeysSharedReset(): Promise<void> {
  console.log("\n--- два ключа на общий сброс: 2 fire ---");
  const pA = await pair(KEY_1, RESET);
  const pB = await pair(KEY_2, RESET);
  assert(pA.a.res?.ok === true, "ключ 1: держатель A ok:true");
  assert(pB.a.res?.ok === true, "ключ 2: держатель A ok:true (свой маркер)");
  assert(pB.b.res?.ok === false, "ключ 2: конкурент B ok:false");
  assert(
    pA.a.res?.ok === true && pB.a.res?.ok === true,
    "FR-201: оба ключа на общий сброс получили fire (2 успеха)",
  );
  assert(countMarks(KEY_1) === 1, "key1: ровно один маркер");
  assert(countMarks(KEY_2) === 1, "key2: ровно один маркер");
  assert(
    join(tmpRoot, keyIdOf(KEY_1)) !== join(tmpRoot, keyIdOf(KEY_2)),
    "маркеры разных ключей живут в разных <keyId>/ каталогах (не дедупятся)",
  );
}

/** E4: release чужой инстанцией не сносит аренду держателя (compare-and-remove по pid). */
async function testReleaseCrossInstance(): Promise<void> {
  console.log("\n--- release чужой инстанции не сносит аренду ---");
  const pidArg = process.pid + 4242; // точно не pid A и не pid Б-инстанции
  const r = runInstanceSync({ dir: tmpRoot, key: KEY_1, reset: RESET, action: "release", holdMs: 0, pidArg });
  assert(r.res?.released === false, "release чужим pid (не владельца) -> false");
  const m = readMarkerSafe(KEY_1, RESET);
  assert(m?.pid !== undefined && m !== null, "маркер держателя не удалён (аренда цела)");
}

// --- runner ----------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n=== firelease e2e tests (spec 006 T-03 RED: cross-process дедуп) ===");
  tmpRoot = mkdtempSync(join(tmpdir(), "firelease-e2e-"));
  writeChildScript();

  assert(typeof FIRE_LEASE_TTL_MS === "number" && FIRE_LEASE_TTL_MS === 10 * 60_000, "TTL const экспортируется и равен 10 мин");

  await testExactlyOneFire();
  await testTwoKeysSharedReset();
  await testReleaseCrossInstance();

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
