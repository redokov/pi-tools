/**
 * index.ts -- pi-transcribe extension entry point.
 *
 * Registers:
 *   /transcribe [name] [--lang ru|en] [--model gigaam|whisper-large]
 *               [--format text|srt|vtt|json|verbose_json]
 *               [--no-summary] [--summary-prompt <text>]
 *   /transcribe-gigaam [name] (same flags; model fixed to gigaam)
 *   /transcribe-status
 *
 * Full pipeline: validate input -> pick model -> prepare.py -> transcribe.py
 * -> read out/<name>.<ext> -> print to chat -> (unless --no-summary) send
 * the agent a summarization request via pi.sendUserMessage().
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyFileSync, mkdirSync, renameSync } from "node:fs";
import { basename, join, isAbsolute } from "node:path";
import {
  baseNameOf,
  displayPath,
  getInboxDir,
  getOutDir,
  latestInboxFile,
  listOutFiles,
  manifestExists,
  resolveSourcePath,
  sourceExists,
  type Model,
} from "./paths.js";
import {
  runPrepare,
  runTranscribe,
} from "./pipeline.js";
import { hasManifest, readResult, summarizeOut, truncateForChat } from "./output.js";
import { askModelChoice, askReuseManifest } from "./prompt.js";
import {
  DEFAULT_MODEL,
  GIGAAAM_MODEL,
  parseArgs,
  type ParsedArgs,
} from "./args.js";
import { sanitizeName, isCorrupted } from "./fix-names.js"
import { sendSummary } from "./summary.js";

/** Max lines printed to chat before truncation. */
const MAX_CHAT_LINES = 200;

/** Prepare timeout (ms) — ffmpeg work on long video can be slow. */
const PREPARE_TIMEOUT_MS = 10 * 60 * 1000;
/** Transcribe timeout (ms) — API + possibly many chunks. */
const TRANSCRIBE_TIMEOUT_MS = 30 * 60 * 1000;

function parseArgsDefault(args: string, defaultModel: Model): ParsedArgs {
  const parsed = parseArgs(args);
  if (!parsed.error && !parsed.model) parsed.model = defaultModel;
  return parsed;
}

const HELP_TEXT =
  "/transcribe — транскрибация аудио/видео из inbox/ через API wormsoft\n" +
  "  /transcribe                                  — самый свежий файл из inbox/ (по умолчанию модель whisper-large)\n" +
  "  /transcribe meeting.mp4                      — конкретный файл из inbox/\n" +
  "  /transcribe <абсолютный путь.mp4>            — файл скапируется в inbox/ под тем же именем и запускается пайплайн\n" +
  "    (если в пути есть пробелы — оберните путь в двойные кавычки)\n" +
  "  /transcribe-gigaam [файл]                    — то же самое, но модель фиксирована: gigaam\n" +
  "Флаги:\n" +
  "  --lang <ru|en>          язык (по умолчанию ru)\n" +
  "  --model <gigaam|whisper-large>  пропустить выбор, задать модель явно\n" +
  "  --format <text|srt|vtt|json|verbose_json>  формат (по умолчанию text)\n" +
  "  --no-summary            не отправлять агенту запрос на саммаризацию после успеха\n" +
  "  --summary-prompt <текст>  свой текст запроса на саммаризацию\n" +
  "После успешной транскрибации агенту автоматически отправляется запрос на саммаризацию (pi.sendUserMessage).";

async function handleTranscribe(
  args: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  defaultModel: Model,
): Promise<void> {
  const parsed = parseArgsDefault(args, defaultModel);

  if (parsed.error === "HELP") {
    ctx.ui.notify(HELP_TEXT, "info");
    return;
  }
  if (parsed.error) {
    ctx.ui.notify(`pi-transcribe: ${parsed.error}`, "error");
    return;
  }

  // 1. Resolve the source file.
  //    - absolute path outside inbox -> copy into inbox/ under the same name
  //      (the original is never modified) and run the pipeline on the copy.
  //    - plain name -> inbox/<name>.
  //    - no arg    -> newest file in inbox/.
  let source: string;
  if (parsed.file) {
    const trimmed = parsed.file.trim();
    if (isAbsolute(trimmed)) {
      const abs = trimmed;
      if (!sourceExists(abs)) {
        ctx.ui.notify(`Файл не найден: ${abs}`, "error");
        return;
      }
      const name = basename(abs);
      if (!name) {
        ctx.ui.notify("Не удалось определить имя файла из пути.", "error");
        return;
      }
      const inbox = getInboxDir();
      mkdirSync(inbox, { recursive: true });
      const dest = join(inbox, name);
      try {
        copyFileSync(abs, dest);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.ui.notify(`Не удалось скопировать ${abs} → inbox/: ${msg}`, "error");
        return;
      }
      source = dest;
      ctx.ui.notify(`Скопировано в inbox/: ${displayPath(dest)}`, "info");
    } else {
      const r = resolveSourcePath(trimmed);
      if (!r.ok) {
        ctx.ui.notify(`Файл не найден в inbox: ${r.error}`, "error");
        return;
      }
      source = r.path;
      if (!sourceExists(source)) {
        ctx.ui.notify(`Файл не найден: ${source}`, "error");
        return;
      }
    }
  } else {
    const latest = latestInboxFile();
    if (!latest) {
      ctx.ui.notify(
        "inbox/ пуст. Положите аудио/видео в inbox/ проекта transcribe и повторите /transcribe.",
        "error",
      );
      return;
    }
    source = latest;
    ctx.ui.notify(`Без аргументов — беру самый свежий файл: ${displayPath(source)}`, "info");
  }

  const baseName = baseNameOf(source);
  const projectName = basename(process.cwd());

  // 2. Model selection (interactive unless --model passed / pinned).
  let model = parsed.model;
  if (!model) {
    model = await askModelChoice(ctx.ui, parsed.lang);
    ctx.ui.notify(`Модель: ${model}`, "info");
  }

  const manifest = `${baseName}.manifest.json`;
  const reuse = hasManifest(baseName) ? await askReuseManifest(ctx.ui, baseName) : false;

  ctx.ui.setStatus("transcribe", `⏳ ${reuse ? "transcribe" : "prepare"}: ${displayPath(source)}…`);

  try {
    // 3. Prepare (unless reusing an existing manifest).
    if (!reuse) {
      const prep = await runPrepare(
        { input: source, lang: parsed.lang },
        { timeoutMs: PREPARE_TIMEOUT_MS, onLine: () => {} },
      );
      if (!prep.ok) {
        ctx.ui.setStatus("transcribe", "⛔ prepare: ошибка");
        ctx.ui.notify(
          `prepare.py завершился с ошибкой (code=${prep.code ?? "?"})\n` +
            `${(prep.stderr || prep.stdout).slice(-2000)}`,
          "error",
        );
        return;
      }
    }

    // Re-check manifest after (re)prepare.
    if (!manifestExists(baseName)) {
      ctx.ui.setStatus("transcribe", "⛔ manifest не создан");
      ctx.ui.notify(
        `prepare.py отработал, но manifest не найден: out/${manifest}`,
        "error",
      );
      return;
    }

    // 4. Transcribe.
    const tr = await runTranscribe(
      {
        input: `out/${manifest}`,
        model,
        lang: parsed.lang,
        format: parsed.format,
        noInteractive: true,
      },
      { timeoutMs: TRANSCRIBE_TIMEOUT_MS, onLine: () => {} },
    );
    if (!tr.ok) {
      ctx.ui.setStatus("transcribe", "⛔ transcribe: ошибка");
      ctx.ui.notify(
        `transcribe.py завершился с ошибкой (code=${tr.code ?? "?"})\n` +
          `${(tr.stderr || tr.stdout).slice(-2000)}`,
        "error",
      );
      return;
    }

    // 5. Read the result.
    const res = readResult(baseName, parsed.format);
    if (!res.ok) {
      ctx.ui.setStatus("transcribe", "⛔ результат не найден");
      ctx.ui.notify(res.error, "error");
      return;
    }
    if (res.text.trim().length === 0) {
      ctx.ui.notify(`Результат пуст: ${res.path}`, "warning");
    }

    // 6. Print to chat. sendMessage with display:true renders as an
    // assistant-visible custom message in the transcript.
    const { shown, total, note } = truncateForChat(res.lines, MAX_CHAT_LINES, res.path);
    const header = `📝 Транскрипция: ${displayPath(source)} (модель ${model}, ${parsed.lang}, ${parsed.format})\n\n`;
    pi.sendMessage(
      {
        customType: "pi-transcribe",
        content: header + shown + (note ? `\n\n${note}` : ""),
        display: true,
        details: { source: displayPath(source), model, format: parsed.format, result: res.path },
      },
      { deliverAs: "nextTurn", triggerTurn: false },
    );

    // 7. Automatic summarization request to the agent (unless --no-summary).
    if (!parsed.noSummary) {
      try {
        await sendSummary(
          (text, opts) => Promise.resolve(pi.sendUserMessage(text, opts as never)),
          {
            source,
            model,
            format: parsed.format,
            result: res.path,
            baseName,
            projectName,
          },
          parsed.summaryPrompt,
        );
        ctx.ui.notify("Агенту отправлен запрос на саммаризацию.", "info");
      } catch (e) {
        // Non-fatal: the transcript itself is already in the chat.
        const msg = e instanceof Error ? e.message : String(e);
        ctx.ui.notify(`Саммаризация не отправлена: ${msg}`, "warning");
      }
    }

    ctx.ui.setStatus("transcribe", `✅ ${res.path.split(/[\\/]/).pop()}`);
    ctx.ui.notify(`Готово: ${res.path}`, "info");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ctx.ui.setStatus("transcribe", "⛔ ошибка");
    ctx.ui.notify(`pi-transcribe: ${msg}`, "error");
  }
}

async function handleStatus(_args: string, ctx: ExtensionContext): Promise<void> {
  const files = listOutFiles();
  const text = files.length === 0
    ? "out/ пуст."
    : summarizeOut(files.map((f) => ({ name: f.name, size: f.size, mtimeMs: f.mtime })));
  ctx.ui.notify(`Содержимое out/:\n${text}`, "info");
}


/** Scan out/*.md for corrupted filenames (U+FFFD etc.) and rename them clean. */
async function handleFixNames(_args: string, ctx: ExtensionContext): Promise<void> {
  const files = listOutFiles();
  const corrupted = files.filter((f) => isCorrupted(f.name));
  if (corrupted.length === 0) {
    ctx.ui.notify("Все имены файлов в out/ чисты.", "info");
    return;
  }
  const renamed: string[] = [];
  const errors: string[] = [];
  for (const f of corrupted) {
    const clean = sanitizeName(f.name);
    try {
      renameSync(join(getOutDir(), f.name), join(getOutDir(), clean));
      renamed.push(`${f.name} → ${clean}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${f.name}: ${msg}`);
    }
  }
  const renText = renamed.map((r) => `  ${r}`).join("\n");
  const errText = errors.map((r) => `  ${r}`).join("\n");
  const text = `Переименовано:\n${renText}\nОшибки:\n${errText}`;
  ctx.ui.notify(`Cleanup имен файлов (U+FFFD / поврежденные Cyrillic):
${text}`, "info");
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("transcribe", {
    description:
      "Транскрибация аудио/видео из inbox/ (wormsoft API). Модель по умолчанию whisper-large. " +
      "Флаги: --lang ru|en, --model gigaam|whisper-large, --format text|srt|vtt|json|verbose_json, " +
      "--no-summary, --summary-prompt <текст>. --help — справка. " +
      "После успеха агенту автоматически отправляется запрос на саммаризацию.",
    getArgumentCompletions: (prefix: string) => {
      void latestInboxFile();
      void listOutFiles();
      const candidates = [
        "--lang", "--model", "--format", "--no-summary", "--summary-prompt", "--help",
      ];
      const filtered = candidates.filter((c) => c.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((v) => ({ value: v, label: v })) : null;
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      await handleTranscribe(args, ctx, pi, DEFAULT_MODEL);
    },
  });

  pi.registerCommand("transcribe-gigaam", {
    description:
      "Как /transcribe, но модель фиксирована: gigaam. Флаги: --lang, --format, --no-summary, --summary-prompt. --help — справка.",
    getArgumentCompletions: (prefix: string) => {
      const candidates = ["--lang", "--format", "--no-summary", "--summary-prompt", "--help"];
      const filtered = candidates.filter((c) => c.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((v) => ({ value: v, label: v })) : null;
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      await handleTranscribe(args, ctx, pi, GIGAAAM_MODEL);
    },
  });

  pi.registerCommand("transcribe-status", {
    description: "Содержимое out/ проекта transcribe (манифесты и результаты)",
    handler: async (args: string, ctx: ExtensionContext) => {
      await handleStatus(args, ctx);
    },
  });
  pi.registerCommand("transcribe-fixnames", {
    description: "Cleanup имен файлов out/ — удаляет U+FFFD и поврежденные Cyrillic из имен",
    handler: async (args: string, ctx: ExtensionContext) => {
      await handleFixNames(args, ctx);
    },
  });
}
