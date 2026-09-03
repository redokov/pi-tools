/**
 * output.ts -- read transcription results from the transcribe project's out/.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import {
  FORMAT_EXT,
  manifestPathFor,
  resultPathFor,
  type OutputFormat,
} from "./paths.js";

/**
 * Read the result file for baseName + format.
 * Returns { ok: true, path, text, lines } or { ok: false, error }.
 */
export function readResult(
  baseName: string,
  format: OutputFormat,
): { ok: true; path: string; text: string; lines: string[] } | { ok: false; error: string } {
  const path = resultPathFor(baseName, format);
  if (!existsSync(path)) {
    return { ok: false, error: `файл результата не найден: ${path}` };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, error: `не удалось прочитать ${path}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const lines = text.split(/\r?\n/);
  return { ok: true, path, text, lines };
}

/**
 * Render a result for chat display, truncating long output.
 * Returns { shown, total, note } where shown is the text to print.
 */
export function truncateForChat(
  lines: string[],
  maxLines: number,
  fullPath: string,
): { shown: string; total: number; note: string | null } {
  const total = lines.length;
  if (total <= maxLines) {
    return { shown: lines.join("\n"), total, note: null };
  }
  const shown = lines.slice(0, maxLines).join("\n");
  const note = `… показаны первые ${maxLines} из ${total} строк, полный файл: ${fullPath}`;
  return { shown, total, note };
}

/** True when the manifest file for baseName exists (prepare already ran). */
export function hasManifest(baseName: string): boolean {
  return existsSync(manifestPathFor(baseName));
}

export interface OutEntry {
  name: string;
  size: number;
  mtimeMs: number;
}

/**
 * Group out/ files by base name: manifest + per-format results.
 * Returns rows sorted by mtime desc.
 */
export function summarizeOut(entries: OutEntry[]): string {
  if (entries.length === 0) {
    return "out/ пуст — результатов пока нет.";
  }
  const byBase = new Map<string, OutEntry[]>();
  for (const e of entries) {
    let base = e.name;
    if (base.toLowerCase().endsWith(".manifest.json")) {
      base = base.slice(0, -".manifest.json".length);
    } else {
      const m = base.match(/^(.*)\.(txt|srt|vtt|json)$/);
      if (m) base = m[1];
      // careful: "name.verbose.json" -> "name"
      const m2 = base.match(/^(.*)\.json$/);
      if (m && base !== e.name) {
        // for "name.json" produced from format json -> base "name"; but for
        // "name.verbose.json" the first match already gave "name.verbose"
        const m3 = e.name.match(/^(.*)\.verbose\.json$/);
        if (m3) base = m3[1];
      }
      void m2;
    }
    const arr = byBase.get(base) ?? [];
    arr.push(e);
    byBase.set(base, arr);
  }

  const rows: string[] = [];
  for (const [base, files] of [...byBase.entries()].sort((a, b) =>
    (b[1][0]?.mtimeMs ?? 0) - (a[1][0]?.mtimeMs ?? 0),
  )) {
    const names = files.map((f) => f.name).join(", ");
    const newest = Math.max(...files.map((f) => f.mtimeMs));
    const when = new Date(newest).toLocaleString();
    rows.push(`• ${base}  [${when}]  →  ${names}`);
  }
  return rows.join("\n");
}

/** Format bytes for a compact display. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export { statSync };
export const extForFormat = (f: OutputFormat) => FORMAT_EXT[f];
