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

/** Compute the moment the window resets.
 *
 * The provider's window is a LAZY anchor: the real 2h slot starts at the
 * FIRST credit spend of the window (state.firstCallEmittedAt), not at the
 * reset moment (windowStartedAt). When a first call is recorded, the
 * boundary follows it: fireAt = max(windowStartedAt, firstCallEmittedAt) +
 * windowMs. Without a first call yet (idle window), the reset moment is
 * used as before. This is what keeps the watchdog from firing (120 - N)
 * minutes early after /settimer N and from drifting one "reset -> first
 * call" gap per cycle (the 2026-10 drift investigation).
 */
export function computeFireAt(state: {
  windowStartedAt: number;
  windowMs: number;
  /** Lazy provider anchor: first call of the current window, if any. */
  firstCallEmittedAt?: number;
}): number {
  const start = Math.max(
    state.windowStartedAt,
    state.firstCallEmittedAt ?? state.windowStartedAt,
  );
  return start + state.windowMs;
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
  // Unref parity (spec 003, spec 012 T7): the watchdog is armed ~2h ahead
  // at the window boundary; a ref'd handle kept every embedded/test process
  // (tsx suites, repro harnesses) alive until the boundary. The pi host
  // process holds its own loop, so unref changes nothing in production.
  handle.unref();
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
