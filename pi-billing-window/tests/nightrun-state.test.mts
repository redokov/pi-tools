/**
 * nightrun-state.test.mts — unit-тесты runner state (spec 015, T03).
 *
 * Run: npx tsx tests/nightrun-state.test.mts
 */

import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readState,
  writeState,
  clearState,
  mutateState,
  setPaths,
  resetPaths,
  type NightRunState,
} from "../src/nightrun-state.js";

function assert(cond: boolean, name: string): void {
  if (!cond) {
    console.error(`✗ FAIL: ${name}`);
    process.exit(1);
  }
  console.log(`✓ ${name}`);
}

let tmpDir: string;
let passed = 0;

function setup(): void {
  tmpDir = mkdtempSync(join(tmpdir(), "nightrun-state-test-"));
  const stateFile = join(tmpDir, "nightrun.json");
  const lockFile = join(tmpDir, "nightrun.lock");
  setPaths(stateFile, lockFile);
}

function teardown(): void {
  resetPaths();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

function makeState(overrides: Partial<NightRunState> = {}): NightRunState {
  return {
    version: 1,
    plan: "night-2026-10-26",
    backlog: "/path/to/backlog.md",
    backlogHash: "abc123",
    currentTask: 1,
    status: "idle",
    attempt: 1,
    maxRetries: 2,
    lastResult: null,
    updatedAt: Date.now(),
    userStop: false,
    ...overrides,
  };
}

function testReadWriteRoundTrip(): void {
  const state = makeState();
  writeState(state);
  const read = readState();
  assert(read !== null, "read after write: not null");
  assert(read!.version === 1, "read: version=1");
  assert(read!.plan === state.plan, "read: plan matches");
  assert(read!.currentTask === 1, "read: currentTask=1");
  assert(read!.status === "idle", "read: status=idle");
  passed += 5;
}

function testReadNonExistent(): void {
  const read = readState();
  assert(read === null, "read non-existent: null");
  passed += 1;
}

function testClearState(): void {
  const state = makeState();
  writeState(state);
  assert(readState() !== null, "clear: state exists before");
  const cleared = clearState();
  assert(cleared === true, "clear: returns true");
  assert(readState() === null, "clear: state null after");
  passed += 3;
}

async function testMutateState(): Promise<void> {
  const state = makeState({ currentTask: 1 });
  writeState(state);

  await mutateState((cur) => {
    assert(cur !== null, "mutate: cur not null");
    assert(cur!.currentTask === 1, "mutate: cur.currentTask=1");
    return {
      next: { ...cur!, currentTask: 2, updatedAt: Date.now() },
    };
  });

  const read = readState();
  assert(read !== null, "mutate: read after mutate not null");
  assert(read!.currentTask === 2, "mutate: currentTask advanced to 2");
  passed += 4;
}

function testConcurrentWrites(): void {
  const state1 = makeState({ currentTask: 1 });
  const state2 = makeState({ currentTask: 2 });

  // Sequential writes under lock (no actual concurrency in this test,
  // but verifies atomic tmp+rename works).
  writeState(state1);
  const read1 = readState();
  assert(read1!.currentTask === 1, "concurrent: first write task=1");

  writeState(state2);
  const read2 = readState();
  assert(read2!.currentTask === 2, "concurrent: second write task=2");
  passed += 2;
}

function testRestartRecovery(): void {
  const state = makeState({
    status: "awaiting-result",
    currentTask: 3,
    attempt: 2,
  });
  writeState(state);

  // Simulate restart: read state.
  const recovered = readState();
  assert(recovered !== null, "restart: recovered not null");
  assert(recovered!.status === "awaiting-result", "restart: status preserved");
  assert(recovered!.currentTask === 3, "restart: task preserved");
  assert(recovered!.attempt === 2, "restart: attempt preserved");
  passed += 4;
}

function testDayNightIsolation(): void {
  // State file path is separate from daytime state (pi-billing-window.json).
  // This test just verifies the file is written to the correct path.
  const state = makeState();
  writeState(state);
  const stateFile = join(tmpDir, "nightrun.json");
  assert(existsSync(stateFile), "isolation: nightrun.json exists");
  // No cross-contamination with daytime state (different file).
  passed += 1;
}

function testCorruptedState(): void {
  const stateFile = join(tmpDir, "nightrun-corrupt.json");
  setPaths(stateFile, join(tmpDir, "nightrun-corrupt.lock"));
  // Битый JSON -> null (толерантное чтение, никогда не бросает).
  writeFileSync(stateFile, "{ это не json", "utf8");
  assert(readState() === null, "corrupted: broken JSON -> null");
  // Чужая схема -> null.
  writeFileSync(stateFile, JSON.stringify({ foo: "bar" }), "utf8");
  assert(readState() === null, "corrupted: foreign schema -> null");
  // Валидный JSON без обязательных полей -> null.
  writeFileSync(stateFile, JSON.stringify({ version: 99 }), "utf8");
  assert(readState() === null, "corrupted: wrong version -> null");
  passed += 3;
  // Вернуть пути основного сценария.
  setPaths(join(tmpDir, "nightrun.json"), join(tmpDir, "nightrun.lock"));
}

async function main(): Promise<void> {
  setup();
  try {
    testReadNonExistent();
    testReadWriteRoundTrip();
    testClearState();
    await testMutateState();
    testConcurrentWrites();
    testRestartRecovery();
    testDayNightIsolation();
    testCorruptedState();
    console.log(`\n✓✓✓ nightrun-state: ${passed} passed, 0 failed`);
  } finally {
    teardown();
  }
}

void main();
