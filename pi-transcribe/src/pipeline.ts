/**
 * pipeline.ts -- spawn wrappers around the transcribe project scripts.
 *
 *   python scripts/prepare.py <input> --lang <lang> [--chunk-seconds N]
 *   python scripts/transcribe.py <input|manifest> --model <m> --lang <l> --format <f>
 *
 * No persistent state, no timers. All state is on disk in the project out/.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  getPrepareScript,
  getTranscribeScript,
  getOutDir,
  getProjectDir,
  type Model,
  type OutputFormat,
} from "./paths.js";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Python executable. Defaults to "python" (Windows PATH). */
  python?: string;
  /** Working directory for the child. Defaults to PROJECT_DIR. */
  cwd?: string;
  /** Kill the child after this many ms. 0/undefined = no timeout. */
  timeoutMs?: number;
  /** Optional progress callback for streamed stdout+stderr lines. */
  onLine?: (line: string) => void;
  /** Environment (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

function run(
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const python = opts.python ?? "python";
  const cwd = opts.cwd ?? getProjectDir();
  return new Promise<RunResult>((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(python, args, {
        cwd,
        env: opts.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      resolvePromise({
        code: null,
        stdout: "",
        stderr: `не удалось запустить ${python}: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const settle = (r: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(r);
    };

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {}
        settle({
          code: null,
          stdout,
          stderr: `таймаут ${opts.timeoutMs} мс: процесс убит`,
        });
      }, opts.timeoutMs);
    }

    const feed = (chunk: Buffer, sink: (s: string) => void) => {
      const text = chunk.toString("utf8");
      sink(text);
      // Line-based progress callback.
      for (const part of text.split(/\r?\n/)) {
        const line = part.trimEnd();
        if (line && opts.onLine) {
          try {
            opts.onLine(line);
          } catch {
            // never let a progress callback kill the run
          }
        }
      }
    };

    child.stdout?.on("data", (c: Buffer) => {
      stdout += c;
      feed(c, () => {});
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c;
      feed(c, () => {});
    });
    child.on("error", (e) => {
      settle({ code: null, stdout, stderr: `${stderr}\nspawn error: ${e.message}` });
    });
    child.on("close", (code) => {
      settle({ code: code ?? -1, stdout, stderr });
    });
  });
}

export interface PrepareArgs {
  /** Absolute path to the source file. */
  input: string;
  /** ISO-639-1 code, e.g. "ru". */
  lang: string;
  /** Optional chunk length in seconds (passed through). */
  chunkSeconds?: number;
}

/** Build the argv for prepare.py (exported for unit tests). */
export function prepareCommand(args: PrepareArgs): string[] {
  const a = [getPrepareScript(), args.input, "--lang", args.lang];
  if (args.chunkSeconds && args.chunkSeconds > 0) {
    a.push("--chunk-seconds", String(args.chunkSeconds));
  }
  return a;
}

/** Run prepare.py. Returns true on exit code 0. */
export async function runPrepare(
  args: PrepareArgs,
  opts: RunOptions = {},
): Promise<RunResult & { ok: boolean }> {
  if (!existsSync(getPrepareScript())) {
    return {
      ok: false,
      code: null,
      stdout: "",
      stderr: `скрипт не найден: ${getPrepareScript()}`,
    };
  }
  const r = await run(prepareCommand(args), opts);
  return { ...r, ok: r.code === 0 };
}

export interface TranscribeArgs {
  /** Absolute path to the manifest (or audio file). */
  input: string;
  model: Model;
  lang: string;
  format: OutputFormat;
  /**
   * Always pass --no-interactive: the extension asks the user for the model
   * itself (via ctx.ui.select) and passes it explicitly.
   */
  noInteractive?: boolean;
}

/** Build the argv for transcribe.py (exported for unit tests). */
export function transcribeCommand(args: TranscribeArgs): string[] {
  const a = [
    getTranscribeScript(),
    args.input,
    "--model",
    args.model,
    "--lang",
    args.lang,
    "--format",
    args.format,
    "--out-dir",
    getOutDir(),
  ];
  if (args.noInteractive !== false) {
    a.push("--no-interactive");
  }
  return a;
}

/** Run transcribe.py. Returns true on exit code 0. */
export async function runTranscribe(
  args: TranscribeArgs,
  opts: RunOptions = {},
): Promise<RunResult & { ok: boolean }> {
  if (!existsSync(getTranscribeScript())) {
    return {
      ok: false,
      code: null,
      stdout: "",
      stderr: `скрипт не найден: ${getTranscribeScript()}`,
    };
  }
  const r = await run(transcribeCommand(args), opts);
  return { ...r, ok: r.code === 0 };
}

/**
 * Run prepare + transcribe as one pipeline. Progress lines are streamed to
 * onProgress when provided. Returns the final step result plus per-step logs.
 */
export interface PipelineResult {
  ok: boolean;
  prepared: RunResult & { ok: boolean };
  transcribed: RunResult & { ok: boolean };
}

export async function runPipeline(
  prepareArgs: PrepareArgs,
  transcribeArgs: TranscribeArgs,
  opts: { onProgress?: (line: string) => void; python?: string; timeoutMs?: number } = {},
): Promise<PipelineResult> {
  const baseOpts: RunOptions = {
    python: opts.python,
    timeoutMs: opts.timeoutMs,
    onLine: opts.onProgress,
  };
  const prepared = await runPrepare(prepareArgs, baseOpts);
  if (!prepared.ok) {
    return { ok: false, prepared, transcribed: prepared };
  }
  const transcribed = await runTranscribe(transcribeArgs, baseOpts);
  return { ok: transcribed.ok, prepared, transcribed };
}
