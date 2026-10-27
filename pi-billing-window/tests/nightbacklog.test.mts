/**
 * nightbacklog.test.mts — unit-тесты backlog parser (spec 015, T02).
 *
 * Run: npx tsx tests/nightbacklog.test.mts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBacklog } from "../src/nightbacklog.js";

function assert(cond: boolean, name: string): void {
  if (!cond) {
    console.error(`✗ FAIL: ${name}`);
    process.exit(1);
  }
  console.log(`✓ ${name}`);
}

let tmpDir: string;
let passed = 0;
let failed = 0;

function setup(): void {
  tmpDir = mkdtempSync(join(tmpdir(), "nightbacklog-test-"));
}

function teardown(): void {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

function testTwoTasksValid(): void {
  const backlogPath = join(tmpDir, "backlog-two.md");
  const content = `## Task 1
First task body.

## Acceptance
First acceptance.

## Task 2
Second task body.

## Acceptance
Second acceptance.`;
  writeFileSync(backlogPath, content, "utf8");

  const result = parseBacklog(backlogPath);
  assert(result.ok === true, "two tasks: ok=true");
  if (!result.ok) return;
  assert(result.tasks.length === 2, "two tasks: count=2");
  assert(result.tasks[0].taskNumber === 1, "task 1 number");
  assert(result.tasks[0].taskBody.includes("First task"), "task 1 body");
  assert(
    result.tasks[0].acceptance.includes("First acceptance"),
    "task 1 acceptance",
  );
  assert(result.tasks[1].taskNumber === 2, "task 2 number");
  assert(result.tasks[1].taskBody.includes("Second task"), "task 2 body");
  assert(
    result.tasks[1].acceptance.includes("Second acceptance"),
    "task 2 acceptance",
  );
  assert(typeof result.hash === "string" && result.hash.length > 0, "hash present");
  passed += 8;
}

function testMissingAcceptance(): void {
  const backlogPath = join(tmpDir, "backlog-missing-acceptance.md");
  const content = `## Task 1
Task without acceptance.`;
  writeFileSync(backlogPath, content, "utf8");

  const result = parseBacklog(backlogPath);
  assert(result.ok === false, "missing acceptance: ok=false");
  if (result.ok) return;
  assert(
    result.error.includes("no Acceptance"),
    "missing acceptance: error mentions acceptance",
  );
  passed += 2;
}

function testDuplicateTask(): void {
  const backlogPath = join(tmpDir, "backlog-duplicate.md");
  const content = `## Task 1
First.
## Acceptance
First acc.
## Task 1
Duplicate.
## Acceptance
Dup acc.`;
  writeFileSync(backlogPath, content, "utf8");

  const result = parseBacklog(backlogPath);
  assert(result.ok === false, "duplicate task: ok=false");
  if (result.ok) return;
  assert(
    result.error.includes("Duplicate"),
    "duplicate task: error mentions duplicate",
  );
  passed += 2;
}

function testNonSequential(): void {
  const backlogPath = join(tmpDir, "backlog-nonseq.md");
  const content = `## Task 1
First.
## Acceptance
First acc.
## Task 3
Skipped 2.
## Acceptance
Third acc.`;
  writeFileSync(backlogPath, content, "utf8");

  const result = parseBacklog(backlogPath);
  assert(result.ok === false, "non-sequential: ok=false");
  if (result.ok) return;
  assert(
    result.error.includes("not sequential"),
    "non-sequential: error mentions sequential",
  );
  passed += 2;
}

function testOversizedBacklog(): void {
  const backlogPath = join(tmpDir, "backlog-oversized.md");
  // 3 MB content (exceeds MAX_BACKLOG_SIZE=2MB).
  const huge = "x".repeat(3 * 1024 * 1024);
  const content = `## Task 1\n${huge}\n## Acceptance\nAcc.`;
  writeFileSync(backlogPath, content, "utf8");

  const result = parseBacklog(backlogPath);
  assert(result.ok === false, "oversized backlog: ok=false");
  if (result.ok) return;
  assert(
    result.error.includes("too large"),
    "oversized backlog: error mentions size",
  );
  passed += 2;
}

function testOversizedTask(): void {
  const backlogPath = join(tmpDir, "backlog-oversized-task.md");
  // Task body 70KB (exceeds MAX_TASK_SIZE=64KB).
  const huge = "y".repeat(70 * 1024);
  const content = `## Task 1\n${huge}\n## Acceptance\nAcc.`;
  writeFileSync(backlogPath, content, "utf8");

  const result = parseBacklog(backlogPath);
  assert(result.ok === false, "oversized task: ok=false");
  if (result.ok) return;
  assert(
    result.error.includes("too large"),
    "oversized task: error mentions size",
  );
  passed += 2;
}

function testNoTasks(): void {
  const backlogPath = join(tmpDir, "backlog-empty.md");
  const content = "Some text without tasks.";
  writeFileSync(backlogPath, content, "utf8");

  const result = parseBacklog(backlogPath);
  assert(result.ok === false, "no tasks: ok=false");
  if (result.ok) return;
  assert(
    result.error.includes("No tasks found"),
    "no tasks: error mentions no tasks",
  );
  passed += 2;
}

function testAcceptanceWithoutTask(): void {
  const backlogPath = join(tmpDir, "backlog-orphan-acceptance.md");
  const content = `## Acceptance\nOrphan acceptance.`;
  writeFileSync(backlogPath, content, "utf8");

  const result = parseBacklog(backlogPath);
  assert(result.ok === false, "orphan acceptance: ok=false");
  if (result.ok) return;
  assert(
    result.error.includes("without preceding Task"),
    "orphan acceptance: error mentions preceding",
  );
  passed += 2;
}

function main(): void {
  setup();
  try {
    testTwoTasksValid();
    testMissingAcceptance();
    testDuplicateTask();
    testNonSequential();
    testOversizedBacklog();
    testOversizedTask();
    testNoTasks();
    testAcceptanceWithoutTask();
    console.log(`\n✓✓✓ nightbacklog: ${passed} passed, ${failed} failed`);
  } finally {
    teardown();
  }
}

main();
