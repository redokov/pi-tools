/**
 * attribution.test.mts -- spec 006, T-01 (FR-101/FR-103/FR-301 + NR-3):
 * аддитивный блок токенов в деталях fire-путь-строк armslog.
 *
 * Грамматика (§7.1 D-606), аддитивность В КОНЦЕ detail:
 *   <существующий detail>  key=<basename> pid=<pid> host=<host> ep=<epoch>
 *       [ctx=stale src=<probe|epoch-guard|drain>] [epoch-mismatch=1]
 *
 * RED: prod-код ещё не несёт токены withAttr -- ассерты грамматики должны
 * FAIL, совместимость (.includes()-подстроки) остаётся зелёной.
 *
 * Run: timeout 120 npx tsx tests/attribution.test.mts
 *
 * События провоцируются ЕСТЕСТВЕННО через существующий API расширения
 * (session_start / session_shutdown / cont-after-reset / watchdog / retry),
 * НЕ через несуществующие экспорты (withAttr/probe ещё нет): ассертится
 * ТОЛЬКО текст строк в лог-файле.
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
  setStaleRetryMsForTests,
  __resetStaleStateForTests,
  __syncWatchdogForTests,
  __fireWatchdogForTests,
  __retryTickForTests,
} from "../src/index.ts";
import {
  mutateState,
  setPaths as stateSetPaths,
  resetPaths as stateResetPaths,
} from "../src/state.ts";
import {
  setPaths as armsSetPaths,
  resetPaths as armsResetPaths,
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

function makeMockPi(opts: { failStale?: boolean } = {}): {
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
    sendUserMessage: async (content: unknown, o?: unknown) => {
      // failStale -- piApi "ctx is stale" mid-send: probe-детекция D-601.
      if (opts.failStale) {
        throw new Error("extension ctx is stale");
      }
      sends.push({ content, opts: o });
      return undefined;
    },
  };
  return { pi, handlers, commands, sends };
}

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

/** Backdate a window reset; grace 60 s -> delay ~ (60s - backMs). */
async function backdateReset(backMs = 60_000): Promise<void> {
  await mutateState((cur) => {
    if (cur === null) throw new Error("state file missing");
    return { next: { ...cur, lastResetAt: Date.now() - backMs } };
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

// --- log line helpers ------------------------------------------------------------

function linesWith(log: string, event: string): string[] {
  return log
    .split("\n")
    .filter((l) => l.includes(`| ${event} |`) || l.trim().endsWith(`| ${event}`));
}

function lastLine(log: string, event: string): string | undefined {
  const a = linesWith(log, event);
  return a[a.length - 1];
}

/** Первая fire-путь-строка, содержащая «попытка N/6» (прогрессия D-204). */
function attemptLine(log: string, n: number): string | undefined {
  return log.split("\n").find((l) => l.includes(`попытка ${n}/6`));
}

/** Грамматика §7.1: блок токенов (пид/host/ep есть на строке). */
function hasTokenBlock(line: string): boolean {
  return /\bpid=\d+/.test(line) && /\bhost=\S+/.test(line) && /\bep=\d+/.test(line);
}

function countKey(line: string): number {
  return (line.match(/\bkey=/g) ?? []).length;
}

function epOf(line: string): string | undefined {
  return (/\bep=(\d+)/.exec(line) ?? [])[1];
}

function pidOf(line: string): string | undefined {
  return (/\bpid=(\d+)/.exec(line) ?? [])[1];
}

// --- 1. Базовый fire-путь: session-start / arm-seen несёт блок (без дубля key=)

async function testBasicAttr(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-attr-basic-"));
  applyPaths(tmp);
  try {
    await seedFreshWindow();
    const { pi, handlers, commands } = makeMockPi();
    piBillingWindowFactory(pi as never);
    const ctx = makeCtx(join(tmp, "sess-1.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);
    await __syncWatchdogForTests();

    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    const sstart = lastLine(log, "session-start");
    const seen = lastLine(log, "arm-seen");

    assert(
      sstart !== undefined && hasTokenBlock(sstart),
      "basic: session-start несёт блок токенов pid= host= ep=",
    );
    assert(
      sstart !== undefined && countKey(sstart) === 1,
      "basic: session-start: key= ровно один (нет дубля)",
    );
    assert(
      sstart !== undefined && sstart.includes("reason="),
      "basic: session-start: старые подстроки целы (reason=)",
    );
    assert(
      seen !== undefined && hasTokenBlock(seen),
      "basic: arm-seen несёт блок токенов pid= host= ep=",
    );
    assert(
      seen !== undefined && countKey(seen) === 1,
      "basic: arm-seen: key= ровно один (нет дубля)",
    );
  } finally {
    cleanupPaths(tmp);
  }
}

// --- 2. Stale-эпоха: drain на fire, epoch-guard на waiting-прогрессии, капитуляция

async function testStaleEpochDrain(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-attr-stale-"));
  applyPaths(tmp);
  try {
    await seedFreshWindow();
    const { pi, handlers, commands } = makeMockPi();
    piBillingWindowFactory(pi as never);
    const sessionFile = join(tmp, "sess-2.jsonl");
    const ctx = makeCtx(sessionFile);
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);
    await __syncWatchdogForTests();

    // Замена сессии без свежих ссылок -> piApiEpoch(0) !== sessionEpoch(1).
    await handlerOf(handlers, "session_shutdown")({ reason: "replacement" }, ctx);
    await handlerOf(handlers, "session_start")(
      { reason: "replacement" },
      makeCtx(sessionFile),
    );

    const logA = readFileSync(join(tmp, "armslog.log"), "utf8");
    const waiting0 = lastLine(logA, "replacement:waiting");
    assert(
      waiting0 !== undefined && hasTokenBlock(waiting0),
      "stale: replacement:waiting несёт блок токенов pid= host= ep=",
    );
    assert(
      waiting0 !== undefined && countKey(waiting0) === 1,
      "stale: replacement:waiting: key= ровно один",
    );

    // Fire при мёртвых ссылках: backdate 30 s при grace 60 s (delay 30 s,
    // сам не выстрелит) -> форс-файр -> fire:reset-ready с drain.
    await backdateReset(30_000);
    await __fireWatchdogForTests();
    const logB = readFileSync(join(tmp, "armslog.log"), "utf8");
    const frr = lastLine(logB, "fire:reset-ready");
    assert(
      frr !== undefined && hasTokenBlock(frr),
      "stale: fire:reset-ready несёт блок токенов pid= host= ep=",
    );
    assert(
      frr !== undefined &&
        /ctx=stale\s+src=drain\s+epoch-mismatch=1/.test(frr),
      "stale: fire:reset-ready несёт ctx=stale src=drain epoch-mismatch=1 (мёртвый piApi)",
    );
    assert(
      frr !== undefined && frr.includes("отправляю «продолжи»"),
      "stale: fire:reset-ready: старые подстроки целы «продолжи»",
    );

    // Waiting-прогрессия «попытка N/6» -> каждая несёт epoch-guard.
    const attempts: Array<string | undefined> = [];
    for (let n = 1; n <= 6; n++) {
      setStaleRetryMsForTests(0);
      await __retryTickForTests();
      const logN = readFileSync(join(tmp, "armslog.log"), "utf8");
      attempts.push(attemptLine(logN, n));
    }
    for (let n = 0; n < 6; n++) {
      const l = attempts[n];
      assert(
        l !== undefined &&
          /ctx=stale\s+src=epoch-guard\s+epoch-mismatch=1/.test(l),
        `stale: попытка ${n + 1}/6 несёт ctx=stale src=epoch-guard epoch-mismatch=1`,
      );
    }
    assert(
      attempts.every(
        (l) => l !== undefined && /\bep=\d+/.test(l) && /\bpid=\d+/.test(l),
      ),
      "stale: каждая попытка N/6 несёт свой ep= и pid=",
    );
    assert(
      attempts.every((l) => l !== undefined && epOf(l) !== undefined && pidOf(l) !== undefined) &&
        new Set(attempts.map((l) => epOf(l ?? ""))).size === 1 &&
        new Set(attempts.map((l) => pidOf(l ?? ""))).size === 1,
      "stale: ep=/pid= согласованы в прогрессии одной сессии",
    );
    assert(
      attempts[0] !== undefined &&
        /\bpiApiEpoch=\d+/.test(attempts[0]) &&
        /\bsessionEpoch=\d+/.test(attempts[0]),
      "stale: попытка 1/6: деталь эпох цела (piApiEpoch=/sessionEpoch=)",
    );

    // Капитуляция после 6 попыток -> отдельная строка с токенами.
    const logC = readFileSync(join(tmp, "armslog.log"), "utf8");
    const cap = lastLine(logC, "capitulation:after-6");
    assert(
      cap !== undefined && hasTokenBlock(cap),
      "stale: capitulation:after-6 несёт блок токенов pid= host= ep=",
    );
    assert(
      cap !== undefined && countKey(cap) === 1,
      "stale: capitulation:after-6: key= ровно один",
    );
    assert(
      cap !== undefined && cap.includes("флаг снят"),
      "stale: capitulation:after-6: старые подстроки целы (флаг снят)",
    );

    // После капитуляции sync видит arm-gone (тоже fire-путь).
    await __syncWatchdogForTests();
    const logD = readFileSync(join(tmp, "armslog.log"), "utf8");
    const gone = lastLine(logD, "arm-gone");
    assert(
      gone !== undefined && hasTokenBlock(gone),
      "stale: arm-gone несёт блок токенов pid= host= ep=",
    );
    assert(
      gone !== undefined && gone.includes("флаг исчез/истёк"),
      "stale: arm-gone: старые подстроки целы",
    );
  } finally {
    cleanupPaths(tmp);
  }
}

// --- 3. Probe: sendUserMessage бросает «stale» -> ctx=stale src=probe ----------

async function testProbeSendError(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-attr-probe-"));
  applyPaths(tmp);
  try {
    await seedFreshWindow();
    const { pi, handlers, commands } = makeMockPi({ failStale: true });
    piBillingWindowFactory(pi as never);
    const ctx = makeCtx(join(tmp, "sess-3.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);
    await backdateReset(); // 60 s назад, grace 60 s -> fireAt ~ now, сам выстрелит
    await __syncWatchdogForTests(); // пере-арм: arm-seen + пересчёт fireAt
    await sleep(500);

    const log = readFileSync(join(tmp, "armslog.log"), "utf8");
    const se = lastLine(log, "send-error:stale");
    assert(
      se !== undefined && hasTokenBlock(se),
      "probe: send-error:stale несёт блок токенов pid= host= ep=",
    );
    assert(
      se !== undefined && /ctx=stale\s+src=probe/.test(se),
      "probe: send-error:stale несёт ctx=stale src=probe (send упал по stale)",
    );
    assert(
      se !== undefined && countKey(se) === 1,
      "probe: send-error:stale: key= ровно один",
    );
    assert(
      se !== undefined && se.includes("попытка 1/6"),
      "probe: send-error:stale: прогрессия попытка 1/6 цела",
    );
    assert(
      se !== undefined && se.includes("повтор через"),
      "probe: send-error:stale: старые подстроки целы (повтор через)",
    );

    // Прогрессия: каждая попытка со своей атрибуцией ep/pid.
    for (let n = 2; n <= 6; n++) {
      setStaleRetryMsForTests(0);
      await __retryTickForTests();
    }
    const log2 = readFileSync(join(tmp, "armslog.log"), "utf8");
    const attempts: string[] = [];
    for (let n = 1; n <= 6; n++) {
      const l = attemptLine(log2, n);
      if (l !== undefined) attempts.push(l);
    }
    assert(
      attempts.length === 6 &&
        attempts.every((l) => /\bep=\d+/.test(l) && /\bpid=\d+/.test(l)),
      "probe: каждая попытка N/6 несёт свой ep= и pid=",
    );
    assert(
      attempts.length === 6 &&
        attempts.every(
          (l) => epOf(l) !== undefined && pidOf(l) !== undefined &&
            new Set(attempts.map((x) => epOf(x))).size === 1 &&
            new Set(attempts.map((x) => pidOf(x))).size === 1,
        ),
      "probe: каждая попытка N/6 несёт согласованный ep= и pid=",
    );
  } finally {
    cleanupPaths(tmp);
  }
}

// --- 4. Успешный fire-путь: fire:send-ok / fire:confirmed c токенами ----------

async function testSuccessPathTokens(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "pbi-attr-ok-"));
  applyPaths(tmp);
  try {
    await seedFreshWindow();
    const { pi, handlers, commands } = makeMockPi();
    piBillingWindowFactory(pi as never);
    const ctx = makeCtx(join(tmp, "sess-4.jsonl"));
    await handlerOf(handlers, "session_start")({}, ctx);
    await commandOf(commands, "cont-after-reset")("", ctx);
    await backdateReset(); // 60 s назад, grace 60 s -> fireAt ~ now, сам выстрелит
    await __syncWatchdogForTests(); // пере-арм: arm-seen + пересчёт fireAt
    await sleep(500);

    const logA = readFileSync(join(tmp, "armslog.log"), "utf8");
    const ok = lastLine(logA, "fire:send-ok");
    assert(
      ok !== undefined && hasTokenBlock(ok),
      "success: fire:send-ok несёт блок токенов pid= host= ep=",
    );
    assert(
      ok !== undefined && ok.includes("«продолжи»"),
      "success: fire:send-ok: старые подстроки целы («продолжи»)",
    );

    // Успешный ответ провайдера подтверждает pending-arm.
    await handlerOf(handlers, "after_provider_response")(
      { status: 200, headers: {} },
      ctx,
    );
    const logB = readFileSync(join(tmp, "armslog.log"), "utf8");
    const conf = lastLine(logB, "fire:confirmed");
    assert(
      conf !== undefined && hasTokenBlock(conf),
      "success: fire:confirmed несёт блок токенов pid= host= ep=",
    );
    assert(
      conf !== undefined && conf.includes("«продолжи»"),
      "success: fire:confirmed: старые подстроки целы («продолжи»)",
    );
  } finally {
    cleanupPaths(tmp);
  }
}

// --- runner ----------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    "\n=== Attribution tests (spec 006: токены key/pid/host/ep + stale-признаки) ===",
  );

  __resetStaleStateForTests();
  await testBasicAttr();
  __resetStaleStateForTests();
  await testStaleEpochDrain();
  __resetStaleStateForTests();
  await testProbeSendError();
  __resetStaleStateForTests();
  await testSuccessPathTokens();

  console.log("\n======================================");
  for (const r of results) console.log(r);
  console.log("======================================");
  console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
