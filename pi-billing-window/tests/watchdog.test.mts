/**
 * watchdog.test.mts -- unit tests for the one-shot watchdog timer.
 *
 * Run: npx tsx tests/watchdog.test.mts
 *
 * Uses short delays (20-40 ms) and awaits real timers via promises.
 */

import {
  computeFireAt,
  armWatchdog,
  clearWatchdog,
  hasWatchdog,
  pendingFireAt,
} from "../src/watchdog.ts";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  // ---- computeFireAt: correct addition ----
  {
    const fireAt = computeFireAt({ windowStartedAt: 1000, windowMs: 2000 });
    assert(fireAt === 3000, "computeFireAt adds windowStartedAt + windowMs");
  }

  // ---- armWatchdog: cb fires at scheduled moment ----
  {
    const fired = { v: false };
    const fireAt = Date.now() + 30;
    armWatchdog(fireAt, () => {
      fired.v = true;
    });
    assert(hasWatchdog() === true, "hasWatchdog true right after arm");
    assert(pendingFireAt() === fireAt, "pendingFireAt returns armed fireAt");
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    assert(fired.v === true, "cb fired after delay elapsed");
    assert(hasWatchdog() === false, "hasWatchdog false after fire");
    assert(pendingFireAt() === null, "pendingFireAt null after fire");
  }

  // ---- re-arm replaces the previous timer ----
  {
    const firstFired = { v: false };
    const secondFired = { v: false };
    armWatchdog(Date.now() + 80, () => {
      firstFired.v = true;
    });
    const fireAt = Date.now() + 30;
    armWatchdog(fireAt, () => {
      secondFired.v = true;
    });
    assert(pendingFireAt() === fireAt, "re-arm updates pendingFireAt");
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    assert(firstFired.v === false, "first cb NOT called after re-arm");
    assert(secondFired.v === true, "second cb fired after re-arm");
  }

  // ---- fireAt in the past: cb fires immediately (delay 0) ----
  {
    const fired = { v: false };
    armWatchdog(Date.now() - 5000, () => {
      fired.v = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert(fired.v === true, "cb fired immediately for past fireAt");
  }

  // ---- clearWatchdog cancels the timer ----
  {
    const fired = { v: false };
    armWatchdog(Date.now() + 30, () => {
      fired.v = true;
    });
    clearWatchdog();
    assert(hasWatchdog() === false, "hasWatchdog false after clear");
    assert(pendingFireAt() === null, "pendingFireAt null after clear");
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    assert(fired.v === false, "cb NOT called after clearWatchdog");
  }

  // ---- clearWatchdog with no timer: no throw, idempotent ----
  {
    let threw = false;
    try {
      clearWatchdog();
      clearWatchdog();
    } catch {
      threw = true;
    }
    assert(threw === false, "clearWatchdog without timer does not throw");
  }

  for (const line of results) {
    console.log(line);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
