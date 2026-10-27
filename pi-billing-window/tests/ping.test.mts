/**
 * ping.test.mts -- unit tests for spec 017 (boundary-ping).
 *
 * Run: npx tsx tests/ping.test.mts
 *
 * Coverage (design §10):
 *   1. loadPingConfig -- ok / нет файлов / битый JSON / нет полей.
 *   2. sendPing -- 200+usage (legacy и новый формат), 429 без ретрая,
 *      фолбэк-модель на 400, sse-фолбэк, сеть/таймаут -> infra.
 *   3. pingBoundaryFlow -- ok (reset+якорь), 429 re-anchor, 429
 *      unknown-anchor retry + cap, infra streak + слепой fallback,
 *      burned (без слепого reset), disabled (legacy), recorded-dedup,
 *      идемпотентность после чужого re-anchor, no-config.
 *   4. manualPing -- ничего не пишет в lastBoundary/last429At.
 *   5. insertRetryPoint -- epsilon, сортировка.
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
  readWakeTable,
  mutateWakeTable,
  setWakePaths,
  resetPaths as wakeResetPaths,
  WAKE_MARGIN_MS,
  WAKE_DEPTH,
  insertRetryPoint,
  type WakeTable,
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
  PING_RETRY_MAX,
  loadPingConfig,
  setPingConfigPaths,
  resetPingConfigPaths,
  setPingFetchForTests,
  setPingNotifyForTests,
  sendPing,
  pingBoundaryFlow,
  manualPing,
  setPingDisabled,
  readPingState,
} from "../src/ping.ts";

// ---- Harness -------------------------------------------------------------

const tmpDir = mkdtempSync(join(tmpdir(), "pbw-ping-"));
const stateFile = join(tmpDir, "state.json");
const stateLock = join(tmpDir, "state.lock");
const wakeFile = join(tmpDir, "wakeups.json");
const wakeLock = join(tmpDir, "wakeups.lock");
const historyFile = join(tmpDir, "history.csv");
const historyLock = join(tmpDir, "history.lock");
const armsLog = join(tmpDir, "arms.log");
const modelsJson = join(tmpDir, "models.json");
const authJson = join(tmpDir, "auth.json");

stateSetPaths(stateFile, stateLock);
setWakePaths(wakeFile, wakeLock);
historySetPaths(historyFile, historyLock);
setArmsLogPath(armsLog);
setPingConfigPaths(modelsJson, authJson);

const WINDOW_MS = 2 * 60 * 60 * 1000;

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

type EmitCall = { event: string; payload: unknown };
function createMockEmit(): { calls: EmitCall[]; emit: EmitFn } {
  const calls: EmitCall[] = [];
  return {
    calls,
    emit(event, payload) {
      calls.push({ event, payload });
    },
  };
}

/** Очередь ответов fetch-мока: каждый вызов берёт следующий обработчик. */
type FetchHandler = (url: string, body: any) => Response | Promise<Response>;
let fetchHandlers: FetchHandler[] = [];
let fetchCalls: { url: string; body: any }[] = [];

function installFetch(handlers: FetchHandler[]): void {
  fetchHandlers = [...handlers];
  fetchCalls = [];
  setPingFetchForTests(async (url, init) => {
    const u = typeof url === "string" ? url : url.toString();
    let body: any = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {}
    fetchCalls.push({ url: u, body });
    const h = fetchHandlers.length > 0 ? fetchHandlers.shift()! : () => new Response("{}", { status: 500 });
    return h(u, body);
  });
}

function restoreFetch(): void {
  setPingFetchForTests(null);
  fetchHandlers = [];
  fetchCalls = [];
}

/** fetch-мок, который ругается, если его вызвали (для dedup/legacy кейсов). */
function installFetchMustNotCall(): void {
  installFetch([
    () => {
      throw new Error("fetch НЕ должен был вызываться в этом кейсе");
    },
  ]);
}

let notified: NotifyPayload[] = [];
// Инъекция notify-рекордера: все notify-пейдгоады пинга пишутся в массив.
setPingNotifyForTests(async (p: NotifyPayload): Promise<NotifyResult> => {
  notified.push(p);
  return { ok: true };
});

/** appendHistory асинхронен (lock + append): перед чтением CSV даём ему осесть. */
async function historyText(): Promise<string> {
  for (let i = 0; i < 20 && !fs.existsSync(historyFile); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  try {
    return fs.readFileSync(historyFile, "utf8");
  } catch {
    return "";
  }
}

// ---- loadPingConfig (design §10.1) ---------------------------------------

function writeConfig(baseUrl?: string, key?: string): void {
  fs.writeFileSync(
    modelsJson,
    JSON.stringify({
      providers: baseUrl === undefined ? {} : { wormsoft: { baseUrl } },
    }),
    "utf8",
  );
  fs.writeFileSync(
    authJson,
    JSON.stringify({ wormsoft: key === undefined ? {} : { key } }),
    "utf8",
  );
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${extra ? " -- " + extra : ""}`);
  }
}

async function main(): Promise<void> {
  // ===== 1. loadPingConfig =====
  console.log("loadPingConfig:");
  writeConfig("https://api.example/v1/", "secret-key");
  const cfg = loadPingConfig();
  check("валидный конфиг", cfg !== null && cfg.baseUrl === "https://api.example/v1" && cfg.apiKey === "secret-key");

  const savedModels = modelsJson;
  setPingConfigPaths(join(tmpDir, "no-models.json"), authJson);
  check("нет models.json -> null", loadPingConfig() === null);
  setPingConfigPaths(savedModels, join(tmpDir, "no-auth.json"));
  check("нет auth.json -> null", loadPingConfig() === null);
  setPingConfigPaths(savedModels, authJson);

  writeConfig("not-a-url", "k");
  check("baseUrl не http(s) -> null", loadPingConfig() === null);
  writeConfig("https://api.example/v1", "");
  check("пустой ключ -> null", loadPingConfig() === null);
  fs.writeFileSync(modelsJson, "{bogus", "utf8");
  check("битый models.json -> null", loadPingConfig() === null);
  writeConfig("https://api.example/v1", "secret-key");

  // ===== 2. sendPing =====
  console.log("sendPing:");
  const cfg2 = loadPingConfig()!;

  installFetch([
    (_u, b) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "1" } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } },
        }),
        { status: 200 },
      ),
  ]);
  let r = await sendPing(cfg2);
  check("200 json -> ok, mode json", r.kind === "ok" && r.mode === "json" && r.model === PING_MODEL);
  check("usage (legacy формат) распознан", r.kind === "ok" && r.usage?.input === 10 && r.usage?.output === 2 && r.usage?.cacheRead === 4);
  check("запрос: max_tokens=2, stream=false", fetchCalls[0]?.body?.max_tokens === 2 && fetchCalls[0]?.body?.stream === false);
  restoreFetch();

  installFetch([
    () =>
      new Response(
        JSON.stringify({ usage: { input_tokens: 7, output_tokens: 1 } }),
        { status: 200 },
      ),
  ]);
  r = await sendPing(cfg2);
  check("usage (новый формат) распознан", r.kind === "ok" && r.usage?.input === 7 && r.usage?.output === 1);
  restoreFetch();

  installFetch([() => new Response("{}", { status: 429 })]);
  r = await sendPing(cfg2);
  check("429 -> limit, БЕЗ ретрая", r.kind === "limit" && fetchCalls.length === 1);
  restoreFetch();

  installFetch([
    () => new Response("{}", { status: 400 }),
    () =>
      new Response(
        JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
        { status: 200 },
      ),
  ]);
  r = await sendPing(cfg2);
  check("400 на основную -> фолбэк-модель 200 -> ok", r.kind === "ok" && r.model === PING_FALLBACK_MODEL);
  check("фолбэк-запрос ушёл с fallback-моделью", fetchCalls.length === 2 && fetchCalls[1].body?.model === PING_FALLBACK_MODEL);
  restoreFetch();

  installFetch([
    () => new Response("{}", { status: 400 }),
    () => new Response("{}", { status: 400 }),
    () => new Response("data: {\"x\":1}\n\n", { status: 200 }),
  ]);
  r = await sendPing(cfg2);
  check("протокольная ошибка -> sse-фолбэк -> ok, mode sse", r.kind === "ok" && r.mode === "sse");
  check("sse-запрос со stream=true", fetchCalls.length === 3 && fetchCalls[2].body?.stream === true);
  restoreFetch();

  installFetch([() => Promise.reject(new Error("ECONNREFUSED"))]);
  r = await sendPing(cfg2);
  check("сетевая ошибка -> infra", r.kind === "infra");
  restoreFetch();

  setPingFetchForTests(
    (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        // Никогда не резолвимся сами -- проверяем, что attempt доёбит нас по abort.
        const signal: AbortSignal | undefined = init?.signal ?? undefined;
        if (signal) {
          const onAbort = () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
  );
  // Держим event loop живым на время проверки: сам аборт-таймер unref
  // (spec 003 -- не держать loop), в пустом тест-процессе он не выстрелит
  // без постороннего ref. В хост-процессе pi loop всегда жив.
  const keepAlive = setInterval(() => {}, 20);
  r = await sendPing(cfg2, { timeoutMs: 60 });
  clearInterval(keepAlive);
  check("таймаут -> infra (abort)", r.kind === "infra");
  restoreFetch();

  installFetch([() => new Response("{}", { status: 401 })]);
  r = await sendPing(cfg2);
  check("401 -> infra (без фолбэков)", r.kind === "infra" && fetchCalls.length === 1);
  restoreFetch();

  // ===== 3. pingBoundaryFlow =====
  console.log("pingBoundaryFlow:");

  // --- 3.1 ok: верифицированный reset + якорь пинга (FR-017-1, FR-017-6)
  cleanState();
  const now = Date.now();
  writeStateSync(makeState({ windowStartedAt: now - WINDOW_MS - 5000 }));
  installFetch([
    () =>
      new Response(JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 2 } }), { status: 200 }),
  ]);
  const emit1 = createMockEmit();
  const boundary1 = now + 60_000;
  const sentBefore = Date.now();
  let out = await pingBoundaryFlow({
    firedPoint: boundary1,
    note: "wake 12:00",
    emit: emit1.emit,
    blindOnInfra: true,
  });
  const st1 = readStateSync()!;
  check("ok -> outcome handled", out === "handled");
  check("ok -> checkAndReset выполнен (lastResetAt свежий)", st1.lastResetAt >= sentBefore);
  check("ok -> billing:window_reset эмитится", emit1.calls.some((c) => c.event === "billing:window_reset"));
  check("ok -> якорь пинга: firstCallEmittedAt = sentAt", st1.firstCallEmittedAt !== undefined && st1.firstCallEmittedAt! >= sentBefore && st1.firstCallEmittedAt! <= Date.now());
  const t1 = readWakeTable()!;
  check(
    "ok -> wake-таблица перестроена от пинга",
    t1.points.length === WAKE_DEPTH && Math.abs(t1.points[0] - (st1.firstCallEmittedAt! + WINDOW_MS + WAKE_MARGIN_MS)) < 1000,
  );
  check("ok -> ping.lastBoundary записан", readPingState().lastBoundary === boundary1);
  check("ok -> history kind=ping", (await historyText()).includes("ping"));
  restoreFetch();

  // --- 3.2 recorded-ok dedup: без второго пинга (FR-017-7)
  cleanState();
  const boundary2 = Date.now() + 60_000;
  writeStateSync(
    makeState({
      windowStartedAt: Date.now() - WINDOW_MS - 5000,
      ping: { lastBoundary: boundary2, lastStatus: "ok" },
    }),
  );
  installFetchMustNotCall();
  const emit2 = createMockEmit();
  out = await pingBoundaryFlow({ firedPoint: boundary2, note: "wake 13:00", emit: emit2.emit, blindOnInfra: true });
  check("recorded ok -> reset без пинга", out === "handled" && readStateSync()!.lastResetAt > 0 && fetchCalls.length === 0);
  check("recorded ok -> window_reset эмитится", emit2.calls.some((c) => c.event === "billing:window_reset"));
  restoreFetch();

  // --- 3.3 429 + поздний firstCall -> re-anchor (FR-017-4)
  cleanState();
  const fc = Date.now() - 10 * 60_000;
  writeStateSync(
    makeState({
      windowStartedAt: Date.now() - 30 * 60_000, // фиктивный якорь (reset-момент)
      firstCallEmittedAt: fc,
    }),
  );
  installFetch([() => new Response("{}", { status: 429 })]);
  const emit3 = createMockEmit();
  out = await pingBoundaryFlow({ firedPoint: Date.now() + 60_000, note: "wake 14:00", emit: emit3.emit, blindOnInfra: true });
  const st3 = readStateSync()!;
  check("429 -> outcome handled", out === "handled");
  check("429 -> reset подавлен (lastResetAt не тронут)", st3.lastResetAt === 0);
  check("429 -> window_reset НЕ эмитится", !emit3.calls.some((c) => c.event === "billing:window_reset"));
  check("429 -> windowStartedAt := firstCallEmittedAt", st3.windowStartedAt === fc);
  check("429 -> last429At записан", st3.last429At !== undefined);
  const t3 = readWakeTable()!;
  check("429 -> таблица перестроена от fc", t3.points.length > 0 && Math.abs(t3.points[0] - (fc + WINDOW_MS + WAKE_MARGIN_MS)) < 1000);
  check("429 -> history kind=429 (ping probe)", (await historyText()).includes("429"));
  restoreFetch();

  // --- 3.4 recorded-429 после ЧУЖОГО re-anchor -> идемпотентный no-op
  const st3b = readStateSync()!;
  const boundary3b = st3b.ping!.lastBoundary!;
  installFetchMustNotCall();
  out = await pingBoundaryFlow({ firedPoint: boundary3b, note: "wake 14:00", emit: createMockEmit().emit, blindOnInfra: true });
  const st4 = readStateSync()!;
  check(
    "recorded 429 после re-anchor -> no-op (retryAttempt не взведён, точек не добавлено)",
    out === "handled" && (st4.ping?.retryAttempt ?? 0) === 0 && readWakeTable()!.points.length === t3.points.length,
  );
  restoreFetch();

  // --- 3.5 429 без якоря -> unknown-anchor retry (FR-017-4)
  cleanState();
  writeStateSync(makeState({ windowStartedAt: Date.now() - WINDOW_MS - 5000 }));
  installFetch([() => new Response("{}", { status: 429 })]);
  out = await pingBoundaryFlow({ firedPoint: Date.now() + 60_000, note: "wake 15:00", emit: createMockEmit().emit, blindOnInfra: true });
  let st5 = readStateSync()!;
  check("429 unknown -> retryAttempt = 1", (st5.ping?.retryAttempt ?? 0) === 1);
  const t5 = readWakeTable()!;
  const retryPoint = t5.points.find((p) => p > Date.now() && p <= Date.now() + 10 * 60_000 + 1000);
  check("429 unknown -> retry-точка +10 мин", retryPoint !== undefined);
  check("429 unknown -> reset подавлен", st5.lastResetAt === 0);
  restoreFetch();

  // --- 3.6 cap: 12 попыток -> notify однократно, точки не пишутся
  cleanState();
  writeStateSync(makeState({ windowStartedAt: Date.now() - WINDOW_MS - 5000 }));
  installFetch(Array.from({ length: 40 }, () => () => new Response("{}", { status: 429 })));
  notified = [];
  for (let i = 0; i < PING_RETRY_MAX + 3; i++) {
    await pingBoundaryFlow({ firedPoint: Date.now() + 60_000 + i * 1000, note: `wake 16:${i}`, emit: createMockEmit().emit, blindOnInfra: true });
  }
  st5 = readStateSync()!;
  check("cap -> retryAttempt сошёлся", (st5.ping?.retryAttempt ?? 0) >= PING_RETRY_MAX);
  check(
    "cap -> notify ping:429-cap ровно один",
    notified.filter((n) => n.type === "billing:ping-429-cap").length === 1,
  );
  check("cap -> после капа точек не прибавилось", readWakeTable()!.points.length <= PING_RETRY_MAX + 2);
  restoreFetch();

  // --- 3.7 infra streak -> слепой fallback (FR-017-5)
  cleanState();
  writeStateSync(makeState({ windowStartedAt: Date.now() - WINDOW_MS - 5000 }));
  notified = [];
  installFetch([
    () => Promise.reject(new Error("net down")),
    () => Promise.reject(new Error("net down")),
    () => Promise.reject(new Error("net down")),
    () => Promise.reject(new Error("net down")),
  ]);
  const emit7 = createMockEmit();
  for (let i = 0; i < 3; i++) {
    await pingBoundaryFlow({ firedPoint: Date.now() + 60_000 + i * 1000, note: `wake 17:${i}`, emit: emit7.emit, blindOnInfra: true });
  }
  const st7 = readStateSync()!;
  check("infra x3 -> слепой reset (lastResetAt)", st7.lastResetAt > 0);
  check("infra x3 -> window_reset эмитится (слепой)", emit7.calls.some((c) => c.event === "billing:window_reset"));
  check(
    "infra x3 -> notify fallback ровно один",
    notified.filter((n) => n.type === "billing:ping-infra-fallback").length === 1,
  );
  restoreFetch();

  // --- 3.8 burned: слепой reset запрещён (FR-017-8)
  cleanState();
  writeStateSync(makeState({ windowStartedAt: Date.now() - WINDOW_MS - 5000 }));
  notified = [];
  installFetch([
    () => Promise.reject(new Error("net down")),
    () => Promise.reject(new Error("net down")),
    () => Promise.reject(new Error("net down")),
    () => Promise.reject(new Error("net down")),
  ]);
  const emit8 = createMockEmit();
  for (let i = 0; i < 3; i++) {
    await pingBoundaryFlow({ firedPoint: Date.now() + 60_000 + i * 1000, note: `probe 18:${i}`, emit: emit8.emit, blindOnInfra: false });
  }
  const st8 = readStateSync()!;
  check("burned infra x3 -> слепого reset НЕТ", st8.lastResetAt === 0);
  check("burned infra -> window_reset НЕ эмитится", !emit8.calls.some((c) => c.event === "billing:window_reset"));
  check("burned infra -> notify fallback НЕ шлётся", notified.filter((n) => n.type === "billing:ping-infra-fallback").length === 0);
  restoreFetch();

  // --- 3.8b burned infra-кап: после 30 неудач probe-пинги останавливаются
  cleanState();
  writeStateSync(makeState({ windowStartedAt: Date.now() - WINDOW_MS - 5000 }));
  notified = [];
  installFetch(Array.from({ length: 40 }, () => () => Promise.reject(new Error("net down"))));
  const emit8c = createMockEmit();
  const POINTS_BEFORE = readWakeTable()?.points.length ?? 0;
  for (let i = 0; i < 33; i++) {
    await pingBoundaryFlow({ firedPoint: Date.now() - 40 * 60_000 + i * 1000, note: `probe 22:${i}`, emit: emit8c.emit, blindOnInfra: false });
  }
  check(
    "burned infra-кап -> probe остановлены, notify один",
    notified.filter((n) => n.type === "billing:ping-infra-fallback").length === 1,
  );
  check("burned infra-кап -> слепого reset так и нет", readStateSync()!.lastResetAt === 0);
  restoreFetch();

  // burned + ok -> reset разрешён и происходит
  cleanState();
  writeStateSync(makeState({ windowStartedAt: Date.now() - WINDOW_MS - 5000 }));
  installFetch([() => new Response("{}", { status: 200 })]);
  const emit8b = createMockEmit();
  out = await pingBoundaryFlow({ firedPoint: Date.now() - 40 * 60_000, note: "probe 19:00", emit: emit8b.emit, blindOnInfra: false });
  check("burned ok -> верифицированный reset", out === "handled" && readStateSync()!.lastResetAt > 0);
  check("burned ok -> window_reset эмитится", emit8b.calls.some((c) => c.event === "billing:window_reset"));
  restoreFetch();

  // --- 3.9 disabled -> legacy, fetch не вызывается (FR-017-10)
  cleanState();
  writeStateSync(makeState({ windowStartedAt: Date.now() - WINDOW_MS - 5000, ping: { disabled: true } }));
  installFetchMustNotCall();
  out = await pingBoundaryFlow({ firedPoint: Date.now() + 60_000, note: "wake 20:00", emit: createMockEmit().emit, blindOnInfra: true });
  check("disabled -> outcome legacy (fetch не звался)", out === "legacy" && fetchCalls.length === 0);
  restoreFetch();

  // --- 3.10 no config -> infra-путь, streak < 3 -> без reset
  cleanState();
  writeStateSync(makeState({ windowStartedAt: Date.now() - WINDOW_MS - 5000 }));
  setPingConfigPaths(join(tmpDir, "absent-models.json"), join(tmpDir, "absent-auth.json"));
  out = await pingBoundaryFlow({ firedPoint: Date.now() + 60_000, note: "wake 21:00", emit: createMockEmit().emit, blindOnInfra: true });
  const st10 = readStateSync()!;
  check("no-config -> handled, streak=1, reset нет", out === "handled" && (st10.ping?.infraStreak ?? 0) === 1 && st10.lastResetAt === 0);
  check("no-config -> retry-точка поставлена", readWakeTable()!.points.some((p) => p > Date.now() && p <= Date.now() + 3 * 60_000));
  setPingConfigPaths(modelsJson, authJson);

  // ===== 4. manualPing (FR-017-9) =====
  console.log("manualPing:");
  cleanState();
  const winBefore = Date.now() - 60 * 60_000;
  writeStateSync(makeState({ windowStartedAt: winBefore }));
  installFetch([() => new Response(JSON.stringify({ usage: { prompt_tokens: 9, completion_tokens: 1 } }), { status: 200 })]);
  const mr = await manualPing({ project: "p", session: "s" });
  const mst = readStateSync()!;
  check("manual -> ok", mr.kind === "ok");
  check("manual -> lastStatus/lastAt записаны", mst.ping?.lastStatus === "ok" && mst.ping?.lastAt !== undefined);
  check("manual -> lastBoundary НЕ записан (dedup авто-пинга цел)", mst.ping?.lastBoundary === undefined);
  check("manual -> last429At НЕ записан", mst.last429At === undefined);
  check("manual -> окно НЕ тронуто", mst.windowStartedAt === winBefore && mst.firstCallEmittedAt === undefined && mst.lastResetAt === 0);
  check("manual -> history note=manual", (await historyText()).includes("manual"));
  restoreFetch();

  // manual 429 тоже не трогает окно
  installFetch([() => new Response("{}", { status: 429 })]);
  const mr2 = await manualPing();
  check("manual 429 -> limit, окно не тронуто", mr2.kind === "limit" && readStateSync()!.last429At === undefined);
  restoreFetch();

  // ===== 5. insertRetryPoint (design §6) =====
  console.log("insertRetryPoint:");
  const base = 1_700_000_000_000;
  const tbl: WakeTable = { version: 1, points: [base, base + 7_200_000], updatedAt: 0, source: "firstCall" };
  const withRetry = insertRetryPoint(tbl, base + 3_600_000);
  check("вставка между точками (сортировка)", withRetry.points.join(",") === [base, base + 3_600_000, base + 7_200_000].join(","));
  check("epsilon-дедуп: близкая точка не вставляется", insertRetryPoint(withRetry, base + 3_600_030).points.length === 3);
  check("пустая таблица принимает точку", insertRetryPoint({ version: 1, points: [], updatedAt: 0, source: "firstCall" }, 42).points.join(",") === "42");

  // ===== 6. setPingDisabled (FR-017-10) =====
  cleanState();
  await setPingDisabled(true);
  check("setPingDisabled(true)", readPingState().disabled === true);
  await setPingDisabled(false);
  check("setPingDisabled(false)", readPingState().disabled === false);

  // ---- teardown ----
  restoreFetch();
  stateResetPaths();
  wakeResetPaths();
  historyResetPaths();
  resetArmsLogPath();
  resetPingConfigPaths();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

await main();
