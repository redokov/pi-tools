/**
 * exit-hygiene.test.mts -- every test suite must EXIT its process (spec 003).
 *
 * Run: npx tsx tests/exit-hygiene.test.mts
 *
 * Two layers:
 *  1. unit: the extension's periodic intervals (ticker.ts, ui.ts) must NOT
 *     keep the event loop alive on their own (unref parity with the
 *     watchdog timers in index.ts). Checked via hasRefForTests() probes.
 *  2. e2e: spawn every existing suite with the tsx CLI and require exit
 *     code 0 within a timeout. The incident (2026-09-27): replacement
 *     .test.mts printed "8 passed, 0 failed" but never exited -- a
 *     statusUpdater interval kept the loop alive after the race-guard
 *     (correctly) skipped a stale-ctx teardown.
 *
 * This meta-suite never spawns itself.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";

import * as ticker from "../src/ticker.ts";
import * as ui from "../src/ui.ts";

// --- tiny assert harness (tests/*.test.mts house style) ----------------------

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

// --- 1. unit: unref contract on the periodic intervals -----------------------

/**
 * The unref parity contract: like the watchdog timers in index.ts, the
 * ticker and statusUpdater intervals must not keep a (test) process alive
 * once nothing else references the loop. hasRefForTests() returns null
 * when the interval is not running.
 */
function unitUnrefContract(): void {
  ticker.startTicker(() => {});
  assert(
    ticker.hasRefForTests() === false,
    "unit: ticker interval unref (hasRef false после startTicker)",
  );
  ticker.stopTicker();
  assert(
    ticker.hasRefForTests() === null,
    "unit: ticker interval очищен после stopTicker",
  );

  const stop = ui.startStatusUpdater({
    mode: "tui",
    ui: { setStatus: () => {} },
  });
  assert(
    ui.hasRefForTests() === false,
    "unit: statusUpdater interval unref (hasRef false после start)",
  );
  stop();
  assert(
    ui.hasRefForTests() === null,
    "unit: statusUpdater interval очищен после stop",
  );
}

// --- 2. e2e: every suite exits with code 0 -------------------------------------

const SUITES = [
  "test",
  "arms",
  "history",
  "lifecycle",
  "watchdog",
  "watchdog.e2e",
  "replacement",
  "stale-capitulation",
  "pending-window-retry",
  "attribution",
  "session-isolation",
  "firelease",
  "firelease.e2e",
] as const;

const SPAWN_TIMEOUT_MS = 120_000;

/** The main suite is `test.mts`; every other suite is `<name>.test.mts`. */
function suitePath(suite: string): string {
  return suite === "test" ? "tests/test.mts" : `tests/${suite}.test.mts`;
}
const tsxCli = join(
  process.cwd(),
  "node_modules",
  "tsx",
  "dist",
  "cli.mjs",
);

/**
 * Spawn one suite with the tsx CLI and resolve its exit code.
 * -1 = timed out (the bug this suite regresses).
 */
function runSuite(suite: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [tsxCli, suitePath(suite)],
      { timeout: SPAWN_TIMEOUT_MS, cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.killed) {
          console.error(
            `[exit-hygiene] ${suite}: TIMEOUT после ${Math.round(SPAWN_TIMEOUT_MS / 1000)} с; stdout tail:\n${stdout.slice(-600)}\nstderr tail:\n${stderr.slice(-600)}`,
          );
          resolve(-1);
          return;
        }
        if (err && typeof err.code === "number") {
          console.error(
            `[exit-hygiene] ${suite}: exit ${err.code}; stdout tail:\n${stdout.slice(-600)}\nstderr tail:\n${stderr.slice(-600)}`,
          );
          resolve(err.code);
          return;
        }
        if (err) {
          console.error(`[exit-hygiene] ${suite}: spawn error: ${err.message}`);
          resolve(1);
          return;
        }
        resolve(0);
      },
    );
  });
}

// --- runner ---------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    "\n=== Exit-hygiene tests (suite completion / unref parity, spec 003) ===",
  );

  unitUnrefContract();

  for (const suite of SUITES) {
    const code = await runSuite(suite);
    assert(
      code === 0,
      `e2e: сьют ${suite} завершается exit 0 (got ${code})`,
    );
  }

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
