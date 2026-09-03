/**
 * fix-names.ts -- automatic cleanup of corrupted Cyrillic filenames in out/.
 *
 * Root cause chain (see README "Cyrillic/encoding practices"):
 *   1. The summarizer agent may type U+FFFD (replacement char) into filenames
 *      when Cyrillic letters get corrupted in its history.
 *   2. Python on Windows with default cp1251 encoding muts Cyrillic to U+FFFD.
 *
 * This module guarantees cleanup even when the agent errs:
 *   - `sanitizeName(name)` strips U+FFFD / non-printable / non-alphanumeric
 *     chars (letters, digits, '-._' are kept).
 *   - `corruptedNames(names)` selects filenames needing cleanup.
 * Pure: no fs ops here — fs lives in the command handler (index.ts).
 */

/** Characters allowed in filenames besides letters/digits. */
const ALLOWED = "-._";

/** Unicode-aware letters/digits (incl. Cyrillic), no spaces/underscores. */
const ALNUM = /[\p{L}\p{N}\p{M}]/u;

/**
 * Strip U+FFFD, non-printable and other non-alphanumeric chars from a name.
 * Letters and digits (any alphabet incl. Cyrillic) and ALLOWED chars are kept.
 */
export function sanitizeName(name: string): string {
  const chars = [];
  for (const c of name) {
    if (ALNUM.test(c) || ALLOWED.includes(c)) chars.push(c);
  }
  return chars.join("");
}

/** True when the name contains chars outside letters/digits/ALLOWED. */
export function isCorrupted(name: string): boolean {
  return sanitizeName(name) !== name;
}

/** Select filenames needing cleanup. */
export function corruptedNames(names: string[]): string[] {
  return names.filter(isCorrupted);
}
