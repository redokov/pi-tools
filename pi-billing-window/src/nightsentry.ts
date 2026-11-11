/**
 * nightsentry.ts -- ночной дозор + предстарт ночи (spec 019).
 *
 * Закрывает разрывы инцидента 2026-11-10→11 (DevRepoProxy night003):
 * ночь работала, сессия погибла от 429, но ни взвода cont-after-reset,
 * ни плана ночи не было -- и никто не предупредил.
 *
 * Три ответственности, ВСЕ чистые (без I/O, NFR-019-2):
 *   (a) ночная интервальная математика -- реэкспорт обёртки над
 *       nightplan.inInterval (wrap полночи) + hoursBeforeNight;
 *   (b) предикаты дозора: checkNoArmGap (FR-019-1: ночь + нет взвода +
 *       нет плана), checkArmGoneNightGap (FR-019-2: arm-gone в ночи или
 *       за ARM_GONE_GRACE_MS до неё), dedupPassed (чистый дедуп);
 *   (c) сборка предстартовой сводки /night-check (FR-019-5):
 *       buildNightCheckReport -- окно/взвод/план/пинг/вердикт.
 *
 * Дедуп-отметки времени хранит вызывающий код в state.sentry (NFR-019-4);
 * этот модуль только решает, пора ли (dedupPassed).
 *
 * Passive observer: модуль ничего не бросает, ничего не пишет.
 */

import { inInterval, nextOccurrence } from "./nightplan.js";

// ---- Constants (FR-019-1/2/4) ----

/** Начало ночи по умолчанию (локальное время), как в /night-plan. */
export const NIGHT_FROM = "22:00";
/** Конец ночи по умолчанию (локальное время), как в /night-plan. */
export const NIGHT_TO = "08:00";

/** Дедуп оповещения «ночь без страховки»: не чаще раза в час (FR-019-1). */
export const SENTRY_DEDUP_MS = 60 * 60 * 1000;
/** Arm-gone интересен ночи, если случился в ней или за 2 ч до неё (FR-019-2). */
export const ARM_GONE_GRACE_MS = 2 * 60 * 60 * 1000;
/** Период повтора эскалации серии infra-отказов пинга (FR-019-4). */
export const INFRA_ESCALATE_MS = 6 * 60 * 60 * 1000;
/** Порог серии infra-отказов пинга для эскалации (FR-019-4). */
export const PING_STREAK_THRESHOLD = 10;

/**
 * Причины arm-gone, которые оставляют ночь без страховки «незаметно».
 * Ручное снятие (`kind=off`, сам пользователь) исключено -- это осознанное
 * действие (parity со spec 011 FR-011-1).
 */
export const NIGHT_ARM_GONE_REASONS: ReadonlySet<string> = new Set([
  "confirmed-exhausted",
  "repeat-exhausted",
  "ttl-expired",
  "external-removal",
]);

// ---- Interval math (FR-019-1) ----

/** Локальное время сейчас внутри ночного интервала? (wrap полночи). */
export function inNightInterval(
  nowMs: number,
  from: string = NIGHT_FROM,
  to: string = NIGHT_TO,
): boolean {
  return inInterval(nowMs, from, to);
}

/**
 * Сколько миллисекунд до ближайшего начала ночи (FR-019-2: grace до старта).
 * Внутри ночного интервала -- 0. Невалидный from -- Number.POSITIVE_INFINITY
 * (никогда не настанет), не throw.
 */
export function msBeforeNight(
  nowMs: number,
  from: string = NIGHT_FROM,
  to: string = NIGHT_TO,
): number {
  if (inInterval(nowMs, from, to)) return 0;
  const next = nextOccurrence(nowMs, from);
  if (next === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, next - nowMs);
}

// ---- Sentry predicates (FR-019-1, FR-019-2) ----

/** Вход предиката «ночь без страховки». */
export type NoArmGapInput = {
  nowMs: number;
  /** Есть ли живая запись cont-after-reset (armed или pending). */
  armed: boolean;
  /** Есть ли АКТИВНЫЙ (не истёкший) план ночи. */
  planActive: boolean;
  /** Интервал ночи (по умолчанию 22:00-08:00; план переопределяет). */
  nightFrom?: string;
  nightTo?: string;
};

/**
 * FR-019-1: ночь идёт (идут вызовы модели), а взвода нет и плана нет.
 * Возвращает код разрыва "no-arm" или null.
 */
export function checkNoArmGap(input: NoArmGapInput): "no-arm" | null {
  const from = input.nightFrom ?? NIGHT_FROM;
  const to = input.nightTo ?? NIGHT_TO;
  if (!inNightInterval(input.nowMs, from, to)) return null;
  if (input.armed || input.planActive) return null;
  return "no-arm";
}

/** Вход предиката ночной добавки к arm-gone. */
export type ArmGoneNightGapInput = {
  nowMs: number;
  /** Метка причины arm-gone (kind/reason из sync-пути, spec 011). */
  reason: string;
  nightFrom?: string;
  nightTo?: string;
};

/**
 * FR-019-2: arm-gone «тихой» причины в ночном интервале или за
 * ARM_GONE_GRACE_MS до его начала. Возвращает "arm-gone-night" или null.
 */
export function checkArmGoneNightGap(
  input: ArmGoneNightGapInput,
): "arm-gone-night" | null {
  if (!NIGHT_ARM_GONE_REASONS.has(input.reason)) return null;
  const from = input.nightFrom ?? NIGHT_FROM;
  const to = input.nightTo ?? NIGHT_TO;
  if (inNightInterval(input.nowMs, from, to)) return "arm-gone-night";
  if (msBeforeNight(input.nowMs, from) <= ARM_GONE_GRACE_MS) {
    return "arm-gone-night";
  }
  return null;
}

/**
 * Чистый дедуп: пора ли слать очередное оповещение.
 * undefined/0 lastAt -- «никогда не слали» -> true.
 */
export function dedupPassed(
  lastAt: number | undefined,
  nowMs: number,
  minIntervalMs: number,
): boolean {
  if (typeof lastAt !== "number" || !Number.isFinite(lastAt) || lastAt <= 0) {
    return true;
  }
  return nowMs - lastAt >= minIntervalMs;
}

// ---- /night-check report (FR-019-5) ----

/** Вход сводки предстарта ночи (всё уже прочитано вызывающим кодом). */
export type NightCheckInput = {
  nowMs: number;
  // Окно (state).
  windowStartedAt: number;
  windowMs: number;
  callsInWindow: number;
  windowInput?: number;
  windowOutput?: number;
  windowCacheRead?: number;
  // Взвод (arms).
  armed: boolean;
  armRepeatLeft?: number;
  armExpiresAt?: number;
  // План ночи.
  planActive: boolean;
  planFrom?: string;
  planTo?: string;
  planRepeat?: number;
  /** Файл плана есть, но expiresAt в прошлом (мусор, D4). */
  planExpiredFile: boolean;
  // Проверочный запрос (state.ping).
  pingModel?: string;
  pingStatus?: string;
  pingStreak?: number;
  pingDetail?: string;
  // Интервал ночи (для вердикта no-arm во время предстарта днём).
  nightFrom?: string;
  nightTo?: string;
};

/** Вердикт предстарта: коды разрывов (пусто = «можно запускать ночь»). */
export type NightCheckVerdict = (
  | "no-arm"
  | "window-low"
  | "ping-dead"
  | "plan-expired-file"
)[];

function fmtTokens(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtMinutes(ms: number): string {
  if (ms < 0) return "0 мин";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  return `${h} ч ${min % 60} мин`;
}

/**
 * FR-019-5: сводка предстарта ночи. Чистая: markdown-таблица + список
 * разрывов. Вердикты:
 *   no-arm            -- нет ни взвода, ни активного плана;
 *   window-low        -- до сброса окна <30 мин или прошло >80% окна;
 *   ping-dead         -- серия infra-отказов пинга >= порога;
 *   plan-expired-file -- файл плана протух (мусор).
 */
export function buildNightCheckReport(
  input: NightCheckInput,
): { text: string; verdict: NightCheckVerdict } {
  const verdict: NightCheckVerdict = [];

  // Окно.
  const msLeft = input.windowStartedAt + input.windowMs - input.nowMs;
  const elapsedFrac = Math.min(
    1,
    Math.max(0, (input.nowMs - input.windowStartedAt) / input.windowMs),
  );
  const windowLow =
    Number.isFinite(msLeft) &&
    msLeft > -input.windowMs &&
    (msLeft < 30 * 60 * 1000 || elapsedFrac > 0.8);

  // Взвод.
  const armLine = input.armed
    ? `взведён, осталось срабатываний: ${
        typeof input.armRepeatLeft === "number" ? input.armRepeatLeft : "?"
      }${
        typeof input.armExpiresAt === "number"
          ? `, истекает через ${fmtMinutes(input.armExpiresAt - input.nowMs)}`
          : ""
      }`
    : "НЕТ";

  // План.
  const planLine = input.planActive
    ? `активен ${input.planFrom ?? "?"}-${input.planTo ?? "?"}, repeat=${
        input.planRepeat ?? "?"
      }`
    : input.planExpiredFile
      ? "нет (файл-мусор с истёкшим сроком)"
      : "нет";

  // Пинг.
  const streak = input.pingStreak ?? 0;
  const pingLine = `${
    input.pingStatus ?? "—"
  } (модель ${input.pingModel ?? "—"}, серия отказов ${streak}${
    input.pingDetail ? `, последний: ${input.pingDetail}` : ""
  })`;

  // Вердикты.
  if (!input.armed && !input.planActive) verdict.push("no-arm");
  if (windowLow) verdict.push("window-low");
  if (streak >= PING_STREAK_THRESHOLD) verdict.push("ping-dead");
  if (input.planExpiredFile) verdict.push("plan-expired-file");

  const verdictText =
    verdict.length === 0
      ? "можно запускать ночь"
      : verdict
          .map((v) => {
            switch (v) {
              case "no-arm":
                return "нет страховки: взведи /cont-after-reset N или /night-plan [HH:MM-HH:MM] repeat=N";
              case "window-low":
                return "окно на исходе: дождись сброса окна или сократи вечерние расходы";
              case "ping-dead":
                return "проверочный запрос окна не работает: сбросы будут слепыми (см. state.ping)";
              case "plan-expired-file":
                return "файл плана ночи протух — будет убран при первом чтении";
            }
          })
          .join("; ");

  const text = [
    "**Предстарт ночи (spec 019)**",
    "",
    "| Что | Состояние |",
    "|---|---|",
    `| Окно | вызовов ${input.callsInWindow}, осталось ${fmtMinutes(
      Math.max(0, msLeft),
    )} (${Math.round(elapsedFrac * 100)}% прошло), токены: input ${fmtTokens(
      input.windowInput,
    )} / output ${fmtTokens(input.windowOutput)} / cache ${fmtTokens(
      input.windowCacheRead,
    )} |`,
    `| Взвод автопродолжения | ${armLine} |`,
    `| План ночи | ${planLine} |`,
    `| Проверочный запрос окна | ${pingLine} |`,
    "",
    `Вердикт: ${verdictText}.`,
  ].join("\n");

  return { text, verdict };
}
