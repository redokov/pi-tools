/**
 * args.ts -- argument parsing and defaults for /transcribe commands.
 *
 * Shared by index.ts (command wiring) and tests. Pure: no fs, no ui.
 */

import type { Model, OutputFormat } from "./paths.js";

export const MODEL_SET = new Set(["gigaam", "whisper-large"]);
export const FORMAT_SET = new Set(["text", "srt", "vtt", "json", "verbose_json"]);

/**
 * Default model for /transcribe. The interactive prompt (askModelChoice)
 * still shows gigaam first and keeps gigaam as its cancel-fallback; the
 * non-interactive default is whisper-large per TZ.
 */
export const DEFAULT_MODEL: Model = "whisper-large";

/** Default model for /transcribe-gigaam. */
export const GIGAAAM_MODEL: Model = "gigaam";

export interface ParsedArgs {
  file?: string;
  lang: string;
  model?: Model;
  format: OutputFormat;
  /** --no-summary: skip the automatic agent summarization request. */
  noSummary: boolean;
  /** --summary-prompt <text>: override the summarization prompt. */
  summaryPrompt?: string;
  error?: string;
}

/**
 * Tokenize a command-line argument string.
 * Supports double and single quotes so paths with spaces survive:
 *   `C:\a b\file.mp4 --lang en`  →  ["C:\a b\file.mp4", "--lang", "en"]
 *   `"C:\a b\file.mp4"`         →  ["C:\a b\file.mp4"]
 * Unquoted spaces still separate tokens (backwards compatible).
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inDQ = false;
  let inSQ = false;
  let hasToken = false;
  for (const ch of input) {
    if (ch === '"' && !inSQ) {
      inDQ = !inDQ;
      hasToken = true;
      continue;
    }
    if (ch === "'" && !inDQ) {
      inSQ = !inSQ;
      hasToken = true;
      continue;
    }
    if ((ch === " " || ch === "\t") && !inDQ && !inSQ) {
      if (hasToken) {
        tokens.push(cur);
        cur = "";
        hasToken = false;
      }
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(cur);
  return tokens;
}

export function parseArgs(args: string): ParsedArgs {
  const tokens = tokenize(args ?? "");
  const out: ParsedArgs = { lang: "ru", format: "text", noSummary: false };
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
    } else if (t === "--summary-prompt") {
      // The prompt is free text: consume the rest of the line as one string.
      const rest = tokens.slice(i + 1);
      if (rest.length === 0) {
        out.error = "--summary-prompt требует значения (текст запроса)";
        return out;
      }
      out.summaryPrompt = rest.join(" ");
      i = tokens.length; // stop; summary prompt is the last option
    } else if (t === "--no-summary") {
      out.noSummary = true;
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
