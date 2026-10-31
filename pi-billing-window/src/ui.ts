/**
 * ui.ts -- status bar widget for billing window.
 *
 * Persistent widget in the TUI footer showing the ABSOLUTE TIME of the
 * next billing-window reset, e.g. "[обновится в 17:30]". Pushed via
 * ctx.ui.setStatus(key, text). Updated every intervalMs (default 30 s).
 *
 * The time is deterministic (windowStartedAt + windowMs) so the widget does
 * NOT tick down: it shows the next reset moment in local time and is only
 * refreshed periodically (and on every window_reset event).
 *
 * Module-level state (currentInterval, currentCtx, currentKey) is shared so
 * that stopStatusUpdater() can tear everything down from anywhere -- and so
 * that re-calling startStatusUpdater() while another is running cleans up
 * the previous one.
 */

import { readStateSync } from "./state.js";
import { isArmed as isContAfterResetArmed } from "./arms.js";

const DEFAULT_KEY = "billing-window";
// 30 s: README/TZ promise a ~30 s refresh, and a 5-min cadence reads as a
// "frozen" countdown to the user. Cheap enough (one tiny file read per tick).
const DEFAULT_INTERVAL_MS = 30_000;

let currentInterval: NodeJS.Timeout | null = null;
let currentCtx: any = null;
let currentKey: string | null = null;

/**
 * Format the next reset moment into the status bar text.
 *
 *   resetAt -> "[обновится в ЧЧ:ММ]"   (24h clock, zero-padded HH:MM)
 *
 * E.g. "[обновится в 17:30]". Uses local wall-clock time of the reset
 * boundary (windowStartedAt + windowMs).
 */
export function renderStatusBar(resetAt: number): string {
  const d = new Date(resetAt);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `[обновится в ${hh}:${mm}]`;
}

/**
 * Compute the reset boundary from the current state, or null if no state
 * exists.
 *
 * Lazy provider anchor (2026-10 drift fix): the real window starts at the
 * FIRST credit spend of the window (firstCallEmittedAt), not at the reset
 * moment. The indicator shows max(windowStartedAt, firstCallEmittedAt) +
 * windowMs -- the provider's real boundary, so "обновится в ЧЧ:ММ" matches
 * the wormsoft dashboard instead of drifting a gap per cycle.
 */
function computeResetAt(): number | null {
  const state = readStateSync();
  if (state === null) return null;
  const start = Math.max(
    state.windowStartedAt,
    state.firstCallEmittedAt ?? state.windowStartedAt,
  );
  return start + state.windowMs;
}

/**
 * Push the current status (or clear it) to the given ctx.
 * Defensive: silently bails if ctx or ctx.ui is missing or invalid.
 *
 * Visibility rule: the status line is only shown when the active model
 * belongs to the wormsoft provider. For any other provider (or when no
 * model is selected) the line is cleared via setStatus(key, undefined).
 */
function applyStatus(ctx: any, key: string, provider?: string): void {
  if (!ctx || !ctx.ui || typeof ctx.ui.setStatus !== "function") return;

  // Visibility rule: the status line is only shown when the active model
  // belongs to the wormsoft provider. `provider` may be passed explicitly
  // (e.g. from model_select, where ctx.model may not be refreshed yet);
  // otherwise it is read from the current model. For any other provider (or
  // when no model is selected) the line is cleared via setStatus(key, undefined).
  const effectiveProvider = provider ?? ctx.model?.provider;
  if (effectiveProvider !== "wormsoft") {
    ctx.ui.setStatus(key, undefined);
    return;
  }

  const resetAt = computeResetAt();
  if (resetAt === null) {
    ctx.ui.setStatus(key, undefined);
  } else {
    // If this conversation has an active cont-after-reset flag, surface it in
    // the timer widget so the user can see it is armed.
    const base = renderStatusBar(resetAt);
    const text = isContAfterResetArmed() ? `${base} [cont-after-reset]` : base;
    ctx.ui.setStatus(key, text);
  }
}

/**
 * One-shot status push. Useful for commands like /billing-status that want
 * to refresh the footer immediately without waiting for the next tick.
 */
export function forceUpdate(
  ctx: any,
  key: string = DEFAULT_KEY,
  provider?: string,
): void {
  applyStatus(ctx, key, provider);
}

/**
 * Start the periodic status updater. Calls stopStatusUpdater() first, so
 * calling this while another updater is running cleanly replaces it (the
 * previous ctx's status line is cleared before the new one is started).
 *
 * In non-tui modes (print, rpc, etc.) the UI is absent -- we return a
 * no-op stopper so callers can still call it safely.
 *
 * Returns a stopper that clears the interval AND removes the status line
 * via setStatus(key, undefined).
 */
export function startStatusUpdater(
  ctx: any,
  options?: { key?: string; intervalMs?: number },
): () => void {
  // Non-tui mode -> no UI to update. Return a no-op stopper.
  if (!ctx || ctx.mode !== "tui") {
    return () => {};
  }

  // Replace any previously running updater (cleans its status line too).
  stopStatusUpdater();

  const key = options?.key ?? DEFAULT_KEY;
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;

  currentCtx = ctx;
  currentKey = key;

  currentInterval = setInterval(() => {
    if (currentCtx && currentKey) {
      try {
        applyStatus(currentCtx, currentKey);
      } catch (err) {
        // Spec 007 (live /reload crash): the session was replaced
        // (ctx.reload / restart) and the captured ctx went stale -- reading
        // ctx.ui throws via assertActive() and the uncaught exception KILLED
        // pi. The status bar is cosmetic: skip the tick silently. The
        // extension reload re-creates the updater for the new session.
        return;
      }
    }
  }, intervalMs);
  currentInterval.unref();

  // Capture for the stopper so it can clean up exactly what it started
  // even if a subsequent startStatusUpdater() has swapped module state.
  const capturedCtx = ctx;
  const capturedKey = key;

  return () => {
    if (currentInterval) {
      clearInterval(currentInterval);
      currentInterval = null;
    }
    try {
      capturedCtx?.ui?.setStatus?.(capturedKey, undefined);
    } catch {
      // ignore -- ctx may be torn down
    }
    if (currentCtx === capturedCtx) currentCtx = null;
    if (currentKey === capturedKey) currentKey = null;
  };
}

/**
 * Stop the running updater (if any) and clear the status line.
 * Safe to call multiple times.
 */
export function stopStatusUpdater(): void {
  if (currentInterval) {
    clearInterval(currentInterval);
    currentInterval = null;
  }
  if (currentCtx && currentKey) {
    try {
      currentCtx.ui.setStatus(currentKey, undefined);
    } catch {
      // ignore -- ctx may be torn down
    }
  }
  currentCtx = null;
  currentKey = null;
}

/**
 * Spec 003 (exit hygiene): test probe -- whether the running interval is
 * ref'd (keeps the event loop alive). null = no interval running.
 */
export function hasRefForTests(): boolean | null {
  return currentInterval === null ? null : currentInterval.hasRef();
}
