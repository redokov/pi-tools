/**
 * ping-selfheal.test.mts -- unit-тесты самовосстановления проверочного
 * запроса (spec 019, T2: FR-019-3 модель-фолбэк + FR-019-4 эскалация).
 *
 * Run: npx tsx tests/ping-selfheal.test.mts
 *
 * Инцидент-реплика 2026-11-10→11: закэшированная мёртвая модель
 * openai/gpt-oss:20b давала HTTP 404 на каждом wake-пинге, фолбэк не
 * запускался (зависимость от кэша mode/model), 23 отказа подряд — молчание.
 */

import * as fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readStateSync,
  writeStateSync,
  setPaths as stateSetPaths,
  resetPaths as stateResetPaths,
  type State,
} from "../src/state.ts";
import {
  setWakePaths,
  resetPaths as wakeResetPaths,
} from "../src/wakeups.ts";
import {
  setPaths as historySetPaths,
  resetPaths as historyResetPaths,
} from "../src/history.ts";
import { setArmsLogPath, resetArmsLogPath } from "../src/armslog.ts";
import type { EmitFn } from "../src/reset.ts";
import type { NotifyPayload, NotifyResult } from "../src/notifier.ts";
import {
  PING_MODEL,
  PING_FALLBACK_MODEL,
  loadPingConfig,
  setPingConfigPaths,
  resetPingConfigPaths,
  setPingFetchForTests,
  setPingNotifyForTests,
  sendPing,
  pingBoundaryFlow,
  readProviderPingModels,
  pickFallbackModels,
  type ProviderModelCost,
} from "../src/ping.ts";
import {
  PING_STREAK_THRESHOLD,
  INFRA_ESCALATE_MS,
} from "../src/nightsentry.js";

// ---- Harness -------------------------------------------------------------

const tmpDir = mkdtempSync(join(tmpdir(), "pbw-ping-heal-"));
const stateFile = join(tmpDir, "state.json");
const stateLock = join(tmpDir, "state.lock");
const wakeFile = join(tmpDir, "wakeups.json");
const wakeLock = join(tmpDir, "wakeups.lock");
const historyFile = join(tmpDir, "history.csv");
const historyLock = join(tmpDir, "history.lock");
const armsLogFile = join(tmpDir, "arms.log");
const modelsJson = join(tmpDir, "models.json");
const authJson = join(tmpDir, "auth.json");

stateSetPaths(stateFile, stateLock);
setWakePaths(wakeFile, wakeLock);
historySetPaths(historyFile, historyLock);
setArmsLogPath(armsLogFile);
setPingConfigPaths(modelsJson, authJson);

const WINDOW_MS = 2 * 60 * 60 * 1000;

/** Живые модели провайдера (реплика models.json на 2026-11-11). */
const LIVE_MODELS = `{"providers":{"wormsoft":{"baseUrl":"https://ai.wormsoft.ru/api/gpt","models":[
  {"id":"zai/glm-5.3:NVFP4","cost":{"input":150000,"output":500000,"cacheRead":50000}},
  {"id":"zai/glm-5.3","cost":{"input":2800000,"output":10000000}},
  {"id":"deepseek-ai/deepseek-v4.1-flash-1017","cost":{"input":400000,"output":1520000}},
  {"id":"qwen/qwen3.8:27b","cost":{"input":220000,"output":1000000}},
  {"id":"zai/glm-5.3-flash","cost":{"input":800000,"output":2800000}},
  {"id":"xiaomi/mimo-v2.6-flash","cost":{"input":200000,"output":250000}},
  {"id":"xiaomi/mimo-v2.6-pro","cost":{"input":600000,"output":1000000}}
]}}}`;

function writeConfig(models: string): void {
  fs.writeFileSync(modelsJson, models, "utf8");
  fs.writeFileSync(
    authJson,
    JSON.stringify({ wormsoft: { key: "test-key" } }),
    "utf8",
  );
}

function makeState(over: Partial<State> = {}): State {
  return {
    provider: "wormsoft",
    windowStartedAt: Date.now(),
    windowMs: WINDOW_MS,
    lastResetAt: 0,
    resetCount: 0,
    callsInWindow: 0,
    ...over,
  };
}

function cleanState(): void {
  for (const f of [stateFile, wakeFile, historyFile]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {}
  }
}

type FetchHandler = (url: string, body: any) => Response;
let fetchCalls: { body: any }[] = [];

function installFetch(handlers: FetchHandler[]): void {
  const queue = [...handlers];
  fetchCalls = [];
  setPingFetchForTests(async (url, init) => {
    let body: any = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {}
    fetchCalls.push({ body });
    const h = queue.length > 0 ? queue.shift()! : () => new Response("{}", { status: 500 });
    return h(typeof url === "string" ? url : url.toString(), body);
  });
}

function restoreFetch(): void {
  setPingFetchForTests(null);
  fetchCalls = [];
}

let notified: NotifyPayload[] = [];
setPingNotifyForTests(async (p: NotifyPayload): Promise<NotifyResult> => {
  notified.push(p);
  return { ok: true };
});

const noopEmit: EmitFn = () => {};

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}`);
  }
}

async function main(): Promise<void> {
  console.log("pickFallbackModels (чистая):");
  const list: ProviderModelCost[] = [
    { id: "expensive", inputCost: 900, outputCost: 100 },
    { id: "cheap", inputCost: 100, outputCost: 50 },
    { id: "mid", inputCost: 300, outputCost: 10 },
    { id: "same-as-cheap", inputCost: 100, outputCost: 900 },
    { id: "no-price" },
  ];
  check(
    "сортировка по input, tie-break по output",
    JSON.stringify(pickFallbackModels(list, [])) ===
      JSON.stringify(["cheap", "same-as-cheap", "mid"]),
  );
  check(
    "exclude убирает модели",
    pickFallbackModels(list, ["cheap", "same-as-cheap"])[0] === "mid",
  );
  check("limit=1 -- одна модель", pickFallbackModels(list, [], 1).length === 1);
  check("пустой список -> []", pickFallbackModels([], []).length === 0);
  check(
    "без цены -- в конец",
    pickFallbackModels([{ id: "a" }, { id: "b", inputCost: 1 }], []).pop() === "a",
  );

  console.log("readProviderPingModels (толерантное чтение):");
  writeConfig(LIVE_MODELS);
  check("читает 7 моделей", readProviderPingModels().length === 7);
  check("цены прочитаны", readProviderPingModels()[0].inputCost === 150000);
  writeConfig('{"providers":{}}');
  check("нет провайдера -> []", readProviderPingModels().length === 0);
  writeConfig("{bogus");
  check("битый JSON -> [] (не бросает)", readProviderPingModels().length === 0);
  writeConfig(LIVE_MODELS);

  console.log("sendPing: 404 на закэшированной мёртвой модели (реплика инцидента):");
  const cfg = loadPingConfig()!;
  check("конфиг живой", cfg !== null && cfg.baseUrl.includes("wormsoft"));

  // 404 на primary (закэшированная мёртвая), 404 на PING_FALLBACK_MODEL,
  // 200 на самой дешёвой живой -> ok, модель закрепляется.
  cleanState();
  installFetch([
    () => new Response("{}", { status: 404 }),
    () => new Response("{}", { status: 404 }),
    () =>
      new Response(
        JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 1 } }),
        { status: 200 },
      ),
  ]);
  let r = await sendPing(cfg, { model: "openai/gpt-oss:20b", mode: "json" });
  check("404 на кэше -> фолбэк живой моделью -> ok", r.kind === "ok");
  check(
    "фолбэк выбрал самую дешёвую живую (zai/glm-5.3:NVFP4, 150к)",
    r.kind === "ok" && r.model === "zai/glm-5.3:NVFP4",
  );
  check(
    "цепочка: primary -> PING_FALLBACK -> живая (3 запроса)",
    fetchCalls.length === 3 &&
      fetchCalls[0].body.model === "openai/gpt-oss:20b" &&
      fetchCalls[1].body.model === PING_FALLBACK_MODEL &&
      fetchCalls[2].body.model === "zai/glm-5.3:NVFP4",
  );
  restoreFetch();

  // Без кэша (mode/model не заданы): живая цепочка исчерпана (все 404),
  // затем протокольный sse-фолбэк на primary — тоже неудача -> infra.
  installFetch([
    () => new Response("{}", { status: 404 }),
    () => new Response("{}", { status: 404 }),
    () => new Response("{}", { status: 404 }),
    () => new Response("{}", { status: 404 }),
    () => new Response("{}", { status: 404 }),
  ]);
  r = await sendPing(cfg);
  check("без кэша: все 404 -> infra", r.kind === "infra");
  check(
    "порядок попыток: primary, фолбэк, 3 живые по цене, sse на primary",
    fetchCalls.length === 6 &&
      fetchCalls[0].body.model === PING_MODEL &&
      fetchCalls[1].body.model === PING_FALLBACK_MODEL &&
      fetchCalls[2].body.model === "zai/glm-5.3:NVFP4" &&
      fetchCalls[3].body.model === "xiaomi/mimo-v2.6-flash" &&
      fetchCalls[4].body.model === "qwen/qwen3.8:27b" &&
      fetchCalls[5].body.model === PING_MODEL &&
      fetchCalls[5].body.stream === true,
  );
  restoreFetch();

  // Провайдер без списка моделей: цепочка = только PING_FALLBACK_MODEL.
  writeConfig('{"providers":{"wormsoft":{"baseUrl":"https://ai.wormsoft.ru/api/gpt"}}}');
  installFetch([
    () => new Response("{}", { status: 404 }),
    () => new Response("{}", { status: 404 }),
  ]);
  r = await sendPing(cfg, { model: "openai/gpt-oss:20b", mode: "json" });
  check(
    "пустой список провайдера: primary, фолбэк, sse на primary -> infra",
    r.kind === "infra" &&
      fetchCalls.length === 3 &&
      fetchCalls[0].body.model === "openai/gpt-oss:20b" &&
      fetchCalls[1].body.model === PING_FALLBACK_MODEL &&
      fetchCalls[2].body.model === "openai/gpt-oss:20b",
  );
  restoreFetch();
  writeConfig(LIVE_MODELS);

  console.log("pingBoundaryFlow: закрепление модели в state.ping (самовосстановление):");
  cleanState();
  const now = Date.now();
  writeStateSync(
    makeState({
      windowStartedAt: now - WINDOW_MS - 5000,
      ping: { model: "openai/gpt-oss:20b", mode: "json", infraStreak: 23, infraNotified: true },
    }),
  );
  installFetch([
    () => new Response("{}", { status: 404 }),
    () => new Response("{}", { status: 404 }),
    () =>
      new Response(JSON.stringify({ usage: { prompt_tokens: 9 } }), { status: 200 }),
  ]);
  const out = await pingBoundaryFlow({
    firedPoint: now + 60_000,
    note: "wake 23:15",
    emit: noopEmit,
    blindOnInfra: true,
  });
  const st = readStateSync()!;
  check("флоу отработал", out === "handled");
  check(
    "state.ping.model закрепился на живой модели",
    st.ping?.model === "zai/glm-5.3:NVFP4",
  );
  check("инфра-серия сброшена успехом", st.ping?.infraStreak === 0);
  check("sentry.lastInfraNotifyAt обнулён", st.sentry?.lastInfraNotifyAt === 0);
  restoreFetch();

  console.log("pingBoundaryFlow: эскалация серии (FR-019-4):");
  cleanState();
  writeStateSync(makeState({ windowStartedAt: now - 1000 }));
  installFetch([() => new Response("{}", { status: 404 })]); // очередь: каждый вызов доедает до 500-го хвостового
  let escalations = 0;
  for (let i = 1; i <= PING_STREAK_THRESHOLD; i++) {
    await pingBoundaryFlow({
      firedPoint: now + 60_000 + i,
      note: `wake probe ${i}`,
      emit: noopEmit,
      blindOnInfra: true,
    });
    const stN = readStateSync()!;
    if (notified.some((n) => n.type === "billing:ping-infra-streak")) escalations++;
    if (i === PING_STREAK_THRESHOLD) {
      check(
        `серия ${i} -> эскалация отправлена`,
        notified.some((n) => n.type === "billing:ping-infra-streak"),
      );
      check(
        "sentry.lastInfraNotifyAt записан",
        typeof stN.sentry?.lastInfraNotifyAt === "number" && stN.sentry!.lastInfraNotifyAt! > 0,
      );
    } else if (i === PING_STREAK_THRESHOLD - 1) {
      check(
        `серия ${i} (порог-1) -> эскалации ещё нет`,
        !notified.some((n) => n.type === "billing:ping-infra-streak"),
      );
    }
  }
  check("эскалация ровно одна за серию", escalations === 1);
  // Дедуп 6 ч: серия растёт дальше — повтор не раньше INFRA_ESCALATE_MS.
  await pingBoundaryFlow({
    firedPoint: now + 120_000,
    note: "wake probe 11",
    emit: noopEmit,
    blindOnInfra: true,
  });
  check(
    "внутри 6 ч — дедуп держит (одна эскалация)",
    notified.filter((n) => n.type === "billing:ping-infra-streak").length === 1,
  );
  // 7 часов назад — снова можно.
  const stOld = readStateSync()!;
  writeStateSync({
    ...stOld,
    sentry: { ...stOld.sentry, lastInfraNotifyAt: Date.now() - INFRA_ESCALATE_MS - 1000 },
  });
  await pingBoundaryFlow({
    firedPoint: now + 180_000,
    note: "wake probe 12",
    emit: noopEmit,
    blindOnInfra: true,
  });
  check(
    "через 6 ч — эскалация повторяется",
    notified.filter((n) => n.type === "billing:ping-infra-streak").length === 2,
  );
  restoreFetch();

  // ---- Teardown ----------------------------------------------------------
  stateResetPaths();
  wakeResetPaths();
  historyResetPaths();
  resetArmsLogPath();
  resetPingConfigPaths();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}

  console.log(`\nping-selfheal: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
