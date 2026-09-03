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
 * Path of the summary file for a transcript: out/<basename>-sum.md.
 * <basename> is the source media stem (e.g. "meeting.mp4" -> "meeting").
 */
export function summaryPathFor(baseName: string): string {
  return `out/${baseName}-sum.md`;
}

/**
 * Appended to the default follow-up summarization prompt so that the agent
 * always saves the summary to out/<basename>-sum.md (rules: c:/MyProjects/
 * transcribe/docs/summary.md) and replies with a short result + file path.
 */
export function summaryFileInstruction(baseName: string): string {
  const file = summaryPathFor(baseName);
  return (
    `После подготовки саммари ОБЯЗАТЕЛЬНО сохрани его в файл ${file} ` +
    `по правилам из c:/MyProjects/transcribe/docs/summary.md ` +
    `(UTF-8 без BOM, перевод строк LF, структура: «# Саммари: <basename>» + метаданные + «## TL;DR» + «## Ключевые темы» + «## Подробно по темам» + «## Решения / действия» + «## Открытые вопросы»; файл уже существует — перезаписать, новые версии типа -sum-1.md не создавать). ` +
    `В чат выведи краткий итог (2–4 предложения) и укажи путь к файлу: ${file}.`
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
