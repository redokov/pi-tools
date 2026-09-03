/**
 * index.ts -- pi-transcribe extension entry point.
 *
 * Registers:
 *   /transcribe [name] [--lang ru|en] [--model gigaam|whisper-large]
 *               [--format text|srt|vtt|json|verbose_json]
 *   /transcribe-status
 *
 * Full pipeline: validate input -> pick model -> prepare.py -> transcribe.py
 * -> read out/<name>.<ext> -> print to chat.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  baseNameOf,
  displayPath,
  latestInboxFile,
  listOutFiles,
  manifestExists,
  resolveSourcePath,
  resultPathFor,
  sourceExists,
  type Model,
  type OutputFormat,
} from "./paths.js";
import {
  runPrepare,
  runTranscribe,
} from "./pipeline.js";
import { hasManifest, readResult, summarizeOut, truncateForChat } from "./output.js";
import { askModelChoice, askReuseManifest } from "./prompt.js";

/** Max lines printed to chat before truncation. */
const MAX_CHAT_LINES = 200;

/** Prepare timeout (ms) — ffmpeg work on long video can be slow. */
const PREPARE_TIMEOUT_MS = 10 * 60 * 1000;
/** Transcribe timeout (ms) — API + possibly many chunks. */
const TRANSCRIBE_TIMEOUT_MS = 30 * 60 * 1000;

interface ParsedArgs {
  file?: string;
  lang: string;
  model?: Model;
  format: OutputFormat;
  error?: string;
}

const MODEL_SET = new Set(["gigaam", "whisper-large"]);
const FORMAT_SET = new Set(["text", "srt", "vtt", "json", "verbose_json"]);

function parseArgs(args: string): ParsedArgs {
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  const out: ParsedArgs = { lang: "ru", format: "text" };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--lang") {
      const v = tokens[++i];
      if (!v) { out.error = "--lang требует значения (ru|en)"; return out; }
      out.lang = v;
    } else if (t === "--model") {
      const v = tokens[++i];
      if (!v) { out.error = "--model требует значения (gigaam|whisper-large)"; return out; }
      if (!MODEL_SET.has(v)) { out.error = `неизвестная модель '${v}'`; return out; }
      out.model = v as Model;
    } else if (t === "--format") {
      const v = tokens[++i];
      if (!v) { out.error = "--format требует значения (text|srt|vtt|json|verbose_json)"; return out; }
      if (!FORMAT_SET.has(v)) { out.error = `неизвестный формат '${v}'`; return out; }
      out.format = v as OutputFormat;
    } else if (t === "--chunk-seconds" || t === "--help" || t === "-h") {
      if (t === "--help" || t === "-h") {
        out.error = "HELP";
        return out;
      }
      const v = tokens[++i];
      void v; // not used by extension (chunking is internal to prepare.py)
    } else if (t.startsWith("-")) {
      out.error = `неизвестный флаг '${t}'`;
      return out;
    } else if (out.file === undefined) {
      out.file = t;
    } else {
      out.error = `лишний аргумент '${t}'`;
      return out;
    }
  }
  return out;
}

const HELP_TEXT =
  "/transcribe — транскрибация аудио/видео из inbox/ через API wormsoft\n" +
  "  /transcribe                                  — самый свежий файл из inbox/\n" +
  "  /transcribe meeting.mp4                      — конкретный файл из inbox/\n" +
  "  /transcribe <путь.mp4>                       — абсолютный путь\n" +
  "Флаги:\n" +
  "  --lang <ru|en>          язык (по умолчанию ru)\n" +
  "  --model <gigaam|whisper-large>  пропустить интерактивный выбор\n" +
  "  --format <text|srt|vtt|json|verbose_json>  формат (по умолчанию text)";

async function handleTranscribe(
  args: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  const parsed = parseArgs(args);

  if (parsed.error === "HELP") {
    ctx.ui.notify(HELP_TEXT, "info");
    return;
  }
  if (parsed.error) {
    ctx.ui.notify(`pi-transcribe: ${parsed.error}`, "error");
    return;
  }

  // 1. Resolve the source file.
  let source: string;
  if (parsed.file) {
    const r = resolveSourcePath(parsed.file);
    if (!r.ok) {
      ctx.ui.notify(`Файл не найден в inbox: ${r.error}`, "error");
      return;
    }
    source = r.path;
    if (!sourceExists(source)) {
      ctx.ui.notify(`Файл не найден: ${source}`, "error");
      return;
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

  // 2. Model selection (interactive unless --model passed).
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

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("transcribe", {
    description:
      "Транскрибация аудио/видео из inbox/ (wormsoft API). Флаги: --lang ru|en, --model gigaam|whisper-large, --format text|srt|vtt|json|verbose_json. --help — справка.",
    getArgumentCompletions: (prefix: string) => {
      const files = latestInboxFile() ? listOutFiles() : [];
      void files;
      const candidates = ["--lang", "--model", "--format", "--help"];
      const filtered = candidates.filter((c) => c.startsWith(prefix));
      return filtered.length > 0 ? filtered.map((v) => ({ value: v, label: v })) : null;
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      await handleTranscribe(args, ctx, pi);
    },
  });

  pi.registerCommand("transcribe-status", {
    description: "Содержимое out/ проекта transcribe (манифесты и результаты)",
    handler: async (args: string, ctx: ExtensionContext) => {
      await handleStatus(args, ctx);
    },
  });
}
