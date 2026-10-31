/**
 * pi-billing-window -- tracks the 2-hour billing window for the wormsoft
 * provider and emits custom events that other pi extensions can subscribe to.
 *
 * Architecture
 * ------------
 * - state.ts: file-backed JSON state with proper-lockfile serialization
 * - wakeups.ts: absolute wake-point table + wake timer (spec 012)
 * - reset.ts: checkAndReset() under a lock (window boundary detection)
 * - ui.ts: status bar widget that renders a live countdown via ctx.ui.setStatus
 * - index.ts (this file): orchestration -- hooks + commands wiring
 *
 * Custom event channels (sent via pi.events / EventBus)
 * -----------------------------------------------------
 *   "billing:window_reset"         -> payload: fresh State after a reset
 *   "billing:window_about_to_reset"-> payload: { provider, msRemaining }
 *   "llm:first_call"               -> payload: { provider, timestamp, windowStartedAt }
 *
The first two are produced by reset.ts via the wake scheduler (spec 012).
 * The last one is produced by this extension on the first LLM call in a
 * freshly started window.
 *
 * We intentionally use pi.events.emit/on for cross-extension communication
 * instead of pi.on(...): the typed pi.on() only accepts the well-known
 * ExtensionEvent names, not arbitrary channel names.
 */

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  readStateSync,
  mutateState,
  type State,
} from "./state.js";
import {
  ABOUT_TO_RESET_MS,
  // Spec 012 (TD-002/TD-008): checkAndReset живёт в reset.ts (дословный
  // перенос из бывшего ticker.ts) + параметр note для history-строк.
  checkAndReset,
  type EmitFn,
} from "./reset.js";
import {
  armWakeTimer,
  clearWakeTimer,
  readWakeTable,
  mutateWakeTable,
  nextDuePoint,
  dropBurnedPoints,
  appendAnchorPoint,
  computeTableFromAnchor,
  WAKE_BURNED_TTL_MS,
  WAKE_MARGIN_MS,
  WAKE_DEPTH,
  setWakePaths,
} from "./wakeups.js";
import {
  renderStatusBar,
  startStatusUpdater,
  stopStatusUpdater,
  forceUpdate as forceUpdateStatus,
} from "./ui.js";
import { parseDuration, formatDuration } from "./parser.js";
import { sendNotify, type NotifyPayload } from "./notifier.js";
import {
  appendHistory,
  trimHistory,
  isoLocal,
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
  getArmForKey as armsGetArmForKey,
  getKey as armsGetKey,
  extendArmTtl as armsExtendArmTtl,
  ARMS_TTL_MS,
  remapKey,
  RESET_GRACE_MS,
  RETRY_AFTER_FIRE_MS,
} from "./arms.js";
import { armsLog, setArmsLogPath } from "./armslog.js";
// Spec 017 (boundary-ping): пинг-зонд границ окна.
import {
  manualPing,
  pingBoundaryFlow,
  readPingState,
  setPingDisabled,
  PING_MODEL,
} from "./ping.js";
import {
  acquireFireLease,
  releaseFireLease,
  setFiresDirPath,
} from "./firelease.js";
import {
  armWatchdog,
  clearWatchdog,
  computeFireAt,
} from "./watchdog.js";
// Spec 014 (night plan): ночной контракт -- план-файл, интервальная
// математика, ночная книга и сборка утреннего отчёта.
import {
  readPlan,
  writePlan,
  clearPlan,
  inInterval,
  parseHHMM,
  fmtHHMM,
  nextOccurrence,
  previousOccurrence,
  nightDateFor,
  appendLedger,
  readLedger,
  readHistoryRows,
  buildMorningReport,
  fallbackWindowsFromHistory,
  reportPathFor,
  getNightsDir,
  type NightPlan,
  type LedgerRow,
} from "./nightplan.js";
import {
  initRunnerFromPlan,
  resumeRunner,
  pauseRunner,
  stopRunner,
  skipCurrentTask,
  getRunnerStatus,
  dispatchCurrentTask,
  applyTaskResult,
  extractTaskResult,
} from "./nightrun.js";
import { readState as readNightRunState } from "./nightrun-state.js";
import {
  suggestBacklogPath,
  buildNightCreatePrompt,
} from "./nightcreate.js";

export { setArmsLogPath };
// Spec 007: direct unit-test exports for the new delivery/gating helpers.
export { verifyDelivered, isTokenBearing, ownerQuiet };

const PROVIDER = "wormsoft";
const WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Spec 014 (FR-014-6): version stamp формата 014.<date>. Дописывается
 * как токен v= через withAttr (только добавляет, существующие токены не
 * трогает), показывается в /billing-status и в шапке утреннего отчёта --
 * защита от повторения deploy-разрыва 24.10 («ночь работала на коде N»).
 */
export const VERSION = "018.2026-10-31";

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
 * The most recent ctx handed to session_start. Used by the window_reset
 * listener so it can call ctx.ui.notify() without needing the ctx as a
 * closure argument (the listener is registered once via pi.events.on()).
 */
let currentCtx: ExtensionContext | null = null;

/**
 * Spec 006 (D-607/D-608): the owner conversation -- the session-file key
 * whose arm / delivery currentCtx/currentKey/timers serve. It is the
 * conversation that last (re)started this window on a non-blocked path, and
 * it survives foreign (child subagent) session-start/session-shutdown events.
 * Updated ONLY on: first session-start, a same-key session-start, a
 * carry-reason session-start, and /cont-after-reset. Never on a blocked
 * foreign repoint (the guard leaves it with the live owner).
 */
let ownerKey: string | null = null;

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
 * Spec 014 (FR-014-4): unsubscriber для подписчика ночной книги
 * (ledger-строка на каждый billing:window_reset в интервале плана).
 */
let unsubscribeWindowResetLedger: (() => void) | null = null;

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

// --- Spec 006 (F1 probe + F3 attr): аддитивная атрибуция armslog -------------

/**
 * Spec 006 (D-601): last result of probePiAlive(). "unknown" before the
 * first probe. Read by withAttr() to stamp `ctx=stale src=probe` on fire-
 * path lines while the captured pi reference is dead. Never persisted.
 */
let probeState: "live" | "stale" | "unknown" = "unknown";

/**
 * Spec 007 test hook: forces probePiAlive() to return this value regardless
 * of the actual probe. null = use the real probe. Reset in
 * __resetStaleStateForTests().
 */
let probeOverrideForTests: "live" | "stale" | null = null;

/**
 * Spec 006 (D-603c / FR-102): the previous sync tick observed a dead
 * reference (probe "stale"). Read at the top of each syncWatchdog() to
 * detect the stale→live edge on the current tick. Never persisted.
 */
let probeWasStale = false;

/**
 * Spec 006 (D-603c / FR-102): the previous sync tick observed an epoch
 * mismatch (piApiEpoch !== sessionEpoch). Used to detect the FIRST
 * successful epoch-guard after a stale chain ("впервые получен успешный
 * epoch-guard"), distinct from a plain staleAttempts>0 accident where the
 * guard never failed (that must not force). Never persisted.
 */
let epochGuardWasFailing = false;

/**
 * Spec 006 (D-601): cheap dead-reference probe. Any runtime method on the
 * ExtensionAPI is wrapped in `assertActive()` (fact e), so calling
 * `getSessionName?.()` is an O(1) read of staleness that throws "ctx is
 * stale" when the captured `piApi` no longer belongs to the live session.
 * Never sends anything and never throws.
 */
function probePiAlive(): "live" | "stale" {
  if (probeOverrideForTests !== null) return probeOverrideForTests;
  if (piApi === null) return "stale";
  try {
    const p = piApi as unknown as { getSessionName?: () => unknown };
    p.getSessionName?.(); // any runtime method is wrapped in assertActive
    probeState = "live";
  } catch {
    probeState = "stale"; // "ctx is stale" -- reference invalidated
  }
  return probeState;
}

/**
 * Spec 006 (Q-004): `host=` token -- os.hostname() truncated at the first
 * "." or "/" so it stays a single ASCII label (parser's \S+ stays valid).
 */
const hostId = (() => {
  try {
    return os.hostname().split(/[./]/)[0] || "?";
  } catch {
    return "?";
  }
})();

/** Spec 006 (D-606): basename of the current arms key (grammar `key=`). */
function baseKey(): string {
  const k = armsGetKey();
  if (!k) return "?";
  return k.split(/[\\/]/).pop() ?? "?";
}

/**
 * Spec 006 (D-606): append the attribution token block to a fire-path
 * armslog detail, at the very END (monitors' `.*` and `.includes()`-tests
 * stay intact). Grammar:
 *   <detail>  key=<basename> pid=<pid> host=<host> ep=<epoch>
 *            [ctx=stale src=<probe|epoch-guard|drain>] [epoch-mismatch=1]
 * Never duplicates a token already present in `detail` (session-start /
 * arm-seen already carry `key=`). The stale-signal is either passed
 * explicitly by the caller (`stale`) or derived from the current probe /
 * epoch state (D-602). Pure, never throws.
 */
function withAttr(
  detail: string,
  stale?: { ctx: "probe" | "epoch-guard" | "drain"; mismatch?: boolean },
): string {
  let out = detail;
  if (!/\bkey=/.test(out)) out += ` key=${baseKey()}`;
  if (!/\bpid=/.test(out)) out += ` pid=${process.pid}`;
  if (!/\bhost=/.test(out)) out += ` host=${hostId}`;
  if (!/\bep=/.test(out)) out += ` ep=${sessionEpoch}`;
  // Spec 014 (FR-014-6): версия кода, обрабатывавшего ночь (additive).
  if (!/\bv=/.test(out)) out += ` v=${VERSION}`;
  let src: "probe" | "epoch-guard" | "drain" | null = null;
  let mismatch = false;
  if (stale) {
    src = stale.ctx;
    mismatch = !!stale.mismatch;
  } else if (probeState === "stale") {
    src = "probe";
  } else if (piApiEpoch !== sessionEpoch) {
    src = "epoch-guard";
    mismatch = true;
  }
  if (src !== null && !/\bctx=stale/.test(out)) {
    out += ` ctx=stale src=${src}${mismatch ? " epoch-mismatch=1" : ""}`;
  }
  return out;
}

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

/**
 * Spec 005 (fire-once-per-window): the state.lastResetAt value the last
 * successful "продолжи" was sent FOR. In phase "pending" a re-send is
 * allowed ONLY once this marker no longer equals the current
 * state.lastResetAt -- i.e. a NEW window reset has arrived (FR1). Set in
 * fireContinue() immediately after a successful send (the same spot where
 * markFired() runs), reset to null on confirmation / flag removal and in
 * __resetStaleStateForTests(). Not persisted: a process restart between
 * resets yields null, which the pending branch treats as "wait for a new
 * reset" (firedReset falls back to 0 -> at most one send per reset).
 */
let pendingFiredResetAt: number | null = null;

/**
 * Spec 009 (T1): ключ сессии, для которой стартовал ТЕКУЩИЙ runtime.
 * Ставится В НАЧАЛЕ onSessionStart (ДО ownerBlocked-гейта) на КАЖДЫЙ
 * session_start, включая blocked/чужие, поэтому fire-путь (T2/F2) отличает
 * «refs указывают на другую сессию» от «старт ещё не был» и маршрутизирует
 * доставку в разговор владельца через switchSession.
 */
let lastSessionStartKey: string | null = null;

/**
 * Spec 009 (T2): state.lastResetAt, для которого switch-путь уже
 * пробовался (max 1 попытка на reset). Неудачная попытка fall-through к
 * обычной отправке (существующая обработка stale); повтор на ТОМ ЖЕ reset
 * switch не перезапускает.
 */
let switchRoutedForReset: number | null = null;

/**
 * Spec 010 (T1, F1b): state.lastResetAt сброса, TTL для которого уже
 * продлевался sync-poller'ом (один раз на сброс) — флаг не сгорает по TTL
 * во время ночных неудачных цепочек.
 */
let lastTtlExtendedReset = 0;

/**
 * Spec 012 (инцидент pi-remote 2026-10-15, ночная цепочка 02:04→02:57Z):
 * pacing неудачных switch-попыток. Неудачный switchSession НЕ пейсинговался
 * вообще — каждый 60-с sync-тик через ensureGraceTimer (delay=0) заново
 * гонял fire:switch-needed → fire:switch-failed → fire:switch-blocked
 * (~50 тройных кругов за ночь). Теперь неудачная попытка ставит
 * switchRetryNotBefore = now + staleBackoffMs(switchAttempts) (5→60 мин,
 * тот же график, что у stale-доставки), успех switch и переход
 * stale→live сбрасывают счётчик.
 */
let switchAttempts = 0;
let switchRetryNotBefore = 0;

/**
 * Spec 010 (T3, F4): notify «commandCtx мёртв — вызови команду» отправлен
 * ОДИН раз на цепочку (сбрасывается при успешной доставке и в
 * __resetStaleStateForTests) — не спамить на каждую попытку.
 */
let switchFailedNotified = false;

/**
 * Spec 009 (T2): свежий командный ctx (несёт switchSession, жив, пока его
 * сессия активна). Захватывается обёрткой pi.registerCommand в фабрике на
 * КАЖДЫЙ вызов команды — командный хендлер получает свежий
 * ExtensionCommandContext на каждый вызов, в отличие от module-level piApi,
 * захваченного для возможно заменённой сессии.
 */
let commandCtx: ExtensionCommandContext | null = null;

/**
 * Spec 009 (T2, test hook): bounded-ожидание lastSessionStartKey ===
 * ownerKey после успешного switch. В проде switchSession завершает
 * session_start синхронно, так что ожидание — belt-and-suspenders
 * (пара round'ов); тесты сводят его к 0.
 */
let switchWaitMs = 150;
let switchWaitRounds = 2;
export function setSwitchWaitForTests(ms: number, rounds: number): void {
  switchWaitMs = ms;
  switchWaitRounds = rounds;
}

/**
 * Spec 007 (D1): bounded misroute attempts. A send that resolved but never
 * appeared in the owner session jsonl is re-driven by the existing retry
 * loop; after MISROUTE_MAX_ATTEMPTS the mechanism capitulates (disarm +
 * notify) instead of looping silently forever.
 */
let misrouteAttempts = 0;
const MISROUTE_MAX_ATTEMPTS = 6;

/**
 * Spec 007 (test hook): verification override for unit tests. Unit-test
 * mocks do not write session-file entries, so the real verification would
 * mark every mock send as misroute; tests that keep the old asserts stub
 * this to always-true. Null (default) = real verification. The new
 * delivery-gating tests drive the REAL verification with a faithful mock.
 */
let verifyDeliveredOverride:
  | ((
      ownerKey: string | null,
      sendTimeMs: number,
      text: string,
    ) => boolean)
  | null = null;
export function setProbePiAliveForTests(s: "live" | "stale" | null): void {
  probeOverrideForTests = s;
}

export function setVerifyDeliveredForTests(
  fn: ((
    ownerKey: string | null,
    sendTimeMs: number,
    text: string,
  ) => boolean) | null,
): void {
  verifyDeliveredOverride = fn;
}

/**
 * Spec 007 (D1): tolerance between the wall clock (Date.now() at send) and
 * the jsonl entry timestamp when matching the delivered user entry.
 */
const DELIVERED_TOLERANCE_MS = 1500;

/**
 * Spec 007 (live observations 19:38:32Z / 21:38:35Z): pi appends the jsonl
 * entry a few ms -- or more -- after sendUserMessage resolves (the entry's
 * timestamp is set at message creation, the file flush lags behind). Up to
 * DELIVERED_REVERIFY_ROUNDS re-reads with increasing delays catch a
 * slow-but-real delivery before a false misroute is declared.
 */
const DELIVERED_REVERIFY_MS = 2500;
const DELIVERED_REVERIFY_ROUNDS = 3;

/** Exponential backoff: RETRY_AFTER_FIRE_MS * 2^(attempt-1), capped. */
function staleBackoffMs(attempt: number): number {
  return Math.min(
    RETRY_AFTER_FIRE_MS * Math.pow(2, attempt - 1),
    STALE_BACKOFF_CAP_MS,
  );
}

/** Каталог маркеров firelease для тестов (пер-процесс, под системный tmp). */
let testFiresDir: string | null = null;

/**
 * Spec 012 (T4): per-test temp dir for the wake table. __resetStaleStateForTests
 * redirects the wakeups file/lock here so no suite ever touches the user's
 * real ~/.pi/agent/pi-billing-window-wakeups.json (same policy as testFiresDir).
 */
let testWakeDir: string | null = null;

/**
 * Spec 007 (D1): did the sent text actually reach the OWNER conversation?
 * Reads the owner session jsonl and looks for a user entry whose text
 * contains the sent text and whose timestamp is >= sendTimeMs - tolerance.
 * Returns false when the owner key is unknown/ephemeral or the file is
 * unreadable -- the caller keeps the bounded retry path; this helper adds
 * no counters of its own.
 */
function verifyDelivered(
  ownerKey: string | null,
  sendTimeMs: number,
  text: string,
): boolean {
  if (!ownerKey || ownerKey.startsWith("ephemeral:")) return false;
  let raw: string;
  try {
    raw = fs.readFileSync(ownerKey, "utf8");
  } catch {
    return false;
  }
  const notBefore = sendTimeMs - DELIVERED_TOLERANCE_MS;
  type EntryLike = {
    type?: string;
    timestamp?: string;
    message?: {
      role?: string;
      content?: unknown;
    };
  };
  for (const line of raw.split("\n")) {
    if (!line.includes(text)) continue;
    let entry: EntryLike | null = null;
    try {
      entry = JSON.parse(line) as EntryLike;
    } catch {
      continue;
    }
    const e: EntryLike | null = entry;
    if (!e || e.type !== "message") continue;
    if (e.message?.role !== "user") continue;
    const c = e.message?.content;
    const hasText =
      (typeof c === "string" && c.includes(text)) ||
      (Array.isArray(c) &&
        c.some(
          (p) =>
            typeof p === "object" &&
            p !== null &&
            (p as { type?: string; text?: string }).type === "text" &&
            typeof (p as { text?: string }).text === "string" &&
            (p as { text?: string }).text!.includes(text),
        ));
    if (!hasText) continue;
    const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (Number.isFinite(ts) && ts >= notBefore) return true;
  }
  return false;
}

/**
 * Spec 007 (D4): file-based quiet check on the OWNER conversation. True
 * when the owner session jsonl has not been touched for >= quietMs (the
 * window grace -- a recently touched file means another conversation may
 * be mid-turn, even when ctx.isIdle() lies through the shared refs).
 * Unknown/ephemeral owner or unreadable file -> true (do not block the
 * send path on missing evidence; D1/D3 remain the primary guards).
 */
function ownerQuiet(ownerKey: string | null, quietMs: number): boolean {
  if (!ownerKey || ownerKey.startsWith("ephemeral:")) return true;
  try {
    const mtime = fs.statSync(ownerKey).mtimeMs;
    return Date.now() - mtime >= quietMs;
  } catch {
    return true;
  }
}

/**
 * Spec 007 (D2): token-bearing usage check. A successful wormsoft response
 * with no reported token burn (0-token background call: title generation,
 * provider retry probe) must not confirm the pending cont-after-reset arm.
 * Any positive input/output/cache value counts as a real call.
 */
function isTokenBearing(u: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
} | null): boolean {
  if (!u) return false;
  return (
    (typeof u.input === "number" && u.input > 0) ||
    (typeof u.output === "number" && u.output > 0) ||
    (typeof u.cacheRead === "number" && u.cacheRead > 0) ||
    (typeof u.cacheWrite === "number" && u.cacheWrite > 0)
  );
}

/**
 * Test hook: reset the stale-retry counter / pacing / fire dedup marker so
 * scenarios in one process do not leak attempts into each other.
 */
export function __resetStaleStateForTests(): void {
  probeOverrideForTests = null;
  staleAttempts = 0;
  staleRetryNotBefore = 0;
  lastFiredResetAt = null;
  pendingFiredResetAt = null;
  // Spec 009 (T1/T2): session-tracking module state resets with the rest,
  // so scenarios in one process do not leak the switch route or the last
  // session-start key into each other.
  lastSessionStartKey = null;
  switchRoutedForReset = null;
  commandCtx = null;
  // Spec 012 (T2): pacing неудачных switch-попыток — тоже в изоляцию
  // сценариев.
  resetSwitchPacing();
  // Spec 010 (T1/T3): TTL-маркер сброса и notify-флаг цепочки — тоже в
  // изоляцию (сценарии одного процесса не должны наследовать друг друга).
  lastTtlExtendedReset = 0;
  switchFailedNotified = false;
  probeWasStale = false;
  epochGuardWasFailing = false;
  ownerKey = null;
  // Spec 007 (D1): the misroute streak resets with the stale state.
  misrouteAttempts = 0;
  // Diagnostic follow-up (spec 010 T5): scenario 4 leaves currentCtx (isIdle
  // mock) and lastArmSeenKey behind; the fork scenario's fire was silently
  // blocked by the stale currentCtx surviving the reset. Full isolation:
  // these module vars reset with the rest so scenarios in one process do
  // not leak into each other.
  currentCtx = null;
  lastArmSeenKey = null;
  // Spec 011 (D1): снимок последней живой записи и маркер само-снятия —
  // в общую изоляцию сценариев (кейсы одного процесса не наследуют их).
  lastArmSeen = null;
  selfArmGoneKind = null;
  // Diagnostic follow-up (spec 010 T5): car's fireContinue hung inside
  // await armsMarkFired() (withArmsLock racing the spec-010 TTL extension),
  // leaving watchdogEvalInFlight=true -- every later runGuarded call in the
  // fork scenario was silently skipped. Reset the in-flight guard with the
  // rest so scenarios in one process do not inherit a hung delivery.
  watchdogEvalInFlight = false;
  // Spec 006 (D-604): маркеры firelease в тестах — изолированный каталог в
  // системном tmp (пересоздаётся на каждый сброс), чтобы планирования fire из
  // разных сценариев не пересекались и не писали в ~/.pi/agent/...-fires.
  if (testFiresDir === null) {
    testFiresDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibw-fires-"));
  } else {
    fs.rmSync(testFiresDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testFiresDir, { recursive: true });
  setFiresDirPath(testFiresDir);
  // Spec 012 (T4): wake-таблица/таймер — изоляция сценариев: снятый таймер +
  // свежий tmp-каталог, чтобы сьюты не трогали реальный wakeups.json и не
  // стреляли чужие точки (фабрика теперь пишет якоря на каждый firstCall).
  stopWakeTimer();
  if (testWakeDir === null) {
    testWakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pibw-wake-"));
  } else {
    fs.rmSync(testWakeDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testWakeDir, { recursive: true });
  setWakePaths(
    path.join(testWakeDir, "wakeups.json"),
    path.join(testWakeDir, "wakeups.lock"),
  );
}

/** Test hook: read the current stale-retry pacing moment. */
export function __staleRetryNotBeforeForTests(): number {
  return staleRetryNotBefore;
}

/**
 * Spec 007 (test hook): set the misroute/stale pacing marker directly. The
 * misroute retry pace is RETRY_AFTER_FIRE_MS (5 min) -- unit tests compress
 * it to 0 so retryTick re-drives immediately.
 */
export function setStaleRetryNotBeforeForTests(ms: number): void {
  staleRetryNotBefore = ms;
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

/** Spec 012 (T4): test hook -- re-arm the wake scheduler from the table right now. */
export function __ensureWakeTimerForTests(): void {
  ensureWakeTimer();
}

/** Spec 012 (T4/T5): test hook -- force one wake fire (consume + reset check). */
export function __fireWakeForTests(): Promise<void> {
  return onWakeFire();
}

/** Spec 012 (T5): test hook -- run one sync-poller wake safety tick. */
export function __wakeSyncTickForTests(): Promise<void> {
  return wakeSyncTick();
}

/** Spec 012 (T4): test hook -- stop both wake timers (scenario teardown). */
export function __stopWakeTimerForTests(): void {
  stopWakeTimer();
}

/**
 * Track arm visibility changes so syncWatchdog logs "arm-seen" /
 * "arm-gone" only on the transition, not on every sync tick.
 */
let lastArmSeenKey: string | null = null;

// Spec 011 (D1): снимок последней живой записи флага (обновляется на каждом
// sync-тике при живом arm) — по нему arm-gone-переход определяет причину
// сгорания (ttl-expired / repeat-exhausted) для уведомления пользователю.
let lastArmSeen: { phase: string; repeat: number; expiresAt: number } | null =
  null;

// Spec 011 (D1, FR-011-4): маркер «флаг сняли мы сами» — уведомление уже
// есть (capitulation / confirmed-exhausted) или не нужно (off); гасит
// arm-gone-notify, чтобы пользователь не получал дубликат.
let selfArmGoneKind: "off" | "capitulation" | "confirmed-exhausted" | null =
  null;

// --- firelease helpers (spec 006, D-604) --------------------------------------

/**
 * Освободить аренду сброса `reset` для текущего ключа (compare-and-remove по
 * нашему pid; идемпотентен, never-throws). No-op при невалидном reset/ключе.
 */
function releaseFireForReset(reset: number): void {
  if (reset <= 0) return;
  const key = armsGetKey();
  if (!key) return;
  releaseFireLease(key, reset, process.pid);
}

/**
 * Spec 006 (D-604): единственная точка планирования fire — берёт аренду
 * (key, st.lastResetAt) ДО того, как сброс зарегистрирован запланированным
 * (lastFiredResetAt) и ДО лога fire:reset-ready / grace. Возвращает true, когда
 * аренда наша (занята сейчас ИЛИ мы держим её в этом процессе — повторный
 * acquire собственного живого маркера даёт holderPid === process.pid, что
 * равнозначно «аренда всё ещё моя»); false — маркер занят ЧУЖИМ живым
 * процессом: молчаливый дедуп (ни fire:reset-ready, ни lastFiredResetAt),
 * watchdog переводится на следующую границу окна (другой процесс доставит;
 * после TTL/takeover следующая граница даст ещё шанс). Без осмысленного
 * сброса или ключа дедуп невозможен — планируем как раньше (true).
 */
function planFireForReset(st: State | null): boolean {
  const key = armsGetKey();
  if (!key) return true;
  const reset = st?.lastResetAt ?? 0;
  if (reset <= 0) return true;
  const lease = acquireFireLease(key, reset);
  if (lease.ok || lease.holderPid === process.pid) return true;
  // Чужой живой маркер: не планируем, watchdog на следующую границу.
  // (st здесь гарантированно не null — выше reset>0 вернул true раньше.)
  armWatchdog(computeFireAt(st as State), onWatchdogFire);
  return false;
}

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

/** Grammar `key=` from D-606: basename of an arbitrary session-file key. */
function sessionKeyBase(k: string): string {
  return k.split(/[\\/]/).pop() || k;
}

/**
 * Spec 006 (D-608): is the OWNER's interest live? True when the owner's
 * conversation has a live (unexpired, armed/pending) arm under `ownerKey`
 * OR an in-flight delivery for it (state.lastResetAt has already advanced
 * past the reset the owner's arm was set for -- a fire is due/pending).
 * Both clauses are read by key from arms.json WITHOUT touching currentKey.
 * Without a live interest the guard does not block: orphan/foreign sessions
 * must not prevent a legitimate identical re-establishment.
 */
function hasLiveOwnerInterest(): boolean {
  if (ownerKey === null) return false;
  const arm = armsGetArmForKey(ownerKey);
  if (arm === null) return false;
  try {
    const st = readStateSync();
    if (st !== null && st.lastResetAt > arm.lastResetAtAtArm) return true;
  } catch {
    // unreadable state below is non-fatal -- the live arm alone is enough
  }
  return true;
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

/**
 * Spec 002 (T15, инцидент 2026-09-27): a "продолжи" delivery is in flight
 * for a reset that has already been planned a fire (armed arm,
 * state.lastResetAt === lastFiredResetAt). Sync ticks and the retry loop
 * must NOT drop that send: the D-203 dedup will never re-plan this reset
 * (the old noisy 60 s re-fire loop was the incident's only "healer"), so
 * the grace timer survives if armed and is restored from
 * lastResetAt + grace if lost (delay is naturally 0 after the grace has
 * already elapsed). No-op without a planned reset or without a live state.
 */
function ensureGraceTimer(): void {
  if (graceTimer !== null) return;
  const st = readStateSync();
  if (st === null || st.lastResetAt <= 0) return;
  if (lastFiredResetAt === null || st.lastResetAt !== lastFiredResetAt) {
    return;
  }
  const ep = sessionEpoch;
  const delay = Math.max(0, st.lastResetAt + resetGraceMs - Date.now());
  graceTimer = setTimeout(() => {
    graceTimer = null;
    if (ep !== sessionEpoch) return;
    void runGuarded(fireContinue);
  }, delay);
  graceTimer.unref();
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
  // Spec 012 (T4): wake/about timers close over the same session refs --
  // stop them with the rest (session_start re-arms from the wake table).
  stopWakeTimer();
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
      void wakeSyncTick();
      // Spec 014: инвариант страховки + перевзвод утреннего таймера.
      void nightPlanTick();
      ensureMorningTimer();
    }, SYNC_POLL_MS);
    syncTimer.unref();
  }
  syncWatchdog();
  void wakeSyncTick();
  void nightPlanTick();
  ensureMorningTimer();
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
 *    has elapsed. A delivery already in flight for a planned reset (T15)
 *    keeps its own grace timer (never dropped by sync ticks) and is
 *    re-driven by the retry interval; the watchdog points at the NEXT
 *    window boundary for that case;
 *  - arm "pending": retry interval; watchdog/grace cleared.
 */
function syncWatchdog(): void {
  probePiAlive(); // D-601: регулярная картина на каждом sync-тике
  const arm = armsGetArm();
  const st = readStateSync();

  // Spec 010 (T1, F1b): TTL продлевается ПРИ КАЖДОМ сбросе окна (один раз
  // на сброс — lastTtlExtendedReset): флаг, переживающий неудачную цепочку
  // доставки, не сгорает по TTL до восстановления доставки (miRead-кейс:
  // confirm 17:39 → TTL до 01:39 → истёк во время цепочки). sync-poller
  // жив и после fork-цепочек (module timer), поэтому продление не требует
  // живого окна. Никогда не укорачивает (extendArmTtl).
  if (
    st !== null &&
    st.lastResetAt > 0 &&
    lastTtlExtendedReset !== st.lastResetAt &&
    arm !== null
  ) {
    lastTtlExtendedReset = st.lastResetAt;
    // Fire-and-forget с ЯВНЫМ .catch: неудача продления TTL не критична
    // (следующий тик повторит), а голый void здесь ронял процесс
    // unhandled-rejection'ом, когда e2e-cleanup удалял tmp-каталог под
    // ногами ждущего лок (ENOENT mkdir arms.lock.lock).
    void armsExtendArmTtl(armsGetKey(), ARMS_TTL_MS).catch(() => {});
  }

  // Spec 006 (D-603c / FR-102): форс-перерис доставки на ПЕРВОМ же sync-тике,
  // где доставка оживает — probe перешёл stale→live ИЛИ впервые после
  // stale-цепочки (staleAttempts > 0) успешен epoch-guard (piApiEpoch ===
  // sessionEpoch). Только при armed/in-flight доставке (lastFiredResetAt ===
  // st.lastResetAt): сброс backoff и немедленный fireContinue, не ждать
  // 5-минутного pacing. probeState === "live" обязателен — иначе форс при
  // мёртвой ссылке породил бы новые send-error:stale (churn каунтера).
  const wasProbeStale = probeWasStale;
  probeWasStale = probeState === "stale";
  const wasEpochMismatch = epochGuardWasFailing;
  epochGuardWasFailing = piApiEpoch !== sessionEpoch;
  const staleRecovered =
    probeState === "live" &&
    (wasProbeStale ||
      (staleAttempts > 0 && wasEpochMismatch && piApiEpoch === sessionEpoch));
  if (
    arm !== null &&
    st !== null &&
    staleRecovered &&
    lastFiredResetAt === st.lastResetAt
  ) {
    staleAttempts = 0;
    staleRetryNotBefore = 0;
    // Spec 012 (T2): оживание ссылок — чистый лист и для switch-pacing:
    // доставка не ждёт остатка backoff-а.
    resetSwitchPacing();
    ensureRetryInterval();
    void runGuarded(fireContinue);
  }

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
      if (selfArmGoneKind !== null) {
        // Spec 011 (D1, FR-011-4): флаг сняли мы сами (off / capitulation /
        // confirmed-exhausted) — уведомление уже есть или не нужно: только
        // лог с атрибутом kind, без notify.
        armsLog(
          "arm-gone",
          withAttr(
            `флаг исчез/истёк (sync-poller продолжает жить), kind=${selfArmGoneKind}`,
          ),
        );
        selfArmGoneKind = null;
      } else {
        // Spec 011 (D1, FR-011-1): флаг сгорел без нашего участия —
        // определить причину по снимку последней живой записи и уведомить
        // пользователя (fire-and-forget, как capitulation-notify).
        const seen = lastArmSeen;
        let reason:
          | "ttl-expired"
          | "repeat-exhausted"
          | "external-removal" = "ttl-expired";
        let bodyText: string;
        if (seen !== null && Date.now() > seen.expiresAt) {
          reason = "ttl-expired";
          bodyText =
            "срок годности флага (8 ч) истёк — запись удалена из arms.json. Для продолжения взведите снова: /cont-after-reset N";
        } else if (
          seen !== null &&
          seen.phase === "pending" &&
          seen.repeat <= 1
        ) {
          reason = "repeat-exhausted";
          bodyText =
            "автопродолжения исчерпаны (последний «продолжи» подтвердился и снял флаг). Для продолжения взведите снова: /cont-after-reset N";
        } else {
          // Внешнее удаление записи из arms.json (не нами): отдельная метка
          // reason=external-removal. Инцидент APKScenTest 24.10: ночной агент
          // снял флаг сам (arm_cont_after_reset.py --remove по стоп-условию),
          // а armslog сообщил reason=ttl-expired -- ложный след для
          // диагностики (TTL был жив ещё 6 часов).
          reason = "external-removal";
          bodyText =
            "запись исчезла из arms.json (внешнее изменение). Для продолжения взведите снова: /cont-after-reset N";
        }
        armsLog(
          "arm-gone",
          withAttr(
            `флаг исчез/истёк (sync-poller продолжает жить), reason=${reason}`,
          ),
        );
        // Spec 014 (FR-014-3, §5.2): в интервале активного плана arm-gone-notify
        // ГАСИТСЯ: инвариант на этом же тике (или следующим, ≤60 с) либо уже
        // перевзводит флаг (одно событие night-plan-rearm), либо шлёт
        // night-plan-uninsured. Дублировать пользователя не нужно.
        if (activePlanForKey(key) !== null) {
          armsLog(
            "night-plan:arm-gone-suppressed",
            withAttr(
              `billing:cont-after-reset-arm-gone погашен (reason=${reason}): инвариант плана разберётся`,
            ),
          );
        } else {
          // Spec 011 (D1): уведомление об исчезновении/истечении флага —
          // новый type в union NotifyPayload (notifier.ts).
          void sendNotify({
            type: "billing:cont-after-reset-arm-gone",
            provider: PROVIDER,
            title: "cont-after-reset: флаг сгорел",
            body: bodyText,
            timestamp: Date.now(),
          });
        }
      }
      // Spec 011 (D1): снимок сбрасывается вместе с ключом перехода —
      // повторные тики без флага не считаются новым переходом (no dup).
      lastArmSeen = null;
    }
    // Spec 006 (D-604): флаг снят (arm-gone) — освобождаем аренду сброса.
    releaseFireForReset(st?.lastResetAt ?? 0);
    refreshMarker();
    return;
  }

  if (lastArmSeenKey === null) {
    lastArmSeenKey = key;
    armsLog(
      "arm-seen",
      withAttr(`repeat=${arm.repeat ?? 1} phase=${arm.phase ?? "armed"} key=${key?.split(/[\\/]/).pop() ?? "?"}`),
    );
  }
  // Spec 011 (D1): свежий снимок живой записи на каждом тике — к моменту
  // перехода arm-gone он отражает последнее известное состояние флага
  // (phase/repeat/TTL), по нему определяется причина сгорания.
  lastArmSeen = {
    phase: arm.phase ?? "armed",
    repeat: arm.repeat ?? 1,
    expiresAt: arm.expiresAt,
  };

  if (arm.phase === "pending") {
    clearWatchdog();
    stopGraceTimer();
    ensureRetryInterval();
    return;
  }

  // Spec 002 (T15, H0): a "продолжи" delivery is in flight for a reset
  // this process has already planned a fire for. The incident of
  // 2026-09-27: an unconditional stopGraceTimer() here killed the pending
  // grace send when a 60 s sync tick landed inside the grace window, and
  // the D-203 dedup then forbade re-planning it -- 27 minutes of silence.
  // The delivery must survive sync ticks on its own timers instead.
  if (
    st !== null &&
    st.lastResetAt > arm.lastResetAtAtArm &&
    lastFiredResetAt === st.lastResetAt
  ) {
    ensureGraceTimer(); // keep / restore the pending grace send
    ensureRetryInterval(); // H1: re-drive while the agent streams
    // The watchdog points at the next window boundary (the fire dedup
    // keeps sync ticks from re-planning this reset).
    armWatchdog(computeFireAt(st), onWatchdogFire);
    return;
  }

  stopGraceTimer();
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
    // Spec 006 (D-604): аренда маркера ДО регистрации плана. Чужой живой
    // маркер = молчаливый дедуп (другой процесс доставит): план НЕ ставим,
    // lastFiredResetAt НЕ трогаем — planFireForReset уже перевёл watchdog на
    // следующую границу окна, а следующий sync-тик попробует снова.
    if (!planFireForReset(st)) return;
    fireAt = Math.min(fireAt, st.lastResetAt + resetGraceMs);
    lastFiredResetAt = st.lastResetAt;
    // A fresh reset gives the delivery a clean slate (D-204 reset rules;
    // Spec 007 review follow-up: the misroute streak resets too, so partial
    // misroute streaks from earlier resets do not eat the budget of later
    // ones -> no premature capitulation).
    staleAttempts = 0;
    misrouteAttempts = 0;
  }
  armWatchdog(fireAt, onWatchdogFire);
}

/** One pending-retry tick (also exposed to tests for determinism). */
async function retryTick(): Promise<void> {
  return runGuarded(async () => {
    const arm = armsGetArm();
    if (!arm) return;
    const st = readStateSync();
    if (arm.phase === "pending") {
      if (st === null) return;
      // Spec 005 (fire-once-per-window): "продолжи" may be re-sent only
      // after a NEW window reset -- state.lastResetAt advanced past the
      // reset the previous send was made for (pendingFiredResetAt). Elapsed
      // time since lastFireAt / last429At is NO LONGER a send condition
      // (FR1/FR6). A null marker (process restart between resets) is
      // compared against 0 so a send happens at most once per reset.
      const firedReset = pendingFiredResetAt ?? 0;
      if (st.lastResetAt === firedReset) return; // нового сброса нет — ждём
      await fireContinue(); // новый сброс → повтор
      return;
    }
    // Spec 002 (D-204): armed phase with a stale delivery in flight -- the
    // bounded retry loop re-attempts fireContinue (paced internally by
    // staleRetryNotBefore with exponential backoff).
    // Spec 002 (T15, H1): any OTHER delivery in flight (the reset was
    // fired but the send has not gone through: streaming agent, no piApi
    // yet, paced stale retry) is re-driven here too -- the D-203 dedup
    // will never re-plan this reset, so this loop is the only thing left
    // to deliver the "продолжи" (the incident's "not-idle returns silently
    // and nobody retries" hole).
    const deliveryInFlight =
      st !== null &&
      st.lastResetAt > arm.lastResetAtAtArm &&
      lastFiredResetAt === st.lastResetAt;
    if (deliveryInFlight || staleAttempts > 0) {
      await fireContinue();
    }
  });
}

/**
 * The watchdog fired (window boundary or reset+grace): do a precise
 * checkAndReset() and, when the conversation is armed, schedule the
 * "продолжи" send after the grace period. The grace delay is measured from
 * state.lastResetAt, so a reset that happened before the fire (lazy wake
 * point, another process) does not wait the grace twice.
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
    // Spec 006 (D-604): lease-захват ДО регистрации fire. Если аренда у
    // чужого живого процесса — молчаливый дедуп: без fire:reset-ready, без
    // grace и lastFiredResetAt; watchdog уже на следующей границе (повторная
    // попытка при TTL/takeover на ней естественна).
    if (!planFireForReset(st)) return;
    // Spec 002 (D-203): this reset window has now been planned a fire for;
    // sync ticks must not re-plan it.
    lastFiredResetAt = base;
    const delay = Math.max(0, base + resetGraceMs - Date.now());
    // Spec 006 (D-602): признак «fire планируется при мёртвых ссылках» —
    // drain-маркер, если probe видит смерть piApi ИЛИ эпохи разошлись.
    const drainStale =
      piApi === null || probePiAlive() === "stale" || piApiEpoch !== sessionEpoch;
    armsLog(
      "fire:reset-ready",
      withAttr(
        `watchdog: сброс окна ${new Date(base).toISOString()}, отправляю «продолжи» через ${Math.round(delay / 1000)} с`,
        drainStale ? { ctx: "drain", mismatch: true } : undefined,
      ),
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
/**
 * What exhausted the delivery attempts: a stale pi / epoch-mismatch chain
 * ("stale") or a persistent misroute ("misroute"). Drives the log/notify
 * label so the telemetry names the real cause.
 */
type CapitulationCause = "stale" | "misroute";

async function capitulate(cause: CapitulationCause = "stale"): Promise<void> {
  const key = armsGetKey();
  // Spec 011 (D1, FR-011-4): капитуляция снимает флаг сама — пометить
  // само-снятие ДО armsDisarm(), чтобы arm-gone-переход не отправил
  // дублирующее уведомление (capitulation-notify уже уходит ниже).
  selfArmGoneKind = "capitulation";
  await armsDisarm();
  // Spec 006 (D-604): капитуляция — release-точка аренды сброса.
  releaseFireForReset(readStateSync()?.lastResetAt ?? 0);
  const causeLabel =
    cause === "misroute" ? `${MISROUTE_MAX_ATTEMPTS} misroute-попыток` : `${STALE_MAX_ATTEMPTS} stale-попыток`;
  armsLog(
    `capitulation:after-${STALE_MAX_ATTEMPTS}`,
    withAttr(`«продолжи» не доставлен после ${causeLabel}, ключ ${key?.split(/[\\/]/).pop() ?? "?"} — флаг снят, уведомление отправлено`),
  );
  void sendNotify({
    type: "billing:cont-after-reset-capitulation",
    provider: PROVIDER,
    title: "cont-after-reset: капитуляция",
    body: `«продолжи» не удалось доставить после сброса окна (${causeLabel}). Флаг снят, чтобы не молчать. Подробности: ~/.pi/agent/pi-billing-window-arms.log`,
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
  // Spec 006 (D-604): stale-провал — release-точка аренды (другой процесс
  // получает шанс доставить первым), свой retry-цикл живёт и повторно
  // acquire'ит перед следующей отправкой. kind="waiting" (epoch-guard) аренду
  // НЕ снимает: доставка легитимно отложена до переусыновления (FR-203).
  if (kind === "stale") releaseFireForReset(readStateSync()?.lastResetAt ?? 0);
  armsLog(
    event,
    withAttr(
      `${detail} — попытка ${staleAttempts}/${STALE_MAX_ATTEMPTS}, повтор через ${Math.round(backoff / 60000)} мин`,
      // Spec 006 (D-602): "stale"-ветка — send упал по факту (probe);
      // "waiting"-ветка — epoch-guard (ссылки из прошлой эпохи).
      kind === "stale"
        ? { ctx: "probe" }
        : { ctx: "epoch-guard", mismatch: true },
    ),
  );
  ensureRetryInterval();
  if (staleAttempts >= STALE_MAX_ATTEMPTS) {
    // Spec 010 (T1, F1a): капитуляция в repeat-режиме (repeat > 1) НЕ
    // снимает флаг — пауза до следующего сброса окна (флаг остаётся armed,
    // retry-интервал жив с пейcингом до границы, sync-poller жив): ночной
    // сценарий требует, чтобы флаг пережил ночь; при следующем сбросе —
    // новая цепочка (staleAttempts обнуляется), и если commandCtx ожил
    // (пользователь вызвал команду) — delivery проходит. Одноразовый флаг
    // (repeat=1) капитулирует как раньше (вечный ретрай не нужен).
    const armRec = armsGetArm();
    if (armRec !== null && (armRec.repeat ?? 1) > 1) {
      await pauseChainUntilNextReset();
    } else {
      await capitulate();
    }
  }
}

/**
 * Spec 010 (T1, F1a): пауза неудачной цепочки доставки в repeat-режиме —
 * флаг остаётся armed (НЕ disarm), notify уходит пользователю, retry-пейcинг
 * ставится на момент следующего сброса (computeFireAt), staleAttempts
 * обнуляется (новая цепочка при следующем сбросе — чистый backoff).
 * Вечный ретрай останавливается (попытки не повторяются 6 раз подряд), но
 * флаг переживает ночь.
 */
async function pauseChainUntilNextReset(): Promise<void> {
  const key = armsGetKey();
  const nextFire = computeFireAt(readStateSync() as State);
  staleAttempts = 0;
  staleRetryNotBefore = Number.isFinite(nextFire) ? nextFire : Date.now() + STALE_BACKOFF_CAP_MS;
  // Spec 010 (T3): notify-флаг цепочки сбрасывается — новая цепочка даст
  // новый notify, если commandCtx опять мёртв.
  switchFailedNotified = false;
  armsLog(
    `capitulation:paused-until-reset`,
    withAttr(`«продолжи» не доставлен после ${STALE_MAX_ATTEMPTS} попыток, ключ ${key?.split(/[\\/]/).pop() ?? "?"} — флага НЕ снят (repeat-режим), цепочка паузится до следующего сброса`),
  );
  void sendNotify({
    type: "billing:cont-after-reset-capitulation",
    provider: PROVIDER,
    title: "cont-after-reset: пауза до сброса",
    body: `«продолжи» не удалось доставить (${STALE_MAX_ATTEMPTS} попыток). Флаг остаётся взведённым (repeat-режим) и переживёт ночь; доставка восстановится, когда commandCtx оживёт (вызов любой команды в окне). Подробности: ~/.pi/agent/pi-billing-window-arms.log`,
    timestamp: Date.now(),
  });
  syncWatchdog();
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
/**
 * Spec 012: сброс pacing-состояния switch-пути (успешный switch, переход
 * stale→live, session_start владельца). Доставка начинается с чистого
 * листа, как D-204 делает для stale-доставки.
 */
function resetSwitchPacing(): void {
  switchAttempts = 0;
  switchRetryNotBefore = 0;
}

/**
 * Spec 009 (T2): переключить АКТИВНУЮ сессию окна на разговор владельца
 * ТОЛЬКО через командный ctx-механизм. Командный ctx (захвачен обёрткой
 * pi.registerCommand) несёт switchSession, который маршрутизируется через
 * AgentSessionRuntime.switchSession и поднимает session_start владельца
 * СИНХРОННО ДО своего завершения (полный старт — incoming === ownerKey
 * никогда не blocked). НЕ трогает ownerKey/currentKey (инвариант spec 006).
 * Follow-up (live 19:42Z): commandCtx может быть МЁРТВ после длинной
 * fork-цепочки (захвачен при /cont-after-reset до цепочки) — switchSession
 * бросает stale; причина отказа возвращается вызывающему для лога
 * fire:switch-failed (диагностика) и для решения о повторной попытке.
 * Spec 012 (T1): с успешной заменой pi инвалидирует и САМ вызывающий командный
 * ctx ("Do not use a captured pi or command ctx after ctx.switchSession()") —
 * пост-replacement работу pi предписывает вести в withSession-callback,
 * который получает свежий command-capable ctx. Захватываем его в commandCtx,
 * чтобы СЛЕДУЮЩИЙ fire-раунд не упирался в мёртвый switch-путь после нашего
 * же успешного switch (инцидент pi-remote: успешный switch в 09:00Z оставлял
 * мёртвый commandCtx до следующей ручной команды в окне).
 */
async function trySwitchToOwner(
  key: string,
): Promise<{ ok: boolean; reason: string }> {
  const ctx = commandCtx as unknown as {
    switchSession?: (
      sessionPath: string,
      options?: {
        withSession?: (replacedCtx: ExtensionCommandContext) => Promise<void>;
      },
    ) => Promise<{ cancelled: boolean }>;
  } | null;
  if (ctx === null || typeof ctx.switchSession !== "function") {
    return {
      ok: false,
      reason: "commandCtx недоступен/не несёт switchSession",
    };
  }
  try {
    const res = await ctx.switchSession(key, {
      withSession: async (replacedCtx) => {
        // Свежий ReplacedSessionContext — command-capable и жив: pi
        // валидирует его методы ровно как у обычного командного ctx.
        commandCtx = replacedCtx;
        switchFailedNotified = false;
        resetSwitchPacing();
      },
    });
    if (res?.cancelled === false) return { ok: true, reason: "switched" };
    return { ok: false, reason: `cancelled=${String(res?.cancelled)}` };
  } catch (err) {
    return {
      ok: false,
      reason: `switchSession бросил: ${String((err as Error)?.message ?? err).slice(0, 120)}`,
    };
  }
}

async function fireContinue(): Promise<void> {
  // Spec 006 (D-601): свежий статус на момент попытки, перед epoch-guard.
  probePiAlive();
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

  // Spec 007 (D4): file-based quiet check on the OWNER conversation. A
  // recently touched owner jsonl means another conversation may be mid-turn
  // even when ctx.isIdle() lies through the shared refs. Unknown/unreadable
  // file does not block (ownerQuiet returns true).
  if (!ownerQuiet(ownerKey, resetGraceMs)) {
    armsLog(
      "block:owner-busy",
      withAttr(
        "jsonl владельца менялся недавно — вероятно, чужой/родительский разговор в ходу, не шлю",
      ),
    );
    return;
  }

  // Spec 009 (T2, F2): маршрутизация доставки в РАЗГОВОР владельца.
  // lastSessionStartKey — ключ, для которого стартовал текущий runtime;
  // когда он ≠ владельцу, refs (piApi) принадлежат другой сессии, и обычная
  // отправка уйдёт в чужой разговор (или упадёт stale). Переключаем активную
  // сессию на владельца через командный ctx (switchSession) — он поднимает
  // session_start владельца синхронно (полный старт, не blocked: incoming
  // === ownerKey), после чего piApi перечитывается свежим. Max 1 УСПЕШНЫЙ switch на reset
  // (switchRoutedForReset); неудачная попытка НЕ отправляет ничего
  // (Spec 011 D2: misroute исключён, повтор на retry-тике), после успешного
  // revive — один мгновенный повтор switch (Spec 011 TD-011-3).
  const curReset = readStateSync()?.lastResetAt ?? 0;
  if (
    ownerKey !== null &&
    lastSessionStartKey !== null &&
    lastSessionStartKey !== ownerKey &&
    switchRoutedForReset !== curReset
  ) {
    // Spec 012 (T2): paced retry после неудачного switch-пути — как
    // D-204 делает для stale-доставки. Неудачный switch НЕ пейсинговался
    // вообще: каждый 60-с sync-тик через ensureGraceTimer (delay=0)
    // заново гонял switch-раунд (инцидент pi-remote: ~50 тройных кругов
    // fire:switch-* за ночь). Молча ждём — нарушать silence ради спама
    // нечего, доставка возобновится сама по backoff-у или при
    // stale→live переходе в syncWatchdog.
    if (Date.now() < switchRetryNotBefore) {
      ensureRetryInterval();
      return;
    }
    armsLog(
      "fire:switch-needed",
      withAttr(
        `refs указывают на другую сессию (${sessionKeyBase(lastSessionStartKey)} != владельца ${sessionKeyBase(ownerKey)}) — переключаю активную сессию на владельца через switchSession`,
      ),
    );
    const switchRes = await trySwitchToOwner(ownerKey);
    // Follow-up (live 19:42Z): маркер ставится ТОЛЬКО при УСПЕШНОМ switch —
    // неудачная попытка (commandCtx мёртв после fork-цепочки, throw/cancel)
    // НЕ блокирует повторные попытки switch на retry-попытках того же
    // сброса; частоту ограничивает существующий stale-пейcинг
    // (staleRetryNotBefore: 5/10/20/40/60 мин). Неудачный switch НЕ
    // переключает активную сессию — повтор безопасен.
    let switched = false;
    if (switchRes.ok) {
      switchRoutedForReset = curReset;
      // Spec 012 (T2): успешный switch — чистый лист pacing-а (withSession-
      // callback тоже это делает, но он опционален со стороны pi).
      resetSwitchPacing();
      // switchSession завершается ПОСЛЕ session_start-хендлеров владельца,
      // так что lastSessionStartKey уже равен ownerKey — ожидание
      // belt-and-suspenders (bounded: пара round'ов, settable для тестов).
      for (
        let round = 0;
        round < switchWaitRounds && lastSessionStartKey !== ownerKey;
        round++
      ) {
        await new Promise((r) => setTimeout(r, switchWaitMs));
      }
      switched = true;
    } else {
      armsLog(
        "fire:switch-failed",
        withAttr(
          `switchSession не прошёл (${switchRes.reason}) — повтор switch после revive`,
        ),
      );
      const staleCommandCtx = /stale/i.test(switchRes.reason);
      // Spec 010 (T3, F4): notify при ПЕРВОМ switch-failed из-за мёртвого
      // commandCtx на цепочку (switchFailedNotified) — не спамить на каждую
      // попытку; уходит через notifier, виден утром/в истории.
      if (staleCommandCtx && !switchFailedNotified) {
        switchFailedNotified = true;
        void sendNotify({
          type: "billing:cont-after-reset-capitulation",
          provider: PROVIDER,
          title: "cont-after-reset: commandCtx мёртв",
          body: `switchSession не прошёл после fork-цепочки. Вызови любую команду в окне (например /billing-status), чтобы switch-путь ожил. Подробности: ~/.pi/agent/pi-billing-window-arms.log`,
          timestamp: Date.now(),
        });
      }
      // Spec 010 (T2, F2): программный вызов команды при ЖИВОМ piApi —
      // pi исполняет extension-команду ВМЕСТО отправки (no turn, no user
      // entry) через текущий runtime → обёртка pi.registerCommand захватит
      // commandCtx = fresh ctx → switch-путь восстановится. Гейт: только
      // при stale commandCtx И probePiAlive() === "live" И piApiEpoch ===
      // sessionEpoch (мёртвый piApi → throws stale — без вызова). При
      // мёртвом piApi — ничего.
      const piRef = piApi;
      let revived = false;
      if (
        staleCommandCtx &&
        probePiAlive() === "live" &&
        piApiEpoch === sessionEpoch &&
        piRef !== null
      ) {
        try {
          await piRef.sendUserMessage("/billing-status", {
            expandPromptTemplates: true,
          });
          armsLog(
            "switch-revive:cmd",
            withAttr(
              "команда исполнена программно — commandCtx обновится на свежий ctx, switch-путь восстановится",
            ),
          );
          revived = true;
        } catch (err) {
          armsLog(
            "switch-revive:failed",
            withAttr(String((err as Error)?.message ?? err).slice(0, 120)),
          );
        }
      }
      if (revived) {
        // Spec 011 (TD-011-3): мгновенный ЕДИНСТВЕННЫЙ повтор switch в том
        // же раунде — revive синхронно перезахватил commandCtx, повторный
        // switchSession почти всегда проходит; провал → switch-blocked
        // (return) — снова через retry-тик.
        const retryRes = await trySwitchToOwner(ownerKey);
        if (retryRes.ok) {
          switchRoutedForReset = curReset;
          armsLog(
            "fire:switch-retry-ok",
            withAttr(
              "повтор switchSession после revive прошёл — доставка в разговор владельца в этом же раунде",
            ),
          );
          resetSwitchPacing();
          // Тот же wait-loop, что и при первом прохождении switch.
          for (
            let round = 0;
            round < switchWaitRounds && lastSessionStartKey !== ownerKey;
            round++
          ) {
            await new Promise((r) => setTimeout(r, switchWaitMs));
          }
          switched = true;
        } else {
          armsLog(
            "fire:switch-retry-failed",
            withAttr(
              `switchSession после revive не прошёл (${retryRes.reason}) — «продолжи» не отправляю`,
            ),
          );
        }
      }
      if (!switched) {
        // Spec 011 (D2, FR-011-2): ГЛАВНОЕ — отправка «продолжи» в чужую
        // сессию невозможна: без прошедшего switch доставка блокируется,
        // повтор на retry-тике (ensureRetryInterval). switch-blocked НЕ
        // инкрементирует staleAttempts (ложная капитуляция запрещена).
        // Spec 012 (T2): неудачная цепочка switch-путь пейсингует — следующий
        // раунд не раньше staleBackoffMs(switchAttempts).
        switchAttempts++;
        switchRetryNotBefore = Date.now() + staleBackoffMs(switchAttempts);
        armsLog(
          "fire:switch-blocked",
          withAttr(
            `switch на владельца не прошёл — «продолжи» НЕ отправляю (misroute исключён), повтор через ${Math.round(staleBackoffMs(switchAttempts) / 60_000)} мин (попытка ${switchAttempts})`,
          ),
        );
        ensureRetryInterval();
        return;
      }
    }
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

  // Spec 006 (D-604): send-gating — отправляем, только пока аренда (key,
  // reset) всё ещё НАША (пере-acquire). Чужая живая аренда вернёт ok:false с
  // чужим holderPid -> не шлём (другой процесс доставит; retry/pacing живёт).
  const gateSt = readStateSync();
  const gateReset =
    gateSt !== null && gateSt.lastResetAt > 0 ? gateSt.lastResetAt : 0;
  const gateKey = armsGetKey();
  if (gateKey && gateReset > 0) {
    const lease = acquireFireLease(gateKey, gateReset);
    if (!lease.ok && lease.holderPid !== process.pid) return;
  }

  try {
    const sendTime = Date.now();
    await p.sendUserMessage("продолжи");
    // Spec 007 (D1): sendUserMessage resolved, but pi routes it through the
    // SHARED runtime slot, which a live subagent session re-points at itself
    // (bindCore plain slot assignment; assertActive does not detect it).
    // Verify the owner jsonl actually received the entry; otherwise the
    // message went to a foreign session -- do NOT switch to pending, keep
    // the armed (delivery-in-flight) state so the retry loop re-drives, and
    // pace it. After MISROUTE_MAX_ATTEMPTS, capitulate instead of looping.
    let delivered = (verifyDeliveredOverride ?? verifyDelivered)(
      ownerKey,
      sendTime,
      "продолжи",
    );
    // Spec 007 (live observation 19:38:32Z, session 17-27-11-381Z): pi
    // appends the user entry to the session jsonl a few ms AFTER
    // sendUserMessage resolves (the incident: entry at +17 ms) -- a fast
    // file read misses a slow-but-real delivery and reports a false
    // misroute. Re-verify once with a short bounded grace before declaring
    // a misroute; only then count an attempt and pace the retry.
    if (!delivered) {
      // Pace IMMEDIATELY: during the re-verify grace this fireContinue is
      // still awaiting, and the retry loop could re-drive a SECOND send in
      // parallel (the pace is normally set after the misroute is declared).
      staleRetryNotBefore = Date.now() + staleBackoffMs(misrouteAttempts + 1);
      for (let round = 1; round <= DELIVERED_REVERIFY_ROUNDS && !delivered; round++) {
        await new Promise((r) =>
          setTimeout(r, DELIVERED_REVERIFY_MS * round),
        );
        delivered = (verifyDeliveredOverride ?? verifyDelivered)(
          ownerKey,
          sendTime,
          "продолжи",
        );
        if (delivered) {
          staleRetryNotBefore = 0; // delivered -> clean slate (D-204)
          armsLog(
            "fire:send-reverify",
            withAttr(
              `запись владельца появилась в jsonl после довписи (реверификация ${round}) — реверификация сняла ложный misroute`,
            ),
          );
        }
      }
    }
    if (!delivered) {
      misrouteAttempts++;
      armsLog(
        "fire:send-misroute",
        withAttr(
          `sendUserMessage решилcя, но в jsonl владельца (${ownerKey ? ownerKey.split(/[\\/]/).pop() : "?"}) записи «продолжи» нет — сообщение ушло в чужую сессию, попытка ${misrouteAttempts}/${MISROUTE_MAX_ATTEMPTS}`,
        ),
      );
      if (misrouteAttempts >= MISROUTE_MAX_ATTEMPTS) {
        await capitulate("misroute");
      } else {
        staleRetryNotBefore = Date.now() + staleBackoffMs(misrouteAttempts);
      }
      return;
    }
    // Sent: switch the flag to "pending" instead of consuming it. The first
    // successful provider response (confirmSuccess) clears it; a 429 means
    // the provider has not recovered yet and the retry loop re-sends every
    // RETRY_AFTER_FIRE_MS.
    await armsMarkFired();
    staleRetryNotBefore = 0;
    // Spec 002 (D-204): a successful delivery resets the stale counter so
    // the next stale streak starts from scratch (no false capitulation).
    staleAttempts = 0;
    // Spec 007 (D1): a delivered send starts the misroute streak from
    // scratch (no false capitulation from a stale foreign session).
    misrouteAttempts = 0;
    // Spec 010 (T3): успешная доставка сбрасывает notify-флаг цепочки —
    // следующая fork-цепочка с мёртвым commandCtx даст новый notify.
    switchFailedNotified = false;
    // Spec 005: record the reset this send was made for so the pending
    // branch of retryTick re-sends only on a NEW reset, not on a 5-min
    // timeout (FR1).
    pendingFiredResetAt = readStateSync()?.lastResetAt ?? null;
    armsLog("fire:send-ok", withAttr("«продолжи» отправлен и подтверждён в jsonl владельца, флаг в pending до первого успешного ответа"));
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
    armsLog("send-error", withAttr(String((err as Error)?.message ?? err).slice(0, 200)));
    // Spec 006 (D-604): non-stale send-ошибка тоже освобождает аренду —
    // следующий retry re-acquire'ит перед новой отправкой.
    releaseFireForReset(readStateSync()?.lastResetAt ?? 0);
  }
  refreshMarker();
}

// --- Emit plumbing ------------------------------------------------------------

/**
 * Build an EmitFn that forwards into pi.events (the EventBus shared across
 * extensions). We capture the bus reference once at session_start; the wake
 * scheduler and commands call this closure, so the bus reference is stable
 * for the lifetime of the running session.
 *
 * `null` is treated as "no bus yet" (e.g. very early startup before
 * session_start has fired) -- in that case emit becomes a no-op so the
 * scheduler doesn't crash.
 */
function buildEmitFn(): EmitFn {
  return (event: string, payload: unknown) => {
    const bus = eventBus;
    if (bus) {
      try {
        bus.emit(event, payload);
      } catch {
        // Never let a listener failure kill the scheduler. The bus already wraps
        // individual handlers, but our own .emit must not throw either.
      }
    }
    // Spec 015-fix: ПРЯМОЙ путь ночной книги. Запись ledger больше не
    // зависит от живой EventBus-подписки (инцидент 25→26.10: сессию вымесло
    // чужой session_start, session_shutdown снял подписки, blocked-путь их
    // не вернул — 6 сбросов ушли в шину без слушателей). Дубль с подписчиком
    // исключает идемпотентность appendLedger по (nightDate, resetAt, resetCount).
    if (event === "billing:window_reset") {
      void nightPlanLedgerRow(payload);
      // Spec 015: re-drive ночной очереди на новом окне (только если
      // runner запущен явно и userStop не стоит).
      nightRunRedriveOnReset();
    }
  };
}

// --- Wake scheduler lifecycle (spec 012, TD-005) -------------------------------

/**
 * Secondary one-shot timer for billing:window_about_to_reset (Should, D-012):
 * fires ABOUT_TO_RESET_MS before the armed wake point. Kept as a separate
 * module handle -- wakeups.ts owns the wake timer handle itself.
 */
let wakeAboutHandle: ReturnType<typeof setTimeout> | null = null;

/** Stop both wake timers (idempotent; shutdown + cancel-before-arm). */
function stopWakeTimer(): void {
  clearWakeTimer();
  if (wakeAboutHandle !== null) {
    clearTimeout(wakeAboutHandle);
    wakeAboutHandle = null;
  }
}

/** History note for a wake-sourced reset: "wake HH:MM" (local time of the
 * fired point, TD-008). */
function wakeNoteOf(p: number): string {
  const d = new Date(p);
  return `wake ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Idempotent wake scheduler (ensureGraceTimer pattern, TD-005): cancel both
 * old timers, tolerantly read the table, arm the one-shot unref wake timer
 * at the next due point; the about_to_reset secondary timer is armed only
 * when its moment is in the future. Re-armed on every source event
 * (llm:first_call anchor, billing:window_reset, /settimer, /billing-reset,
 * session_start, every fire, every sync tick) -- the wall-clock recompute on
 * each re-arm neutralizes setTimeout drift.
 */
function ensureWakeTimer(): void {
  stopWakeTimer();
  const now = Date.now();
  const p = nextDuePoint(readWakeTable(), now);
  if (p === null) return;
  armWakeTimer(p, () => {
    void onWakeFire();
  });
  const aboutAt = p - ABOUT_TO_RESET_MS;
  if (aboutAt > now) {
    wakeAboutHandle = setTimeout(() => {
      wakeAboutHandle = null;
      // Payload by the fresh state (design §4 API contract).
      const st = readStateSync();
      buildEmitFn()("billing:window_about_to_reset", {
        provider: st?.provider ?? PROVIDER,
        msRemaining: Math.max(0, p - Date.now()),
      });
    }, aboutAt - now);
    wakeAboutHandle.unref();
  }
}

/**
 * A wake point fired (timer or sync-poller safety path). The head is
 * consumed under the lock UNCONDITIONALLY (TD-004 op 1 -- a point is
 * one-shot by definition; a no-op checkAndReset just means "window still
 * alive", the next anchor restores precision). FR-012-10: a burned head
 * (now > p + WAKE_BURNED_TTL_MS -- the machine slept through the boundary)
 * is purged quietly with NO reset emit (design §8). Then the single reset
 * path checkAndReset with note "wake HH:MM" (TD-008) and a re-arm from the
 * remaining tail. runGuarded serializes overlaps with the watchdog fire;
 * reset dedup (lastResetAt + DEDUP_WINDOW_MS) makes a double fire harmless.
 */
async function onWakeFire(): Promise<void> {
  return runGuarded(async () => {
    const now = Date.now();
    const table = readWakeTable();
    if (table !== null && table.points.length > 0) {
      if (now > table.points[0] + WAKE_BURNED_TTL_MS) {
        // Burned head: quiet purge, no shot into the past (FR-012-10).
        const burnedPoint = table.points[0];
        await mutateWakeTable((cur) =>
          cur === null ? { next: null } : { next: dropBurnedPoints(cur, Date.now()) },
        );
        // Spec 017 (FR-017-8): probe-ping на сгоревшей голове — окно, скорее
        // всего, перевернулось во сне: 200 → верифицированный reset (сетка
        // восстанавливается без ручного /settimer); 429/infra → штатные пути
        // spec 017. Слепой reset запрещён (blindOnInfra=false): spec 012
        // «не стрелять в прошлое» сохраняется и для infra-путей.
        await pingBoundaryFlow({
          firedPoint: burnedPoint,
          note: `probe ${wakeNoteOf(burnedPoint)}`,
          emit: buildEmitFn(),
          meta: historyMetaOf(currentCtx),
          blindOnInfra: false,
        });
      } else {
        const firedPoint = table.points[0];
        await mutateWakeTable((cur) => {
          if (cur === null || cur.points.length === 0) return { next: null };
          // Spec 017: consume-guard — параллельный процесс, уже съевший голову
          // (общий файл), больше НЕ съедает следующую точку: потребляем только
          // если голова всё ещё наша.
          if (cur.points[0] !== firedPoint) return { next: null };
          return { next: { ...cur, points: cur.points.slice(1) } };
        });
        // Spec 017 (FR-017-1): граница проходит через пинг-зонд. "legacy"
        // (пинг выключен / state нет) — слепой checkAndReset как до фичи.
        const outcome = await pingBoundaryFlow({
          firedPoint,
          note: wakeNoteOf(firedPoint),
          emit: buildEmitFn(),
          meta: historyMetaOf(currentCtx),
          blindOnInfra: true,
        });
        if (outcome === "legacy") {
          await checkAndReset(
            buildEmitFn(),
            historyMetaOf(currentCtx),
            wakeNoteOf(firedPoint),
          );
        }
      }
    }
    ensureWakeTimer();
  });
}

/**
 * Spec 012 (T5, TD-007): 60-second safety net inside the existing
 * sync-poller. Bounds the wake delivery lag by WAKE_MARGIN_MS +
 * SYNC_POLL_MS even when the one-shot setTimeout drifted or was lost under
 * load. Burned points are purged quietly -- no shot into the past
 * (FR-012-10); a due point goes through the exact onWakeFire path
 * (consume under lock + checkAndReset "wake HH:MM") -- the double path
 * (timer + poller) collapses into one reset via consume + reset dedup.
 */
async function wakeSyncTick(): Promise<void> {
  const now = Date.now();
  const table = readWakeTable();
  if (table === null || table.points.length === 0) return;
  if (dropBurnedPoints(table, now).points.length !== table.points.length) {
    // Quiet purge of everything burned by a long sleep (FR-012-10).
    await mutateWakeTable((cur) =>
      cur === null ? { next: null } : { next: dropBurnedPoints(cur, Date.now()) },
    );
  }
  // nextDuePoint is TTL-aware, so a skipped (ELOCKED) purge is harmless.
  const p = nextDuePoint(table, now);
  if (p !== null && now >= p) {
    await onWakeFire();
    return;
  }
  ensureWakeTimer(); // wall-clock re-arm against drift (TD-005)
}

// --- EventBus listeners -------------------------------------------------------

/**
 * Listener for our own "billing:window_reset" channel. We push a friendly
 * notification in TUI mode; in other modes (rpc, print) we silently skip --
 * notify() would just clutter logs there.
 * On reset we also force the status-bar widget to refresh so it shows the
 * new absolute next-reset time immediately.
 */
function handleWindowReset(_payload: unknown): void {
  // Spec 012 (T4): a reset just happened -- re-arm the scheduler from the
  // remaining tail of the wake table (design §3/§4: window_reset is one of
  // the re-arm events).
  ensureWakeTimer();
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
  // Refresh the timer widget with the new reset boundary (absolute time).
  forceUpdateStatus(ctx);
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
  if (unsubscribeWindowResetLedger) {
    try {
      unsubscribeWindowResetLedger();
    } catch {}
    unsubscribeWindowResetLedger = null;
  }

  try {
    unsubscribeWindowReset = bus.on("billing:window_reset", handleWindowReset);
    unsubscribeWindowResetNotify = bus.on(
      "billing:window_reset",
      handleWindowResetForNotify,
    );
    // Spec 014 (FR-014-4): ночная книга -- третий подписчик канала.
    unsubscribeWindowResetLedger = bus.on(
      "billing:window_reset",
      handleWindowResetForLedger,
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
  if (unsubscribeWindowResetLedger) {
    try {
      unsubscribeWindowResetLedger();
    } catch {}
    unsubscribeWindowResetLedger = null;
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
 * Spec 008 (T1): universal re-adoption of fresh pi/events references from
 * the CURRENT context of a user command (/cont-after-reset). A command
 * handler receives a fresh ExtensionCommandContext per invocation (the
 * runner rebuilds it per call), so the ctx passed to the command is always
 * bound to the live session -- unlike the module-level `piApi`, which was
 * captured by main() / a session-start shift for a possibly replaced
 * session. Adopting the refs here lets the fire path (`p = piApi`) deliver
 * again after a session change WITHOUT a reload.
 *
 * Best-effort: today's real command ctx does not carry api/events fields,
 * so in production this returns false and the bounded waiting path applies;
 * the probe is kept so a future pi exposing the refs lights up automatically
 * (same shapes as sessionBusOf). A no-op when the refs are already current
 * (piApiEpoch === sessionEpoch) -- repeated /cont-after-reset calls in a
 * healthy session must not spam replacement:adopted.
 * Returns true when fresh refs were adopted.
 */
function adoptFreshRefs(ctx: unknown, source: string): boolean {
  if (piApiEpoch === sessionEpoch) return false;
  const fresh = sessionBusOf(null, ctx);
  if (fresh === null) return false;
  eventBus = fresh.bus;
  piApi = fresh.api;
  piApiEpoch = sessionEpoch;
  staleAttempts = 0;
  staleRetryNotBefore = 0;
  armsLog("replacement:adopted", withAttr(source));
  return true;
}

/**
 * pi.on("session_start"): capture ctx, initialize state if missing, run a
 * one-shot checkAndReset() if the saved state is already expired, and
 * arm the absolute wake scheduler from the persisted wake table. Idempotent
 * across reloads: the table is file-backed, ensureWakeTimer() re-reads it.
 */
async function onSessionStart(
  event: unknown,
  ctx: ExtensionContext,
): Promise<void> {
  const incomingKey = sessionKeyOf(ctx);
  // Spec 009 (T1): ключ сессии, для которой стартовал ТЕКУЩИЙ runtime —
  // на КАЖДЫЙ session_start, включая blocked/чужие, строго ДО
  // ownerBlocked-гейта (иначе fire-путь не отличит «refs на другую
  // сессию» от «старта не было» и не сработает switch-маршрутизация).
  lastSessionStartKey = incomingKey;
  const reason = String((event as { reason?: string } | null)?.reason ?? "");
  // Spec 006 (D-608): foreign session-start (repoint + другой session-file
  // key) при живом интересе ВЛАДЕЛЬЦА. КРИТИЧНО строго до `currentCtx = ctx`:
  // currentCtx остаётся ctx владельца, иначе shutdown-гвард
  // (_ctx !== currentCtx) пропустит смерть дочерней сессии и убьёт
  // таймеры/epoch владельца. Здесь НЕ делаем: currentCtx = ctx, НЕ
  // armsSwitchKey(incomingKey), НЕ переснятие piApi/eventBus, НЕ сброс
  // staleAttempts/таймеров по чужому поводу — доставка владельца нетронута.
  // Spec 007 (live 07:38-09:38Z): reload-after-resume chains left the
  // owner's captured ctx DEAD (probe "stale"), and the blocked shift then
  // never happened -- every later session-start with a different key was
  // blocked and the fire could never send (send-error:stale loop). A dead
  // owner ctx means the "live interest" is fictional: the owner session is
  // already replaced, so the shutdown-guard protection is moot. Block ONLY
  // while the owner's captured ctx is alive; a dead ctx lets the shift
  // through so the delivery follows the user's actual conversation.
  // Spec 008 (C2): probe «live» can ALSO be fictional when the captured
  // refs belong to a REPLACED session (main() re-captured piApi for the new
  // session, but ownerKey still points at the old conversation) -- the
  // probe passes because the reference was re-captured for a session that is
  // alive, just not the owner's. Require piApiEpoch === sessionEpoch: when
  // the refs belong to another epoch, the shift must go through and
  // ownerKey must move to the actual conversation (key/arms.json travel
  // together); otherwise they diverge forever.
  const ownerBlocked =
    ownerKey !== null &&
    incomingKey !== ownerKey &&
    remapKey(reason) === "repoint" &&
    hasLiveOwnerInterest() &&
    probePiAlive() === "live" &&
    piApiEpoch === sessionEpoch;
  if (ownerBlocked) {
    armsLog(
      "session-start",
      withAttr(
        `reason=${reason} key=${sessionKeyBase(incomingKey)} armed=${armsIsArmed()} owner-shift(blocked): ${sessionKeyBase(ownerKey as string)}->${sessionKeyBase(incomingKey)}`,
      ),
    );
    // Spec 009 (T1, F1): гейт блокирует только owner-SHIFT, НЕ
    // самопрочинку refs. 1) Adopt свежих ссылок из event/ctx, когда они
    // есть (belt-and-suspenders: сегодняшний event-handler ctx не несёт
    // api/events — в проде это no-op; будущий pi с refs зажжётся
    // автоматически). 2) Сброс staleAttempts/staleRetryNotBefore — после
    // fork/replace-цепочки чистый лист. Лог replacement:adopted ТОЛЬКО
    // когда refs реально изменились (избегать спама на каждый fork).
    // 3) ensureTickerStarted + ensureSyncPoller (C2: ранний return раньше
    // пропускал запуск таймеров/поллера). Инвариант spec 006: ownerKey и
    // currentCtx НЕ меняются — флаг не крадётся; доставка следует за
    // владельцем через T2/F2 switch.
    const blockedFresh = sessionBusOf(event, ctx);
    if (blockedFresh !== null) {
      const refsChanged =
        piApi !== blockedFresh.api || eventBus !== blockedFresh.bus;
      eventBus = blockedFresh.bus;
      piApi = blockedFresh.api;
      piApiEpoch = sessionEpoch;
      staleAttempts = 0;
      staleRetryNotBefore = 0;
      if (refsChanged) {
        armsLog(
          "replacement:adopted",
          withAttr(
            "session_start (blocked) переснял ссылки на pi/events — отправка «продолжи» снова возможна",
          ),
        );
      }
    }
    ensureSyncPoller();
    // Spec 012 (T4): session_start is a scheduler re-arm event even on the
    // blocked path (the wake table is process-global, not session-scoped).
    ensureWakeTimer();
    // Spec 014 (FR-014-5): утренний таймер -- тоже process-global (план
    // живёт вне беседы), перевзводим и на blocked-пути.
    ensureMorningTimer();
    return;
  }

  currentCtx = ctx;
  // Spec 006 (D-601): мгновенная картина сразу после любого session_start.
  probePiAlive();

  // Spec 002 (D-201): after a session replacement the factory may NOT have
  // re-run, so piApi/eventBus may still belong to the replaced session and
  // every send would fail with "extension ctx is stale". Try to re-capture
  // the fresh refs from the session_start event/context; if that fails, we
  // are on the bounded waiting path (replacement:waiting -> capitulation).
  // Spec 008 (T1): session-start keeps its own inline re-capture because the
  // session_start EVENT may also carry the refs (sessionBusOf checks both
  // holders); the /cont-after-reset command path uses adoptFreshRefs(ctx)
  // instead -- a command handler receives no event. The in-flight redraw
  // below stays session-start specific (a delivery may already be in flight
  // for the current reset).
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
        withAttr("session_start переснял ссылки на pi/events — отправка «продолжи» снова возможна"),
      );
      // Spec 006 (D-603 / FR-102): if a delivery is in flight for the
      // current reset (planned & not yet confirmed), force the redraw on
      // the FIRST moment we own fresh refs instead of waiting for the next
      // tick. Safe when in flight: runGuarded's watchdogEvalInFlight guard
      // serializes with any other delivery, and fireContinue re-checks idle
      // + lease (send-gating) internally -- nothing duplicated here.
      const adoptSt = readStateSync();
      if (adoptSt !== null && lastFiredResetAt === adoptSt.lastResetAt) {
        void runGuarded(fireContinue);
      }
    } else {
      armsLog(
        "replacement:waiting",
        withAttr(
          "свежие ссылки не найдены в session_start — жду переусыновления (после 6 попыток капитуляция с уведомлением)",
          { ctx: "epoch-guard", mismatch: true },
        ),
      );
    }
  }

  // Subscribe to our own EventBus channels so we can notify the user when
  // a reset happens (also useful for future "about to reset" hooks).
  subscribeToBillingEvents();

  // Arm the wake scheduler and the status-bar updater FIRST, before any
  // state I/O. If the state bootstrap below throws (e.g. a lock timeout while
  // another pi window holds the lock), pi swallows handler errors -- without
  // this ordering the countdown and reset scheduler would never start in this
  // session until /reload. With timers up first, a bootstrap failure degrades
  // to just a warning and everything keeps running.
  // Spec 012 (T4): re-arm the absolute wake scheduler from the persisted
  // table (survives restarts; the watchdog stays session-scoped).
  ensureWakeTimer();

  // Start the status-bar updater (shows the absolute next-reset time) in
  // TUI mode only. startStatusUpdater itself returns a no-op stopper outside
  // of TUI.
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
      // Window already expired while pi was off. Let the reset machinery
      // reset it -- this also fires billing:window_reset which our listener
      // will pick up and turn into a notify().
      await checkAndReset(buildEmitFn(), historyMetaOf(ctx));
    }
    // Refresh the status bar after a possible reset so the footer shows
    // the new absolute next-reset time right away.
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
      // Spec 014 (design §8): /new унёс разговор (и флаг) -- если активный
      // план страховал прежний ключ, запоминаем carry-ключ: инвариант
      // продолжит страховать унесённый ключ, план не перезаписываем.
      const prevKey = armsGetKey();
      if (
        prevKey !== null &&
        prevKey !== key &&
        activePlanForKey(prevKey) !== null
      ) {
        nightPlanCarryKey = key;
        armsLog(
          "night-plan:carry",
          withAttr(
            `план следует за сессией: ${sessionKeyBase(prevKey)} -> ${sessionKeyBase(key)}`,
          ),
        );
      }
      await armsCarryArmTo(key);
    } else {
      armsSwitchKey(key);
    }
    // Always run the sync-poller: the arm can be (re)created at any time by
    // an external writer (night-agent helper scripts/arm_cont_after_reset.py),
    // and a live sync-poller is what notices and re-arms the watchdog.
    ensureSyncPoller();
    // Spec 014 (FR-014-5): session_start владельца -- перевзвод утреннего
    // таймера плана (wall-clock, unref).
    ensureMorningTimer();
    refreshMarker();
  } catch (err) {
    console.warn("pi-billing-window: arms session init failed:", err);
  }
  // Spec 006 (D-607): неблокированный session-start принимает владельца.
  // ownerKey обновляется на первом старте (null), совпадающем ключе и
  // carry-причине; owner-shift: <old>-><new> только когда ключ реально сменился.
  const prevOwner = ownerKey;
  ownerKey = incomingKey;
  const ownerShift =
    prevOwner !== null && prevOwner !== incomingKey
      ? ` owner-shift: ${sessionKeyBase(prevOwner)}->${sessionKeyBase(incomingKey)}`
      : "";
  armsLog(
    "session-start",
    withAttr(`reason=${String((event as { reason?: string } | null)?.reason ?? "?")} key=${armsGetKey()?.split(/[\\/]/).pop() ?? "?"} armed=${armsIsArmed()}${ownerShift}`),
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
  // Spec 007: do NOT re-point to a foreign session (subagent) -- its
  // wormsoft responses (INCLUDING 429) must not steal the owner ctx; a
  // repoint here made window_reset notifies and sends land in the foreign
  // session (the 2026-09-28 incident). Same-key or no owner yet -> repoint.
  const respKey = sessionKeyOf(ctx);
  if (ownerKey === null || (respKey === ownerKey && !respKey.startsWith("ephemeral:"))) {
    currentCtx = ctx;
  }

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
    // Spec 015 (FR-015-4): ночная задача на 429 НЕ считается выполненной —
    // paused с причиной 429, cursor сохраняется; re-drive на новом окне.
    const nr429 = readNightRunState();
    if (nr429 !== null && nr429.status === "awaiting-result") {
      await applyTaskResult("429");
      armsLog(
        "night-run:429",
        withAttr(`задача ${nr429.currentTask} сохранена, runner в paused (429)`),
      );
    }
    return;
  }

  // Only successful responses count towards the limit.
  if (event.status >= 400) return;

  const emit = buildEmitFn();
  const timestamp = Date.now();

  // Spec 014 (FR-014-4): usage читается ОДИН раз -- аккумуляция токенов
  // окна в State и history-строка используют один и тот же снимок.
  const usage = lastAssistantUsage(ctx);

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
      // Spec 014 (FR-014-4): аккумулируемые токены окна (обнуляются на
      // reset в reset.ts; ночная книга читает их через prevWindow*).
      windowInput: (cur.windowInput ?? 0) + (usage?.input ?? 0),
      windowOutput: (cur.windowOutput ?? 0) + (usage?.output ?? 0),
      windowCacheRead: (cur.windowCacheRead ?? 0) + (usage?.cacheRead ?? 0),
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
  //
  // Spec 007 (D2): confirm ONLY for a real (token-bearing) response IN the
  // owner conversation, after the send this arm waits for. A foreign
  // subagent's flash responses and 0-token background calls (title
  // generation, retry probes) must NOT confirm the arm -- in the 2026-09-28
  // incident a 0/0-token glm-5.3-flash call in the foreign session consumed
  // the arm while the owner chat had received nothing.
  const respKey2 = sessionKeyOf(ctx);
  const confirmEligible =
    ownerKey !== null &&
    respKey2 === ownerKey &&
    !respKey2.startsWith("ephemeral:") &&
    pendingFiredResetAt !== null &&
    isTokenBearing(usage);
  const armState = readStateSync();
  const confirmed = confirmEligible
    ? await armsConfirmSuccess(Date.now(), {
        lastResetAt: armState?.lastResetAt,
      })
    : false;
  if (confirmed) {
    // Spec 006 (D-604): fire:confirmed — release-точка аренды. Освобождаем
    // и сброс подтверждения, и сброс последней отправки (могут разойтись при
    // долгой доставке между двумя сбросами окна).
    releaseFireForReset(armState?.lastResetAt ?? 0);
    releaseFireForReset(pendingFiredResetAt ?? 0);
    // Spec 002 (D-203): a repeat re-arm waits for the NEXT reset; give the
    // dedup marker a fresh window.
    lastFiredResetAt = null;
    // Spec 005: confirmation clears the pending-send marker (FR3) so a
    // freshly re-armed repeat flag starts from a clean slate.
    pendingFiredResetAt = null;
    armsLog("fire:confirmed", withAttr("успешный ответ после «продолжи» — флаг снят/перевзведён"));
    // Spec 011 (D3, FR-011-3): бюджет автопродолжений — сообщить пользователю
    // до того, как флаг сгорит. armsGetArm() после confirmSuccess: перевзведённая
    // запись (repeat-1) либо null (одноразовый флаг снят).
    const remaining = armsGetArm()?.repeat ?? 0;
    if (remaining === 0) {
      // FR-011-4: исчерпание подтверждением — arm-gone-notify (D1) подавляем,
      // это уведомление уже сообщает пользователю об исчерпании.
      selfArmGoneKind = "confirmed-exhausted";
    }
    void sendNotify({
      type: "billing:cont-after-reset-confirmed",
      provider: PROVIDER,
      title: remaining > 0
        ? `cont-after-reset: продолжи доставлен (осталось ${remaining})`
        : "cont-after-reset: продолжи доставлен (автопродолжения исчерпаны)",
      body: remaining > 0
        ? `«продолжи» доставлен и подтверждён. Осталось автопродолжений: ${remaining}.`
        : `«продолжи» доставлен и подтверждён. Автопродолжения исчерпаны — флаг снят. Для продолжения взведите снова: /cont-after-reset N.`,
      timestamp: Date.now(),
    });
    // Re-arm the watchdog for the next boundary (repeat>1) or drop it
    // (the one-shot arm was removed by confirmSuccess).
    syncWatchdog();
  }

  if (firstCallJustEmitted) {
    // Spec 012 (T4, FR-012-6): auto-init the wake table from the fresh
    // anchor (state.firstCallEmittedAt). The anchor point = anchor +
    // windowMs + WAKE_MARGIN_MS; R1 epsilon, tail top-up and depth
    // truncation live in appendAnchorPoint (TD-004 op 2). Passive: a lock
    // skip (ELOCKED) is quiet -- the next anchor/tick repeats it.
    const anchorState = readStateSync();
    const anchor = anchorState?.firstCallEmittedAt ?? timestamp;
    const anchorWinMs = anchorState?.windowMs ?? WINDOW_MS;
    await mutateWakeTable((cur) => ({
      next: {
        ...appendAnchorPoint(
          cur ?? {
            version: 1,
            points: [],
            updatedAt: Date.now(),
            source: "firstCall",
          },
          anchor,
          anchorWinMs,
        ),
        // The table's latest rebuild origin is now a firstCall anchor.
        source: "firstCall",
      },
    }));
    ensureWakeTimer();
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
    usage,
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

  // Spec 015 (design §6): если ночной runner ждёт результат — ищем явный
  // маркер TASK_RESULT в последнем ответе. Обычный текст НЕ считается PASS.
  await nightRunObserveResult(ctx);
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
 * pi.on("session_shutdown"): tear down the wake scheduler, EventBus subscriptions, and
 * status updater. Re-runs cleanly on quit / reload / new / resume / fork.
 */
function onSessionShutdown(_event: unknown, _ctx: ExtensionContext): void {
  // Race guard: a late shutdown for an already-replaced session must not
  // tear down the new session's freshly restarted poller.
  if (_ctx && currentCtx && _ctx !== currentCtx) return;
  // Bump the epoch FIRST so deferred code still holding old-session refs
  // aborts instead of touching them (stale pi -> runtime error).
  sessionEpoch++;
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
        ctx.ui.notify(
          `pi-billing-window: state не инициализирован (v=${VERSION})`,
          "info",
        );
        return;
      }
      // Spec 014 (FR-014-6): version stamp в /billing-status.
      // Spec 017 (FR-017-12): строка пинг-зонда в /billing-status.
      const p = s.ping ?? {};
      const pingOn = p.disabled !== true;
      let pingInfo = `ping=${pingOn ? "on" : "off"}`;
      if (pingOn) {
        if (p.lastAt !== undefined) {
          const d = new Date(p.lastAt);
          pingInfo += ` (${p.lastStatus ?? "?"} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}, ${p.mode ?? "?"})`;
        } else {
          pingInfo += ` (ещё не было, ${p.model ?? PING_MODEL})`;
        }
      }
      const resetAt = s.windowStartedAt + s.windowMs;
      const d = new Date(resetAt);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      ctx.ui.notify(
        `${s.provider}: обновится в ${hh}:${mm} (calls=${s.callsInWindow}, resets=${s.resetCount}) ${pingInfo} v=${VERSION}`,
        "info",
      );
    },
  });
}

/**
 * /ping-wormsoft -- spec 017 (FR-017-9): ручной диагностический пинг.
 * НЕ трогает состояние окна: без reset, без якорей, без last429At;
 * пишет history kind="ping" note="manual" и кэширует рабочий mode/model.
 */
function registerPingWormsoft(pi: ExtensionAPI): void {
  pi.registerCommand("ping-wormsoft", {
    description: "Ручной пинг wormsoft: проверить лимит (диагностика)",
    handler: async (_args, ctx) => {
      const res = await manualPing(historyMetaOf(ctx));
      if (res.kind === "ok") {
        const u = res.usage;
        const tok = u
          ? `, ${u.input ?? 0}+${u.output ?? 0} ток`
          : "";
        ctx.ui.notify(
          `Пинг wormsoft: 200 OK — лимит есть, окно переворачивалось/активно. ${res.latencyMs} мс${tok} (${res.model}, ${res.mode})`,
          "info",
        );
      } else if (res.kind === "limit") {
        ctx.ui.notify(
          `Пинг wormsoft: 429 — лимит текущего окна исчерпан (${res.latencyMs} мс)`,
          "info",
        );
      } else {
        ctx.ui.notify(
          `Пинг wormsoft: ошибка транспорта — ${res.error}`,
          "info",
        );
      }
    },
  });
}

/**
 * /billing-ping -- spec 017 (FR-017-10): on|off|status для пинг-зонда.
 * off = точное legacy-поведение слепого reset на границах.
 */
function registerBillingPing(pi: ExtensionAPI): void {
  pi.registerCommand("billing-ping", {
    description: "Пинг-зонд границ окна: on | off | status",
    handler: async (args, ctx) => {
      const arg = String(args ?? "").trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        await setPingDisabled(arg === "off");
        ctx.ui.notify(
          arg === "off"
            ? "Пинг-зонд ВЫКЛЮЧЕН: границы окна сбрасываются вслепую (поведение до spec 017)"
            : "Пинг-зонд включён: reset границ подтверждается пингом",
          "info",
        );
        return;
      }
      const p = readPingState();
      const parts: string[] = [
        p.disabled === true
          ? "пинг-зонд: ВЫКЛЮЧЕН (слепой reset на границах)"
          : "пинг-зонд: включён",
      ];
      if (p.mode !== undefined) parts.push(`режим ${p.mode}`);
      parts.push(`модель ${p.model ?? PING_MODEL}`);
      if (p.lastAt !== undefined) {
        const d = new Date(p.lastAt);
        parts.push(
          `последний: ${p.lastStatus ?? "?"} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} (${p.lastDetail ?? ""})`,
        );
      }
      if ((p.retryAttempt ?? 0) > 0) parts.push(`429-retry попытка ${p.retryAttempt}`);
      if ((p.infraStreak ?? 0) > 0) parts.push(`infra подряд: ${p.infraStreak}`);
      ctx.ui.notify(parts.join("; "), "info");
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
          // Spec 014 (FR-014-4): итоги окна -- в prev*, аккумуляторы -- в 0.
          windowInput: 0,
          windowOutput: 0,
          windowCacheRead: 0,
          prevWindowCalls: cur.callsInWindow,
          prevWindowInput: cur.windowInput ?? 0,
          prevWindowOutput: cur.windowOutput ?? 0,
          prevWindowCacheRead: cur.windowCacheRead ?? 0,
          // Spec 015-fix: начало завершившегося окна — в payload ledger.
          prevWindowStartedAt: cur.windowStartedAt,
        };
        return { next };
      });
      ctx.ui.notify("Окно сброшено вручную", "info");

      // Spec 012 (FR-012-5): a manual reset clears the wake grid -- the next
      // wake point comes from the next firstCall anchor (or the boundary
      // ping). Stale old-grid points must not fire later.
      await mutateWakeTable(() => ({
        next: { version: 1, points: [], updatedAt: Date.now(), source: "settimer" },
      }));
      ensureWakeTimer();

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
      // Spec 015-fix: прямой путь ledger — ручной сброс тоже не зависит
      // от живой подписки (дубль отсечён идемпотентностью).
      if (fresh) {
        void nightPlanLedgerRow(fresh);
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
              // Spec 014 (FR-014-4): итоги окна -- в prev*, аккумуляторы -- в 0.
              windowInput: 0,
              windowOutput: 0,
              windowCacheRead: 0,
              prevWindowCalls: cur.callsInWindow,
              prevWindowInput: cur.windowInput ?? 0,
              prevWindowOutput: cur.windowOutput ?? 0,
              prevWindowCacheRead: cur.windowCacheRead ?? 0,
              // Spec 015-fix: начало завершившегося окна — в payload ledger.
              prevWindowStartedAt: cur.windowStartedAt,
            },
          };
        });
        const fresh = readStateSync();
        if (eventBus && fresh) {
          try {
            eventBus.emit("billing:window_reset", fresh);
          } catch {}
        }
        // Spec 015-fix: прямой путь ledger (дубль отсечён идемпотентностью).
        if (fresh) {
          void nightPlanLedgerRow(fresh);
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
        // Spec 012 (FR-012-5): a manual reset clears the wake grid -- the
        // next wake point comes from the next firstCall anchor (or the
        // boundary ping). Stale old-grid points must not fire later.
        await mutateWakeTable(() => ({
          next: { version: 1, points: [], updatedAt: Date.now(), source: "settimer" },
        }));
      } else {
        // Sync the countdown to the given remaining time: pick a
        // windowStartedAt that leaves durationMs of life in the window.
        // We deliberately do NOT touch lastResetAt here, so a future
        // auto-reset is not suppressed by checkAndReset()'s dedup logic.
        //
        // 2026-10 drift fix: the user's sync is GROUND TRUTH for the provider
        // boundary, so the lazy anchor (firstCallEmittedAt) is set to the
        // same targetStartedAt. checkAndReset / watchdog / indicator all
        // compute the boundary as max(windowStartedAt, firstCallEmittedAt) +
        // windowMs -- without this, the next real call would re-anchor at
        // its own timestamp and override the user's correction, and the
        // plugin would keep resetting (2h - N) minutes early.
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
                firstCallEmittedAt: targetStartedAt,
              },
            };
          }
          return {
            next: {
              ...cur,
              windowStartedAt: targetStartedAt,
              resetCount: cur.resetCount + 1,
              callsInWindow: 0,
              firstCallEmittedAt: targetStartedAt,
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
        // Spec 012 (FR-012-5, 2026-10 drift fix): rebuild the wake grid from
        // the user-synced anchor -- first point = now + N + margin, tail =
        // +windowMs steps (same full grid as an auto anchor, R2). Without
        // the rebuild the wake points kept firing on the OLD grid, (2h - N)
        // minutes away from the synced boundary.
        await mutateWakeTable(() => ({
          next: computeTableFromAnchor(
            targetStartedAt,
            windowMs,
            WAKE_MARGIN_MS,
            WAKE_DEPTH,
            "settimer",
          ),
        }));
      }

      // The watchdog must track the (possibly moved) window boundary: resync
      // after the state mutation in BOTH branches (0 = reset, sync = shift).
      // The wake scheduler is re-armed from the rebuilt/cleared table too.
      ensureWakeTimer();
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
 * /pbr-reload -- self-reload of the extension module via ctx.reload()
 * (session.reload(), session_start reason="reload"). Useful for ops (pick up
 * freshly deployed extension code without killing the session) and for live
 * scenario B2 (spec 006 T-14): arm -> reload BEFORE the boundary -> delivery
 * AFTER session-start(reload) with exactly one fire per reset (D-604 dedup).
 * The captured ctx becomes stale after await ctx.reload() -- the handler
 * must not touch it afterwards (docs: Session replacement lifecycle).
 */
function registerSelfReload(pi: ExtensionAPI): void {
  pi.registerCommand("pbr-reload", {
    description:
      "Перезагрузить расширение pi-billing-window (новый модуль, тот же session-file)",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Перезагрузка расширения pi-billing-window…", "info");
      await ctx.reload();
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
        // Spec 006 (D-607 iv): /cont-after-reset сознательно привязывает
        // владельца к активному conversation.
        ownerKey = key;
        armsSwitchKey(key);

        // Spec 008 (T1): the command receives a FRESH ctx on every invocation
        // -- this is the universal recovery after a session change without a
        // reload. When the module-level piApi/eventBus still belong to a
        // replaced session, adopt the fresh refs so the fire path (`p =
        // piApi`) can deliver again; a no-op while the refs are current.
        adoptFreshRefs(
          ctx,
          "/cont-after-reset переснял ссылки на pi/events из свежего ctx — отправка «продолжи» снова возможна",
        );

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
          // Spec 011 (D1, FR-011-4): снятие флага по команде пользователя —
          // само-снятие: arm-gone-notify не нужен (действие инициировал сам
          // пользователь, ответ уже есть в ctx.ui.notify).
          selfArmGoneKind = "off";
          const removed = await armsDisarm();
          // Spec 005: снятие флага снимает и маркер последней отправки.
          pendingFiredResetAt = null;
          // Spec 006 (D-604): ручное снятие флага (disarm) — release-точка
          // аренды сброса (флаг снят, «продолжи» больше не имеет смысла).
          releaseFireForReset(readStateSync()?.lastResetAt ?? 0);
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

// --- Spec 014: night plan (ночной контракт страховки ночной сессии) -------------

/**
 * Spec 014 (§12): injectable notify-транспорт ночи — тесты перехватывают
 * rearm/uninsured/report без реального HTTP; в проде — sendNotify.
 */
type NightNotifyPayload = Extract<
  NotifyPayload,
  {
    type:
      | "billing:night-plan-rearm"
      | "billing:night-plan-uninsured"
      | "billing:night-report";
  }
>;

let nightNotifyHook: ((p: NightNotifyPayload) => void) | null = null;

/** fire-and-forget notify ночи (хук тестов или sendNotify, никогда не бросает). */
function nightNotify(p: NightNotifyPayload): void {
  if (nightNotifyHook !== null) {
    try {
      nightNotifyHook(p);
    } catch {}
    return;
  }
  void sendNotify(p);
}

/** Rate-limit notify night-plan-uninsured (память процесса, design §5.2). */
let uninsuredNotifyRateMs = 10 * 60_000;
/** Порог «флаг снят снова»: перевзвод чаще — escalate (FR-014-3). */
let rearmRepeatEscalateMs = 30 * 60_000;
/** Сгоревший утренний таймер: тишина после to + N минут (§8 edge). */
let morningGraceMs = 30 * 60_000;

/** Spec 014 (§8): carry-ключ плана — куда /new унёс разговор этой ночи. */
let nightPlanCarryKey: string | null = null;

/** Пейсинг инварианта и эскалации по ключу плана (память процесса). */
const lastAutoRearmAt = new Map<string, number>();
const lastUninsuredNotifyAt = new Map<string, number>();

/** In-memory счётчики ночи для утреннего отчёта (§7). */
const nightStats = {
  nightDate: null as string | null,
  rearm: 0,
  uninsured: 0,
};

function bumpNightStats(plan: NightPlan, kind: "rearm" | "uninsured"): void {
  if (nightStats.nightDate !== plan.nightDate) {
    nightStats.nightDate = plan.nightDate;
    nightStats.rearm = 0;
    nightStats.uninsured = 0;
  }
  nightStats[kind]++;
}

/**
 * Живой план, чьё страхование связано с ключом key: план есть, не истёк,
 * интервал идёт, key — это plan.key или carry-ключ (§8). null — нет/чужой.
 * O(1) файловое чтение; используется инвариантом и гашением arm-gone.
 */
function activePlanForKey(key: string | null): NightPlan | null {
  if (key === null) return null;
  const plan = readPlan();
  if (plan === null) return null;
  const now = Date.now();
  if (now > plan.expiresAt) return null;
  if (!inInterval(now, plan.fromLocal, plan.toLocal)) return null;
  if (key !== plan.key && key !== nightPlanCarryKey) return null;
  return plan;
}

/**
 * Инвариант страховки (FR-014-2, design §5.1): на каждом sync-тике при
 * живом плане и незастрахованном ключе — auto-rearm (arm + armslog +
 * notify). Неудача arm() или слишком частый перевзвод — escalate
 * night-plan-uninsured с rate-limit (§5.2). Никогда не бросает наружу
 * (NFR-014-2); все тайминги — параметры (тест-хуки ниже, NFR-014-1).
 */
async function nightPlanTick(): Promise<void> {
  try {
    const plan = readPlan();
    if (plan === null) return;
    const now = Date.now();
    if (now > plan.expiresAt) return;
    if (!inInterval(now, plan.fromLocal, plan.toLocal)) return;
    const curKey = armsGetKey();
    if (curKey === null) return;

    // Застрахован ли план: флаг под plan.key или (carry-случай §8) под
    // текущим ключом этого процесса.
    const armPlan = armsGetArmForKey(plan.key);
    const armHere = curKey === plan.key ? armPlan : armsGetArmForKey(curKey);
    if (armPlan !== null || armHere !== null) {
      // Страховка жива — сбросить escalate-состояние (design §5.1 п.3).
      lastUninsuredNotifyAt.delete(plan.key);
      return;
    }

    // Owner-guard (NFR-014-4, паттерн D-607/D-608): перевзводит ТОЛЬКО
    // процесс, показывающий разговор плана (или его carry-наследника).
    // Чужие процессы — только наблюдение, без мутаций.
    const isOwner = curKey === plan.key || curKey === nightPlanCarryKey;
    if (!isOwner) return;

    const prevRearm = lastAutoRearmAt.get(plan.key);
    lastAutoRearmAt.set(plan.key, now);

    const st = readStateSync();
    let armedOk = false;
    try {
      const rec = await armsArm(st?.lastResetAt ?? 0, now, plan.repeat);
      armedOk = rec !== null;
      // TTL флага — до конца плана (FR-014-2): arm() сам даёт 8 ч,
      // extendArmTtl добирает остаток (никогда не укорачивает).
      if (armedOk && plan.expiresAt - now > ARMS_TTL_MS) {
        await armsExtendArmTtl(curKey, plan.expiresAt - now, now);
      }
    } catch (err) {
      armedOk = false;
      armsLog(
        "night-plan:auto-rearm-error",
        withAttr(String((err as Error)?.message ?? err).slice(0, 160)),
      );
    }

    if (armedOk) {
      bumpNightStats(plan, "rearm");
      armsLog(
        "night-plan:auto-rearm",
        withAttr(
          `auto-rearm:from-plan repeat=${plan.repeat} ${plan.fromLocal}-${plan.toLocal} night=${plan.nightDate}`,
        ),
      );
      nightNotify({
        type: "billing:night-plan-rearm",
        provider: PROVIDER,
        title: "night plan: флаг восстановлен автоматически",
        body: `План ${plan.fromLocal}–${plan.toLocal}: снятый флаг cont-after-reset перевзведён (repeat=${plan.repeat}). Ночь застрахована.`,
        timestamp: now,
      });
      // FR-014-3: флаг снят снова и перевзводится чаще порога — escalate.
      if (prevRearm !== undefined && now - prevRearm < rearmRepeatEscalateMs) {
        nightPlanEscalate(
          plan,
          `флаг снят снова в интервале плана (перевзвод чаще ${Math.round(rearmRepeatEscalateMs / 60_000)} мин)`,
        );
      }
      // Свежий флаг — пересинхронизировать watchdog/маркер под него.
      syncWatchdog();
      refreshMarker();
    } else {
      nightPlanEscalate(
        plan,
        "arm() не смог восстановить флаг (lock/ошибка записи arms.json)",
      );
    }
  } catch (err) {
    console.warn("pi-billing-window: night-plan tick failed:", err);
  }
}

/**
 * Escalate (FR-014-3): armslog night-plan:uninsured на КАЖДОМ событии
 * (полный лог, без пейсинга), notify billing:night-plan-uninsured —
 * rate-limited (по умолчанию 10 мин), пока план активен и ключ
 * незастрахован. Память процесса — новых файлов нет (design §2).
 */
function nightPlanEscalate(plan: NightPlan, reason: string): void {
  const now = Date.now();
  bumpNightStats(plan, "uninsured");
  armsLog("night-plan:uninsured", withAttr(`${reason} night=${plan.nightDate}`));
  const last = lastUninsuredNotifyAt.get(plan.key) ?? 0;
  if (now - last < uninsuredNotifyRateMs) return;
  lastUninsuredNotifyAt.set(plan.key, now);
  nightNotify({
    type: "billing:night-plan-uninsured",
    provider: PROVIDER,
    title: "night plan: ночь НЕ застрахована",
    body: `План ${plan.fromLocal}–${plan.toLocal}: ${reason}. Проверь arms.json/сессию вручную (/cont-after-reset N или /night-plan off).`,
    timestamp: now,
  });
}

// --- Spec 014: утренний отчёт (wall-clock таймер, FR-014-5) ---------------------

let morningTimer: ReturnType<typeof setTimeout> | null = null;
let morningScheduledFor: number | null = null;
/** `${key}@${nightDate}` последнего сгенерированного отчёта (анти-дубликат). */
let morningDoneKey: string | null = null;
let warnedMorningOnce = false;

function clearMorningTimer(): void {
  if (morningTimer !== null) {
    clearTimeout(morningTimer);
    morningTimer = null;
  }
  morningScheduledFor = null;
}

/**
 * Взвести one-shot wall-clock таймер на ближайший toLocal активного плана
 * (unref, перевзвод на каждом sync-тике и session_start; watchdog.ts
 * паттерн: cancel-before-arm, delay = max(0, when - now)). Мёртвый/чужой
 * план — тихо снять. Таймер НЕ останавливается на session_shutdown:
 * он план-скоуп, не сессия-скоуп (пишет только файлы + notify).
 */
function ensureMorningTimer(): void {
  try {
    const plan = readPlan();
    if (plan === null || Date.now() > plan.expiresAt) {
      clearMorningTimer();
      return;
    }
    const now = Date.now();
    const when = nextOccurrence(now, plan.toLocal);
    if (when === null) {
      clearMorningTimer();
      return;
    }
    if (morningTimer !== null && morningScheduledFor === when) return;
    clearMorningTimer();
    morningScheduledFor = when;
    morningTimer = setTimeout(() => {
      morningTimer = null;
      morningScheduledFor = null;
      void runGuarded(fireMorningReport);
    }, Math.max(0, when - now));
    morningTimer.unref();
  } catch {
    // quiet (NFR-014-2)
  }
}

/**
 * Сгенерировать утренний отчёт (FR-014-5): nights/report-<nightDate>.md
 * (ledger + history.csv, version в шапке — «ночь работала на коде N») +
 * notify billing:night-report с 2-строчным дайджестом. Сгоревший таймер
 * (машина спала: now > to + morningGraceMs) тихо гасится (design §8),
 * книга ночи доступна через /night-plan status. Никогда не бросает.
 */
async function fireMorningReport(): Promise<void> {
  try {
    const plan = readPlan();
    if (plan === null || Date.now() > plan.expiresAt) return;
    const now = Date.now();
    const recentTo = previousOccurrence(now, plan.toLocal);
    if (recentTo === null || now - recentTo > morningGraceMs) {
      morningDoneKey = `${plan.key}@${plan.nightDate}`;
      armsLog(
        "night-plan:morning-report",
        withAttr(
          "сгоревший таймер (машина спала?) — отчёт пропущен, книга ночи доступна через /night-plan status",
        ),
      );
      return;
    }
    const doneKey = `${plan.key}@${plan.nightDate}`;
    if (morningDoneKey === doneKey) return;
    const ledgerRows = readLedger(plan.nightDate);
    const historyRows = readHistoryRows(plan.createdAt, now);
    // Spec 015-fix: книга пуста, но сбросы в history есть — считаем окна
    // по fallback, чтобы armslog/notify не врали «0 из 0» (инцидент 25→26.10).
    const fallbackRows =
      ledgerRows.length === 0
        ? fallbackWindowsFromHistory(plan, historyRows)
        : [];
    const effRows = ledgerRows.length > 0 ? ledgerRows : fallbackRows;
    const ledgerIncomplete = ledgerRows.length === 0 && fallbackRows.length > 0;
    const md = buildMorningReport(plan, ledgerRows, historyRows, {
      version: VERSION,
      nowMs: now,
      rearmCount: nightStats.nightDate === plan.nightDate ? nightStats.rearm : 0,
      uninsuredCount:
        nightStats.nightDate === plan.nightDate ? nightStats.uninsured : 0,
    });
    const file = reportPathFor(plan.nightDate);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, md, "utf8");
    morningDoneKey = doneKey;
    const used = effRows.filter((r) => r.verdict === "used").length;
    const idle = effRows.length - used;
    const totIn = effRows.reduce((s, r) => s + r.input, 0);
    armsLog(
      "night-plan:morning-report",
      withAttr(
        `отчёт записан: ${file} (окон ${effRows.length}, used ${used}, idle ${idle}` +
          `${ledgerIncomplete ? "; LEDGER INCOMPLETE — восстановлено из history.csv" : ""})`,
      ),
    );
    nightNotify({
      type: "billing:night-report",
      provider: PROVIDER,
      title: `Ночь ${plan.nightDate}: использовано окон ${used}/${effRows.length}` +
        `${ledgerIncomplete ? " (LEDGER INCOMPLETE)" : ""}`,
      body: `Простаивало: ${idle}. Input за ночь: ${totIn}. auto-rearm: ${
        nightStats.nightDate === plan.nightDate ? nightStats.rearm : 0
      }. Полный отчёт: ${file}`,
      timestamp: now,
    });
  } catch (err) {
    if (!warnedMorningOnce) {
      warnedMorningOnce = true;
      console.warn("pi-billing-window: morning report failed:", err);
    }
  }
}

// --- Spec 014: ночная книга (подписчик billing:window_reset, FR-014-4) ----------

/**
 * Строку книги пишет процесс, выполнивший сброс: он же единственный
 * эмиттер billing:window_reset на своей шине (checkAndReset дедупится по
 * lastResetAt), и именно у него в payload — итоги завершившегося окна
 * (prevWindow*, аккумулируемые в State). Сброс ИЛИ начало окна вне
 * интервала плана — строка не пишется. Никогда не бросает наружу.
 */
const handleWindowResetForLedger = (payload: unknown): void => {
  void nightPlanLedgerRow(payload);
};

async function nightPlanLedgerRow(payload: unknown): Promise<void> {
  try {
    const plan = readPlan();
    if (plan === null) return;
    const now = Date.now();
    if (now > plan.expiresAt) return;
    const p = payload as Partial<State> | null;
    const resetAt =
      typeof p?.lastResetAt === "number" && p.lastResetAt > 0
        ? p.lastResetAt
        : now;
    const startedAt =
      typeof p?.windowStartedAt === "number" ? p.windowStartedAt : resetAt;
    const resetIn = inInterval(resetAt, plan.fromLocal, plan.toLocal);
    const startedIn = inInterval(startedAt, plan.fromLocal, plan.toLocal);
    if (!resetIn && !startedIn) return;
    const calls = p?.prevWindowCalls ?? 0;
    // armPhase: свежий arm не имеет поля phase (оно появляется после
    // markFired) — семантика design §6: undefined => "armed".
    const armRec = armsGetArmForKey(plan.key);
    const row: LedgerRow = {
      tsIso: isoLocal(new Date(now)),
      epochMs: now,
      nightDate: plan.nightDate,
      resetAt,
      callsInWindow: calls,
      input: p?.prevWindowInput ?? 0,
      output: p?.prevWindowOutput ?? 0,
      cacheRead: p?.prevWindowCacheRead ?? 0,
      armPhase: armRec === null ? "none" : (armRec.phase ?? "armed"),
      verdict: calls > 0 ? "used" : "idle",
      // Spec 015-fix: идемпотентность + диагностика.
      resetCount: typeof p?.resetCount === "number" ? p.resetCount : -1,
      prevWindowStartedAt:
        typeof p?.prevWindowStartedAt === "number"
          ? p.prevWindowStartedAt
          : startedAt,
    };
    const status = await appendLedger(row);
    if (status === "error") {
      armsLog(
        "night-plan:ledger-error",
        withAttr(
          `строка книги не записана (reset ${isoLocal(new Date(resetAt))}, nightDate ${plan.nightDate}) — сброс и доставка НЕ затронуты, см. warn выше`,
        ),
      );
    }
  } catch (err) {
    console.warn("pi-billing-window: night ledger append failed:", err);
    armsLog(
      "night-plan:ledger-error",
      withAttr(
        `сбор строки книги не удался: ${String((err as Error)?.message ?? err).slice(0, 160)}`,
      ),
    );
  }
}

// --- Spec 014: тест-хуки (design §11) -------------------------------------------

/** Инвариант вручную — детерминизм без 60-с тика. */
export function __nightPlanTickForTests(): Promise<void> {
  return nightPlanTick();
}

/** Утренний отчёт вручную — без wall-clock ожидания toLocal. */
export function __fireMorningForTests(): Promise<void> {
  return fireMorningReport();
}

/** Перехватить ночные notify (rearm/uninsured/report) в тестах; null — проде. */
export function __setNightPlanNotifyForTests(
  fn: ((p: NightNotifyPayload) => void) | null,
): void {
  nightNotifyHook = fn;
}

/** Параметры пейсинга эскалации (прод-значения: 10 мин / 30 мин). */
export function setNightPlanEscalateForTests(
  notifyRateMs: number,
  repeatEscalateMs: number,
): void {
  uninsuredNotifyRateMs = notifyRateMs;
  rearmRepeatEscalateMs = repeatEscalateMs;
}

/** Grace сгоревшего утреннего таймера (прод-значение: 30 мин). */
export function setNightPlanMorningGraceForTests(ms: number): void {
  morningGraceMs = ms;
}

/** Сброс in-memory состояния ночи между тестами. */
export function __resetNightPlanStateForTests(): void {
  lastAutoRearmAt.clear();
  lastUninsuredNotifyAt.clear();
  nightPlanCarryKey = null;
  nightStats.nightDate = null;
  nightStats.rearm = 0;
  nightStats.uninsured = 0;
  morningDoneKey = null;
  warnedMorningOnce = false;
  clearMorningTimer();
  nightNotifyHook = null;
  uninsuredNotifyRateMs = 10 * 60_000;
  rearmRepeatEscalateMs = 30 * 60_000;
  morningGraceMs = 30 * 60_000;
}

/**
 * /night-plan — ночной контракт (spec 014, FR-014-1): создать/обновить план
 * на текущую ночь для текущей беседы. План живёт ВНЕ беседы: переживает
 * дисарм агента; инвариант на sync-тике перевзвёлит флаг по мере
 * необходимости, в toLocal приходит утренний отчёт, в toLocal+1ч план
 * истекает. Взвод плана НЕ взводит флаг cont-after-reset сам.
 *   /night-plan                              — 22:00-08:00, repeat=6
 *   /night-plan 22:00-08:00 repeat=3 backlog=C:/tasks/night.md
 *   /night-plan off                          — снять досрочно
 *   /night-plan status                       — план/флаг/книга ночи
 */
function registerNightPlan(pi: ExtensionAPI): void {
  pi.registerCommand("night-plan", {
    description:
      "Ночной план: авто-перевзвод cont-after-reset в интервале (default 22:00-08:00), ночная книга и утренний отчёт. 'off' — снять, 'status' — показать.",
    handler: async (args, ctx) => {
      try {
        const argv = String(args ?? "")
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        const sub = argv[0]?.toLowerCase();

        if (sub === "off") {
          const removed = await clearPlan();
          clearMorningTimer();
          lastAutoRearmAt.clear();
          lastUninsuredNotifyAt.clear();
          nightPlanCarryKey = null;
          armsLog(
            "night-plan:off",
            withAttr(removed ? "план снят командой" : "плана не было (no-op)"),
          );
          ctx.ui.notify(
            removed
              ? "night plan: план снят (инвариант больше не перевзводит флаг)"
              : "night plan: активного плана не было",
            "info",
          );
          return;
        }

        if (sub === "status") {
          const plan = readPlan();
          if (plan === null) {
            ctx.ui.notify(
              "night plan: плана нет. /night-plan [HH:MM-HH:MM] [repeat=N] [backlog=<path>]",
              "info",
            );
            return;
          }
          const now = Date.now();
          const active = now <= plan.expiresAt;
          const inInt = active && inInterval(now, plan.fromLocal, plan.toLocal);
          const arm = armsGetArmForKey(plan.key);
          const nights = readLedger(plan.nightDate);
          const used = nights.filter((r) => r.verdict === "used").length;
          ctx.ui.notify(
            `night plan: ${plan.fromLocal}–${plan.toLocal} (repeat=${plan.repeat}), ночь ${plan.nightDate}\n` +
              `план ${active ? "активен" : "истёк"}${inInt ? ", интервал идёт" : ""}; ` +
              `флаг: ${arm === null ? "нет" : (arm.phase ?? "armed")}\n` +
              `backlog: ${plan.backlogPath ?? "—"}; книга ночи: ${nights.length} окон (used ${used})\n` +
              `истекает: ${new Date(plan.expiresAt).toLocaleTimeString()}`,
            "info",
          );
          return;
        }

        // Spec 016: /night-plan create — генератор meta-prompt-а для новой
        // сессии (адаптация задач к проекту + backlog + команды запуска).
        // Ничего не взводит и не запускает: пишет только файл-артефакт.
        if (sub === "create") {
          const createUsage =
            "night plan: формат /night-plan create [HH:MM-HH:MM] <цель ночи>";
          let cFrom = "22:00";
          let cTo = "08:00";
          const rest = argv.slice(1);
          if (rest.length > 0 && /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(rest[0])) {
            const parts = rest[0].split("-");
            cFrom = parts[0];
            cTo = parts[1];
            rest.shift();
          }
          const goal = rest.join(" ").trim();
          if (goal.length === 0) {
            ctx.ui.notify(createUsage, "error");
            return;
          }
          const cFromMin = parseHHMM(cFrom);
          const cToMin = parseHHMM(cTo);
          if (cFromMin === null || cToMin === null || cFromMin === cToMin) {
            ctx.ui.notify(
              `night plan: неверный интервал ${cFrom}-${cTo} (нужно HH:MM-HH:MM, from != to)`,
              "error",
            );
            return;
          }
          cFrom = fmtHHMM(cFromMin);
          cTo = fmtHHMM(cToMin);

          const cwd = historyMetaOf(ctx).project;
          const date = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD (local)
          const backlogPath = suggestBacklogPath(cwd, date);
          const prompt = buildNightCreatePrompt({
            cwd,
            goal,
            fromLocal: cFrom,
            toLocal: cTo,
            date,
            backlogPath,
          });
          try {
            const outDir = getNightsDir();
            fs.mkdirSync(outDir, { recursive: true });
            const outFile = path.join(outDir, `create-prompt-${date}.md`);
            const tmp = outFile + ".tmp." + process.pid;
            fs.writeFileSync(tmp, prompt, "utf8");
            fs.renameSync(tmp, outFile);
            armsLog(
              "night-plan:create",
              withAttr(`goal='${goal.slice(0, 80)}' -> ${outFile}`),
            );
            ctx.ui.notify(
              `night plan: meta-prompt для ночного прогона записан:\n${outFile}\n` +
                `Открой файл, скопируй содержимое в НОВУЮ сессию агента — она подготовит backlog ` +
                `(${backlogPath}) и выведет команды запуска. Сам runner не запущен.`,
              "info",
            );
          } catch (err) {
            ctx.ui.notify(
              `night plan: не удалось записать meta-prompt: ${String((err as Error)?.message ?? err).slice(0, 120)}`,
              "error",
            );
          }
          return;
        }

        // Создание/обновление плана на текущую ночь.
        let fromLocal = "22:00";
        let toLocal = "08:00";
        let repeat = 6;
        let backlogPath: string | null = null;
        for (const tok of argv) {
          if (/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(tok)) {
            const parts = tok.split("-");
            fromLocal = parts[0];
            toLocal = parts[1];
            continue;
          }
          const rm = /^repeat=(\d+)$/i.exec(tok);
          if (rm) {
            repeat = Math.min(99, Math.max(1, Number(rm[1])));
            continue;
          }
          const bm = /^backlog=(.+)$/i.exec(tok);
          if (bm) {
            backlogPath = bm[1];
            continue;
          }
          ctx.ui.notify(
            `night plan: неизвестный аргумент '${tok}'. Формат: ` +
              "/night-plan [HH:MM-HH:MM] [repeat=N] [backlog=<path>] | off | status | create [HH:MM-HH:MM] <цель>",
            "error",
          );
          return;
        }

        const fromMin = parseHHMM(fromLocal);
        const toMin = parseHHMM(toLocal);
        if (fromMin === null || toMin === null || fromMin === toMin) {
          ctx.ui.notify(
            `night plan: неверный интервал ${fromLocal}-${toLocal} (нужно HH:MM-HH:MM, from != to)`,
            "error",
          );
          return;
        }
        fromLocal = fmtHHMM(fromMin);
        toLocal = fmtHHMM(toMin);

        const now = Date.now();
        const key = sessionKeyOf(ctx);
        const toAt = nextOccurrence(now, toLocal);
        if (toAt === null) {
          ctx.ui.notify("night plan: не удалось вычислить момент отчёта", "error");
          return;
        }
        const nightDate = nightDateFor(now, fromLocal, toLocal);
        if (nightDate === null) {
          ctx.ui.notify("night plan: не удалось вычислить дату ночи", "error");
          return;
        }
        const plan: NightPlan = {
          key,
          fromLocal,
          toLocal,
          repeat,
          backlogPath,
          createdAt: now,
          expiresAt: toAt + 60 * 60_000, // toLocal + 1 ч (FR-014-1)
          nightDate,
        };
        const ok = await writePlan(plan);
        if (!ok) {
          ctx.ui.notify(
            "night plan: не удалось записать план (лок занят?) — попробуй ещё раз",
            "error",
          );
          return;
        }
        // Свежий план — чистое in-memory состояние ночи.
        lastAutoRearmAt.delete(plan.key);
        lastUninsuredNotifyAt.delete(plan.key);
        nightPlanCarryKey = null;
        if (nightStats.nightDate !== plan.nightDate) {
          nightStats.nightDate = plan.nightDate;
          nightStats.rearm = 0;
          nightStats.uninsured = 0;
        }
        morningDoneKey = null;
        armsLog(
          "night-plan:armed",
          withAttr(
            `${plan.fromLocal}-${plan.toLocal} repeat=${plan.repeat} night=${plan.nightDate} expires=${new Date(plan.expiresAt).toISOString()}` +
              `${plan.backlogPath ? ` backlog=${plan.backlogPath}` : ""}`,
          ),
        );
        ensureMorningTimer();
        ctx.ui.notify(
          `night plan: взведён на ${plan.fromLocal}–${plan.toLocal} (ночь ${plan.nightDate}, repeat=${repeat}). ` +
            `Отчёт в ${plan.toLocal}, план истекает ${new Date(plan.expiresAt).toLocaleTimeString()}. ` +
            "Флаг cont-after-reset НЕ взведён: инвариант перевзведёт его по мере необходимости (или /cont-after-reset N вручную).",
          "info",
        );
      } catch (err) {
        console.warn("pi-billing-window: /night-plan failed:", err);
      }
    },
  });
}

// --- Spec 015: /night-run production wiring ---------------------------------

/**
 * Delivery одной задачи через существующие owner/session гейты
 * (design §2.4, §5). Гейты решают «можно ли доставить сейчас», НИКОГДА не
 * «выполнена ли задача» (PASS/FAIL — только по маркеру в ответе).
 * Typed errors: OWNER_BUSY / SWITCH_NEEDED — cursor не двигается.
 */
async function nightRunDeliver(prompt: string): Promise<void> {
  // Owner-busy: jsonl владельца менялся недавно — вероятно, чужой/родитель-
  // ский разговор в ходу; задача НЕ считается выполненной.
  if (!ownerQuiet(ownerKey, resetGraceMs)) {
    throw new Error("OWNER_BUSY: owner jsonl busy");
  }
  // Switch-needed: refs указывают на другую сессию — доставка ушла бы в
  // чужой разговор (spec 009); runner ждёт переключения, cursor стоит.
  if (
    ownerKey !== null &&
    lastSessionStartKey !== null &&
    lastSessionStartKey !== ownerKey
  ) {
    throw new Error("SWITCH_NEEDED: refs point to a foreign session");
  }
  const p = piApi;
  if (!p || piApiEpoch !== sessionEpoch) {
    throw new Error("SWITCH_NEEDED: piApi stale");
  }
  const sendTime = Date.now();
  await p.sendUserMessage(prompt);
  // Доставка подтверждается записью в jsonl владельца (verifyDelivered).
  // Проба — однострочный маркер из шаблона промпта (есть в КАЖДОЙ задаче,
  // записи строго новее sendTime — ложных срабатываний на старых нет).
  const probe = "TASK_RESULT: PASS";
  if (!(verifyDeliveredOverride ?? verifyDelivered)(ownerKey, sendTime, probe)) {
    throw new Error("night-run deliver: entry not found in owner jsonl (misroute)");
  }
}

/**
 * Один шаг драйвера очереди: dispatch текущей задачи, если runner в
 * running и userStop не стоит. Никогда не бросает — все исходы в armslog.
 * Вызывается ТОЛЬКО как: явный /night-run resume, PASS-цепочка внутри
 * окна, re-drive на billing:window_reset. Фонового таймера НЕТ.
 */
async function nightRunTick(): Promise<void> {
  const st = readNightRunState();
  if (!st || st.status !== "running" || st.userStop) return;
  try {
    const outcome = await dispatchCurrentTask(nightRunDeliver);
    if (outcome.type === "dispatched") {
      armsLog(
        "night-run:dispatch",
        withAttr(`task=${outcome.task} отправлена, awaiting-result`),
      );
    }
  } catch (err) {
    armsLog(
      "night-run:dispatch-error",
      withAttr(String((err as Error)?.message ?? err).slice(0, 200)),
    );
  }
}

/** Текст последнего assistant-сообщения сессии (для маркера задачи). */
function lastAssistantText(ctx: ExtensionContext | null): string {
  try {
    const entries = ctx?.sessionManager?.getEntries?.() as
      | Array<{
          type?: string;
          message?: { role?: string; content?: unknown };
        }>
      | undefined;
    if (!Array.isArray(entries)) return "";
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type !== "message" || !e.message) continue;
      if (e.message.role !== "assistant") continue;
      const c = e.message.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        const texts = c
          .filter(
            (p) =>
              typeof p === "object" &&
              p !== null &&
              (p as { type?: string }).type === "text",
          )
          .map((p) => String((p as { text?: string }).text ?? ""));
        if (texts.length > 0) return texts.join("\n");
      }
    }
  } catch {
    // stale ctx / нет доступа — пустой текст (неоднозначный результат).
  }
  return "";
}

/**
 * Наблюдатель результата (design §6): после ответа провайдера, если
 * runner в awaiting-result, ищем явный маркер TASK_RESULT: PASS|FAIL в
 * последнем assistant-ответе. Обычный текст без маркера — НЕ PASS
 * (неоднозначный результат не продвигает cursor). PASS → цепочка: сразу
 * dispatch следующей задачи того же окна.
 */
async function nightRunObserveResult(ctx: ExtensionContext | null): Promise<void> {
  const st = readNightRunState();
  if (!st || st.status !== "awaiting-result" || st.userStop) return;
  const marker = extractTaskResult(lastAssistantText(ctx));
  if (marker === null) return; // неоднозначно — ничего не двигаем
  const after = await applyTaskResult(marker);
  if (marker === "PASS" && after !== null && after.status === "running") {
    await nightRunTick(); // PASS-цепочка: следующая задача без ожидания reset
  }
}

/**
 * Re-drive на сбросе окна (естественный ночной heartbeat): провайдер
 * вернул лимит. Возобновляет только runner, запущенный явным действием
 * пользователя (state существует); userStop блокирует всё.
 *   running           → dispatch текущей задачи
 *   awaiting-result   → recovery (bounded re-ask, НЕ автоматический PASS)
 *   paused + 429      → resume + dispatch той же задачи (FR-015-4 «resume later»)
 */
function nightRunRedriveOnReset(): void {
  void (async () => {
    try {
      const st = readNightRunState();
      if (!st || st.userStop) return;
      if (st.status === "paused" && st.lastResult === "429") {
        if (!(await resumeRunner())) return;
      } else if (st.status === "awaiting-result") {
        if ((await import("./nightrun.js")).recoverFromAwaitingResult() === null) return;
      } else if (st.status !== "running") {
        return;
      }
      await nightRunTick();
    } catch (err) {
      armsLog(
        "night-run:redrive-error",
        withAttr(String((err as Error)?.message ?? err).slice(0, 200)),
      );
    }
  })();
}

/**
 * /night-run — backlog runner (spec 015, FR-015-6). Выполняет задачи из
 * Markdown backlog последовательно. Отдельная команда и отдельное состояние
 * (pi-billing-window-nightrun.json); /night-plan не запускает runner сам.
 *   /night-run status   — статус runner-а (ничего не меняет)
 *   /night-run resume   — инициализировать из плана / продолжить текущую задачу
 *   /night-run pause    — приостановить (paused + transition)
 *   /night-run skip     — явный skip текущей задачи (с причиной в журнале)
 *   /night-run stop     — user stop (сильнее auto-continuation, auto-rearm
 *                          плана его НЕ сбрасывает)
 */
function registerNightRun(pi: ExtensionAPI): void {
  pi.registerCommand("night-run", {
    description:
      "Backlog runner: /night-run status | resume | pause | skip | stop. Выполняет задачи из backlog ночного плана последовательно.",
    handler: async (args, ctx) => {
      try {
        const argv = String(args ?? "")
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        const sub = argv[0]?.toLowerCase();

        if (sub === "status" || !sub) {
          const status = getRunnerStatus();
          if (!status.state) {
            ctx.ui.notify(
              "night-run: runner не инициализирован. Создай план с backlog через /night-plan, затем /night-run resume.",
              "info",
            );
            return;
          }
          const st = status.state;
          ctx.ui.notify(
            `night-run: план ${st.plan}, статус ${st.status}\n` +
              `задача ${st.currentTask}/${status.taskCount}, попытка ${st.attempt}/${st.maxRetries}\n` +
              `lastResult: ${st.lastResult ?? "—"}; userStop: ${st.userStop ? "да" : "нет"}\n` +
              `backlog: ${st.backlog}`,
            "info",
          );
          return;
        }

        if (sub === "resume") {
          let st = getRunnerStatus().state;
          if (!st) {
            // Нет state — инициализируем runner из активного плана с backlog.
            const ok = await initRunnerFromPlan();
            if (!ok) {
              ctx.ui.notify(
                "night-run: не удалось инициализировать (нет активного плана, истёк, нет backlog или backlog невалиден)",
                "error",
              );
              return;
            }
            st = getRunnerStatus().state;
            ctx.ui.notify(
              `night-run: runner инициализирован из плана (задача ${st?.currentTask ?? 1}). Повтори /night-run resume для запуска.`,
              "info",
            );
            return;
          }
          const resumed = await resumeRunner();
          if (!resumed) {
            ctx.ui.notify(
              "night-run: resume заблокирован (userStop активен или терминальный статус)",
              "error",
            );
            return;
          }
          ctx.ui.notify(
            `night-run: продолжаю с задачи ${st.currentTask}`,
            "info",
          );
          // Явное действие пользователя: dispatch текущей задачи сейчас.
          void nightRunTick();
          return;
        }

        if (sub === "pause") {
          const ok = await pauseRunner();
          ctx.ui.notify(
            ok ? "night-run: paused" : "night-run: pause no-op (не в running/awaiting-result)",
            ok ? "info" : "warning",
          );
          return;
        }

        if (sub === "stop") {
          const ok = await stopRunner();
          ctx.ui.notify(
            ok
              ? "night-run: stopped (userStop установлен, авто-продолжение заблокировано)"
              : "night-run: stop no-op (runner не инициализирован)",
            ok ? "info" : "warning",
          );
          return;
        }

        if (sub === "skip") {
          const ok = await skipCurrentTask();
          ctx.ui.notify(
            ok
              ? "night-run: текущая задача пропущена (skip записан в журнал переходов)"
              : "night-run: skip не выполнен (терминальный статус или backlog невалиден)",
            ok ? "info" : "error",
          );
          return;
        }

        ctx.ui.notify(
          `night-run: неизвестная подкоманда '${sub}'. Формат: /night-run status | resume | pause | skip | stop`,
          "error",
        );
      } catch (err) {
        console.warn("pi-billing-window: /night-run failed:", err);
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

  // Spec 009 (T2): обернуть pi.registerCommand так, чтобы хендлер КАЖДОЙ
  // команды сначала захватывал свежий командный ctx (он несёт switchSession
  // и пересоздаётся на каждый вызов), потом вызывал оригинал. Обёртка
  // устанавливается ДО registerBillingStatus и остальных register*, поэтому
  // покрыты все команды.
  const origRegisterCommand = pi.registerCommand.bind(pi);
  pi.registerCommand = ((
    name: string,
    options: Parameters<typeof origRegisterCommand>[1],
  ) => {
    const origHandler = options.handler;
    options.handler = async (args, ctx) => {
      commandCtx = ctx;
      return origHandler(args, ctx);
    };
    return origRegisterCommand(name, options);
  }) as typeof pi.registerCommand;

  pi.on("session_start", onSessionStart);
  pi.on("model_select", onModelSelect);
  pi.on("after_provider_response", onAfterProviderResponse);
  pi.on("session_shutdown", onSessionShutdown);

  registerBillingStatus(pi);
  registerBillingTick(pi);
  registerBillingReset(pi);
  registerSettimer(pi);
  registerContAfterReset(pi);
  registerSelfReload(pi);
  // Spec 017: пинг-зонд границ окна.
  registerPingWormsoft(pi);
  registerBillingPing(pi);
  // Spec 014: ночной план — новый контракт поверх cont-after-reset.
  registerNightPlan(pi);
  // Spec 015: /night-run — backlog runner.
  registerNightRun(pi);

  // Touch renderStatusBar so the import is retained for downstream tools
  // and linters that flag unused imports. The function is also exposed for
  // future command handlers (e.g. /billing-status could switch to the
  // footer string for parity with the widget).
  void renderStatusBar;
  void stopStatusUpdater;
}
