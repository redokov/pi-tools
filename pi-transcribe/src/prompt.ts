/**
 * prompt.ts -- interactive model choice (and manifest reuse) via ctx.ui.
 */

import { MODEL_CHOICES, type Model } from "./paths.js";

export interface UiLike {
  select?(title: string, items: string[], options?: unknown): Promise<string | undefined>;
  confirm?(title: string, message: string, options?: unknown): Promise<boolean>;
  notify?(msg: string, level?: "info" | "warning" | "error"): void;
  input?(title: string, placeholder?: string): Promise<string | undefined>;
}

/**
 * Ask the user to pick a model via ctx.ui.select.
 *
 * - If ui.select is unavailable (non-TUI mode) -> returns the default
 *   (gigaam) without prompting.
 * - Returns "gigaam" when the user cancels (Escape / timeout), so the
 *   default wins instead of aborting the run.
 */
export async function askModelChoice(
  ui: UiLike | undefined,
  lang: string,
): Promise<Model> {
  const defaultModel: Model = "gigaam";
  if (!ui || typeof ui.select !== "function") return defaultModel;

  const hint =
    lang.toLowerCase().startsWith("ru")
      ? "gigaam — лучшее качество для русского; whisper-large — универсальная, лучше на шумных записях"
      : "язык не русский — по умолчанию whisper-large";
  void hint;

  const items = [
    ...MODEL_CHOICES,
  ];
  const choice = await ui.select(`Модель для транскрибации (${lang}):`, items);
  if (choice === undefined) return defaultModel; // cancel -> default
  if (choice === "gigaam" || choice === "whisper-large") return choice;
  return defaultModel;
}

/**
 * Path of the legacy summary file for a transcript: out/<basename>-sum.md.
 * <basename> is the source media stem (e.g. "meeting.mp4" -> "meeting").
 * Fallback path only: used for manifest-reuse checks. The actual summary
 * file is named by content (see summaryFileInstruction).
 */
export function summaryPathFor(baseName: string): string {
  return `out/${baseName}-sum.md`;
}

/**
 * Current date in YYYY-MM-DD (local time), e.g. "2026-08-31".
 */
export function todayIso(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Appended to the follow-up summarization prompt so that the agent
 * always saves the summary to out/<ProjectName><CamelCaseWords>-<YYYY-MM-DD>.md, where
 * <CamelCaseWords> is derived from the transcript content by the agent itself
 * (rules: c:/tools/pi-transcribe/docs/summary.md) and replies with a short
 * result + file path.
 */
export function summaryFileInstruction(baseName: string, date: string, projectName: string): string {
  const dir = "out/";
  return (
    `После подготовки саммари ОБЯЗАТЕЛЬНО сохрани его в файл в каталоге ${dir} ` +
    `с названием из трех частей: 1) имя проекта (${projectName}) — на русском, CamelCase, 2) название по содержанию транскрипции — CamelCaseWords на русском (слова в CamelCase, без пробелов, подчёрков, дефисов и других спец-символов — только буквы и цифры; запрещён символ � (U+FFFD) и любые непечатаемые символы — если буква не распозналась, переформулируйте имя на чистый русский), 3) дата YYYY-MM-DD в конце перед расширением. ` +
    `Формат: ${dir}<ProjectName><CamelCaseWords>-<YYYY-MM-DD>.md, например ${dir}${projectName}ОбсуждениеПлана-${date}.md ` +
    `по правилам из c:/tools/pi-transcribe/docs/summary.md ` +
    `(UTF-8 без BOM, перевод строк LF, структура: «# Саммари: <basename>» + метаданные + «## TL;DR» + «## Ключевые темы» + «## Подробно по темам» + «## Решения / действия» + «## Открытые вопросы»; файл уже может существовать (reuse) — перезаписать по правилам, новые версии не создавать). ` +
    `НЕ печатайте транскрипцию или саммари в чат — только краткий итог. НЕ генеририуйте повторные Cyrilic- блоки: если Cyrillic- слово повреждено (�), переформулируйте fresh на чистый русский и продолжайте — не копите поврежденные строки из истории. Если саммари большое, сохраните файл несколькими небольшими write-вызовами. В чат выведи краткий итог (2–4 предложения) и укажи путь к созданного файлу: ${dir}${projectName}<CamelCaseWords>-<YYYY-MM-DD>.md.`
  );
}

/**
 * Ask whether to reuse an existing manifest. Returns true (reuse) when the
 * user confirms OR when the UI is unavailable (assume reuse — cheaper).
 */
export async function askReuseManifest(
  ui: UiLike | undefined,
  baseName: string,
): Promise<boolean> {
  if (!ui || typeof ui.confirm !== "function") return true;
  return await ui.confirm(
    "Файл уже подготовлен",
    `Для «${baseName}» уже есть manifest в out/. Переиспользовать (пропустить prepare)?`,
  );
}
