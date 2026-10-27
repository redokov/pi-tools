/**
 * nightrun.e2e.test.mts — integration-сценарии /night-run (spec 015, T08/T09).
 *
 * Run: npx tsx tests/nightrun.e2e.test.mts
 *
 * Стиль nightplan.e2e.test.mts: мок pi (eventBus, registerCommand,
 * sendUserMessage), реальные tmp-файлы. Проверяет:
 *  1. /night-plan ... backlog=<path> только сохраняет ссылку (не исполняет);
 *  2. /night-run resume инициализирует runner из плана с backlog;
 *  3. /night-plan не запускает runner (state не создаётся/не меняется);
 *  4. дневная задача (/billing-reset) не двигает night cursor;
 *  5. user stop переживает перевзвод /night-plan (auto-rearm не сбрасывает).
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piBillingWindowFactory, {
  setArmsLogPath,
  setVerifyDeliveredForTests,
} from "../src/index.ts";
import {
  writeStateSync,
  setPaths as stateSetPaths,
  resetPaths as stateResetPaths,
} from "../src/state.ts";
import {
  setPaths as npSetPaths,
  resetPaths as npResetPaths,
  readPlan,
} from "../src/nightplan.ts";
import {
  setPaths as armsSetPaths,
  resetPaths as armsResetPaths,
} from "../src/arms.ts";
import {
  setPaths as historySetPaths,
  resetPaths as historyResetPaths,
} from "../src/history.ts";
import {
  setPaths as nrSetPaths,
  resetPaths as nrResetPaths,
  readState as readNightRunState,
} from "../src/nightrun-state.ts";
import {
  setPaths as nrlSetPaths,
  resetPaths as nrlResetPaths,
} from "../src/nightrun-log.ts";

// --- assert harness ---------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(cond: boolean, name: string): void {
  if (cond) {
    passed++;
    console.log(`✓ ${name}`);
  } else {
    failed++;
    console.error(`✗ FAIL: ${name}`);
  }
}

// --- mock pi ------------------------------------------------------------------------

type SessionHandler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;

function makeMockPi(): {
  pi: unknown;
  commands: Map<string, CommandHandler>;
  sends: unknown[];
} {
  const commands = new Map<string, CommandHandler>();
  const sends: unknown[] = [];
  const busSubs = new Map<string, Array<(d: unknown) => void>>();
  const pi = {
    events: {
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
    on: (_ev: string, _h: SessionHandler) => {},
    registerCommand: (name: string, spec: { handler: CommandHandler }) => {
      commands.set(name, spec.handler);
    },
    sendUserMessage: async (content: unknown) => {
      sends.push(content);
      return undefined;
    },
  };
  return { pi, commands, sends };
}

function makeCtx(sessionFile: string): unknown {
  return {
    mode: "tui",
    isIdle: () => true,
    model: { provider: "wormsoft", id: "test/model-1" },
    ui: { notify: () => {}, setStatus: () => {} },
    sessionManager: {
      getSessionFile: () => sessionFile,
      getCwd: () => "C:/tmp/fake-project",
      getEntries: () => [],
    },
  };
}

// --- main -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nightrun-e2e-"));
  const backlogPath = join(dir, "backlog.md");
  writeFileSync(
    backlogPath,
    "## Task 1\nЗадача один.\n\n## Acceptance\nКритерий один.\n\n" +
      "## Task 2\nЗадача два.\n\n## Acceptance\nКритерий два.\n",
    "utf8",
  );

  stateSetPaths(join(dir, "state.json"), join(dir, "state.lock"));
  armsSetPaths(join(dir, "arms.json"), join(dir, "arms.lock"));
  historySetPaths(join(dir, "history.csv"), join(dir, "history.lock"));
  npSetPaths(join(dir, "plan.json"), join(dir, "plan.lock"), join(dir, "nights"));
  nrSetPaths(join(dir, "nightrun.json"), join(dir, "nightrun.lock"));
  nrlSetPaths(join(dir, "transitions.jsonl"), join(dir, "transitions.lock"));

  writeStateSync({
    provider: "wormsoft",
    windowStartedAt: Date.now(),
    windowMs: 2 * 60 * 60 * 1000,
    lastResetAt: 0,
    resetCount: 1,
    callsInWindow: 0,
  });

  const { pi, commands, sends } = makeMockPi();
  piBillingWindowFactory(pi as never);

  const nightRun = commands.get("night-run");
  const nightPlan = commands.get("night-plan");
  const billingReset = commands.get("billing-reset");
  assert(nightRun !== undefined, "command /night-run registered");
  assert(nightPlan !== undefined, "command /night-plan registered");
  assert(billingReset !== undefined, "command /billing-reset registered");

  const ctx = makeCtx(join(dir, "owner-session.jsonl"));

  try {
    // 1. /night-plan backlog=<path> — только ссылка, runner НЕ стартует.
    await nightPlan!(`00:00-23:59 backlog=${backlogPath}`, ctx);
    const plan = readPlan();
    assert(plan !== null, "plan created with backlog");
    assert(plan!.backlogPath === backlogPath, "plan stores backlog reference");
    assert(
      !existsSync(join(dir, "nightrun.json")),
      "/night-plan does NOT create runner state",
    );
    assert(sends.length === 0, "/night-plan sends nothing (reference-only)");

    // 2. /night-run status — runner не инициализирован, ничего не меняет.
    await nightRun!("status", ctx);
    assert(!existsSync(join(dir, "nightrun.json")), "status changes nothing");

    // 3. /night-run resume (без state) — инициализация из плана.
    await nightRun!("resume", ctx);
    let st = readNightRunState();
    assert(st !== null, "resume initialized runner state from plan");
    assert(st!.currentTask === 1, "state starts at task 1");
    assert(st!.backlogHash.length > 0, "state stores backlog hash");

    // 4. /night-run resume (state есть) — продолжение текущей задачи +
    //    явный dispatch (production wiring: resume → nightRunTick).
    // Доставка верифицируется моком verifyDelivered (владельца нет — без
    // мока всегда misroute).
    setVerifyDeliveredForTests(() => true);
    await nightRun!("resume", ctx);
    st = readNightRunState();
    assert(st!.status === "running", "resume -> running");
    assert(st!.currentTask === 1, "resume does NOT skip current task");
    // Dispatch отправлен: РОВНО ОДНА задача, не весь Markdown.
    await new Promise((r) => setTimeout(r, 50));
    assert(sends.length === 1, "resume dispatched exactly one message");
    const sent = String(sends[0]);
    assert(sent.includes("Задача один"), "dispatched prompt has task 1");
    assert(!sent.includes("Задача два"), "prompt has NO task 2 (no giant prompt)");
    assert(sent.includes("TASK_RESULT: PASS"), "prompt requires result marker");
    st = readNightRunState();
    assert(st!.status === "awaiting-result", "durable awaiting-result after dispatch");

    // 5. /night-run stop — user stop.
    await nightRun!("stop", ctx);
    st = readNightRunState();
    assert(st!.userStop === true && st!.status === "stopped", "stop -> stopped+userStop");
    const sendsAfterStop = sends.length;

    // 6. /night-plan перевзвод (аналог auto-rearm) НЕ сбрасывает user stop
    //    и не запускает runner.
    await nightPlan!(`00:00-23:59 backlog=${backlogPath}`, ctx);
    st = readNightRunState();
    assert(st!.userStop === true, "user stop survives /night-plan re-arm");
    assert(st!.status === "stopped", "plan re-arm does not restart runner");
    assert(sends.length === sendsAfterStop, "plan re-arm sends no backlog task");

    // 7. Дневная задача (/billing-reset) не двигает night cursor.
    await billingReset!("", ctx);
    st = readNightRunState();
    assert(st!.currentTask === 1, "daytime reset does NOT advance night cursor");
    assert(st!.status === "stopped", "daytime reset does NOT change night status");

    // 8. /night-run status показывает состояние после всех переходов.
    await nightRun!("status", ctx);
    const raw = readFileSync(join(dir, "nightrun.json"), "utf8");
    assert(raw.includes("\"userStop\": true"), "state file durable after status");

    // 9. Transition log записан и содержит причины.
    const logRaw = readFileSync(join(dir, "transitions.jsonl"), "utf8");
    assert(logRaw.includes("user-stop"), "transition log has user-stop reason");
    assert(logRaw.includes("user-init"), "transition log has init record");
    assert(logRaw.includes("user-resume"), "transition log has resume record");
  } finally {
    stateResetPaths();
    armsResetPaths();
    historyResetPaths();
    npResetPaths();
    nrResetPaths();
    nrlResetPaths();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }

  console.log(
    `\n${failed === 0 ? "✓✓✓" : "✗"} nightrun.e2e: ${passed} passed, ${failed} failed`,
  );
  if (failed > 0) process.exit(1);
}

void main();
