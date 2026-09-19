/**
 * lifecycle.test.mts -- regression tests for the session-replacement fix in
 * src/index.ts (cont-after-reset vs stale extension ctx).
 *
 * Bug being covered: the cont-after-reset poller (armedPollTimer) and the
 * boundary timer survived session_shutdown and later called
 * piApi.sendUserMessage() on a CAPTURED pi. pi invalidates captured
 * session-bound extension objects on session replacement
 * (new/fork/switch/reload), so the send threw:
 *   "Error: This extension ctx is stale after session replacement or reload"
 * The fix stops the pollers in session_shutdown; session_start re-adopts the
 * (file-backed) arm and restarts the poller against the fresh references.
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

import piBillingWindowFactory from "../src/index.ts";
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
          if (i >= 0) arr.splice(i, 1);
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

/** Simulate a billing-window reset `minAgo` minutes ago (past the 1 min grace). */
async function bumpReset(minAgo: number): Promise<void> {
  const now = Date.now();
  await mutateState((cur) => {
    if (cur === null) throw new Error("state file missing");
    return {
      next: { ...cur, lastResetAt: now - minAgo * 60_000, windowStartedAt: now },
    };
  });
}

function applyPaths(tmp: string): void {
  stateSetPaths(join(tmp, "state.json"), join(tmp, "state.lock"));
  armsSetPaths(join(tmp, "arms.json"), join(tmp, "arms.lock"));
  historySetPaths(join(tmp, "history.csv"), join(tmp, "history.lock"));
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
  if (!h) throw new Error(`no command registered for ${name}`);
  return h;
}

// --- tests --------------------------------------------------------------------

/**
 * Stale-pi resilience (the exact error from the field report): the send is
 * attempted and REJECTED with pi's stale-ctx error. The arm must survive so
 * a healthy instance can retry, and the failure must not crash the poller.
 */

/**
 * Regression for the reported failure: arm a conversation, let a reset
 * happen, replace the session (shutdown without a new session_start -- the
 * old extension instance is gone). The poller must be dead: no
 * sendUserMessage attempts on the captured (stale) pi.
 *
 * Pre-fix this failed: the poller survived shutdown and fired "продолжи"
 * within ARMED_POLL_MS (10 s).
 */
async function testShutdownStopsPoller(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-lc-shutdown-"));
  applyPaths(tmp);
  try {
    seedFreshWindow();
    const { pi, handlers, commands, sends } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-a.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);
    assert(armsIsArmed(), "shutdown-stops-poller: arm is set");

    await bumpReset(2); // reset happened 2 min ago -> past 1 min grace
    await handlerOf(handlers, "session_shutdown")({}, ctx);

    // One full poll interval (10 s) plus slack: a live poller would have
    // attempted the send by now.
    await sleep(11_500);
    assert(
      sends.length === 0,
      "shutdown-stops-poller: no sendUserMessage after session_shutdown (stale-pi bug)",
    );
  } finally {
    cleanupPaths(tmp);
  }
}

/**
 * Replacement session lifecycle: old instance shuts down, a new instance
 * starts for the same conversation ("reload" reason keeps the same key).
 * session_start must re-adopt the file-backed arm, fire "продолжи" once with
 * the FRESH pi, consume the one-shot flag and stop the poller.
 */
async function testReplacementRefires(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-lc-refire-"));
  applyPaths(tmp);
  try {
    seedFreshWindow();
    const { pi, handlers, commands, sends } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-a.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);
    await bumpReset(2);
    await handlerOf(handlers, "session_shutdown")({}, ctx);

    // New extension instance for the replacement session.
    await handlerOf(handlers, "session_start")({ reason: "reload" }, ctx);
    await sleep(300); // fire is async (lock file I/O for disarm)

    assert(
      sends.length === 1 && sends[0]!.content === "продолжи",
      "replacement: 'продолжи' sent exactly once with the fresh pi",
    );
    assert(
      armsGetArm()?.phase === "pending",
      "replacement: flag switches to pending (not consumed) after the send",
    );
    await handlerOf(handlers, "after_provider_response")(
      { status: 200, headers: {} },
      ctx,
    );
    assert(
      !armsIsArmed(),
      "replacement: pending flag cleared by the first successful response",
    );

    // Stop the ticker/status timers so the test process can exit.
    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    cleanupPaths(tmp);
  }
}

async function testStaleSendKeepsArm(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-lc-stale-"));
  applyPaths(tmp);
  try {
    seedFreshWindow();
    const { pi, handlers, commands, sends } = makeMockPi(true);
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-a.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);
    await bumpReset(2);
    await handlerOf(handlers, "session_shutdown")({}, ctx);

    await handlerOf(handlers, "session_start")({ reason: "reload" }, ctx);
    await sleep(300);

    assert(sends.length === 1, "stale-pi: send was attempted");
    assert(
      armsIsArmed(),
      "stale-pi: arm kept after rejected send (retry on next poll)",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
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
 * persistence layer, so simulating elapsed time is a plain file edit --
 * same idea as bumpReset() does for state).
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
  try {
    seedFreshWindow();
    const { pi, handlers, commands, sends } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-a.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);
    await bumpReset(2);
    await commandOf(commands, "cont-after-reset")("", ctx); // immediate fire
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
    await commandOf(commands, "cont-after-reset")("", ctx); // re-evaluate
    await sleep(300);
    assert(
      sends.length === 1,
      "soon-429: no retry before RETRY_AFTER_FIRE_MS after a fresh 429",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    cleanupPaths(tmp);
  }
}

/**
 * Pending phase: once RETRY_AFTER_FIRE_MS have passed since the last
 * attempt/429, the poller retries the send; the first successful response
 * then confirms and clears the pending flag.
 */
async function testPendingRetryAndConfirm(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-lc-pending-"));
  applyPaths(tmp);
  try {
    seedFreshWindow();
    const { pi, handlers, commands, sends } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-a.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);
    await bumpReset(2);
    await commandOf(commands, "cont-after-reset")("", ctx); // immediate fire
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

    // Re-entering the command re-evaluates the pending arm -> retry fire.
    await commandOf(commands, "cont-after-reset")("", ctx);
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
    await bumpReset(2);
    await cmd("", ctx);
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
    await bumpReset(2);
    await cmd("", ctx);
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
    cleanupPaths(tmp);
  }
}

// --- runner -------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n=== Lifecycle tests (session replacement / cont-after-reset) ===");
  await testShutdownStopsPoller();
  await testReplacementRefires();
  await testStaleSendKeepsArm();
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