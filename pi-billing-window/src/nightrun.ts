/**
 * nightrun.ts — backlog runner for /night-run (spec 015).
 *
 * Выполняет задачи из Markdown backlog последовательно, одну за раз.
 * Dispatch через существующую инфраструктуру (owner/session gates, fire lease,
 * verifyDelivered). Классификация результатов: PASS/FAIL/429/OWNER_BUSY/
 * SWITCH_NEEDED/STOPPED/BOUNDARY_BLOCKED/AWAITING_RESULT. Никогда не отправляет
 * весь Markdown целиком.
 */

import * as fs from "node:fs";
import { parseBacklog, type BacklogTask } from "./nightbacklog.js";
import {
  readState,
  writeState,
  clearState,
  mutateState,
  type NightRunState,
  type NightRunStatus,
  type NightRunResult,
} from "./nightrun-state.js";
import {
  appendTransition,
  type TransitionAction,
  type TransitionReason,
} from "./nightrun-log.js";
import { readPlan, inInterval } from "./nightplan.js";
import { armsLog } from "./armslog.js";

/** Максимальный размер prompt для одной задачи (байт). */
const MAX_TASK_PROMPT_SIZE = 16 * 1024; // 16 KB

/** Default max retries per task. */
const DEFAULT_MAX_RETRIES = 2;

/**
 * Инициализировать runner state из активного плана с backlog.
 * Возвращает false если план отсутствует, истёк, или backlog невалиден.
 */
export async function initRunnerFromPlan(): Promise<boolean> {
  const plan = readPlan();
  if (!plan) {
    armsLog("night-run:init-no-plan", "нет активного плана");
    return false;
  }
  if (Date.now() > plan.expiresAt) {
    armsLog("night-run:init-expired", `план истёк ${new Date(plan.expiresAt).toISOString()}`);
    return false;
  }
  if (!plan.backlogPath) {
    armsLog("night-run:init-no-backlog", "backlog не указан в плане");
    return false;
  }

  const parseResult = parseBacklog(plan.backlogPath);
  if (!parseResult.ok) {
    armsLog("night-run:init-parse-fail", parseResult.error);
    await appendTransition({
      timestamp: Date.now(),
      plan: plan.nightDate,
      task: 0,
      fromStatus: null,
      toStatus: "failed",
      action: "init",
      reason: "backlog-invalid",
      attempt: 0,
      result: null,
    });
    return false;
  }

  const state: NightRunState = {
    version: 1,
    plan: plan.nightDate,
    backlog: plan.backlogPath,
    backlogHash: parseResult.hash,
    currentTask: 1,
    status: "idle",
    attempt: 1,
    maxRetries: DEFAULT_MAX_RETRIES,
    lastResult: null,
    updatedAt: Date.now(),
    userStop: false,
  };

  await mutateState(() => ({ next: state }));
  await appendTransition({
    timestamp: Date.now(),
    plan: state.plan,
    task: state.currentTask,
    fromStatus: null,
    toStatus: "idle",
    action: "init",
    reason: "user-init",
    attempt: 1,
    result: null,
  });
  armsLog(
    "night-run:init",
    `plan=${state.plan} backlog=${state.backlog} tasks=${parseResult.tasks.length}`,
  );
  return true;
}

/**
 * Возобновить runner (из idle/paused). Transition в running.
 */
export async function resumeRunner(): Promise<boolean> {
  const st = readState();
  if (!st) {
    armsLog("night-run:resume-no-state", "state отсутствует");
    return false;
  }
  if (st.userStop) {
    armsLog("night-run:resume-stopped", "user stop активен, resume заблокирован");
    return false;
  }
  if (st.status === "completed" || st.status === "failed") {
    armsLog("night-run:resume-terminal", `status=${st.status}, resume impossible`);
    return false;
  }

  const fromStatus = st.status;
  await mutateState((cur) => {
    if (!cur) return { next: null };
    return {
      next: { ...cur, status: "running", updatedAt: Date.now() },
    };
  });
  await appendTransition({
    timestamp: Date.now(),
    plan: st.plan,
    task: st.currentTask,
    fromStatus,
    toStatus: "running",
    action: "resume",
    reason: "user-resume",
    attempt: st.attempt,
    result: st.lastResult,
  });
  armsLog("night-run:resume", `task=${st.currentTask} attempt=${st.attempt}`);
  return true;
}

/**
 * Пауза runner (running → paused).
 */
export async function pauseRunner(): Promise<boolean> {
  const st = readState();
  if (!st) return false;
  if (st.status !== "running" && st.status !== "awaiting-result") {
    armsLog("night-run:pause-not-running", `status=${st.status}, pause no-op`);
    return false;
  }

  const fromStatus = st.status;
  await mutateState((cur) => {
    if (!cur) return { next: null };
    return {
      next: { ...cur, status: "paused", updatedAt: Date.now() },
    };
  });
  await appendTransition({
    timestamp: Date.now(),
    plan: st.plan,
    task: st.currentTask,
    fromStatus,
    toStatus: "paused",
    action: "pause",
    reason: "user-pause",
    attempt: st.attempt,
    result: st.lastResult,
  });
  armsLog("night-run:pause", `task=${st.currentTask}`);
  return true;
}

/**
 * Остановить runner (любой → stopped). User stop сильнее auto-continuation.
 */
export async function stopRunner(): Promise<boolean> {
  const st = readState();
  if (!st) return false;

  const fromStatus = st.status;
  await mutateState((cur) => {
    if (!cur) return { next: null };
    return {
      next: {
        ...cur,
        status: "stopped",
        userStop: true,
        updatedAt: Date.now(),
      },
    };
  });
  await appendTransition({
    timestamp: Date.now(),
    plan: st.plan,
    task: st.currentTask,
    fromStatus,
    toStatus: "stopped",
    action: "stop",
    reason: "user-stop",
    attempt: st.attempt,
    result: st.lastResult,
  });
  armsLog("night-run:stop", `task=${st.currentTask}`);
  return true;
}

/**
 * Skip текущую задачу (explicit user action). Продвигает currentTask.
 */
export async function skipCurrentTask(): Promise<boolean> {
  const st = readState();
  if (!st) return false;
  if (st.status === "completed" || st.status === "failed") {
    armsLog("night-run:skip-terminal", `status=${st.status}, skip impossible`);
    return false;
  }

  const parseResult = parseBacklog(st.backlog);
  if (!parseResult.ok) {
    armsLog("night-run:skip-parse-fail", parseResult.error);
    return false;
  }

  const nextTask = st.currentTask + 1;
  const isLast = nextTask > parseResult.tasks.length;
  const newStatus: NightRunStatus = isLast ? "completed" : st.status;

  await mutateState((cur) => {
    if (!cur) return { next: null };
    return {
      next: {
        ...cur,
        currentTask: isLast ? cur.currentTask : nextTask,
        status: newStatus,
        attempt: 1,
        lastResult: null,
        updatedAt: Date.now(),
      },
    };
  });
  await appendTransition({
    timestamp: Date.now(),
    plan: st.plan,
    task: st.currentTask,
    fromStatus: st.status,
    toStatus: newStatus,
    action: "skip",
    reason: "user-skip",
    attempt: st.attempt,
    result: null,
  });
  armsLog(
    "night-run:skip",
    `task=${st.currentTask} skipped, next=${isLast ? "completed" : nextTask}`,
  );
  return true;
}

/**
 * Получить статус runner-а.
 */
export function getRunnerStatus(): {
  active: boolean;
  state: NightRunState | null;
  taskCount: number;
} {
  const st = readState();
  if (!st) return { active: false, state: null, taskCount: 0 };

  const parseResult = parseBacklog(st.backlog);
  const taskCount = parseResult.ok ? parseResult.tasks.length : 0;

  return {
    active: st.status === "running" || st.status === "awaiting-result",
    state: st,
    taskCount,
  };
}

/**
 * Проверка boundary (08:00 в плане). Возвращает true если dispatch заблокирован.
 */
export function isBoundaryBlocked(): boolean {
  const plan = readPlan();
  if (!plan) return true; // нет плана → блокировка
  const now = Date.now();
  if (now > plan.expiresAt) return true; // план истёк
  // inInterval проверяет, находимся ли мы в интервале fromLocal–toLocal.
  // Если мы ВНЕ интервала (т.е. после toLocal), то boundary достигнут.
  const inside = inInterval(now, plan.fromLocal, plan.toLocal);
  return !inside; // вне интервала → блокировка
}

/**
 * Построить prompt для одной задачи. Если oversized, возвращает error.
 */
export function buildTaskPrompt(
  task: BacklogTask,
): { ok: true; prompt: string } | { ok: false; error: string } {
  const prompt =
    `# Task ${task.taskNumber}\n\n${task.taskBody}\n\n## Acceptance Criteria\n\n${task.acceptance}\n\n---\n\nПосле выполнения задачи ответь строго в формате:\n\nTASK_RESULT: PASS\n\nили\n\nTASK_RESULT: FAIL\n\nв зависимости от результата.`;
  const size = Buffer.byteLength(prompt, "utf8");
  if (size > MAX_TASK_PROMPT_SIZE) {
    return {
      ok: false,
      error: `Task ${task.taskNumber} prompt too large: ${size} bytes (max ${MAX_TASK_PROMPT_SIZE})`,
    };
  }
  return { ok: true, prompt };
}

/**
 * Извлечь результат задачи из текста ответа (scan для "TASK_RESULT: PASS|FAIL").
 * Возвращает null если маркер отсутствует.
 */
export function extractTaskResult(
  text: string,
): "PASS" | "FAIL" | null {
  const passMatch = /TASK_RESULT:\s*PASS/i.exec(text);
  const failMatch = /TASK_RESULT:\s*FAIL/i.exec(text);
  if (passMatch) return "PASS";
  if (failMatch) return "FAIL";
  return null;
}

// --- Core dispatch + result classification (spec 015, T05/T06) ---------------

/** Delivery provider: отправка prompt-а текущей задачи. Бросает при ошибке. */
export type DeliverFn = (prompt: string) => Promise<void>;

export type DispatchOutcome =
  | { type: "dispatched"; task: number }
  | { type: "BOUNDARY_BLOCKED"; task: number }
  | { type: "STOPPED"; task: number }
  | { type: "OWNER_BUSY"; task: number }
  | { type: "SWITCH_NEEDED"; task: number }
  | { type: "task-oversized"; task: number; error: string }
  | { type: "backlog-invalid"; task: number; error: string }
  | { type: "backlog-hash-mismatch"; task: number }
  | { type: "state-missing" }
  | { type: "not-runnable"; status: NightRunStatus }
  | { type: "no-plan" };

/**
 * Dispatch текущей задачи. Порядок:
 *  1. Прочитать state (нет -> state-missing).
 *  2. userStop -> STOPPED (не считается выполнением).
 *  3. Терминальные статусы -> not-runnable.
 *  4. Boundary (план истёк/вне интервала) -> BOUNDARY_BLOCKED (idle-причина).
 *  5. Парсинг backlog; hash-проверка (защита от подмены).
 *  6. Prompt только ОДНОЙ задачи (никогда весь Markdown).
 *  7. Перед отправкой: status=awaiting-result (durable, FR-015-3).
 *  8. deliver() — доставка; OWNER_BUSY/SWITCH_NEEDED классифицирует
 *     доставщик по своим гейтам (не PASS/FAIL задачи).
 *
 * Диспетчер НЕ двигает cursor: продвижение делает applyTaskResult.
 */
export async function dispatchCurrentTask(
  deliver: DeliverFn,
): Promise<DispatchOutcome> {
  const st = readState();
  if (!st) return { type: "state-missing" };
  if (st.userStop || st.status === "stopped") {
    await appendTransition({
      timestamp: Date.now(),
      plan: st.plan,
      task: st.currentTask,
      fromStatus: st.status,
      toStatus: "stopped",
      action: "dispatch",
      reason: "user-stop",
      attempt: st.attempt,
      result: "STOPPED",
    });
    return { type: "STOPPED", task: st.currentTask };
  }
  if (st.status !== "running") {
    return { type: "not-runnable", status: st.status };
  }

  // Boundary: 08:00 (или истечение плана) запрещает НОВЫЙ dispatch
  // (FR-015-5). Уже идущая задача (awaiting-result) сюда не попадает.
  if (isBoundaryBlocked()) {
    await mutateState((cur) =>
      cur
        ? { next: { ...cur, status: "paused", lastResult: "BOUNDARY_BLOCKED", updatedAt: Date.now() } }
        : { next: null },
    );
    await appendTransition({
      timestamp: Date.now(),
      plan: st.plan,
      task: st.currentTask,
      fromStatus: "running",
      toStatus: "paused",
      action: "dispatch",
      reason: "after-boundary",
      attempt: st.attempt,
      result: "BOUNDARY_BLOCKED",
    });
    return { type: "BOUNDARY_BLOCKED", task: st.currentTask };
  }

  const parseResult = parseBacklog(st.backlog);
  if (!parseResult.ok) {
    await appendTransition({
      timestamp: Date.now(),
      plan: st.plan,
      task: st.currentTask,
      fromStatus: "running",
      toStatus: "failed",
      action: "fail",
      reason: "backlog-invalid",
      attempt: st.attempt,
      result: null,
    });
    await mutateState((cur) =>
      cur ? { next: { ...cur, status: "failed", updatedAt: Date.now() } } : { next: null },
    );
    return { type: "backlog-invalid", task: st.currentTask, error: parseResult.error };
  }
  if (parseResult.hash !== st.backlogHash) {
    // Файл подменён после init: курсор невалиден (design §4).
    await appendTransition({
      timestamp: Date.now(),
      plan: st.plan,
      task: st.currentTask,
      fromStatus: "running",
      toStatus: "failed",
      action: "fail",
      reason: "backlog-hash-mismatch",
      attempt: st.attempt,
      result: null,
    });
    await mutateState((cur) =>
      cur ? { next: { ...cur, status: "failed", updatedAt: Date.now() } } : { next: null },
    );
    return { type: "backlog-hash-mismatch", task: st.currentTask };
  }

  const task = parseResult.tasks.find((t) => t.taskNumber === st.currentTask);
  if (!task) {
    // currentTask за пределами файла (backlog стал короче).
    return { type: "backlog-invalid", task: st.currentTask, error: `Task ${st.currentTask} not found` };
  }

  const promptRes = buildTaskPrompt(task);
  if (!promptRes.ok) {
    // Гигантский prompt нельзя отправлять (FR-015-9): задача FAIL без retry
    // — это структурная проблема, повтор не поможет.
    await appendTransition({
      timestamp: Date.now(),
      plan: st.plan,
      task: st.currentTask,
      fromStatus: "running",
      toStatus: "failed",
      action: "fail",
      reason: "task-oversized",
      attempt: st.attempt,
      result: "FAIL",
    });
    await mutateState((cur) =>
      cur
        ? { next: { ...cur, status: "failed", lastResult: "FAIL", updatedAt: Date.now() } }
        : { next: null },
    );
    return { type: "task-oversized", task: st.currentTask, error: promptRes.error };
  }

  // Durable awaiting-result ПЕРЕД отправкой (design §4): рестарт между
  // send и результатом восстанавливается из этого статуса, никогда не
  // считается автоматическим PASS.
  await mutateState((cur) =>
    cur
      ? { next: { ...cur, status: "awaiting-result", updatedAt: Date.now() } }
      : { next: null },
  );
  await appendTransition({
    timestamp: Date.now(),
    plan: st.plan,
    task: st.currentTask,
    fromStatus: "running",
    toStatus: "awaiting-result",
    action: "dispatch",
    reason: "dispatch-sent",
    attempt: st.attempt,
    result: null,
  });

  try {
    await deliver(promptRes.prompt);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    // Доставщик классифицирует свои гейты через thrown typed error:
    // "OWNER_BUSY" / "SWITCH_NEEDED" — delivery-диагностика, задача НЕ
    // считается выполненной, cursor не двигается (FR-015-4, design §5).
    if (msg.includes("OWNER_BUSY")) {
      await applyTaskResult("OWNER_BUSY");
      return { type: "OWNER_BUSY", task: st.currentTask };
    }
    if (msg.includes("SWITCH_NEEDED")) {
      await applyTaskResult("SWITCH_NEEDED");
      return { type: "SWITCH_NEEDED", task: st.currentTask };
    }
    // Прочая ошибка доставки: вернуться в running для повторного dispatch,
    // попытку не расходовать (доставка не состоялась — задача не начата).
    await mutateState((cur) =>
      cur ? { next: { ...cur, status: "running", updatedAt: Date.now() } } : { next: null },
    );
    throw err;
  }
  return { type: "dispatched", task: st.currentTask };
}

/**
 * Применить результат задачи к state (атомарно + transition log).
 * Единственное место, двигающее cursor.
 *
 *   PASS            -> next task (или completed на последней)
 *   FAIL            -> bounded retry; исчерпание -> failed
 *   429             -> пауза, задача сохраняется, cursor не двигается
 *   OWNER_BUSY      -> пауза с причиной, задача сохраняется
 *   SWITCH_NEEDED   -> пауза с причиной, задача сохраняется
 *   STOPPED         -> stopped (user stop)
 *   AWAITING_RESULT -> неоднозначный результат: ничего не двигать
 */
export async function applyTaskResult(
  result: Exclude<NightRunResult, null>,
): Promise<NightRunState | null> {
  const st = readState();
  if (!st) return null;

  const parseResult = parseBacklog(st.backlog);
  const taskCount = parseResult.ok ? parseResult.tasks.length : 0;

  if (result === "PASS") {
    const isLast = st.currentTask >= taskCount;
    const nextTask = isLast ? st.currentTask : st.currentTask + 1;
    const nextStatus: NightRunStatus = isLast ? "completed" : "running";
    await mutateState((cur) =>
      cur
        ? {
            next: {
              ...cur,
              currentTask: nextTask,
              status: nextStatus,
              attempt: 1,
              lastResult: "PASS",
              updatedAt: Date.now(),
            },
          }
        : { next: null },
    );
    await appendTransition({
      timestamp: Date.now(),
      plan: st.plan,
      task: st.currentTask,
      fromStatus: st.status,
      toStatus: nextStatus,
      action: isLast ? "complete" : "advance",
      reason: isLast ? "completed" : "pass",
      attempt: st.attempt,
      result: "PASS",
    });
    return readState();
  }

  if (result === "FAIL") {
    if (st.attempt < st.maxRetries) {
      // Bounded retry: попытка расходуется, задача та же.
      await mutateState((cur) =>
        cur
          ? {
              next: {
                ...cur,
                status: "running",
                attempt: cur.attempt + 1,
                lastResult: "FAIL",
                updatedAt: Date.now(),
              },
            }
          : { next: null },
      );
      await appendTransition({
        timestamp: Date.now(),
        plan: st.plan,
        task: st.currentTask,
        fromStatus: st.status,
        toStatus: "running",
        action: "retry",
        reason: "fail",
        attempt: st.attempt + 1,
        result: "FAIL",
      });
      return readState();
    }
    await mutateState((cur) =>
      cur
        ? { next: { ...cur, status: "failed", lastResult: "FAIL", updatedAt: Date.now() } }
        : { next: null },
    );
    await appendTransition({
      timestamp: Date.now(),
      plan: st.plan,
      task: st.currentTask,
      fromStatus: st.status,
      toStatus: "failed",
      action: "fail",
      reason: "retry-exhausted",
      attempt: st.attempt,
      result: "FAIL",
    });
    return readState();
  }

  if (result === "429") {
    // Cursor не двигается (FR-015-4): 429 — про провайдера, не про задачу.
    await mutateState((cur) =>
      cur
        ? { next: { ...cur, status: "paused", lastResult: "429", updatedAt: Date.now() } }
        : { next: null },
    );
    await appendTransition({
      timestamp: Date.now(),
      plan: st.plan,
      task: st.currentTask,
      fromStatus: st.status,
      toStatus: "paused",
      action: "pause",
      reason: "429",
      attempt: st.attempt,
      result: "429",
    });
    return readState();
  }

  if (result === "OWNER_BUSY" || result === "SWITCH_NEEDED") {
    // Delivery-диагностика (design §5): задача не выполнена, cursor стоит.
    await mutateState((cur) =>
      cur
        ? { next: { ...cur, status: "paused", lastResult: result, updatedAt: Date.now() } }
        : { next: null },
    );
    await appendTransition({
      timestamp: Date.now(),
      plan: st.plan,
      task: st.currentTask,
      fromStatus: st.status,
      toStatus: "paused",
      action: "pause",
      reason: result === "OWNER_BUSY" ? "owner-busy" : "switch-needed",
      attempt: st.attempt,
      result,
    });
    return readState();
  }

  if (result === "STOPPED") {
    await mutateState((cur) =>
      cur
        ? {
            next: {
              ...cur,
              status: "stopped",
              userStop: true,
              lastResult: "STOPPED",
              updatedAt: Date.now(),
            },
          }
        : { next: null },
    );
    await appendTransition({
      timestamp: Date.now(),
      plan: st.plan,
      task: st.currentTask,
      fromStatus: st.status,
      toStatus: "stopped",
      action: "stop",
      reason: "user-stop",
      attempt: st.attempt,
      result: "STOPPED",
    });
    return readState();
  }

  // AWAITING_RESULT / BOUNDARY_BLOCKED и прочее неоднозначное:
  // не продвигать currentTask (спека: неоднозначный результат — стоп).
  return st;
}

/**
 * Восстановление после рестарта из awaiting-result (design §4):
 * статус возвращается в running с ТОЙ ЖЕ задачей и попыткой.
 * Задача НИКОГДА не считается автоматически PASS — результат остаётся
 * неопределённым и требует повторного dispatch (bounded reconciliation).
 */
export async function recoverFromAwaitingResult(): Promise<NightRunState | null> {
  const st = readState();
  if (!st) return null;
  if (st.status !== "awaiting-result") return st;
  if (st.userStop) return st;

  await mutateState((cur) =>
    cur ? { next: { ...cur, status: "running", updatedAt: Date.now() } } : { next: null },
  );
  await appendTransition({
    timestamp: Date.now(),
    plan: st.plan,
    task: st.currentTask,
    fromStatus: "awaiting-result",
    toStatus: "running",
    action: "resume",
    reason: "recovery-unresolved",
    attempt: st.attempt,
    result: st.lastResult,
  });
  return readState();
}
