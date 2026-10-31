/**
 * test.mts -- unit tests for pi-billing-window (state + reset + wakeups).
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
  ABOUT_TO_RESET_MS,
  DEDUP_WINDOW_MS,
  type EmitFn,
} from "../src/reset.ts";
import {
  WAKE_MARGIN_MS,
  WAKE_DEPTH,
  WAKE_BURNED_TTL_MS,
  WAKE_APPEND_EPSILON_MS,
  computeTableFromAnchor,
  nextDuePoint,
  dropBurnedPoints,
  appendAnchorPoint,
  readWakeTable,
  mutateWakeTable,
  setWakePaths as wakeSetPaths,
  resetPaths as wakeResetPaths,
  armWakeTimer,
  clearWakeTimer,
  hasRefForTests as wakeHasRefForTests,
  type WakeTable,
} from "../src/wakeups.ts";
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
import {
  setPaths as historySetPaths,
  resetPaths as historyResetPaths,
} from "../src/history.ts";
import piBillingWindowFactory, {
  setArmsLogPath,
  __resetStaleStateForTests,
  __ensureWakeTimerForTests,
  __fireWakeForTests,
  __wakeSyncTickForTests,
  __stopWakeTimerForTests,
} from "../src/index.ts";
import {
  setPaths as armsSetPaths,
  resetPaths as armsResetPaths,
} from "../src/arms.ts";

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

// Redirect the shared history CSV and the arms file too: checkAndReset()
// (reset.ts checkAndReset) appends "window_reset" rows into history.csv, and ui.ts reads the
// arms file while rendering -- both must never touch the product files
// during tests.
const testHistoryFile = join(tmpDir, "history.csv");
const testHistoryLock = join(tmpDir, "history.lock");
const testArmsFile = join(tmpDir, "arms.json");
const testArmsLock = join(tmpDir, "arms.lock");
historySetPaths(testHistoryFile, testHistoryLock);
armsSetPaths(testArmsFile, testArmsLock);

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
    // Spec 017: wake-тесты этого сьюта остаются на legacy-пути (ping off =
    // бит-в-бит поведение до spec 017); пинг покрыт tests/ping.test.mts.
    ping: { disabled: true },
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

  // ---- reset.ts tests ----

  console.log("\n=== Reset tests (reset.ts) ===");

  // 1. checkAndReset returns false when state is null
  cleanState();
  {
    const emit = createMockEmit();
    const result = await checkAndReset(emit.emit);
    assert(result === false, "reset: returns false when state is null");
    assert(emit.calls.length === 0, "reset: emits nothing when state is null");
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
    assert(result === false, "reset: returns false when window not expired");
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
    assert(result === true, "reset: returns true when window expired");
    assert(
      emit.calls.some((c) => c.event === "billing:window_reset"),
      "reset: emits billing:window_reset on reset",
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
    assert(result === false, "reset: dedup -> returns false on recent reset");
    assert(
      !emit.calls.some((c) => c.event === "billing:window_reset"),
      "reset: dedup -> does NOT emit window_reset",
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
    assert(after?.resetCount === 4, "reset: increments resetCount (3 -> 4)");
  }

  // 6. checkAndReset resets callsInWindow to 0
  // 2026-10 drift fix: the window boundary follows the LAZY anchor
  // (firstCallEmittedAt) -- a window whose first call came 1h after the
  // reset moment must NOT reset at windowStartedAt + windowMs (that was
  // the drift bug: one "reset -> first call" gap lost per cycle).
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
    const result = await checkAndReset(emit.emit);
    const after = readStateSync();
    assert(
      result === false && after?.callsInWindow === 17 && after?.resetCount === 0,
      "reset: lazy anchor 1h late -> NO reset at windowStartedAt + 2h",
    );
    assert(
      after?.firstCallEmittedAt === now - 60 * 60 * 1000,
      "reset: lazy anchor preserved when window not expired",
    );
  }
  // 6b. Same state but the first call sits at the window start: the
  // anchor equals windowStartedAt, the 2h boundary HAS passed -> reset.
  cleanState();
  {
    const emit = createMockEmit();
    const now = Date.now();
    await mutateState(() => ({
      next: makeState({
        windowStartedAt: now - (2 * 60 * 60 * 1000 + 1000),
        lastResetAt: 0,
        callsInWindow: 17,
        firstCallEmittedAt: now - (2 * 60 * 60 * 1000 + 1000),
      }),
    }));
    await checkAndReset(emit.emit);
    const after = readStateSync();
    assert(after?.callsInWindow === 0, "reset: resets callsInWindow to 0");
    assert(
      after?.firstCallEmittedAt === undefined,
      "reset: clears firstCallEmittedAt",
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
    assert(result === false, "reset: about_to_reset does not count as reset");
    const aboutCall = emit.calls.find(
      (c) => c.event === "billing:window_about_to_reset",
    );
    assert(
      aboutCall !== undefined,
      "reset: emits billing:window_about_to_reset when 5 min remaining",
    );
    const payload = aboutCall?.payload as { provider: string; msRemaining: number };
    assert(
      payload?.provider === "wormsoft",
      "reset: about_to_reset payload has provider",
    );
    assert(
      typeof payload?.msRemaining === "number" && payload.msRemaining >= 0,
      "reset: about_to_reset payload has positive msRemaining",
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
      "reset: does NOT emit window_about_to_reset when > 5 min remaining",
    );
  }

  // 9. note (TD-008): custom note lands in the history row
  cleanState();
  {
    const emit = createMockEmit();
    const now = Date.now();
    await mutateState(() => ({
      next: makeState({
        windowStartedAt: now - (2 * 60 * 60 * 1000 + 1000),
        lastResetAt: 0,
        resetCount: 7,
      }),
    }));
    const result = await checkAndReset(
      emit.emit,
      { project: "waketest", session: "s1" },
      "wake 09:00",
    );
    assert(result === true, "reset: note case -> resets window");
    // appendHistory is fire-and-forget inside checkAndReset -- give it a beat
    await new Promise((r) => setTimeout(r, 150));
    const csv = fs.readFileSync(testHistoryFile, "utf8").trim();
    const lastRow = csv.split(/\r?\n/).pop() ?? "";
    const fields = lastRow.split(",");
    assert(fields[2] === "window_reset", "reset: note case -> history kind=window_reset");
    assert(
      fields[11] === "wake 09:00",
      `reset: custom note lands in history row (got '${fields[11]}')`,
    );
  }

  // 10. note default is "auto" when the argument is omitted
  cleanState();
  {
    const emit = createMockEmit();
    const now = Date.now();
    await mutateState(() => ({
      next: makeState({
        windowStartedAt: now - (2 * 60 * 60 * 1000 + 1000),
        lastResetAt: 0,
      }),
    }));
    await checkAndReset(emit.emit);
    await new Promise((r) => setTimeout(r, 150));
    const csv = fs.readFileSync(testHistoryFile, "utf8").trim();
    const lastRow = csv.split(/\r?\n/).pop() ?? "";
    const fields = lastRow.split(",");
    assert(
      fields[11] === "auto",
      `reset: default note is 'auto' (got '${fields[11]}')`,
    );
  }

  // ---- wakeups.ts tests (spec 012: T1 pure functions + T2 persistence/timer) ----

  console.log("\n=== Wakeups tests (wakeups.ts) ===");

  const testWakeFile = join(tmpDir, "wakeups.json");
  const testWakeLock = join(tmpDir, "wakeups.lock");
  const cleanWake = (): void => {
    try {
      if (fs.existsSync(testWakeFile)) fs.unlinkSync(testWakeFile);
    } catch {}
    try {
      if (fs.existsSync(testWakeLock)) fs.unlinkSync(testWakeLock);
    } catch {}
  };

  // 0. constants sanity (FR-012-3/4/10, R1)
  assert(
    WAKE_MARGIN_MS === 2 * 60_000 &&
      WAKE_DEPTH === 12 &&
      WAKE_BURNED_TTL_MS === 30 * 60_000 &&
      WAKE_APPEND_EPSILON_MS === 60_000,
    "wakeups: constants 2min / depth 12 / ttl 30min / epsilon 60s",
  );

  // 1. computeTableFromAnchor: depth, first element, step, tail
  {
    const anchor = 1_000_000;
    const w = 2 * 60 * 60 * 1000;
    const t = computeTableFromAnchor(anchor, w);
    assert(t.points.length === WAKE_DEPTH, "computeTableFromAnchor: depth points");
    assert(
      t.points[0] === anchor + w + WAKE_MARGIN_MS,
      "computeTableFromAnchor: first = anchor + window + margin",
    );
    assert(t.points[1] === t.points[0] + w, "computeTableFromAnchor: step = windowMs");
    assert(
      t.points[WAKE_DEPTH - 1] === t.points[0] + (WAKE_DEPTH - 1) * w,
      "computeTableFromAnchor: tail = first + k*windowMs",
    );
    assert(
      t.version === 1 && t.source === "firstCall",
      "computeTableFromAnchor: version 1, source firstCall",
    );
  }

  // 2. nextDuePoint (design §4: min non-burned point)
  {
    const w = 2 * 60 * 60 * 1000;
    const base = Date.now();
    const mk = (points: number[], source: WakeTable["source"] = "firstCall"): WakeTable => ({
      version: 1,
      points,
      updatedAt: base,
      source,
    });
    assert(nextDuePoint(null, base) === null, "nextDuePoint: no table -> null");
    assert(nextDuePoint(mk([]), base) === null, "nextDuePoint: empty points -> null");
    assert(
      nextDuePoint(mk([base + w]), base) === base + w,
      "nextDuePoint: future point -> it",
    );
    assert(
      nextDuePoint(mk([base - 60_000]), base) === base - 60_000,
      "nextDuePoint: past within TTL -> it",
    );
    assert(
      nextDuePoint(mk([base - WAKE_BURNED_TTL_MS - 1]), base) === null,
      "nextDuePoint: burned point -> null",
    );
    assert(
      nextDuePoint(
        mk([base - WAKE_BURNED_TTL_MS - 1, base - 60_000, base + w]),
        base,
      ) === base - 60_000,
      "nextDuePoint: min non-burned of several",
    );
  }

  // 3. dropBurnedPoints: strict boundary + mixed ages
  {
    const base = Date.now();
    const w = 2 * 60 * 60 * 1000;
    const p = base - 10_000;
    const t: WakeTable = { version: 1, points: [p], updatedAt: base, source: "settimer" };
    const alive = dropBurnedPoints(t, p + WAKE_BURNED_TTL_MS);
    assert(
      alive.points.length === 1,
      "dropBurnedPoints: exactly p+ttl survives (strict >)",
    );
    const dead = dropBurnedPoints(t, p + WAKE_BURNED_TTL_MS + 1);
    assert(dead.points.length === 0, "dropBurnedPoints: p+ttl+1 drops");
    const mixed: WakeTable = {
      version: 1,
      points: [base - 40 * 60_000, base - 5 * 60_000, base + w],
      updatedAt: base,
      source: "firstCall",
    };
    const m = dropBurnedPoints(mixed, base);
    assert(
      m.points.length === 2 &&
        m.points[0] === base - 5 * 60_000 &&
        m.points[1] === base + w,
      "dropBurnedPoints: mixed ages -> only burned dropped",
    );
  }

  // 4. appendAnchorPoint: ascending insert + top-up + truncate + R1 epsilon
  {
    const w = 2 * 60 * 60 * 1000;
    const base = Date.now();
    // insertion in ascending order + top-up of the tail to depth
    const t: WakeTable = { version: 1, points: [base + 10 * w], updatedAt: base, source: "settimer" };
    const r1 = appendAnchorPoint(t, base, w); // target = base + w + margin
    assert(
      r1.points[0] === base + w + WAKE_MARGIN_MS && r1.points[1] === base + 10 * w,
      "appendAnchorPoint: inserts in ascending order",
    );
    assert(r1.points.length === WAKE_DEPTH, "appendAnchorPoint: top-up tail to depth");
    assert(
      r1.points[WAKE_DEPTH - 1] === r1.points[1] + (WAKE_DEPTH - 2) * w,
      "appendAnchorPoint: tail = last + k*windowMs",
    );
    // R1: anchor point closer than 60s to an existing one is NOT inserted
    const near = base + w + WAKE_MARGIN_MS - 30_000;
    const t2: WakeTable = { version: 1, points: [near], updatedAt: base, source: "firstCall" };
    const r2 = appendAnchorPoint(t2, base, w);
    assert(
      r2.points[0] === near && !r2.points.includes(base + w + WAKE_MARGIN_MS),
      "appendAnchorPoint: R1 -- point within 60s epsilon not inserted",
    );
    // truncation beyond depth cuts the far tail, never the head
    const full = computeTableFromAnchor(base, w);
    const q = base + 6 * w + WAKE_MARGIN_MS + 120_000; // lands between p5 and p6
    const r3 = appendAnchorPoint(full, base + 5 * w + 120_000, w);
    assert(r3.points.length === WAKE_DEPTH, "appendAnchorPoint: truncates to depth");
    assert(r3.points[0] === full.points[0], "appendAnchorPoint: head kept on truncation");
    assert(r3.points.includes(q), "appendAnchorPoint: mid insert survives truncation");
    assert(
      !r3.points.includes(full.points[WAKE_DEPTH - 1]),
      "appendAnchorPoint: far tail point is cut",
    );
  }

  // 5. persistence: write -> read round-trip under lock
  cleanWake();
  wakeSetPaths(testWakeFile, testWakeLock);
  {
    const w = 2 * 60 * 60 * 1000;
    let sawNull = false;
    const ok = await mutateWakeTable((cur) => {
      sawNull = cur === null;
      return { next: computeTableFromAnchor(1_000_000, w) };
    });
    assert(ok === true, "mutateWakeTable: returns true on write");
    assert(sawNull, "mutateWakeTable: transform sees null when file missing");
    const t = readWakeTable();
    assert(
      t !== null && t.points.length === WAKE_DEPTH && t.points[0] === 1_000_000 + w + WAKE_MARGIN_MS,
      "readWakeTable: round-trip after write",
    );
  }

  // 6. missing file -> null, silent
  cleanWake();
  {
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (m?: unknown) => {
      warns.push(String(m));
    };
    try {
      assert(readWakeTable() === null, "readWakeTable: missing file -> null");
      assert(warns.length === 0, "readWakeTable: missing file is silent");
    } finally {
      console.warn = origWarn;
    }
  }

  // 7. corrupt JSON / foreign schema -> null + ONE warn per process
  cleanWake();
  wakeSetPaths(testWakeFile, testWakeLock); // reset the warn flag
  {
    fs.writeFileSync(testWakeFile, "{definitely not json", "utf8");
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (m?: unknown) => {
      warns.push(String(m));
    };
    try {
      assert(readWakeTable() === null, "readWakeTable: corrupt JSON -> null");
      assert(readWakeTable() === null, "readWakeTable: corrupt JSON -> null again");
      assert(warns.length === 1, "readWakeTable: corrupt JSON warns exactly once");
      // foreign schema (version 2) is also rejected
      fs.writeFileSync(
        testWakeFile,
        JSON.stringify({ version: 2, points: [1], updatedAt: 1, source: "firstCall" }),
        "utf8",
      );
      assert(readWakeTable() === null, "readWakeTable: version != 1 -> null");
      // non-numeric points are rejected too
      fs.writeFileSync(
        testWakeFile,
        JSON.stringify({ version: 1, points: [1, "two"], updatedAt: 1, source: "firstCall" }),
        "utf8",
      );
      assert(readWakeTable() === null, "readWakeTable: non-numeric points -> null");
    } finally {
      console.warn = origWarn;
    }
  }

  // 8. points: [] is a legal "window not started" state
  cleanWake();
  {
    const ok = await mutateWakeTable(() => ({
      next: { version: 1, points: [], updatedAt: Date.now(), source: "settimer" },
    }));
    assert(ok === true, "mutateWakeTable: empty table write ok");
    const t = readWakeTable();
    assert(
      t !== null && t.points.length === 0 && t.source === "settimer",
      "readWakeTable: points [] is legal",
    );
  }

  // 9. two parallel mutations do not lose a point (lock serializes them)
  cleanWake();
  {
    const seed: WakeTable = {
      version: 1,
      points: [1_000],
      updatedAt: Date.now(),
      source: "firstCall",
    };
    await mutateWakeTable(() => ({ next: seed }));
    const pushPoint = (p: number) =>
      mutateWakeTable((cur) => {
        const base = cur ?? seed;
        return { next: { ...base, points: [...base.points, p].sort((a, b) => a - b) } };
      });
    const [r1, r2] = await Promise.all([pushPoint(3_000), pushPoint(2_000)]);
    assert(r1 === true && r2 === true, "parallel mutateWakeTable: both succeed");
    const t = readWakeTable();
    assert(
      t !== null &&
        t.points.length === 3 &&
        t.points[0] === 1_000 &&
        t.points[1] === 2_000 &&
        t.points[2] === 3_000,
      "parallel mutateWakeTable: no point lost (lock serializes)",
    );
  }

  // 10. wake timer primitive: unref, clear, immediate fire, cancel-before-arm
  {
    let fired = false;
    armWakeTimer(Date.now() + 60_000, () => {
      fired = true;
    });
    assert(
      wakeHasRefForTests() === false,
      "armWakeTimer: handle is unref'd (does not hold event loop)",
    );
    clearWakeTimer();
    assert(wakeHasRefForTests() === null, "clearWakeTimer: -> null");
    // re-arm cancels the previous timer (watchdog.ts pattern)
    let firstFired = false;
    armWakeTimer(Date.now() + 20_000, () => {
      firstFired = true;
    });
    armWakeTimer(Date.now() + 20_000, () => {
      fired = true;
    });
    clearWakeTimer();
    assert(!firstFired, "armWakeTimer: re-arm cancels the previous timer");
    // a past moment fires with delay 0 (self-correcting max(0, when-now))
    fired = false;
    armWakeTimer(Date.now() - 5_000, () => {
      fired = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    assert(fired, "armWakeTimer: past whenMs fires immediately (delay 0)");
    clearWakeTimer();
  }

  cleanWake();

  // ---- wake scheduler integration (spec 012 T4: index.ts scheduler) ----

  console.log("\n=== Wake scheduler integration (spec 012 T4) ===");

  // Drive the real extension factory (pending-window-retry.test.mts pattern):
  // mock pi/ctx, temp paths, manual hooks. The factory now writes wake
  // anchors on the first call, so the arms log path is redirected too.
  setArmsLogPath(join(tmpDir, "armslog.log"));
  __resetStaleStateForTests(); // isolates fires + wake dirs; wake overridden below
  cleanWake();
  wakeSetPaths(testWakeFile, testWakeLock);
  __stopWakeTimerForTests();
  cleanState();

  type SchedHandler = (event: unknown, ctx: unknown) => unknown;
  const schedHandlers = new Map<string, SchedHandler[]>();
  const schedCommands = new Map<
    string,
    (args: string, ctx: unknown) => Promise<void> | void
  >();
  const busEmits: Array<{ ch: string; data: unknown }> = [];
  const busSubs = new Map<string, Array<(d: unknown) => void>>();
  {
    const pi = {
      events: {
        emit: (ch: string, data: unknown) => {
          busEmits.push({ ch, data });
        },
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
      on: (ev: string, h: SchedHandler) => {
        const arr = schedHandlers.get(ev) ?? [];
        arr.push(h);
        schedHandlers.set(ev, arr);
      },
      registerCommand: (
        name: string,
        spec: { handler: (args: string, ctx: unknown) => Promise<void> | void },
      ) => {
        schedCommands.set(name, spec.handler);
      },
      sendUserMessage: async () => undefined,
    };
    piBillingWindowFactory(pi as never);
  }
  const notifies: string[] = [];
  const schedCtx = {
    mode: "tui",
    isIdle: () => true,
    model: { provider: "wormsoft", id: "test/model-1" },
    ui: {
      notify: (msg: string) => {
        notifies.push(msg);
      },
      setStatus: () => {},
    },
    sessionManager: {
      getSessionFile: () => join(tmpDir, "sess-wake.jsonl"),
      getCwd: () => "C:/tmp/fake-project",
      getEntries: () => [
        {
          type: "message",
          message: { role: "assistant", usage: { input: 10, output: 5 } },
        },
      ],
    },
  };
  const sessionStart = schedHandlers.get("session_start")?.[0];
  const afterResponse = schedHandlers.get("after_provider_response")?.[0];
  if (!sessionStart || !afterResponse) {
    throw new Error("extension did not register hooks");
  }

  const W2H = 2 * 60 * 60 * 1000;
  const schedSeedState = async (over: Partial<State> = {}): Promise<void> => {
    await mutateState(() => ({ next: makeState(over) }));
  };
  const schedHistoryLastRow = (): string[] => {
    const csv = fs.readFileSync(testHistoryFile, "utf8").trim();
    return (csv.split(/\r?\n/).pop() ?? "").split(",");
  };

  // A. first call -> anchor appended, table auto-initialized (FR-012-6)
  await schedSeedState();
  await sessionStart({}, schedCtx);
  cleanWake();
  const tA0 = Date.now();
  await afterResponse({ status: 200, headers: {} }, schedCtx);
  const tA1 = Date.now();
  const tA = readWakeTable();
  assert(
    tA !== null && tA.source === "firstCall",
    "wake scheduler: first call creates the table (source=firstCall)",
  );
  assert(
    tA !== null && tA.points.length === WAKE_DEPTH,
    "wake scheduler: anchor insert + tail top-up = depth points",
  );
  assert(
    tA !== null &&
      tA.points[0] >= tA0 + W2H + WAKE_MARGIN_MS &&
      tA.points[0] <= tA1 + W2H + WAKE_MARGIN_MS,
    "wake scheduler: first point = anchor + windowMs + margin",
  );
  assert(
    tA !== null && tA.points[1] === tA.points[0] + W2H,
    "wake scheduler: top-up tail steps by windowMs",
  );
  assert(
    wakeHasRefForTests() === false,
    "wake scheduler: timer armed & unref'd after the anchor",
  );

  // B. expired window + due point -> wake fire resets with note "wake HH:MM"
  busEmits.length = 0;
  cleanWake();
  const headB = Date.now() - 60_000; // due, within the 30-min TTL
  const tailB = Date.now() + 3 * 60 * 60 * 1000;
  await mutateWakeTable(() => ({
    next: {
      version: 1,
      points: [headB, tailB],
      updatedAt: Date.now(),
      source: "firstCall",
    },
  }));
  await schedSeedState({ windowStartedAt: Date.now() - W2H - 5_000 });
  await __fireWakeForTests();
  await new Promise((r) => setTimeout(r, 150)); // appendHistory is fire-and-forget
  assert(
    busEmits.some((e) => e.ch === "billing:window_reset"),
    "wake scheduler: wake fire emits billing:window_reset",
  );
  const tB = readWakeTable();
  assert(
    tB !== null && tB.points.length === 1 && tB.points[0] === tailB,
    "wake scheduler: head consumed, tail kept",
  );
  const noteB = `wake ${String(new Date(headB).getHours()).padStart(2, "0")}:${String(new Date(headB).getMinutes()).padStart(2, "0")}`;
  const rowB = schedHistoryLastRow();
  assert(
    rowB[2] === "window_reset",
    "wake scheduler: history row kind=window_reset",
  );
  assert(
    rowB[11] === noteB,
    `wake scheduler: history note "${noteB}" (got '${rowB[11]}')`,
  );
  assert(
    wakeHasRefForTests() === false,
    "wake scheduler: re-armed at the next point after the fire",
  );

  // C. speculative point before the boundary -> no-op reset, point consumed
  busEmits.length = 0;
  cleanWake();
  const headC = Date.now() - 30_000;
  await mutateWakeTable(() => ({
    next: {
      version: 1,
      points: [headC],
      updatedAt: Date.now(),
      source: "firstCall",
    },
  }));
  await schedSeedState(); // fresh window, NOT expired
  await __fireWakeForTests();
  await new Promise((r) => setTimeout(r, 100));
  assert(
    !busEmits.some((e) => e.ch === "billing:window_reset"),
    "wake scheduler: speculative point -> no reset emit",
  );
  const tC = readWakeTable();
  assert(
    tC !== null && tC.points.length === 0,
    "wake scheduler: speculative point is still consumed",
  );
  assert(
    wakeHasRefForTests() === null,
    "wake scheduler: no timer when the table is empty",
  );

  // D. the armed setTimeout really fires (short-delay end-to-end)
  busEmits.length = 0;
  cleanWake();
  await schedSeedState({ windowStartedAt: Date.now() - W2H - 5_000 });
  const headD = Date.now() + 120;
  await mutateWakeTable(() => ({
    next: {
      version: 1,
      points: [headD],
      updatedAt: Date.now(),
      source: "firstCall",
    },
  }));
  __ensureWakeTimerForTests();
  await new Promise((r) => setTimeout(r, 600));
  assert(
    busEmits.some((e) => e.ch === "billing:window_reset"),
    "wake scheduler: armed setTimeout fires and resets the window",
  );
  const tD = readWakeTable();
  assert(
    tD !== null && tD.points.length === 0,
    "wake scheduler: timer fire consumes the point",
  );

  // E. T5: burned head (older than the 30-min TTL) -> quiet purge, no emit
  busEmits.length = 0;
  cleanWake();
  await mutateWakeTable(() => ({
    next: {
      version: 1,
      points: [Date.now() - 40 * 60_000], // burned (FR-012-10)
      updatedAt: Date.now(),
      source: "firstCall",
    },
  }));
  await schedSeedState({ windowStartedAt: Date.now() - W2H - 5_000 });
  await __wakeSyncTickForTests();
  await new Promise((r) => setTimeout(r, 100));
  assert(
    !busEmits.some((e) => e.ch === "billing:window_reset"),
    "wake sync tick: burned point purged without a reset emit",
  );
  const tE = readWakeTable();
  assert(
    tE !== null && tE.points.length === 0,
    "wake sync tick: burned point dropped from the table",
  );
  assert(
    wakeHasRefForTests() === null,
    "wake sync tick: nothing left to arm after the purge",
  );

  // F. T5: due head within the TTL -> the sync tick drives the wake path
  busEmits.length = 0;
  cleanWake();
  const headF = Date.now() - 2 * 60_000; // due, within TTL
  await mutateWakeTable(() => ({
    next: {
      version: 1,
      points: [headF],
      updatedAt: Date.now(),
      source: "firstCall",
    },
  }));
  await schedSeedState({ windowStartedAt: Date.now() - W2H - 5_000 });
  await __wakeSyncTickForTests();
  await new Promise((r) => setTimeout(r, 150));
  assert(
    busEmits.some((e) => e.ch === "billing:window_reset"),
    "wake sync tick: due point fires the reset",
  );
  const tF = readWakeTable();
  assert(
    tF !== null && tF.points.length === 0,
    "wake sync tick: due point consumed",
  );
  const noteF = `wake ${String(new Date(headF).getHours()).padStart(2, "0")}:${String(new Date(headF).getMinutes()).padStart(2, "0")}`;
  const rowF = schedHistoryLastRow();
  assert(
    rowF[2] === "window_reset" && rowF[11] === noteF,
    `wake sync tick: history note "${noteF}" (got kind='${rowF[2]}' note='${rowF[11]}')`,
  );

  // teardown: no scheduler timer may survive the block
  __stopWakeTimerForTests();
  cleanWake();
  cleanState();

  // ---- ui.ts tests ----

  console.log("\n=== UI tests ===");

  // renderStatusBar now renders the ABSOLUTE reset moment (epoch ms) as
  // "[обновится в ЧЧ:ММ]" (24h local time, zero-padded). Helper: local-time
  // epoch for a fixed wall-clock moment.
  const at = (h: number, m: number) =>
    new Date(2026, 9, 31, h, m, 0, 0).getTime();

  // 1. renderStatusBar formats the absolute reset time correctly
  assert(
    renderStatusBar(at(17, 30)) === "[обновится в 17:30]",
    "renderStatusBar: 17:30 -> '[обновится в 17:30]'",
  );
  assert(
    renderStatusBar(at(8, 5)) === "[обновится в 08:05]",
    "renderStatusBar: zero-padded 08:05",
  );
  assert(
    renderStatusBar(at(0, 0)) === "[обновится в 00:00]",
    "renderStatusBar: midnight -> 00:00",
  );
  assert(
    renderStatusBar(at(23, 59)) === "[обновится в 23:59]",
    "renderStatusBar: 23:59 (24h clock, no am/pm)",
  );
  assert(
    renderStatusBar(at(9, 7)) === "[обновится в 09:07]",
    "renderStatusBar: both parts zero-padded",
  );
  // Seconds are dropped: a reset at 17:30:45 still renders 17:30.
  assert(
    renderStatusBar(new Date(2026, 9, 31, 17, 30, 45, 0).getTime()) ===
      "[обновится в 17:30]",
    "renderStatusBar: seconds dropped (17:30:45 -> 17:30)",
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
          c.text.startsWith("[обновится в "),
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
  historyResetPaths();
  armsResetPaths();
  wakeResetPaths();
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