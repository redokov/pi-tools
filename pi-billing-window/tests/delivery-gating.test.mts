/**
 * delivery-gating.test.mts -- spec 007: доставка «продолжи» строго в
 * разговор-владелец (D1) и гейт подтверждения (D2).
 *
 * Run: npx tsx tests/delivery-gating.test.mts
 *
 * Отличие от старых тест-файлов: mock-pi ЗДЕСЬ верный (faithful) --
 * sendUserMessage ДОПОЛНЯЕТ owner session-файл записью пользователя
 * (так делает реальный pi), поэтому реальная D1-верификация различает
 * «доставлено во владельца» от «ушло в чужую сессию». Старые тест-файлы
 * стабят верификацию через setVerifyDeliveredForTests(() => true).
 *
 * Сценарии:
 *  A. Позитивная доставка: send -> запись в jsonl владельца -> fire:send-ok,
 *     pending; ответ владельца с токенами -> fire:confirmed.
 *  B. Misroute -> восстановление: send ушёл в никуда (mock не пишет) ->
 *     fire:send-misroute, arm остаётся armed; после "смерти субагента"
 *     ретрай доставляет -> fire:send-ok.
 *  C. Misroute-кап: 6 неудачных попыток -> capitulation (дезарм + лог).
 *  D. Гейт подтверждения (D2): чужой ключ / 0 токенов -> НЕ подтверждает;
 *     владелец + токены -> подтверждает.
 *  E/F. Unit: ownerQuiet, verifyDelivered, isTokenBearing.
 */

import * as fs from "node:fs";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piBillingWindowFactory, {
  isTokenBearing,
  ownerQuiet,
  setArmsLogPath,
  setResetGraceMsForTests,
  setStaleRetryNotBeforeForTests,
  setVerifyDeliveredForTests,
  verifyDelivered,
  __fireWatchdogForTests,
  __resetStaleStateForTests,
  __retryTickForTests,
} from "../src/index.ts";
import {
  mutateState,
  setPaths as stateSetPaths,
  resetPaths as stateResetPaths,
} from "../src/state.ts";
import {
  setPaths as armsSetPaths,
  resetPaths as armsResetPaths,
  getArm,
  isArmed,
} from "../src/arms.ts";
import {
  setPaths as historySetPaths,
  resetPaths as historyResetPaths,
} from "../src/history.ts";

// --- harness -----------------------------------------------------------------

function assert(cond: boolean, name: string): void {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    console.error(`FAIL  ${name}`);
    process.exitCode = 1;
  }
}

const WINDOW_MS = 2 * 60 * 60 * 1000;
const CONT = "продолжи";

type SessionHandler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;

function makeFaithfulMock(): {
  pi: unknown;
  handlers: Map<string, SessionHandler>;
  commands: Map<string, CommandHandler>;
  sends: string[];
  target: { current: string | null };
  writeDelay: { ms: number };
} {
  const handlers = new Map<string, SessionHandler>();
  const commands = new Map<string, CommandHandler>();
  const sends: string[] = [];
  const target: { current: string | null } = { current: null };
  const writeDelay: { ms: number } = { ms: 0 };

  const pi = {
    events: {
      emit: (_ch: string, _data: unknown) => {},
      on: (ch: string, h: (d: unknown) => void) => () => {},
    },
    on: (ev: string, h: SessionHandler) => {
      handlers.set(ev, h);
    },
    registerCommand: (name: string, spec: { handler: CommandHandler }) => {
      commands.set(name, spec.handler);
    },
    sendUserMessage: async (content: unknown) => {
      sends.push(String(content));
      const f = target.current;
      // Faithful: real pi appends the user entry into ITS session file.
      if (f) {
        if (writeDelay.ms > 0) {
          await new Promise((r) => setTimeout(r, writeDelay.ms));
        }
        const entry = {
          type: "message",
          timestamp: new Date().toISOString(),
          message: {
            role: "user",
            content: [{ type: "text", text: String(content) }],
          },
        };
        fs.appendFileSync(f, JSON.stringify(entry) + "\n", "utf8");
      }
      return undefined;
    },
  };
  return { pi, handlers, commands, sends, target, writeDelay };
}

function makeCtx(
  sessionFile: string,
  extra?: Record<string, unknown>,
): unknown {
  return {
    mode: "tui",
    isIdle: () => true,
    model: { provider: "wormsoft", id: "test/model-1" },
    ui: { notify: () => {}, setStatus: () => {} },
    sessionManager: {
      getSessionFile: () => sessionFile,
      getCwd: () => "C:/tmp/fake-project",
      getEntries: () => [],
    },
    ...(extra ?? {}),
  };
}

function handlerOf(m: ReturnType<typeof makeFaithfulMock>, name: string): SessionHandler {
  const h = m.handlers.get(name);
  if (!h) throw new Error(`no handler registered for ${name}`);
  return h;
}

function commandOf(m: ReturnType<typeof makeFaithfulMock>, name: string): CommandHandler {
  const h = m.commands.get(name);
  if (!h) throw new Error(`no command registered for ${name}`);
  return h;
}

function applyPaths(tmp: string): void {
  stateSetPaths(join(tmp, "state.json"), join(tmp, "state.lock"));
  armsSetPaths(join(tmp, "arms.json"), join(tmp, "arms.lock"));
  historySetPaths(join(tmp, "history.csv"), join(tmp, "history.lock"));
  setArmsLogPath(join(tmp, "armslog.log"));
}

function cleanupPaths(tmp: string): void {
  rmSync(tmp, { recursive: true, force: true });
  stateResetPaths();
  armsResetPaths();
  historyResetPaths();
  setVerifyDeliveredForTests(null);
}

/** Create the owner session file with an OLD mtime (ownerQuiet true). */
function makeQuietOwnerFile(tmp: string): string {
  const f = join(tmp, "owner.jsonl");
  writeFileSync(f, "", "utf8");
  const past = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(f, past, past);
  return f;
}

async function seedFreshWindow(): Promise<void> {
  const { writeStateSync } = await import("../src/state.ts");
  writeStateSync({
    provider: "wormsoft",
    windowStartedAt: Date.now(),
    windowMs: WINDOW_MS,
    lastResetAt: 0,
    resetCount: 1,
    callsInWindow: 0,
  });
}

async function backdateReset(): Promise<void> {
  await mutateState((cur) => {
    if (cur === null) throw new Error("state file missing");
    return { next: { ...cur, lastResetAt: Date.now() - 60_000 } };
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Assistant entries for the after_provider_response gating tests. */
function usageEntries(input: number, output: number): unknown[] {
  return [
    { type: "message", message: { role: "assistant", usage: { input, output } } },
  ];
}

// --- scenario A: positive delivery + confirmation ----------------------------

async function testPositiveDelivery(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-007-pos-"));
  applyPaths(tmp);
  try {
    __resetStaleStateForTests();
    await seedFreshWindow();
    const m = makeFaithfulMock();
    piBillingWindowFactory(m.pi as never);

    const ownerFile = makeQuietOwnerFile(tmp);
    const ctxOwner = makeCtx(ownerFile);
    await handlerOf(m, "session_start")({ reason: "start" }, ctxOwner);
    await commandOf(m, "cont-after-reset")("", ctxOwner);
    assert(isArmed(), "A: флаг взведён до сброса");
    await backdateReset();

    setResetGraceMsForTests(150);
    m.target.current = ownerFile; // faithful mock writes to the owner jsonl
    await __fireWatchdogForTests();
    await sleep(500);

    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(m.sends.length === 1 && m.sends[0] === CONT, "A: «продолжи» отправлен");
    if (!log.includes("fire:send-ok")) {
      console.error("A: armslog:\n" + log.split("\n").slice(-8).join("\n"));
    }
    assert(log.includes("fire:send-ok"), "A: fire:send-ok в armslog");
    assert(
      !log.includes("fire:send-misroute"),
      "A: нет fire:send-misroute (верификация нашла запись владельца)",
    );
    assert(getArm()?.phase === "pending", "A: arm в pending после доставки");

    // Confirm: the OWNER responds with a token-bearing wormsoft call.
    await handlerOf(m, "after_provider_response")(
      { status: 200, headers: {} },
      makeCtx(ownerFile, {
        sessionManager: {
          getSessionFile: () => ownerFile,
          getCwd: () => "C:/tmp/fake-project",
          getEntries: () => usageEntries(1200, 300),
        },
      }),
    );
    const log2 = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(
      log2.includes("fire:confirmed"),
      "A: fire:confirmed по ответу владельца с токенами",
    );
    await handlerOf(m, "session_shutdown")({}, ctxOwner);
  } finally {
    cleanupPaths(tmp);
  }
}

// --- scenario B: misroute -> recovery ----------------------------------------

async function testMisrouteAndRecovery(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-007-mis-"));
  applyPaths(tmp);
  try {
    __resetStaleStateForTests();
    await seedFreshWindow();
    const m = makeFaithfulMock();
    piBillingWindowFactory(m.pi as never);

    const ownerFile = makeQuietOwnerFile(tmp);
    const ctxOwner = makeCtx(ownerFile);
    await handlerOf(m, "session_start")({ reason: "start" }, ctxOwner);
    await commandOf(m, "cont-after-reset")("", ctxOwner);
    await backdateReset();

    setResetGraceMsForTests(150);
    m.target.current = null; // send resolves, but the entry goes NOWHERE
    await __fireWatchdogForTests();
    await sleep(16500); // covers the up-to-15 s re-verify rounds before the misroute

    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(
      log.includes("fire:send-misroute"),
      "B: fire:send-misroute — sendUserMessage решился, записи владельца нет",
    );
    assert(
      !log.includes("fire:send-ok"),
      "B: НЕТ fire:send-ok при недоставке (тихий пропуск задет)",
    );
    assert(isArmed(), "B: arm остаётся armed (delivery in flight), не pending");

    // Recovery: the foreign subagent died, the slot re-binds to the owner;
    // the retry delivers and the faithful mock writes the owner entry.
    m.target.current = ownerFile;
    setStaleRetryNotBeforeForTests(0); // compress the misroute backoff
    await __retryTickForTests();
    await sleep(200);

    const log2 = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(m.sends.length === 2, "B: ретрай отправил второй «продолжи»");
    assert(
      log2.includes("fire:send-ok"),
      "B: после «смерти субагента» ретрай доставил — fire:send-ok",
    );
    await handlerOf(m, "session_shutdown")({}, ctxOwner);
  } finally {
    cleanupPaths(tmp);
  }
}

// --- scenario B2: slow-but-real delivery -> re-verify (D1) -------------------

async function testReverifyLateAppend(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-007-rev-"));
  applyPaths(tmp);
  try {
    __resetStaleStateForTests();
    await seedFreshWindow();
    const m = makeFaithfulMock();
    piBillingWindowFactory(m.pi as never);

    const ownerFile = makeQuietOwnerFile(tmp);
    const ctxOwner = makeCtx(ownerFile);
    await handlerOf(m, "session_start")({ reason: "start" }, ctxOwner);
    await commandOf(m, "cont-after-reset")("", ctxOwner);
    await backdateReset();

    setResetGraceMsForTests(150);
    m.target.current = ownerFile;
    m.writeDelay.ms = 1200; // pi appends the entry AFTER sendUserMessage resolves
    await __fireWatchdogForTests();
    await sleep(8000); // covers the up-to-7.5 s re-verify rounds

    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(
      log.includes("fire:send-ok"),
      "B2: довпись через 3 с -> реверификация сняла ложный misroute, fire:send-ok",
    );
    assert(
      !log.includes("fire:send-misroute"),
      "B2: НЕТ fire:send-misroute при реальной (медленной) доставке",
    );
    assert(getArm()?.phase === "pending", "B2: arm в pending после доставки");
    await handlerOf(m, "session_shutdown")({}, ctxOwner);
  } finally {
    cleanupPaths(tmp);
  }
}


// --- scenario C: misroute cap -> capitulation --------------------------------

async function testMisrouteCapitulation(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-007-cap-"));
  applyPaths(tmp);
  try {
    __resetStaleStateForTests();
    await seedFreshWindow();
    const m = makeFaithfulMock();
    piBillingWindowFactory(m.pi as never);

    const ownerFile = makeQuietOwnerFile(tmp);
    const ctxOwner = makeCtx(ownerFile);
    await handlerOf(m, "session_start")({ reason: "start" }, ctxOwner);
    await commandOf(m, "cont-after-reset")("", ctxOwner);
    await backdateReset();

    setResetGraceMsForTests(150);
    // Persistent misroute: every send resolves but never reaches the owner.
    setVerifyDeliveredForTests(() => false);
    // The FIRST send happens on the watchdog fire (reset planned + grace);
    // the remaining 5 are re-driven by the retry loop.
    await __fireWatchdogForTests();
    await sleep(16500); // the fire's misroute re-verify completes before the loop
    for (let i = 0; i < 5; i++) {
      setStaleRetryNotBeforeForTests(0); // compress the misroute backoff
      await __retryTickForTests();
      await sleep(50);
    }
    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(
      (log.match(/fire:send-misroute/g) ?? []).length === 6,
      "C: 6 fire:send-misroute (каждая попытка задокументирована)",
    );
    assert(
      log.includes("capitulation:after-6"),
      "C: после 6 неудачных попыток — капитуляция, не молчаливый цикл",
    );
    assert(getArm() === null, "C: флаг снят при капитуляции");
    await handlerOf(m, "session_shutdown")({}, ctxOwner);
  } finally {
    cleanupPaths(tmp);
  }
}

// --- scenario D: confirmation gating (D2) ------------------------------------

async function testConfirmGating(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-007-gate-"));
  applyPaths(tmp);
  try {
    __resetStaleStateForTests();
    await seedFreshWindow();
    const m = makeFaithfulMock();
    piBillingWindowFactory(m.pi as never);

    const ownerFile = makeQuietOwnerFile(tmp);
    const foreignFile = join(tmp, "foreign.jsonl");
    const ctxOwner = makeCtx(ownerFile);
    await handlerOf(m, "session_start")({ reason: "start" }, ctxOwner);
    await commandOf(m, "cont-after-reset")("", ctxOwner);
    await backdateReset();

    setResetGraceMsForTests(150);
    m.target.current = ownerFile;
    await __fireWatchdogForTests();
    await sleep(500);
    assert(m.sends.length === 1, "D: доставка состоялась (pending готов к подтверждению)");

    const respond = (file: string, input: number, output: number) =>
      handlerOf(m, "after_provider_response")(
        { status: 200, headers: {} },
        makeCtx(file, {
          sessionManager: {
            getSessionFile: () => file,
            getCwd: () => "C:/tmp/fake-project",
            getEntries: () => usageEntries(input, output),
          },
        }),
      );

    // (1) FOREIGN session, token-bearing -> must NOT confirm.
    await respond(foreignFile, 143574, 11873);
    assert(
      !readFileSync(join(tmp, "armslog.log"), "utf8").includes("fire:confirmed"),
      "D1: чужой субагентский ответ (даже с токенами) НЕ подтверждает флаг",
    );

    // (2) OWNER session, 0 tokens (background flash call) -> must NOT confirm.
    await respond(ownerFile, 0, 0);
    assert(
      !readFileSync(join(tmp, "armslog.log"), "utf8").includes("fire:confirmed"),
      "D2: 0-токен фоновый вызов владельца НЕ подтверждает флаг",
    );

    // (3) OWNER session, token-bearing -> confirms.
    await respond(ownerFile, 1200, 300);
    assert(
      readFileSync(join(tmp, "armslog.log"), "utf8").includes("fire:confirmed"),
      "D3: ответ владельца с токенами подтверждает флаг",
    );
    await handlerOf(m, "session_shutdown")({}, ctxOwner);
  } finally {
    cleanupPaths(tmp);
  }
}

// --- scenario E/F: unit helpers ----------------------------------------------

async function testUnitHelpers(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-007-unit-"));
  applyPaths(tmp);
  try {
    // ownerQuiet
    const f = makeQuietOwnerFile(tmp);
    assert(ownerQuiet(f, 60_000) === true, "E: тихий jsonl (mtime 10 мин назад) -> ownerQuiet true");
    writeFileSync(f, "x", "utf8"); // fresh mtime
    assert(ownerQuiet(f, 60_000) === false, "E: свежий jsonl -> ownerQuiet false");
    assert(ownerQuiet(join(tmp, "missing.jsonl"), 60_000) === true, "E: файл отсутствует -> ownerQuiet true (не блокирует)");
    assert(ownerQuiet(null, 60_000) === true, "E: ownerKey null -> ownerQuiet true");

    // verifyDelivered
    const now = Date.now();
    const entry = {
      type: "message",
      timestamp: new Date(now - 200).toISOString(),
      message: { role: "user", content: [{ type: "text", text: CONT }] },
    };
    const f2 = join(tmp, "sess.jsonl");
    writeFileSync(f2, JSON.stringify(entry) + "\n", "utf8");
    assert(verifyDelivered(f2, now, CONT) === true, "F: запись пользователя «продолжи» после отправки -> true");
    const oldEntry = {
      type: "message",
      timestamp: new Date(now - 60_000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: CONT }] },
    };
    const f3 = join(tmp, "sess-old.jsonl");
    writeFileSync(f3, JSON.stringify(oldEntry) + "\n", "utf8");
    assert(verifyDelivered(f3, now, CONT) === false, "F: запись ДО отправки (60 с назад) -> false");
    const asstEntry = {
      type: "message",
      timestamp: new Date(now - 200).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: CONT }] },
    };
    const f4 = join(tmp, "sess-asst.jsonl");
    writeFileSync(f4, JSON.stringify(asstEntry) + "\n", "utf8");
    assert(verifyDelivered(f4, now, CONT) === false, "F: role=assistant -> false (только role=user)");
    assert(verifyDelivered(join(tmp, "nope.jsonl"), now, CONT) === false, "F: файл не читается -> false");
    assert(verifyDelivered(null, now, CONT) === false, "F: ownerKey null -> false");

    // isTokenBearing
    assert(isTokenBearing(null) === false, "F: usage null -> false");
    assert(isTokenBearing({ input: 0, output: 0 }) === false, "F: 0/0 -> false (фоновый вызов)");
    assert(isTokenBearing({ input: 1200, output: 0 }) === true, "F: input>0 -> true");
    assert(isTokenBearing({ input: 0, output: 41 }) === true, "F: output>0 -> true");
    assert(isTokenBearing({ input: 0, output: 0, cacheRead: 500 }) === true, "F: cacheRead>0 -> true");

    // __resetStaleStateForTests resets the misroute streak (no direct assert:
    // misrouteAttempts is module-private; covered by scenario B/C order).
    __resetStaleStateForTests();
  } finally {
    cleanupPaths(tmp);
  }
}

// --- main --------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n=== Spec 007: delivery routing + confirm gating ===");
  await testUnitHelpers();
  await testPositiveDelivery();
  await testMisrouteAndRecovery();
  await testReverifyLateAppend();
  await testMisrouteCapitulation();
  await testConfirmGating();
  console.log("========================================");
  // Spec 003 (exit hygiene): guarantee the process exits. The asserts set
  // process.exitCode=1 on failure, so a forced exit preserves the verdict.
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
