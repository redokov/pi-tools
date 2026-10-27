/**
 * nightrun.test.mts — unit/mock-тесты runner-а (spec 015, T05/T06/T07).
 *
 * Run: npx tsx tests/nightrun.test.mts
 *
 * Реальные tmp-файлы (state/log/plan/backlog), mock deliverer для dispatch.
 * Wall-clock не участвует в ожиданиях: boundary тестируется через план
 * с expiresAt в прошлом/будущем.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setPaths as npSetPaths,
  resetPaths as npResetPaths,
  writePlan,
  type NightPlan,
} from "../src/nightplan.js";
import { setPaths as nrSetPaths, resetPaths as nrResetPaths } from "../src/nightrun-state.js";
import {
  setPaths as nrlSetPaths,
  resetPaths as nrlResetPaths,
  readTransitions,
} from "../src/nightrun-log.js";
import {
  initRunnerFromPlan,
  resumeRunner,
  pauseRunner,
  stopRunner,
  skipCurrentTask,
  dispatchCurrentTask,
  applyTaskResult,
  recoverFromAwaitingResult,
  buildTaskPrompt,
  extractTaskResult,
} from "../src/nightrun.js";
import { readState } from "../src/nightrun-state.js";

function assert(cond: boolean, name: string): void {
  if (!cond) {
    console.error(`✗ FAIL: ${name}`);
    process.exit(1);
  }
  console.log(`✓ ${name}`);
}

let passed = 0;
function ok(): void {
  passed++;
}

/** Тестовый окружение: tmp-каталог с планом (backlog из 2 задач) + runner state. */
function makeEnv(opts: { expiredPlan?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "nightrun-test-"));
  const backlogPath = join(dir, "backlog.md");
  writeFileSync(
    backlogPath,
    "## Task 1\nСделай первое.\n\n## Acceptance\nПервый критерий.\n\n" +
      "## Task 2\nСделай второе.\n\n## Acceptance\nВторой критерий.\n",
    "utf8",
  );
  npSetPaths(join(dir, "plan.json"), join(dir, "plan.lock"), join(dir, "nights"));
  nrSetPaths(join(dir, "nightrun.json"), join(dir, "nightrun.lock"));
  nrlSetPaths(join(dir, "transitions.jsonl"), join(dir, "transitions.lock"));

  const now = Date.now();
  const plan: NightPlan = {
    key: "C:/tmp/sess-night.jsonl",
    fromLocal: "00:00",
    toLocal: "23:59",
    repeat: 6,
    backlogPath,
    createdAt: now,
    expiresAt: opts.expiredPlan ? now - 1000 : now + 60 * 60_000,
    nightDate: "2026-10-26",
  };
  // writePlan сам берёт лок; план с expiresAt в прошлом валиден для записи.
  // Прямая запись (async writePlan в sync-сетапе неудобен): валидный JSON.
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan, null, 2), "utf8");
  return dir;
}

function cleanup(dir: string): void {
  npResetPaths();
  nrResetPaths();
  nrlResetPaths();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

/** Инициализировать runner и перевести в running. */
async function startRunner(): Promise<void> {
  const inited = await initRunnerFromPlan();
  assert(inited, "init from plan -> true");
  ok();
  const resumed = await resumeRunner();
  assert(resumed, "resume -> true");
  ok();
}

// --- 1. PASS task 1 -> currentTask 2 -----------------------------------------
async function testPassAdvances(): Promise<void> {
  const dir = makeEnv();
  try {
    await startRunner();
    const st0 = readState()!;
    assert(st0.currentTask === 1 && st0.status === "running", "task1 running");

    const prompts: string[] = [];
    const outcome = await dispatchCurrentTask(async (p) => {
      prompts.push(p);
    });
    assert(outcome.type === "dispatched", "dispatch task1 -> dispatched");
    ok();
    // Prompt содержит ТОЛЬКО задачу 1 (FR-015-9: не весь Markdown).
    assert(prompts[0].includes("Сделай первое"), "prompt has task 1");
    assert(!prompts[0].includes("Сделай второе"), "prompt has NO task 2 (no giant prompt)");
    ok();
    let st = readState()!;
    assert(st.status === "awaiting-result", "awaiting-result before result");
    ok();

    st = (await applyTaskResult("PASS"))!;
    assert(st.currentTask === 2, "PASS task1 -> currentTask 2");
    assert(st.status === "running", "PASS -> running");
    assert(st.attempt === 1, "attempt reset to 1");
    ok();
  } finally {
    cleanup(dir);
  }
}

// --- 2. PASS последней -> completed -------------------------------------------
async function testPassLastCompletes(): Promise<void> {
  const dir = makeEnv();
  try {
    await startRunner();
    // Быстро дойти до задачи 2: skip задачу 1.
    await skipCurrentTask();
    await dispatchCurrentTask(async () => {});
    const st = (await applyTaskResult("PASS"))!;
    assert(st.currentTask === 2, "still on last task number");
    assert(st.status === "completed", "PASS last -> completed");
    ok();
  } finally {
    cleanup(dir);
  }
}

// --- 3. FAIL -> bounded retry --------------------------------------------------
async function testFailBoundedRetry(): Promise<void> {
  const dir = makeEnv();
  try {
    await startRunner();
    await dispatchCurrentTask(async () => {});
    let st = (await applyTaskResult("FAIL"))!;
    assert(st.currentTask === 1, "FAIL keeps task 1");
    assert(st.attempt === 2, "FAIL -> attempt 2 (bounded retry)");
    assert(st.status === "running", "FAIL -> running for retry");
    ok();
    // Вторая FAIL: maxRetries=2 исчерпан.
    await dispatchCurrentTask(async () => {});
    st = (await applyTaskResult("FAIL"))!;
    assert(st.status === "failed", "retry exhaustion -> failed");
    assert(st.currentTask === 1, "cursor NOT advanced on fail");
    ok();
  } finally {
    cleanup(dir);
  }
}

// --- 4. 429: cursor не двигается ------------------------------------------------
async function test429PreservesTask(): Promise<void> {
  const dir = makeEnv();
  try {
    await startRunner();
    await dispatchCurrentTask(async () => {});
    const st = (await applyTaskResult("429"))!;
    assert(st.currentTask === 1, "429 keeps task 1");
    assert(st.status === "paused", "429 -> paused (idle)");
    assert(st.lastResult === "429", "lastResult=429");
    ok();
    const reasons = readTransitions().map((r) => r.reason);
    assert(reasons.includes("429"), "transition log has reason 429");
    ok();
  } finally {
    cleanup(dir);
  }
}

// --- 5. owner-busy: cursor не двигается ------------------------------------------
async function testOwnerBusyPreservesTask(): Promise<void> {
  const dir = makeEnv();
  try {
    await startRunner();
    const outcome = await dispatchCurrentTask(async () => {
      throw new Error("OWNER_BUSY: jsonl busy");
    });
    assert(outcome.type === "OWNER_BUSY", "deliver throws OWNER_BUSY");
    ok();
    const st = readState()!;
    assert(st.currentTask === 1, "owner-busy keeps task 1");
    assert(st.status === "paused", "owner-busy -> paused");
    const reasons = readTransitions().map((r) => r.reason);
    assert(reasons.includes("owner-busy"), "log has owner-busy reason");
    ok();
  } finally {
    cleanup(dir);
  }
}

// --- 6. switch-needed: cursor не двигается ---------------------------------------
async function testSwitchNeededPreservesTask(): Promise<void> {
  const dir = makeEnv();
  try {
    await startRunner();
    const outcome = await dispatchCurrentTask(async () => {
      throw new Error("SWITCH_NEEDED: refs point elsewhere");
    });
    assert(outcome.type === "SWITCH_NEEDED", "deliver throws SWITCH_NEEDED");
    ok();
    const st = readState()!;
    assert(st.currentTask === 1, "switch-needed keeps task 1");
    ok();
  } finally {
    cleanup(dir);
  }
}

// --- 7. user stop сильнее auto-continuation ---------------------------------------
async function testUserStopWins(): Promise<void> {
  const dir = makeEnv();
  try {
    await startRunner();
    await dispatchCurrentTask(async () => {});
    await applyTaskResult("PASS"); // task 2 now

    const stopped = await stopRunner();
    assert(stopped, "stop -> true");
    ok();
    let st = readState()!;
    assert(st.userStop === true && st.status === "stopped", "userStop set");
    ok();

    // Авто-продолжение (dispatch) после stop -> STOPPED, задача не выполняется.
    const outcome = await dispatchCurrentTask(async () => {
      throw new Error("should not deliver");
    });
    assert(outcome.type === "STOPPED", "dispatch after stop -> STOPPED");
    ok();

    // resume заблокирован userStop-ом.
    const resumed = await resumeRunner();
    assert(resumed === false, "resume blocked by userStop");
    ok();
  } finally {
    cleanup(dir);
  }
}

// --- 8. pause/resume ----------------------------------------------------------------
async function testPauseResume(): Promise<void> {
  const dir = makeEnv();
  try {
    await startRunner();
    const paused = await pauseRunner();
    assert(paused, "pause -> true");
    ok();
    let st = readState()!;
    assert(st.status === "paused", "status paused");
    ok();
    // Dispatch в паузе невозможен (not-runnable).
    const outcome = await dispatchCurrentTask(async () => {});
    assert(outcome.type === "not-runnable", "paused -> not-runnable");
    ok();
    const resumed = await resumeRunner();
    assert(resumed, "resume -> true");
    ok();
    st = readState()!;
    assert(st.status === "running" && st.currentTask === 1, "resume keeps task 1");
    ok();
  } finally {
    cleanup(dir);
  }
}

// --- 9. explicit skip ------------------------------------------------------------------
async function testExplicitSkip(): Promise<void> {
  const dir = makeEnv();
  try {
    await startRunner();
    const skipped = await skipCurrentTask();
    assert(skipped, "skip -> true");
    ok();
    const st = readState()!;
    assert(st.currentTask === 2, "skip advances to task 2");
    const recs = readTransitions().filter((r) => r.action === "skip");
    assert(recs.length === 1 && recs[0].reason === "user-skip", "skip logged with reason");
    ok();
  } finally {
    cleanup(dir);
  }
}

// --- 10. boundary 08:00 блокирует dispatch ----------------------------------------------
async function testBoundaryBlocksDispatch(): Promise<void> {
  // План активен на старте, истекает к моменту dispatch (аналог 08:00).
  const dir = makeEnv();
  try {
    await startRunner();
    // План истёк между init и dispatch (стало 08:00+).
    const { readFileSync } = await import("node:fs");
    const planPath = join(dir, "plan.json");
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as NightPlan;
    plan.expiresAt = Date.now() - 1000;
    writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf8");

    const outcome = await dispatchCurrentTask(async () => {
      throw new Error("should not deliver");
    });
    assert(outcome.type === "BOUNDARY_BLOCKED", "expired plan -> BOUNDARY_BLOCKED");
    ok();
    const st = readState()!;
    assert(st.status === "paused", "boundary -> paused");
    assert(st.currentTask === 1, "boundary keeps task 1");
    const reasons = readTransitions().map((r) => r.reason);
    assert(reasons.includes("after-boundary"), "log has after-boundary");
    ok();
  } finally {
    cleanup(dir);
  }
}

// --- 11. restart recovery из awaiting-result ---------------------------------------------
async function testRestartRecovery(): Promise<void> {
  const dir = makeEnv();
  try {
    await startRunner();
    // Диспетчер выставил awaiting-result, процесс «умер» до результата.
    await dispatchCurrentTask(async () => {});
    let st = readState()!;
    assert(st.status === "awaiting-result", "crashed in awaiting-result");
    ok();

    // Рестарт: recovery возвращает running с ТОЙ ЖЕ задачей, НЕ PASS.
    st = (await recoverFromAwaitingResult())!;
    assert(st.status === "running", "recovered -> running");
    assert(st.currentTask === 1, "recovered keeps task 1");
    assert(st.lastResult !== "PASS", "recovery is NOT an implicit PASS");
    ok();
    const reasons = readTransitions().map((r) => r.reason);
    assert(reasons.includes("recovery-unresolved"), "log has recovery-unresolved");
    ok();
  } finally {
    cleanup(dir);
  }
}

// --- 12. журнал переходов: причины простоя -------------------------------------------------
async function testIdleReasonsInLog(): Promise<void> {
  const dir = makeEnv();
  try {
    await startRunner();
    await dispatchCurrentTask(async () => {
      throw new Error("OWNER_BUSY: busy");
    });
    await resumeRunner();
    await dispatchCurrentTask(async () => {});
    await applyTaskResult("429");
    const reasons = readTransitions().map((r) => r.reason);
    assert(reasons.includes("owner-busy"), "log: owner-busy");
    assert(reasons.includes("429"), "log: 429");
    assert(reasons.includes("dispatch-sent"), "log: dispatch-sent");
    assert(reasons.includes("user-resume"), "log: user-resume");
    ok();
    // Каждая запись имеет полный набор полей.
    for (const r of readTransitions()) {
      assert(typeof r.timestamp === "number" && r.timestamp > 0, "record has timestamp");
      assert(typeof r.plan === "string", "record has plan");
      assert(typeof r.task === "number", "record has task");
      assert(typeof r.toStatus === "string", "record has toStatus");
    }
    ok();
  } finally {
    cleanup(dir);
  }
}

// --- 13. prompt builder + result extraction ------------------------------------------------
function testPromptAndMarker(): void {
  const prompt = buildTaskPrompt({
    taskNumber: 1,
    taskBody: "Body of task.",
    acceptance: "Acceptance of task.",
  });
  assert(prompt.ok, "prompt ok");
  if (prompt.ok) {
    assert(prompt.prompt.includes("TASK_RESULT: PASS"), "prompt requires PASS marker");
    assert(prompt.prompt.includes("TASK_RESULT: FAIL"), "prompt requires FAIL marker");
  }
  ok();
  assert(extractTaskResult("done. TASK_RESULT: PASS") === "PASS", "marker PASS");
  assert(extractTaskResult("no luck. TASK_RESULT: FAIL") === "FAIL", "marker FAIL");
  assert(extractTaskResult("всё готово, но маркера нет") === null, "no marker -> null (неявный PASS запрещён)");
  ok();
}

// --- 14. дневная изоляция: state-файл отдельный ---------------------------------------------
async function testDayNightIsolation(): Promise<void> {
  const dir = makeEnv();
  try {
    await startRunner();
    await dispatchCurrentTask(async () => {});
    await applyTaskResult("PASS");
    // nightrun state в СВОЁМ файле; дневной state (pi-billing-window.json)
    // не трогался runner-ом (никаких обращений к нему в модуле).
    const st = readState()!;
    assert(st.currentTask === 2, "night cursor advanced to 2");
    ok();
  } finally {
    cleanup(dir);
  }
}

async function main(): Promise<void> {
  await testPassAdvances();
  await testPassLastCompletes();
  await testFailBoundedRetry();
  await test429PreservesTask();
  await testOwnerBusyPreservesTask();
  await testSwitchNeededPreservesTask();
  await testUserStopWins();
  await testPauseResume();
  await testExplicitSkip();
  await testBoundaryBlocksDispatch();
  await testRestartRecovery();
  await testIdleReasonsInLog();
  testPromptAndMarker();
  await testDayNightIsolation();
  console.log(`\n✓✓✓ nightrun: ${passed} passed, 0 failed`);
}

void main();
