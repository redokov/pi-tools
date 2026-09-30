/**
 * lifecycle.test.mts -- regression tests for cont-after-reset vs session
 * replacement in src/index.ts (watchdog model).
 *
 * What is covered: after a session_shutdown all cont-after-reset timers
 * (watchdog, pending-retry interval, grace timer, sync-poller) must be dead,
 * so nothing ever calls sendUserMessage() on a CAPTURED (stale) pi. pi
 * invalidates captured session-bound extension objects on session
 * replacement (new/fork/switch/reload), so the send would throw:
 *   "Error: This extension ctx is stale after session replacement or reload"
 * session_start re-adopts the (file-backed) arm and restarts the machinery
 * against the fresh references.
 *
 * Timing model: real minutes are never waited. The watchdog boundary is made
 * reachable by backdating state.windowStartedAt (the boundary then lies in
 * the past and the watchdog fires immediately), the grace and stale-retry
 * intervals are shrunk via setResetGraceMsForTests() /
 * setStaleRetryMsForTests(), and resync/retry ticks are driven manually via
 * __syncWatchdogForTests() / __retryTickForTests().
 *
 * Run: .\node_modules\.bin\tsx.cmd tests/lifecycle.test.mts
 *
 * These tests drive the real extension factory (default export of src/index.ts)
 * through a mock ExtensionAPI/ExtensionContext, so the actual
 * session_start/session_shutdown wiring is exercised end-to-end.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piBillingWindowFactory, {
  setArmsLogPath,
  setStaleRetryMsForTests,
  setResetGraceMsForTests,
  __syncWatchdogForTests,
  __retryTickForTests,
  setVerifyDeliveredForTests,
  setSwitchWaitForTests,
  __resetStaleStateForTests,
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
} from "../src/arms.ts";
import {
  setPaths as historySetPaths,
  resetPaths as historyResetPaths,
} from "../src/history.ts";

// --- tiny assert harness (same style as tests/test.mts) ----------------------

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

// --- mock pi / ctx -----------------------------------------------------------

type SessionHandler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;

/**
 * Mock ExtensionAPI. Captures event/command registrations and records every
 * sendUserMessage call. With `rejectSends` it throws the exact stale-ctx
 * error pi throws for captured objects after session replacement.
 */
function makeMockPi(rejectSends = false): {
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
      if (rejectSends) {
        throw new Error(
          "This extension ctx is stale after session replacement or reload.",
        );
      }
      return undefined;
    },
  };
  return { pi, handlers, commands, sends };
}

/** Mock ExtensionContext bound to a fake session file. */
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
 * the past: the watchdog, once resynced, fires immediately, checkAndReset()
 * performs a real reset and the (shortened) grace schedules the send.
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

/**
 * Advance state.lastResetAt to a "new" window reset (spec 005): the pending
 * branch of retryTick re-sends "продолжи" only once state.lastResetAt
 * differs from the reset the last send was made for.
 */
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

/** First registered handler for an event (factory registers each once). */
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
  if (!h) throw new Error(`no handler registered for ${name}`);
  return h;
}

// --- tests --------------------------------------------------------------------

/**
 * Regression for the reported failure: arm a conversation, let the watchdog
 * reach a fireable state (boundary in the past -> reset + grace pending),
 * then shut the session down. Everything must be dead: no sendUserMessage
 * attempts on the captured (stale) pi. Pre-fix this failed: the pollers
 * survived shutdown and fired "продолжи" within seconds.
 */
async function testShutdownStopsTimers(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-lc-shutdown-"));
  applyPaths(tmp);
  setResetGraceMsForTests(150);
  try {
    seedFreshWindow();
    const { pi, handlers, commands, sends } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-a.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);
    assert(armsIsArmed(), "shutdown-stops-timers: arm is set");

    // Boundary in the past: the resync arms the watchdog at a past moment,
    // it fires immediately, checkAndReset() resets the window and the grace
    // send is scheduled 150 ms out.
    await expireWindow();
    await __syncWatchdogForTests();
    await sleep(80); // watchdog fired, checkAndReset done, grace pending

    await handlerOf(handlers, "session_shutdown")({}, ctx);

    // A live grace timer would have sent by now (grace is 150 ms).
    await sleep(400);
    assert(
      sends.length === 0,
      "shutdown-stops-timers: no sendUserMessage after session_shutdown (grace/retry/watchdog stopped)",
    );
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    cleanupPaths(tmp);
  }
}

/**
 * Replacement session lifecycle: old instance shuts down, a new instance
 * starts for the same conversation ("reload" reason keeps the same key).
 * session_start must re-adopt the file-backed arm, fire "продолжи" once with
 * the FRESH pi, consume the one-shot flag (pending) and confirm on the first
 * successful provider response.
 */
async function testReplacementRefires(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-lc-refire-"));
  applyPaths(tmp);
  setResetGraceMsForTests(50);
  try {
    seedFreshWindow();
    // Session A: arm, then it is replaced. Real pi re-runs the extension
    // factory for the replacement session with a FRESH pi -- that is what
    // refreshes piApi -- so the test must simulate exactly that (calling
    // handlers of the old factory emulates a stale pi and hits the
    // epoch-mismatch guard on purpose, see testStaleSendKeepsPollerRetries).
    const a = makeMockPi();
    piBillingWindowFactory(a.pi as never);

    const ctx = makeCtx(join(tmp, "sess-a.jsonl"));
    await handlerOf(a.handlers, "session_start")({}, ctx);
    await commandOf(a.commands, "cont-after-reset")("", ctx);
    await handlerOf(a.handlers, "session_shutdown")({}, ctx);

    // Replacement session: fresh factory invocation (fresh pi + handlers).
    const b = makeMockPi();
    piBillingWindowFactory(b.pi as never);
    await handlerOf(b.handlers, "session_start")({ reason: "reload" }, ctx);

    // Now let the boundary pass and resync: the watchdog fires, resets the
    // window, and the (shortened) grace sends with the fresh pi.
    await expireWindow();
    await __syncWatchdogForTests();
    await sleep(300); // watchdog fire + checkAndReset + grace are async

    assert(
      b.sends.length === 1 && b.sends[0]?.content === "продолжи",
      "replacement: 'продолжи' sent exactly once with the fresh pi",
    );
    assert(
      armsGetArm()?.phase === "pending",
      "replacement: flag switches to pending (not consumed) after the send",
    );
    await handlerOf(b.handlers, "after_provider_response")(
      { status: 200, headers: {} },
      ctx,
    );
    assert(
      !armsIsArmed(),
      "replacement: pending flag cleared by the first successful response",
    );

    // Stop the ticker/status timers so the test process can exit.
    await handlerOf(b.handlers, "session_shutdown")({}, ctx);
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    cleanupPaths(tmp);
  }
}

/**
 * Stale-pi resilience (the exact error from the field report): the send is
 * attempted and REJECTED with pi's stale-ctx error. The arm must survive so
 * a healthy instance can retry, and the failure must not crash anything.
 */
async function testStaleSendKeepsArm(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-lc-stale-"));
  applyPaths(tmp);
  setResetGraceMsForTests(50);
  try {
    seedFreshWindow();
    // Session A arms; on replacement the factory re-runs with a fresh pi
    // that REJECTS sends with the stale-ctx error (like pi does mid-replace).
    const a = makeMockPi();
    piBillingWindowFactory(a.pi as never);

    const ctx = makeCtx(join(tmp, "sess-a.jsonl"));
    await handlerOf(a.handlers, "session_start")({}, ctx);
    await commandOf(a.commands, "cont-after-reset")("", ctx);
    await handlerOf(a.handlers, "session_shutdown")({}, ctx);

    const b = makeMockPi(true);
    piBillingWindowFactory(b.pi as never);
    await handlerOf(b.handlers, "session_start")({ reason: "reload" }, ctx);
    await expireWindow();
    await __syncWatchdogForTests();
    await sleep(300);

    assert(b.sends.length === 1, "stale-pi: send was attempted");
    assert(
      armsIsArmed(),
      "stale-pi: arm kept after rejected send (retry on next resync)",
    );

    await handlerOf(b.handlers, "session_shutdown")({}, ctx);
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    cleanupPaths(tmp);
  }
}

/**
 * REGRESSION (production evidence 2026-09-24..25): a stale-pi send error
 * used to stop the poller "until session_start" -- which never comes in an
 * idle night session, so ONE stale error killed the whole cont-after-reset
 * mechanism for the rest of the night. Now the arm must survive and the
 * bounded retry loop keeps attempting (paced by staleRetryNotBefore with
 * exponential backoff; spec 002 D-203 stops the sync-poller from re-firing
 * the same reset, so retries are driven by the retry tick), with the
 * failure visible in the persistent arms log.
 */
async function testStaleSendKeepsPollerRetries(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-lc-stale2-"));
  applyPaths(tmp);
  setStaleRetryMsForTests(60);
  setResetGraceMsForTests(20);
  try {
    seedFreshWindow();
    // Single live process: the pi rejects sends with the stale error, but
    // no session replacement ever arrives (the night scenario).
    const { pi, handlers, commands, sends } = makeMockPi(true);
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-a.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);

    // First fire attempt (deterministic resync): rejected with the stale
    // error, but the arm and the machinery survive.
    await expireWindow();
    await __syncWatchdogForTests();
    await sleep(120);
    assert(sends.length === 1, "stale-poller: первая попытка отправки была");
    assert(
      armsIsArmed(),
      "stale-poller: флаг сохранён после stale-ошибки",
    );

    // The bounded retry loop must keep working (spec 002: the sync-poller
    // no longer re-fires the same reset; retries come from the retry
    // interval). Pacing is force-opened for determinism.
    setStaleRetryMsForTests(0);
    await __retryTickForTests();
    await sleep(120);
    setStaleRetryMsForTests(0);
    await __retryTickForTests();
    await sleep(120);
    assert(
      sends.length >= 2,
      `stale-poller: retry жив, повторные попытки идут (sends=${sends.length})`,
    );

    // The stale failure must be visible in the persistent arms log.
    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(
      log.includes("send-error:stale"),
      "stale-poller: send-error:stale записан в armslog",
    );
    assert(
      log.includes("fire:reset-ready"),
      "stale-poller: fire:reset-ready записан в armslog",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    setStaleRetryMsForTests(RETRY_AFTER_FIRE_MS);
    setResetGraceMsForTests(RESET_GRACE_MS);
    cleanupPaths(tmp);
  }
}

/**
 * 429 handling: a rate-limited response records state.last429At, appends a
 * kind="429" history row and does NOT increment callsInWindow.
 */
async function test429Recorded(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-lc-429-"));
  applyPaths(tmp);
  try {
    seedFreshWindow();
    await mutateState((cur) => {
      if (cur === null) throw new Error("state file missing");
      return { next: { ...cur, callsInWindow: 5 } };
    });
    const { pi, handlers, sends } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-a.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);

    await handlerOf(handlers, "after_provider_response")(
      { status: 429, headers: {} },
      ctx,
    );
    await sleep(300); // history append is fire-and-forget

    const st = readStateSync();
    assert(
      typeof st?.last429At === "number" && st.last429At > 0,
      "429: last429At recorded in state",
    );
    assert(st?.callsInWindow === 5, "429: callsInWindow not incremented");
    const csv = readFileSync(join(tmp, "history.csv"), "utf8");
    assert(csv.includes(",429,"), "429: history row with kind=429");
    assert(csv.includes("limit exhausted"), "429: history row has note");
    assert(sends.length === 0, "429: no continuation send");

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    cleanupPaths(tmp);
  }
}

/**
 * Backdate the pending arm's lastFireAt on disk (the arms file is the
 * persistence layer, so simulating elapsed time is a plain file edit -- the
 * same idea expireWindow() does for the window boundary).
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

/**
 * Pending phase (spec 005): a 429 arriving right after a "продолжи" attempt
 * never re-sends on elapsed time -- neither RETRY_AFTER_FIRE_MS nor the 429
 * paces the pending branch any more. Only a NEW window reset would unlock
 * the repeat; here none has happened, so the tick must stay silent.
 */
async function testPendingRetryNotBeforeRetryDelay(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-lc-soon429-"));
  applyPaths(tmp);
  setResetGraceMsForTests(20);
  try {
    seedFreshWindow();
    const { pi, handlers, commands, sends } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-a.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);
    await expireWindow();
    await __syncWatchdogForTests(); // deterministic watchdog fire
    await sleep(300);
    assert(sends.length === 1, "soon-429: first 'продолжи' sent");
    assert(
      armsGetArm()?.phase === "pending",
      "soon-429: flag is pending after the send",
    );

    // A fresh 429 right after the attempt: retryAfter moves to "now".
    await handlerOf(handlers, "after_provider_response")(
      { status: 429, headers: {} },
      ctx,
    );

    // 11 minutes since the send, the 429 still fresh, and NO new window
    // reset -> no retry (spec 005: elapsed time / 429 are not the trigger).
    backdateLastFireAt(tmp, RETRY_AFTER_FIRE_MS + 60_000);
    await __syncWatchdogForTests(); // pending branch -> retry interval
    await __retryTickForTests();
    await sleep(300);
    assert(
      sends.length === 1,
      "soon-429: no retry without a new window reset (elapsed time / fresh 429 are not the trigger)",
    );

    // Even a NEW window reset re-sends (the 429 does not hold it back):
    // spec 005 dropped last429At from the pending pacing entirely.
    await advanceResetAt(30_000);
    await __retryTickForTests();
    await sleep(300);
    assert(
      sends.length === 2,
      "soon-429: new window reset re-sends despite the fresh 429 (one repeat)",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    cleanupPaths(tmp);
  }
}

/**
 * Pending phase (spec 005): a re-send happens only once a NEW window reset
 * arrives (state.lastResetAt advanced past the reset the last "продолжи"
 * was made for). The retry tick then sends exactly one more "продолжи"
 * (lastFireAt refreshed); the first successful response confirms and
 * clears the pending flag.
 */
async function testPendingRetryAndConfirm(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-lc-pending-"));
  applyPaths(tmp);
  setResetGraceMsForTests(20);
  try {
    seedFreshWindow();
    const { pi, handlers, commands, sends } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-a.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);
    await expireWindow();
    await __syncWatchdogForTests(); // deterministic watchdog fire
    await sleep(300);
    assert(sends.length === 1, "pending-retry: first 'продолжи' sent");
    assert(
      armsGetArm()?.phase === "pending",
      "pending-retry: flag is pending after the send",
    );

    // A 429 arrives, then 11 minutes pass since BOTH the send and the 429.
    // Spec 005: elapsed time alone must NOT unlock a re-send -- the next
    // "продолжи" awaits a NEW window reset.
    await handlerOf(handlers, "after_provider_response")(
      { status: 429, headers: {} },
      ctx,
    );
    backdateLastFireAt(tmp, RETRY_AFTER_FIRE_MS + 60_000);
    await mutateState((cur) => {
      if (cur === null) throw new Error("state file missing");
      return {
        next: { ...cur, last429At: Date.now() - (RETRY_AFTER_FIRE_MS + 60_000) },
      };
    });

    // Pending tick after elapsed time, still no new reset -> silence.
    await __syncWatchdogForTests(); // pending branch -> retry interval
    await __retryTickForTests();
    await sleep(300);
    assert(
      sends.length === 1,
      "pending-retry: no retry on elapsed time alone (needs a new window reset)",
    );

    // A NEW window reset arrives: the retry tick re-sends exactly once.
    await advanceResetAt(30_000);
    await __retryTickForTests();
    await sleep(300);
    assert(
      sends.length === 2,
      "pending-retry: second 'продолжи' sent after a new window reset",
    );
    const arm = armsGetArm();
    assert(
      arm?.phase === "pending" &&
        typeof arm.lastFireAt === "number" &&
        arm.lastFireAt > Date.now() - 5_000,
      "pending-retry: lastFireAt refreshed by the retry",
    );

    // First successful provider response confirms and clears the flag.
    await handlerOf(handlers, "after_provider_response")(
      { status: 200, headers: {} },
      ctx,
    );
    assert(
      !armsIsArmed(),
      "pending-retry: first success confirms and removes the pending flag",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    cleanupPaths(tmp);
  }
}

// --- /cont-after-reset argument parsing ---------------------------------------

/**
 * Parsing of the /cont-after-reset argument into the arms file: no argument
 * arms a classic one-shot (repeat=1), a 1..99 integer arms that many total
 * repetitions, "off"/"0"/"нет"/"выкл" disarm, and any other string keeps the
 * backward-compatible one-shot fallback.
 */
async function testContAfterResetArgParsing(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-lc-parse-"));
  applyPaths(tmp);
  try {
    seedFreshWindow();
    const { pi, handlers, commands } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-parse.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    const cmd = commandOf(commands, "cont-after-reset");

    await cmd("", ctx);
    assert(armsGetArm()?.repeat === 1, "parse: no argument -> repeat=1");
    assert(armsIsArmed(), "parse: no argument arms the flag");

    await cmd("5", ctx);
    assert(
      armsGetArm()?.repeat === 5,
      "parse: '5' -> repeat=5 (re-arms an existing flag)",
    );

    await cmd("off", ctx);
    assert(!armsIsArmed(), "parse: 'off' disarms");
    assert(armsGetArm() === null, "parse: record removed by 'off'");

    await cmd("0", ctx);
    assert(!armsIsArmed(), "parse: '0' disarms (existing synonym)");

    // Non-numeric / out-of-range args keep the old one-shot fallback.
    await cmd("abc", ctx);
    assert(
      armsGetArm()?.repeat === 1,
      "parse: 'abc' falls back to repeat=1 (backward compatible)",
    );
    await cmd("100", ctx);
    assert(
      armsGetArm()?.repeat === 1,
      "parse: out-of-range '100' falls back to repeat=1",
    );

    await cmd("нет", ctx);
    assert(!armsIsArmed(), "parse: 'нет' disarms");

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    cleanupPaths(tmp);
  }
}

/**
 * End-to-end repeat mode: arm with repeat=3, let a reset fire, confirm the
 * first success -- the flag must be re-armed (repeat=2, phase=armed, fresh
 * lastResetAtAtArm) rather than consumed -- and fire again on the NEXT reset.
 */
async function testRepeatRearmAcrossResets(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-lc-repeat-"));
  applyPaths(tmp);
  setResetGraceMsForTests(20);
  try {
    seedFreshWindow();
    const { pi, handlers, commands, sends } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-repeat.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    const cmd = commandOf(commands, "cont-after-reset");

    await cmd("3", ctx);
    assert(armsGetArm()?.repeat === 3, "repeat-e2e: armed with repeat=3");

    // First window reset -> first "продолжи".
    await expireWindow();
    await __syncWatchdogForTests();
    await sleep(300);
    assert(sends.length === 1, "repeat-e2e: first 'продолжи' sent");
    assert(armsGetArm()?.phase === "pending", "repeat-e2e: pending after send");

    const markerAtConfirm = readStateSync()?.lastResetAt ?? -1;
    await handlerOf(handlers, "after_provider_response")(
      { status: 200, headers: {} },
      ctx,
    );
    const re = armsGetArm();
    assert(
      re?.repeat === 2 && re?.phase === "armed",
      "repeat-e2e: re-armed to repeat=2 after the first success",
    );
    assert(
      re?.lastResetAtAtArm === markerAtConfirm,
      "repeat-e2e: re-arm marker = current state.lastResetAt",
    );
    assert(
      re?.lastFireAt === undefined,
      "repeat-e2e: lastFireAt cleared on re-arm",
    );

    // Second window reset -> fires again (the nightly-repeat fix).
    await expireWindow();
    await __syncWatchdogForTests();
    await sleep(300);
    assert(
      sends.length === 2,
      "repeat-e2e: second 'продолжи' fired on the next reset",
    );
    assert(armsGetArm()?.phase === "pending", "repeat-e2e: pending again");
    assert(
      armsGetArm()?.repeat === 2,
      "repeat-e2e: repeat unchanged until the next confirmation",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    cleanupPaths(tmp);
  }
}

/**
 * Spec 009 (T3, F2/F3): полный цикл fire -> confirmed через switchSession-путь
 * + pendingFiredResetAt (max 1 повторный send на reset).
 *
 * Владелец армится командой (командный ctx несёт switchSession), чужая
 * (дочерняя) сессия стартует и блокируется (owner-ctx жив, repoint-причина),
 * lastSessionStartKey = child-файл. После сброса окна refs указывают на
 * другую сессию -> fire:switch-needed -> trySwitchToOwner(ownerKey) через
 * командный ctx -> session_start владельца перезапускается синхронно
 * (полный старт, не blocked) -> piApi живой той же эпохи -> «продолжи»
 * уходит в разговор владельца (fire:send-ok), флаг в pending. Первый
 * успешный wormsoft-ответ подтверждает флаг; повторный retryTick на ТОМ ЖЕ
 * reset дубля не даёт (pendingFiredResetAt).
 */
async function testFullCycleViaSwitchPath(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-lc-switch-"));
  applyPaths(tmp);
  setResetGraceMsForTests(50);
  try {
    setSwitchWaitForTests(0, 0);
    __resetStaleStateForTests();
    seedFreshWindow();
    const a = makeMockPi();
    piBillingWindowFactory(a.pi as never);

    const ownerFile = join(tmp, "L_owner.jsonl");
    const childFile = join(tmp, "L_child.jsonl");

    // Owner ctx: свежий командный ctx несёт switchSession (spec 009 T2).
    // switchSession маршрутизируется через командный ctx: поднимает
    // session_start владельца СИНХРОННО ДО своего завершения (incoming ===
    // ownerKey -> НЕ blocked, полный старт) и возвращает { cancelled: false }.
    const baseOwner = makeCtx(ownerFile) as Record<string, unknown>;
    const ownerCtx: Record<string, unknown> = {
      ...baseOwner,
      switchSession: async (path: string) => {
        switchCalls.push(path);
        await handlerOf(a.handlers, "session_start")({}, ownerCtx); // полный старт владельца
        return { cancelled: false };
      },
    };
    const switchCalls: string[] = [];

    // Owner session_start: полный старт, ownerKey = ownerFile.
    await handlerOf(a.handlers, "session_start")({}, ownerCtx);
    // /cont-after-reset: обёртка фабрики захватывает командный ctx (несёт
    // switchSession) на каждый вызов — он и используется switch-путём.
    await commandOf(a.commands, "cont-after-reset")("", ownerCtx);
    assert(armsIsArmed(), "switch-path: флаг взведён командой");

    // Child (foreign) session_start: owner-ctx жив, repoint-причина ->
    // ownerBlocked -> lastSessionStartKey = child-файл (ставится ДО гейта).
    const childCtx = makeCtx(childFile);
    await handlerOf(a.handlers, "session_start")({ reason: "startup" }, childCtx);

    // Граница окна в прошлом: watchdog срабатывает, checkAndReset делает
    // реальный reset, (сокращённый) grace планирует fire. Refs указывают на
    // другую сессию (lastSessionStartKey = childFile != ownerKey) ->
    // fire:switch-needed -> trySwitchToOwner(ownerFile) -> switchSession ->
    // session_start re-run (lastSessionStartKey = ownerFile) -> piApi жив
    // (piApiEpoch === sessionEpoch, shutdown'ов не было) -> send «продолжи»
    // -> fire:send-ok, pendingFiredResetAt = lastResetAt.
    await expireWindow();
    await __syncWatchdogForTests();
    await sleep(400); // watchdog fire + checkAndReset + grace + switch + send

    assert(
      a.sends.filter((s) => s.content === "продолжи").length === 1,
      "switch-path: 'продолжи' отправлен ровно один раз через switchSession-путь",
    );
    assert(
      switchCalls.length === 1 && switchCalls[0] === ownerFile,
      "switch-path: switchSession вызван один раз с ключом владельца",
    );
    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(
      log.includes("fire:switch-needed"),
      "switch-path: fire:switch-needed записан в armslog",
    );
    assert(
      log.includes("fire:send-ok"),
      "switch-path: fire:send-ok записан в armslog",
    );
    assert(
      !log.includes("send-error:stale"),
      "switch-path: send-error:stale ОТСУТСТВУЕТ (доставка без stale-ошибок)",
    );

    // Confirm: успешный wormsoft-ответ В разговоре владельца подтверждает
    // pending-флаг (первый успех снимает/съедает его).
    await handlerOf(a.handlers, "after_provider_response")(
      { status: 200, headers: {} },
      ownerCtx,
    );
    await sleep(200);
    assert(
      !armsIsArmed(),
      "switch-path: первый успех подтвердил и снял pending-флаг",
    );

    // pendingFiredResetAt (max 1 повторный send на reset): retryTick на ТОМ
    // ЖЕ reset (pendingFiredResetAt === st.lastResetAt) повторного send НЕ
    // даёт — дубля нет.
    await __retryTickForTests();
    await sleep(300);
    assert(
      a.sends.filter((s) => s.content === "продолжи").length === 1,
      "switch-path: дубля нет на том же reset (pendingFiredResetAt)",
    );

    // Stop the timers so the test process can exit.
    await handlerOf(a.handlers, "session_shutdown")({}, ownerCtx);
  } finally {
    setSwitchWaitForTests(150, 2);
    setResetGraceMsForTests(RESET_GRACE_MS);
    cleanupPaths(tmp);
  }
}

// --- runner -------------------------------------------------------------------

async function main(): Promise<void> {
  // Spec 007: unit-test mocks do not write session-file entries -- stub
  // the D1 delivery verification to always-true (the new delivery-gating
  // tests drive the real verification with a faithful mock).
  setVerifyDeliveredForTests(() => true);
  console.log("\n=== Lifecycle tests (session replacement / cont-after-reset) ===");
  await testShutdownStopsTimers();
  await testReplacementRefires();
  await testStaleSendKeepsArm();
  await testStaleSendKeepsPollerRetries();
  await test429Recorded();
  await testPendingRetryNotBeforeRetryDelay();
  await testPendingRetryAndConfirm();
  await testContAfterResetArgParsing();
  await testRepeatRearmAcrossResets();
  await testFullCycleViaSwitchPath();

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
