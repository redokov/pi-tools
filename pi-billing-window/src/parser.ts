/**
 * parser.ts -- pure functions for parsing and formatting durations.
 *
 * No side effects, no I/O. Safe to import from anywhere.
 */

/**
 * Result of parseDuration. On success, totalMs holds the parsed value
 * (>= 0). On error, totalMs is 0 and error contains a short Russian
 * description of the problem.
 */
export type ParsedDuration = {
  totalMs: number;
  error?: string;
};

/**
 * Parse a human-friendly duration string.
 *
 * Supported formats:
 *   - bare integer -> minutes, e.g. "60" = 60 min
 *   - "Nm"         -> minutes,   e.g. "90m"
 *   - "Nh"         -> hours,     e.g. "2h"
 *   - "Nh Nm"      -> hours and minutes, e.g. "1h30m"
 *
 * Case-insensitive. Surrounding whitespace is trimmed. "0" is valid
 * and returns { totalMs: 0 }.
 *
 * Anything else (empty, negative, fractional, unknown suffix like s/d,
 * non-numeric input, mixed junk) -> { totalMs: 0, error: "..." }.
 */
export function parseDuration(input: string): ParsedDuration {
  if (typeof input !== "string") {
    return { totalMs: 0, error: "значение не является строкой" };
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { totalMs: 0, error: "пустое значение" };
  }

  // Pattern A: "Nh Nm" / "N h N m" (case-insensitive, optional spaces between)
  // Groups: 1 = hours digits, 2 = minutes digits.
  const combined = /^(\d+)\s*h\s*(\d+)\s*m$/i.exec(trimmed);
  if (combined) {
    const hours = Number(combined[1]);
    const minutes = Number(combined[2]);
    return {
      totalMs: ((hours * 60) + minutes) * 60 * 1000,
    };
  }

  // Pattern B: "Nh" (case-insensitive)
  const hoursOnly = /^(\d+)\s*h$/i.exec(trimmed);
  if (hoursOnly) {
    const hours = Number(hoursOnly[1]);
    return {
      totalMs: hours * 60 * 60 * 1000,
    };
  }

  // Pattern C: "Nm" (case-insensitive)
  const minutesOnly = /^(\d+)\s*m$/i.exec(trimmed);
  if (minutesOnly) {
    const minutes = Number(minutesOnly[1]);
    return {
      totalMs: minutes * 60 * 1000,
    };
  }

  // Pattern D: bare integer -> minutes
  const bareInt = /^(\d+)$/.exec(trimmed);
  if (bareInt) {
    const minutes = Number(bareInt[1]);
    return {
      totalMs: minutes * 60 * 1000,
    };
  }

  // Anything else is an error. Try to give a useful hint for the
  // most common mistakes.
  if (/^-/.test(trimmed)) {
    return { totalMs: 0, error: "отрицательное значение недопустимо" };
  }
  if (/^\d+\.\d+/.test(trimmed)) {
    return { totalMs: 0, error: "дробные значения не поддерживаются" };
  }
  if (/\d+\s*s$/i.test(trimmed)) {
    return { totalMs: 0, error: "секунды не поддерживаются, используйте минуты или часы" };
  }
  if (/\d+\s*d$/i.test(trimmed)) {
    return { totalMs: 0, error: "дни не поддерживаются, используйте минуты или часы" };
  }
  return {
    totalMs: 0,
    error: `не удалось разобрать "${trimmed}" (примеры: 60, 90m, 1h, 1h30m)`,
  };
}

/**
 * Format a non-negative millisecond count as "HH:MM:SS".
 *
 * Negative inputs render as "00:00:00". No upper cap on hours
 * (25h renders as "25:00:00").
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "00:00:00";
  }

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));

  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}
