/**
 * watchdog.e2e.test.mts -- e2e scenarios for the watchdog-driven
 * cont-after-reset model (docs/watchdog-redesign.md, Task 3).
 *
 * Run: npx tsx tests/watchdog.e2e.test.mts
 *
 * Drives the real extension factory (src/index.ts default export) through a
 * mock ExtensionAPI (the lifecycle.test.mts pattern). Real minutes are never
 * waited: the window boundary is backdated via state.windowStartedAt, the
 * grace is shrunk via setResetGraceMsForTests() and the resync/fire/retry
 * ticks are driven manually via __syncWatchdogForTests() /
 * __fireWatchdogForTests() / __retryTickForTests().
 *
 * NOTE on "watchdog очищен" in one-shot scenarios (4 and 8): per the spec
 * ("Новая модель": the watchdog is armed on the known window boundary ALWAYS
 * while a live state exists, even without an arm), after a one-shot
 * confirm / disarm the watchdog is RE-POINTED at the fresh window boundary
 * (it must still do a precise reset) -- it only stops pointing at
 * reset+grace. The tests therefore assert pendingFireAt() === the boundary,
 * not hasWatchdog() === false.
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
  __syncWatchdogForTests,
  __fireWatchdogForTests,
  __retryTickForTests,
} from "../src/index.ts";
import {
  writeStateSync,
  mutateState,
  readStateSync,
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
  ARMS_TTL_MS,
  type Arm,
  type ArmMap,
} from "../src/arms.ts";
import {
  setPaths as historySetPaths,
  resetPaths as historyResetPaths,
} from "../src/history.ts";
import {
  hasWatchdog,
  pendingFireAt,
  computeFireAt,
} from "../src/watchdog.ts";

// --- tiny assert harness (same style as tests/lifecycle.test.mts) -------------

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

// --- mock pi / ctx (lifecycle.test.mts pattern) --------------------------------

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
      getEntries: () => [],
    },
  };
}

// --- state seeding ------------------------------------------------------------

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

/**
 * Backdate the window so the boundary (windowStartedAt + windowMs) lies in
 * the past: checkAndReset() inside the (hook-driven) watchdog fire performs
 * a real reset.
 */
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

function handlerOf(
  handlers: Map<string, SessionHandler[]>,
  name: string,
): SessionHandler {
  const h = handlers.get(name)?.[0];
  if (!h) throw new Error(`no handler registered for ${name}`);
  return h;
}

function commandOf(
  commands: Map<string, CommandHandler>,
  name: string,
): CommandHandler {
  const h = commands.get(name);
  if (!h) throw new Error(`no command registered for ${name}`);
  return h;
}

/**
 * Backdate the pending arm's lastFireAt on disk (the arms file is the
 * persistence layer, so simulating elapsed time is a plain file edit).
 */
function backdateLastFireAt(tmp: string, ms: number): void {
  const armsPath = join(tmp, "arms.json");
  const map = JSON.parse(readFileSync(armsPath, "utf8")) as Record<
    string,
    { lastFireAt?: number }
  >;
  const key = Object.keys(map)[0];
  if (!key) throw new Error("no arm on disk");
  map[key].lastFireAt = Date.now() - ms;
  writeFileSync(armsPath, JSON.stringify(map, null, 2), "utf8");
}

/** Backdate state.last429At (drives the pending-retry pacing). */
async function backdateLast429At(ms: number): Promise<void> {
  await mutateState((cur) => {
    if (cur === null) throw new Error("state file missing");
    return {
      next: { ...cur, last429At: Date.now() - ms },
    };
  });
}

// --- 1. /settimer 30m при armed → watchdog взведён ----------------------------

/**
 * Scenario 1: "/settimer 30m" while the conversation is armed must re-point
 * the watchdog at the NEW boundary (now + 30 min, ±1 s tolerance) and keep
 * the armed flag intact.
 */
async function testSettimerArmsWatchdog(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-wd-settimer-"));
  applyPaths(tmp);
  try {
    seedFreshWindow();
    const { pi, handlers, commands } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-1.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);
    assert(armsIsArmed(), "settimer: взведён cont-after-reset");

    const before = Date.now();
    await commandOf(commands, "settimer")("30m", ctx);
    const after = Date.now();

    const fireAt = pendingFireAt();
    assert(
      fireAt !== null,
      "settimer: watchdog взведён (pendingFireAt != null)",
    );
    const lower = before + 30 * 60 * 1000 - 1000;
    const upper = after + 30 * 60 * 1000 + 1000;
    assert(
      fireAt !== null && fireAt >= lower && fireAt <= upper,
      `settimer: fireAt ≈ now+30m (получено смещение ${
        fireAt === null ? "?" : Math.round((fireAt - before) / 1000)
      } с, ожидание ±1 с)`,
    );
    assert(
      armsIsArmed() && armsGetArm()?.phase !== "pending",
      "settimer: armed-флаг сохранён (phase ещё не pending)",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    cleanupPaths(tmp);
  }
}

// --- 2. Watchdog fire → reset + ровно один «продолжи» ---------------------------

/**
 * Scenario 2: a (hook-driven) watchdog fire with a shortened grace must:
 * reset the window (resetCount grows), send "продолжи" EXACTLY once and
 * switch the flag to "pending". A double hook invocation must not duplicate
 * the send (the in-flight guard drops the concurrent second fire, and after
 * the send the sync/retry hooks stay paced).
 */
async function testWatchdogFireSendsOnce(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-wd-fire-"));
  applyPaths(tmp);
  setResetGraceMsForTests(40);
  try {
    seedFreshWindow();
    const { pi, handlers, commands, sends } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-2.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);
    const resetCountBefore = readStateSync()?.resetCount ?? -1;

    await expireWindow();
    // Double hook invocation: the concurrent second fire is dropped by the
    // in-flight guard, so the reset produces exactly one grace timer.
    await Promise.all([
      __fireWatchdogForTests(),
      __fireWatchdogForTests(),
    ]);
    await sleep(300); // reset + (40 ms) grace + send

    const st = readStateSync();
    assert(
      (st?.resetCount ?? 0) > resetCountBefore,
      "fire: окно сброшено (resetCount вырос)",
    );
    assert(
      sends.length === 1 && sends[0]?.content === "продолжи",
      "fire: «продолжи» отправлен ровно один раз",
    );
    assert(
      armsGetArm()?.phase === "pending",
      "fire: флаг перешёл в pending",
    );

    // Double hook invocation after the send: the pending branch never sends
    // directly, and the retry tick is paced by RETRY_AFTER_FIRE_MS.
    await __syncWatchdogForTests();
    await __syncWatchdogForTests();
    await __retryTickForTests();
    await sleep(200);
    assert(
      sends.length === 1,
      "fire: двойной sync + retry не дублируют отправку",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    cleanupPaths(tmp);
  }
}

// --- 3. 429 → повтор не раньше 5 минут ------------------------------------------

/**
 * Scenario 3: right after a "продолжи" a 429 arrives. The pending-retry tick
  * must NOT re-send (RETRY_AFTER_FIRE_MS has not passed); once 6 minutes are
 * backdated into BOTH the arm's lastFireAt (arms.json) and state.last429At,
 * the retry tick re-sends.
 */
async function test429RetryPacing(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-wd-429-"));
  applyPaths(tmp);
  setResetGraceMsForTests(40);
  try {
    seedFreshWindow();
    const { pi, handlers, commands, sends } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-3.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);
    await expireWindow();
    await __fireWatchdogForTests();
    await sleep(300);
    assert(sends.length === 1, "429: первый «продолжи» отправлен");

    // Fresh 429 after the send: retryAfter moves to "now".
    await handlerOf(handlers, "after_provider_response")(
      { status: 429, headers: {} },
      ctx,
    );
    await __retryTickForTests();
    await sleep(200);
    assert(
      sends.length === 1,
      "429: нет повтора сразу после 429 (не прошло 5 мин)",
    );

    // 6 minutes since BOTH the send and the 429 -> the retry fires.
    backdateLastFireAt(tmp, RETRY_AFTER_FIRE_MS + 60_000);
    await backdateLast429At(RETRY_AFTER_FIRE_MS + 60_000);
    await __retryTickForTests();
    await sleep(300);
    assert(
      sends.length === 2 && sends[1]?.content === "продолжи",
      "429: повтор после прошествия 5+ минут",
    );
    assert(
      armsGetArm()?.phase === "pending",
      "429: флаг остаётся в pending",
    );
    const arm = armsGetArm();
    assert(
      typeof arm?.lastFireAt === "number" &&
        arm.lastFireAt > Date.now() - 5_000,
      "429: lastFireAt обновлён повторной отправкой",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    cleanupPaths(tmp);
  }
}

// --- 4. Успешный ответ → confirmSuccess (одноразовый) --------------------------

/**
 * Scenario 4: the first successful provider response after "продолжи"
 * confirms a ONE-SHOT arm: the flag is removed and the watchdog stops
 * pointing at reset+grace. Per the spec (watchdog stays on the boundary
 * while a live state exists) the watchdog is then re-armed at the FRESH
 * window boundary, not cleared outright.
 */
async function testOneShotConfirmClearsFlag(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-wd-confirm-"));
  applyPaths(tmp);
  setResetGraceMsForTests(40);
  try {
    seedFreshWindow();
    const { pi, handlers, commands, sends } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-4.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);
    await expireWindow();
    await __fireWatchdogForTests();
    await sleep(300);
    assert(sends.length === 1, "confirm: «продолжи» отправлен");
    assert(
      armsGetArm()?.phase === "pending",
      "confirm: флаг в pending до успешного ответа",
    );

    await handlerOf(handlers, "after_provider_response")(
      { status: 200, headers: {} },
      ctx,
    );

    assert(!armsIsArmed(), "confirm: одноразовый флаг снят");
    assert(
      armsGetArm() === null,
      "confirm: запись удалена из arms.json",
    );

    const st = readStateSync();
    assert(
      hasWatchdog(),
      "confirm: watchdog жив (ТЗ: всегда взведён при живом state)",
    );
    assert(
      pendingFireAt() ===
        (st === null ? null : st.windowStartedAt + st.windowMs),
      "confirm: watchdog смотрит на новую границу окна, не на reset+grace",
    );

    // No more sends: the machinery is quiet after the confirmation.
    await __syncWatchdogForTests();
    await __retryTickForTests();
    await sleep(200);
    assert(
      sends.length === 1,
      "confirm: больше никаких отправок после подтверждения",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    cleanupPaths(tmp);
  }
}

// --- 5. repeat=2: перевзвод на новую границу -----------------------------------

/**
 * Scenario 5: with repeat=2, the confirm re-arms the flag (repeat 2 -> 1,
 * phase "armed") and the watchdog points at the NEW window boundary
 * (windowStartedAt + 2h ~= lastResetAt + 2h). No further sends.
 */
async function testRepeatTwoRearmsWatchdog(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-wd-repeat-"));
  applyPaths(tmp);
  setResetGraceMsForTests(40);
  try {
    seedFreshWindow();
    const { pi, handlers, commands, sends } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-5.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("2", ctx);
    assert(
      armsGetArm()?.repeat === 2,
      "repeat: взведён с repeat=2",
    );

    await expireWindow();
    await __fireWatchdogForTests();
    await sleep(300);
    assert(sends.length === 1, "repeat: первый «продолжи» отправлен");

    await handlerOf(handlers, "after_provider_response")(
      { status: 200, headers: {} },
      ctx,
    );

    const arm = armsGetArm();
    assert(
      arm !== null && arm.phase === "armed" && arm.repeat === 1,
      "repeat: флаг перевзведён (repeat=1, phase=armed)",
    );
    const st = readStateSync();
    const boundary = st === null ? null : st.windowStartedAt + st.windowMs;
    assert(
      hasWatchdog() && pendingFireAt() === boundary,
      "repeat: watchdog смотрит на новую границу окна (≈ lastResetAt+2ч)",
    );
    if (st !== null) {
      assert(
        boundary !== null &&
          boundary >= st.lastResetAt + WINDOW_MS - 5_000 &&
          boundary <= st.lastResetAt + WINDOW_MS + 5_000,
        "repeat: граница ≈ lastResetAt + 2ч",
      );
    }

    await __syncWatchdogForTests();
    await __retryTickForTests();
    await sleep(200);
    assert(
      sends.length === 1,
      "repeat: попыток отправки после перевзвода нет",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    cleanupPaths(tmp);
  }
}

// --- 6. Внешняя запись в arms.json подхватывается sync'ом ----------------------

/**
 * Scenario 6: a night helper script writes an armed record directly into
 * arms.json under the CURRENT session key. One sync (what the 60 s
 * sync-poller does) must adopt the arm and arm the watchdog on the boundary.
 */
async function testExternalArmsWriteAdoptedBySync(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-wd-external-"));
  applyPaths(tmp);
  try {
    seedFreshWindow();
    const { pi, handlers } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const sessionFile = join(tmp, "sess-6.jsonl");
    const ctx = makeCtx(sessionFile);
    await handlerOf(handlers, "session_start")({}, ctx);
    await __syncWatchdogForTests();

    assert(!armsIsArmed(), "external: до записи флага нет");
    const stBefore = readStateSync();
    const boundary =
      stBefore === null ? null : stBefore.windowStartedAt + stBefore.windowMs;

    // Emulate the night script: a direct file write under the session key.
    const now = Date.now();
    const rec: Arm = {
      armedAt: now,
      lastResetAtAtArm: 0,
      expiresAt: now + ARMS_TTL_MS,
      phase: "armed",
      repeat: 1,
    };
    const map: ArmMap = { [sessionFile]: rec };
    writeFileSync(join(tmp, "arms.json"), JSON.stringify(map, null, 2), "utf8");

    // The sync-poller's single tick (hook-driven, deterministic).
    await __syncWatchdogForTests();

    assert(armsIsArmed(), "external: внешний флаг подхвачен (isArmed)");
    assert(
      hasWatchdog() &&
        pendingFireAt() === boundary &&
        boundary !== null &&
        pendingFireAt() === computeFireAt({
          windowStartedAt: stBefore?.windowStartedAt ?? 0,
          windowMs: stBefore?.windowMs ?? 0,
        }),
      "external: watchdog взведён на границу окна",
    );
    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(
      log.includes("arm-seen"),
      "external: arm-seen записан в armslog",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    cleanupPaths(tmp);
  }
}

// --- 7. session_shutdown останавливает всё -------------------------------------

/**
 * Scenario 7 (regression): session_shutdown must stop the whole machinery:
 * the watchdog is cleared (hasWatchdog false) and the already scheduled
 * grace timer is killed, so nothing is ever sent after the shutdown.
 */
async function testShutdownStopsEverything(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-wd-shutdown-"));
  applyPaths(tmp);
  setResetGraceMsForTests(200);
  try {
    seedFreshWindow();
    const { pi, handlers, commands, sends } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-7.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);
    assert(
      hasWatchdog(),
      "shutdown: watchdog взведён при armed-флаге",
    );

    await expireWindow();
    await __fireWatchdogForTests();
    await sleep(60); // reset done, the 200 ms grace is pending, no send yet

    await handlerOf(handlers, "session_shutdown")({}, ctx);

    assert(
      !hasWatchdog(),
      "shutdown: watchdog очищен (hasWatchdog false)",
    );
    assert(
      armsIsArmed(),
      "shutdown: файловый флаг переживает shutdown",
    );

    // A live grace timer would have sent by now (grace is 200 ms).
    await sleep(450);
    assert(
      sends.length === 0,
      "shutdown: после session_shutdown ничего не отправлено (grace/retry/watchdog мертвы)",
    );

    // cleanupPaths is in finally; shutdown already happened.
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    cleanupPaths(tmp);
  }
}

// --- 8. /cont-after-reset off снимает флаг и watchdog ---------------------------

/**
 * Scenario 8: "/cont-after-reset off" removes the flag; the watchdog stops
 * pointing at the arm-related moment (it is re-pointed at the plain window
 * boundary per the spec) and a later fire resets the window WITHOUT sending
 * anything.
 */
async function testContAfterResetOff(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-wd-off-"));
  applyPaths(tmp);
  setResetGraceMsForTests(40);
  try {
    seedFreshWindow();
    const { pi, handlers, commands, sends } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-8.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);
    assert(armsIsArmed(), "off: флаг взведён");

    await commandOf(commands, "cont-after-reset")("off", ctx);
    assert(
      !armsIsArmed() && armsGetArm() === null,
      "off: флаг снят и запись удалена",
    );

    const st = readStateSync();
    assert(
      pendingFireAt() ===
        (st === null ? null : st.windowStartedAt + st.windowMs),
      "off: watchdog смотрит на границу окна (не на сброс)",
    );

    // A fire after the disarm resets the window but sends NOTHING.
    await expireWindow();
    await __fireWatchdogForTests();
    await sleep(300);
    assert(
      sends.length === 0,
      "off: после снятия флага watchdog ничего не отправляет",
    );
    const st2 = readStateSync();
    assert(
      (st2?.resetCount ?? 0) > (st?.resetCount ?? 0),
      "off: окно по-прежнему сбрасывается (точный reset без флага)",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    cleanupPaths(tmp);
  }
}

// --- runner ---------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    "\n=== Watchdog e2e tests (watchdog-driven cont-after-reset) ===",
  );
  await testSettimerArmsWatchdog();
  await testWatchdogFireSendsOnce();
  await test429RetryPacing();
  await testOneShotConfirmClearsFlag();
  await testRepeatTwoRearmsWatchdog();
  await testExternalArmsWriteAdoptedBySync();
  await testShutdownStopsEverything();
  await testContAfterResetOff();

  console.log("\n========================================");
  for (const r of results) console.log(r);
  console.log("========================================");
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
