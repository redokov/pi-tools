/**
 * pi-billing-window -- tracks the 2-hour billing window for the wormsoft
 * provider and emits custom events that other pi extensions can subscribe to.
 *
 * Architecture
 * ------------
 * - state.ts: file-backed JSON state with proper-lockfile serialization
 * - ticker.ts: 5-minute timer that calls checkAndReset() under a lock
 * - ui.ts: status bar widget that renders a live countdown via ctx.ui.setStatus
 * - index.ts (this file): orchestration -- hooks + commands wiring
 *
 * Custom event channels (sent via pi.events / EventBus)
 * -----------------------------------------------------
 *   "billing:window_reset"         -> payload: fresh State after a reset
 *   "billing:window_about_to_reset"-> payload: { provider, msRemaining }
 *   "llm:first_call"               -> payload: { provider, timestamp, windowStartedAt }
 *
 * The first two are produced by ticker.ts (via the emitFn we pass to it).
 * The last one is produced by this extension on the first LLM call in a
 * freshly started window.
 *
 * We intentionally use pi.events.emit/on for cross-extension communication
 * instead of pi.on(...): the typed pi.on() only accepts the well-known
 * ExtensionEvent names, not arbitrary channel names.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  readStateSync,
  mutateState,
  type State,
} from "./state.js";
import {
  startTicker,
  stopTicker,
  checkAndReset,
  type EmitFn,
} from "./ticker.js";
import {
  renderStatusBar,
  startStatusUpdater,
  stopStatusUpdater,
  forceUpdate as forceUpdateStatus,
} from "./ui.js";
import { parseDuration, formatDuration } from "./parser.js";
import { sendNotify } from "./notifier.js";
import {
  appendHistory,
  trimHistory,
  type HistoryUsage,
} from "./history.js";
import {
  switchKey as armsSwitchKey,
  carryArmTo as armsCarryArmTo,
  arm as armsArm,
  disarm as armsDisarm,
  markFired as armsMarkFired,
  confirmSuccess as armsConfirmSuccess,
  isArmed as armsIsArmed,
  getArm as armsGetArm,
  resetReadyToFire,
  RESET_GRACE_MS,
  RETRY_AFTER_FIRE_MS,
  type Arm as ArmsArm,
} from "./arms.js";

const PROVIDER = "wormsoft";
const WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Build a fresh State for a brand-new window.
 */
function makeInitialState(): State {
  return {
    provider: PROVIDER,
    windowStartedAt: Date.now(),
    windowMs: WINDOW_MS,
    lastResetAt: 0,
    resetCount: 0,
    callsInWindow: 0,
  };
}

// --- Module-level orchestration state ----------------------------------------

/**
 * Whether startTicker() has already been called. Guards against double-start
 * when /reload fires multiple session_start events back-to-back.
 */
let tickerStarted = false;

/**
 * The most recent ctx handed to session_start. Used by the window_reset
 * listener so it can call ctx.ui.notify() without needing the ctx as a
 * closure argument (the listener is registered once via pi.events.on()).
 */
let currentCtx: ExtensionContext | null = null;

/**
 * The shared EventBus captured from `pi.events` in the factory. All
 * cross-extension communication goes through this bus. `null` until the
 * factory runs.
 *
 * NOTE: the bus lives on the ExtensionAPI (pi.events), NOT on ExtensionContext
 * (ctx) -- so we must not read it from ctx. The factory is re-invoked for
 * every session with a fresh `pi`, which keeps this pointing at the live bus.
 */
let eventBus: {
  emit: (channel: string, data: unknown) => void;
  on: (channel: string, handler: (data: unknown) => void) => () => void;
} | null = null;

/**
 * Unsubscriber returned by pi.events.on("billing:window_reset", ...) so we
 * can detach the listener on session_shutdown. Null when not subscribed.
 */
let unsubscribeWindowReset: (() => void) | null = null;

/**
 * Unsubscriber for the about-to-reset channel (currently informational only,
 * but kept symmetrical so a future handler can be added cleanly).
 */
let unsubscribeAboutToReset: (() => void) | null = null;

/**
 * Unsubscriber for the notify-on-window-reset side-effect (sends an HTTP
 * POST to pi-remote so connected browser clients get a toast + system
 * notification). Kept separate from unsubscribeWindowReset so the two
 * handlers can evolve independently.
 */
let unsubscribeWindowResetNotify: (() => void) | null = null;

/**
 * Stopper returned by startStatusUpdater(). Called on session_shutdown so
 * we don't leave a dangling setInterval pointing at a torn-down ctx.
 */
let stopStatusFn: (() => void) | null = null;

/**
 * The live ExtensionAPI (`pi`) captured in the factory. Used to send
 * "продолжи" via pi.sendUserMessage on a cont-after-reset trigger. The
 * factory re-runs per session with a fresh pi, so this stays current.
 */
let piApi: ExtensionAPI | null = null;

/**
 * Periodic poller that drives cont-after-reset detection while the current
 * conversation is armed. The armed FLAG survives /new (it is file-backed in
 * arms.ts and re-adopted in session_start); this timer does NOT -- it closes
 * over this session's captured pi/ctx, which pi invalidates on session
 * replacement (new/fork/switch/reload). session_shutdown therefore stops it,
 * and session_start restarts it against the fresh references when the arm
 * is still active. Using the captured pi after replacement throws
 * "extension ctx is stale" (docs: Session replacement lifecycle and footguns).
 */
let armedPollTimer: NodeJS.Timeout | null = null;

/**
 * One-shot timer that forces checkAndReset() at the true 2h boundary while a
 * conversation is armed, so the reset (and thus the "продолжи") does not have
 * to wait up to the 5-minute tick. Cleared together with the poller on
 * session_shutdown for the same staleness reason.
 */
let boundaryResetTimer: NodeJS.Timeout | null = null;

/** How often the armed poller wakes up. */
const ARMED_POLL_MS = 10_000;

// --- cont-after-reset helpers -------------------------------------------------

/** A stable per-process identity for the conversation we are showing. */
function sessionKeyOf(ctx: ExtensionContext | null): string {
  const f = ctx?.sessionManager?.getSessionFile?.();
  return typeof f === "string" && f.length > 0 ? f : `ephemeral:${process.pid}`;
}

// --- history.ts helpers -------------------------------------------------------

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * Project/session attribution for history rows. Project = full session cwd
 * (per-project grouping is a report-time concern, not a write-time one);
 * session = basename of the session file so two agents in the same cwd are
 * still distinguishable.
 */
function historyMetaOf(ctx: ExtensionContext | null): {
  project: string;
  session: string;
} {
  const cwd = ctx?.sessionManager?.getCwd?.();
  const key = sessionKeyOf(ctx);
  const session =
    key.startsWith("ephemeral:") ? key : key.split(/[\\/]/).pop() ?? key;
  return {
    project: typeof cwd === "string" ? cwd : "",
    session,
  };
}

/**
 * Usage of the LAST assistant response, read from the in-memory session
 * (pi-ai Usage: input/output/cacheRead/cacheWrite). The hook payload itself
 * carries only {status, headers}, so this is the cheapest way to get real
 * token burn. Returns null when unavailable (e.g. provider did not report
 * usage) -- history rows then leave the token columns empty.
 */
function lastAssistantUsage(ctx: ExtensionContext | null): HistoryUsage | null {
  try {
    const entries = ctx?.sessionManager?.getEntries?.() as
      | Array<{
          type?: string;
          message?: { role?: string; usage?: Record<string, unknown> };
        }>
      | undefined;
    if (!Array.isArray(entries)) return null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type !== "message" || !e.message) continue;
      if (e.message.role !== "assistant") continue;
      const u = e.message.usage;
      if (u && typeof u === "object") {
        return {
          input: num(u.input),
          output: num(u.output),
          cacheRead: num(u.cacheRead),
          cacheWrite: num(u.cacheWrite),
        };
      }
      return null;
    }
  } catch {
    // Session manager unavailable (early startup / rpc) -- no usage, no drama.
  }
  return null;
}

/** Force a footer refresh so the armed indicator appears/disappears promptly. */
function refreshMarker(): void {
  if (currentCtx?.mode === "tui") {
    try {
      forceUpdateStatus(currentCtx);
    } catch {}
  }
}

function clearBoundaryResetTimer(): void {
  if (boundaryResetTimer) {
    clearTimeout(boundaryResetTimer);
    boundaryResetTimer = null;
  }
}

function stopArmedPoller(): void {
  if (armedPollTimer) {
    clearInterval(armedPollTimer);
    armedPollTimer = null;
  }
  clearBoundaryResetTimer();
}

/**
 * Ensure the armed poller is running (used after arming / adoption).
 */
function ensureArmedPoller(): void {
  if (!armedPollTimer) {
    armedPollTimer = setInterval(() => {
      void evaluateArmedReset();
    }, ARMED_POLL_MS);
  }
  void evaluateArmedReset();
}

/**
 * While a conversation is armed: (1) fire "продолжи" once a reset since the
 * arming has passed, and the 60 s grace has elapsed; (2) otherwise schedule a
 * one-shot force-reset at the true window boundary so the trigger lands near
 * the real zero (not up to 5 min late). Stops itself when the arm is gone or
 * expired.
 */
async function evaluateArmedReset(): Promise<void> {
  const arm = armsGetArm();
  if (!arm) {
    // Expired or removed. Keep the poller alive: an external writer
    // (night-agent helper scripts/arm_cont_after_reset.py) can (re)arm this
    // conversation at any time, and the 10s no-op tick is what notices.
    clearBoundaryResetTimer();
    refreshMarker();
    return;
  }
  const st = readStateSync();
  const now = Date.now();

  // "продолжи" has already been sent for this arm (phase "pending"): wait
  // for the first successful provider response to clear the flag
  // (confirmSuccess, called from onAfterProviderResponse), retrying the
  // send no more often than every RETRY_AFTER_FIRE_MS after the last
  // attempt/429. In "pending" neither resetReadyToFire nor the boundary
  // logic below applies.
  if (arm.phase === "pending") {
    const retryAfter = Math.max(arm.lastFireAt ?? 0, st?.last429At ?? 0);
    if (now - retryAfter >= RETRY_AFTER_FIRE_MS) {
      await fireContinue(arm);
    }
    return;
  }

  if (!st) return;

  // A reset has happened since arming. Fire once the grace period has elapsed.
  if (resetReadyToFire(arm, st, now)) {
    await fireContinue(arm);
    return;
  }

  // No reset yet (or reset too recent to act on). If the window already reads
  // expired but lastResetAt has not advanced (another process owns the lazy
  // tick), force a boundary reset soon.
  if (st.lastResetAt <= arm.lastResetAtAtArm) {
    const msToBoundary = st.windowStartedAt + st.windowMs - now;
    if (msToBoundary <= 0) {
      void checkAndReset(buildEmitFn(), historyMetaOf(currentCtx)).then(() => {
        void evaluateArmedReset();
      });
    } else if (!boundaryResetTimer) {
      boundaryResetTimer = setTimeout(() => {
        boundaryResetTimer = null;
        void checkAndReset(buildEmitFn(), historyMetaOf(currentCtx)).then(() => {
          void evaluateArmedReset();
        });
      }, msToBoundary + 500);
    }
  }
}

/**
 * Send the one-word "продолжи" so the interrupted agent resumes. Guards:
 *  - only when the agent is idle (spec: "if the agent is streaming, do
 *    nothing" -- we keep the arm and retry on the next poll);
 *  - only after the grace period (handled by the caller).
 * After a successful send the flag switches to "pending" (markFired); the
 * first successful provider response confirms it (confirmSuccess).
 */
async function fireContinue(_arm: ArmsArm): Promise<void> {
  let idle = true;
  try {
    idle = currentCtx?.isIdle?.() ?? true;
  } catch {
    idle = true;
  }
  if (!idle) {
    // Streaming -- spec says do nothing. Keep the arm; next poll retries.
    return;
  }

  const p = piApi;
  if (!p) return;

  try {
    await p.sendUserMessage("продолжи");
    // Sent: switch the flag to "pending" instead of consuming it. The first
    // successful provider response (confirmSuccess) clears it; a 429 means
    // the provider has not recovered yet and the poller retries every
    // RETRY_AFTER_FIRE_MS.
    await armsMarkFired();
    console.log(
      "[pi-billing-window] cont-after-reset: 'продолжи' отправлен, " +
      "флаг в pending — сниму после первого успешного ответа, " +
      "при 429 повтор через 10 мин",
    );
  } catch (err) {
    // Failed to send (e.g. bus busy). Keep the arm and poller; retry next poll.
    console.warn(
      "[pi-billing-window] cont-after-reset: не удалось отправить:",
      err,
    );
  }
  refreshMarker();
}

// --- Emit plumbing ------------------------------------------------------------

/**
 * Build an EmitFn that forwards into pi.events (the EventBus shared across
 * extensions). We capture the bus reference once at session_start; subsequent
 * ticker ticks call this closure, so the bus reference is stable for the
 * lifetime of the running session.
 *
 * `null` is treated as "no bus yet" (e.g. very early startup before
 * session_start has fired) -- in that case emit becomes a no-op so the
 * ticker doesn't crash.
 */
function buildEmitFn(): EmitFn {
  return (event: string, payload: unknown) => {
    const bus = eventBus;
    if (!bus) return;
    try {
      bus.emit(event, payload);
    } catch {
      // Never let a listener failure kill the ticker. The bus already wraps
      // individual handlers, but our own .emit must not throw either.
    }
  };
}

// --- Ticker lifecycle ---------------------------------------------------------

/**
 * Idempotent ticker starter. Safe to call multiple times: only the first
 * call wires up the interval. Used in session_start where a reload may
 * fire repeatedly without the previous shutdown having torn the ticker down.
 */
function ensureTickerStarted(): void {
  if (tickerStarted) return;
  startTicker(buildEmitFn());
  tickerStarted = true;
}

/**
 * Stop the ticker AND reset the started flag so a future session_start can
 * start it again. Matches the contract required by tests: stopTicker() is
 * safe to call when no interval is running (it's a no-op in that case).
 */
function shutdownTicker(): void {
  stopTicker();
  tickerStarted = false;
}

// --- EventBus listeners -------------------------------------------------------

/**
 * Listener for our own "billing:window_reset" channel. We push a friendly
 * notification in TUI mode; in other modes (rpc, print) we silently skip --
 * notify() would just clutter logs there.
 */
function handleWindowReset(_payload: unknown): void {
  if (!currentCtx) return;
  if (currentCtx.mode !== "tui") return;
  try {
    currentCtx.ui.notify(
      "wormsoft: 2-часовой лимит сброшен, свежий слот доступен",
      "info",
    );
  } catch {
    // ignore -- ctx may be torn down
  }
}

/**
 * Listener for "billing:window_about_to_reset" -- currently a no-op
 * placeholder (other extensions may subscribe via the bus independently).
 * Kept here so we explicitly attach to the channel and confirm the bus is
 * wired correctly end-to-end.
 */
function handleAboutToReset(payload: unknown): void {
  // Reserved for future UI hint ("window resets in ~5 min").
  // We deliberately do nothing here so we don't spam the user.
  void payload;
}

/**
 * Side-effect listener for "billing:window_reset": pushes the event out
 * to pi-remote over HTTP so connected browser clients can show a toast
 * and (when the tab is in the background) a system notification.
 *
 * Fire-and-forget: sendNotify() never throws, so we don't need to await
 * it. The `void` keeps the lint clean and signals intent.
 */
const handleWindowResetForNotify = (payload: unknown): void => {
  const p = payload as { provider?: string; resetCount?: number };
  void sendNotify({
    type: "billing:window_reset",
    provider: p?.provider ?? "wormsoft",
    title: "Wormsoft: лимит обновлён",
    body: `2-часовое окно сброшено (reset #${p?.resetCount ?? "?"}). Свежие 5M токенов доступны.`,
    timestamp: Date.now(),
  });
};

/**
 * Attach our window_reset / about_to_reset listeners to the EventBus.
 * Stores the unsubscribe handles on module-level variables so they can be
 * detached in session_shutdown.
 */
function subscribeToBillingEvents(): void {
  const bus = eventBus;
  if (!bus) return;

  // Always detach any previous subscription first (defensive against reload
  // sequences where shutdown did not run cleanly).
  if (unsubscribeWindowReset) {
    try {
      unsubscribeWindowReset();
    } catch {}
    unsubscribeWindowReset = null;
  }
  if (unsubscribeAboutToReset) {
    try {
      unsubscribeAboutToReset();
    } catch {}
    unsubscribeAboutToReset = null;
  }
  if (unsubscribeWindowResetNotify) {
    try {
      unsubscribeWindowResetNotify();
    } catch {}
    unsubscribeWindowResetNotify = null;
  }

  try {
    unsubscribeWindowReset = bus.on("billing:window_reset", handleWindowReset);
    unsubscribeWindowResetNotify = bus.on(
      "billing:window_reset",
      handleWindowResetForNotify,
    );
    unsubscribeAboutToReset = bus.on(
      "billing:window_about_to_reset",
      handleAboutToReset,
    );
  } catch {
    // Bus unavailable for some reason -- degrade gracefully.
  }
}

function unsubscribeFromBillingEvents(): void {
  if (unsubscribeWindowReset) {
    try {
      unsubscribeWindowReset();
    } catch {}
    unsubscribeWindowReset = null;
  }
  if (unsubscribeAboutToReset) {
    try {
      unsubscribeAboutToReset();
    } catch {}
    unsubscribeAboutToReset = null;
  }
  if (unsubscribeWindowResetNotify) {
    try {
      unsubscribeWindowResetNotify();
    } catch {}
    unsubscribeWindowResetNotify = null;
  }
}

// --- Session lifecycle hooks --------------------------------------------------

/**
 * pi.on("session_start"): capture ctx, initialize state if missing, run a
 * one-shot checkAndReset() if the saved state is already expired, and
 * start the periodic ticker. Idempotent across reloads thanks to the
 * tickerStarted guard and the state file itself.
 */
async function onSessionStart(
  event: unknown,
  ctx: ExtensionContext,
): Promise<void> {
  currentCtx = ctx;

  // Subscribe to our own EventBus channels so we can notify the user when
  // a reset happens (also useful for future "about to reset" hooks).
  subscribeToBillingEvents();

  // Start the periodic ticker and the status-bar updater FIRST, before any
  // state I/O. If the state bootstrap below throws (e.g. a lock timeout while
  // another pi window holds the lock), pi swallows handler errors -- without
  // this ordering the countdown and reset ticker would never start in this
  // session until /reload. With timers up first, a bootstrap failure degrades
  // to just a warning and everything keeps running.
  ensureTickerStarted();

  // Start the status-bar updater (live countdown) in TUI mode only.
  // startStatusUpdater itself returns a no-op stopper outside of TUI.
  if (stopStatusFn) {
    try {
      stopStatusFn();
    } catch {}
    stopStatusFn = null;
  }
  stopStatusFn = startStatusUpdater(ctx);

  // Push the current status immediately so the footer reflects the
  // persisted window state right after startup.
  forceUpdateStatus(ctx);

  // Initialize state / reset an expired window. Non-fatal: if this throws,
  // the timers above are already running, so the countdown and reset
  // detection keep working even in this degraded case.
  try {
    const existing = readStateSync();
    if (existing === null) {
      await mutateState(() => ({ next: makeInitialState() }));
    } else if (Date.now() - existing.windowStartedAt >= existing.windowMs) {
      // Window already expired while pi was off. Let the ticker machinery
      // reset it -- this also fires billing:window_reset which our listener
      // will pick up and turn into a notify().
      await checkAndReset(buildEmitFn(), historyMetaOf(ctx));
    }
    // Refresh the status bar after a possible reset so the fresh countdown
    // is visible right away.
    forceUpdateStatus(ctx);
    // Trim history rows older than RETENTION_DAYS (cheap: file is tiny).
    void trimHistory();
  } catch (err) {
    console.warn(
      "pi-billing-window: state init on session_start failed:",
      err,
    );
  }

  // cont-after-reset: (re)bind this window to its conversation's armed flag.
  // On /new the armed record is carried to the fresh conversation (spec: keep
  // the flag after /new). On /resume, /fork, /reload or startup we merely
  // re-point at the current conversation; an arm stays with the conversation
  // that created it and is re-adopted only if we come back to it. A process
  // restart re-adopts the record persisted under its conversation file.
  try {
    const key = sessionKeyOf(ctx);
    const reason = (event as { reason?: string } | null)?.reason;
    if (reason === "new") {
      await armsCarryArmTo(key);
    } else {
      armsSwitchKey(key);
    }
    // Always run the armed poller: the arm can be (re)created at any time by
    // an external writer (night-agent helper scripts/arm_cont_after_reset.py),
    // and a live poller is what notices and fires "продолжи".
    ensureArmedPoller();
    refreshMarker();
  } catch (err) {
    console.warn("pi-billing-window: arms session init failed:", err);
  }
}

/**
 * pi.on("after_provider_response"): every successful call to the tracked
 * provider bumps callsInWindow under a lock. The first call after a
 * window-start sets firstCallEmittedAt and fires "llm:first_call" on the
 * EventBus. After mutation we run checkAndReset() so a window that
 * expired during this very call gets cleaned up immediately. The first
 * successful response also confirms a "pending" cont-after-reset arm
 * (armsConfirmSuccess, one-shot after a CONFIRMED success).
 *
 * A 429 response is NOT an error here: it means the provider's limit is
 * exhausted. We record state.last429At and append a kind="429" history row;
 * a 429 does not increment callsInWindow.
 *
 * NOTE on filtering: the AfterProviderResponseEvent payload only carries
 * { status, headers } -- it does NOT carry the provider name. We get the
 * provider name from ctx.model.provider (Model<Api> has a `provider: string`
 * field). In practice ctx.model is the model being talked to RIGHT NOW, so
 * it matches the call that just finished.
 */
async function onAfterProviderResponse(
  event: { status: number; headers: Record<string, string> },
  ctx: ExtensionContext,
): Promise<void> {
  if (typeof event.status !== "number") return;

  // Filter by provider. ctx.model may be undefined during startup / RPC.
  const providerName: string | undefined = ctx.model?.provider;
  if (providerName !== PROVIDER) return;

  // Keep currentCtx fresh so window_reset notifications find a live ctx.
  currentCtx = ctx;

  // Limit exhausted: remember when it happened (drives the pending
  // cont-after-reset retry pacing) and log a history row. A 429 does NOT
  // count towards callsInWindow.
  if (event.status === 429) {
    await mutateState((cur) => {
      const next: State = cur === null ? makeInitialState() : { ...cur };
      next.last429At = Date.now();
      return { next };
    });
    const meta429 = historyMetaOf(ctx);
    const fresh429 = readStateSync();
    void appendHistory({
      kind: "429",
      project: meta429.project,
      session: meta429.session,
      callsInWindow: fresh429?.callsInWindow,
      resetCount: fresh429?.resetCount,
      note: "limit exhausted",
    });
    return;
  }

  // Only successful responses count towards the limit.
  if (event.status >= 400) return;

  const emit = buildEmitFn();
  const timestamp = Date.now();

  // Read state once outside the lock to grab windowStartedAt for the
  // first_call payload (avoids re-reading after the lock).
  const before = readStateSync();

  let firstCallJustEmitted = false;
  await mutateState<true>((cur) => {
    if (cur === null) {
      // State vanished between read and lock -- very unlikely, but be safe.
      return { next: makeInitialState(), result: true };
    }

    const next: State = {
      ...cur,
      callsInWindow: cur.callsInWindow + 1,
    };

    if (cur.firstCallEmittedAt === undefined) {
      next.firstCallEmittedAt = timestamp;
      firstCallJustEmitted = true;
    }

    return { next, result: true };
  });

  // The first successful wormsoft response after a "продолжи" confirms the
  // pending cont-after-reset arm. A one-shot arm is removed; a repeat>1 arm is
  // re-armed for the NEXT reset. Passing the current state.lastResetAt lets
  // the re-armed record wait for a reset that happens after confirmation.
  const armState = readStateSync();
  void armsConfirmSuccess(Date.now(), { lastResetAt: armState?.lastResetAt });

  if (firstCallJustEmitted) {
    emit("llm:first_call", {
      provider: PROVIDER,
      timestamp,
      windowStartedAt: before?.windowStartedAt ?? timestamp,
    });
  }

  // History: one row per successful call with real token usage when the
  // provider reports it. Fire-and-forget; never throws.
  const meta = historyMetaOf(ctx);
  const modelId = ctx.model?.id ?? ""; // canonical model name for the call row
  const fresh = readStateSync();
  void appendHistory({
    kind: "call",
    project: meta.project,
    session: meta.session,
    model: modelId,
    callsInWindow: fresh?.callsInWindow,
    resetCount: fresh?.resetCount,
    usage: lastAssistantUsage(ctx),
  });

  // Refresh the status bar so the callsInWindow counter and any freshly
  // started countdown reflect the new state without waiting for the
  // 30-second ui.ts interval.
  if (ctx.mode === "tui") {
    forceUpdateStatus(ctx);
  }

  // A long-running call could have crossed the window boundary. checkAndReset
  // is idempotent and dedups via lastResetAt, so calling it here is safe and
  // handles the edge case without waiting up to TICK_MS for the next tick.
  await checkAndReset(emit, meta);
}

/**
 * pi.on("model_select"): the footer countdown is only visible while the active
 * model belongs to the wormsoft provider (ui.ts visibility rule). A model
 * switch (Ctrl+P, /model, or session restore) changes the provider WITHOUT
 * any LLM call, so the status bar must be refreshed here -- otherwise the
 * countdown would stay hidden (or stale) for up to the status interval after
 * the switch. We pass the new model's provider explicitly so the check is not
 * dependent on ctx.model already being updated at handler time.
 */
function onModelSelect(
  event: { model?: { provider?: string } },
  ctx: ExtensionContext,
): void {
  // Keep the live ctx fresh so emit/notify find a valid bus context.
  currentCtx = ctx;
  forceUpdateStatus(ctx, undefined, event?.model?.provider);
}

/**
 * pi.on("session_shutdown"): tear down ticker, EventBus subscriptions, and
 * status updater. Re-runs cleanly on quit / reload / new / resume / fork.
 */
function onSessionShutdown(_event: unknown, _ctx: ExtensionContext): void {
  shutdownTicker();
  unsubscribeFromBillingEvents();
  if (stopStatusFn) {
    try {
      stopStatusFn();
    } catch {}
    stopStatusFn = null;
  }
  // cont-after-reset: stop timers that close over this session's captured
  // pi/ctx. The armed flag itself lives in arms.ts (file-backed) and is
  // re-adopted by session_start, which restarts the poller with fresh refs.
  // Keeping these timers alive past replacement left them calling
  // piApi.sendUserMessage() on a stale pi -> "extension ctx is stale" spam.
  stopArmedPoller();
  // We deliberately do NOT clear currentCtx -- a fresh session_start will
  // overwrite it, and clearing it here would lose any pending notifications.
}

// --- Commands -----------------------------------------------------------------

/**
 * /billing-status -- snapshot of the current window state via ui.notify.
 */
function registerBillingStatus(pi: ExtensionAPI): void {
  pi.registerCommand("billing-status", {
    description: "Показать состояние окна лимита",
    handler: async (_args, ctx) => {
      const s = readStateSync();
      if (s === null) {
        ctx.ui.notify("pi-billing-window: state не инициализирован", "info");
        return;
      }
      const remain = Math.max(0, s.windowMs - (Date.now() - s.windowStartedAt));
      const mm = Math.ceil(remain / 60_000);
      const hh = Math.floor(mm / 60);
      const m = mm % 60;
      const hhStr = String(hh).padStart(2, "0");
      const mmStr = String(m).padStart(2, "0");
      ctx.ui.notify(
        `${s.provider}: до reset ${hhStr}:${mmStr} ч:мин (calls=${s.callsInWindow}, resets=${s.resetCount})`,
        "info",
      );
    },
  });
}

/**
 * /billing-tick -- force a checkAndReset() right now (useful for testing
 * without waiting 5 minutes). Surfaces the emit payload via notify().
 */
function registerBillingTick(pi: ExtensionAPI): void {
  pi.registerCommand("billing-tick", {
    description: "Принудительный тик окна (для отладки)",
    handler: async (_args, ctx) => {
      // Reflect ctx in module state so buildEmitFn() finds a live bus.
      currentCtx = ctx;

      const emit: EmitFn = (event, payload) => {
        try {
          const json = JSON.stringify(payload).slice(0, 200);
          ctx.ui.notify(`[${event}] ${json}`, "info");
        } catch {
          // ignore -- payload may not be JSON-serializable
        }
      };
      const result = await checkAndReset(emit, historyMetaOf(ctx));
      ctx.ui.notify(
        result ? "Тик: reset произошёл" : "Тик: reset не произошёл",
        "info",
      );
    },
  });
}

/**
 * /billing-reset -- manually reset the window without waiting for it to
 * expire. Increments resetCount, zeroes callsInWindow, clears
 * firstCallEmittedAt, and starts a fresh windowStartedAt = now.
 */
function registerBillingReset(pi: ExtensionAPI): void {
  pi.registerCommand("billing-reset", {
    description: "Принудительный сброс окна",
    handler: async (_args, ctx) => {
      await mutateState((cur) => {
        if (cur === null) {
          return { next: makeInitialState() };
        }
        const now = Date.now();
        const next: State = {
          ...cur,
          windowStartedAt: now,
          lastResetAt: now,
          resetCount: cur.resetCount + 1,
          callsInWindow: 0,
          firstCallEmittedAt: undefined,
        };
        return { next };
      });
      ctx.ui.notify("Окно сброшено вручную", "info");

      // Refresh the status bar so the user sees the new countdown
      // immediately.
      if (ctx.mode === "tui") {
        forceUpdateStatus(ctx);
      }

      // Broadcast our manual reset through the bus so other extensions
      // can react just like to a normal reset.
      const bus = eventBus;
      const fresh = readStateSync();
      if (bus && fresh) {
        try {
          bus.emit("billing:window_reset", fresh);
        } catch {}
      }
      // History: manual reset row.
      const meta = historyMetaOf(ctx);
      void appendHistory({
        kind: "manual_reset",
        project: meta.project,
        session: meta.session,
        callsInWindow: fresh?.callsInWindow,
        resetCount: fresh?.resetCount,
      });
    },
  });
}

/**
 * /settimer -- set the remaining time until the next window reset. Lets the
 * user sync the plugin to the real billing clock they see in their wormsoft
 * dashboard. Accepts a duration string (e.g. "60", "1h30m", "0" for an
 * immediate reset). Clamps to the configured window length (2h) so the
 * countdown never goes negative.
 */
function registerSettimer(pi: ExtensionAPI): void {
  pi.registerCommand("settimer", {
    description:
      "Установить таймер окна (в минутах до reset). Примеры: /settimer 60, /settimer 1h30m, /settimer 0",
    handler: async (args, ctx) => {
      const arg = (args || "").trim();
      if (!arg) {
        ctx.ui.notify(
          "Использование: /settimer <длительность>\n" +
            "Примеры: /settimer 60, /settimer 1h30m, /settimer 0 (сброс)",
          "info",
        );
        return;
      }

      const parsed = parseDuration(arg);
      if (parsed.error) {
        ctx.ui.notify(
          `Неверный формат: '${arg}'. Примеры: 60, 1h30m, 0`,
          "error",
        );
        return;
      }

      // Clamp: durationMs cannot exceed the configured window length.
      let durationMs = Math.max(0, parsed.totalMs);
      const windowMs = WINDOW_MS;
      if (durationMs > windowMs) durationMs = windowMs;
      const now = Date.now();

      if (durationMs === 0) {
        // Immediate reset: open a fresh window right now and broadcast the
        // reset event (mirrors /billing-reset). Going through checkAndReset()
        // here would be blocked by its own dedup (lastResetAt is recent), so
        // we reset directly instead.
        await mutateState((cur) => {
          if (cur === null) {
            return {
              next: {
                provider: PROVIDER,
                windowStartedAt: now,
                windowMs,
                lastResetAt: now,
                resetCount: 1,
                callsInWindow: 0,
                firstCallEmittedAt: undefined,
              },
            };
          }
          return {
            next: {
              ...cur,
              windowStartedAt: now,
              lastResetAt: now,
              resetCount: cur.resetCount + 1,
              callsInWindow: 0,
              firstCallEmittedAt: undefined,
            },
          };
        });
        const fresh = readStateSync();
        if (eventBus && fresh) {
          try {
            eventBus.emit("billing:window_reset", fresh);
          } catch {}
        }
        // History: /settimer 0 performs a real reset.
        const meta = historyMetaOf(ctx);
        void appendHistory({
          kind: "window_reset",
          project: meta.project,
          session: meta.session,
          callsInWindow: fresh?.callsInWindow,
          resetCount: fresh?.resetCount,
          note: "settimer 0",
        });
      } else {
        // Sync the countdown to the given remaining time: pick a
        // windowStartedAt that leaves durationMs of life in the window.
        // We deliberately do NOT touch lastResetAt here, so a future
        // auto-reset is not suppressed by checkAndReset()'s dedup logic.
        const targetStartedAt = now - (windowMs - durationMs);
        await mutateState((cur) => {
          if (cur === null) {
            return {
              next: {
                provider: PROVIDER,
                windowStartedAt: targetStartedAt,
                windowMs,
                lastResetAt: 0,
                resetCount: 1,
                callsInWindow: 0,
                firstCallEmittedAt: undefined,
              },
            };
          }
          return {
            next: {
              ...cur,
              windowStartedAt: targetStartedAt,
              resetCount: cur.resetCount + 1,
              callsInWindow: 0,
              firstCallEmittedAt: undefined,
            },
          };
        });
        // History: timer sync row (no reset happened; lastResetAt untouched).
        const meta = historyMetaOf(ctx);
        const fresh2 = readStateSync();
        void appendHistory({
          kind: "settimer",
          project: meta.project,
          session: meta.session,
          callsInWindow: fresh2?.callsInWindow,
          resetCount: fresh2?.resetCount,
          note: `sync ${formatDuration(durationMs)}`,
        });
      }

      ctx.ui.notify(
        durationMs === 0
          ? "Таймер: окно сброшено (свежие 2 часа)"
          : `Таймер установлен: ${formatDuration(durationMs)} до reset`,
        "info",
      );

      if (ctx.mode === "tui") {
        forceUpdateStatus(ctx);
      }
    },
  });
}

/**
 * /cont-after-reset -- arm (default) or disarm ("off") the automatic
 * "continue after reset" for THIS conversation. When armed, the footer timer
 * shows " [cont-after-reset]"; on the next window reset (after ~1 min) the
 * agent gets a "продолжи" and resumes the interrupted task. One-shot by
 * default; "/cont-after-reset N" (N in 1..99) arms N total repetitions, each
 * confirmed fire re-arming for the next reset. Expires ~8h (ARMS_TTL_MS) after
 * arming if no reset comes.
 */
function registerContAfterReset(pi: ExtensionAPI): void {
  pi.registerCommand("cont-after-reset", {
    description:
      "Взвести/снять автопродолжение после сброса окна лимита. Без аргумента — взвести один раз, N (1..99) — взвести на N срабатываний, 'off' — снять.",
    handler: async (args, ctx) => {
      currentCtx = ctx;
      try {
        const key = sessionKeyOf(ctx);
        armsSwitchKey(key);

        const arg = String(args ?? "").trim().toLowerCase();
        const wantOff =
          arg === "off" || arg === "0" || arg === "нет" || arg === "выкл";

        // Optional repeat count: "/cont-after-reset 5" arms 5 total fires.
        // Empty / non-numeric / out-of-range keeps the classic one-shot
        // (repeat 1) so existing callers and arbitrary args are unaffected.
        let repeat = 1;
        let explicitRepeat = false;
        if (arg !== "" && !wantOff) {
          const n = Number(arg);
          if (Number.isInteger(n) && n >= 1 && n <= 99) {
            repeat = n;
            explicitRepeat = true;
          }
        }

        if (wantOff) {
          const removed = await armsDisarm();
          stopArmedPoller();
          ctx.ui.notify(
            removed
              ? "cont-after-reset: флаг снят"
              : "cont-after-reset: флаг не был взведён",
            "info",
          );
          refreshMarker();
          return;
        }

        // An explicit numeric argument always re-arms so the requested repeat
        // count is applied; a bare "/cont-after-reset" stays idempotent (an
        // existing arm is left untouched).
        if (explicitRepeat) await armsDisarm();

        const st = readStateSync();
        const existing = explicitRepeat ? null : armsGetArm();
        const cur =
          existing ??
          (await armsArm(st?.lastResetAt ?? 0, Date.now(), repeat));
        if (!cur) {
          ctx.ui.notify(
            "cont-after-reset: не удалось взвести флаг",
            "error",
          );
          return;
        }
        ensureArmedPoller();
        const now = Date.now();
        const expMins = Math.max(0, Math.ceil((cur.expiresAt - now) / 60_000));

        // Estimate the actual fire moment: window boundary + ~1 min grace.
        const st2 = readStateSync();
        let fireMins: number | null = null;
        if (st2) {
          const remaining = Math.max(
            0,
            st2.windowStartedAt + st2.windowMs - now,
          );
          fireMins = Math.max(1, Math.ceil((remaining + RESET_GRACE_MS) / 60_000));
        }

        const fireText =
          fireMins === null
            ? "сработает при сбросе окна"
            : `сработает при сбросе окна (через ~${fireMins} мин)`;
        const rep = cur.repeat ?? 1;
        const repeatText =
          rep > 1
            ? ` Режим повтора: ${rep} срабатываний всего (repeat=${rep}).`
            : " Одноразовый флаг.";
        ctx.ui.notify(
          `cont-after-reset: взведён, ${fireText}.${repeatText} Срок годности флага: до ${new Date(cur.expiresAt).toLocaleTimeString()} (${expMins} мин) — если сброса не будет, флаг сгорит.`,
          "info",
        );
        refreshMarker();
      } catch (err) {
        console.warn("pi-billing-window: /cont-after-reset failed:", err);
      }
    },
  });
}

// --- Extension entrypoint -----------------------------------------------------

export default function (pi: ExtensionAPI): void {
  // Capture the shared EventBus once per session. The factory is re-invoked
  // for each session with a fresh `pi`, so eventBus always points at the
  // live bus for the running session.
  eventBus = pi.events;
  // Keep a live ExtensionAPI reference for pi.sendUserMessage (cont-after-reset).
  piApi = pi;

  pi.on("session_start", onSessionStart);
  pi.on("model_select", onModelSelect);
  pi.on("after_provider_response", onAfterProviderResponse);
  pi.on("session_shutdown", onSessionShutdown);

  registerBillingStatus(pi);
  registerBillingTick(pi);
  registerBillingReset(pi);
  registerSettimer(pi);
  registerContAfterReset(pi);

  // Touch renderStatusBar so the import is retained for downstream tools
  // and linters that flag unused imports. The function is also exposed for
  // future command handlers (e.g. /billing-status could switch to the
  // footer string for parity with the widget).
  void renderStatusBar;
  void stopStatusUpdater;
}
