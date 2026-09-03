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
    const bus = (currentCtx as any)?.events as
      | { emit: (channel: string, data: unknown) => void }
      | undefined;
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
  if (!currentCtx) return;
  const bus = (currentCtx as any).events as
    | { on: (channel: string, handler: (data: unknown) => void) => () => void }
    | undefined;
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
  _event: unknown,
  ctx: ExtensionContext,
): Promise<void> {
  currentCtx = ctx;

  // Subscribe to our own EventBus channels so we can notify the user when
  // a reset happens (also useful for future "about to reset" hooks).
  subscribeToBillingEvents();

  // Initialize state if it doesn't exist. We do this BEFORE the expired
  // check so the file is always present after session_start.
  const existing = readStateSync();
  if (existing === null) {
    await mutateState(() => ({ next: makeInitialState() }));
  } else if (Date.now() - existing.windowStartedAt >= existing.windowMs) {
    // Window already expired while pi was off. Let the ticker machinery
    // reset it -- this also fires billing:window_reset which our listener
    // will pick up and turn into a notify().
    await checkAndReset(buildEmitFn());
  }

  // Start the periodic ticker. ensureTickerStarted() is a no-op on
  // subsequent reloads.
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
  // persisted window state right after startup -- otherwise we'd have
  // to wait up to DEFAULT_INTERVAL_MS (5 min) for the first tick, or
  // until the first LLM call.
  forceUpdateStatus(ctx);
}

/**
 * pi.on("after_provider_response"): every successful call to the tracked
 * provider bumps callsInWindow under a lock. The first call after a
 * window-start sets firstCallEmittedAt and fires "llm:first_call" on the
 * EventBus. After mutation we run checkAndReset() so a window that
 * expired during this very call gets cleaned up immediately.
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
  // Only successful responses count towards the limit.
  if (typeof event.status !== "number" || event.status >= 400) return;

  // Filter by provider. ctx.model may be undefined during startup / RPC.
  const providerName: string | undefined = ctx.model?.provider;
  if (providerName !== PROVIDER) return;

  // Keep currentCtx fresh so window_reset notifications find a live ctx.
  currentCtx = ctx;

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

  if (firstCallJustEmitted) {
    emit("llm:first_call", {
      provider: PROVIDER,
      timestamp,
      windowStartedAt: before?.windowStartedAt ?? timestamp,
    });
  }

  // Refresh the status bar so the callsInWindow counter and any freshly
  // started countdown reflect the new state without waiting for the
  // 30-second ui.ts interval.
  if (ctx.mode === "tui") {
    forceUpdateStatus(ctx);
  }

  // A long-running call could have crossed the window boundary. checkAndReset
  // is idempotent and dedups via lastResetAt, so calling it here is safe and
  // handles the edge case without waiting up to TICK_MS for the next tick.
  await checkAndReset(emit);
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
      const result = await checkAndReset(emit);
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
      // (e.g. wormsoft-rate-limit) can react just like to a normal reset.
      const bus = (ctx as any).events as
        | { emit: (channel: string, data: unknown) => void }
        | undefined;
      const fresh = readStateSync();
      if (bus && fresh) {
        try {
          bus.emit("billing:window_reset", fresh);
        } catch {}
      }
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

      // Pick a windowStartedAt that puts "durationMs" of life left in the
      // current window: started = now - (windowMs - durationMs).
      const targetStartedAt = Date.now() - (windowMs - durationMs);
      const now = Date.now();

      await mutateState((cur) => {
        if (cur === null) {
          return {
            next: {
              provider: PROVIDER,
              windowStartedAt: targetStartedAt,
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
            windowStartedAt: targetStartedAt,
            lastResetAt: now,
            resetCount: cur.resetCount + 1,
            callsInWindow: 0,
            firstCallEmittedAt: undefined,
          },
        };
      });

      // checkAndReset will fire the window_reset event if duration=0 or the
      // adjusted window has already expired.
      await checkAndReset(buildEmitFn());

      ctx.ui.notify(
        `Таймер установлен: ${formatDuration(durationMs)} до reset`,
        "info",
      );

      if (ctx.mode === "tui") {
        forceUpdateStatus(ctx);
      }
    },
  });
}

// --- Extension entrypoint -----------------------------------------------------

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", onSessionStart);
  pi.on("after_provider_response", onAfterProviderResponse);
  pi.on("session_shutdown", onSessionShutdown);

  registerBillingStatus(pi);
  registerBillingTick(pi);
  registerBillingReset(pi);
  registerSettimer(pi);

  // Touch renderStatusBar so the import is retained for downstream tools
  // and linters that flag unused imports. The function is also exposed for
  // future command handlers (e.g. /billing-status could switch to the
  // footer string for parity with the widget).
  void renderStatusBar;
  void stopStatusUpdater;
}
