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
          │
          ▼
    ┌──────────┐
    │ arms.ts  │
    │ JSON+lock│
    └──────────┘
```

- **state.ts** — единственный модуль с I/O. Все остальные читают/пишут только через `readStateSync()` и `mutateState()`. Это позволяет держать инвариант «state всегда либо валидный, либо `null`» в одном месте.
- **arms.ts** — второй I/O-модуль: per-разговор флаги `/cont-after-reset` в отдельном файле (см. §5 и [`STATE.md`](./STATE.md) §8). Тот же паттерн, что и state.ts: атомарная запись + `proper-lockfile`. От state.ts не зависит — только index.ts и ui.ts его используют.
- **ticker.ts** — единственный модуль с `setInterval`. Останавливается/запускается ровно один раз за сессию (через `ensureTickerStarted`/`shutdownTicker` в `index.ts`). (Исключение — armed-poller из §5: отдельный интервал, живёт пока флаг взведён.)
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

## 5. Автопродолжение после сброса (cont-after-reset)

Фича «взведённый флаг»: когда 2-часовое окно сбросится, в чат текущего окна отправляется слово `продолжи`, и прерванная задача возобновляется. Реализована поверх отдельного файла флагов (см. [`STATE.md`](./STATE.md) §8), шину событий **не использует** — сброс читается напрямую из state-файла (`state.lastResetAt`), который виден всем процессам pi.

### 5.1. Цикл armed-poller и срабатывание

```
/cont-after-reset
   │
   ├── armsArm(lastResetAt)   — фиксируем lastResetAt на момент взвода
   │                            (сработает только сброс ПОСЛЕ него)
   ├── ensureArmedPoller()    — опрос каждые 10 с (ARMED_POLL_MS)
   └── boundary-таймер        — одноразовый checkAndReset() на точной
                                границе окна (+500 мс), чтобы reset
                                не ждал 5-минутного тика тикера
   │
   ▼  каждые 10 с: evaluateArmedReset()
   ├── флага нет/истёк → stopArmedPoller(), выйти
   ├── resetReadyToFire(arm, state, now)?
   │     (state.lastResetAt > arm.lastResetAtAtArm  И
   │      now - state.lastResetAt >= RESET_GRACE_MS (60 c))
   │     ├─ нет → если окно уже истекло, а lastResetAt не продвинулся
   │     │        (reset «принадлежит» другому процессу) — форсируем
   │     │        checkAndReset() сами; иначе ждём следующего опроса
   │     └─ да → fireContinue(arm)
   │              ├── ctx.isIdle() === false (агент стримит) → ждём,
   │              │   повтор на следующем опросе (флаг сохраняется)
   │              └── idle → pi.sendUserMessage("продолжи") →
   │                    stopArmedPoller() + armsDisarm()  (one-shot)
   └── (сбой sendUserMessage → флаг сохранён, ретрай на следующем опросе)
```

`resetReadyToFire` — чистая функция в `arms.ts`, покрыта юнит-тестами (`tests/arms.test.mts`); grace в 60 с нужен, чтобы wormsoft успел вернуть токены после сброса.

### 5.2. Хранение и ключи

Каждое окно pi — отдельный процесс, работающий ровно с одним разговором. Флаги хранятся в общем файле по ключу **файла сессии** (`ctx.sessionManager.getSessionFile()`; fallback `ephemeral:<pid>` для headless-режимов). Процесс помнит `currentKey` и читает/пишет только запись своего разговора — флаги чужих окон ему не видны и не мешают.

### 5.3. Жизненный цикл флага

| Событие | Что происходит |
|---|---|
| `/cont-after-reset` | Взвод (идемпотентно: активный флаг не перезаписывается). |
| `/cont-after-reset off` | Снятие + остановка poller'а. |
| Сброс окна + 60 с | Отправка `продолжи`, снятие флага (one-shot). |
| TTL 2 ч 10 мин | Флаг истекает (`expiresAt`), игнорируется и вычищается при следующей записи в файл. |
| `/new` (`session_start`, `reason="new"`) | `carryArmTo(newKey)`: запись переносится на новый файл сессии — флага продолжает работать в том же окне. |
| `/resume`, `/fork`, `/reload`, старт | `switchKey(newKey)` без переноса: флаг остаётся у разговора, где был взведён, и подхватывается только при возврате к нему (в т.ч. после перезапуска процесса — «переусыновление»). |
| `session_shutdown` | Poller **не** останавливается намеренно: module-state переживает `/new` и переключения разговоров внутри процесса. |

Взведённое состояние отражается в футере TUI маркером `[cont-after-reset]` (обновляется каждые 30 с и принудительно при взводе/снятии).

## 6. Шина событий

Подробнее — в [`EVENTBUS.md`](./EVENTBUS.md). Краткая сводка:

| Канал | Кто слушает внутри плагина | Кто может слушать снаружи |
|---|---|---|
| `llm:first_call` | — | любой (например, логгер) |
| `billing:window_reset` | `handleWindowReset` (TUI notify), `handleWindowResetForNotify` (HTTP POST в pi-remote) | аналитика, свои расширения |
| `billing:window_about_to_reset` | `handleAboutToReset` (пока no-op) | любой |

Внутри плагина используется `pi.events` (нетипизированная шина), захваченная в фабрике расширения в переменную `eventBus`. `pi.on(...)` для cross-extension каналов не подходит — он принимает только стандартные `ExtensionEvent`-имена.

## 7. Зависимости и порядок инициализации

1. `npm install` подтягивает `proper-lockfile`, `@types/node`, `tsx`, `typescript`.
2. `pi` запускается, читает `package.json#pi.extension` → загружает `src/index.ts`.
3. `default function (pi)` вызывается, регистрирует хуки и команды (ещё **до** `session_start`).
4. На `session_start` (порядок продуман: таймеры запускаются **до** state-I/O, чтобы сбой бутстрапа не оставлял сессию без отсчёта):
   1. подписываемся на свои каналы в EventBus;
   2. запускаем `ticker` и `ui` (TUI-only), `forceUpdateStatus` — футер сразу отражает сохранённое состояние;
   3. инициализируем state (если отсутствует) / сбрасываем истекшее окно через `checkAndReset` — в try/catch: ошибка (например, lock timeout) деградирует до warn в лог;
   4. привязываем arms: `reason === "new"` → `carryArmTo(key)`, иначе `switchKey(key)`; если флаг активен — `ensureArmedPoller()`.
5. Дополнительно на `model_select` — `forceUpdateStatus` с провайдером новой модели: переключение модели меняет провайдера без LLM-вызова, и футер должен отреагировать немедленно.

## 8. Failure modes

| Сценарий | Что происходит |
|---|---|
| state-файл повреждён (не парсится) | `readStateSync` вернёт `null`. `session_start` создаст свежий initial state (с `resetCount = 0` — состояние нельзя «восстановить» без бэкапа). |
| lock-файл застрял (предыдущий процесс умер, не сняв лок) | `proper-lockfile` сам обнаружит и удалит stale-lock по TTL. |
| `setNotify` (HTTP в pi-remote) не отвечает | `sendNotify` через 3 с делает `AbortController.abort()`, в лог уходит warn, в EventBus ничего не отправляется. На состояние окна это не влияет. |
| `ctx.ui` или `ctx.ui.setStatus` отсутствует | `applyStatus` молча выходит (try-catch + проверка типов). |
| Два процесса одновременно пишут state | `proper-lockfile` сериализует доступ. Потеря данных невозможна, но возможен повторный emit без reset (блокируется дедупом). |
| arms-файл повреждён (не парсится) | `readArmsSync` вернёт `{}` — флаги просто теряются (молча), взводится заново вручную. На state окна не влияет. |
| arms-lock застрял | Аналогично state-lock: `proper-lockfile` снимет stale-lock по TTL. |
| `pi.sendUserMessage` упал при срабатывании | Флаг сохраняется, poller ретраит на следующем опросе (10 с). |
| Взвод в headless-режиме (нет файла сессии) | Ключ `ephemeral:<pid>`: флаг работает, но привязан к процессу и переживёт только пока процесс жив. |
| Вызов к провайдеру возвращает 4xx/5xx | `onAfterProviderResponse` отфильтровывает (`status >= 400 → return`). Лимит не «съедается» ошибочными вызовами. |
| `ctx.model` не определён (очень ранний старт, RPC) | Фильтр в `onAfterProviderResponse` не сработает, событие будет проигнорировано. |

## 9. Что можно вынести за пределы расширения

| Компонент | Сейчас | Альтернатива |
|---|---|---|
| Storage | JSON в `~/.pi/agent/` | SQLite / общий daemon-state |
| Tick | `setInterval` внутри плагина | Внешний cron + JSON-RPC |
| UI | `ctx.ui.setStatus` | полноценный `CustomView` (если будет поддержан в pi API) |
| Notifier | прямой HTTP в pi-remote | публикация в общий EventBus, откуда читает кто угодно |
