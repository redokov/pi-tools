/**
 * nightcreate.e2e.test.mts — e2e-сценарии /night-plan create (spec 016, T02).
 *
 * Run: npx tsx tests/nightcreate.e2e.test.mts
 *
 * Мок pi + реальные tmp-файлы. Проверяет: create пишет meta-prompt в nights dir,
 * НЕ создаёт план и runner state, НЕ отправляет сообщения; пустая цель →
 * usage без файла.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piBillingWindowFactory from "../src/index.ts";
import { setPaths as stateSetPaths, resetPaths as stateResetPaths } from "../src/state.ts";
import { setPaths as armsSetPaths, resetPaths as armsResetPaths } from "../src/arms.ts";
import {
  setPaths as historySetPaths,
  resetPaths as historyResetPaths,
} from "../src/history.ts";
import {
  setPaths as npSetPaths,
  resetPaths as npResetPaths,
  getNightsDir,
} from "../src/nightplan.ts";
import {
  setPaths as nrSetPaths,
  resetPaths as nrResetPaths,
} from "../src/nightrun-state.ts";
import { setPaths as nrlSetPaths, resetPaths as nrlResetPaths } from "../src/nightrun-log.ts";

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

type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;

function makeMockPi(): { pi: unknown; commands: Map<string, CommandHandler>; sends: unknown[] } {
  const commands = new Map<string, CommandHandler>();
  const sends: unknown[] = [];
  const pi = {
    events: { emit: () => {}, on: () => () => {} },
    on: () => {},
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

function makeCtx(sessionFile: string, notifies: string[]): unknown {
  return {
    mode: "tui",
    isIdle: () => true,
    model: { provider: "wormsoft", id: "test/model-1" },
    ui: { notify: (msg: unknown) => notifies.push(String(msg)), setStatus: () => {} },
    sessionManager: {
      getSessionFile: () => sessionFile,
      getCwd: () => "C:/Tools/fake-project",
      getEntries: () => [],
    },
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nightcreate-e2e-"));
  stateSetPaths(join(dir, "state.json"), join(dir, "state.lock"));
  armsSetPaths(join(dir, "arms.json"), join(dir, "arms.lock"));
  historySetPaths(join(dir, "history.csv"), join(dir, "history.lock"));
  npSetPaths(join(dir, "plan.json"), join(dir, "plan.lock"), join(dir, "nights"));
  nrSetPaths(join(dir, "nightrun.json"), join(dir, "nightrun.lock"));
  nrlSetPaths(join(dir, "transitions.jsonl"), join(dir, "transitions.lock"));

  const { pi, commands, sends } = makeMockPi();
  piBillingWindowFactory(pi as never);
  const nightPlan = commands.get("night-plan");
  assert(nightPlan !== undefined, "/night-plan registered");

  const notifies: string[] = [];
  const ctx = makeCtx(join(dir, "owner-session.jsonl"), notifies);

  try {
    // 1. create без цели → usage, ничего не пишет.
    await nightPlan!("create", ctx);
    assert(
      notifies.length === 1 && notifies[0].includes("формат"),
      "create without goal -> usage notify",
    );
    const filesAfterUsage = existsSync(join(getNightsDir()));
    assert(!filesAfterUsage, "no prompt file after usage error");

    // 2. create с целью: интервал по умолчанию.
    await nightPlan!("create доделай тесты spec 015", ctx);
    const date = new Date().toLocaleDateString("sv-SE");
    const outFile = join(getNightsDir(), `create-prompt-${date}.md`);
    assert(existsSync(outFile), "create writes meta-prompt file");
    const prompt = readFileSync(outFile, "utf8");
    assert(prompt.includes("C:/Tools/fake-project"), "prompt has project cwd");
    assert(prompt.includes("доделай тесты spec 015"), "prompt has goal");
    assert(
      prompt.includes("/night-plan 22:00-08:00 backlog="),
      "prompt has default-interval launch command",
    );
    assert(
      prompt.includes("backlog-") && prompt.includes(".ai"),
      "prompt suggests backlog path",
    );
    const lastNotify = notifies[notifies.length - 1];
    assert(lastNotify.includes(outFile), "notify shows prompt file path");
    assert(lastNotify.includes("НОВУЮ сессию"), "notify instructs new-session paste");

    // 3. create НЕ создаёт план и runner state, НЕ отправляет сообщения.
    assert(!existsSync(join(dir, "plan.json")), "create does NOT write plan file");
    assert(!existsSync(join(dir, "nightrun.json")), "create does NOT write runner state");
    assert(sends.length === 0, "create sends nothing");

    // 4. create с кастомным интервалом.
    await nightPlan!("create 23:00-07:00 почистить отчёты", ctx);
    const prompt2 = readFileSync(outFile, "utf8");
    assert(
      prompt2.includes("/night-plan 23:00-07:00 backlog="),
      "custom interval in launch command",
    );
    assert(prompt2.includes("почистить отчёты"), "custom goal in prompt");

    // 5. Неверный интервал → usage.
    await nightPlan!("create 25:00-99:00 цель", ctx);
    assert(
      notifies[notifies.length - 1].includes("интервал"),
      "invalid interval -> error notify",
    );
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
    `\n${failed === 0 ? "✓✓✓" : "✗"} nightcreate.e2e: ${passed} passed, ${failed} failed`,
  );
  if (failed > 0) process.exit(1);
}

void main();
