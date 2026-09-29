/**
 * replacement.test.mts -- spec 002, инвариант 1 (FR-001/FR-005):
 * replacement сессии не теряет флаг молча.
 *
 * Run: npx tsx tests/replacement.test.mts
 *
 * Two scenarios (design §5.1):
 *  1. session_start reason="replacement" (factory NOT re-run) carries fresh
 *     pi/events refs in its ctx -> the extension re-adopts them
 *     ("replacement:adopted") and the "продолжи" send goes through on the
 *     FRESH api. No "send-error:stale" on the successful path.
 *  2. No fresh refs available in the event/ctx (today's real pi shapes) ->
 *     "replacement:waiting" in armslog, the OLD epoch's sendUserMessage is
 *     NOT called (epoch guard), the arm survives.
 *  3. (spec 006, D-603 / FR-102) stale на границе -> replacement:adopted ->
 *     первый же __retryTickForTests() даёт fire:send-ok на НОВОЙ эпохе
 *     (форс-перерис доставки); после adopted нет send-error:stale со старой
 *     эпохой. РЕД-тест: текущий код pending-веткой ждёт нового сброса окна
 *     и не перерисовывает -- assert падает.
 */

import {
  mkdtempSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piBillingWindowFactory, {
  setArmsLogPath,
  __syncWatchdogForTests,
  __fireWatchdogForTests,
  __retryTickForTests,
  __resetStaleStateForTests,
  setResetGraceMsForTests,
  setVerifyDeliveredForTests,
} from "../src/index.ts";
import {
  mutateState,
  setPaths as stateSetPaths,
  resetPaths as stateResetPaths,
} from "../src/state.ts";
import {
  setPaths as armsSetPaths,
  resetPaths as armsResetPaths,
  isArmed as armsIsArmed,
  getArm as armsGetArm,
  RESET_GRACE_MS,
} from "../src/arms.ts";
import {
  setPaths as historySetPaths,
  resetPaths as historyResetPaths,
} from "../src/history.ts";

// --- tiny assert harness ------------------------------------------------------

const results: string[] = [];
let passed = 0;
let failed = 0;

function assert(cond: boolean, name: string): void {
  if (cond) {
    passed++;
    results.push(`PASS: ${name}`);
  } else {
    failed++;
    results.push(`FAIL: ${name}`);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Все строки armslog, содержащие искомое событие (армлог-событие во 2-й колонке). */
function linesWith(log: string, event: string): string[] {
  return log.split("\n").filter((l) => l.includes(event));
}

/** Токен ep=<N> (D-606 грамматика) из строки armslog. */
function epOf(line: string): number | null {
  const m = line.match(/\bep=(\d+)/);
  return m ? Number(m[1]) : null;
}

// --- mock pi / ctx --------------------------------------------------------------

type SessionHandler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;

function makeMockPi(): {
  pi: unknown;
  handlers: Map<string, SessionHandler[]>;
  commands: Map<string, CommandHandler>;
  sends: Array<{ content: unknown; opts: unknown }>;
} {
  const handlers = new Map<string, SessionHandler[]>();
  const commands = new Map<string, CommandHandler>();
  const sends: Array<{ content: unknown; opts: unknown }> = [];
  const busSubs = new Map<string, Array<(d: unknown) => void>>();

  const pi = {
    events: {
      emit: (_ch: string, _data: unknown) => {},
      on: (ch: string, h: (d: unknown) => void) => {
        const arr = busSubs.get(ch) ?? [];
        arr.push(h);
        busSubs.set(ch, arr);
        return () => {
          const i = arr.indexOf(h);
          if (i >= 0) arr.splice(i, 1);
        };
      },
    },
    on: (ev: string, h: SessionHandler) => {
      const arr = handlers.get(ev) ?? [];
      arr.push(h);
      handlers.set(ev, arr);
    },
    registerCommand: (name: string, spec: { handler: CommandHandler }) => {
      commands.set(name, spec.handler);
    },
    sendUserMessage: async (content: unknown, opts?: unknown) => {
      sends.push({ content, opts });
      return undefined;
    },
  };
  return { pi, handlers, commands, sends };
}

/**
 * Mock ExtensionContext. `extra` lets scenario 1 attach fresh pi/events
 * refs (the hypothetical session_start payload that D-201 probes for).
 */
function makeCtx(sessionFile: string, extra?: Record<string, unknown>): unknown {
  return {
    mode: "tui",
    isIdle: () => true,
    model: { provider: "wormsoft", id: "test/model-1" },
    ui: {
      notify: () => {},
      setStatus: () => {},
    },
    sessionManager: {
      getSessionFile: () => sessionFile,
      getCwd: () => "C:/tmp/fake-project",
      getEntries: () => [],
    },
    ...(extra ?? {}),
  };
}

// --- state seeding ---------------------------------------------------------------

const WINDOW_MS = 2 * 60 * 60 * 1000;

/** Seed a fresh window (reset marker 0, ready for arming). */
async function seedFreshWindow(): Promise<void> {
  const { writeStateSync } = await import("../src/state.ts");
  writeStateSync({
    provider: "wormsoft",
    windowStartedAt: Date.now(),
    windowMs: WINDOW_MS,
    lastResetAt: 0,
    resetCount: 1,
    callsInWindow: 0,
  });
}

/** Backdate a window reset R whose grace has already elapsed. */
async function backdateReset(): Promise<void> {
  await mutateState((cur) => {
    if (cur === null) throw new Error("state file missing");
    return { next: { ...cur, lastResetAt: Date.now() - 60_000 } };
  });
}

function applyPaths(tmp: string): void {
  stateSetPaths(join(tmp, "state.json"), join(tmp, "state.lock"));
  armsSetPaths(join(tmp, "arms.json"), join(tmp, "arms.lock"));
  historySetPaths(join(tmp, "history.csv"), join(tmp, "history.lock"));
  setArmsLogPath(join(tmp, "armslog.log"));
}

function cleanupPaths(tmp: string): void {
  rmSync(tmp, { recursive: true, force: true });
  stateResetPaths();
  armsResetPaths();
  historyResetPaths();
}

function handlerOf(
  handlers: Map<string, SessionHandler[]>,
  name: string,
): SessionHandler {
  const h = handlers.get(name)?.[0];
  if (!h) throw new Error(`no handler registered for ${name}`);
  return h;
}

function commandOf(
  commands: Map<string, CommandHandler>,
  name: string,
): CommandHandler {
  const h = commands.get(name);
  if (!h) throw new Error(`no command registered for ${name}`);
  return h;
}

// --- 1. Replacement с свежими ссылками в ctx: adopted + send ----------------

/**
 * Scenario 1 (design §5.1): factory ran for session A; session_start
 * reason="replacement" arrives WITHOUT the factory re-running, but the
 * event/ctx carries the fresh pi/events. onSessionStart must re-adopt the
 * refs (armslog "replacement:adopted"), and the watchdog fire must deliver
 * "продолжи" via the FRESH api.
 */
async function testReplacementAdoptsFreshRefs(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-repl-adopt-"));
  applyPaths(tmp);
  try {
    await seedFreshWindow();
    const a = makeMockPi();
    piBillingWindowFactory(a.pi as never);

    const sessionFile = join(tmp, "sess-1.jsonl");
    const ctxA = makeCtx(sessionFile);
    await handlerOf(a.handlers, "session_start")({}, ctxA);
    await commandOf(a.commands, "cont-after-reset")("", ctxA);
    assert(armsIsArmed(), "adopted: флаг взведён до замены");
    await backdateReset();

    // Replacement: old session shuts down, a new one starts WITHOUT the
    // factory re-running. The new ctx carries the fresh pi/events refs.
    await handlerOf(a.handlers, "session_shutdown")({}, ctxA);
    const fresh = makeMockPi();
    const ctxB = makeCtx(sessionFile, {
      api: fresh.pi,
      events: (fresh.pi as { events: unknown }).events,
    });
    await handlerOf(a.handlers, "session_start")(
      { reason: "replacement" },
      ctxB,
    );

    // The fire pipeline must now deliver via the re-adopted refs.
    await sleep(400); // sync-poller resync -> watchdog fires -> grace -> send

    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(
      log.includes("replacement:adopted"),
      "adopted: armslog содержит replacement:adopted",
    );
    assert(
      fresh.sends.length === 1 && fresh.sends[0]?.content === "продолжи",
      "adopted: «продолжи» доставлен через переснятые ссылки (fresh api)",
    );
    assert(
      a.sends.length === 0,
      "adopted: старая (stale) api не используется",
    );
    assert(
      !log.includes("send-error:stale"),
      "adopted: на успешном пути нет send-error:stale (регресс-страховка)",
    );
    await handlerOf(a.handlers, "session_shutdown")(
      { reason: "replacement" },
      ctxB,
    );
  } finally {
    cleanupPaths(tmp);
  }
}

// --- 2. Replacement без свежих ссылок: waiting + guard -----------------------

/**
 * Scenario 2 (design §5.1): no fresh refs in the event/ctx (today's real
 * pi shapes) -> "replacement:waiting" in armslog, the old epoch's
 * sendUserMessage is never called, the arm survives (no capitulation yet).
 */
async function testReplacementWaitingWithoutFreshRefs(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-repl-wait-"));
  applyPaths(tmp);
  try {
    await seedFreshWindow();
    const { pi, handlers, commands, sends } = makeMockPi();
    piBillingWindowFactory(pi as never);

    const sessionFile = join(tmp, "sess-2.jsonl");
    const ctx = makeCtx(sessionFile);
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);
    await backdateReset();
    // Replacement WITHOUT fresh refs in the ctx (real pi today).
    await handlerOf(handlers, "session_shutdown")({}, ctx);
    await handlerOf(handlers, "session_start")(
      { reason: "replacement" },
      makeCtx(sessionFile),
    );
    await sleep(400); // sync resync -> watchdog fire -> grace -> guard

    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(
      log.includes("replacement:waiting"),
      "waiting: armslog содержит replacement:waiting",
    );
    assert(
      sends.length === 0,
      "waiting: sendUserMessage старой эпохи не вызван (эпоха-гуард)",
    );
    assert(
      armsIsArmed(),
      "waiting: флаг не потерян молча (нет капитуляции на первой попытке)",
    );
    await handlerOf(handlers, "session_shutdown")(
      { reason: "replacement" },
      ctx,
    );
  } finally {
    cleanupPaths(tmp);
  }
}

// --- 3. Форс-перерис после переусыновления (spec 006, D-603 / FR-102) --------

/**
 * Scenario 3 (design §5.4, D-603(b) / FR-102): форс-перерис доставки после
 * переусыновления. Доставка дошла до pending НА СТАРОЙ сессии (fire:send-ok
 * старой эпохи, флаг ждёт подтверждения), сессия заменена и ссылки пересняты
 * (replacement:adopted на НОВОЙ эпохе). ПЕРВЫЙ же __retryTickForTests() после
 * adopted обязан выдать fire:send-ok на новой эпохе (перерис на первом же
 * тике, FR-102), а НЕ ждать нового сброса окна; stale-цепочки старой эпохи
 * после adopted не должно быть.
 *
 * РЕД: текущий код в pending-ветке retryTick не перерисовывает без нового
 * сброса (st.lastResetAt === pendingFiredResetAt -> return) -- assert падает.
 */
async function testReplacementForcesReFireAfterAdopted(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-repl-rerun-"));
  applyPaths(tmp);
  setResetGraceMsForTests(20);
  try {
    await seedFreshWindow();
    const a = makeMockPi();
    piBillingWindowFactory(a.pi as never);

    const sessionFile = join(tmp, "sess-3.jsonl");
    const ctxA = makeCtx(sessionFile);
    await handlerOf(a.handlers, "session_start")({}, ctxA);
    await commandOf(a.commands, "cont-after-reset")("", ctxA);
    assert(armsIsArmed(), "perm3: флаг взведён");
    await backdateReset();

    // Граница: доставка на СТАРОЙ сессии (эпоха-старая) -> флаг в pending.
    await __syncWatchdogForTests();
    await __fireWatchdogForTests();
    await sleep(150);
    assert(
      a.sends.length === 1 && armsGetArm()?.phase === "pending",
      "perm3: старая сессия доставила «продолжи» — флаг в pending (in-flight доставка)",
    );
    const log0 = readFileSync(join(tmp, "armslog.log"), "utf8");
    const oldLine = linesWith(log0, "fire:send-ok")[0] ?? "";
    const oldEp = epOf(oldLine);
    assert(
      oldLine !== "" && oldEp !== null,
      `perm3: fire:send-ok старой эпохи в armslog (ep=${oldEp})`,
    );

    // Переусыновление со свежими ссылками -> replacement:adopted (эпоха+1).
    await handlerOf(a.handlers, "session_shutdown")({}, ctxA);
    const fresh = makeMockPi();
    const ctxB = makeCtx(sessionFile, {
      api: fresh.pi,
      events: (fresh.pi as { events: unknown }).events,
    });
    await handlerOf(a.handlers, "session_start")(
      { reason: "replacement" },
      ctxB,
    );
    const log1 = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(
      log1.includes("replacement:adopted"),
      "perm3: armslog содержит replacement:adopted",
    );
    const adoptedEp = epOf(linesWith(log1, "replacement:adopted")[0] ?? "");
    assert(
      adoptedEp !== null && adoptedEp === (oldEp ?? -1) + 1,
      `perm3: replacement:adopted на новой эпохе (ep=${adoptedEp}, ждал ${(oldEp ?? -1) + 1})`,
    );

    // РЕД: первый же retry-тик после adopted обязан форс-перерисовать.
    await __retryTickForTests();
    await sleep(150);
    const log2 = readFileSync(join(tmp, "armslog.log"), "utf8");
    const afterAdopted = log2.slice(log2.lastIndexOf("replacement:adopted"));
    const newLine = linesWith(afterAdopted, "fire:send-ok")[0] ?? "";
    const newEp = epOf(newLine);
    assert(
      newLine !== "",
      "perm3: __retryTickForTests() после adopted даёт fire:send-ok (форс-перерис)",
    );
    assert(
      newEp !== null && newEp === adoptedEp,
      `perm3: send-ok на новой эпохе (ep=${newEp}, ждал ${adoptedEp})`,
    );
    const staleOld = afterAdopted
      .split("\n")
      .filter((l) => l.includes("send-error:stale") && l.includes(`ep=${oldEp}`));
    assert(
      staleOld.length === 0,
      "perm3: после adopted нет send-error:stale со старой эпохой",
    );

    await handlerOf(a.handlers, "session_shutdown")({}, ctxB);
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    cleanupPaths(tmp);
  }
}

// --- runner ----------------------------------------------------------------------

// Spec-002 test hook: reset the module-level stale-retry/dedup state between
// scenarios. Since T-02 the hook is a NAMED export -- the factory-property
// probe below is kept only for the pre-T02 build where the hook did not
// exist yet (optional chaining keeps the RED run an assertion failure, not
// a crash). Without the reset the previous scenario's stale pacing leaks
// into the next one (backoff silently paces the fire).
function resetStaleStateForTests(): void {
  __resetStaleStateForTests?.();
  const hooks = piBillingWindowFactory as unknown as {
    __resetStaleStateForTests?: () => void;
  };
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  hooks.__resetStaleStateForTests?.();
}

async function main(): Promise<void> {
  // Spec 007: unit-test mocks do not write session-file entries -- stub
  // the D1 delivery verification to always-true (the new delivery-gating
  // tests drive the real verification with a faithful mock).
  setVerifyDeliveredForTests(() => true);
  console.log(
    "\n=== Replacement tests (spec 002: cont-after-reset vs stale session) ===",
  );
  resetStaleStateForTests();
  await testReplacementAdoptsFreshRefs();
  resetStaleStateForTests();
  await testReplacementWaitingWithoutFreshRefs();
  resetStaleStateForTests();
  await testReplacementForcesReFireAfterAdopted();

  console.log("\n========================================");
  for (const r of results) console.log(r);
  console.log("========================================");
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
