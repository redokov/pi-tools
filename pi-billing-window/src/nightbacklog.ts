/**
 * nightbacklog.ts — Markdown backlog parser (spec 015, FR-015-1).
 *
 * Парсит структурированный Markdown с явными секциями `## Task N` и
 * `## Acceptance`. Reject для дублирующихся/пропущенных/непоследовательных
 * Task N, oversized input, и для гигантских промптов (невозможно передать
 * целиком в sendUserMessage). Никогда не возвращает весь Markdown одним
 * куском — только отдельные задачи и acceptance.
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";

export type BacklogTask = {
  /** Порядковый номер задачи (1-based). */
  taskNumber: number;
  /** Тело задачи (без заголовка `## Task N`). */
  taskBody: string;
  /** Acceptance criteria (без заголовка `## Acceptance`). */
  acceptance: string;
};

export type BacklogParseResult =
  | { ok: true; tasks: BacklogTask[]; hash: string }
  | { ok: false; error: string };

/** Максимальный размер backlog-файла (байт). */
const MAX_BACKLOG_SIZE = 2 * 1024 * 1024; // 2 MB

/** Максимальный размер одной задачи (task body + acceptance, байт). */
const MAX_TASK_SIZE = 64 * 1024; // 64 KB

/**
 * Парсить Markdown backlog с явными секциями `## Task N` и `## Acceptance`.
 * Возвращает упорядоченный массив задач или ошибку.
 *
 * Формат:
 * ```markdown
 * ## Task 1
 * <task body>
 * ## Acceptance
 * <acceptance criteria>
 * ## Task 2
 * ...
 * ```
 *
 * Reject:
 * - Дублирующиеся task numbers
 * - Пропущенные task numbers (1, 2, 4 — нет 3)
 * - Отсутствующая секция Acceptance для любой задачи
 * - Oversized input (файл > MAX_BACKLOG_SIZE)
 * - Oversized task (task body + acceptance > MAX_TASK_SIZE)
 * - Непоследовательные task numbers (2, 1, 3)
 */
export function parseBacklog(path: string): BacklogParseResult {
  try {
    // Размер файла.
    const stats = fs.statSync(path);
    if (stats.size > MAX_BACKLOG_SIZE) {
      return {
        ok: false,
        error: `Backlog file too large: ${stats.size} bytes (max ${MAX_BACKLOG_SIZE})`,
      };
    }

    const content = fs.readFileSync(path, "utf8");
    const hash = crypto.createHash("sha256").update(content, "utf8").digest("hex");

    // Разбить на строки.
    const lines = content.split(/\r?\n/);
    const tasks: BacklogTask[] = [];
    let currentTask: { taskNumber: number; taskBody: string } | null = null;
    let acceptanceLines: string[] = [];
    let inAcceptance = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const taskMatch = /^##\s+Task\s+(\d+)\s*$/i.exec(line);
      const acceptMatch = /^##\s+Acceptance\s*$/i.exec(line);

      if (taskMatch) {
        // Завершить предыдущую задачу (если была в acceptance).
        if (currentTask && inAcceptance) {
          const acceptance = acceptanceLines.join("\n").trim();
          const taskSize =
            Buffer.byteLength(currentTask.taskBody, "utf8") +
            Buffer.byteLength(acceptance, "utf8");
          if (taskSize > MAX_TASK_SIZE) {
            return {
              ok: false,
              error: `Task ${currentTask.taskNumber} too large: ${taskSize} bytes (max ${MAX_TASK_SIZE})`,
            };
          }
          tasks.push({
            taskNumber: currentTask.taskNumber,
            taskBody: currentTask.taskBody,
            acceptance,
          });
          currentTask = null;
          acceptanceLines = [];
          inAcceptance = false;
        } else if (currentTask && !inAcceptance) {
          // Task без Acceptance.
          return {
            ok: false,
            error: `Task ${currentTask.taskNumber} has no Acceptance section`,
          };
        }

        // Начать новую задачу.
        const taskNumber = parseInt(taskMatch[1], 10);
        currentTask = { taskNumber, taskBody: "" };
        continue;
      }

      if (acceptMatch) {
        if (!currentTask) {
          return {
            ok: false,
            error: `Acceptance section without preceding Task (line ${i + 1})`,
          };
        }
        currentTask.taskBody = currentTask.taskBody.trim();
        inAcceptance = true;
        acceptanceLines = [];
        continue;
      }

      // Накапливать тело задачи или acceptance.
      if (currentTask) {
        if (inAcceptance) {
          acceptanceLines.push(line);
        } else {
          currentTask.taskBody += line + "\n";
        }
      }
    }

    // Завершить последнюю задачу.
    if (currentTask && inAcceptance) {
      const acceptance = acceptanceLines.join("\n").trim();
      const taskSize =
        Buffer.byteLength(currentTask.taskBody, "utf8") +
        Buffer.byteLength(acceptance, "utf8");
      if (taskSize > MAX_TASK_SIZE) {
        return {
          ok: false,
          error: `Task ${currentTask.taskNumber} too large: ${taskSize} bytes (max ${MAX_TASK_SIZE})`,
        };
      }
      tasks.push({
        taskNumber: currentTask.taskNumber,
        taskBody: currentTask.taskBody,
        acceptance,
      });
    } else if (currentTask && !inAcceptance) {
      return {
        ok: false,
        error: `Task ${currentTask.taskNumber} has no Acceptance section`,
      };
    }

    // Проверка последовательности и дублей.
    if (tasks.length === 0) {
      return { ok: false, error: "No tasks found in backlog" };
    }

    const seen = new Set<number>();
    for (const t of tasks) {
      if (seen.has(t.taskNumber)) {
        return { ok: false, error: `Duplicate Task ${t.taskNumber}` };
      }
      seen.add(t.taskNumber);
    }

    // Проверка последовательности: tasks должны быть 1, 2, 3, ..., N.
    const sorted = tasks.map((t) => t.taskNumber).sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] !== i + 1) {
        return {
          ok: false,
          error: `Task numbers are not sequential: expected ${i + 1}, got ${sorted[i]}`,
        };
      }
    }

    // Упорядочить по taskNumber.
    tasks.sort((a, b) => a.taskNumber - b.taskNumber);

    return { ok: true, tasks, hash };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse backlog: ${(err as Error)?.message ?? String(err)}`,
    };
  }
}
