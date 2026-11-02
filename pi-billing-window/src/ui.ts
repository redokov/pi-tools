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
import { uidiag } from "./uidiag.js";

const DEFAULT_KEY = "billing-window";
// 30 s: README/TZ promise a ~30 s refresh, and a 5-min cadence reads as a
// "frozen" countdown to the user. Cheap enough (one tiny file read per tick).
const DEFAULT_INTERVAL_MS = 30_000;

/**
 * Spec 018 (FR-018-1): machine-readable outcome of a status push. Every
 * (previously silent) bail branch and any failure gets a code so callers
 * (tests, the tick fail-streak FR-018-6, the refresh machinery FR-018-3)
 * can react without guessing.
 *
 * - "ok"            -- status text set;
 * - "cleared"       -- line removed via setStatus(key, undefined) because the
 *                      provider is not wormsoft (the visibility rule applied
 *                      successfully -- by design, NOT a failure, D-006);
 * - "bail:no-ctx"   -- no ctx at all;
 * - "bail:no-ui"    -- ctx present but ctx.ui/setStatus missing;
 * - "bail:provider" -- reserved for the provider bail (currently folded into
 *                      "cleared" -- kept in the union per FR-018-1);
 * - "bail:no-state" -- no persisted window state yet (transient, no log);
 * - "error"         -- touching ctx THREW (stale ctx) -- assigned by the
 *                      applyStatusSafe wrapper, the single try/catch owner.
 */
export type StatusOutcome =
  | "ok"
  | "cleared"
  | "bail:no-ctx"
  | "bail:no-ui"
  | "bail:provider"
  | "bail:no-state"
  | "error";

let currentInterval: NodeJS.Timeout | null = null;
let currentCtx: any = null;
let currentKey: string | null = null;

// Spec 018 (FR-018-6): consecutive failed ticks of the current updater
// episode. First failure of an episode logs `tick:error` via uidiag; a
// successful tick resets it. Reset on stop/start of the updater.
let tickFailStreak = 0;

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
 * Spec 018 (FR-018-1): returns a StatusOutcome code instead of void. The
 * branch logic/order is unchanged -- every branch just returns its code.
 * IMPORTANT: an exception thrown while TOUCHING ctx (stale ctx after
 * session replacement) PROPAGATES out of here; the single try/catch owner
 * is applyStatusSafe (D-004 / design §3.2).
 *
 * Visibility rule: the status line is only shown when the active model
 * belongs to the wormsoft provider. For any other provider (or when no
 * model is selected) the line is cleared via setStatus(key, undefined).
 */
function applyStatus(ctx: any, key: string, provider?: string): StatusOutcome {
  if (!ctx) return "bail:no-ctx";
  if (!ctx.ui || typeof ctx.ui.setStatus !== "function") {
    return "bail:no-ui";
  }

  // Visibility rule: the status line is only shown when the active model
  // belongs to the wormsoft provider. `provider` may be passed explicitly
  // (e.g. from model_select, where ctx.model may not be refreshed yet);
  // otherwise it is read from the current model. For any other provider (or
  // when no model is selected) the line is cleared via setStatus(key, undefined).
  const effectiveProvider = provider ?? ctx.model?.provider;
  if (effectiveProvider !== "wormsoft") {
    ctx.ui.setStatus(key, undefined);
    return "cleared";
  }

  const resetAt = computeResetAt();
  if (resetAt === null) {
    ctx.ui.setStatus(key, undefined);
    return "bail:no-state";
  }
  // If this conversation has an active cont-after-reset flag, surface it in
  // the timer widget so the user can see it is armed.
  const base = renderStatusBar(resetAt);
  const text = isContAfterResetArmed() ? `${base} [cont-after-reset]` : base;
  ctx.ui.setStatus(key, text);
  return "ok";
}

/**
 * Spec 018 (FR-018-5a, design §3.2): the SINGLE try/catch around applyStatus.
 * `reason` encodes the calling PATH (tick / force / refresh) so the uidiag
 * line says WHO failed. Never throws; returns "error" on a stale ctx.
 */
function applyStatusSafe(
  ctx: any,
  key: string,
  reason: string,
  provider?: string,
): StatusOutcome {
  try {
    return applyStatus(ctx, key, provider);
  } catch (err) {
    uidiag(
      `${reason}:error`,
      err instanceof Error ? err.message : String(err),
    );
    return "error";
  }
}

/**
 * One-shot status push. Useful for commands like /billing-status that want
 * to refresh the footer immediately without waiting for the next tick.
 *
 * Spec 018 (D-004): NEVER THROWS anymore -- delegates to applyStatusSafe, so
 * every one of the ~10 call sites in index.ts is protected by this single
 * point. Positional signature (ctx, key?, provider?) is unchanged.
 */
export function forceUpdate(
  ctx: any,
  key: string = DEFAULT_KEY,
  provider?: string,
): StatusOutcome {
  return applyStatusSafe(ctx, key, "force", provider);
}

/**
 * Spec 018 (FR-018-3, D-005): self-heal the updater's ctx binding.
 *
 * Called from event handlers in index.ts (after_provider_response,
 * model_select, session_start) with the LIVE ctx of the current session:
 *
 * - ctx is a live tui ctx DIFFERENT from the updater's currentCtx ->
 *   swap currentCtx (the interval keeps running; the next tick -- or the
 *   immediate apply below -- revives the widget; no stop/start needed);
 * - same ctx -> idempotent immediate apply;
 * - ctx is dead (reading ctx.mode throws) -> uidiag("refresh:stale-ctx")
 *   and a quiet return (nothing to heal; the next event brings a live ctx);
 * - non-tui process -> quiet return (the norm, D-006).
 */
export function refreshStatusContext(ctx: any, provider?: string): void {
  if (!ctx) return;
  let isTui: boolean;
  try {
    isTui = ctx.mode === "tui";
  } catch {
    uidiag("refresh:stale-ctx");
    return;
  }
  if (!isTui) return;
  if (ctx !== currentCtx) {
    // Swap the binding transparently: currentKey/currentInterval stay --
    // the interval is alive and the nearest tick picks the new ctx up.
    currentCtx = ctx;
  }
  applyStatusSafe(ctx, currentKey ?? DEFAULT_KEY, "refresh", provider);
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
  // Fresh updater -> fresh failure episode (design §3.4).
  tickFailStreak = 0;

  currentInterval = setInterval(() => {
    // Spec 018 (D-005): the tick NEVER re-binds ctx itself (it has no live
    // ctx to bind -- refreshStatusContext from event handlers does that).
    // It stays a cheap always-ticking probe: a stale ctx throws instantly,
    // applyStatusSafe swallows it, and the first failure of an episode
    // leaves a `tick:error` uidiag trace (FR-018-6) instead of the old
    // forever-silent catch (spec 007's fix kept pi alive but hid the
    // freeze -- spec 018 makes the failure visible and healable).
    if (!currentCtx || !currentKey) return; // updater stopped
    const outcome = applyStatusSafe(currentCtx, currentKey, "tick");
    if (outcome === "error") {
      tickFailStreak++;
      if (tickFailStreak === 1) {
        uidiag("tick:error", `streak start, key=${currentKey}`);
      }
    } else {
      tickFailStreak = 0;
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
    tickFailStreak = 0; // spec 018 (FR-018-6): a stopped episode ends
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
  tickFailStreak = 0; // spec 018 (FR-018-6): a stopped episode ends
}

/**
 * Spec 018 (FR-018-6): test probe -- the current updater's consecutive
 * failed-tick count. Never throws; reads module state only.
 */
export function getTickFailStreakForTests(): number {
  return tickFailStreak;
}

/**
 * Spec 003 (exit hygiene): test probe -- whether the running interval is
 * ref'd (keeps the event loop alive). null = no interval running.
 */
export function hasRefForTests(): boolean | null {
  return currentInterval === null ? null : currentInterval.hasRef();
}
