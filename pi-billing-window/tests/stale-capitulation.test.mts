/**
 * stale-capitulation.test.mts -- spec 002, инварианты 4 и 5
 * (FR-003/FR-004/FR-005): bounded stale-retry (N=6, exponential backoff)
 * and the capitulation notification through notifier.ts.
 *
 * Run: npx tsx tests/stale-capitulation.test.mts
 *
 * Determinism: no real minutes are waited. Attempts are driven by
 * __fireWatchdogForTests()/__retryTickForTests(); the stale pacing is
 * force-opened via setStaleRetryMsForTests(0) (which resets
 * staleRetryNotBefore); the backoff intervals are read back through
 * __staleRetryNotBeforeForTests().
 */

import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piBillingWindowFactory, {
  setArmsLogPath,
  setStaleRetryMsForTests,
  __fireWatchdogForTests,
  __retryTickForTests,
  __resetStaleStateForTests,
  __staleRetryNotBeforeForTests,
  setVerifyDeliveredForTests,
} from "../src/index.ts";
import {
  mutateState,
  writeStateSync,
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

// --- tiny assert harness ------------------------------------------------------

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

// --- mock pi / ctx --------------------------------------------------------------

type SessionHandler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;

/**
 * Mock ExtensionAPI whose sendUserMessage rejects with pi's exact
 * stale-ctx error. `reject` is switchable at runtime so a scenario can
 * interleave failed and successful attempts.
 */
function makeMockPi(): {
  pi: unknown;
  handlers: Map<string, SessionHandler[]>;
  commands: Map<string, CommandHandler>;
  sends: Array<{ content: unknown; opts: unknown }>;
  reject: { enabled: boolean };
} {
  const handlers = new Map<string, SessionHandler[]>();
  const commands = new Map<string, CommandHandler>();
  const sends: Array<{ content: unknown; opts: unknown }> = [];
  const reject = { enabled: true };
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
      if (reject.enabled) {
        throw new Error(
          "This extension ctx is stale after session replacement or reload.",
        );
      }
      return undefined;
    },
  };
  return { pi, handlers, commands, sends, reject };
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

// --- state seeding ---------------------------------------------------------------

const WINDOW_MS = 2 * 60 * 60 * 1000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;

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

/** Seed a fresh window, arm the flag, then backdate a fireable reset R. */
async function seedArmedWithPastReset(
  commands: Map<string, CommandHandler>,
  handlers: Map<string, SessionHandler[]>,
  ctx: unknown,
): Promise<void> {
  writeStateSync({
    provider: "wormsoft",
    windowStartedAt: Date.now(),
    windowMs: WINDOW_MS,
    lastResetAt: 0,
    resetCount: 1,
    callsInWindow: 0,
  });
  await handlerOf(handlers, "session_start")({}, ctx);
  await commandOf(commands, "cont-after-reset")("", ctx);
  await mutateState((cur) => {
    if (cur === null) throw new Error("state file missing");
    return { next: { ...cur, lastResetAt: Date.now() - 60_000 } };
  });
}

/** Backdate the pending arm's lastFireAt on disk (pacing is file-backed). */
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
 * Advance state.lastResetAt to a "new" window reset (spec 005): the pending
 * branch of retryTick re-attempts only once state.lastResetAt differs from
 * the reset the previous "продолжи" was made for. A distinct value per call
 * lets each stale attempt in a loop pass the pending gate exactly once.
 */
async function advanceResetAt(msAgo: number): Promise<void> {
  await mutateState((cur) => {
    if (cur === null) throw new Error("state file missing");
    return { next: { ...cur, lastResetAt: Date.now() - msAgo } };
  });
}

/** Expected backoff: MIN(RETRY_AFTER_FIRE_MS * 2^(n-1), 60 min). */
function expectedBackoff(attempt: number): number {
  return Math.min(
    RETRY_AFTER_FIRE_MS * Math.pow(2, attempt - 1),
    BACKOFF_CAP_MS,
  );
}

// --- 1. Счётчик N=6 + экспоненциальный backoff + disarm -----------------------

async function testBoundedRetryAndDisarm(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-stale-"));
  applyPaths(tmp);
  __resetStaleStateForTests();
  setStaleRetryMsForTests(0);
  try {
    const { pi, handlers, commands, sends } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-1.jsonl"));
    await seedArmedWithPastReset(commands, handlers, ctx);
    assert(armsIsArmed(), "cap: флаг взведён");

    // Attempt 1 (watchdog fire): stale, counter=1.
    await __fireWatchdogForTests();
    await sleep(150);
    const t1 = Date.now();
    assert(sends.length === 1, "cap: первая попытка отправки была");
    let pacing = __staleRetryNotBeforeForTests();
    let interval = pacing - t1;
    let expected = expectedBackoff(1);
    assert(
      Math.abs(interval - expected) < 2_000,
      `cap: backoff(1) ≈ RETRY_AFTER_FIRE_MS (получено ${Math.round(interval / 1000)} с, ожидается ${Math.round(expected / 1000)} с)`,
    );

    // Attempts 2..5: intervals must grow exponentially with every attempt.
    let prevInterval = interval;
    for (let n = 2; n <= 5; n++) {
      setStaleRetryMsForTests(0); // force pacing open (deterministic)
      await __retryTickForTests();
      await sleep(100);
      const before = Date.now();
      assert(
        sends.length === n,
        `cap: попытка ${n} после retry-tick (sends=${sends.length})`,
      );
      pacing = __staleRetryNotBeforeForTests();
      interval = pacing - before;
      expected = expectedBackoff(n);
      assert(
        Math.abs(interval - expected) < 2_000,
        `cap: backoff(${n}) ≈ RETRY_AFTER_FIRE_MS*2^${n - 1} (получено ${Math.round(interval / 1000)} с, ожидается ${Math.round(expected / 1000)} с)`,
      );
      assert(
        interval > prevInterval,
        `cap: интервалы backoff возрастают (n=${n})`,
      );
      prevInterval = interval;
    }

    // Attempt 6: capitulation -- the flag is disarmed and logged.
    setStaleRetryMsForTests(0);
    await __retryTickForTests();
    await sleep(150);
    assert(
      sends.length === 6,
      `cap: ровно 6 попыток (sends=${sends.length})`,
    );
    assert(!armsIsArmed(), "cap: флаг снят после 6-й попытки");
    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(
      log.includes("capitulation:after-6"),
      "cap: armslog содержит capitulation:after-6",
    );
    for (let n = 1; n <= 6; n++) {
      assert(
        log.includes(`попытка ${n}/6`),
        `cap: лог содержит счётчик попытки ${n}/6`,
      );
    }

    // No 7th attempt: the arm is gone, the loop is over.
    setStaleRetryMsForTests(0);
    await __retryTickForTests();
    await sleep(100);
    assert(
      sends.length === 6,
      "cap: после капитуляции новых попыток нет (не вечный цикл)",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    __resetStaleStateForTests();
    cleanupPaths(tmp);
  }
}

// --- 2. Notify при капитуляции через notifier.ts (FR-004) ---------------------

async function testCapitulationNotify(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-capnotify-"));
  applyPaths(tmp);
  __resetStaleStateForTests();
  setStaleRetryMsForTests(0);
  const originalFetch = globalThis.fetch;
  const fetched: Array<{ url: string; body: unknown; headers: unknown }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    fetched.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: init?.headers,
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const { pi, handlers, commands, sends } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-2.jsonl"));
    await seedArmedWithPastReset(commands, handlers, ctx);

    await __fireWatchdogForTests(); // attempt 1
    await sleep(100);
    for (let n = 2; n <= 6; n++) {
      setStaleRetryMsForTests(0);
      await __retryTickForTests();
      await sleep(80);
    }
    assert(sends.length === 6, "notify: 6 попыток до капитуляции");

    // sendNotify is fire-and-forget: give the fetch a moment to land.
    await sleep(400);

    const notify = fetched.find((f) =>
      f.body !== null &&
      (f.body as { type?: string }).type ===
        "billing:cont-after-reset-capitulation",
    );
    assert(notify !== undefined, "notify: sendNotify вызван при капитуляции");
    if (notify !== undefined) {
      const body = notify.body as {
        provider: string;
        title: string;
        body: string;
      };
      assert(
        body.provider === "wormsoft",
        "notify: provider=wormsoft",
      );
      assert(
        body.title.includes("cont-after-reset") ||
          body.title.toLowerCase().includes("капитул"),
        "notify: title отражает капитуляцию cont-after-reset",
      );
      assert(
        body.body.includes("продолжи") ||
          body.body.toLowerCase().includes("не"),
        "notify: body сообщает о недоставке «продолжи»",
      );
    }
    assert(
      !armsIsArmed(),
      "notify: флаг уже disarm до/при отправке уведомления",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    globalThis.fetch = originalFetch;
    __resetStaleStateForTests();
    cleanupPaths(tmp);
  }
}

// --- 3. Успешная отправка сбрасывает счётчик (нет ложной капитуляции) --------

async function testSuccessResetsCounter(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-reset-"));
  applyPaths(tmp);
  __resetStaleStateForTests();
  setStaleRetryMsForTests(0);
  try {
    const { pi, handlers, commands, sends, reject } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const ctx = makeCtx(join(tmp, "sess-3.jsonl"));
    await seedArmedWithPastReset(commands, handlers, ctx);

    // Attempts 1..2 fail stale.
    await __fireWatchdogForTests();
    await sleep(100);
    setStaleRetryMsForTests(0);
    await __retryTickForTests();
    await sleep(100);
    assert(sends.length === 2, "reset: 2 stale-попытки до успеха");

    // Attempt 3 succeeds: the arm goes pending, the counter resets.
    reject.enabled = false;
    setStaleRetryMsForTests(0);
    await __retryTickForTests();
    await sleep(100);
    assert(sends.length === 3, "reset: успешная попытка после двух stale");
    assert(
      armsGetArm()?.phase === "pending",
      "reset: флаг в pending (не капитуляция)",
    );
    let log = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(
      !log.includes("capitulation"),
      "reset: после успешной отправки капитуляции нет",
    );

    // Go stale again: a full NEW set of 6 failures is needed before the
    // capitulation fires (the counter was reset by the success above).
    // Spec 005: the pending branch needs a NEW window reset per attempt to
    // pass the gate (elapsed time via lastFireAt no longer unlocks it), so
    // each loop step advances state.lastResetAt before the tick.
    reject.enabled = true;
    let attempts = 3;
    for (let n = 1; n <= 5; n++) {
      await advanceResetAt(30_000 + n * 1_000);
      setStaleRetryMsForTests(0);
      await __retryTickForTests();
      await sleep(80);
      attempts++;
      assert(
        sends.length === attempts,
        `reset: попытка ${n} после сброса счётчика прошла (sends=${sends.length})`,
      );
    }
    log = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(
      !log.includes("capitulation"),
      "reset: 5 stale-попыток после сброса — ещё не капитуляция",
    );
    assert(armsIsArmed(), "reset: флаг всё ещё взведён (5/6 после сброса)");

    // The 6th stale failure after the reset capitulates (fresh reset too).
    await advanceResetAt(20_000);
    setStaleRetryMsForTests(0);
    await __retryTickForTests();
    await sleep(150);
    assert(!armsIsArmed(), "reset: капитуляция на 6-й stale после сброса");
    log = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(
      log.includes("capitulation:after-6"),
      "reset: armslog фиксирует капитуляцию после полного цикла",
    );

    await handlerOf(handlers, "session_shutdown")({}, ctx);
  } finally {
    __resetStaleStateForTests();
    cleanupPaths(tmp);
  }
}

// --- runner ----------------------------------------------------------------------

async function main(): Promise<void> {
  // Spec 007: unit-test mocks do not write session-file entries -- stub
  // the D1 delivery verification to always-true (the new delivery-gating
  // tests drive the real verification with a faithful mock).
  setVerifyDeliveredForTests(() => true);
  console.log(
    "\n=== Stale capitulation tests (spec 002: bounded retry + notify) ===",
  );
  await testBoundedRetryAndDisarm();
  await testCapitulationNotify();
  await testSuccessResetsCounter();

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
