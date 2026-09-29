/**
 * session-isolation.test.mts -- spec 006, T-06 (RED):
 * owner-shift наблюдаемость (FR-401 / D-607) + минимальный guard
 * «не трогать таймеры/epoch владельца» (FR-402 / D-608).
 *
 * Run: timeout 120 npx tsx tests/session-isolation.test.mts
 *
 * Ожидаемое поведение (ЗАФИКСИРОВАНО ЗДЕСЬ, код пока его не даёт → RED):
 *  (a) чужой `session-start` (другой session-file key, reason=startup/resume)
 *      при живом флаге владельца → в detail строки `session-start` появляется
 *      `owner-shift: K_owner->K_child` (FR-401);
 *  (b) guard D-608 (repoint + чужой ключ + hasLiveOwnerInterest) блокирует
 *      перехват: currentCtx/currentKey остаются у владельца, таймеры и epoch
 *      владельца не трогаются — ассертится наблюдаемыми эффектами:
 *      доставка владельца по-прежнему даёт fire:send-ok на его mock-pi, флаг
 *      не «пропал» (нет arm-gone), запись arms.json остаётся под старым ключом;
 *  (c) `session-shutdown` дочерней (чужой) сессии НЕ ломает владельца: после
 *      него владелец шлёт повторно (send идёт), не уходит в replacement:waiting,
 *      sessionEpoch не «перепрыгивает»;
 *  (d) легитимные сценарии НЕ блокируются: same-key session-start (reload)
 *      не помечается owner-shift и не ломает доставку; carry-причина
 *      (reason="fork") переносит запись флага, обновляет владельца и несёт
 *      owner-shift (без owner-shift(blocked)); после carry чужой startup
 *      блокируется (owner-shift(blocked)).
 *
 * Техника: два session-file (K_owner.jsonl, K_child.jsonl) + makeMockPi /
 * makeCtx (как в replacement.test.mts); владелец взводится через команду
 * /cont-after-reset; fire-путь дёргается детерминированно хуками
 * __syncWatchdogForTests() / __retryTickForTests(); armslog читается через
 * setArmsLogPath.
 */

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piBillingWindowFactory, {
  setArmsLogPath,
  setResetGraceMsForTests,
  __syncWatchdogForTests,
  __retryTickForTests,
  setVerifyDeliveredForTests,
  setProbePiAliveForTests,
} from "../src/index.ts";
import {
  writeStateSync,
  mutateState,
  setPaths as stateSetPaths,
  resetPaths as stateResetPaths,
} from "../src/state.ts";
import {
  setPaths as armsSetPaths,
  resetPaths as armsResetPaths,
  isArmed as armsIsArmed,
  getKey as armsCurrentKey,
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

function makeCtx(sessionFile: string): unknown {
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
  };
}

// --- state seeding ---------------------------------------------------------------

const WINDOW_MS = 2 * 60 * 60 * 1000;

/** Seed a fresh window (reset marker 0, ready for arming). */
async function seedFreshWindow(): Promise<void> {
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
    return { next: { ...cur, lastResetAt: Date.now() - 1000 } };
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

function sessionStartLines(log: string): string[] {
  return log
    .split("\n")
    .filter((l) => l.includes("session-start") && l.includes("key="));
}

function lineForKey(log: string, base: string): string {
  return (
    log
      .split("\n")
      .find((l) => l.includes("session-start") && l.includes(`key=${base}`)) ??
    ""
  );
}

// --- (a)+(b)+(c): foreign session-start + child shutdown не ломают владельца --

/**
 * Owner arming / cont-after-reset, then a FOREIGN session-start
 * (reason=startup, другой session-file) while the owner's arm is LIVE:
 *  (a) armslog несёт owner-shift (FR-401);
 *  (b) guard D-608: currentKey не переуказывается, флаг жив, доставка
 *      владельца по-прежнему даёт fire:send-ok, нет arm-gone, запись
 *      arms.json остаётся под старым ключом;
 *  (c) session-shutdown дочерней сессии не перепрыгивает epoch владельца:
 *      владелец шлёт повторно (send идёт, не replacement:waiting).
 */
async function testForeignSessionDoesNotHijackOwner(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-si-foreign-"));
  applyPaths(tmp);
  setResetGraceMsForTests(50);
  try {
    await seedFreshWindow();
    const a = makeMockPi();
    piBillingWindowFactory(a.pi as never);

    const ownerFile = join(tmp, "K_owner.jsonl");
    const childFile = join(tmp, "K_child.jsonl");
    const ownerBase = "K_owner.jsonl";
    const childBase = "K_child.jsonl";
    const ownerCtx = makeCtx(ownerFile);
    const childCtx = makeCtx(childFile);

    await handlerOf(a.handlers, "session_start")({}, ownerCtx);
    await commandOf(a.commands, "cont-after-reset")("", ownerCtx);
    assert(armsIsArmed(), "A-pre: флаг владельца взведён");

    // (a) чужой session-start (reason=startup) при живом флаге владельца.
    await handlerOf(a.handlers, "session_start")(
      { reason: "startup" },
      childCtx,
    );
    let log = readFileSync(join(tmp, "armslog.log"), "utf8");
    const foreignLine = lineForKey(log, childBase);
    assert(
      foreignLine.includes("owner-shift"),
      "(a): строка session-start чужого ключа несёт 'owner-shift: K_owner->K_child' (FR-401)",
    );

    // (b) D-608 guard: текущий ключ / флаг / таймеры остаются у владельца.
    assert(
      armsCurrentKey() === ownerFile,
      "(b): currentKey (arms) остался у владельца — чужой ключ не перехватил",
    );
    assert(
      armsIsArmed(),
      "(b): флаг владельца жив (isArmed по-прежнему true после чужого session-start)",
    );
    const map1 = JSON.parse(
      readFileSync(join(tmp, "arms.json"), "utf8"),
    ) as Record<string, unknown>;
    assert(
      map1[ownerFile] !== undefined,
      "(b): запись arms.json осталась под ключом владельца",
    );
    assert(
      map1[childFile] === undefined,
      "(b): запись НЕ появилась под чужим ключом (arm не переехал)",
    );

    // (b) владельческая доставка продолжает работать после чужого session-start.
    await backdateReset();
    await __syncWatchdogForTests();
    await sleep(200);
    assert(
      a.sends.some((s) => s.content === "продолжи"),
      "(b): доставка владельца жива — send-ok на mock-pi владельца после чужого session-start",
    );
    log = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(
      log.includes("fire:send-ok"),
      "(b): fire:send-ok владельца записан в armslog",
    );
    assert(
      !log.includes("arm-gone"),
      "(b): флаг владельца не «пропал» — нет arm-gone после чужого session-start",
    );

    // (c) session-shutdown дочерней (чужой) сессии НЕ ломает владельца.
    await handlerOf(a.handlers, "session_shutdown")({}, childCtx);
    await backdateReset(); // новый сброс окна владельца
    await __syncWatchdogForTests();
    await __retryTickForTests();
    await sleep(200);
    const logAfterChild = readFileSync(join(tmp, "armslog.log"), "utf8");
    assert(
      a.sends.filter((s) => s.content === "продолжи").length === 2,
      "(c): после shutdown дочерней сессии владелец шлёт повторно (send идёт, 2 доставки)",
    );
    assert(
      (logAfterChild.match(/fire:send-ok/g) ?? []).length === 2,
      "(c): два fire:send-ok владельца — sessionEpoch не «перепрыгнул» (нет блокировки доставки)",
    );
    assert(
      !logAfterChild.includes("replacement:waiting"),
      "(c): владелец НЕ ушёл в replacement:waiting после shutdown дочерней сессии",
    );
    assert(
      !logAfterChild.includes("send-error:stale"),
      "(c): нет send-error:stale у владельца после shutdown дочерней сессии",
    );

    await handlerOf(a.handlers, "session_shutdown")({}, ownerCtx);
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- (e) spec 007: МЁРТВЫЙ ctx владельца НЕ блокирует смену -------------------

/**
 * Spec 007 (live 07:38-09:38Z): reload-after-resume chains left the owner's
 * captured ctx dead (probe "stale") and the blocked shift never happened --
 * the fire could never send (send-error:stale loop). A dead owner ctx means
 * the "live interest" is fictional, so the shift must go through: the
 * delivery follows the user's actual conversation.
 */
async function testStaleOwnerCtxLetsShiftThrough(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-si-staleshift-"));
  applyPaths(tmp);
  setResetGraceMsForTests(50);
  try {
    await seedFreshWindow();
    const a = makeMockPi();
    piBillingWindowFactory(a.pi as never);

    const ownerFile = join(tmp, "K_owner.jsonl");
    const childFile = join(tmp, "K_child.jsonl");
    const childBase = "K_child.jsonl";
    const ownerCtx = makeCtx(ownerFile);
    const childCtx = makeCtx(childFile);

    await handlerOf(a.handlers, "session_start")({}, ownerCtx);
    await commandOf(a.commands, "cont-after-reset")("", ownerCtx);
    assert(armsIsArmed(), "E-pre: флаг владельца взведён");

    // Мёртвый captured ctx владельца (probe "stale") — сессия заменена.
    setProbePiAliveForTests("stale");

    // Чужой session-start (reason=startup, другой ключ) при мёртвом ctx.
    await handlerOf(a.handlers, "session_start")(
      { reason: "startup" },
      childCtx,
    );
    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    const foreignLine = lineForKey(log, childBase) ?? "";
    assert(
      !foreignLine.includes("owner-shift(blocked)"),
      "(e): при мёртвом ctx владельца смена НЕ блокируется (нет owner-shift(blocked))",
    );
    assert(
      foreignLine.includes("owner-shift"),
      "(e): смена выполнена — строка несёт owner-shift (не blocked)",
    );
    assert(
      armsCurrentKey() === childFile,
      "(e): ключ переехал на новый session-file (доставка следует за разговором)",
    );
    const mapE = JSON.parse(
      readFileSync(join(tmp, "arms.json"), "utf8"),
    ) as Record<string, unknown>;
    // Repoint НЕ переносит запись (spec 006 README: "флаг остаётся у своего
    // разговора и сработает, когда вы к нему вернётесь") — запись остаётся
    // под ключом владельца, переехавшей записи быть не должно. Ранее этот
    // ассерт был RED-остатком и тест не был подключён к runner'у;правильное
    // поведение зафиксировано здесь.
    assert(
      mapE[ownerFile] !== undefined,
      "(e): запись arms.json осталась под ключом владельца (repoint не переносит)",
    );
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    setProbePiAliveForTests(null);
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- (d) легитимный same-key session-start НЕ блокируется ----------------------

/**
 * Same-key session-start (reason="reload") — это легитимный repoint на тот
 * же conversation: НЕ должен помечаться owner-shift (ownerKey===incoming),
 * НЕ блокироваться guard и не ломать доставку владельца.
 */
async function testSameKeySessionStartNotBlocked(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-si-samekey-"));
  applyPaths(tmp);
  setResetGraceMsForTests(50);
  try {
    await seedFreshWindow();
    const a = makeMockPi();
    piBillingWindowFactory(a.pi as never);

    const ownerFile = join(tmp, "K_owner.jsonl");
    const ownerCtx = makeCtx(ownerFile);

    await handlerOf(a.handlers, "session_start")({}, ownerCtx);
    await commandOf(a.commands, "cont-after-reset")("", ownerCtx);
    assert(armsIsArmed(), "D-samekey: флаг взведён (pre)");

    // Same-key reload: fresh ctx, тот же session-file, reason=reload.
    await handlerOf(a.handlers, "session_start")(
      { reason: "reload" },
      makeCtx(ownerFile),
    );
    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    const latest = sessionStartLines(log).at(-1) ?? "";
    assert(
      armsCurrentKey() === ownerFile,
      "(d) same-key: currentKey не менялся после reload того же ключа",
    );
    assert(
      armsIsArmed(),
      "(d) same-key: флаг жив после same-key session-start (легитимный reload)",
    );
    assert(
      !latest.includes("owner-shift"),
      "(d) same-key: строкa session-start НЕ содержит owner-shift (совпадение ключа — не shift)",
    );
    assert(
      !log.includes("owner-shift(blocked)"),
      "(d) same-key: guard D-608 НЕ блокировал легитимный same-key session-start",
    );

    // Доставка после same-key reload работает штатно.
    await backdateReset();
    await __syncWatchdogForTests();
    await sleep(200);
    assert(
      a.sends.filter((s) => s.content === "продолжи").length === 1,
      "(d) same-key: доставка владельца работает после same-key reload (1 send-ok)",
    );

    await handlerOf(a.handlers, "session_shutdown")({}, ownerCtx);
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- (d) carry-причина (fork) переносит флаг и НЕ блокируется -----------------

/**
 * Carry (reason="fork", другой key) — легитимный сценарий: запись флага
 * переносится на новый conversation, владелец обновляется (ownerKey=fork),
 * запись несёт owner-shift БЕЗ owner-shift(blocked). После carry чужой
 * startup (ещё один key) уже блокируется guard'ом — владелец теперь fork.
 */
async function testCarrySessionMovesOwner(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-si-carry-"));
  applyPaths(tmp);
  try {
    await seedFreshWindow();
    const a = makeMockPi();
    piBillingWindowFactory(a.pi as never);

    const ownerFile = join(tmp, "K_owner.jsonl");
    const forkFile = join(tmp, "K_fork.jsonl");
    const child2File = join(tmp, "K_child2.jsonl");
    const forkBase = "K_fork.jsonl";
    const child2Base = "K_child2.jsonl";
    const ownerCtx = makeCtx(ownerFile);

    await handlerOf(a.handlers, "session_start")({}, ownerCtx);
    await commandOf(a.commands, "cont-after-reset")("", ownerCtx);
    assert(armsIsArmed(), "D-carry: флаг взведён у владельца (pre)");

    // carry: fork на новый key — запись переносится, владелец переезжает.
    await handlerOf(a.handlers, "session_start")(
      { reason: "fork" },
      makeCtx(forkFile),
    );
    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    const forkLine = lineForKey(log, forkBase);
    assert(
      forkLine.includes("owner-shift"),
      "(d) carry: строка session-start несёт owner-shift (K_owner->K_fork) — владелец обновился",
    );
    assert(
      !forkLine.includes("owner-shift(blocked)"),
      "(d) carry: carry-причина НЕ блокируется guard'ом (ownerKey обновляется)",
    );
    assert(
      armsCurrentKey() === forkFile,
      "(d) carry: currentKey переехал на fork-ключ",
    );
    assert(
      armsIsArmed(),
      "(d) carry: флаг перенесён и жив (запись поехала с владельцем)",
    );
    const m = JSON.parse(
      readFileSync(join(tmp, "arms.json"), "utf8"),
    ) as Record<string, unknown>;
    assert(
      m[forkFile] !== undefined && m[ownerFile] === undefined,
      "(d) carry: запись перенесена в arms.json (под старым ключом пусто)",
    );

    // После carry владелец — fork: чужой startup блокируется.
    await handlerOf(a.handlers, "session_start")(
      { reason: "startup" },
      makeCtx(child2File),
    );
    const log2 = readFileSync(join(tmp, "armslog.log"), "utf8");
    const child2Line = lineForKey(log2, child2Base);
    assert(
      child2Line.includes("owner-shift(blocked)"),
      "(d) carry+guard: после carry чужой startup блокируется (owner-shift(blocked))",
    );

    await handlerOf(a.handlers, "session_shutdown")({}, makeCtx(forkFile));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- (f) spec 008 (T2): ЖИВОЙ probe + epoch-mismatch: смена проходит ---------

/**
 * Spec 008 (C2, live 12:08/12:35Z): a session-start with a DIFFERENT key
 * while the owner's arm is live was BLOCKED even though the owner's
 * conversation was already replaced -- the probe said "live" because main()
 * had re-captured piApi for the replacement session while ownerKey still
 * pointed at the old conversation. The shift must go through whenever the
 * captured refs belong to ANOTHER epoch (piApiEpoch !== sessionEpoch):
 * ownerKey moves to the actual conversation and key/arms.json travel
 * together; otherwise key and conversation diverge forever.
 */
async function testEpochMismatchLetsShiftThrough(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-si-epoch-"));
  applyPaths(tmp);
  setResetGraceMsForTests(50);
  try {
    await seedFreshWindow();
    const a = makeMockPi();
    piBillingWindowFactory(a.pi as never);

    const ownerFile = join(tmp, "E_owner.jsonl");
    const childFile = join(tmp, "E_child.jsonl");
    const childBase = "E_child.jsonl";
    const ownerCtx = makeCtx(ownerFile);
    const childCtx = makeCtx(childFile);

    await handlerOf(a.handlers, "session_start")({}, ownerCtx);
    await commandOf(a.commands, "cont-after-reset")("", ownerCtx);
    assert(armsIsArmed(), "F-pre: флаг владельца взведён");

    // Owner session replaced: shutdown bumps the epoch; the module-level
    // refs now belong to the OLD epoch (piApiEpoch !== sessionEpoch), but
    // the mock probe still says "live" (the fictional C2 combination).
    await handlerOf(a.handlers, "session_shutdown")({}, ownerCtx);

    // Чужой session-start (reason=startup, другой ключ) при живом probe и
    // разошедшихся эпохах: смена должна ПРОЙТИ (не blocked).
    await handlerOf(a.handlers, "session_start")(
      { reason: "startup" },
      childCtx,
    );
    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    const foreignLine = lineForKey(log, childBase) ?? "";
    assert(
      !foreignLine.includes("owner-shift(blocked)"),
      "(f) T2: при epoch-mismatch смена НЕ блокируется (нет owner-shift(blocked))",
    );
    assert(
      foreignLine.includes("owner-shift"),
      "(f) T2: смена выполнена — строка несёт owner-shift (не blocked)",
    );
    assert(
      armsCurrentKey() === childFile,
      "(f) T2: ключ переехал на актуальный разговор (key/разговор вместе)",
    );
    const mapF = JSON.parse(
      readFileSync(join(tmp, "arms.json"), "utf8"),
    ) as Record<string, unknown>;
    assert(
      mapF[ownerFile] !== undefined,
      "(f) T2: запись arms.json осталась под ключом владельца (repoint не переносит)",
    );

    await handlerOf(a.handlers, "session_shutdown")({}, childCtx);
  } finally {
    setResetGraceMsForTests(RESET_GRACE_MS);
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --- runner ----------------------------------------------------------------------

function resetStaleStateForTests(): void {
  const hooks = piBillingWindowFactory as unknown as {
    __resetStaleStateForTests?: () => void;
  };
  hooks.__resetStaleStateForTests?.();
}

async function main(): Promise<void> {
  // Spec 007: unit-test mocks do not write session-file entries -- stub
  // the D1 delivery verification to always-true (the new delivery-gating
  // tests drive the real verification with a faithful mock).
  setVerifyDeliveredForTests(() => true);
  console.log(
    "\n=== Session isolation (spec 006, T-06: owner-shift FR-401/D-607 + guard D-608) ===",
  );
  resetStaleStateForTests();
  await testForeignSessionDoesNotHijackOwner();
  resetStaleStateForTests();
  await testStaleOwnerCtxLetsShiftThrough();
  resetStaleStateForTests();
  await testSameKeySessionStartNotBlocked();
  resetStaleStateForTests();
  await testCarrySessionMovesOwner();
  resetStaleStateForTests();
  await testEpochMismatchLetsShiftThrough();

  console.log("\n========================================");
  for (const r of results) console.log(r);
  console.log("========================================");
  console.log(`TOTAL: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
