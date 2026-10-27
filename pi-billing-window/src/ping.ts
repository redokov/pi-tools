/**
 * ping.ts -- boundary-ping for pi-billing-window (spec 017).
 *
 * Провайдер wormsoft якорит новое 2-часовое окно ЛЕНИВО: только от первого
 * запроса после восстановления лимита. Поэтому на каждой wake-границе мы
 * сами отправляем дешёвый 1-токенный completion-запрос (мимо пайплайна pi):
 *
 *   200 -> окно реально перевернулось: сам пинг якорит новое окно у
 *          провайдера на предсказанный момент -> верифицированный
 *          checkAndReset -> billing:window_reset (FR-017-1, FR-017-6);
 *   429 -> окно ещё живое: reset подавлен, локальный якорь корректируется
 *          (re-anchor на firstCallEmittedAt), проверка перепланируется
 *          (FR-017-4);
 *   infra (сеть/таймаут/401/5xx/нет конфига) -> НЕ сигнал об окне:
 *          bounded retry, после 3 подряд -- слепой legacy-reset (FR-017-5),
 *          пинг никогда не блокирует reset навсегда.
 *
 * Транспорт: прямой fetch к {baseUrl}/chat/completions (openai-completions),
 * baseUrl из ~/.pi/agent/models.json, ключ из ~/.pi/agent/auth.json.
 * Модель: openai/gpt-oss:20b (5 000/4 000 кр за М, без бейджа "на пенсии"),
 * фолбэк wormsoft/agent/low на модель-ошибку (D-002). Режим стрима
 * stream:false с авто-фолбэком на stream:true+abort, рабочий режим
 * кэшируется в state.ping.mode (D-003).
 *
 * Пинг НЕ проходит через пайплайн pi: нет транскрипта, нет
 * after_provider_response, нет callsInWindow/llm:first_call, нет
 * подтверждения cont-after-reset (FR-017-11, урок инцидента 2026-09-28).
 *
 * Passive observer: ни одна ошибка пинга не роняет host-процесс (NFR-017-2);
 * таймеры unref (NFR-017-3, spec 003).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mutateState, readStateSync, type State } from "./state.js";
import { checkAndReset, type EmitFn, type HistoryMeta } from "./reset.js";
import {
  appendHistory,
  type HistoryUsage,
} from "./history.js";
import {
  computeTableFromAnchor,
  insertRetryPoint,
  mutateWakeTable,
  WAKE_DEPTH,
  WAKE_MARGIN_MS,
} from "./wakeups.js";
import { armsLog } from "./armslog.js";
import { sendNotify } from "./notifier.js";

// ---- Constants ----

/** Локальная копия index.PROVIDER (без циклического импорта). */
const PING_PROVIDER = "wormsoft";

/** Модель пинга: самая дешёвая без бейджа "на пенсии" (D-002). */
export const PING_MODEL = "openai/gpt-oss:20b";
/** Фолбэк-модель при модель-ошибке (400/404/422) на основную (D-002). */
export const PING_FALLBACK_MODEL = "wormsoft/agent/low";
/** Таймаут одного запроса (NFR-017-4). */
export const PING_TIMEOUT_MS = 30_000;
/** Кап выходных токенов: стоимость пинга и защита от reasoning-хвостов. */
export const PING_MAX_TOKENS = 2;
/** Шаг retry-точки при 429 с неизвестным якорем (FR-017-4). */
export const PING_RETRY_MS = 10 * 60_000;
/** Кап попыток unknown-anchor retry: 12 x 10 мин ~ 2 ч (FR-017-4). */
export const PING_RETRY_MAX = 12;
/** Шаг retry-точки при infra-ошибке (FR-017-5). */
export const PING_INFRA_RETRY_MS = 2 * 60_000;
/** Streak infra-ошибок, после которого включается слепой legacy-reset. */
export const PING_INFRA_STREAK_MAX = 3;
/**
 * Кап infra-проб на burned-пути (слепой reset там запрещён -- spec 012):
 * после 30 неудач (~1 час по 2 мин) probe-пинги останавливаются с notify,
 * пока транспорт не оживёт (ok/429 сбрасывает streak и флаг).
 */
export const PING_INFRA_BURNED_MAX = 30;

// ---- Types ----

/** Схема state.ping (аддитивная, толерантная -- design §9). */
export type PingState = {
  /** /billing-ping off: авто-границы ведут себя как до фичи (слепой reset). */
  disabled?: boolean;
  /** Рабочий режим стрима (D-003), резолвится первым успешным пингом. */
  mode?: PingMode;
  /** Рабочая модель (если потребовался фолбэк). */
  model?: string;
  /** Timestamp последнего пинга (auto или manual). */
  lastAt?: number;
  lastStatus?: PingStatus;
  /** Маркер границы последнего АВТО-пинга -- ключ dedup между процессами (D-007). */
  lastBoundary?: number;
  /** Latency/error-деталь последнего пинга. */
  lastDetail?: string;
  infraStreak?: number;
  infraNotified?: boolean;
  retryAttempt?: number;
};

export type PingMode = "json" | "sse";
export type PingStatus = "ok" | "429" | "infra";

export type PingConfig = {
  baseUrl: string;
  apiKey: string;
};

export type PingResult =
  | {
      kind: "ok";
      status: number;
      mode: PingMode;
      model: string;
      sentAt: number;
      latencyMs: number;
      usage?: HistoryUsage;
    }
  | {
      kind: "limit";
      status: number;
      mode: PingMode;
      model: string;
      sentAt: number;
      latencyMs: number;
    }
  | { kind: "infra"; error: string };

export type PingFlowOutcome =
  /** Пинг выключен / state нет: вызывающий путь обязан сделать слепой checkAndReset сам. */
  | "legacy"
  /** Флоу отработал полностью (reset или подавление + перепланирование). */
  | "handled";

type FetchLike = typeof fetch;

// ---- Config loader (FR-017-2, NFR-017-2) ----

let modelsJsonPath = path.join(os.homedir(), ".pi", "agent", "models.json");
let authJsonPath = path.join(os.homedir(), ".pi", "agent", "auth.json");

/** Tests: redirect the config files. */
export function setPingConfigPaths(models: string, auth: string): void {
  modelsJsonPath = models;
  authJsonPath = auth;
}

/** Tests: restore the default config paths. */
export function resetPingConfigPaths(): void {
  modelsJsonPath = path.join(os.homedir(), ".pi", "agent", "models.json");
  authJsonPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
}

/**
 * Толерантное чтение конфига провайдера: baseUrl из models.json
 * (providers.wormsoft.baseUrl), ключ из auth.json (wormsoft.key).
 * Любая неудача -> null (infra-путь), никогда не бросает.
 */
export function loadPingConfig(): PingConfig | null {
  try {
    const modelsRaw = fs.readFileSync(modelsJsonPath, "utf8");
    const models = JSON.parse(modelsRaw) as {
      providers?: Record<string, { baseUrl?: unknown }>;
    };
    const baseUrlRaw = models.providers?.[PING_PROVIDER]?.baseUrl;
    if (typeof baseUrlRaw !== "string" || !/^https?:\/\//i.test(baseUrlRaw)) {
      return null;
    }
    const baseUrl = baseUrlRaw.replace(/\/+$/, "");

    const authRaw = fs.readFileSync(authJsonPath, "utf8");
    const auth = JSON.parse(authRaw) as Record<string, { key?: unknown }>;
    const key = auth[PING_PROVIDER]?.key;
    if (typeof key !== "string" || key.length === 0) {
      return null;
    }
    return { baseUrl, apiKey: key };
  } catch {
    return null;
  }
}

// ---- Transport (FR-017-2, FR-017-3, design §4) ----

/** Injection seam for tests. */
let pingFetchImpl: FetchLike | null = null;

/** Tests: inject a fetch implementation; null restores the global fetch. */
export function setPingFetchForTests(impl: FetchLike | null): void {
  pingFetchImpl = impl;
}

function fetchOf(): FetchLike {
  return pingFetchImpl ?? fetch;
}

/** Инъекция notify для тестов (по умолчанию -- notifier.sendNotify). */
let pingNotifyImpl: typeof sendNotify = sendNotify;

/** Tests: inject the notify function. */
export function setPingNotifyForTests(impl: typeof sendNotify): void {
  pingNotifyImpl = impl;
}

type AttemptResult =
  | { kind: "ok"; usage?: HistoryUsage }
  | { kind: "limit" }
  | { kind: "status"; status: number }
  | { kind: "error"; error: string };

/**
 * Одна попытка: POST chat/completions в заданном режиме.
 * sse: статус читается по заголовкам, после первого чанка тело обрывается
 * (usage недоступен -- design §11). Никогда не бросает.
 */
async function attempt(
  cfg: PingConfig,
  model: string,
  mode: PingMode,
  timeoutMs: number,
): Promise<AttemptResult> {
  const controller = new AbortController();
  // spec 003: таймаут-таймер не держит event loop; снимается по завершении.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  try {
    const res = await fetchOf()(cfg.baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: PING_MAX_TOKENS,
        stream: mode === "sse",
      }),
      signal: controller.signal,
    });

    if (res.status === 429) return { kind: "limit" };
    if (res.status === 200) {
      if (mode === "sse") {
        // Первый чанк достаточен: окно подтверждено, генерация обрывается.
        try {
          const reader = res.body?.getReader();
          if (reader) {
            await reader.read();
            await reader.cancel().catch(() => {});
          }
        } catch {
          // тело недоступно/порвано -- статус уже известен, это не ошибка
        }
        return { kind: "ok" };
      }
      let usage: HistoryUsage | undefined;
      try {
        const data = (await res.json()) as {
          usage?: Record<string, unknown>;
        };
        usage = parseUsage(data?.usage);
      } catch {
        // битый JSON тела: статус 200 уже подтверждает переворот окна
      }
      return { kind: "ok", usage };
    }
    return { kind: "status", status: res.status };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 160);
    return { kind: "error", error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Толерантный парсер usage: legacy openai + новый формат input_tokens. */
function parseUsage(u: Record<string, unknown> | undefined): HistoryUsage | undefined {
  if (u === null || typeof u !== "object") return undefined;
  const o = u as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const details =
    (o.prompt_tokens_details ?? o.input_tokens_details) as
      | Record<string, unknown>
      | undefined;
  const input = num(o.prompt_tokens) ?? num(o.input_tokens);
  const output = num(o.completion_tokens) ?? num(o.output_tokens);
  const cacheRead = num(details?.cached_tokens);
  if (input === undefined && output === undefined && cacheRead === undefined) {
    return undefined;
  }
  return { input, output, cacheRead };
}

/**
 * Полный пинг с деревом попыток (design §4.3):
 *   1. json + resolvedModel (state.ping.model ?? PING_MODEL)
 *   2. при 400/404/422 на основную модель -- json + PING_FALLBACK_MODEL
 *   3. при протокольной ошибке (400/404/405/406/415/501) -- sse
 *   4. иначе (401/403/5xx/сеть/таймаут) -- infra
 * Рабочие mode/model кэшируются вызывающим кодом при исходе ok/limit.
 */
export async function sendPing(
  cfg: PingConfig,
  opts: { mode?: PingMode; model?: string; timeoutMs?: number } = {},
): Promise<PingResult> {
  const timeoutMs = opts.timeoutMs ?? PING_TIMEOUT_MS;
  const primary = opts.model ?? PING_MODEL;
  const mode0 = opts.mode;
  const sentAt = Date.now();

  const finish = (
    a: AttemptResult,
    mode: PingMode,
    model: string,
  ): PingResult => {
    const latencyMs = Date.now() - sentAt;
    if (a.kind === "ok") {
      return { kind: "ok", status: 200, mode, model, sentAt, latencyMs, usage: a.usage };
    }
    if (a.kind === "limit") {
      return { kind: "limit", status: 429, mode, model, sentAt, latencyMs };
    }
    if (a.kind === "status") {
      return { kind: "infra", error: `HTTP ${a.status}` };
    }
    return { kind: "infra", error: a.error };
  };

  // 1. Основная попытка в кэшированном режиме (или json, если режим неизвестен).
  const useMode: PingMode = mode0 ?? "json";
  let a = await attempt(cfg, primary, useMode, timeoutMs);
  if (a.kind === "ok" || a.kind === "limit") {
    return finish(a, useMode, primary);
  }

  // 2. Модель-ошибка на основную модель -> фолбэк-модель (только в json-режиме).
  const modelErr = a.kind === "status" && [400, 404, 422].includes(a.status);
  if (modelErr && mode0 === undefined && primary === PING_MODEL) {
    const a2 = await attempt(cfg, PING_FALLBACK_MODEL, "json", timeoutMs);
    if (a2.kind === "ok" || a2.kind === "limit") {
      return finish(a2, "json", PING_FALLBACK_MODEL);
    }
    a = a2;
  }

  // 3. Протокольная ошибка -> sse-фолбэк (режим ещё не зафиксирован как sse).
  const protoErr =
    (a.kind === "status" && [400, 404, 405, 406, 415, 501].includes(a.status)) ||
    (a.kind === "error" && /stream/i.test(a.error));
  if (protoErr && useMode !== "sse") {
    const a3 = await attempt(cfg, primary, "sse", timeoutMs);
    if (a3.kind === "ok" || a3.kind === "limit") {
      return finish(a3, "sse", primary);
    }
  }

  // 4. Сеть/таймаут/401/403/5xx -> infra.
  return finish(a, useMode, primary);
}

// ---- State helpers ----

/** Прочитать ping-подсостояние (толерантно). */
export function readPingState(): PingState {
  return readStateSync()?.ping ?? {};
}

/** Мутация ping-подсостояния под общим state-локом. */
async function mutatePing(
  transform: (ping: PingState, state: State) => PingState,
): Promise<void> {
  await mutateState((cur) => {
    if (cur === null) return { next: null };
    const ping = transform(cur.ping ?? {}, cur);
    return { next: { ...cur, ping } };
  });
}

/** Записать результат авто-пинга в общее состояние (dedup-маркер границы). */
async function recordAutoResult(
  firedPoint: number,
  res: PingResult,
): Promise<void> {
  await mutatePing((ping) => {
    const next: PingState = { ...ping, lastAt: Date.now(), lastBoundary: firedPoint };
    if (res.kind === "ok") {
      next.lastStatus = "ok";
      next.lastDetail = `${res.latencyMs}ms ${res.model} ${res.mode}`;
      next.mode = res.mode;
      next.model = res.model;
      next.infraStreak = 0;
      next.infraNotified = false;
      next.retryAttempt = 0;
    } else if (res.kind === "limit") {
      next.lastStatus = "429";
      next.lastDetail = `${res.latencyMs}ms`;
      next.mode = res.mode;
      next.model = res.model;
      next.infraStreak = 0;
      next.infraNotified = false;
      // retryAttempt управляется в handlePingLimit (re-anchor сбрасывает).
    } else {
      next.lastStatus = "infra";
      next.lastDetail = res.error.slice(0, 120);
    }
    return next;
  });
}

// ---- Boundary flow (FR-017-1, 4, 5, 6, 7; design §5) ----

export type PingFlowOptions = {
  /** Сработавшая wake-точка (или значение сгоревшей для probe). */
  firedPoint: number;
  /** Note для history/логов: "wake HH:MM" или "probe wake HH:MM". */
  note: string;
  emit: EmitFn;
  meta?: HistoryMeta;
  /** false для burned-head: слепой reset запрещён (spec 012 FR-012-10). */
  blindOnInfra: boolean;
  /** Тесты: подменить таймаут sendPing. */
  timeoutMs?: number;
};

/**
 * Полный флоу границы: dedup по записанному результату -> пинг -> действие.
 * Возвращает "legacy", когда пинг выключен/невозможен и вызывающий должен
 * сделать слепой checkAndReset сам; "handled" -- всё сделано здесь.
 * Идемпотентен для параллельных процессов (design §5.4).
 */
export async function pingBoundaryFlow(opts: PingFlowOptions): Promise<PingFlowOutcome> {
  try {
    const st = readStateSync();
    if (st === null) return "legacy"; // окна нет -- слепой путь безопасен (no-op)

    const ping = st.ping ?? {};
    if (ping.disabled === true) return "legacy";

    // -- 5.1: записанный результат этой границы (dedup, D-007) --------------
    if (ping.lastBoundary === opts.firedPoint) {
      if (ping.lastStatus === "ok") {
        // Окно подтверждено (нами или соседним процессом): reset; dedup
        // checkAndReset защищает от дубля, а если победитель умер до
        // reset'а -- этот вызов его закрывает.
        await checkAndReset(opts.emit, opts.meta, opts.note);
        const fresh = readStateSync();
        const okSentAt = fresh?.firstCallEmittedAt;
        if (fresh !== null && okSentAt !== undefined) {
          // Якорь уже стоит (пинг-победитель или реальный вызов) -- не трогаем.
        } else {
          await applyPingAnchorFromState();
        }
        return "handled";
      }
      if (ping.lastStatus === "429") {
        await handlePingLimit(opts.firedPoint);
        return "handled";
      }
      if (ping.lastStatus === "infra") {
        // Соседний процесс уже записал infra и (скорее всего) уже поставил
        // retry-точку/сделал слепой reset; повтор идемпотентен (design §5.4).
        await handlePingInfra(opts, "recorded");
        return "handled";
      }
    }

    // -- Свежий пинг --------------------------------------------------------
    const cfg = loadPingConfig();
    if (cfg === null) {
      armsLog("ping:infra", `${opts.note}: нет конфига (models.json/auth.json)`);
      await handlePingInfra(opts, "no-config");
      return "handled";
    }
    const res = await sendPing(cfg, {
      mode: ping.mode,
      model: ping.model,
      timeoutMs: opts.timeoutMs,
    });
    await recordAutoResult(opts.firedPoint, res);
    emitPingEvent(opts.emit, res);
    const st2 = readStateSync();

    if (res.kind === "ok") {
      armsLog("ping:ok", `${opts.note} ${res.latencyMs}ms ${res.model} ${res.mode}`);
      void appendHistory({
        kind: "ping",
        project: opts.meta?.project,
        session: opts.meta?.session,
        model: res.model,
        callsInWindow: st2?.callsInWindow,
        resetCount: st2?.resetCount,
        usage: res.usage ?? null,
        note: `${opts.note} ok`,
      });
      // FR-017-1: верифицированный reset.
      await checkAndReset(opts.emit, opts.meta, opts.note);
      // FR-017-6: пинг якорит новое окно (локально + wake-таблица).
      await applyPingAnchor(res.sentAt);
      return "handled";
    }

    if (res.kind === "limit") {
      armsLog("ping:429", `${opts.note} окно ещё живое (${res.latencyMs}ms)`);
      // Честный сигнал для pacing'а cont-after-reset + history-строка.
      await mutateState((cur) =>
        cur === null
          ? { next: null }
          : { next: { ...cur, last429At: Date.now() } },
      );
      void appendHistory({
        kind: "429",
        project: opts.meta?.project,
        session: opts.meta?.session,
        callsInWindow: st2?.callsInWindow,
        resetCount: st2?.resetCount,
        note: "ping probe",
      });
      await handlePingLimit(opts.firedPoint);
      return "handled";
    }

    // infra
    armsLog("ping:infra", `${opts.note} попытка: ${res.error}`);
    void appendHistory({
      kind: "ping",
      project: opts.meta?.project,
      session: opts.meta?.session,
      callsInWindow: st2?.callsInWindow,
      resetCount: st2?.resetCount,
      note: `${opts.note} infra: ${res.error.slice(0, 60)}`,
    });
    await handlePingInfra(opts, res.error);
    return "handled";
  } catch (err) {
    // NFR-017-2: пинг никогда не роняет host. На неожиданном сбое --
    // слепой reset (лучше лишний reset, чем потерянная граница), но только
    // там, где он разрешён.
    const msg = String((err as Error)?.message ?? err).slice(0, 160);
    console.warn("pi-billing-window: pingBoundaryFlow failed:", msg);
    if (opts.blindOnInfra) {
      await checkAndReset(opts.emit, opts.meta, opts.note);
    }
    return "handled";
  }
}

/** EventBus-событие для внешних подписчиков (design §8). */
function emitPingEvent(emit: EmitFn, res: PingResult): void {
  try {
    emit("billing:ping", {
      provider: PING_PROVIDER,
      status: res.kind === "infra" ? "infra" : res.kind === "limit" ? 429 : 200,
      latencyMs: res.kind === "infra" ? undefined : res.latencyMs,
      usage: res.kind === "ok" ? res.usage : undefined,
      error: res.kind === "infra" ? res.error : undefined,
    });
  } catch {
    // шина подписчиков -- пассивный наблюдатель
  }
}

// ---- handlePingLimit (FR-017-4, design §5.2) ----

async function handlePingLimit(firedPoint: number): Promise<void> {
  void firedPoint;
  const st = readStateSync();
  if (st === null) return;
  const fc = st.firstCallEmittedAt;
  const win = st.windowMs;

  if (fc !== undefined && fc > st.windowStartedAt) {
    // Re-anchor: локальный якорь был фиктивен, реальное окно стартовало
    // от первого вызова (fc >= истинного якоря провайдера -- верхняя
    // граница, повторный пинг на fc+2h уже не встретит 429).
    await mutateState((cur) =>
      cur === null ? { next: null } : { next: { ...cur, windowStartedAt: fc } },
    );
    await mutateWakeTable(() => ({
      next: computeTableFromAnchor(fc, win, WAKE_MARGIN_MS, WAKE_DEPTH, "firstCall"),
    }));
    await mutatePing((ping) => ({ ...ping, retryAttempt: 0 }));
    armsLog(
      "ping:429-reanchor",
      `якорь -> firstCall (${new Date(fc).toISOString()}), следующая граница +${Math.round((fc + win - Date.now()) / 60000)} мин`,
    );
    void pingNotifyImpl({
      type: "billing:ping-429-reanchor",
      provider: PING_PROVIDER,
      title: "пинг 429: окно ещё активно",
      body: "Локальный якорь скорректирован на первый вызов окна; reset подавлен, следующая проверка на новой границе.",
      timestamp: Date.now(),
    });
    return;
  }

  if (fc !== undefined && fc === st.windowStartedAt) {
    // Соседний процесс уже сделал re-anchor -- идемпотентный no-op.
    return;
  }

  // Unknown anchor: в текущем локальном окне не было ни одного вызова,
  // но лимит у провайдера исчерпан (внешний потребитель ключа).
  const attemptNo = (st.ping?.retryAttempt ?? 0) + 1;
  if (attemptNo > PING_RETRY_MAX) {
    // Уведомление -- ровно на первом пересечении капа (attemptNo == MAX+1).
    if (attemptNo === PING_RETRY_MAX + 1) {
      armsLog(
        "ping:429-cap",
        `лимит не восстанавливается ${PING_RETRY_MAX} попыток -- активное зондирование остановлено`,
      );
      void pingNotifyImpl({
        type: "billing:ping-429-cap",
        provider: PING_PROVIDER,
        title: "пинг: окно не восстанавливается",
        body: `429 на ${PING_RETRY_MAX} подряд пингах. Лимит держит внешний потребитель ключа или провайдер. Активные пинги остановлены; первый реальный вызов возобновит штатный цикл.`,
        timestamp: Date.now(),
      });
    }
    await mutatePing((ping) => ({ ...ping, retryAttempt: attemptNo }));
    return;
  }
  await mutatePing((ping) => ({ ...ping, retryAttempt: attemptNo }));
  const retryAt = Date.now() + PING_RETRY_MS;
  await mutateWakeTable((cur) =>
    cur === null
      ? {
          next: {
            version: 1,
            points: [retryAt],
            updatedAt: Date.now(),
            source: "firstCall",
          },
        }
      : { next: insertRetryPoint(cur, retryAt) },
  );
  armsLog(
    "ping:429-unknown-anchor",
    `попытка ${attemptNo}/${PING_RETRY_MAX}, повтор через ${Math.round(PING_RETRY_MS / 60000)} мин`,
  );
}

// ---- handlePingInfra (FR-017-5, design §5.3) ----

async function handlePingInfra(
  opts: PingFlowOptions,
  reason: string,
): Promise<{ rolled: boolean }> {
  const st = readStateSync();
  const streak = (st?.ping?.infraStreak ?? 0) + 1;
  await mutatePing((ping) => ({ ...ping, infraStreak: streak }));

  if (streak >= PING_INFRA_STREAK_MAX) {
    if (opts.blindOnInfra) {
      // Слепой legacy-reset: пинг сломан, но окно не должно остаться
      // без reset'а (D-008). Дедуп checkAndReset защищает от дублей.
      armsLog(
        "ping:infra-fallback",
        `${streak} подряд infra (${reason}) -- слепой reset как до фичи`,
      );
      await checkAndReset(opts.emit, opts.meta, opts.note);
      const notified = readPingState().infraNotified === true;
      if (!notified) {
        await mutatePing((ping) => ({ ...ping, infraNotified: true }));
        void pingNotifyImpl({
          type: "billing:ping-infra-fallback",
          provider: PING_PROVIDER,
          title: "пинг недоступен — reset вслепую",
          body: `Транспорт пинга падает (${reason}). Границы окна сбрасываются без верификации, как до spec 017. Проверь models.json/auth.json и доступность ai.wormsoft.ru.`,
          timestamp: Date.now(),
        });
      }
      return { rolled: true };
    }
    // burned-head: слепой reset запрещён (spec 012) -- только retry.
  }

  // Кап burned-проб: без него слепой-запретённый путь ретраился бы вечно.
  if (!opts.blindOnInfra && streak > PING_INFRA_BURNED_MAX) {
    if (readPingState().infraNotified !== true) {
      await mutatePing((ping) => ({ ...ping, infraNotified: true }));
      armsLog(
        "ping:infra-cap",
        `${streak} подряд infra на burned-пути -- probe-пинги остановлены до восстановления транспорта`,
      );
      void pingNotifyImpl({
        type: "billing:ping-infra-fallback",
        provider: PING_PROVIDER,
        title: "пинг недоступен — probe остановлены",
        body: `Транспорт пинга падает (${reason}). Probe-пинги после сна остановлены после ${PING_INFRA_BURNED_MAX} неудач; окно ждёт первого реального вызова или /settimer. Проверь models.json/auth.json и доступность ai.wormsoft.ru.`,
        timestamp: Date.now(),
      });
    }
    return { rolled: false };
  }

  // bounded retry через wake-точку (epsilon дедуплит параллельные вставки)
  const retryAt = Date.now() + PING_INFRA_RETRY_MS;
  await mutateWakeTable((cur) =>
    cur === null
      ? {
          next: {
            version: 1,
            points: [retryAt],
            updatedAt: Date.now(),
            source: "firstCall",
          },
        }
      : { next: insertRetryPoint(cur, retryAt) },
  );
  return { rolled: false };
}

// ---- applyPingAnchor (FR-017-6, design §5.5) ----

/**
 * Зафиксировать якорь пинга ПОСЛЕ состоявшегося reset'а:
 * firstCallEmittedAt := sentAt (если ещё не занят реальным вызовом) и
 * полная перестройка wake-таблицы от момента пинга. Тогда первый реальный
 * вызов не создаёт двойной якорь, а сетка идёт от пинга.
 */
export async function applyPingAnchor(sentAt: number): Promise<void> {
  const st = readStateSync();
  if (st === null) return;
  // reset должен был только что случиться (нами или соседом в пределах
  // минуты) И якорь ещё свободен.
  if (st.firstCallEmittedAt !== undefined) return;
  if (st.lastResetAt < sentAt - 60_000) return;

  await mutateState((cur) =>
    cur === null
      ? { next: null }
      : { next: { ...cur, firstCallEmittedAt: sentAt } },
  );
  await mutateWakeTable(() => ({
    next: computeTableFromAnchor(
      sentAt,
      st.windowMs,
      WAKE_MARGIN_MS,
      WAKE_DEPTH,
      "firstCall",
    ),
  }));
  armsLog(
    "ping:anchor",
    `новое окно якорено пингом (${new Date(sentAt).toISOString()}), сетка от пинга`,
  );
}

/** Вариант applyPingAnchor для recorded-ok пути: sentAt неизвестен, якорим по lastResetAt. */
async function applyPingAnchorFromState(): Promise<void> {
  const st = readStateSync();
  if (st === null) return;
  if (st.lastResetAt === 0) return;
  await applyPingAnchor(st.lastResetAt);
}

// ---- Manual ping (FR-017-9) ----

/**
 * Ручной /ping-wormsoft: диагностика. Шлёт пинг, пишет history/armslog,
 * кэширует рабочий mode/model -- НО не трогает lastBoundary (dedup-маркер
 * авто-пинга), last429At и состояние окна.
 */
export async function manualPing(
  meta?: HistoryMeta,
  timeoutMs?: number,
): Promise<PingResult> {
  const cfg = loadPingConfig();
  if (cfg === null) {
    armsLog("ping:manual", "нет конфига (models.json/auth.json)");
    void appendHistory({
      kind: "ping",
      project: meta?.project,
      session: meta?.session,
      note: "manual infra: no config",
    });
    return { kind: "infra", error: "no config (models.json/auth.json)" };
  }
  const ping = readPingState();
  const res = await sendPing(cfg, {
    mode: ping.mode,
    model: ping.model,
    timeoutMs,
  });
  armsLog(
    "ping:manual",
    res.kind === "infra"
      ? `infra: ${res.error}`
      : `${res.kind} ${res.latencyMs}ms ${res.model} ${res.mode}`,
  );
  await mutatePing((p) => {
    const next: PingState = { ...p, lastAt: Date.now() };
    if (res.kind === "ok") {
      next.lastStatus = "ok";
      next.lastDetail = `${res.latencyMs}ms ${res.model} ${res.mode}`;
      next.mode = res.mode;
      next.model = res.model;
    } else if (res.kind === "limit") {
      next.lastStatus = "429";
      next.lastDetail = `${res.latencyMs}ms`;
      next.mode = res.mode;
      next.model = res.model;
    } else {
      next.lastStatus = "infra";
      next.lastDetail = res.error.slice(0, 120);
    }
    return next;
  });
  void appendHistory({
    kind: "ping",
    project: meta?.project,
    session: meta?.session,
    model: res.kind === "infra" ? undefined : res.model,
    callsInWindow: readStateSync()?.callsInWindow,
    resetCount: readStateSync()?.resetCount,
    usage: res.kind === "ok" ? (res.usage ?? null) : undefined,
    note: "manual",
  });
  return res;
}

/** Включить/выключить автопинг (FR-017-10). Возвращает новое значение. */
export async function setPingDisabled(disabled: boolean): Promise<boolean> {
  // Bootstrap: state может не существовать (первая команда до первого
  // вызова провайдера) -- создаём минимальное окно, как makeInitialState
  // в index.ts, чтобы флаг пережил первый session_start.
  if (readStateSync() === null) {
    await mutateState(() => ({
      next: {
        provider: PING_PROVIDER,
        windowStartedAt: Date.now(),
        windowMs: 2 * 60 * 60 * 1000,
        lastResetAt: 0,
        resetCount: 0,
        callsInWindow: 0,
        ping: { disabled },
      },
    }));
    return disabled;
  }
  await mutatePing((ping) => ({ ...ping, disabled }));
  return disabled;
}
