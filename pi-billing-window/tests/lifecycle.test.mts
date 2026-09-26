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
 * mechanism for the rest of the night. Now the arm must survive and further
 * resyncs keep attempting (paced by staleRetryNotBefore), with the failure
 * visible in the persistent arms log.
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

    // The resync path must keep working: with retry pacing of 60 ms further
    // attempts follow while the boundary stays in the past.
    await sleep(120);
    await __syncWatchdogForTests();
    await sleep(120);
    await __syncWatchdogForTests();
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
 * Pending phase: a 429 arriving right after a "продолжи" attempt blocks the
 * retry until RETRY_AFTER_FIRE_MS have passed since that 429/attempt.
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

    // 11 minutes since the send, but the 429 is fresh -> NO retry yet.
    backdateLastFireAt(tmp, RETRY_AFTER_FIRE_MS + 60_000);
    await __syncWatchdogForTests(); // pending branch -> retry interval
    await __retryTickForTests();
    await sleep(300);
    assert(
      sends.length === 1,
      "soon-429: no retry before RETRY_AFTER_FIRE_MS after a fresh 429",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    cleanupPaths(tmp);
  }
}

/**
 * Pending phase: once RETRY_AFTER_FIRE_MS have passed since the last
 * attempt/429, the retry tick re-sends; the first successful response
 * then confirms and clears the pending flag.
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

    // The pending-retry tick re-sends "продолжи".
    await __syncWatchdogForTests(); // pending branch -> retry interval
    await __retryTickForTests();
    await sleep(300);
    assert(
      sends.length === 2,
      "pending-retry: second 'продолжи' sent after RETRY_AFTER_FIRE_MS",
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

// --- runner -------------------------------------------------------------------

async function main(): Promise<void> {
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
