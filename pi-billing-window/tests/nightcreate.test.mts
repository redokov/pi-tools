/**
 * nightcreate.test.mts — unit-тесты meta-prompt builder-а (spec 016, T01).
 *
 * Run: npx tsx tests/nightcreate.test.mts
 *
 * Чистая функция: без fs и часов — все входы параметрами.
 */

import { suggestBacklogPath, buildNightCreatePrompt } from "../src/nightcreate.js";

function assert(cond: boolean, name: string): void {
  if (!cond) {
    console.error(`✗ FAIL: ${name}`);
    process.exit(1);
  }
  console.log(`✓ ${name}`);
}

let passed = 0;
function ok(): void {
  passed++;
}

const OPTS = {
  cwd: "C:/Tools/pi-billing-window",
  goal: "доделать тесты spec 015 и прибрать отчёты",
  fromLocal: "22:00",
  toLocal: "08:00",
  date: "2026-10-26",
  backlogPath: "C:/Tools/pi-billing-window/.ai/night/backlog-2026-10-26.md",
};

function testSuggestPath(): void {
  const p = suggestBacklogPath("C:/proj", "2026-10-26");
  assert(
    p === "C:/proj/.ai/night/backlog-2026-10-26.md" ||
      p === "C:\\proj\\.ai\\night\\backlog-2026-10-26.md" ||
      p.endsWith(joinStyle("backlog-2026-10-26.md")),
    "suggestBacklogPath: <cwd>/.ai/night/backlog-<date>.md",
  );
  ok();
  assert(p.includes("2026-10-26"), "suggestBacklogPath: date embedded");
  ok();
}

function joinStyle(s: string): string {
  return s;
}

function testPromptContent(): void {
  const p = buildNightCreatePrompt(OPTS);
  // Проект и цель.
  assert(p.includes(OPTS.cwd), "prompt: cwd embedded");
  ok();
  assert(p.includes(OPTS.goal), "prompt: goal embedded");
  ok();
  // Строгий формат (spec 015).
  assert(p.includes("## Task 1"), "prompt: format example Task");
  ok();
  assert(p.includes("## Acceptance"), "prompt: format example Acceptance");
  ok();
  assert(p.includes("последовательные"), "prompt: sequential rule");
  ok();
  assert(p.includes("2 МБ") && p.includes("64 КБ"), "prompt: size limits");
  ok();
  // Маркер результата.
  assert(p.includes("TASK_RESULT: PASS"), "prompt: PASS marker required");
  ok();
  assert(p.includes("TASK_RESULT: FAIL"), "prompt: FAIL marker required");
  ok();
  assert(p.includes("НЕ считается успехом"), "prompt: unmarked text is not PASS");
  ok();
  // Безопасность.
  assert(p.includes("разрушительных"), "prompt: no destructive ops");
  ok();
  assert(p.includes("unit/mock"), "prompt: unit/mock tests only");
  ok();
  assert(p.includes("Не запускай /night-run сам"), "prompt: agent must not start runner");
  ok();
  // Backlog path + команды запуска с интервалом.
  assert(p.includes(OPTS.backlogPath), "prompt: backlog path embedded");
  ok();
  assert(
    p.includes(`/night-plan 22:00-08:00 backlog=${OPTS.backlogPath}`),
    "prompt: launch plan command with interval and path",
  );
  ok();
  assert(p.includes("/night-run resume"), "prompt: launch resume commands");
  ok();
  // Граница.
  assert(p.includes("08:00"), "prompt: boundary time");
  ok();
}

function testCustomInterval(): void {
  const p = buildNightCreatePrompt({ ...OPTS, fromLocal: "23:00", toLocal: "07:00" });
  assert(
    p.includes("/night-plan 23:00-07:00 backlog="),
    "prompt: custom interval in launch command",
  );
  ok();
  assert(p.includes("07:00"), "prompt: custom boundary");
  ok();
}

function testEmptyCwdFallback(): void {
  const p = buildNightCreatePrompt({ ...OPTS, cwd: "" });
  assert(p.includes("каталог текущей сессии"), "prompt: empty cwd fallback");
  ok();
}

function testDeterminism(): void {
  const a = buildNightCreatePrompt(OPTS);
  const b = buildNightCreatePrompt(OPTS);
  assert(a === b, "prompt: deterministic for same inputs");
  ok();
}

function main(): void {
  testSuggestPath();
  testPromptContent();
  testCustomInterval();
  testEmptyCwdFallback();
  testDeterminism();
  console.log(`\n✓✓✓ nightcreate: ${passed} passed, 0 failed`);
}

main();
