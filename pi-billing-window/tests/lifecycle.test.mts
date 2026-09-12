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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piBillingWindowFactory from "../src/index.ts";
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
    model: { provider: "wormsoft" },
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
      !armsIsArmed(),
      "replacement: one-shot arm consumed after successful send",
    );

    // Stop the ticker/status timers so the test process can exit.
    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    cleanupPaths(tmp);
  }
}

/**
 * Stale-pi resilience (the exact error from the field report): the send is
 * attempted and REJECTED with pi's stale-ctx error. The arm must survive so
 * a healthy instance can retry, and the failure must not crash the poller.
 */
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

// --- runner -------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n=== Lifecycle tests (session replacement / cont-after-reset) ===");
  await testShutdownStopsPoller();
  await testReplacementRefires();
  await testStaleSendKeepsArm();

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