/**
 * nightcreate.ts — pure builder для /night-plan create (spec 016).
 *
 * Генерирует meta-prompt для НОВОЙ сессии агента: агент адаптирует задачи
 * ночи к проекту, пишет backlog-файл в строгом формате spec 015 и выводит
 * точные команды запуска. Модуль чистый: ни fs, ни часов — все входы
 * параметрами (тестируемость, FR-016-4).
 */

import * as path from "node:path";

/** Предложенный путь backlog-файла: <cwd>/.ai/night/backlog-<date>.md */
export function suggestBacklogPath(cwd: string, date: string): string {
  return path.join(cwd, ".ai", "night", `backlog-${date}.md`);
}

export type NightCreateOpts = {
  /** Каталог проекта, в котором будет работать ночная сессия. */
  cwd: string;
  /** Цель ночи (свободный текст пользователя, непустой). */
  goal: string;
  /** "HH:MM" — начало интервала плана. */
  fromLocal: string;
  /** "HH:MM" — конец интервала плана (граница, по умолчанию 08:00). */
  toLocal: string;
  /** Дата ночи "YYYY-MM-DD" (для имени файла). */
  date: string;
  /** Путь backlog-файла, который агент должен создать. */
  backlogPath: string;
};

/**
 * Собрать meta-prompt для новой сессии. Инструктирует агента: адаптировать
 * задачи к проекту, написать валидный backlog (формат spec 015) и вывести
 * команды запуска для пользователя. Никогда не запускает runner сам.
 */
export function buildNightCreatePrompt(o: NightCreateOpts): string {
  const interval = `${o.fromLocal}-${o.toLocal}`;
  const planCmd = `/night-plan ${interval} backlog=${o.backlogPath}`;
  const lines: string[] = [];

  lines.push("# Подготовка ночного прогона (night-run)");
  lines.push("");
  lines.push("Ты — подготовщик ночного backlog-а. Твоя работа: разобрать");
  lines.push("проект, составить задачи на ночь и подготовить файл backlog-а");
  lines.push("и команды запуска. НИЧЕГО не запускай сам — ночной прогон");
  lines.push("запускает пользователь скопированной командой.");
  lines.push("");
  lines.push("## Проект");
  lines.push(`Рабочий каталог: \`${o.cwd || "(каталог текущей сессии)"}\`.`);
  lines.push("Изучи структуру проекта, спеки (.ai/sdd/specs/), статус задач,");
  lines.push("чтобы задачи ночи были реальными и адаптированными к проекту.");
  lines.push("");
  lines.push("## Цель ночи");
  lines.push(o.goal);
  lines.push("");
  lines.push("## Что сделать");
  lines.push(`1. Составь план задач на ночь под цель выше.`);
  lines.push(`2. Запиши backlog-файл: \`${o.backlogPath}\` (создай каталоги).`);
  lines.push("3. Выведи в конце ответа команды запуска (см. «Финальный шаг»).");
  lines.push("");
  lines.push("## Строгий формат backlog-а (расширение проверяет автоматически)");
  lines.push("Backlog — UTF-8 Markdown и ТОЛЬКО такой структуры:");
  lines.push("");
  lines.push("```markdown");
  lines.push("## Task 1");
  lines.push("<полное самодостаточное описание задачи 1>");
  lines.push("");
  lines.push("## Acceptance");
  lines.push("<проверяемые критерии приёмки задачи 1>");
  lines.push("");
  lines.push("## Task 2");
  lines.push("...");
  lines.push("");
  lines.push("## Acceptance");
  lines.push("...");
  lines.push("```");
  lines.push("");
  lines.push("Правила (нарушение любого — файл будет отвергнут):");
  lines.push("- номера задач строго последовательные: 1, 2, 3… без дублей и пропусков;");
  lines.push("- у КАЖДОЙ задачи обязательна секция `## Acceptance`;");
  lines.push("- лимиты: файл ≤ 2 МБ, одна задача (тело + acceptance) ≤ 64 КБ — пиши компактно;");
  lines.push("- задача = один законченный кусок работы: ночная сессия получает её ОДНУ");
  lines.push("  и должна закончить явным вердиктом; не сваливай в задачу несколько работ.");
  lines.push("");
  lines.push("## Маркер результата (критично)");
  lines.push("В Acceptance КАЖДОЙ задачи явно потребуй завершить работу над задачей");
  lines.push("строкой:");
  lines.push("");
  lines.push("- `TASK_RESULT: PASS` — все критерии приёмки выполнены и подтверждены;");
  lines.push("- `TASK_RESULT: FAIL` — не выполнены (с коротким объяснением).");
  lines.push("");
  lines.push("Обычный текст («всё сделал», «готово») НЕ считается успехом: runner");
  lines.push("продвигается только по явному маркеру. Критерии приёмки должны быть");
  lines.push("проверяемыми (запуск тестов, гейт, проверка файла) — чтобы PASS был");
  lines.push("обоснованным, а не декларативным.");
  lines.push("");
  lines.push("## Правила ночной работы (впиши их в тексты задач)");
  lines.push("- Никаких интерактивных вопросов посреди задачи: ночь идёт без человека;");
  lines.push("  неясность — фиксируй решение в задаче или помечай FAIL.");
  lines.push("- Никаких разрушительных операций; база 1С не изменяется;");
  lines.push("  только unit/mock/static-тесты, никаких UI/E2E и живых прогонов;");
  lines.push("- После правок кода прогоняй имеющиеся гейты проекта (tsc/тесты)");
  lines.push("  и отражай результат в вердикте задачи.");
  lines.push("");
  lines.push("## Как ночной runner выполнит backlog (учти при декомпозиции)");
  lines.push("- Задачи идут строго по одной, по порядку; PASS → следующая;");
  lines.push("  FAIL → до 2 повторов, потом очередь останавливается (fail).");
  lines.push("- 429/граница времени — задача сохраняется и повторяется позже;");
  lines.push("  рестарт не считается PASS: задача будет повторена.");
  lines.push(`- После ${o.toLocal} новые задачи не отправляются — планируй объём`);
  lines.push("  реалистично: суммарно задача не должна выполняться дольше одного окна;");
  lines.push("  длинную работу режь на несколько задач с промежуточными критериями.");
  lines.push("");
  lines.push("## Финальный шаг");
  lines.push("Пиши backlog-файл, затем выведи в конце ответа РОВНО эти команды");
  lines.push("(подставив актуальный путь, если скорректируешь его):");
  lines.push("");
  lines.push("```text");
  lines.push(planCmd);
  lines.push("/night-run resume");
  lines.push("/night-run resume");
  lines.push("```");
  lines.push("");
  lines.push("Команды выполняет ПОЛЬЗОВАТЕЛЬ в сессии-владельце (не ты):");
  lines.push("первая взводит план со ссылкой на backlog, вторая и третья");
  lines.push("инициализируют и запускают runner. Не запускай /night-run сам.");
  lines.push("");

  return lines.join("\n");
}
