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
  getKey as armsGetKey,
  remapKey,
  RESET_GRACE_MS,
  RETRY_AFTER_FIRE_MS,
} from "./arms.js";
import { armsLog, setArmsLogPath } from "./armslog.js";
import {
  armWatchdog,
  clearWatchdog,
  computeFireAt,
} from "./watchdog.js";

export { setArmsLogPath };

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
 * Monotonic session epoch. Bumped as the FIRST action of session_shutdown
 * so deferred code from the old session (poller ticks, .then continuations)
 * can detect that its captured refs went stale and stop touching them.
 */
let sessionEpoch = 0;

/**
 * Invariant: `piApi` belongs to epoch `piApiEpoch`. If `piApiEpoch !==
 * sessionEpoch`, the session `piApi` was captured for has been replaced
 * (new/fork/switch/reload) and `piApi` must not be used.
 */
let piApiEpoch = 0;

/**
 * cont-after-reset timers. The armed FLAG survives /new (it is file-backed in
 * arms.ts and re-adopted in session_start); these timers do NOT -- they close
 * over this session's captured pi/ctx, which pi invalidates on session
 * replacement (new/fork/switch/reload). session_shutdown therefore stops them,
 * and session_start restarts them against the fresh references. Using the
 * captured pi after replacement throws "extension ctx is stale" (docs:
 * Session replacement lifecycle and footguns).
 *
 *  - retryTimer: slow interval (RETRY_AFTER_FIRE_MS) re-sending "продолжи"
 *    while an arm is in phase "pending";
 *  - graceTimer: one-shot send of "продолжи" RESET_GRACE_MS after the reset;
 *  - syncTimer: slow poller (SYNC_POLL_MS) whose only job is to notice
 *    external writes into arms.json and resync the watchdog.
 */
let retryTimer: NodeJS.Timeout | null = null;
let graceTimer: NodeJS.Timeout | null = null;
let syncTimer: NodeJS.Timeout | null = null;

/** How often the sync-poller resyncs the watchdog (external arms writes). */
const SYNC_POLL_MS = 60_000;

/** Grace override for tests (production value is RESET_GRACE_MS). */
let resetGraceMs = RESET_GRACE_MS;

export function setResetGraceMsForTests(ms: number): void {
  resetGraceMs = Math.max(0, ms);
}

/**
 * Spec 002 (D-204): bounded stale-retry. After a failed delivery attempt
 * (stale pi or an epoch mismatch) the next attempt is paced with an
 * exponentially growing backoff; after STALE_MAX_ATTEMPTS failed attempts
 * the arm is disarmed and a capitulation notification is sent ("never
 * fail silently"). Module-level state on purpose: arms.json/state.json
 * formats must not change (D-004).
 */
const STALE_MAX_ATTEMPTS = 6;
const STALE_BACKOFF_CAP_MS = 60 * 60 * 1000; // 60 min
let staleAttempts = 0;

/** Spec 002 (D-203): the reset window this arm has already fired for. */
let lastFiredResetAt: number | null = null;

/** Exponential backoff: RETRY_AFTER_FIRE_MS * 2^(attempt-1), capped. */
function staleBackoffMs(attempt: number): number {
  return Math.min(
    RETRY_AFTER_FIRE_MS * Math.pow(2, attempt - 1),
    STALE_BACKOFF_CAP_MS,
  );
}

/**
 * Test hook: reset the stale-retry counter / pacing / fire dedup marker so
 * scenarios in one process do not leak attempts into each other.
 */
export function __resetStaleStateForTests(): void {
  staleAttempts = 0;
  staleRetryNotBefore = 0;
  lastFiredResetAt = null;
}

/** Test hook: read the current stale-retry pacing moment. */
export function __staleRetryNotBeforeForTests(): number {
  return staleRetryNotBefore;
}

/**
 * After a stale failure, the next send attempt is paced with an
 * exponential backoff (see staleBackoffMs). Exported override kept for
 * tests: its remaining role is to reset the pacing marker so a test can
 * force the next attempt deterministically.
 */
let staleRetryMs = RETRY_AFTER_FIRE_MS;

export function setStaleRetryMsForTests(_ms: number): void {
  staleRetryMs = Math.max(0, _ms);
  staleRetryNotBefore = 0; // reset pacing so a previous test's backoff
  // does not leak into the next one
}

/**
 * Earliest moment a send may be attempted again after a stale failure
 * (module-level, not persisted: a process restart naturally re-arms).
 */
let staleRetryNotBefore = 0;

// --- Test hooks (deterministic; no real minutes are ever waited) --------------

/**
 * Test hook: run one full watchdog resync immediately (what the sync-poller
 * tick and every mutation point do).
 */
export function __syncWatchdogForTests(): void {
  syncWatchdog();
}

/** Test hook: force one watchdog fire (reset + grace + send scheduling). */
export function __fireWatchdogForTests(): Promise<void> {
  return onWatchdogFire();
}

/** Test hook: run one pending-retry tick manually (interval is 5 min). */
export function __retryTickForTests(): Promise<void> {
  return retryTick();
}

/**
 * Track arm visibility changes so syncWatchdog logs "arm-seen" /
 * "arm-gone" only on the transition, not on every sync tick.
 */
let lastArmSeenKey: string | null = null;

// --- cont-after-reset helpers -------------------------------------------------

/** A stable per-process identity for the conversation we are showing. */
function sessionKeyOf(ctx: ExtensionContext | null): string {
  try {
    const f = ctx?.sessionManager?.getSessionFile?.();
    return typeof f === "string" && f.length > 0 ? f : `ephemeral:${process.pid}`;
  } catch {
    return `ephemeral:${process.pid}`;
  }
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
  // ctx may be stale (session replaced while a timer was in flight) -- any
  // property access on it throws; fall back to a neutral meta instead of
  // crashing the process.
  try {
    const cwd = ctx?.sessionManager?.getCwd?.();
    const key = sessionKeyOf(ctx);
    const session =
      key.startsWith("ephemeral:") ? key : key.split(/[\\/]/).pop() ?? key;
    return {
      project: typeof cwd === "string" ? cwd : "",
      session,
    };
  } catch {
    return { project: "", session: `ephemeral:${process.pid}` };
  }
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

/**
 * Safe `ctx.mode === "tui"` check: the `mode` getter throws on a stale
 * ctx (session replaced / reloaded while a timer was in flight), so the
 * plain comparison can kill the whole process via uncaughtException.
 */
function ctxIsTui(ctx: ExtensionContext | null): boolean {
  if (!ctx) return false;
  try {
    return ctx.mode === "tui";
  } catch {
    // Stale ctx after session replacement or reload -- treat as non-TUI.
    return false;
  }
}

/** Force a footer refresh so the armed indicator appears/disappears promptly. */
function refreshMarker(): void {
  const ctx = currentCtx;
  if (!ctxIsTui(ctx)) return;
  try {
    forceUpdateStatus(ctx);
  } catch {}
}

function stopRetryInterval(): void {
  if (retryTimer !== null) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

function stopGraceTimer(): void {
  if (graceTimer !== null) {
    clearTimeout(graceTimer);
    graceTimer = null;
  }
}

function stopSyncPoller(): void {
  if (syncTimer !== null) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

/**
 * Stop every timer that closes over this session's captured pi/ctx. The
 * armed flag itself is file-backed (arms.ts) and is re-adopted by
 * session_start, which restarts the sync-poller with fresh references.
 */
function stopWatchdogTimers(): void {
  stopSyncPoller();
  stopRetryInterval();
  stopGraceTimer();
  clearWatchdog();
}

/**
 * Pending-phase retry loop ("продолжи" sent, awaiting the first successful
 * provider response). The interval itself is RETRY_AFTER_FIRE_MS; the tick
 * re-checks the pacing condition against the current arm/state.
 */
function ensureRetryInterval(): void {
  if (retryTimer !== null) return;
  retryTimer = setInterval(() => {
    void retryTick();
  }, RETRY_AFTER_FIRE_MS);
  retryTimer.unref();
}

/**
 * Start (once per session) the slow sync-poller and resync the watchdog
 * immediately. The sync-poller's ONLY job is to notice external writes into
 * arms.json (night helper script) and call syncWatchdog(); it never sends
 * anything itself.
 */
function ensureSyncPoller(): void {
  if (syncTimer === null) {
    syncTimer = setInterval(() => {
      syncWatchdog();
    }, SYNC_POLL_MS);
    syncTimer.unref();
  }
  syncWatchdog();
}

/**
 * In-flight guard: the watchdog fire, the pending-retry tick and the grace
 * callback can OVERLAP while a send is being awaited, double-firing
 * "продолжи" (reproduced by the replacement test: two send-ok lines for one
 * reset). Serialized here. A failure inside the guarded fn is logged, never
 * propagated (callers use fire-and-forget `void`).
 */
let watchdogEvalInFlight = false;

function runGuarded(fn: () => Promise<void>): Promise<void> {
  if (watchdogEvalInFlight) return Promise.resolve();
  watchdogEvalInFlight = true;
  return (async () => {
    try {
      await fn();
    } catch (err) {
      armsLog(
        "watchdog:eval-error",
        String((err as Error)?.message ?? err).slice(0, 200),
      );
    } finally {
      watchdogEvalInFlight = false;
    }
  })();
}

/**
 * Full resync of the cont-after-reset machinery against the CURRENT arm and
 * state on disk. Never sends anything itself:
 *  - no arm: watchdog on the window boundary anyway (a precise reset even
 *    without a flag); retry/grace stopped;
 *  - arm "armed": watchdog on the window boundary -- or, when a reset
 *    already happened after arming (missed boundary / another process /
 *    a failed send), on reset+grace, which fires immediately once the grace
 *    has elapsed;
 *  - arm "pending": retry interval; watchdog/grace cleared.
 */
function syncWatchdog(): void {
  const arm = armsGetArm();
  const st = readStateSync();
  const key = armsGetKey();

  if (arm === null) {
    if (st !== null) {
      armWatchdog(computeFireAt(st), onWatchdogFire);
    } else {
      clearWatchdog();
    }
    stopRetryInterval();
    stopGraceTimer();
    if (lastArmSeenKey !== null) {
      lastArmSeenKey = null;
      armsLog("arm-gone", "флаг исчез/истёк (sync-poller продолжает жить)");
    }
    refreshMarker();
    return;
  }

  if (lastArmSeenKey === null) {
    lastArmSeenKey = key;
    armsLog(
      "arm-seen",
      `repeat=${arm.repeat ?? 1} phase=${arm.phase ?? "armed"} key=${key?.split(/[\\/]/).pop() ?? "?"}`
    );
  }

  stopGraceTimer();
  if (arm.phase === "pending") {
    clearWatchdog();
    ensureRetryInterval();
    return;
  }

  // Spec 002 (D-204): an armed arm with a stale delivery in flight is
  // re-driven by the bounded retry interval, not by re-firing the watchdog
  // (the fire dedup below keeps sync ticks from re-planning the send).
  if (staleAttempts > 0) {
    ensureRetryInterval();
  } else {
    stopRetryInterval();
  }

  if (st === null) {
    clearWatchdog();
    return;
  }
  let fireAt = computeFireAt(st);
  // A reset already happened after arming: the interesting moment is
  // reset+grace (in the past -> immediate fire), not the new boundary.
  // Spec 002 (D-203): idempotent per reset -- once a fire has been planned
  // for this lastResetAt value, further sync ticks must NOT re-plan it
  // (the incident's 60 s "fire:reset-ready" loop).
  if (
    st.lastResetAt > arm.lastResetAtAtArm &&
    st.lastResetAt !== lastFiredResetAt
  ) {
    fireAt = Math.min(fireAt, st.lastResetAt + resetGraceMs);
    lastFiredResetAt = st.lastResetAt;
    // A fresh reset gives the delivery a clean slate (D-204 reset rules).
    staleAttempts = 0;
  }
  armWatchdog(fireAt, onWatchdogFire);
}

/** One pending-retry tick (also exposed to tests for determinism). */
async function retryTick(): Promise<void> {
  return runGuarded(async () => {
    const arm = armsGetArm();
    if (!arm) return;
    if (arm.phase === "pending") {
      const st = readStateSync();
      const retryAfter = Math.max(arm.lastFireAt ?? 0, st?.last429At ?? 0);
      if (Date.now() - retryAfter < RETRY_AFTER_FIRE_MS) return;
      await fireContinue();
      return;
    }
    // Spec 002 (D-204): armed phase with a stale delivery in flight -- the
    // bounded retry loop re-attempts fireContinue (paced internally by
    // staleRetryNotBefore with exponential backoff).
    if (staleAttempts > 0) {
      await fireContinue();
    }
  });
}

/**
 * The watchdog fired (window boundary or reset+grace): do a precise
 * checkAndReset() and, when the conversation is armed, schedule the
 * "продолжи" send after the grace period. The grace delay is measured from
 * state.lastResetAt, so a reset that happened before the fire (lazy ticker,
 * another process) does not wait the grace twice.
 */
async function onWatchdogFire(): Promise<void> {
  return runGuarded(async () => {
    const ep = sessionEpoch;
    // A stray fire while a previous grace is pending would schedule a
    // second grace timer -- drop the previous one first (found by e2e).
    stopGraceTimer();
    try {
      await checkAndReset(buildEmitFn(), historyMetaOf(currentCtx));
    } catch (err) {
      armsLog(
        "watchdog:reset-error",
        String((err as Error)?.message ?? err).slice(0, 160),
      );
      return;
    }
    if (ep !== sessionEpoch) return;
    if (armsGetArm() === null) return;
    const st = readStateSync();
    const base = st !== null && st.lastResetAt > 0 ? st.lastResetAt : Date.now();
    // Spec 002 (D-203): this reset window has now been planned a fire for;
    // sync ticks must not re-plan it.
    lastFiredResetAt = base;
    const delay = Math.max(0, base + resetGraceMs - Date.now());
    armsLog(
      "fire:reset-ready",
      `watchdog: сброс окна ${new Date(base).toISOString()}, отправляю «продолжи» через ${Math.round(delay / 1000)} с`
    );
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (ep !== sessionEpoch) return;
      void runGuarded(fireContinue);
    }, delay);
    graceTimer.unref();
  });
}

/**
 * Spec 002 (D-204): capitulation -- the "never fail silently" path. After
 * STALE_MAX_ATTEMPTS failed delivery attempts the arm is disarmed, the
 * capitulation is logged ("capitulation:after-N") and a notification goes
 * out through the existing notifier.ts channel (D-205, no new secrets).
 */
async function capitulate(): Promise<void> {
  const key = armsGetKey();
  await armsDisarm();
  armsLog(
    `capitulation:after-${STALE_MAX_ATTEMPTS}`,
    `«продолжи» не доставлен после ${STALE_MAX_ATTEMPTS} stale-попыток, ключ ${key?.split(/[\\/]/).pop() ?? "?"} — флаг снят, уведомление отправлено`,
  );
  void sendNotify({
    type: "billing:cont-after-reset-capitulation",
    provider: PROVIDER,
    title: "cont-after-reset: капитуляция",
    body: `«продолжи» не удалось доставить после сброса окна (${STALE_MAX_ATTEMPTS} неудачных stale-попыток). Флаг снят, чтобы не молчать. Подробности: ~/.pi/agent/pi-billing-window-arms.log`,
    timestamp: Date.now(),
  });
  staleAttempts = 0;
  staleRetryNotBefore = 0;
  syncWatchdog();
}

/**
 * Spec 002 (D-204): record one failed delivery attempt (a stale pi send or
 * an epoch-mismatch guard) and pace the retry with exponential backoff.
 * After STALE_MAX_ATTEMPTS attempts the mechanism capitulates instead of
 * looping forever (the production incident's "50 minutes, 0 deliveries").
 */
async function noteStaleFailure(
  kind: "stale" | "waiting",
  detail: string,
): Promise<void> {
  staleAttempts++;
  const backoff = staleBackoffMs(staleAttempts);
  staleRetryNotBefore = Date.now() + backoff;
  const event = kind === "waiting" ? "replacement:waiting" : "send-error:stale";
  armsLog(
    event,
    `${detail} — попытка ${staleAttempts}/${STALE_MAX_ATTEMPTS}, повтор через ${Math.round(backoff / 60000)} мин`,
  );
  ensureRetryInterval();
  if (staleAttempts >= STALE_MAX_ATTEMPTS) {
    await capitulate();
  }
}

/**
 * Send the one-word "продолжи" so the interrupted agent resumes. Guards:
 *  - only when the agent is idle (spec: "if the agent is streaming, do
 *    nothing" -- we keep the arm and retry on the next tick);
 *  - only after the grace period (handled by the caller);
 *  - paced after a stale failure (staleRetryNotBefore, exponential
 *    backoff, D-204).
 * After a successful send the flag switches to "pending" (markFired); the
 * first successful provider response confirms it (confirmSuccess).
 */
async function fireContinue(): Promise<void> {
  if (Date.now() < staleRetryNotBefore) {
    // Paced retry after a stale failure -- the arm and the timers stay.
    return;
  }
  let idle = true;
  try {
    idle = currentCtx?.isIdle?.() ?? true;
  } catch {
    idle = true;
  }
  if (!idle) {
    // Streaming -- spec says do nothing. Keep the arm; the next tick retries.
    return;
  }

  const p = piApi;
  if (!p) {
    armsLog("block:no-pi", "piApi ещё не захвачен фабрикой — флаг сохранён");
    return;
  }
  // Invariant: piApi belongs to epoch piApiEpoch. If the session was
  // replaced, using piApi throws "ctx is stale". Spec 002 (D-201): do not
  // touch the stale refs; count a bounded attempt and capitulate with a
  // notification if re-adoption never comes (instead of looping silently).
  if (piApiEpoch !== sessionEpoch) {
    await noteStaleFailure(
      "waiting",
      `ссылки из прошлой эпохи (piApiEpoch=${piApiEpoch}, sessionEpoch=${sessionEpoch}) — не шлю, жду переусыновления`,
    );
    return;
  }

  try {
    await p.sendUserMessage("продолжи");
    // Sent: switch the flag to "pending" instead of consuming it. The first
    // successful provider response (confirmSuccess) clears it; a 429 means
    // the provider has not recovered yet and the retry loop re-sends every
    // RETRY_AFTER_FIRE_MS.
    await armsMarkFired();
    staleRetryNotBefore = 0;
    // Spec 002 (D-204): a successful delivery resets the stale counter so
    // the next stale streak starts from scratch (no false capitulation).
    staleAttempts = 0;
    armsLog("fire:send-ok", "«продолжи» отправлен, флаг в pending до первого успешного ответа");
  } catch (err) {
    if (/stale/i.test(String((err as Error)?.message ?? err))) {
      // pi went stale mid-send. Spec 002 (D-204): bounded retry with
      // exponential backoff; after N attempts capitulate with a notify
      // (the arm/timers keep running until then).
      await noteStaleFailure(
        "stale",
        `pi устарел: ${String((err as Error)?.message ?? err).slice(0, 160)}`,
      );
      return;
    }
    // Failed to send (e.g. bus busy). Keep the arm; the next tick retries.
    armsLog("send-error", String((err as Error)?.message ?? err).slice(0, 200));
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
  const ctx = currentCtx;
  if (!ctx) return;
  if (!ctxIsTui(ctx)) return;
  try {
    ctx.ui.notify(
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

type EventBusRef = {
  emit: (channel: string, data: unknown) => void;
  on: (channel: string, handler: (data: unknown) => void) => () => void;
};

/**
 * Spec 002 (D-201, FAQ F-1): best-effort re-capture of the live pi/events
 * references from a session_start event/context. Current pi shapes do NOT
 * expose them (SessionStartEvent carries only type/reason/previousSessionFile,
 * ExtensionContext has no api/events fields), so in production today this
 * returns null and the "replacement:waiting" fallback path applies; the
 * probe is kept so a future pi exposing the refs lights up automatically.
 */
function sessionBusOf(event: unknown, ctx: unknown): {
  api: ExtensionAPI;
  bus: EventBusRef;
} | null {
  const holders: unknown[] = [event, ctx];
  for (const holder of holders) {
    if (typeof holder !== "object" || holder === null) continue;
    const h = holder as Record<string, unknown>;
    const api = h["api"] ?? h["pi"] ?? h["extensionApi"];
    const bus = h["events"] ?? h["eventBus"] ?? h["bus"];
    if (
      typeof api === "object" &&
      api !== null &&
      typeof (api as { sendUserMessage?: unknown }).sendUserMessage ===
        "function" &&
      typeof bus === "object" &&
      bus !== null &&
      typeof (bus as { emit?: unknown }).emit === "function" &&
      typeof (bus as { on?: unknown }).on === "function"
    ) {
      return {
        api: api as ExtensionAPI,
        bus: bus as EventBusRef,
      };
    }
  }
  return null;
}

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

  // Spec 002 (D-201): after a session replacement the factory may NOT have
  // re-run, so piApi/eventBus may still belong to the replaced session and
  // every send would fail with "extension ctx is stale". Try to re-capture
  // the fresh refs from the session_start event/context; if that fails, we
  // are on the bounded waiting path (replacement:waiting -> capitulation).
  if (piApiEpoch !== sessionEpoch) {
    const fresh = sessionBusOf(event, ctx);
    if (fresh !== null) {
      eventBus = fresh.bus;
      piApi = fresh.api;
      piApiEpoch = sessionEpoch;
      staleAttempts = 0;
      staleRetryNotBefore = 0;
      armsLog(
        "replacement:adopted",
        "session_start переснял ссылки на pi/events — отправка «продолжи» снова возможна",
      );
    } else {
      armsLog(
        "replacement:waiting",
        "свежие ссылки не найдены в session_start — жду переусыновления (после 6 попыток капитуляция с уведомлением)",
      );
    }
  }

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
  // Spec 002 (D-202): on /new the armed record is carried to the fresh
  // conversation, on fork/replacement the record is carried (fork) or
  // already in place (replacement of the same conversation); on resume /
  // reload / startup we merely re-point at the current conversation -- an
  // arm stays with the conversation that created it. A process restart
  // re-adopts the record persisted under its conversation file.
  try {
    const key = sessionKeyOf(ctx);
    const reason = (event as { reason?: string } | null)?.reason;
    if (remapKey(reason ?? "") === "carry") {
      await armsCarryArmTo(key);
    } else {
      armsSwitchKey(key);
    }
    // Always run the sync-poller: the arm can be (re)created at any time by
    // an external writer (night-agent helper scripts/arm_cont_after_reset.py),
    // and a live sync-poller is what notices and re-arms the watchdog.
    ensureSyncPoller();
    refreshMarker();
  } catch (err) {
    console.warn("pi-billing-window: arms session init failed:", err);
  }
  armsLog(
    "session-start",
    `reason=${String((event as { reason?: string } | null)?.reason ?? "?")} key=${armsGetKey()?.split(/[\\/]/).pop() ?? "?"} armed=${armsIsArmed()}`,
  );
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
  const confirmed = await armsConfirmSuccess(Date.now(), {
    lastResetAt: armState?.lastResetAt,
  });
  if (confirmed) {
    // Spec 002 (D-203): a repeat re-arm waits for the NEXT reset; give the
    // dedup marker a fresh window.
    lastFiredResetAt = null;
    armsLog("fire:confirmed", "успешный ответ после «продолжи» — флаг снят/перевзведён");
    // Re-arm the watchdog for the next boundary (repeat>1) or drop it
    // (the one-shot arm was removed by confirmSuccess).
    syncWatchdog();
  }

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
  // Race guard: a late shutdown for an already-replaced session must not
  // tear down the new session's freshly restarted poller.
  if (_ctx && currentCtx && _ctx !== currentCtx) return;
  // Bump the epoch FIRST so deferred code still holding old-session refs
  // aborts instead of touching them (stale pi -> runtime error).
  sessionEpoch++;
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
  // re-adopted by session_start, which restarts the sync-poller with fresh
  // refs. Keeping these timers alive past replacement left them calling
  // piApi.sendUserMessage() on a stale pi -> "extension ctx is stale" spam.
  stopWatchdogTimers();
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

      // The watchdog must track the (possibly moved) window boundary: resync
      // after the state mutation in BOTH branches (0 = reset, sync = shift).
      syncWatchdog();

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
          syncWatchdog();
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
        // Spec 002 (D-203): a fresh arm allows one fire for the current reset.
        lastFiredResetAt = null;
        syncWatchdog();
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
  piApiEpoch = sessionEpoch;

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
