/**
 * nightplan-active.test.mts -- unit-тесты readActivePlan (spec 019, FR-019-6:
 * уборка протухшего файла плана ночи).
 *
 * Run: npx tsx tests/nightplan-active.test.mts
 *
 * Инцидент 2026-11-10→11: nightplan.json протух с 31.10 (другой проект,
 * expiresAt давно прошёл) и сбивал диагностику. readActivePlan: истёкший
 * план = «нет плана» + удаление файла под лок + пометка в armslog.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  setPaths as npSetPaths,
  resetPaths as npResetPaths,
  getPlanFile,
  readPlan,
  writePlan,
  readActivePlan,
  type NightPlan,
} from "../src/nightplan.js";
import { setArmsLogPath, resetArmsLogPath } from "../src/armslog.js";

const tmpDir = mkdtempSync(join(tmpdir(), "pbw-nightplan-active-"));
const planFile = join(tmpDir, "nightplan.json");
const planLock = join(tmpDir, "nightplan.lock");
const nightsDir = join(tmpDir, "nights");
const armsLogFile = join(tmpDir, "arms.log");

npSetPaths(planFile, planLock, nightsDir);
setArmsLogPath(armsLogFile);

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}`);
  }
}

function makePlan(over: Partial<NightPlan>): NightPlan {
  const now = Date.now();
  return {
    key: "C:\\sessions\\owner.jsonl",
    fromLocal: "22:00",
    toLocal: "08:00",
    repeat: 6,
    backlogPath: null,
    createdAt: now,
    expiresAt: now + 10 * 60 * 60 * 1000,
    nightDate: "2026-11-11",
    ...over,
  };
}

async function main(): Promise<void> {
  console.log("readActivePlan (FR-019-6):");

  // Файла нет -> null, ничего не создаётся.
  check("нет файла -> null", (await readActivePlan()) === null);
  check("нет файла -> файл не создан", !existsSync(planFile));

  // Активный план -> возвращается, файл на месте, armslog чист.
  await writePlan(makePlan({}));
  const active = await readActivePlan();
  check("активный план -> возвращается", active !== null && active.nightDate === "2026-11-11");
  check("активный план -> файл сохранён", existsSync(planFile));
  check("активный план -> readPlan согласован", readPlan()?.nightDate === "2026-11-11");
  check("активный план -> armslog без пометки", !existsSync(armsLogFile));

  // Истёкший план -> null + файл удалён + пометка в armslog.
  const now = Date.now();
  await writePlan(
    makePlan({
      createdAt: now - 12 * 60 * 60 * 1000,
      expiresAt: now - 60 * 60 * 1000, // истёк час назад
      nightDate: "2026-10-31",
    }),
  );
  const expired = await readActivePlan();
  check("истёкший план -> null", expired === null);
  check("истёкший план -> файл удалён", !existsSync(planFile));
  let logText = "";
  try {
    logText = readFileSync(armsLogFile, "utf8");
  } catch {}
  check(
    "уборка -> пометка night-plan:expired-cleanup в armslog",
    logText.includes("night-plan:expired-cleanup") &&
      logText.includes("удалён"),
  );

  // Повторное чтение после уборки — тихий null, без новой пометки.
  const again = await readActivePlan();
  check("после уборки -> тихий null", again === null);
  let logText2 = "";
  try {
    logText2 = readFileSync(armsLogFile, "utf8");
  } catch {}
  check("после уборки -> пометка одна", logText2.split("night-plan:expired-cleanup").length === 2);

  // Boundary: expiresAt в ближайшем будущем -> ещё активен.
  await writePlan(makePlan({ expiresAt: Date.now() + 2000 }));
  const boundary = await readActivePlan();
  check("expiresAt на 2 с вперед -> план ещё активен", boundary !== null);

  // ---- Teardown ----
  npResetPaths();
  resetArmsLogPath();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}

  console.log(`\nnightplan-active: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
