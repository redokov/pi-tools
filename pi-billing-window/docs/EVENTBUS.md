# Шина событий (EventBus)

Расширение использует `pi.events` (нетипизированная шина между расширениями) для публикации и подписки на каналы, связанные со сбросом 2-часового окна.

## 1. Каналы

### 1.1. `llm:first_call`

**Источник:** `src/index.ts::onAfterProviderResponse` (на первом успешном вызове к `wormsoft` в окне).

**Payload:**
```ts
{
  provider: string;          // "wormsoft"
  timestamp: number;         // Date.now() в момент вызова
  windowStartedAt: number;   // windowStartedAt из state до этого вызова
}
```

**Гарантии:**
- Эмитится ровно один раз между двумя последовательными reset.
- Устанавливается атомарно (через `mutateState`), параллельные первые вызовы не продублируют событие.

**Когда слушать:**
- Логгеры и аудит-расширения.
- Расширения, которые хотят инициализировать какое-то своё состояние при начале нового окна.

### 1.2. `billing:window_reset`

**Источник:** `src/ticker.ts::checkAndReset` (по истечении окна), `src/index.ts::registerBillingReset` (`/billing-reset`), `src/index.ts::registerSettimer` (`/settimer 0` — прямой emit в обход дедупа).

> Событие также триггерит срабатывание флага `/cont-after-reset` — но **не через шину**: arms-механизм читает `state.lastResetAt` напрямую из state-файла (см. [`STATE.md`](./STATE.md) §8.3). Так задумано: флаг должен сработать и в тех окнах, которые не подписаны на шину.

**Payload:** полный `State` (см. [`STATE.md`](./STATE.md)):
```ts
{
  provider: string;
  windowStartedAt: number;
  windowMs: number;
  lastResetAt: number;
  resetCount: number;
  callsInWindow: number;
  firstCallEmittedAt?: number;
}
```

**Гарантии:**
- После reset значение `callsInWindow === 0`, `firstCallEmittedAt === undefined`.
- Дедуп: если с момента предыдущего reset прошло < `DEDUP_WINDOW_MS (10 мин)`, повторный emit не производится.

**Когда слушать:**
- Расширения, ограничивающие частоту запросов или ведущие собственный учёт расхода.
- Расширения, показывающие пользователю «лимит обновлён» (тосты, баннеры).
- Бэкенд-аналитика, считающая агрегированный расход.

### 1.3. `billing:window_about_to_reset`

**Источник:** `src/ticker.ts::checkAndReset` (когда до конца окна осталось ≤ `ABOUT_TO_RESET_MS (5 мин)`, и reset не произошёл в этом тике).

**Payload:**
```ts
{
  provider: string;
  msRemaining: number;       // мс до конца окна (>= 0)
}
```

**Когда слушать:**
- Расширения, которые хотят заранее подсветить счётчик («осталось X минут»).
- Планировщики отложенных задач, чтобы не уходить в новый цикл прямо перед reset.

## 2. Подписка снаружи

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  // Шина живёт на ExtensionAPI (pi.events), а не на ctx — захватите её
  // в фабрике расширения, как это делает сам pi-billing-window.
  const bus = pi.events as
    | { on: (channel: string, handler: (data: unknown) => void) => () => void }
    | undefined;
  if (!bus) return;

  pi.on("session_start", async (_evt, ctx) => {
    const off = bus.on("billing:window_reset", async (raw) => {
      const state = raw as {
        provider: string;
        resetCount: number;
        callsInWindow: number;
      };
      // например: сбросить собственный rate-limit
      myRateLimiter.reset(state.provider);
    });
    // off() — на session_shutdown
    // (замыкание: сохраните off в переменной, доступной в session_shutdown)
  });
}
```

> **Лучшая практика:** оборачивайте listener в `try/catch` и валидируйте payload. Ошибка в одном listener не должна ронять pi. Шина `pi.events` это гарантирует, но **ваш собственный код** — нет.

## 3. Известные подписчики внутри проекта

| Listener | Где | Что делает |
|---|---|---|
| `handleWindowReset` | `src/index.ts` | `ctx.ui.notify` в TUI-режиме (текст: «wormsoft: 2-часовой лимит сброшен…»). |
| `handleWindowResetForNotify` | `src/index.ts` | HTTP POST в `pi-remote` (`/api/notify`) для браузерных клиентов. |
| `handleAboutToReset` | `src/index.ts` | Пока no-op (заглушка, чтобы канал точно был «подключен»). |

> Механизм `/cont-after-reset` слушает шину **намеренно не использует** — он детектирует сброс по `state.lastResetAt` из общего state-файла, чтобы работать во всех окнах pi независимо от порядка загрузки расширений (см. §1.2 и [`ARCHITECTURE.md`](./ARCHITECTURE.md) §5).

## 4. Контракт стабильности

- **Имена каналов** считаются частью публичного API и меняются через мажорную версию.
- **Payload** — дополняется новыми полями без поломки старых подписчиков (поля опциональны). Удаление поля = breaking change.
- **Порядок вызовов**: при сбросе окна гарантированно один `billing:window_reset`. Никаких «по одному событию на каждый listener».

## 5. Отладка

- `/billing-tick` показывает payload первого события, которое **было бы** отправлено, прямо в `ctx.ui.notify`.
- Подписчик может временно логировать всё в `console.warn` (видно в `~/.pi/agent/logs/`).
- Если событий нет вообще — проверьте, что ваш `session_start` запустился **после** того, как `pi-billing-window` зарегистрировал `startTicker()`. Обычно порядок загрузки расширений алфавитный по имени, но это нигде не задокументировано как контракт.
