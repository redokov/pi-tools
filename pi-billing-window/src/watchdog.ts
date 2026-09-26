/**
 * watchdog.ts -- one-shot process-wide timer for pi-billing-window.
 *
 * Manages a single setTimeout handle. `armWatchdog` clears any previously
 * armed timer and schedules a new one at `fireAt` (delay = max(0, fireAt -
 * Date.now())). Used to fire exactly at the billing window boundary.
 *
 * No I/O, only node:* imports.
 */

let handle: ReturnType<typeof setTimeout> | null = null;
let scheduledFireAt: number | null = null;

/** Compute the moment the window resets (windowStartedAt + windowMs). */
export function computeFireAt(state: {
  windowStartedAt: number;
  windowMs: number;
}): number {
  return state.windowStartedAt + state.windowMs;
}

/**
 * Arm the watchdog: cancel the previous timer and schedule `cb` at
 * `fireAt`. A `fireAt` in the past fires immediately (delay 0).
 */
export function armWatchdog(fireAt: number, cb: () => void): void {
  clearWatchdog();
  const delay = Math.max(0, fireAt - Date.now());
  handle = setTimeout(() => {
    handle = null;
    scheduledFireAt = null;
    cb();
  }, delay);
  scheduledFireAt = fireAt;
}

/** Cancel the armed timer (no-op if none). Idempotent. */
export function clearWatchdog(): void {
  if (handle !== null) {
    clearTimeout(handle);
    handle = null;
  }
  scheduledFireAt = null;
}

/** Whether a timer is currently armed. */
export function hasWatchdog(): boolean {
  return handle !== null;
}

/** The scheduled fire moment, or null if not armed (tests/diagnostics). */
export function pendingFireAt(): number | null {
  return scheduledFireAt;
}
