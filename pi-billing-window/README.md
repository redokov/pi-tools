# pi-billing-window

Расширение для [`pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), которое отслеживает скользящее 2-часовое окно расхода токенов у провайдера **wormsoft** и публикует кастомные события на шине `EventBus` для других расширений.

Проект разработки: **`C:\Tools\pi-billing-window`** (исходники в `src/`, тесты в `tests/`, документация в `docs/`).
Установленная (рабочая) копия: **`C:\Users\r.edokov\.pi\agent\extensions\pi-billing-window\`**.

---

## 1. Назначение

У LLM-провайдера **wormsoft** действует лимит «5M токенов в скользящие 2 часа». Платформа `pi` сама этот лимит не знает, и при исчерпании лимита пользователь обнаруживает это только по 429-й ошибке. Это расширение:

1. **Считает вызовы** к `wormsoft` в текущем 2-часовом окне.
2. **Фиксирует момент первого вызова** — с него начинается окно.
3. **Каждые 5 минут** проверяет, не истекло ли окно, и при истечении сбрасывает счётчик и шлёт событие `billing:window_reset`.
4. **За 5 минут до конца окна** шлёт событие `billing:window_about_to_reset`, чтобы другие расширения могли предупредить пользователя.
5. **Показывает обратный отсчёт** в статус-баре TUI (обновление каждые 30 секунд).
6. **Прокидывает событие `billing:window_reset` в `pi-remote`** (HTTP POST на `http://localhost:7681/api/notify`), чтобы открытые браузерные вкладки (главная и терминальные `/room/:name`) получили тост + системное уведомление.

---

## 2. Архитектура

```
index.ts ──── оркестратор: хуки (session_start, model_select,
             after_provider_response, session_shutdown) + команды
             (/billing-status, /billing-tick, /billing-reset,
             /settimer, /cont-after-reset)
  │
  ├── state.ts  ──── JSON-файл + proper-lockfile для межпроцессной
  │                  синхронизации state. mutateState() / readStateSync()
  │
  ├── ticker.ts ──── setInterval(TICK_MS=5min) → checkAndReset(emit).
  │                  Дедуп через lastResetAt (<10 мин → повторно не шлём).
  │
  ├── arms.ts   ──── per-разговор флаги /cont-after-reset (отдельный
  │                  JSON-файл + lock). Poller 10 с + grace 60 с.
  │
  ├── ui.ts ──────── setStatus("billing-window", "[осталось: H:MM м.]"),
  │                  только для ctx.mode === "tui". Обновление каждые 30 с.
  │
  ├── parser.ts ──── parseDuration("1h30m"/"60"/"90m") для /settimer.
  │
  ├── history.ts ─── append-only CSV-история (вызовы с usage токенов, сбросы)
  │                  в ~/.pi/agent/pi-billing-window-history.csv (общий на
  │                  все окна). Отчёт: scripts/billing_report.py.
  │
  └── notifier.ts ── fire-and-forget POST на pi-remote /api/notify,
                     никогда не бросает.
```

**Каналы EventBus** (через `pi.events.emit` / `pi.events.on`):

| Канал | Источник | Payload |
|---|---|---|
| `llm:first_call` | `index.ts::onAfterProviderResponse` | `{ provider, timestamp, windowStartedAt }` |
| `billing:window_reset` | `ticker.ts::checkAndReset` или `/billing-reset` / `/settimer 0` | полный `State` |
| `billing:window_about_to_reset` | `ticker.ts::checkAndReset` | `{ provider, msRemaining }` |

> **Важно:** для cross-extension рассылки используется `pi.events` (нетипизированная шина), а не `pi.on(...)` — последний принимает только фиксированный набор `ExtensionEvent`-имён и не пропустит произвольные каналы.

---

## 3. Состояние

Файл: **`~/.pi/agent/pi-billing-window.json`** (создаётся при первом `session_start`, если отсутствует).

```ts
type State = {
  provider: string;          // "wormsoft"
  windowStartedAt: number;   // ms epoch — момент первого вызова в окне
  windowMs: number;          // 7200000 (2 часа)
  lastResetAt: number;       // ms epoch — последний реальный reset
  resetCount: number;        // счётчик ручных/авто-сбросов
  callsInWindow: number;     // инкремент на каждом успешном вызове
  firstCallEmittedAt?: number; // ms epoch первого вызова (для /settimer и дебага)
};
```

Запись — атомарная (`writeFileSync(tmp) → renameSync`). Чтение/мутация — под локом `proper-lockfile` (`withLock`). Файл лока: **`~/.pi/agent/pi-billing-window.lock`**.

---

## 4. Команды

| Команда | Что делает |
|---|---|
| `/billing-status` | Показать в `ctx.ui.notify`: провайдер, остаток до reset (чч:мм), `calls`, `resets`. |
| `/billing-tick` | Принудительный `checkAndReset()` прямо сейчас (без ожидания 5 минут) + превью payload событий. |
| `/billing-reset` | Ручной сброс: `resetCount++`, `callsInWindow = 0`, новый `windowStartedAt = now`, эмитит `billing:window_reset`. |
| `/settimer <duration>` | Установить **оставшееся** время до reset (синхронизация с личным кабинетом wormsoft). Форматы: `60` (минуты), `90m`, `2h`, `1h30m`. `0` = немедленный reset. Ограничено 2 ч. |
| `/cont-after-reset [off]` | Автопродолжение после сброса (одноразово) — см. раздел 8a. |

---

## 5. Структура проекта разработки

```
C:\Tools\pi-billing-window\
├── README.md              # этот файл — общий обзор проекта
├── package.json           # name=pi-billing-window, type=module, pi.extension → src/index.ts
├── tsconfig.json          # ES2022, module=ESNext, strict, paths → pi-coding-agent
├── src/                   # исходники расширения
│   ├── index.ts           # оркестратор, регистрация хуков и команд
│   ├── state.ts           # file-backed JSON state + lock
│   ├── ticker.ts          # 5-минутный цикл проверки окна
│   ├── ui.ts              # setStatus-виджет в TUI footer
│   ├── parser.ts          # parseDuration / formatDuration
│   ├── history.ts         # append-only CSV-история вызовов/сбросов
│   └── notifier.ts        # HTTP POST в pi-remote
├── scripts/
│   └── billing_report.py  # MD-отчёт из history.csv (по проектам/суммарно)
├── tests/
│   ├── test.mts           # unit-тесты (state, ticker, ui, parser, notifier)
│   ├── arms.test.mts      # unit-тесты флагов /cont-after-reset
│   ├── history.test.mts   # unit-тесты CSV-истории
│   └── lifecycle.test.mts # регресс-тесты замены сессии (stale ctx, cont-after-reset)
├── docs/
│   ├── ARCHITECTURE.md    # подробный разбор модулей и потоков
│   ├── EVENTBUS.md        # контракт шины событий и подписчики
│   ├── STATE.md           # схема state-файла и его жизненный цикл
│   ├── COMMANDS.md        # спецификация команд пользователя
│   └── DEV-WORKFLOW.md    # как собирать, тестировать, релизить
└── examples/
    └── subscribe.ts       # пример подписчика на billing:window_reset
```

---

## 6. Разработка

### 6.1. Установка зависимостей

```powershell
cd C:\Tools\pi-billing-window
npm install
```

### 6.2. Компиляция (type-check)

```powershell
npx tsc -p tsconfig.json
```

`noEmit: true` — компилятор только проверяет типы, за нас транспилирует runtime `pi` (он загружает `src/index.ts` напрямую через свой bundler).

### 6.3. Юнит-тесты

```powershell
npx tsx tests/test.mts
npx tsx tests/arms.test.mts
npx tsx tests/history.test.mts
npx tsx tests/lifecycle.test.mts
```

Покрытие (тесты лежат в `tests/test.mts`):
- `state.ts` — read/write/lock/mutate, override путей, атомарная запись
- `ticker.ts` — `checkAndReset` (сброс, дедуп < 10 мин, about-to-reset, no-op на null)
- `ui.ts` — `renderStatusBar`, `forceUpdate`, `startStatusUpdater` (с подменой setInterval), режим `mode !== "tui"`
- `parser.ts` — все форматы (`60`, `90m`, `2h`, `1h30m`), ошибки (отрицательные, дробные, секунды, дни, мусор), `formatDuration`
- `notifier.ts` — успех, не-2xx, таймаут, сетевая ошибка, отсутствие url и token

Покрытие `tests/arms.test.mts`:
- `arms.ts` — взвод/снятие/идемпотентность, TTL и prune, перенос флага при `/new` (`carryArmTo`), переключение ключа без переноса (`switchKey`), `resetReadyToFire` (граница grace, срабатывание только после взвода), атомарность записи

Покрытие `tests/history.test.mts`:
- `history.ts` — создание файла (BOM + заголовок ровно один раз), append строк, RFC 4180-эскейп (запятые/кавычки/переносы), `isoLocal` (локальный offset), 5 параллельных аппендов без потери строк (лок), ретеншн-трим (граница 30 дней, идемпотентность), отказоустойчивость (невалидный путь → false/0 без throw), `resetPaths`

### 6.4. Установка / переустановка в pi

```powershell
# Скопировать src/ в рабочий каталог расширения
$dst = "C:\Users\r\.pi\agent\extensions\pi-billing-window"
Copy-Item -Recurse -Force "$PSScriptRoot\src\*" "$dst\"

# (опционально) node_modules + tsx для тестов в рабочей копии
# но удобнее держать их в C:\Tools\pi-billing-window
```

Альтернатива — симлинк (если pi читает файлы напрямую):
```powershell
New-Item -ItemType SymbolicLink `
  -Path "$env:USERPROFILE\.pi\agent\extensions\pi-billing-window" `
  -Target "C:\Tools\pi-billing-window"
```
> Проверьте, что pi действительно подхватывает симлинк; иначе используйте копирование (см. `docs/DEV-WORKFLOW.md`).

### 6.5. Локальная отладка

1. Запустите `pi-remote` (для приёма уведомлений): `cd C:\Tools\pi-remote && npm start`
2. Запустите `pi` в TUI-режиме в репозитории, где есть `.pi/agent/extensions/pi-billing-window`.
3. Введите `/billing-status` — должен появиться тост с текущим состоянием.
4. Сделайте любой вызов к wormsoft — статус-бар начнёт показывать обратный отсчёт.
5. `/settimer 0` — должен произойти немедленный reset + уведомление в браузере (вкладка главной или любой терминальной страницы `/room/:name` pi-remote).

---

## 7. Известные ограничения и соглашения

- **Только провайдер `wormsoft`.** Фильтрация по `ctx.model.provider === "wormsoft"` в `onAfterProviderResponse` и `applyStatus` в `ui.ts`. Для добавления второго провайдера нужно превратить константу `PROVIDER` в список и расширить фильтр.
- **EventBus нетипизирован.** Любой подписчик может ошибиться в имени канала. Защищайтесь: оборачивайте listener в try/catch и валидируйте `payload` перед использованием.
- **One-event-per-reset.** Дедуп в `ticker.ts::checkAndReset`: если `now - lastResetAt < DEDUP_WINDOW_MS (10 мин)`, повторного emit не будет. Это защищает от двойного сброса при двух одновременно работающих pi-процессах.
- **TUI-only статус.** `startStatusUpdater` и `forceUpdate` ничего не делают вне `ctx.mode === "tui"`. В режимах `rpc`, `print` расширение продолжает вести счёт и слать события, но без виджета.
- **`/settimer` не может увеличить окно больше 2 ч.** `durationMs` клампится к `windowMs`. Чтобы поднять лимит — меняйте константу `WINDOW_MS` в `src/index.ts` и перезапускайте pi.
- **Парсер не принимает секунды и дни.** Это намеренно: API провайдера оперирует минутами/часами, добавлять лишние форматы — лишняя поверхность для ошибок.

---

## 8. Дальнейшие шаги (roadmap)

- [x] История `callsInWindow` по минутам (CSV/MD-дамп) — реализовано, см. §8b.

---

## 8a. Автопродолжение после сброса (`/cont-after-reset`)

Когда сессия была прервана (вручную или из-за исчерпания токенов wormsoft в
текущем окне), можно поручить окну автоматически возобновить работу, когда
2-часовое окно сбросится:

- `/cont-after-reset` — взвести флаг для этой сессии (в таймере в футере
  появляется `[cont-after-reset]`). Одноразовый: сработает на ближайшем
  сбросе, после чего сгорит.
- `/cont-after-reset off` — снять флаг вручную.

Как работает:
- окно запоминает значение `lastResetAt` на момент взвода;
- сброс окна (автоматический, `/billing-reset` или `/settimer 0`) виден всем
  окнам через общий state-файл — взведённое окно замечает его и ждёт ~1 мин
  (grace), чтобы wormsoft успел вернуть токены;
- затем, если агент не стримит, в чат отправляется одно слово `продолжи`
  (`pi.sendUserMessage`), задача возобновляется. Если агент занят — ждём и
  пробуем снова;
- продолжается только взведённое окно. Остальные окна сброс просто отражают
  в счётчике.

Ограничения:
- срок годности флага — 2 ч 10 мин от взвода (если сброса за это время не
  было, флаг сгорает);
- `/new` переносит взведённый флаг в новый разговор окна; `/resume` к другой
  сессии — нет (флаг остаётся у своего разговора и сработает, когда вы к нему
  вернётесь);
- флаг хранится в `~/.pi/agent/pi-billing-window-arms.json` (по ключу файла
  сессии) и переживает перезапуск окна.

Заметка: расширение `wormsoft-rate-limit` удалено — его роль (детекция 429 и
собственный авто-`продолжи` по `+2ч`) не работала корректно и заменена этой
функцией, привязанной к реальному сбросу окна.

---

## 8b. История вызовов (`history.csv`) и отчёт

Каждое значимое событие дописывается строкой в **общий** файл `~/.pi/agent/pi-billing-window-history.csv` (один на все окна pi: лимит wormsoft аккаунтный, поэтому аналитика и по проектам, и суммарная):

| Событие | kind |
|---|---|
| Успешный вызов wormsoft | `call` — с usage последнего ответа (input/output/cache-токены), если провайдер их отдаёт |
| Авто-reset | `window_reset` (note=`auto`) |
| `/billing-reset` | `manual_reset` |
| `/settimer` | `window_reset` (note=`settimer 0`) или `settimer` (note=`sync …`) |

Проект — колонка `project` (полный cwd сессии), агент в той же папке различается колонкой `session`. Запись под локом (безопасно для нескольких процессов), UTF-8 + BOM (кириллица в Excel), ретеншн 30 дней (трим на старте сессии). Сбой истории никогда не влияет на счёт/сбросы/уведомления.

Отчёт (MD): по требованию, из каталога разработки:

```bash
python scripts/billing_report.py                              # всё за 30 дней
python scripts/billing_report.py --project Комус --days 7     # один проект (хвост пути, регистронезависимо)
python scripts/billing_report.py --days 0 --out report.md     # в файл
```

Скрипт восстанавливает окна по инкрементам `reset_count` и показывает: суммарный burn, окна каждого проекта (старт, вызовы, токены, «сколько минут прожило до исчерпания»), пиковые минуты.

---

## 9. Связанные документы

- `docs/ARCHITECTURE.md` — детальный разбор модулей и потоков данных.
- `docs/EVENTBUS.md` — полный контракт шины событий + best practices для подписчиков.
- `docs/STATE.md` — схема state-файла, lockfile, сценарии гонок.
- `docs/COMMANDS.md` — спецификация каждой команды: аргументы, побочные эффекты, сообщения об ошибках.
- `docs/DEV-WORKFLOW.md` — как собирать, тестировать, публиковать и отлаживать.
- `examples/subscribe.ts` — минимальный пример расширения-подписчика.

---

## 10. Лицензия и поддержка

Внутренний инструмент, MIT-style (уточните у владельца репозитория при выкладке в общий доступ).
Вопросы и баги — в трекер `pi-tools` или напрямую автору расширения.
