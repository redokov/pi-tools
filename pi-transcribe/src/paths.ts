/**
 * paths.ts -- path handling for the transcribe project.
 *
 * All state lives on disk in the transcribe project (C:\MyProjects\transcribe):
 *   inbox/  -- source audio/video files
 *   out/    -- manifests and transcription results
 *
 * The extension never stores its own persistent state; these helpers only
 * normalize names and build/validate paths, with path-traversal protection.
 */

import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";

/** Root of the transcribe project. Override via env for tests. */
let PROJECT_DIR: string =
  process.env.TRANSCRIBE_PROJECT_DIR ?? "C:\\MyProjects\\transcribe";

/** Re-point the project root (tests only). Recomputes derived dirs. */
export function setProjectDir(dir: string): void {
  PROJECT_DIR = dir;
}

export function getProjectDir(): string {
  return PROJECT_DIR;
}

export function getInboxDir(): string {
  return join(PROJECT_DIR, "inbox");
}
export function getOutDir(): string {
  return join(PROJECT_DIR, "out");
}
export function getScriptsDir(): string {
  return join(PROJECT_DIR, "scripts");
}

export function getPrepareScript(): string {
  return join(getScriptsDir(), "prepare.py");
}
export function getTranscribeScript(): string {
  return join(getScriptsDir(), "transcribe.py");
}

// Back-compat aliases (module-level names imported by index/pipeline).
export const INBOX_DIR = join(PROJECT_DIR, "inbox");
export const OUT_DIR = join(PROJECT_DIR, "out");
export const SCRIPTS_DIR = join(PROJECT_DIR, "scripts");
export const PREPARE_SCRIPT = join(SCRIPTS_DIR, "prepare.py");
export const TRANSCRIBE_SCRIPT = join(SCRIPTS_DIR, "transcribe.py");

/** Accepted source extensions in inbox. */
const SOURCE_EXTS = new Set([
  ".mp4", ".mkv", ".avi", ".mov", ".webm", ".mp3", ".wav", ".m4a",
  ".flac", ".ogg", ".oga", ".opus", ".aac", ".wma",
]);

export const MODEL_CHOICES = ["gigaam", "whisper-large"] as const;
export type Model = (typeof MODEL_CHOICES)[number];

export const FORMAT_CHOICES = ["text", "srt", "vtt", "json", "verbose_json"] as const;
export type OutputFormat = (typeof FORMAT_CHOICES)[number];

export const FORMAT_EXT: Record<OutputFormat, string> = {
  text: "txt",
  srt: "srt",
  vtt: "vtt",
  json: "json",
  verbose_json: "verbose.json",
};

/**
 * Validate a user-supplied file name.
 * - must be a plain file name (no directories, no .. segments),
 * - must end with a known audio/video extension.
 * Returns an error message or null when valid.
 */
export function validateInboxName(name: string): string | null {
  const n = name.trim();
  if (!n) return "пустое имя файла";
  // Reject any path separators / drive letters / protocol-looking input.
  if (/[\\/]/.test(n) || /^[A-Za-z]:/.test(n) || n.includes(":")) {
    return "используй только имя файла, без путей (например meeting.mp4)";
  }
  const lower = n.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  if (!SOURCE_EXTS.has(ext)) {
    const allowed = [...SOURCE_EXTS].join(" ");
    return `неизвестное расширение '${ext || "(нет)"}'. Поддерживаются: ${allowed}`;
  }
  return null;
}

/**
 * Resolve a user-supplied source path to an absolute path.
 *
 * Rules:
 *  - absolute path (with drive letter or leading slash) -> used as-is,
 *    but still validated against traversal.
 *  - plain name -> INBOX_DIR/<name>, validated by validateInboxName().
 *
 * Returns { ok: true, path } or { ok: false, error }.
 */
export function resolveSourcePath(input: string): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "не указан файл" };

  if (isAbsolute(trimmed)) {
    // Absolute paths: resolve() already canonicalizes; only reject ".." in
    // the *relative* form (user typing ../.. into the command line). A
    // legitimate C:\a\..\b.mp4 resolves to a safe absolute path and is fine.
    const norm = resolve(trimmed);
    return { ok: true, path: norm };
  }

  const err = validateInboxName(trimmed);
  if (err) return { ok: false, error: err };
  return { ok: true, path: join(getInboxDir(), trimmed) };
}

/**
 * Base name for results: file name without extension.
 * "meeting.mp4" -> "meeting"; "meeting.mp4.manifest.json" -> "meeting.mp4".
 */
export function baseNameOf(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  // Strip trailing ".manifest.json" if present.
  const noManifest = name.toLowerCase().endsWith(".manifest.json")
    ? name.slice(0, -".manifest.json".length)
    : name;
  return noManifest.replace(/\.[^.]+$/, "");
}

export function manifestPathFor(baseName: string): string {
  return join(getOutDir(), `${baseName}.manifest.json`);
}

export function resultPathFor(baseName: string, format: OutputFormat): string {
  return join(getOutDir(), `${baseName}.${FORMAT_EXT[format]}`);
}

export function manifestExists(baseName: string): boolean {
  return existsSync(manifestPathFor(baseName));
}

/** True when baseName is a known transcribe project base name in out/. */
export function listOutFiles(): { name: string; size: number; mtime: number }[] {
  let entries: string[];
  try {
    entries = readdirSync(getOutDir());
  } catch {
    return [];
  }
  const result: { name: string; size: number; mtime: number }[] = [];
  for (const e of entries) {
    const p = join(getOutDir(), e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isFile()) {
      result.push({ name: e, size: st.size, mtime: st.mtimeMs });
    }
  }
  return result.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Pick the most recently modified file in inbox (excluding .gitkeep).
 * Returns absolute path or null.
 */
export function latestInboxFile(): string | null {
  let entries: string[];
  try {
    entries = readdirSync(getInboxDir());
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const e of entries) {
    if (e === ".gitkeep" || e.startsWith(".")) continue;
    const p = join(getInboxDir(), e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (!best || st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs };
  }
  return best ? best.path : null;
}

/** True when a *relative* name contains a ".." traversal segment. */
function hasTraversal(input: string): boolean {
  const parts = normalize(input).split(/[\\/]/);
  return parts.includes("..");
}

/**
 * Check that an absolute path is safe to treat as a source file:
 * it must exist, be a file, and (for inbox-relative names) stay inside inbox.
 */
export function sourceExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Display-safe relative path (for messages), e.g. "inbox\meeting.mp4". */
export function displayPath(p: string): string {
  const rel = relative(PROJECT_DIR, p);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
    return rel.split(sep).join("/");
  }
  return p;
}

/** Reset to default (clears the test override). */
export function resetProjectDir(): void {
  PROJECT_DIR = process.env.TRANSCRIBE_PROJECT_DIR ?? "C:\\MyProjects\\transcribe";
}
