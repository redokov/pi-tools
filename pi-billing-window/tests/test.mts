/**
 * test.mts -- unit tests for pi-billing-window (state + ticker).
 *
 * Run: .\node_modules\.bin\tsx.cmd test.mts
 */

import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readStateSync,
  writeStateSync,
  withLock,
  mutateState,
  setPaths,
  resetPaths,
  type State,
} from "../src/state.ts";
import {
  checkAndReset,
  TICK_MS,
  ABOUT_TO_RESET_MS,
  DEDUP_WINDOW_MS,
  type EmitFn,
} from "../src/ticker.ts";
import {
  renderStatusBar,
  startStatusUpdater,
  stopStatusUpdater,
  forceUpdate,
} from "../src/ui.ts";
import {
  parseDuration,
  formatDuration,
  type ParsedDuration,
} from "../src/parser.ts";
import { sendNotify, type NotifyPayload } from "../src/notifier.ts";

// Mock emit: collects every (event, payload) call.
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

// ---- fetch mock for notifier tests ----
//
// We replace globalThis.fetch so sendNotify() can be exercised without a
// real HTTP server. The mock records every (url, init) pair and either
// resolves a configured Response or throws a configured Error.
type FetchCall = { url: string; init?: RequestInit };
let originalFetch: typeof fetch | null = null;
let mockFetchCalls: FetchCall[] = [];
let mockFetchResponse: Response | null = null;
let mockFetchError: Error | null = null;
let mockFetchDelayMs = 0;

function installMock(): void {
  if (originalFetch === null) {
    originalFetch = globalThis.fetch;
  }
  mockFetchCalls = [];
  mockFetchResponse = null;
  mockFetchError = null;
  mockFetchDelayMs = 0;
  globalThis.fetch = mockFetchImpl as typeof fetch;
}

function restoreMock(): void {
  if (originalFetch !== null) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
  mockFetchCalls = [];
  mockFetchResponse = null;
  mockFetchError = null;
  mockFetchDelayMs = 0;
}

async function mockFetchImpl(
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const u = typeof url === "string" ? url : url.toString();
  mockFetchCalls.push({ url: u, init });
  const signal: AbortSignal | undefined = init?.signal ?? undefined;
  if (mockFetchDelayMs > 0) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, mockFetchDelayMs);
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (signal.aborted) {
          clearTimeout(timer);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
  if (mockFetchError !== null) {
    throw mockFetchError;
  }
  if (mockFetchResponse !== null) {
    return mockFetchResponse;
  }
  return new Response("{}", { status: 500 });
}

// Use a temp directory so we don't touch the user's real state
const tmpDir = mkdtempSync(join(tmpdir(), "pbw-test-"));
const testStateFile = join(tmpDir, "state.json");
const testLockFile = join(tmpDir, "state.lock");

setPaths(testStateFile, testLockFile);

let passed = 0;
let failed = 0;
const results: string[] = [];

function assert(cond: boolean, name: string): void {
  if (cond) {
    passed++;
    results.push(`PASS  ${name}`);
  } else {
    failed++;
    results.push(`FAIL  ${name}`);
  }
}

function makeState(over: Partial<State> = {}): State {
  return {
    provider: "wormsoft",
    windowStartedAt: Date.now(),
    windowMs: 2 * 60 * 60 * 1000,
    lastResetAt: 0,
    resetCount: 0,
    callsInWindow: 0,
    ...over,
  };
}

function cleanState(): void {
  try {
    if (fs.existsSync(testStateFile)) fs.unlinkSync(testStateFile);
  } catch {}
  try {
    if (fs.existsSync(testLockFile)) fs.unlinkSync(testLockFile);
  } catch {}
}

async function main(): Promise<void> {
  // ---- state.ts tests ----

  console.log("\n=== State tests ===");

  cleanState();
  assert(readStateSync() === null, "readStateSync: returns null when file missing");

  cleanState();
  writeStateSync(makeState({ callsInWindow: 42 }));
  const s = readStateSync();
  assert(s !== null, "readStateSync: returns state after write");
  assert(s?.callsInWindow === 42, "roundtrip: preserves callsInWindow");

  cleanState();
  writeStateSync(makeState({ windowStartedAt: 1234567890 }));
  const s2 = readStateSync();
  assert(s2?.windowStartedAt === 1234567890, "roundtrip: preserves windowStartedAt");

  cleanState();
  writeStateSync(makeState({ windowMs: 3600000 }));
  const s2b = readStateSync();
  assert(s2b?.windowMs === 3600000, "roundtrip: preserves windowMs");

  cleanState();
  // Write malformed JSON
  fs.writeFileSync(testStateFile, "{ not valid json", "utf8");
  const s3 = readStateSync();
  assert(s3 === null, "readStateSync: returns null on malformed JSON");

  cleanState();
  fs.writeFileSync(testStateFile, JSON.stringify({ windowStartedAt: "not a number" }), "utf8");
  const s3b = readStateSync();
  assert(s3b === null, "readStateSync: returns null on invalid shape (windowStartedAt not number)");

  cleanState();
  writeStateSync(makeState({ firstCallEmittedAt: 999 }));
  const s4 = readStateSync();
  assert(s4?.firstCallEmittedAt === 999, "roundtrip: preserves optional firstCallEmittedAt");

  // withLock completes N tasks
  cleanState();
  let counter = 0;
  await Promise.all([
    withLock(async () => {
      await new Promise((r) => setTimeout(r, 30));
      counter++;
    }),
    withLock(async () => {
      await new Promise((r) => setTimeout(r, 30));
      counter++;
    }),
    withLock(async () => {
      await new Promise((r) => setTimeout(r, 30));
      counter++;
    }),
  ]);
  assert(counter === 3, "withLock: 3 tasks all completed");

  // withLock serializes -- check by recording timing
  cleanState();
  const timestamps: number[] = [];
  await Promise.all([
    withLock(async () => {
      timestamps.push(Date.now());
      await new Promise((r) => setTimeout(r, 100));
    }),
    withLock(async () => {
      timestamps.push(Date.now());
      await new Promise((r) => setTimeout(r, 100));
    }),
  ]);
  timestamps.sort((a, b) => a - b);
  const gap = timestamps[1] - timestamps[0];
  assert(gap >= 80, `withLock: serializes (gap=${gap}ms >= 80ms)`);

  // mutateState: read-transform-write atomic
  cleanState();
  const r1 = await mutateState<number>((cur) => {
    if (cur === null) return { next: makeState({ callsInWindow: 1 }) };
    return { next: makeState({ callsInWindow: cur.callsInWindow + 1 }) };
  });
  assert(r1 === undefined, "mutateState: returns undefined when no result provided");
  const after1 = readStateSync();
  assert(after1?.callsInWindow === 1, "mutateState: writes new state");

  cleanState();
  const r2 = await mutateState<string>((cur) => {
    if (cur === null) return { next: makeState(), result: "first" };
    return { next: makeState({ callsInWindow: 999 }), result: "second" };
  });
  assert(r2 === "first", "mutateState: returns transform result when state was null");

  cleanState();
  writeStateSync(makeState({ callsInWindow: 5 }));
  const r3 = await mutateState<number>((cur) => {
    if (cur === null) return { next: null };
    return { next: makeState({ callsInWindow: cur.callsInWindow + 1 }), result: cur.callsInWindow };
  });
  assert(r3 === 5, "mutateState: returns previous value when state existed");
  const after3 = readStateSync();
  assert(after3?.callsInWindow === 6, "mutateState: increments correctly");

  // mutateState with next:null keeps state unchanged
  cleanState();
  writeStateSync(makeState({ callsInWindow: 100 }));
  const before = readStateSync();
  await mutateState(() => ({ next: null }));
  const afterNoOp = readStateSync();
  assert(afterNoOp?.callsInWindow === before?.callsInWindow, "mutateState: next:null is no-op");

  // writeStateSync cleans up .tmp files
  cleanState();
  writeStateSync(makeState());
  const tmpFiles = fs.readdirSync(tmpDir).filter((f) => f.includes(".tmp"));
  assert(tmpFiles.length === 0, "writeStateSync: cleans up .tmp files");

  // ---- ticker.ts tests ----

  console.log("\n=== Ticker tests ===");

  // 1. checkAndReset returns false when state is null
  cleanState();
  {
    const emit = createMockEmit();
    const result = await checkAndReset(emit.emit);
    assert(result === false, "ticker: returns false when state is null");
    assert(emit.calls.length === 0, "ticker: emits nothing when state is null");
  }

  // 2. checkAndReset returns false when window has not expired
  cleanState();
  {
    const emit = createMockEmit();
    const now = Date.now();
    await mutateState(() => ({
      next: makeState({ windowStartedAt: now - 10 * 60 * 1000 }), // 10 min in, 1h50 left
    }));
    const result = await checkAndReset(emit.emit);
    assert(result === false, "ticker: returns false when window not expired");
  }

  // 3. checkAndReset returns true and emits window_reset when window expired
  cleanState();
  {
    const emit = createMockEmit();
    const now = Date.now();
    await mutateState(() => ({
      next: makeState({
        windowStartedAt: now - (2 * 60 * 60 * 1000 + 1000), // expired by 1s
        lastResetAt: 0,
      }),
    }));
    const result = await checkAndReset(emit.emit);
    assert(result === true, "ticker: returns true when window expired");
    assert(
      emit.calls.some((c) => c.event === "billing:window_reset"),
      "ticker: emits billing:window_reset on reset",
    );
  }

  // 4. checkAndReset returns false on dedup (recent reset by another process)
  cleanState();
  {
    const emit = createMockEmit();
    const now = Date.now();
    // Window expired BUT lastResetAt is within DEDUP_WINDOW_MS
    await mutateState(() => ({
      next: makeState({
        windowStartedAt: now - (2 * 60 * 60 * 1000 + 1000),
        lastResetAt: now - 2 * 60 * 1000, // 2 min ago, well within 10 min dedup window
      }),
    }));
    const result = await checkAndReset(emit.emit);
    assert(result === false, "ticker: dedup -> returns false on recent reset");
    assert(
      !emit.calls.some((c) => c.event === "billing:window_reset"),
      "ticker: dedup -> does NOT emit window_reset",
    );
  }

  // 5. checkAndReset increments resetCount
  cleanState();
  {
    const emit = createMockEmit();
    const now = Date.now();
    await mutateState(() => ({
      next: makeState({
        windowStartedAt: now - (2 * 60 * 60 * 1000 + 1000),
        lastResetAt: 0,
        resetCount: 3,
      }),
    }));
    await checkAndReset(emit.emit);
    const after = readStateSync();
    assert(after?.resetCount === 4, "ticker: increments resetCount (3 -> 4)");
  }

  // 6. checkAndReset resets callsInWindow to 0
  cleanState();
  {
    const emit = createMockEmit();
    const now = Date.now();
    await mutateState(() => ({
      next: makeState({
        windowStartedAt: now - (2 * 60 * 60 * 1000 + 1000),
        lastResetAt: 0,
        callsInWindow: 17,
        firstCallEmittedAt: now - 60 * 60 * 1000,
      }),
    }));
    await checkAndReset(emit.emit);
    const after = readStateSync();
    assert(after?.callsInWindow === 0, "ticker: resets callsInWindow to 0");
    assert(
      after?.firstCallEmittedAt === undefined,
      "ticker: clears firstCallEmittedAt",
    );
  }

  // 7. checkAndReset emits window_about_to_reset when 5 min remaining
  cleanState();
  {
    const emit = createMockEmit();
    const now = Date.now();
    const windowMs = 2 * 60 * 60 * 1000;
    // Started 1h55m ago -> 5 min remaining (== ABOUT_TO_RESET_MS, should fire)
    await mutateState(() => ({
      next: makeState({
        windowStartedAt: now - (windowMs - 5 * 60 * 1000),
        lastResetAt: 0,
        windowMs,
      }),
    }));
    const result = await checkAndReset(emit.emit);
    assert(result === false, "ticker: about_to_reset does not count as reset");
    const aboutCall = emit.calls.find(
      (c) => c.event === "billing:window_about_to_reset",
    );
    assert(
      aboutCall !== undefined,
      "ticker: emits billing:window_about_to_reset when 5 min remaining",
    );
    const payload = aboutCall?.payload as { provider: string; msRemaining: number };
    assert(
      payload?.provider === "wormsoft",
      "ticker: about_to_reset payload has provider",
    );
    assert(
      typeof payload?.msRemaining === "number" && payload.msRemaining >= 0,
      "ticker: about_to_reset payload has positive msRemaining",
    );
  }

  // 8. checkAndReset does NOT emit window_about_to_reset when > 5 min remaining
  cleanState();
  {
    const emit = createMockEmit();
    const now = Date.now();
    const windowMs = 2 * 60 * 60 * 1000;
    // Started 1h ago -> 1h remaining, well above 5 min threshold
    await mutateState(() => ({
      next: makeState({
        windowStartedAt: now - 60 * 60 * 1000,
        lastResetAt: 0,
        windowMs,
      }),
    }));
    await checkAndReset(emit.emit);
    assert(
      !emit.calls.some((c) => c.event === "billing:window_about_to_reset"),
      "ticker: does NOT emit window_about_to_reset when > 5 min remaining",
    );
  }

  // ---- ui.ts tests ----

  console.log("\n=== UI tests ===");

  // 1. renderStatusBar formats H:MM (no seconds) correctly
  assert(
    renderStatusBar(5_400_000) === "[осталось: 1:30 м.]",
    "renderStatusBar: 1h30m -> '[осталось: 1:30 м.]'",
  );
  assert(
    renderStatusBar(2 * 60 * 60 * 1000) === "[осталось: 2:00 м.]",
    "renderStatusBar: full 2h window renders 2:00",
  );
  assert(
    renderStatusBar(300_000) === "[осталось: 0:05 м.]",
    "renderStatusBar: 5 minutes renders 0:05",
  );
  assert(
    renderStatusBar(60_000) === "[осталось: 0:01 м.]",
    "renderStatusBar: 1 minute renders 0:01",
  );
  assert(
    renderStatusBar(3_600_000) === "[осталось: 1:00 м.]",
    "renderStatusBar: exactly 1 hour -> 1:00",
  );

  // 2. renderStatusBar shows "0:00" when remaining is 0 or negative
  assert(
    renderStatusBar(0) === "[осталось: 0:00 м.]",
    "renderStatusBar: remaining=0 -> 0:00",
  );
  assert(
    renderStatusBar(-1000) === "[осталось: 0:00 м.]",
    "renderStatusBar: negative remaining -> 0:00",
  );
  assert(
    renderStatusBar(-99_999_999) === "[осталось: 0:00 м.]",
    "renderStatusBar: large negative -> 0:00",
  );

  // 3. renderStatusBar formats hours correctly when >= 1h
  assert(
    renderStatusBar(3_661_000) === "[осталось: 1:01 м.]",
    "renderStatusBar: 1h1m1s -> 1:01 (seconds dropped)",
  );
  // Hours not capped (e.g. > 24h)
  assert(
    renderStatusBar(25 * 60 * 60 * 1000) === "[осталось: 25:00 м.]",
    "renderStatusBar: 25h renders as 25:00 (no cap)",
  );

  // 4. renderStatusBar formats correctly when < 1 minute
  assert(
    renderStatusBar(30_000) === "[осталось: 0:00 м.]",
    "renderStatusBar: 30 seconds -> 0:00 (rounds down to whole minutes)",
  );
  assert(
    renderStatusBar(1_000) === "[осталось: 0:00 м.]",
    "renderStatusBar: 1 second -> 0:00 (rounds down)",
  );
  // 59min59s -> 0:59 (still 59 whole minutes)
  assert(
    renderStatusBar(59 * 60_000 + 59_000) === "[осталось: 0:59 м.]",
    "renderStatusBar: 59min59s -> 0:59",
  );

  // 5. startStatusUpdater: stop function clears status (wormsoft provider)
  {
    const calls: Array<{ key: string; text: string | undefined }> = [];
    const ctx = {
      mode: "tui",
      ui: {
        setStatus(key: string, text: string | undefined) {
          calls.push({ key, text });
        },
      },
      model: { provider: "wormsoft" },
    };

    cleanState();
    writeStateSync(makeState({ windowStartedAt: Date.now() - 60_000 })); // 1 min in, ~1h59m left

    const stop = startStatusUpdater(ctx);
    // First push is from the setInterval callback, but we cannot reliably
    // await it without fake timers. Instead test forceUpdate path.
    forceUpdate(ctx);

    assert(
      calls.some(
        (c) =>
          c.key === "billing-window" &&
          typeof c.text === "string" &&
          c.text.startsWith("[осталось: "),
      ),
      "ui: forceUpdate pushes the status line (wormsoft provider)",
    );

    const beforeStopLen = calls.length;
    stop();
    // stop must push an undefined for the same key
    const last = calls[calls.length - 1];
    assert(
      last?.key === "billing-window" && last?.text === undefined,
      "ui: stopper pushes setStatus(key, undefined) to clear the line",
    );
    // And no further ticks should fire after stop.
    // We just check the stopper cleared currentInterval -- tested implicitly
    // because we have not actually waited for the 5 min interval.
    assert(
      calls.length > beforeStopLen,
      "ui: stopper added at least one setStatus call after stopping",
    );
  }

  // 6. startStatusUpdater: защита от двойного старта
  {
    const calls: Array<{ key: string; text: string | undefined }> = [];
    const ctx = {
      mode: "tui",
      ui: {
        setStatus(key: string, text: string | undefined) {
          calls.push({ key, text });
        },
      },
      model: { provider: "wormsoft" },
    };

    cleanState();
    writeStateSync(makeState());

    const stop1 = startStatusUpdater(ctx);
    const stop2 = startStatusUpdater(ctx); // should stop the first one

    // stop1 should now be a no-op (the interval it captured is already cleared)
    // and stop2 should clear the current one. We verify the first interval
    // was cleared by checking that no dangling interval timer remains: the
    // easiest signal is that stop2's call sequence ends with a clear (undefined).
    const clears = calls.filter((c) => c.text === undefined);
    assert(
      clears.length >= 1,
      "ui: double start -> at least one clear (the previous instance is stopped)",
    );

    // Force the current one to actually be torn down.
    stop2();
    assert(
      calls[calls.length - 1]?.text === undefined,
      "ui: after stop2 the final setStatus is undefined",
    );
  }

  // 7. startStatusUpdater: non-tui mode is a no-op (no setStatus, no interval)
  {
    const calls: Array<{ key: string; text: string | undefined }> = [];
    const ctx = {
      mode: "print",
      ui: {
        setStatus(key: string, text: string | undefined) {
          calls.push({ key, text });
        },
      },
    };
    const stop = startStatusUpdater(ctx);
    assert(calls.length === 0, "ui: non-tui mode does not call setStatus");
    stop(); // must not throw
    assert(calls.length === 0, "ui: stopper is a no-op in non-tui mode");
  }

  // 8. forceUpdate clears status when no state exists (wormsoft provider)
  {
    const calls: Array<{ key: string; text: string | undefined }> = [];
    const ctx = {
      mode: "tui",
      ui: {
        setStatus(key: string, text: string | undefined) {
          calls.push({ key, text });
        },
      },
      model: { provider: "wormsoft" },
    };
    cleanState();
    forceUpdate(ctx);
    assert(
      calls.some((c) => c.key === "billing-window" && c.text === undefined),
      "ui: forceUpdate with no state -> setStatus(key, undefined)",
    );
  }

  // 9. forceUpdate hides the line when provider is not wormsoft
  {
    const calls: Array<{ key: string; text: string | undefined }> = [];
    const ctx = {
      mode: "tui",
      ui: {
        setStatus(key: string, text: string | undefined) {
          calls.push({ key, text });
        },
      },
      model: { provider: "anthropic" },
    };
    cleanState();
    // Even with a real state present, non-wormsoft must hide the line.
    writeStateSync(makeState({ windowStartedAt: Date.now() - 60_000 }));
    forceUpdate(ctx);
    const onlyCall = calls.find((c) => c.key === "billing-window");
    assert(
      onlyCall !== undefined && onlyCall.text === undefined,
      "ui: forceUpdate with non-wormsoft provider -> setStatus(key, undefined)",
    );
  }

  // 10. forceUpdate hides the line when no model is selected
  {
    const calls: Array<{ key: string; text: string | undefined }> = [];
    const ctx = {
      mode: "tui",
      ui: {
        setStatus(key: string, text: string | undefined) {
          calls.push({ key, text });
        },
      },
      // model: undefined -- simulates no model selected
    };
    cleanState();
    writeStateSync(makeState({ windowStartedAt: Date.now() - 60_000 }));
    forceUpdate(ctx);
    const onlyCall = calls.find((c) => c.key === "billing-window");
    assert(
      onlyCall !== undefined && onlyCall.text === undefined,
      "ui: forceUpdate with no model -> setStatus(key, undefined)",
    );
  }

  // 11. startStatusUpdater with non-wormsoft provider: must not push the
  //     status string (line is hidden). The interval may still be set,
  //     but its tick must call setStatus(key, undefined), not the timer
  //     string. We exercise the tick by calling forceUpdate after start.
  {
    const calls: Array<{ key: string; text: string | undefined }> = [];
    const ctx = {
      mode: "tui",
      ui: {
        setStatus(key: string, text: string | undefined) {
          calls.push({ key, text });
        },
      },
      model: { provider: "anthropic" },
    };

    cleanState();
    writeStateSync(makeState({ windowStartedAt: Date.now() - 60_000 }));

    const stop = startStatusUpdater(ctx);
    // The interval is 5 min, so we cannot await a real tick -- exercise
    // the tick path explicitly via forceUpdate (which goes through the
    // same applyStatus() that the interval callback uses).
    forceUpdate(ctx);

    const pushes = calls.filter((c) => c.key === "billing-window");
    assert(
      pushes.length > 0,
      "ui: startStatusUpdater with non-wormsoft provider sets up the line",
    );
    assert(
      pushes.every((c) => c.text === undefined),
      "ui: non-wormsoft provider -> every setStatus call passes undefined (line hidden)",
    );
    assert(
      !pushes.some((c) => typeof c.text === "string" && c.text.startsWith("[осталось: ")),
      "ui: non-wormsoft provider -> no '[осталось: ...]' line is ever pushed",
    );

    stop();
  }

  // ---- parser.ts tests ----

  console.log("\n=== Parser tests ===");

  // parseDuration: valid bare integers (minutes)
  {
    const r = parseDuration("0");
    assert(r.totalMs === 0 && r.error === undefined, "parseDuration: '0' -> 0 ms, no error");
  }
  {
    const r = parseDuration("60");
    assert(r.totalMs === 3600000 && r.error === undefined, "parseDuration: '60' -> 3,600,000 ms (60 min)");
  }
  {
    const r = parseDuration("96");
    assert(r.totalMs === 5760000 && r.error === undefined, "parseDuration: '96' -> 5,760,000 ms (96 min)");
  }
  {
    const r = parseDuration("1");
    assert(r.totalMs === 60000 && r.error === undefined, "parseDuration: '1' -> 60,000 ms (1 min)");
  }

  // parseDuration: Nm (minutes)
  {
    const r = parseDuration("1m");
    assert(r.totalMs === 60000 && r.error === undefined, "parseDuration: '1m' -> 60,000 ms");
  }
  {
    const r = parseDuration("90m");
    assert(r.totalMs === 5400000 && r.error === undefined, "parseDuration: '90m' -> 5,400,000 ms");
  }
  {
    const r = parseDuration("120m");
    assert(r.totalMs === 7200000 && r.error === undefined, "parseDuration: '120m' -> 7,200,000 ms (2h)");
  }

  // parseDuration: Nh (hours)
  {
    const r = parseDuration("1h");
    assert(r.totalMs === 3600000 && r.error === undefined, "parseDuration: '1h' -> 3,600,000 ms");
  }
  {
    const r = parseDuration("2h");
    assert(r.totalMs === 7200000 && r.error === undefined, "parseDuration: '2h' -> 7,200,000 ms");
  }

  // parseDuration: Nh Nm (hours + minutes)
  {
    const r = parseDuration("1h30m");
    assert(r.totalMs === 5400000 && r.error === undefined, "parseDuration: '1h30m' -> 5,400,000 ms");
  }
  {
    const r = parseDuration("2h15m");
    assert(r.totalMs === 8100000 && r.error === undefined, "parseDuration: '2h15m' -> 8,100,000 ms");
  }
  {
    const r = parseDuration("0h30m");
    assert(r.totalMs === 1800000 && r.error === undefined, "parseDuration: '0h30m' -> 1,800,000 ms");
  }

  // parseDuration: case-insensitive
  {
    const r = parseDuration("1H30M");
    assert(r.totalMs === 5400000 && r.error === undefined, "parseDuration: '1H30M' -> 5,400,000 ms (case-insensitive)");
  }
  {
    const r = parseDuration("2H");
    assert(r.totalMs === 7200000 && r.error === undefined, "parseDuration: '2H' -> 7,200,000 ms (case-insensitive)");
  }
  {
    const r = parseDuration("90M");
    assert(r.totalMs === 5400000 && r.error === undefined, "parseDuration: '90M' -> 5,400,000 ms (case-insensitive)");
  }

  // parseDuration: trim
  {
    const r = parseDuration(" 60 ");
    assert(r.totalMs === 3600000 && r.error === undefined, "parseDuration: ' 60 ' -> 3,600,000 ms (trim)");
  }
  {
    const r = parseDuration("\t1h30m\n");
    assert(r.totalMs === 5400000 && r.error === undefined, "parseDuration: tabs/newlines are trimmed");
  }

  // parseDuration: empty / whitespace -> error
  {
    const r = parseDuration("");
    assert(r.totalMs === 0 && typeof r.error === "string" && r.error.length > 0, "parseDuration: '' -> error");
  }
  {
    const r = parseDuration("   ");
    assert(r.totalMs === 0 && typeof r.error === "string" && r.error.length > 0, "parseDuration: whitespace -> error");
  }

  // parseDuration: non-numeric
  {
    const r = parseDuration("abc");
    assert(r.totalMs === 0 && typeof r.error === "string" && r.error.length > 0, "parseDuration: 'abc' -> error");
  }
  {
    const r = parseDuration("1h abc");
    assert(r.totalMs === 0 && typeof r.error === "string" && r.error.length > 0, "parseDuration: '1h abc' -> error");
  }

  // parseDuration: negative values
  {
    const r = parseDuration("-5");
    assert(r.totalMs === 0 && typeof r.error === "string" && r.error.length > 0, "parseDuration: '-5' -> error");
  }
  {
    const r = parseDuration("-1h");
    assert(r.totalMs === 0 && typeof r.error === "string" && r.error.length > 0, "parseDuration: '-1h' -> error");
  }
  {
    const r = parseDuration("-30m");
    assert(r.totalMs === 0 && typeof r.error === "string" && r.error.length > 0, "parseDuration: '-30m' -> error");
  }

  // parseDuration: fractional values
  {
    const r = parseDuration("1.5h");
    assert(r.totalMs === 0 && typeof r.error === "string" && r.error.length > 0, "parseDuration: '1.5h' -> error (fractional)");
  }
  {
    const r = parseDuration("0.5");
    assert(r.totalMs === 0 && typeof r.error === "string" && r.error.length > 0, "parseDuration: '0.5' -> error (fractional)");
  }

  // parseDuration: unsupported units
  {
    const r = parseDuration("90s");
    assert(r.totalMs === 0 && typeof r.error === "string" && r.error.length > 0, "parseDuration: '90s' -> error (seconds unsupported)");
  }
  {
    const r = parseDuration("2d");
    assert(r.totalMs === 0 && typeof r.error === "string" && r.error.length > 0, "parseDuration: '2d' -> error (days unsupported)");
  }
  {
    const r = parseDuration("5w");
    assert(r.totalMs === 0 && typeof r.error === "string" && r.error.length > 0, "parseDuration: '5w' -> error (weeks unsupported)");
  }

  // parseDuration: malformed combinations
  {
    const r = parseDuration("1h2");
    assert(r.totalMs === 0 && typeof r.error === "string" && r.error.length > 0, "parseDuration: '1h2' -> error (missing m suffix)");
  }
  {
    const r = parseDuration("m");
    assert(r.totalMs === 0 && typeof r.error === "string" && r.error.length > 0, "parseDuration: 'm' -> error (no number)");
  }
  {
    const r = parseDuration("h");
    assert(r.totalMs === 0 && typeof r.error === "string" && r.error.length > 0, "parseDuration: 'h' -> error (no number)");
  }
  {
    const r = parseDuration("1m1h");
    assert(r.totalMs === 0 && typeof r.error === "string" && r.error.length > 0, "parseDuration: '1m1h' -> error (wrong order)");
  }

  // formatDuration: positive values
  assert(formatDuration(3600000) === "01:00:00", "formatDuration: 3,600,000 ms -> '01:00:00'");
  assert(formatDuration(5400000) === "01:30:00", "formatDuration: 5,400,000 ms -> '01:30:00'");
  assert(formatDuration(0) === "00:00:00", "formatDuration: 0 -> '00:00:00'");
  assert(formatDuration(1000) === "00:00:01", "formatDuration: 1,000 ms -> '00:00:01'");
  assert(formatDuration(60000) === "00:01:00", "formatDuration: 60,000 ms -> '00:01:00'");
  assert(formatDuration(3661000) === "01:01:01", "formatDuration: 3,661,000 ms -> '01:01:01'");
  assert(formatDuration(7199000) === "01:59:59", "formatDuration: 7,199,000 ms -> '01:59:59'");
  assert(formatDuration(7320000) === "02:02:00", "formatDuration: 7,320,000 ms -> '02:02:00'");
  assert(formatDuration(25 * 60 * 60 * 1000) === "25:00:00", "formatDuration: 25h -> '25:00:00' (no cap)");

  // formatDuration: zero and negative
  assert(formatDuration(-1000) === "00:00:00", "formatDuration: -1,000 ms -> '00:00:00'");
  assert(formatDuration(-99999999) === "00:00:00", "formatDuration: large negative -> '00:00:00'");

  // formatDuration: sub-second rounds down
  assert(formatDuration(500) === "00:00:00", "formatDuration: 500 ms -> '00:00:00' (rounds down)");
  assert(formatDuration(999) === "00:00:00", "formatDuration: 999 ms -> '00:00:00' (rounds down)");

  // parseDuration + formatDuration roundtrip
  {
    const parsed: ParsedDuration = parseDuration("1h30m");
    assert(parsed.totalMs !== undefined, "roundtrip: parseDuration produces totalMs");
    assert(formatDuration(parsed.totalMs) === "01:30:00", "roundtrip: parseDuration -> formatDuration works");
  }
  {
    const parsed = parseDuration("0");
    assert(formatDuration(parsed.totalMs) === "00:00:00", "roundtrip: 0 -> 00:00:00");
  }

  // ---- notifier.ts tests ----

  console.log("\n=== Notifier tests ===");

  const samplePayload: NotifyPayload = {
    type: "billing:window_reset",
    provider: "wormsoft",
    title: "Wormsoft: лимит обновлён",
    body: "2-часовое окно сброшено (reset #1). Свежие 5M токенов доступны.",
    timestamp: 1700000000000,
  };

  // Suppress console.warn noise from the failure-mode tests.
  const originalWarn = console.warn;
  const silentWarn = (() => {}) as typeof console.warn;

  // 1. sendNotify без url/token -> { ok: false, error: "no url" } (НЕ throw)
  {
    installMock();
    console.warn = silentWarn;
    try {
      // Override env to guarantee no token resolves either.
      const savedEnv = process.env.PI_REMOTE_NOTIFY_TOKEN;
      delete process.env.PI_REMOTE_NOTIFY_TOKEN;
      try {
        const r = await sendNotify(samplePayload, { url: "" });
        assert(r.ok === false, "notifier: empty url -> ok=false");
        assert(r.error === "no url", "notifier: empty url -> error='no url'");
        assert(mockFetchCalls.length === 0, "notifier: empty url -> fetch not called");
      } finally {
        if (savedEnv !== undefined) process.env.PI_REMOTE_NOTIFY_TOKEN = savedEnv;
      }
    } catch (e) {
      assert(false, `notifier: empty url must not throw (got: ${(e as Error).message})`);
    } finally {
      console.warn = originalWarn;
      restoreMock();
    }
  }

  // 2. sendNotify с 401 ответом -> { ok: false, status: 401 }
  {
    installMock();
    console.warn = silentWarn;
    try {
      mockFetchResponse = new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
      const r = await sendNotify(samplePayload, { url: "http://x/api/notify" });
      assert(r.ok === false, "notifier: 401 -> ok=false");
      assert(r.status === 401, "notifier: 401 -> status=401");
      assert(
        r.error === "http 401",
        `notifier: 401 -> error='http 401' (got '${r.error}')`,
      );
      assert(mockFetchCalls.length === 1, "notifier: 401 -> fetch called once");
    } finally {
      console.warn = originalWarn;
      restoreMock();
    }
  }

  // 3. sendNotify с 200 ответом -> { ok: true, status: 200 }
  {
    installMock();
    try {
      mockFetchResponse = new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      const r = await sendNotify(samplePayload, { url: "http://x/api/notify" });
      assert(r.ok === true, "notifier: 200 -> ok=true");
      assert(r.status === 200, "notifier: 200 -> status=200");
      assert(r.error === undefined, "notifier: 200 -> no error field");
      assert(mockFetchCalls.length === 1, "notifier: 200 -> fetch called once");
      const call = mockFetchCalls[0];
      assert(
        call.url === "http://x/api/notify",
        `notifier: 200 -> correct url (got '${call.url}')`,
      );
      assert(
        (call.init?.method ?? "").toUpperCase() === "POST",
        "notifier: 200 -> method=POST",
      );
      const headers = call.init?.headers as Record<string, string>;
      assert(
        headers["Content-Type"] === "application/json",
        "notifier: 200 -> Content-Type=application/json",
      );
      // Token is unset (no env, no option) -> no X-Notify-Token header.
      assert(
        headers["X-Notify-Token"] === undefined,
        "notifier: 200 -> no X-Notify-Token when no token configured",
      );
      const body = JSON.parse(call.init?.body as string);
      assert(body.type === "billing:window_reset", "notifier: 200 -> body.type");
      assert(body.title === samplePayload.title, "notifier: 200 -> body.title roundtrip");
      assert(body.timestamp === samplePayload.timestamp, "notifier: 200 -> body.timestamp roundtrip");
    } finally {
      restoreMock();
    }
  }

  // 3b. sendNotify with explicit token -> sends X-Notify-Token header.
  {
    installMock();
    try {
      mockFetchResponse = new Response('{"ok":true}', { status: 200 });
      await sendNotify(samplePayload, {
        url: "http://x/api/notify",
        token: "secret-abc",
      });
      const call = mockFetchCalls[0];
      const headers = call.init?.headers as Record<string, string>;
      assert(
        headers["X-Notify-Token"] === "secret-abc",
        "notifier: explicit token -> X-Notify-Token header set",
      );
    } finally {
      restoreMock();
    }
  }

  // 3c. sendNotify with token from env -> sends X-Notify-Token header.
  {
    installMock();
    try {
      mockFetchResponse = new Response('{"ok":true}', { status: 200 });
      const savedEnv = process.env.PI_REMOTE_NOTIFY_TOKEN;
      process.env.PI_REMOTE_NOTIFY_TOKEN = "env-token-xyz";
      try {
        await sendNotify(samplePayload, { url: "http://x/api/notify" });
        const headers = mockFetchCalls[0].init?.headers as Record<string, string>;
        assert(
          headers["X-Notify-Token"] === "env-token-xyz",
          "notifier: env token -> X-Notify-Token header set",
        );
      } finally {
        if (savedEnv !== undefined) process.env.PI_REMOTE_NOTIFY_TOKEN = savedEnv;
        else delete process.env.PI_REMOTE_NOTIFY_TOKEN;
      }
    } finally {
      restoreMock();
    }
  }

  // 3d. sendNotify with default url when no override given.
  {
    installMock();
    try {
      mockFetchResponse = new Response('{"ok":true}', { status: 200 });
      await sendNotify(samplePayload);
      assert(
        mockFetchCalls[0].url === "http://localhost:7681/api/notify",
        `notifier: default url -> 'http://localhost:7681/api/notify' (got '${mockFetchCalls[0].url}')`,
      );
    } finally {
      restoreMock();
    }
  }

  // 4. sendNotify с network error -> { ok: false, error: ... } (НЕ throw)
  {
    installMock();
    console.warn = silentWarn;
    try {
      mockFetchError = new Error("ECONNREFUSED 127.0.0.1:7681");
      const r = await sendNotify(samplePayload, { url: "http://x/api/notify" });
      assert(r.ok === false, "notifier: network error -> ok=false");
      assert(
        r.error === "ECONNREFUSED 127.0.0.1:7681",
        `notifier: network error -> error contains message (got '${r.error}')`,
      );
      assert(r.status === undefined, "notifier: network error -> no status field");
    } catch (e) {
      assert(
        false,
        `notifier: network error must not throw (got: ${(e as Error).message})`,
      );
    } finally {
      console.warn = originalWarn;
      restoreMock();
    }
  }

  // 5. sendNotify с timeout (timeoutMs=1, mock с задержкой 100ms) -> { ok: false }
  {
    installMock();
    console.warn = silentWarn;
    try {
      // We hand back a Response that is never produced because the mock
      // sleeps past the abort -- AbortController should fire and sendNotify
      // should swallow it as a network/timeout error.
      mockFetchResponse = new Response('{"ok":true}', { status: 200 });
      mockFetchDelayMs = 100;
      const r = await sendNotify(samplePayload, {
        url: "http://x/api/notify",
        timeoutMs: 1,
      });
      assert(r.ok === false, "notifier: timeout -> ok=false");
      assert(
        typeof r.error === "string" && r.error.length > 0,
        "notifier: timeout -> error string present",
      );
    } catch (e) {
      assert(
        false,
        `notifier: timeout must not throw (got: ${(e as Error).message})`,
      );
    } finally {
      console.warn = originalWarn;
      restoreMock();
    }
  }

  // 6. sendNotify: 5xx is also a non-2xx -> { ok: false, status, error }
  {
    installMock();
    console.warn = silentWarn;
    try {
      mockFetchResponse = new Response("boom", { status: 503 });
      const r = await sendNotify(samplePayload, { url: "http://x/api/notify" });
      assert(r.ok === false, "notifier: 503 -> ok=false");
      assert(r.status === 503, "notifier: 503 -> status=503");
      assert(
        r.error === "http 503",
        `notifier: 503 -> error='http 503' (got '${r.error}')`,
      );
    } finally {
      console.warn = originalWarn;
      restoreMock();
    }
  }

  // ---- Done ----
  cleanState();
  rmSync(tmpDir, { recursive: true, force: true });
  resetPaths();
  restoreMock();

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