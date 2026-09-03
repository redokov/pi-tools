/**
 * summary.ts -- the automatic "summarize this transcript" request sent to
 * the agent via pi.sendUserMessage() after a successful transcription.
 *
 * Pure: prompt building + delivery, no fs / spawn.
 */

import { displayPath } from "./paths.js";
import { summaryFileInstruction } from "./prompt.js";

export interface SummaryRequest {
  /** The source media path (absolute). */
  source: string;
  /** Model used for transcription. */
  model: string;
  /** Output format that was produced. */
  format: string;
  /** Path to the full transcript file. */
  result: string;
  /**
   * Source media stem (e.g. "meeting.mp4" -> "meeting"). Used to build the
   * mandatory summary file path out/<basename>-sum.md.
   */
  baseName: string;
}

/**
 * Build the user message that asks the agent to summarize the transcript.
 * The agent reads the full file itself — the message only points at it and
 * requires saving the summary to out/<basename>-sum.md.
 */
export function buildSummaryPrompt(
  req: SummaryRequest,
  customPrompt?: string,
): string {
  const head = displayPath(req.source);
  if (customPrompt && customPrompt.trim().length > 0) {
    // Custom prompt: user controls the wording; still append file refs and
    // the mandatory save-to-file instruction so the agent always knows where
    // to read from and where to write the summary.
    return (
      customPrompt.trim() +
      `\n\nФайл транскрипции: ${req.result}\n` +
      `Модель: ${req.model}, формат: ${req.format}.\n` +
      summaryFileInstruction(req.baseName)
    );
  }
  return (
    `Саммаризируй транскрипцию файла ${head}. ` +
    `Полный текст: ${req.result} (модель ${req.model}, формат ${req.format}). ` +
    `Прочитай файл и подготовь саммари: 1) краткое резюме (3–5 пунктов), ` +
    `2) ключевые решения/выводы, 3) список действий, если они есть. ` +
    `Отвечай на русском. ` +
    summaryFileInstruction(req.baseName)
  );
}

/**
 * Deliver the summarization request to the agent.
 * `sendUserMessage` always triggers a turn; when the agent is streaming
 * `deliverAs` selects the queue. Default is "followUp" (wait until the
 * current agent work — including this command's own turn — is done).
 */
export async function sendSummary(
  send: (content: string, opts?: { deliverAs?: "steer" | "followUp" }) => Promise<void>,
  req: SummaryRequest,
  customPrompt?: string,
): Promise<void> {
  const text = buildSummaryPrompt(req, customPrompt);
  await send(text, { deliverAs: "followUp" });
}
