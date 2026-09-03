/**
 * ticker.ts -- 5-minute ticker for window reset detection.
 *
 * Every TICK_MS we call checkAndReset(emit) which, under a lock:
 *   - reads the current state
 *   - if it is null -> nothing to do
 *   - if window has expired -> dedup check, then reset (emit "billing:window_reset")
 *   - if window is about to expire (<= ABOUT_TO_RESET_MS remaining) -> emit "billing:window_about_to_reset"
 *
 * startTicker(emit) starts a module-level setInterval.
 * stopTicker() clears it (safe to call multiple times).
 */

import { mutateState, type State } from "./state.js";

export const TICK_MS = 5 * 60 * 1000;
export const ABOUT_TO_RESET_MS = 5 * 60 * 1000;
export const DEDUP_WINDOW_MS = 10 * 60 * 1000;

export type EmitFn = (event: string, payload: unknown) => void;

export async function checkAndReset(emit: EmitFn): Promise<boolean> {
  try {
    let didReset = false;
    let aboutToReset: { provider: string; msRemaining: number } | null = null;

    await mutateState<true>((state) => {
      if (state === null) {
        return { next: null, result: true };
      }

      const now = Date.now();
      const elapsed = now - state.windowStartedAt;

      if (elapsed >= state.windowMs) {
        // Dedup: if another process reset very recently, do not emit again.
        if (now - state.lastResetAt < DEDUP_WINDOW_MS) {
          return { next: null, result: true };
        }

        const next: State = {
          provider: state.provider,
          windowStartedAt: now,
          windowMs: state.windowMs,
          lastResetAt: now,
          resetCount: state.resetCount + 1,
          callsInWindow: 0,
          firstCallEmittedAt: undefined,
        };

        didReset = true;
        return { next, result: true };
      }

      // Window not expired yet. Check if it is about to expire.
      const msRemaining = state.windowMs - elapsed;
      if (msRemaining <= ABOUT_TO_RESET_MS) {
        aboutToReset = { provider: state.provider, msRemaining };
      }

      return { next: null, result: true };
    });

    if (didReset) {
      // Re-read the freshly written state to pass to subscribers so they see
      // the new windowStartedAt / resetCount / etc.
      const fresh = (await import("./state.js")).readStateSync();
      emit("billing:window_reset", fresh);
    } else if (aboutToReset !== null) {
      emit("billing:window_about_to_reset", aboutToReset);
    }

    return didReset;
  } catch (err) {
    // Never let a ticker failure kill the host process.
    console.warn("pi-billing-window: checkAndReset failed:", err);
    return false;
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startTicker(emit: EmitFn): () => void {
  // If already running, stop the previous one so we never have two intervals.
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }

  intervalHandle = setInterval(() => {
    void checkAndReset(emit);
  }, TICK_MS);

  return () => {
    if (intervalHandle !== null) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  };
}

export function stopTicker(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
