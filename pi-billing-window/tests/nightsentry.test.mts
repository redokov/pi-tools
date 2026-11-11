/**
 * nightsentry.test.mts -- unit-тесты модуля src/nightsentry.ts (spec 019, T1).
 *
 * Run: npx tsx tests/nightsentry.test.mts
 *
 * Только чистые функции: интервалы (incl. wrap полночь и границы 22:00/08:00),
 * предикаты дозора, дедуп, рендер сводки /night-check. Wall-clock не участвует:
 * все моменты фиксированные (создание Date от локальных компонент).
 */

import {
  NIGHT_FROM,
  NIGHT_TO,
  SENTRY_DEDUP_MS,
  ARM_GONE_GRACE_MS,
  INFRA_ESCALATE_MS,
  PING_STREAK_THRESHOLD,
  NIGHT_ARM_GONE_REASONS,
  inNightInterval,
  msBeforeNight,
  checkNoArmGap,
  checkArmGoneNightGap,
  dedupPassed,
  buildNightCheckReport,
  type NightCheckInput,
} from "../src/nightsentry.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.error(`FAIL: ${name}`);
  }
}

/** Локальный момент по компонентам (как в nightplan-тестах). */
function at(h: number, m: number, dayOffset = 0): number {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime() + dayOffset * 24 * 60 * 60 * 1000;
}

// ---- Константы ----
check("NIGHT_FROM=22:00", NIGHT_FROM === "22:00");
check("NIGHT_TO=08:00", NIGHT_TO === "08:00");
check("SENTRY_DEDUP_MS=1ч", SENTRY_DEDUP_MS === 3600_000);
check("ARM_GONE_GRACE_MS=2ч", ARM_GONE_GRACE_MS === 2 * 3600_000);
check("INFRA_ESCALATE_MS=6ч", INFRA_ESCALATE_MS === 6 * 3600_000);
check("PING_STREAK_THRESHOLD=10", PING_STREAK_THRESHOLD === 10);
check(
  "night arm-gone reasons включают confirmed-exhausted",
  NIGHT_ARM_GONE_REASONS.has("confirmed-exhausted"),
);
check(
  "night arm-gone reasons исключают ручное off",
  !NIGHT_ARM_GONE_REASONS.has("off"),
);

// ---- inNightInterval (wrap полночь, границы) ----
check("23:00 -- ночь", inNightInterval(at(23, 0)));
check("02:00 -- ночь", inNightInterval(at(2, 0)));
check("22:00 -- граница включена", inNightInterval(at(22, 0)));
check("08:00 -- граница исключена", !inNightInterval(at(8, 0)));
check("21:59 -- ещё не ночь", !inNightInterval(at(21, 59)));
check("08:01 -- уже не ночь", !inNightInterval(at(8, 1)));
check("12:00 -- день", !inNightInterval(at(12, 0)));
check("кастомный интервал 23:30-07:00: 23:30 внутри", inNightInterval(at(23, 30), "23:30", "07:00"));
check("кастомный интервал 23:30-07:00: 22:00 снаружи", !inNightInterval(at(22, 0), "23:30", "07:00"));
check("невалидный интервал -> false", !inNightInterval(at(23, 0), "25:00", "08:00"));

// ---- msBeforeNight ----
check("внутри ночи -> 0", msBeforeNight(at(23, 0)) === 0);
check("21:00 -> ~1ч до ночи", Math.abs(msBeforeNight(at(21, 0)) - 3600_000) < 2000);
check("09:00 -> ~13ч до ночи", Math.abs(msBeforeNight(at(9, 0)) - 13 * 3600_000) < 2000);
check("20:00 -> 2ч (граница grace)", msBeforeNight(at(20, 0)) <= ARM_GONE_GRACE_MS);
check("19:00 -> 3ч (вне grace)", msBeforeNight(at(19, 0)) > ARM_GONE_GRACE_MS);
check("невалидный from -> бесконечность", msBeforeNight(at(12, 0), "99:00") === Number.POSITIVE_INFINITY);

// ---- checkNoArmGap (FR-019-1) ----
check(
  "ночь + нет взвода + нет плана -> no-arm",
  checkNoArmGap({ nowMs: at(23, 0), armed: false, planActive: false }) === "no-arm",
);
check(
  "ночь + есть взвод -> null",
  checkNoArmGap({ nowMs: at(23, 0), armed: true, planActive: false }) === null,
);
check(
  "ночь + есть план -> null",
  checkNoArmGap({ nowMs: at(23, 0), armed: false, planActive: true }) === null,
);
check(
  "ночь + взвод и план -> null",
  checkNoArmGap({ nowMs: at(3, 0), armed: true, planActive: true }) === null,
);
check(
  "день без взвода -> null (дозор только про ночь)",
  checkNoArmGap({ nowMs: at(12, 0), armed: false, planActive: false }) === null,
);
check(
  "кастомная ночь 23:30: 23:00 без взвода -> null",
  checkNoArmGap({
    nowMs: at(23, 0),
    armed: false,
    planActive: false,
    nightFrom: "23:30",
    nightTo: "07:00",
  }) === null,
);
check(
  "кастомная ночь 23:30: 23:45 без взвода -> no-arm",
  checkNoArmGap({
    nowMs: at(23, 45),
    armed: false,
    planActive: false,
    nightFrom: "23:30",
    nightTo: "07:00",
  }) === "no-arm",
);

// ---- checkArmGoneNightGap (FR-019-2) ----
check(
  "confirmed-exhausted в ночи -> arm-gone-night",
  checkArmGoneNightGap({ nowMs: at(23, 30), reason: "confirmed-exhausted" }) ===
    "arm-gone-night",
);
check(
  "ttl-expired за 1ч до ночи -> arm-gone-night",
  checkArmGoneNightGap({ nowMs: at(21, 0), reason: "ttl-expired" }) ===
    "arm-gone-night",
);
check(
  "external-removal за 2ч до ночи (граница) -> arm-gone-night",
  checkArmGoneNightGap({ nowMs: at(20, 0), reason: "external-removal" }) !== null,
);
check(
  "confirmed-exhausted за 3ч до ночи -> null",
  checkArmGoneNightGap({ nowMs: at(19, 0), reason: "confirmed-exhausted" }) === null,
);
check(
  "ручной off в ночи -> null (осознанное действие)",
  checkArmGoneNightGap({ nowMs: at(23, 0), reason: "off" }) === null,
);
check(
  "unknown reason -> null",
  checkArmGoneNightGap({ nowMs: at(23, 0), reason: "something-else" }) === null,
);

// ---- dedupPassed ----
check("lastAt undefined -> true (первое оповещение)", dedupPassed(undefined, at(12, 0), SENTRY_DEDUP_MS));
check("lastAt 0 -> true", dedupPassed(0, at(12, 0), SENTRY_DEDUP_MS));
check("ровно 1ч назад -> true (граница включена)", dedupPassed(at(11, 0), at(12, 0), SENTRY_DEDUP_MS));
check("30 мин назад -> false", !dedupPassed(at(11, 30), at(12, 0), SENTRY_DEDUP_MS));
check("2ч назад -> true", dedupPassed(at(10, 0), at(12, 0), SENTRY_DEDUP_MS));
check("lastAt в будущем -> false", !dedupPassed(at(13, 0), at(12, 0), SENTRY_DEDUP_MS));
check("NaN lastAt -> true", dedupPassed(Number.NaN, at(12, 0), SENTRY_DEDUP_MS));

// ---- buildNightCheckReport (FR-019-5) ----

function baseInput(over: Partial<NightCheckInput>): NightCheckInput {
  return {
    nowMs: at(21, 30),
    windowStartedAt: at(21, 0),
    windowMs: 2 * 60 * 60 * 1000,
    callsInWindow: 40,
    windowInput: 1_200_000,
    windowOutput: 300_000,
    windowCacheRead: 800_000,
    armed: true,
    armRepeatLeft: 6,
    armExpiresAt: at(23, 30),
    planActive: true,
    planFrom: "22:00",
    planTo: "08:00",
    planRepeat: 6,
    planExpiredFile: false,
    pingModel: "zai/glm-5.3-flash",
    pingStatus: "ok",
    pingStreak: 0,
    pingDetail: "120ms",
    ...over,
  };
}

// Полный порядок: взвод есть, план есть, окно свежее -> ok.
{
  const r = buildNightCheckReport(baseInput({}));
  check("полный порядок -> вердикт ok", r.verdict.length === 0);
  check("полный порядок -> текст «можно запускать»", r.text.includes("можно запускать ночь"));
  check("текст содержит таблицу", r.text.includes("| Окно |"));
  check("токены отрендерены (1.2M)", r.text.includes("1.2M"));
}

// Разрыв no-arm.
{
  const r = buildNightCheckReport(baseInput({ armed: false, planActive: false }));
  check("нет взвода и плана -> no-arm", r.verdict.includes("no-arm"));
  check("no-arm: подсказка про /cont-after-reset", r.text.includes("/cont-after-reset"));
}

// Взвод есть, плана нет -> НЕ no-arm (страховка есть).
{
  const r = buildNightCheckReport(baseInput({ planActive: false }));
  check("взвод есть, плана нет -> нет разрыва", r.verdict.length === 0);
}

// window-low: до сброса < 30 мин.
{
  const r = buildNightCheckReport(
    baseInput({ nowMs: at(21, 35), windowStartedAt: at(19, 40) }),
  );
  check("окно на исходе (<30 мин) -> window-low", r.verdict.includes("window-low"));
}

// window-low: >80% окна прошло.
{
  const r = buildNightCheckReport(
    baseInput({ nowMs: at(21, 25), windowStartedAt: at(19, 40) }),
  );
  check("окно >80% прошло -> window-low", r.verdict.includes("window-low"));
}

// Окно свежее (10% прошло) -> не window-low.
{
  const r = buildNightCheckReport(
    baseInput({ nowMs: at(19, 52), windowStartedAt: at(19, 40) }),
  );
  check("окно свежее -> не window-low", !r.verdict.includes("window-low"));
}

// ping-dead.
{
  const r = buildNightCheckReport(
    baseInput({ pingStatus: "infra", pingStreak: 23, pingModel: "openai/gpt-oss:20b", pingDetail: "HTTP 404" }),
  );
  check("серия 23 -> ping-dead", r.verdict.includes("ping-dead"));
  check("ping-dead: текст про слепые сбросы", r.text.includes("слепыми"));
}

// ping streak 9 -> ещё не dead.
{
  const r = buildNightCheckReport(baseInput({ pingStreak: 9 }));
  check("серия 9 -> не ping-dead", !r.verdict.includes("ping-dead"));
}

// plan-expired-file.
{
  const r = buildNightCheckReport(
    baseInput({ planActive: false, planExpiredFile: true }),
  );
  check("протухший файл плана -> plan-expired-file", r.verdict.includes("plan-expired-file"));
  check("протухший файл: план активен -> не мусор", r.text.includes("файл-мусор"));
}

// Несколько разрывов сразу (реплика инцидента 10-11.11).
{
  const r = buildNightCheckReport(
    baseInput({
      nowMs: at(22, 30),
      windowStartedAt: at(20, 35),
      armed: false,
      planActive: false,
      planExpiredFile: true,
      pingStatus: "infra",
      pingStreak: 23,
      pingDetail: "HTTP 404",
    }),
  );
  check("инцидент-реплика: 4 разрыва", r.verdict.length === 4);
  check("инцидент-реплика: все коды", 
    r.verdict.includes("no-arm") &&
    r.verdict.includes("window-low") &&
    r.verdict.includes("ping-dead") &&
    r.verdict.includes("plan-expired-file"));
}

// Дефолтные прочерки (нет ping-данных, нет токенов).
{
  const r = buildNightCheckReport({
    nowMs: at(12, 0),
    windowStartedAt: at(10, 0),
    windowMs: 2 * 3600_000,
    callsInWindow: 0,
    armed: false,
    planActive: false,
    planExpiredFile: false,
  });
  check("минимальный вход: no-arm", r.verdict.includes("no-arm"));
  check("минимальный вход: прочерки в токенах", r.text.includes("—"));
  check("минимальный вход: не падает на ping", !r.verdict.includes("ping-dead"));
}

// ---- Итог ----
console.log(`\nnightsentry: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
