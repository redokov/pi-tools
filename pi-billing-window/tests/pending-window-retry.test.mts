/**
 * pending-window-retry.test.mts -- spec 005 (fire-once-per-window).
 *
 * Run: npx tsx tests/pending-window-retry.test.mts
 *
 * NEW pending semantics: after "продолжи" is sent (phase "pending") a
 * re-send is allowed ONLY after a NEW window reset (state.lastResetAt
 * advanced past the reset the send was made for). Elapsed time since
 * lastFireAt / last429At is NO LONGER a send condition (FR1/FR6).
 *
 * Drives the real extension factory through the same public hooks as
 * tests/watchdog.e2e.test.mts (mock pi/ctx, temp paths, fake time via
 * backdating the arms.json / state.json files, manual retry ticks via
 * __retryTickForTests()). No real minutes are ever waited.
 *
 * NOTE: this suite is EXPECTED to be RED against the current src (old
 * 5-min pacing in retryTick). It is the T1 (spec 005) target for the
 * implementation in src/index.ts.
 */

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piBillingWindowFactory, {
  setArmsLogPath,
  setStaleRetryMsForTests,
  setResetGraceMsForTests,
  __fireWatchdogForTests,
  __retryTickForTests,
  __resetStaleStateForTests,
  setVerifyDeliveredForTests,
} from "../src/index.ts";
import {
  writeStateSync,
  mutateState,
  setPaths as stateSetPaths,
  resetPaths as stateResetPaths,
} from "../src/state.ts";
import {
  setPaths as armsSetPaths,
  resetPaths as armsResetPaths,
  isArmed as armsIsArmed,
  getArm as armsGetArm,
  RESET_GRACE_MS,
  RETRY_AFTER_FIRE_MS,
  type ArmMap,
} from "../src/arms.ts";
import {
  setPaths as historySetPaths,
  resetPaths as historyResetPaths,
} from "../src/history.ts";

// --- tiny assert harness (same style as watchdog.e2e.test.mts) ----------------

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

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// --- mock pi / ctx (watchdog.e2e.test.mts pattern) -----------------------------

type SessionHandler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;

function makeMockPi(): {
  pi: unknown;
  handlers: Map<string, SessionHandler[]>;
  commands: Map<string, CommandHandler>;
  sends: Array<{ content: unknown; opts: unknown }>;
} {
  const handlers = new Map<string, SessionHandler[]>();
  const commands = new Map<string, CommandHandler>();
  const sends: Array<{ content: unknown; opts: unknown }> = [];
  const busSubs = new Map<string, Array<(d: unknown) => void>>();

  const pi = {
    events: {
      emit: (_ch: string, _data: unknown) => {},
      on: (ch: string, h: (d: unknown) => void) => {
        const arr = busSubs.get(ch) ?? [];
        arr.push(h);
        busSubs.set(ch, arr);
        return () => {
          const i = arr.indexOf(h);
          if (i >= 0) arr.splice(i, i === -1 ? arr.length : 1);
        };
      },
    },
    on: (ev: string, h: SessionHandler) => {
      const arr = handlers.get(ev) ?? [];
      arr.push(h);
      handlers.set(ev, arr);
    },
    registerCommand: (name: string, spec: { handler: CommandHandler }) => {
      commands.set(name, spec.handler);
    },
    sendUserMessage: async (content: unknown, opts?: unknown) => {
      sends.push({ content, opts });
      return undefined;
    },
  };
  return { pi, handlers, commands, sends };
}

/**
 * Spec 007 (D2): default token-bearing assistant entries for the response
 * handler -- a successful wormsoft call with token burn confirms the
 * pending cont-after-reset arm. (0-token negative cases are covered in
 * tests/delivery-gating.test.mts.)
 */
const TOKEN_ENTRIES = [
  { type: "message", message: { role: "assistant", usage: { input: 1200, output: 300 } } },
];

function makeCtx(sessionFile: string): unknown {
  return {
    mode: "tui",
    isIdle: () => true,
    model: { provider: "wormsoft", id: "test/model-1" },
    ui: {
      notify: () => {},
      setStatus: () => {},
    },
    sessionManager: {
      getSessionFile: () => sessionFile,
      getCwd: () => "C:/tmp/fake-project",
      getEntries: () => TOKEN_ENTRIES,
    },
  };
}

// --- state/arms seeding and fake-time helpers ---------------------------------

const WINDOW_MS = 2 * 60 * 60 * 1000;

function seedFreshWindow(): void {
  writeStateSync({
    provider: "wormsoft",
    windowStartedAt: Date.now(),
    windowMs: WINDOW_MS,
    lastResetAt: 0,
    resetCount: 1,
    callsInWindow: 0,
  });
}

/** Backdate the window so the boundary lies in the past (real reset). */
async function expireWindow(): Promise<void> {
  await mutateState((cur) => {
    if (cur === null) throw new Error("state file missing");
    return {
      next: {
        ...cur,
        windowStartedAt: Date.now() - WINDOW_MS - 1000,
      },
    };
  });
}

/** Advance state.lastResetAt to a "new" window reset (default: now - 30 s). */
async function advanceResetAt(msAgo = 30_000): Promise<void> {
  await mutateState((cur) => {
    if (cur === null) throw new Error("state file missing");
    return {
      next: {
        ...cur,
        lastResetAt: Date.now() - msAgo,
      },
    };
  });
}

/**
 * Fake elapsed time WITHOUT a window reset: move the old pacing markers
 * (arm.lastFireAt and state.last429At) far into the past. Under the OLD
 * retryTick this alone re-arms the 5-min send; under the NEW semantics it
 * must change nothing (no new reset).
 */
function backdatePacingMarkers(tmp: string, ms: number): void {
  const armsPath = join(tmp, "arms.json");
  const map = JSON.parse(readFileSync(armsPath, "utf8")) as ArmMap;
  const key = Object.keys(map)[0];
  if (!key) throw new Error("no arm on disk");
  const arm = map[key];
  if (arm) arm.lastFireAt = Date.now() - ms;
  writeFileSync(armsPath, JSON.stringify(map, null, 2), "utf8");
}

async function backdateLast429At(ms: number): Promise<void> {
  await mutateState((cur) => {
    if (cur === null) throw new Error("state file missing");
    return { next: { ...cur, last429At: Date.now() - ms } };
  });
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
}

// --- scenario plumbing --------------------------------------------------------

interface Fixture {
  tmp: string;
  sends: Array<{ content: unknown; opts: unknown }>;
  handlers: Map<string, SessionHandler[]>;
  commands: Map<string, CommandHandler>;
  ctx: unknown;
}

/**
 * Common prologue: fresh window → arm → expire window → watchdog fire →
 * "продолжи" sent exactly once and phase = "pending".
 */
async function setupPendingSend(): Promise<Fixture> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-pwr-"));
  applyPaths(tmp);
  setResetGraceMsForTests(40);
  setStaleRetryMsForTests(0);
  __resetStaleStateForTests();
  seedFreshWindow();

  const { pi, handlers, commands, sends } = makeMockPi();
  piBillingWindowFactory(pi as never);

  const ctx = makeCtx(join(tmp, "sess-pwi.jsonl"));
  const sessionStart = handlers.get("session_start")?.[0];
  const contAfterReset = commands.get("cont-after-reset");
  if (!sessionStart || !contAfterReset) {
    throw new Error("extension did not register hooks");
  }
  await sessionStart({}, ctx);
  await contAfterReset("", ctx);
  await expireWindow();
  await __fireWatchdogForTests();
  await sleep(300);

  return { tmp, sends, handlers, commands, ctx };
}

// --- spec 005 scenarios ----------------------------------------------------------

/**
 * (а) FR1: pending после send-ok + 3 тика retryTick БЕЗ нового сброса окна
 * (даже с прошедшими >5 мин по lastFireAt/last429At) → НОЛЬ повторных
 * отправок. RED on old: старый retryTick шлёт по 5-мин таймауту.
 */
async function testElapsedTimeWithoutResetStaysSilent(): Promise<void> {
  const { tmp, sends, ctx } = await setupPendingSend();
  try {
    assert(
      sends.length === 1 && sends[0]?.content === "продолжи",
      "a0: первая отправка «продолжи» состоялась (send-ok, phase=pending)",
    );
    assert(
      armsGetArm()?.phase === "pending",
      "a0: флаг в фазе pending после send-ok",
    );

    // 5+ минут прошли, но НОВОГО сброса окна не было (баг из продакшена).
    backdatePacingMarkers(tmp, RETRY_AFTER_FIRE_MS + 60_000); // lastFireAt ≈ 6 мин назад
    await backdateLast429At(RETRY_AFTER_FIRE_MS + 60_000); // last429At ≈ 6 мин назад

    for (let i = 0; i < 3; i++) {
      await __retryTickForTests();
      await sleep(120);
    }
    assert(
      sends.length === 1,
      `a: 3 тика retryTick без нового сброса → 0 повторных отправок (sends=${sends.length})`,
    );
    assert(
      armsGetArm()?.phase === "pending",
      "a: флаг остаётся pending (не снят и не переотправлен)",
    );
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    __resetStaleStateForTests();
    cleanupPaths(tmp);
  }
}

/**
 * (б) FR2: НОВЫЙ сброс окна (state.lastResetAt продвинулся) → ровно ОДНА
 * повторная отправка (без ожидания 5 мин!). RED on old: старый retryTick
 * молчит, т.к. 5 мин от lastFireAt ещё не прошло → sends останется 1.
 */
async function testNewResetSendsExactlyOnce(): Promise<void> {
  const { tmp, sends, ctx } = await setupPendingSend();
  try {
    assert(
      sends.length === 1 && armsGetArm()?.phase === "pending",
      "b0: исходно pending, одна отправка",
    );

    // Новый сброс окна, произошедший 30 с назад. Отправка разрешена СРАЗУ
    // (grace уже не пережидается; никаких 5 мин ожидания по lastFireAt).
    await advanceResetAt(30_000);
    await __retryTickForTests();
    await sleep(250);
    assert(
      sends.length === 2 && sends[1]?.content === "продолжи",
      `b: новый сброс окна → ровно одна повторная отправка (sends=${sends.length})`,
    );

    // Ещё тики без нового сброса → тишина (маркер обновлён на новый сброс).
    for (let i = 0; i < 2; i++) {
      await __retryTickForTests();
      await sleep(100);
    }
    assert(
      sends.length === 2,
      `b: ещё 2 тика без сброса → больше повторных отправок нет (sends=${sends.length})`,
    );
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    __resetStaleStateForTests();
    cleanupPaths(tmp);
  }
}

/**
 * (в) FR1 persistence: после повторной отправки (новый сброс) маркер
 * закреплён; даже при повторном «прошествии» >5 мин без следующего сброса
 * остаёмся тихими. RED on old: старый retryTick снова шлёт по 5-мин
 * таймауту от обновлённого lastFireAt → sends станет 3.
 */
async function testSilencePersistsAfterResend(): Promise<void> {
  const { tmp, sends, ctx } = await setupPendingSend();
  try {
    assert(sends.length === 1, "c0: первая отправка send-ok");

    // Новый сброс → одна повторная отправка.
    await advanceResetAt(30_000);
    await __retryTickForTests();
    await sleep(250);
    assert(sends.length === 2, "c: новый сброс дал одну повторную отправку");

    // Снова «прошли» >5 мин (по старым маркерам), но сброса не было.
    backdatePacingMarkers(tmp, RETRY_AFTER_FIRE_MS + 120_000);
    await backdateLast429At(RETRY_AFTER_FIRE_MS + 120_000);
    for (let i = 0; i < 4; i++) {
      await __retryTickForTests();
      await sleep(100);
    }
    assert(
      sends.length === 2,
      `c: 4 тика с прошедшими >5 мин без сброса → тишина (sends=${sends.length})`,
    );
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    __resetStaleStateForTests();
    cleanupPaths(tmp);
  }
}

/**
 * (г) FR3: подтверждение (успешный ответ провайдера) между тиками снимает
 * флаг; последующие тики (даже с прошедшими >5 мин) отправок не делают.
 */
async function testConfirmBetweenTicksClearsFlag(): Promise<void> {
  const { tmp, sends, handlers, ctx } = await setupPendingSend();
  try {
    assert(
      sends.length === 1 && armsGetArm()?.phase === "pending",
      "d0: pending до подтверждения",
    );

    const afterProvider = handlers.get("after_provider_response")?.[0];
    if (!afterProvider) throw new Error("no after_provider_response handler");
    await afterProvider({ status: 200, headers: {} }, ctx);
    assert(
      !armsIsArmed() && armsGetArm() === null,
      "d: успешный ответ подтвердил — одноразовый флаг снят (запись удалена)",
    );

    // Флаг снят — даже после прошествия >5 мин тики не должны ничего
    // отправить (retryTick выходит рано: фазы pending больше нет).
    for (let i = 0; i < 3; i++) {
      await __retryTickForTests();
      await sleep(100);
    }
    assert(
      sends.length === 1,
      `d: после подтверждения тики тихи (sends=${sends.length})`,
    );
    assert(
      armsGetArm() === null,
      "d: запись отсутствует после подтверждения",
    );
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    __resetStaleStateForTests();
    cleanupPaths(tmp);
  }
}

// --- runner ---------------------------------------------------------------------

async function main(): Promise<void> {
  // Spec 007: unit-test mocks do not write session-file entries -- stub
  // the D1 delivery verification to always-true (the new delivery-gating
  // tests drive the real verification with a faithful mock).
  setVerifyDeliveredForTests(() => true);
  console.log(
    "\n=== Spec 005: pending-window-retry (fire-once-per-window) ===",
  );
  await testElapsedTimeWithoutResetStaysSilent();
  await testNewResetSendsExactlyOnce();
  await testSilencePersistsAfterResend();
  await testConfirmBetweenTicksClearsFlag();

  console.log("\n======================================");
  for (const r of results) console.log(r);
  console.log("======================================");
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
