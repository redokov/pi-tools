# Архитектура pi-billing-window

Документ описывает внутреннее устройство расширения: кто за что отвечает, как данные текут между модулями, какие инварианты поддерживаются и где границы применимости.

## 1. Слои

```
┌────────────────────────────────────────────────────────────────┐
│                          index.ts                              │
│   оркестратор: хуки pi, регистрация команд, EventBus            │
└────────────────────────────────────────────────────────────────┘
          │              │              │              │
          ▼              ▼              ▼              ▼
    ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐
    │ state.ts │  │ticker.ts │  │   ui.ts  │  │ parser.ts /  │
    │ JSON+lock│  │ setIntvl │  │ setStatus│  │ notifier.ts  │
    └──────────┘  └──────────┘  └──────────┘  └──────────────┘
```

- **state.ts** — единственный модуль с I/O. Все остальные читают/пишут только через `readStateSync()` и `mutateState()`. Это позволяет держать инвариант «state всегда либо валидный, либо `null`» в одном месте.
- **ticker.ts** — единственный модуль с `setInterval`. Останавливается/запускается ровно один раз за сессию (через `ensureTickerStarted`/`shutdownTicker` в `index.ts`).
- **ui.ts** — единственный модуль, который пишет в `ctx.ui.setStatus`. Все вызовы обёрнуты в проверку `ctx.mode === "tui"`.
- **parser.ts** — чистые функции, ноль сайд-эффектов.
- **notifier.ts** — fire-and-forget HTTP. Никогда не бросает. Ничего не блокирует.

## 2. Жизненный цикл state

```
              ┌──────────────────┐
              │  state file      │
              │  не существует   │
              └────────┬─────────┘
                       │ session_start → readStateSync() === null
                       ▼
              ┌──────────────────┐
              │  makeInitial-    │
              │  State()         │ ──► mutateState(() => ({ next: initial }))
              └────────┬─────────┘
                       │  первый after_provider_response к wormsoft
                       ▼
              ┌──────────────────┐         каждые 5 мин (ticker.ts)
              │  окно активно    │ ◄──────►  checkAndReset()
              │  callsInWindow++ │           - истекло? → reset + emit
              │  firstCallEmitted│           - <5 мин до конца? → about_to_reset
              └────────┬─────────┘
                       │  windowStartedAt + windowMs <= now
                       ▼
              ┌──────────────────┐
              │  reset           │
              │  resetCount++    │
              │  windowStartedAt │
              │  = now           │
              └────────┬─────────┘
                       │  бродкаст billing:window_reset
                       ▼
              ┌──────────────────┐
              │  новый цикл      │
              └──────────────────┘
```

**Гарантии:**
- `windowStartedAt` всегда ≤ `now()`.
- `resetCount` монотонно растёт (никогда не уменьшается).
- `callsInWindow` сбрасывается в 0 только при `reset` (ручном или автоматическом).
- `firstCallEmittedAt` ставится ровно один раз — на первом вызове после `reset`. Очищается при следующем `reset`.

## 3. Поток данных в `onAfterProviderResponse`

```
pi runtime
   │
   │ event { status, headers }
   ▼
index.ts::onAfterProviderResponse
   │
   ├── filter: status < 400 AND ctx.model.provider === "wormsoft"
   │
   ├── readStateSync()  ─────► before (для windowStartedAt в first_call payload)
   │
   ├── mutateState((cur) => {
   │     next = { ...cur, callsInWindow: cur.callsInWindow + 1,
   │              firstCallEmittedAt: if undefined → timestamp }
   │   })
   │
   ├── if firstCallJustEmitted → buildEmitFn()("llm:first_call", { provider, timestamp, windowStartedAt })
   │
   ├── if ctx.mode === "tui" → forceUpdateStatus(ctx)   // обновить footer немедленно
   │
   └── checkAndReset(buildEmitFn())
         └── если окно пересеклось во время этого вызова → reset + emit
```

## 4. Конкурентность

Несколько `pi`-процессов могут одновременно работать (например, основной терминал и фоновая сессия). Чтобы не потерять события и не сделать двойной reset, используется:

1. **`proper-lockfile`** — файл-блокировка `~/.pi/agent/pi-billing-window.lock`. `mutateState()` оборачивает чтение+запись+возврат результата в `lock()`/`unlock()` с 8 ретраями.
2. **Дедуп по `lastResetAt`** — в `checkAndReset` после записи нового состояния проверяется `now - lastResetAt < DEDUP_WINDOW_MS (10 мин)`. Если да — повторного `emit("billing:window_reset")` не будет.

Это значит:
- Два процесса **могут** независимо увидеть, что окно истекло. Только первый получит право на запись reset и emit; второй, взяв лок после первого, увидит свежий `lastResetAt` и тихо выйдет.
- `emit` выполняется **после** `unlock` (в `ticker.ts::checkAndReset` мутация под локом завершается, и только потом `emit("billing:window_reset", fresh)`). Это уменьшает шанс ситуации «emit ушёл со старым state».

## 5. Шина событий

Подробнее — в [`EVENTBUS.md`](./EVENTBUS.md). Краткая сводка:

| Канал | Кто слушает внутри плагина | Кто может слушать снаружи |
|---|---|---|
| `llm:first_call` | — | любой (например, логгер) |
| `billing:window_reset` | `handleWindowReset` (TUI notify), `handleWindowResetForNotify` (HTTP POST в pi-remote) | `wormsoft-rate-limit`, аналитика и т.п. |
| `billing:window_about_to_reset` | `handleAboutToReset` (пока no-op) | любой |

Внутри плагина используется `pi.events` (нетипизированная шина). `pi.on(...)` для cross-extension каналов не подходит — он принимает только стандартные `ExtensionEvent`-имена.

## 6. Зависимости и порядок инициализации

1. `npm install` подтягивает `proper-lockfile`, `@types/node`, `tsx`, `typescript`.
2. `pi` запускается, читает `package.json#pi.extension` → загружает `src/index.ts`.
3. `default function (pi)` вызывается, регистрирует хуки и команды (ещё **до** `session_start`).
4. На `session_start`:
   - подписываемся на свои каналы в EventBus;
   - инициализируем state, если отсутствует;
   - запускаем `ticker` (idempotent);
   - запускаем `ui` (только в TUI);
   - вызываем `forceUpdateStatus` — чтобы футер сразу отражал сохранённое состояние.

## 7. Failure modes

| Сценарий | Что происходит |
|---|---|
| state-файл повреждён (не парсится) | `readStateSync` вернёт `null`. `session_start` создаст свежий initial state (с `resetCount = 0` — состояние нельзя «восстановить» без бэкапа). |
| lock-файл застрял (предыдущий процесс умер, не сняв лок) | `proper-lockfile` сам обнаружит и удалит stale-lock по TTL. |
| `setNotify` (HTTP в pi-remote) не отвечает | `sendNotify` через 3 с делает `AbortController.abort()`, в лог уходит warn, в EventBus ничего не отправляется. На состояние окна это не влияет. |
| `ctx.ui` или `ctx.ui.setStatus` отсутствует | `applyStatus` молча выходит (try-catch + проверка типов). |
| Два процесса одновременно пишут state | `proper-lockfile` сериализует доступ. Потеря данных невозможна, но возможен повторный emit без reset (блокируется дедупом). |
| Вызов к провайдеру возвращает 4xx/5xx | `onAfterProviderResponse` отфильтровывает (`status >= 400 → return`). Лимит не «съедается» ошибочными вызовами. |
| `ctx.model` не определён (очень ранний старт, RPC) | Фильтр в `onAfterProviderResponse` не сработает, событие будет проигнорировано. |

## 8. Что можно вынести за пределы расширения

| Компонент | Сейчас | Альтернатива |
|---|---|---|
| Storage | JSON в `~/.pi/agent/` | SQLite / общий daemon-state |
| Tick | `setInterval` внутри плагина | Внешний cron + JSON-RPC |
| UI | `ctx.ui.setStatus` | полноценный `CustomView` (если будет поддержан в pi API) |
| Notifier | прямой HTTP в pi-remote | публикация в общий EventBus, откуда читает кто угодно |
