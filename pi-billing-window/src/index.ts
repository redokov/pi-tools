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

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

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
  getArmForKey as armsGetArmForKey,
  getKey as armsGetKey,
  remapKey,
  RESET_GRACE_MS,
  RETRY_AFTER_FIRE_MS,
} from "./arms.js";
import { armsLog, setArmsLogPath } from "./armslog.js";
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

export { setArmsLogPath };
// Spec 007: direct unit-test exports for the new delivery/gating helpers.
export { verifyDelivered, isTokenBearing, ownerQuiet };

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
  probeWasStale = false;
  epochGuardWasFailing = false;
  ownerKey = null;
  // Spec 007 (D1): the misroute streak resets with the stale state.
  misrouteAttempts = 0;
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

/**
 * Track arm visibility changes so syncWatchdog logs "arm-seen" /
 * "arm-gone" only on the transition, not on every sync tick.
 */
let lastArmSeenKey: string | null = null;

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
      armsLog("arm-gone", withAttr("флаг исчез/истёк (sync-poller продолжает жить)"));
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
 * start the periodic ticker. Idempotent across reloads thanks to the
 * tickerStarted guard and the state file itself.
 */
async function onSessionStart(
  event: unknown,
  ctx: ExtensionContext,
): Promise<void> {
  const incomingKey = sessionKeyOf(ctx);
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
    isTokenBearing(lastAssistantUsage(ctx));
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
  registerSelfReload(pi);

  // Touch renderStatusBar so the import is retained for downstream tools
  // and linters that flag unused imports. The function is also exposed for
  // future command handlers (e.g. /billing-status could switch to the
  // footer string for parity with the widget).
  void renderStatusBar;
  void stopStatusUpdater;
}
