/**
 * reset.ts -- window reset detection for pi-billing-window (spec 012, TD-002).
 *
 * `checkAndReset` перенесён из ticker.ts ДОСЛОВНО (DEDUP_WINDOW_MS,
 * ABOUT_TO_RESET_MS, EmitFn, HistoryMeta); единственное изменение сигнатуры --
 * опциональный параметр `note` (default "auto"), попадающий в history-строку
 * window_reset (TD-008: wake-вызовы передают "wake HH:MM" локального времени
 * сработавшей точки, существующие вызовы не меняются).
 *
 * Интервальная механика (TICK_MS, startTicker/stopTicker) НЕ переносится --
 * "когда проверять" теперь решает планировщик wakeups.ts, "как проверять" --
 * этот модуль. Passive observer: checkAndReset никогда не роняет хост-процесс.
 */

import { mutateState, type State } from "./state.js";
import { appendHistory } from "./history.js";

export const ABOUT_TO_RESET_MS = 5 * 60 * 1000;
export const DEDUP_WINDOW_MS = 10 * 60 * 1000;

export type EmitFn = (event: string, payload: unknown) => void;

/** Project/session attribution for history rows (optional). */
export type HistoryMeta = { project?: string; session?: string };

export async function checkAndReset(
  emit: EmitFn,
  meta?: HistoryMeta,
  note = "auto",
): Promise<boolean> {
  try {
    let didReset = false;
    let aboutToReset: { provider: string; msRemaining: number } | null = null;

    await mutateState<true>((state) => {
      if (state === null) {
        return { next: null, result: true };
      }

      const now = Date.now();
      const elapsed = now - state.windowStartedAt;

      if (elapsed >= state.windowMs) {
        // Dedup: if another process reset very recently, do not emit again.
        if (now - state.lastResetAt < DEDUP_WINDOW_MS) {
          return { next: null, result: true };
        }

        const next: State = {
          provider: state.provider,
          windowStartedAt: now,
          windowMs: state.windowMs,
          lastResetAt: now,
          resetCount: state.resetCount + 1,
          callsInWindow: 0,
          firstCallEmittedAt: undefined,
          // Spec 014 (FR-014-4): итоги завершившегося окна уходят в prev*
          // (ночная книга читает их из payload billing:window_reset),
          // аккумулирующие поля нового окна стартуют с нуля.
          windowInput: 0,
          windowOutput: 0,
          windowCacheRead: 0,
          prevWindowCalls: state.callsInWindow,
          prevWindowInput: state.windowInput ?? 0,
          prevWindowOutput: state.windowOutput ?? 0,
          prevWindowCacheRead: state.windowCacheRead ?? 0,
          // Spec 015-fix: начало завершившегося окна — в payload ledger.
          prevWindowStartedAt: state.windowStartedAt,
          // Spec 017: подсостояние пинга переживает reset (dedup-маркер
          // ping.lastBoundary и кэш mode/model не должны теряться).
          ping: state.ping,
        };

        didReset = true;
        return { next, result: true };
      }

      // Window not expired yet. Check if it is about to expire.
      const msRemaining = state.windowMs - elapsed;
      if (msRemaining <= ABOUT_TO_RESET_MS) {
        aboutToReset = { provider: state.provider, msRemaining };
      }

      return { next: null, result: true };
    });

    if (didReset) {
      // Re-read the freshly written state to pass to subscribers so they see
      // the new windowStartedAt / resetCount / etc.
      const fresh = (await import("./state.js")).readStateSync();
      emit("billing:window_reset", fresh);
      // Passive observer: auto reset row into the shared history CSV.
      // fire-and-forget; appendHistory never throws.
      void appendHistory({
        kind: "window_reset",
        project: meta?.project,
        session: meta?.session,
        callsInWindow: fresh?.callsInWindow,
        resetCount: fresh?.resetCount,
        note,
      });
    } else if (aboutToReset !== null) {
      emit("billing:window_about_to_reset", aboutToReset);
    }

    return didReset;
  } catch (err) {
    // Never let a reset check kill the host process.
    // ELOCKED (state-lock contention with another window/process holding
    // it longer than the retry budget) is NOT fatal: the other holder did
    // the check, and the next tick retries. Do not spam the agent window
    // with a console.warn for it -- log quietly and move on.
    const msg = String((err as Error)?.message ?? err).slice(0, 160);
    if ((err as { code?: string })?.code === "ELOCKED") {
      console.warn(
        "pi-billing-window: checkAndReset отложен (state-lock занят другим окном, повтор на следующем тике)",
      );
      return false;
    }
    console.warn("pi-billing-window: checkAndReset failed:", msg);
    return false;
  }
}
