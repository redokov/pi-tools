/**
 * examples/subscribe.ts — пример расширения-подписчика на события
 * pi-billing-window.
 *
 * Этот файл демонстрирует, как из соседнего расширения слушать
 * `billing:window_reset` и реагировать (например, сбросить собственный
 * rate-limit).
 *
 * Использование:
 *   1. Скопировать в C:\Users\r\.pi\agent\extensions\my-subscriber\subscribe.ts
 *   2. Создать рядом package.json:
 *        { "name": "my-subscriber", "type": "module",
 *          "pi": { "extension": "./subscribe.ts" } }
 *   3. Перезапустить pi или /reload.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Вынесем сюда «наш локальный лимитер» для примера.
type Limiter = { resetCount: number; callsLeft: number };
const limiters = new Map<string, Limiter>();

function getLimiter(provider: string): Limiter {
  let l = limiters.get(provider);
  if (!l) {
    l = { resetCount: 0, callsLeft: 100 };
    limiters.set(provider, l);
  }
  return l;
}

export default function (pi: ExtensionAPI): void {
  // Сохраняем unsubscriber, чтобы корректно отписаться на session_shutdown.
  let unsubscribe: (() => void) | null = null;

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    // EventBus лежит в ctx.events. Типизированной обёртки нет — кастим.
    const bus = (ctx as any).events as
      | {
          on: (channel: string, handler: (data: unknown) => void) => () => void;
        }
      | undefined;

    if (!bus) return;

    // Подписываемся. Оборачиваем в try/catch — pi.events уже защищает
    // отдельные listener'ы, но мы хотим быть аккуратными с собственным кодом.
    try {
      unsubscribe = bus.on("billing:window_reset", async (raw) => {
        const s = raw as {
          provider?: string;
          resetCount?: number;
        };
        if (!s?.provider) return;
        const l = getLimiter(s.provider);
        l.resetCount = s.resetCount ?? l.resetCount + 1;
        l.callsLeft = 100; // возвращаем квоту
        // eslint-disable-next-line no-console
        console.log(
          `[my-subscriber] reset #${l.resetCount} for ${s.provider}, callsLeft=${l.callsLeft}`,
        );
      });
    } catch {
      // ignore — bus может быть недоступен в каких-то режимах.
    }
  });

  pi.on("session_shutdown", () => {
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {}
      unsubscribe = null;
    }
  });

  // Пример команды: показать состояние нашего лимитера.
  pi.registerCommand("my-subscriber-status", {
    description: "Состояние локального лимитера, синхронизированного с pi-billing-window",
    handler: async (_args, ctx) => {
      const lines = Array.from(limiters.entries()).map(
        ([provider, l]) => `  ${provider}: callsLeft=${l.callsLeft}, resetCount=${l.resetCount}`,
      );
      if (lines.length === 0) {
        ctx.ui.notify("my-subscriber: ещё ни одного reset не наблюдалось", "info");
      } else {
        ctx.ui.notify("my-subscriber:\n" + lines.join("\n"), "info");
      }
    },
  });
}
