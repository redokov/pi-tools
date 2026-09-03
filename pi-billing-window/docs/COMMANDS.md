# Команды

Расширение регистрирует четыре пользовательские команды. Все доступны и в TUI, и в других режимах (rpc, print), но уведомления через `ctx.ui.notify` показываются только в TUI.

## 1. `/billing-status`

**Аргументы:** нет.

**Поведение:**
1. Читает state через `readStateSync()`.
2. Если state отсутствует — `notify("pi-billing-window: state не инициализирован", "info")`.
3. Иначе считает `remain = max(0, windowMs - (now - windowStartedAt))`, форматирует как `HH:MM ч:мин` и показывает: `<provider>: до reset HH:MM ч:мин (calls=N, resets=N)`.

**Сообщения:**
- Успех: `wormsoft: до reset 01:23 ч:мин (calls=42, resets=17)`
- Пусто: `pi-billing-window: state не инициализирован`

**Побочные эффекты:** нет.

## 2. `/billing-tick`

**Аргументы:** нет.

**Поведение:**
1. Обновляет `currentCtx` (чтобы `buildEmitFn()` находил живую шину).
2. Определяет локальный `emit`, который превращает каждый эмит в `ctx.ui.notify("[<event>] <payload-json-truncated>", "info")`.
3. Вызывает `checkAndReset(localEmit)`.
4. Показывает результат: `Тик: reset произошёл` или `Тик: reset не произошёл`.

**Сообщения:**
- Если бы произошёл `billing:window_reset` (но он подавлен дедупом в большинстве случаев): `[billing:window_reset] {"provider":"wormsoft","windowStartedAt":..., ...}`
- Если бы произошёл `billing:window_about_to_reset`: `[billing:window_about_to_reset] {"provider":"wormsoft","msRemaining":12345}`
- Финал: `Тик: reset произошёл` / `Тик: reset не произошёл`

**Использование:** отладка без ожидания 5-минутного интервала.

**Побочные эффекты:** возможен реальный reset (если дедуп не сработает) — это **изменит** `windowStartedAt`, `resetCount`, обнулит `callsInWindow`.

## 3. `/billing-reset`

**Аргументы:** нет.

**Поведение:**
1. `mutateState`: `resetCount++`, `windowStartedAt = now`, `lastResetAt = now`, `callsInWindow = 0`, `firstCallEmittedAt = undefined`.
2. `notify("Окно сброшено вручную", "info")`.
3. Если `ctx.mode === "tui"` — `forceUpdateStatus(ctx)` (обновить футер немедленно).
4. Если есть `bus` — эмитит `billing:window_reset` со свежим state.

**Сообщения:**
- Успех: `Окно сброшено вручную`
- (через шину): `billing:window_reset` со свежим state, а также `handleWindowReset` нарисует «wormsoft: 2-часовой лимит сброшен…» в TUI.

**Побочные эффекты:** сброс окна (см. таблицу в [`STATE.md`](./STATE.md)).

## 4. `/settimer <duration>`

**Аргумент:** строка длительности.

**Поддерживаемые форматы:**

| Формат | Пример | Интерпретация |
|---|---|---|
| `N` (целое) | `60` | N минут |
| `Nm` | `90m` | N минут |
| `Nh` | `2h` | N часов |
| `Nh Nm` | `1h30m` | N часов и M минут |

Допускаются пробелы между частями: `1 h 30 m`. Регистр не важен.

**Не поддерживается:** `Ns`, `Nd`, дробные числа (`1.5`), отрицательные значения, мусор.

**Поведение:**
1. Парсит аргумент через `parseDuration(arg)`.
2. Если ошибка — `notify("Неверный формат: '<arg>'. Примеры: 60, 1h30m, 0", "error")`.
3. Если пустой аргумент — `notify(usage, "info")`.
4. Clamp: `durationMs = min(max(0, parsed.totalMs), windowMs)`.
5. Пересчитывает `windowStartedAt = now - (windowMs - durationMs)`.
6. `mutateState`: новый `windowStartedAt`, `lastResetAt = now`, `resetCount++`, `callsInWindow = 0`, `firstCallEmittedAt = undefined`.
7. `checkAndReset(buildEmitFn())` — если `durationMs = 0` или целевое окно уже истекло, сработает дедуп и emit `billing:window_reset` (или тихо выйдет, если `lastResetAt` уже свежий).
8. `notify("Таймер установлен: HH:MM:SS до reset", "info")`.
9. Если TUI — `forceUpdateStatus(ctx)`.

**Сообщения:**

| Кейс | Текст |
|---|---|
| Пустой аргумент | `Использование: /settimer <длительность>\nПримеры: /settimer 60, /settimer 1h30m, /settimer 0 (сброс)` |
| Неверный формат | `Неверный формат: '<arg>'. Примеры: 60, 1h30m, 0` |
| Отрицательное | `Неверный формат: '<arg>'. Примеры: 60, 1h30m, 0` (из парсера, подсказка: «отрицательное значение недопустимо») |
| Дробное | (подсказка парсера: «дробные значения не поддерживаются») |
| `60s` / `1d` | (подсказка парсера: «секунды/дни не поддерживаются, используйте минуты или часы») |
| Успех | `Таймер установлен: 00:01:30 до reset` |

**Примеры:**

```text
/settimer 96          → 96 мин до reset (1 ч 36 мин)
/settimer 1h30m       → 1 ч 30 мин до reset
/settimer 2h          → 2 ч до reset (= длине окна; фактически «только что начали»)
/settimer 0           → немедленный reset (windowStartedAt = now - 2ч → сразу истекшее)
/settimer 10h         → clamp до 2 ч (WINDOW_MS), результат как /settimer 2h
/settimer abc         → ошибка формата
/settimer 90s         → ошибка: «секунды не поддерживаются»
```

**Побочные эффекты:** сброс окна со всеми вытекающими.

## 5. Общие соглашения

- Все команды **не должны** ронять pi. Любая ошибка ловится и показывается через `notify`.
- Команды идемпотентны там, где это осмысленно: `/billing-status` (чтение), `/billing-tick` (с дедупом). `/billing-reset` и `/settimer` — **изменяющие**, у них побочный эффект на state и emit событий.
- Если `ctx.ui.notify` отсутствует (rpc-режим) — все уведомления молча проглатываются. Это намеренно: в headless-режиме мы не хотим засорять лог.
