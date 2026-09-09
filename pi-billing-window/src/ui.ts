/**
 * ui.ts -- status bar widget for billing window.
 *
 * Persistent widget in the TUI footer showing a live countdown of the
 * 2-hour billing window. Updates every intervalMs (default 30 s) via
 * ctx.ui.setStatus(key, text).
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
 * Format remaining milliseconds into the status bar text.
 *
 *   remainingMs <= 0  -> "[осталось: 0:00 м.]"
 *   otherwise         -> "[осталось: H:MM м.]"  (no leading zero on hours)
 *
 * Hours are not capped: if the window is somehow > 24h, H reflects the
 * real count (e.g. "25:00"). Minutes are zero-padded to two digits.
 * Seconds are dropped (rounded down to whole minutes).
 */
export function renderStatusBar(remainingMs: number): string {
  if (remainingMs <= 0) {
    return "[осталось: 0:00 м.]";
  }

  const totalMinutes = Math.floor(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const mm = String(minutes).padStart(2, "0");

  return `[осталось: ${hours}:${mm} м.]`;
}

/**
 * Compute remaining ms from the current state, or null if no state exists.
 */
function computeRemainingMs(): number | null {
  const state = readStateSync();
  if (state === null) return null;
  return state.windowStartedAt + state.windowMs - Date.now();
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

  const remaining = computeRemainingMs();
  if (remaining === null) {
    ctx.ui.setStatus(key, undefined);
  } else {
    // If this conversation has an active cont-after-reset flag, surface it in
    // the timer widget so the user can see it is armed.
    const base = renderStatusBar(remaining);
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
      applyStatus(currentCtx, currentKey);
    }
  }, intervalMs);

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
