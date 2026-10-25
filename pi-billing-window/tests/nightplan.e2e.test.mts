/**
 * nightplan.e2e.test.mts -- e2e-сценарии spec 014 (night plan, Task 3).
 *
 * Run: npx tsx tests/nightplan.e2e.test.mts
 *
 * Стиль watchdog.e2e.test.mts: мок pi (eventBus с РАБОЧЕЙ диспетчеризацией
 * emit→on, чтобы подписчик ночной книги получал billing:window_reset),
 * реальные tmp-файлы (state/arms/history/nightplan/armslog), короткие
 * интервалы. Реальные минуты не ждём: инвариант гоняется через
 * __nightPlanTickForTests(), утренний отчёт -- через __fireMorningForTests().
 *
 * Шесть сценариев приёмки (requirements.md Acceptance):
 *  1. план взведён → внешний disarm → sync-тик → auto-rearm + armslog
 *     auto-rearm:from-plan + notify; arm-gone-notify погашен (FR-014-3);
 *  2. сброс окна в интервале плана → строки ledger (used и idle);
 *  3. утренний отчёт в toLocal: report-<date>.md + notify (FR-014-5);
 *  4. /night-plan off → инвариант не перевзводит, ledger/отчёт не пишутся;
 *  5. истёкший план (now > expiresAt) игнорируется на sync-тике;
 *  6. arm() падает (битый arms.json) → night-plan-uninsured с rate-limit.
 */

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piBillingWindowFactory, {
  setArmsLogPath,
  __syncWatchdogForTests,
  __fireWatchdogForTests,
  __nightPlanTickForTests,
  __fireMorningForTests,
  __setNightPlanNotifyForTests,
  setNightPlanEscalateForTests,
  setNightPlanMorningGraceForTests,
  __resetNightPlanStateForTests,
  __resetStaleStateForTests,
  setVerifyDeliveredForTests,
  VERSION,
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
  getArmForKey,
  type ArmMap,
} from "../src/arms.ts";
import {
  setPaths as historySetPaths,
  resetPaths as historyResetPaths,
  appendHistory,
} from "../src/history.ts";
import {
  setPaths as npSetPaths,
  resetPaths as npResetPaths,
  readPlan,
  writePlan,
  readLedger,
  reportPathFor,
  fmtHHMM,
  type NightPlan,
} from "../src/nightplan.ts";

// --- assert harness (watchdog.e2e style) ---------------------------------------

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

function linesWith(log: string, event: string): string[] {
  return log.split("\n").filter((l) => l.includes(event));
}

// --- mock pi: eventBus с реальной диспетчеризацией ------------------------------

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
      // КЛЮЧЕВОЕ отличие от watchdog.e2e-мока: emit ДЕЙСТВИТЕЛЬНО
      // диспатчит в подписчиков шины -- иначе подписчик ночной книги
      // (ledger) не получит billing:window_reset.
      emit: (ch: string, data: unknown) => {
        for (const h of busSubs.get(ch) ?? []) {
          try {
            h(data);
          } catch {}
        }
      },
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

// --- пути и сиды -----------------------------------------------------------------

const WINDOW_MS = 2 * 60 * 60 * 1000;

function seedFreshWindow(): void {
  writeStateSync({
    provider: "wormsoft",
    windowStartedAt: Date.now(),
    windowMs: WINDOW_MS,
    lastResetAt: 0,
    resetCount: 1,
    callsInWindow: 0,
  });
}

/** Просроченное окно с заданными итогами (для сброса и ledger-строки). */
function seedExpiredWindow(
  calls: number,
  tokens: { input: number; output: number; cacheRead: number },
): void {
  writeStateSync({
    provider: "wormsoft",
    windowStartedAt: Date.now() - WINDOW_MS - 1000,
    windowMs: WINDOW_MS,
    lastResetAt: 0,
    resetCount: 1,
    callsInWindow: calls,
    windowInput: tokens.input,
    windowOutput: tokens.output,
    windowCacheRead: tokens.cacheRead,
  });
}

type NightNotify = { type: string; title: string; body: string };

type Scenario = {
  tmp: string;
  sessionFile: string;
  commands: Map<string, CommandHandler>;
  handlers: Map<string, SessionHandler[]>;
  notifies: NightNotify[];
};

function applyPaths(tmp: string): void {
  stateSetPaths(join(tmp, "state.json"), join(tmp, "state.lock"));
  armsSetPaths(join(tmp, "arms.json"), join(tmp, "arms.lock"));
  historySetPaths(join(tmp, "history.csv"), join(tmp, "history.lock"));
  setArmsLogPath(join(tmp, "armslog.log"));
  npSetPaths(
    join(tmp, "nightplan.json"),
    join(tmp, "nightplan.lock"),
    join(tmp, "nights"),
  );
}

async function startScenario(prefix: string): Promise<Scenario> {
  __resetStaleStateForTests();
  __resetNightPlanStateForTests();
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  applyPaths(tmp);
  seedFreshWindow();
  const { pi, handlers, commands } = makeMockPi();
  piBillingWindowFactory(pi as never);
  const notifies: NightNotify[] = [];
  __setNightPlanNotifyForTests((p) => {
    notifies.push({ type: p.type, title: p.title, body: p.body });
  });
  const sessionFile = join(tmp, "sess-night.jsonl");
  const ctx = makeCtx(sessionFile);
  await (handlers.get("session_start")?.[0] as SessionHandler)({}, ctx);
  return { tmp, sessionFile, commands, handlers, notifies };
}

function cleanup(s: Scenario): void {
  __resetNightPlanStateForTests();
  rmSync(s.tmp, { recursive: true, force: true });
  stateResetPaths();
  armsResetPaths();
  historyResetPaths();
  npResetPaths();
}

async function shutdown(s: Scenario): Promise<void> {
  const h = s.handlers.get("session_shutdown")?.[0];
  if (h) await h({}, makeCtx(s.sessionFile));
}

function commandOf(s: Scenario, name: string): CommandHandler {
  const h = s.commands.get(name);
  if (!h) throw new Error(`no command registered: ${name}`);
  return h;
}

function handlerOf(s: Scenario, name: string): SessionHandler {
  const h = s.handlers.get(name)?.[0];
  if (!h) throw new Error(`no handler registered: ${name}`);
  return h;
}

/** Интервал локального времени вокруг now (минутная арифметика, wrap-безопасно). */
function intervalAroundNow(
  beforeMin: number,
  afterMin: number,
): { from: string; to: string } {
  const d = new Date();
  const cur = d.getHours() * 60 + d.getMinutes();
  const wrap = (m: number): string => fmtHHMM(((m % 1440) + 1440) % 1440);
  return { from: wrap(cur - beforeMin), to: wrap(cur + afterMin) };
}

/** Внешний disarm: перезапись arms.json пустой картой (инцидент 24.10). */
function externalDisarm(s: Scenario): void {
  writeFileSync(join(s.tmp, "arms.json"), JSON.stringify({} as ArmMap), "utf8");
}

// --- 1. внешний disarm → sync-тик → auto-rearm + гашение arm-gone ----------------

async function testAutoRearmAfterExternalDisarm(): Promise<void> {
  const s = await startScenario("pbi-np-rearm-");
  try {
    const ctx = makeCtx(s.sessionFile);
    // Флаг взведён вручную (repeat=2) и увиден sync-тиком (snapshot для
    // arm-gone-перехода).
    await commandOf(s, "cont-after-reset")("2", ctx);
    await __syncWatchdogForTests();
    assert(
      getArmForKey(s.sessionFile)?.repeat === 2,
      "rearm: исходный флаг взведён (repeat=2)",
    );

    // План на «сейчас» (интервал вокруг now), repeat=3.
    const { from, to } = intervalAroundNow(2, 2);
    await commandOf(s, "night-plan")(`${from}-${to} repeat=3`, ctx);
    const plan = readPlan();
    assert(plan !== null && plan.key === s.sessionFile, "rearm: план создан на текущую сессию");
    assert(
      plan !== null && plan.fromLocal === from && plan.repeat === 3,
      "rearm: аргументы интервала/repeat разобраны",
    );
    // Взвод плана НЕ взводит флаг сам (FR-014-1) — флаг остался прежним.
    assert(getArmForKey(s.sessionFile)?.repeat === 2, "rearm: план не тронул существующий флаг");

    // Внешний disarm (инцидент-сценарий: агент снял флаг по стоп-условию).
    externalDisarm(s);
    assert(getArmForKey(s.sessionFile) === null, "rearm: флаг исчез (внешний disarm)");

    // Sync-тик: arm-gone-переход — notify погашен планом; затем инвариант.
    await __syncWatchdogForTests();
    await __nightPlanTickForTests();
    await sleep(100);

    const arm = getArmForKey(s.sessionFile);
    assert(arm !== null, "rearm: инвариант перевзводит флаг после внешнего снятия");
    assert(
      arm?.repeat === 3,
      "rearm: перевзведён с repeat плана (3), не старым (2)",
    );
    assert(
      arm !== null && arm.expiresAt > (plan?.expiresAt ?? 0) - 1000,
      "rearm: TTL флага продлён до expiresAt плана",
    );

    const log = readFileSync(join(s.tmp, "armslog.log"), "utf8");
    assert(
      linesWith(log, "night-plan:auto-rearm").length === 1 &&
        linesWith(log, "night-plan:auto-rearm")[0].includes("auto-rearm:from-plan"),
      "rearm: armslog night-plan:auto-rearm (auto-rearm:from-plan)",
    );
    assert(
      linesWith(log, "night-plan:arm-gone-suppressed").length === 1,
      "rearm: arm-gone-notify погашен (night-plan:arm-gone-suppressed)",
    );
    assert(
      s.notifies.some((n) => n.type === "billing:night-plan-rearm"),
      "rearm: notify night-plan-rearm отправлен",
    );
    assert(
      !s.notifies.some((n) => n.type === "billing:night-plan-uninsured"),
      "rearm: uninsured-notify не нужен (перевзвод успешен)",
    );

    await shutdown(s);
  } finally {
    cleanup(s);
  }
}

// --- 2. ledger: сбросы в интервале плана (used + idle) ---------------------------

async function testLedgerUsedIdle(): Promise<void> {
  const s = await startScenario("pbi-np-ledger-");
  try {
    const ctx = makeCtx(s.sessionFile);
    const { from, to } = intervalAroundNow(2, 2);
    await commandOf(s, "night-plan")(`${from}-${to}`, ctx);
    const plan = readPlan();
    assert(plan !== null, "ledger: план создан");

    // Флаг застрахован → arm_phase armed.
    await commandOf(s, "cont-after-reset")("", ctx);

    // Used-окно: окно истекло с 3 вызовами и токенами → watchdog fire →
    // reset → emit на шину → ledger-строка.
    seedExpiredWindow(3, { input: 1_500_000, output: 200_000, cacheRead: 3_000_000 });
    await __fireWatchdogForTests();
    await sleep(150);

    // Idle-окно: флаг снят внешне, окно без вызовов → ручной сброс
    // (/billing-reset эмитит на ту же шину).
    externalDisarm(s);
    await mutateState((cur) =>
      cur === null
        ? { next: null }
        : {
            next: {
              ...cur,
              windowStartedAt: Date.now() - WINDOW_MS - 1000,
              callsInWindow: 0,
              windowInput: 0,
              windowOutput: 0,
              windowCacheRead: 0,
            },
          },
    );
    await commandOf(s, "billing-reset")("", ctx);
    await sleep(150);

    const rows = readLedger(plan?.nightDate ?? "?");
    assert(rows.length === 2, `ledger: обе строки записаны (got ${rows.length})`);
    const used = rows.find((r) => r.verdict === "used");
    const idle = rows.find((r) => r.verdict === "idle");
    assert(used !== undefined, "ledger: used-строка есть");
    assert(
      used?.callsInWindow === 3 &&
        used?.input === 1_500_000 &&
        used?.output === 200_000 &&
        used?.cacheRead === 3_000_000,
      "ledger: used-строка несёт вызовы и токены окна",
    );
    assert(used?.armPhase === "armed", "ledger: arm_phase=armed на момент сброса");
    assert(idle !== undefined, "ledger: idle-строка есть");
    assert(
      idle?.callsInWindow === 0 && idle?.input === 0,
      "ledger: idle-строка с нулевыми вызовами",
    );
    assert(idle?.armPhase === "none", "ledger: arm_phase=none после внешнего снятия");
    assert(
      used !== undefined && used.resetAt > 0 && used.epochMs > used.resetAt - 5000,
      "ledger: reset_at зафиксирован (момент сброса)",
    );
    assert(
      readFileSync(join(s.tmp, "nights", "ledger.csv"), "utf8").includes("armed"),
      "ledger: CSV на диске в nights/ledger.csv",
    );

    await shutdown(s);
  } finally {
    cleanup(s);
  }
}

// --- 3. утренний отчёт в toLocal --------------------------------------------------

async function testMorningReport(): Promise<void> {
  const s = await startScenario("pbi-np-morning-");
  // Grace сгоревшего таймера — 48 ч: previousOccurrence(to) при случайном
  // запуске теста около полуночи даёт «вчера», детерминизма ради расширяем.
  setNightPlanMorningGraceForTests(48 * 60 * 60 * 1000);
  try {
    const ctx = makeCtx(s.sessionFile);
    // Интервал: from = now-5 мин, to = now+1 мин — сброс (reset_at = now)
    // попадает ВНУТРЬ интервала плана, а утренний таймер стоит на будущее
    // to (не стреляет сам до cleanup); «наступление toLocal» эмулирует хук.
    const { from, to } = intervalAroundNow(5, 1);
    await commandOf(s, "night-plan")(`${from}-${to}`, ctx);
    const plan = readPlan();
    assert(plan !== null, "morning: план создан");

    // Окно ночи: used (2 вызова) → ledger-строка.
    seedExpiredWindow(2, { input: 900_000, output: 90_000, cacheRead: 0 });
    await __fireWatchdogForTests();
    await sleep(150);
    assert(readLedger(plan!.nightDate).length === 1, "morning: окно ночи в книге");

    // Токены окна: call-строка history.csv ПОСЛЕ сброса (в границах окна).
    await appendHistory({
      kind: "call",
      project: "C:/tmp/fake-project",
      session: "sess-night.jsonl",
      usage: { input: 1000, output: 200, cacheRead: 5000 },
    });

    // «Наступил toLocal»: утренний таймер сработал (хук — без wall-clock).
    await __fireMorningForTests();

    const file = reportPathFor(plan!.nightDate);
    assert(existsSync(file), "morning: report-<nightDate>.md записан");
    const md = readFileSync(file, "utf8");
    assert(md.includes(`version: ${VERSION}`), "morning: version в шапке (ночь на коде N)");
    assert(md.includes(`# Ночной отчёт — ${plan!.nightDate}`), "morning: шапка с датой ночи");
    assert(md.includes("used"), "morning: таблица окон с verdict");
    assert(md.includes("| 1000 | 200 | 5000 |"), "morning: токены окна из history.csv");
    assert(md.includes("использовано: 1"), "morning: итоги used/idle");
    const log = readFileSync(join(s.tmp, "armslog.log"), "utf8");
    assert(
      linesWith(log, "night-plan:morning-report").length >= 1,
      "morning: armslog night-plan:morning-report",
    );
    assert(
      s.notifies.some((n) => n.type === "billing:night-report"),
      "morning: notify night-report отправлен",
    );
    const report = s.notifies.find((n) => n.type === "billing:night-report");
    assert(
      report !== undefined && report.title.includes("1/1"),
      "morning: дайджест «использовано окон 1/1»",
    );

    // Анти-дубликат: повторный fire в ту же ночь не перезаписывает отчёт.
    await __fireMorningForTests();
    assert(
      linesWith(readFileSync(join(s.tmp, "armslog.log"), "utf8"), "night-plan:morning-report")
        .length === 1,
      "morning: повторный fire той же ночи — no-op (анти-дубликат)",
    );

    await shutdown(s);
  } finally {
    setNightPlanMorningGraceForTests(30 * 60_000);
    cleanup(s);
  }
}

// --- 4. /night-plan off ------------------------------------------------------------

async function testPlanOff(): Promise<void> {
  const s = await startScenario("pbi-np-off-");
  try {
    const ctx = makeCtx(s.sessionFile);
    const { from, to } = intervalAroundNow(2, 2);
    await commandOf(s, "night-plan")(`${from}-${to}`, ctx);
    assert(readPlan() !== null, "off: план взведён");

    // Флаг снят внешне; план снят командой → инвариант НЕ перевзводит.
    externalDisarm(s);
    await commandOf(s, "night-plan")("off", ctx);
    assert(readPlan() === null, "off: план снят (файл удалён)");

    await __nightPlanTickForTests();
    await sleep(100);
    assert(
      getArmForKey(s.sessionFile) === null,
      "off: инвариант не перевзводит флаг",
    );
    assert(
      s.notifies.length === 0,
      "off: ни rearm-, ни uninsured-notify",
    );

    // Сброс окна после снятия плана: ledger не пишется.
    seedExpiredWindow(5, { input: 100, output: 100, cacheRead: 100 });
    await commandOf(s, "billing-reset")("", ctx);
    await sleep(150);
    assert(readLedger().length === 0, "off: строк книги нет");

    // Утренний отчёт без плана не генерируется.
    await __fireMorningForTests();
    const files = existsSync(join(s.tmp, "nights"))
      ? readFileSync(join(s.tmp, "nights", "ledger.csv"), "utf8")
      : "";
    assert(
      s.notifies.every((n) => n.type !== "billing:night-report"),
      "off: night-report не отправлен",
    );

    // status без плана не падает.
    await commandOf(s, "night-plan")("status", ctx);

    await shutdown(s);
  } finally {
    cleanup(s);
  }
}

// --- 5. истёкший план игнорируется --------------------------------------------------

async function testExpiredPlanIgnored(): Promise<void> {
  const s = await startScenario("pbi-np-expired-");
  try {
    const ctx = makeCtx(s.sessionFile);
    const { from, to } = intervalAroundNow(2, 2);
    // План пишем напрямую: expiresAt в прошлом (команда так не умеет --
    // она всегда ставит toLocal+1ч в будущем).
    const now = Date.now();
    const expired: NightPlan = {
      key: s.sessionFile,
      fromLocal: from,
      toLocal: to,
      repeat: 3,
      backlogPath: null,
      createdAt: now - 3 * 60 * 60 * 1000,
      expiresAt: now - 1000,
      nightDate: "2026-10-25",
    };
    assert(await writePlan(expired), "expired: план записан напрямую");

    await __nightPlanTickForTests();
    await sleep(100);
    assert(
      getArmForKey(s.sessionFile) === null,
      "expired: истёкший план не перевзводит флаг",
    );
    assert(s.notifies.length === 0, "expired: notify не отправлены");
    const log = readFileSync(join(s.tmp, "armslog.log"), "utf8");
    assert(
      linesWith(log, "night-plan:").filter((l) => !l.includes("night-plan:")).length === 0 &&
        !linesWith(log, "night-plan:auto-rearm").length &&
        !linesWith(log, "night-plan:uninsured").length,
      "expired: инвариант молчит (утро, план мёртв)",
    );

    // Сброс окна: ledger-подписчик тоже игнорирует истёкший план.
    seedExpiredWindow(1, { input: 1, output: 1, cacheRead: 1 });
    await commandOf(s, "billing-reset")("", ctx);
    await sleep(150);
    assert(readLedger().length === 0, "expired: ledger не пишется");

    await shutdown(s);
  } finally {
    cleanup(s);
  }
}

// --- 6. arm() падает → uninsured с rate-limit ---------------------------------------

async function testBrokenArmsUninsured(): Promise<void> {
  const s = await startScenario("pbi-np-uninsured-");
  try {
    const ctx = makeCtx(s.sessionFile);
    const { from, to } = intervalAroundNow(2, 2);
    await commandOf(s, "night-plan")(`${from}-${to}`, ctx);
    const plan = readPlan();
    assert(plan !== null, "uninsured: план взведён, флага нет");

    // Ломаем arms.json: вместо файла — каталог. writeFileSync(tmp) ок,
    // renameSync(tmp, каталог) падает → arm() отвергает промис.
    mkdirSync(join(s.tmp, "arms.json"));
    assert(getArmForKey(s.sessionFile) === null, "uninsured: флага нет (arms сломан)");

    // Тик 1: arm() упал → armslog + notify.
    await __nightPlanTickForTests();
    await sleep(100);
    assert(
      s.notifies.filter((n) => n.type === "billing:night-plan-uninsured").length === 1,
      "uninsured: первый notify отправлен",
    );
    let log = readFileSync(join(s.tmp, "armslog.log"), "utf8");
    assert(
      linesWith(log, "night-plan:uninsured").length === 1,
      "uninsured: armslog-событие (каждое событие логируется)",
    );
    assert(
      linesWith(log, "night-plan:auto-rearm-error").length === 1,
      "uninsured: причина (arm-error) в armslog",
    );

    // Тик 2: rate-limit 10 мин — notify подавлен, armslog полный.
    await __nightPlanTickForTests();
    await sleep(100);
    assert(
      s.notifies.filter((n) => n.type === "billing:night-plan-uninsured").length === 1,
      "uninsured: rate-limit 10 мин подавляет повтор (10 мин — дефолт)",
    );
    log = readFileSync(join(s.tmp, "armslog.log"), "utf8");
    assert(
      linesWith(log, "night-plan:uninsured").length === 2,
      "uninsured: armslog пишется БЕЗ rate-limit (2 события)",
    );

    // Тик 3: окно пейсинга схлопнуто тест-хуком → повторный notify.
    setNightPlanEscalateForTests(0, 30 * 60_000);
    await __nightPlanTickForTests();
    await sleep(100);
    assert(
      s.notifies.filter((n) => n.type === "billing:night-plan-uninsured").length === 2,
      "uninsured: после истечения rate-окна notify повторяется",
    );
    log = readFileSync(join(s.tmp, "armslog.log"), "utf8");
    assert(
      linesWith(log, "night-plan:uninsured").length === 3,
      "uninsured: полный armslog (3 события)",
    );
    // Сценарий 23:23→09:33 из инцидента 24.10 невозможен: пользователь
    // узнаёт о снятии флага в ту же минуту (инвариант каждые 60 с).
    assert(
      s.notifies.every((n) => n.type !== "billing:night-plan-rearm"),
      "uninsured: ложных rearm-notify нет",
    );

    await shutdown(s);
  } finally {
    setNightPlanEscalateForTests(10 * 60_000, 30 * 60_000);
    cleanup(s);
  }
}

// --- runner -------------------------------------------------------------------------

async function main(): Promise<void> {
  // Spec 007: в unit/e2e-моках нет записей jsonl-сессии — заглушка
  // верификации доставки (как в watchdog.e2e).
  setVerifyDeliveredForTests(() => true);
  console.log("\n=== Night plan e2e tests (spec 014) ===");
  await testAutoRearmAfterExternalDisarm();
  await testLedgerUsedIdle();
  await testMorningReport();
  await testPlanOff();
  await testExpiredPlanIgnored();
  await testBrokenArmsUninsured();

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
