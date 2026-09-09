# Состояние (state)

Файл: **`~/.pi/agent/pi-billing-window.json`** (создаётся при первом `session_start`).
Lockfile: **`~/.pi/agent/pi-billing-window.lock`**.

## 1. Схема

```ts
type State = {
  provider: string;             // "wormsoft"
  windowStartedAt: number;      // ms epoch — момент первого вызова в окне
  windowMs: number;             // 7200000 (2 часа)
  lastResetAt: number;          // ms epoch — последний реальный reset (>= windowStartedAt)
  resetCount: number;           // >= 0
  callsInWindow: number;        // >= 0
  firstCallEmittedAt?: number;  // ms epoch первого вызова, сброшен при reset
};
```

## 2. Жизненный цикл полей

| Поле | Когда создаётся | Когда меняется | Когда обнуляется |
|---|---|---|---|
| `provider` | при создании initial state | никогда | никогда |
| `windowStartedAt` | initial state = `Date.now()` | reset → `Date.now()`, `/settimer` → пересчёт | при reset |
| `windowMs` | initial state = `2h` | только вручную в коде (или при миграции) | никогда |
| `lastResetAt` | initial state = `0` | reset → `Date.now()`, `/settimer` → `Date.now()` | никогда (только растёт) |
| `resetCount` | initial state = `0` | reset → `+1`, `/settimer` → `+1`, `/billing-reset` → `+1` | никогда (только растёт) |
| `callsInWindow` | initial state = `0` | каждый успешный вызов к wormsoft → `+1` | reset → `0` |
| `firstCallEmittedAt` | на первом вызове в окне = `Date.now()` | никогда | reset → `undefined` |

## 3. Атомарность записи

`writeStateSync(state)`:
1. `fs.mkdirSync(dirname, { recursive: true })` — гарантирует каталог.
2. `fs.writeFileSync(tmp = stateFile + ".tmp." + pid, ...)` — пишем во временный файл.
3. `fs.renameSync(tmp, stateFile)` — атомарный rename.

Это защищает от полупустого файла, если процесс упадёт между шагами 2 и 3.

## 4. Синхронизация между процессами

`withLock(fn)`:
1. Создаёт lock-файл, если его нет (`fs.writeFileSync(lockFile, "{}")`).
2. `lockfile.lock(lockFile, { retries: 8 })` — `proper-lockfile` сериализует доступ (по умолчанию ждёт до ~1 с, потом retry).
3. Выполняет `fn()`.
4. `lockfile.unlock(lockFile)` — в `finally`, с подавлением ошибки unlock.

Внутри `mutateState(transform)`:
1. Берёт лок.
2. Читает текущий state через `readStateSync()`.
3. Вызывает `transform(current)` → возвращает `{ next, result? }`.
4. Если `next !== null` — пишет через `writeStateSync`.
5. Возвращает `result`.

## 5. Сценарии гонок

### 5.1. Два процесса, окно истекло

| Время | Процесс A | Процесс B |
|---|---|---|
| t0 | `checkAndReset` берёт лок, видит `elapsed >= windowMs`, пишет reset | ждёт лок |
| t0+ε | эмитит `billing:window_reset`, отпускает лок | получает лок |
| t0+ε+δ | — | видит свежий `lastResetAt`, `elapsed < DEDUP_WINDOW_MS` → тихо выходит |

**Итог:** ровно один `emit`, корректный state.

### 5.2. Один процесс перезапускается во время записи

| Время | Процесс A |
|---|---|
| t0 | `writeFileSync(tmp, …)` |
| t1 | SIGKILL — процесс умер до `renameSync` |
| t2 | tmp-файл остаётся на диске |
| t3 | Новый запуск. `readStateSync()` читает прежний `stateFile`, мутация идёт поверх. tmp-файл перезаписывается при следующей записи. |

**Итог:** консистентное состояние, мусорный tmp-файл будет перезаписан в ближайшем цикле. Можно периодически чистить `*.tmp.*` при старте (не реализовано — крайне редкий кейс).

### 5.3. Параллельный первый вызов после reset

| Время | Процесс A | Процесс B |
|---|---|---|
| t0 | `after_provider_response` → mutateState, `firstCallEmittedAt === undefined` → ставит timestamp | ждёт лок |
| t0+ε | отпускает лок | mutateState, видит `firstCallEmittedAt === <timestamp>` → не трогает поле |
| t0+ε+δ | эмитит `llm:first_call` с timestamp A | (не эмитит — `firstCallJustEmitted === false`) |

**Итог:** ровно один `emit` от первого процесса.

### 5.4. `/settimer` одновременно с авто-reset

| Время | Команда `/settimer 0` | Ticker |
|---|---|---|
| t0 | mutateState, `windowStartedAt = now` (откат через `now - (windowMs - 0)` даёт `windowStartedAt = now - windowMs`, то есть окно сразу «истекшее») | — |
| t0+ε | checkAndReset → видит, что окно истекло, но `lastResetAt` уже свежий от mutateState → дедуп срабатывает, без emit | checkAndReset → видит тот же state → тоже дедуп |

**Итог:** один emit, корректный state.

## 6. Что читать при отладке

```bash
cat ~/.pi/agent/pi-billing-window.json
```

```json
{
  "provider": "wormsoft",
  "windowStartedAt": 1725000000000,
  "windowMs": 7200000,
  "lastResetAt": 1724999000000,
  "resetCount": 17,
  "callsInWindow": 23,
  "firstCallEmittedAt": 1725000000500
}
```

Подсчитать «сколько осталось»:
```js
const s = JSON.parse(require("fs").readFileSync(process.env.USERPROFILE + "/.pi/agent/pi-billing-window.json", "utf8"));
const remain = s.windowStartedAt + s.windowMs - Date.now();
console.log(`${Math.ceil(remain/60000)} мин до reset, calls=${s.callsInWindow}`);
```

Проверить взведённые флаги `/cont-after-reset`:
```js
const a = JSON.parse(require("fs").readFileSync(process.env.USERPROFILE + "/.pi/agent/pi-billing-window-arms.json", "utf8"));
for (const [key, arm] of Object.entries(a)) {
  console.log(key, `armedAt=${new Date(arm.armedAt).toLocaleTimeString()}`, `expires=${new Date(arm.expiresAt).toLocaleTimeString()}`);
}
```

Подсчитать «сколько уже использовано» (если известен лимит):
```js
// лимит = 5M токенов / 2ч. callsInWindow — это только число вызовов, не токены.
```

## 7. Очистка

Если хотите начать «с чистого листа»:
```bash
rm ~/.pi/agent/pi-billing-window.json
rm ~/.pi/agent/pi-billing-window.lock
```

При следующем `session_start` расширение создаст новый initial state с `resetCount = 0`.

## 8. Файл флагов автопродолжения (`pi-billing-window-arms.json`)

Файл: **`~/.pi/agent/pi-billing-window-arms.json`** (создаётся при первом взводе `/cont-after-reset`).
Lockfile: **`~/.pi/agent/pi-billing-window-arms.lock`** (тот же паттерн `proper-lockfile`, что и у state).

### 8.1. Схема

```ts
type Arm = {
  armedAt: number;         // ms epoch — момент взвода
  lastResetAtAtArm: number; // state.lastResetAt на момент взвода;
                           // срабатывает только сброс, продвинувший lastResetAt дальше
  expiresAt: number;       // ms epoch = armedAt + ARMS_TTL_MS (2 ч 10 мин)
};

type ArmMap = Record<string, Arm>; // ключ = файл сессии (или "ephemeral:<pid>")
```

Пример:
```json
{
  "C:\\Users\\r.edokov\\.pi\\agent\\sessions\\abc-123.jsonl": {
    "armedAt": 1725000000000,
    "lastResetAtAtArm": 1724999000000,
    "expiresAt": 1725007860000
  }
}
```

### 8.2. Жизненный цикл записи

| Событие | Что происходит с записью |
|---|---|
| `/cont-after-reset` | Создаётся под ключом текущей сессии (идемпотентно: активную запись не перезаписывает). |
| Сброс окна + 60 с grace, агент idle | Отправлено `продолжи` → запись удалена (one-shot). |
| `/cont-after-reset off` | Удалена. |
| TTL истёк (`expiresAt <= now`) | Игнорируется при чтении; физически вычищается (`pruneExpired`) при следующей записи в файл. |
| `/new` | **Переносится** на ключ нового разговора (`carryArmTo`). |
| `/resume` / `/fork` / `/reload` / рестарт процесса | Остаётся на ключе своего разговора; процесс читает запись только когда показывает этот разговор (`switchKey` без переноса). |

### 8.3. Отличия от state-файла

- **Запись и сброс не связаны**: arms-файл не мутирует тикером/tick'ами — только командой и срабатыванием.
- **Один процесс — одна запись в фокусе**: process держит `currentKey`; чужие записи не трогаются.
- **Побочные эффекты сброса окна на arms не влияют**: авто-reset, `/billing-reset` и `/settimer 0` пишут только state — флаг в arms видит это через рост `state.lastResetAt` и срабатывает. `/settimer` с `duration > 0` окно только передвигает (`lastResetAt` не трогает) — поэтому флаг от него **не срабатывает** и не сбрасывается.

## 9. Файл истории (`pi-billing-window-history.csv`)

Файл: **`~/.pi/agent/pi-billing-window-history.csv`** (создаётся при первом событии, с BOM — чтобы Excel показывал кириллицу). Lockfile: **`~/.pi/agent/pi-billing-window-history.lock`**.

**Один файл на все pi-процессы** (лимит аккаунтный): проект — колонка, а не отдельный файл. Append под локом; трим строк старше 30 дней на `session_start`.

### 9.1. Схема

```csv
ts_iso,epoch_ms,kind,project,session,calls_in_window,reset_count,input,output,cache_read,cache_write,note
2026-09-12T14:03:21+03:00,1789283001000,call,c:\Tools,a1b2c3.jsonl,12,3,14500,3200,890000,0,
2026-09-12T15:57:00+03:00,1789289820000,window_reset,c:\Tools,a1b2c3.jsonl,0,4,,,,,auto
```

| Колонка | Что значит |
|---|---|
| `ts_iso` / `epoch_ms` | Момент события (локальный ISO с offset / ms epoch) |
| `kind` | `call` \| `window_reset` (note: `auto`, `settimer 0`) \| `manual_reset` \| `settimer` (note: `sync …`) |
| `project` | Полный cwd сессии (у reset-строк — cwd процесса, выполнившего reset) |
| `session` | Basename файла сессии (различает агентов в одной папке; `ephemeral:<pid>` в headless) |
| `input/output/cache_read/cache_write` | Usage последнего ответа (если провайдер отдал; иначе пусто) |
| `note` | Свободное поле (RFC 4180-эскейп) |

### 9.2. Кто пишет

| Событие | kind |
|---|---|
| Успешный вызов wormsoft (`after_provider_response`) | `call` |
| Авто-reset (`checkAndReset`) | `window_reset`, note=`auto` |
| `/billing-reset` | `manual_reset` |
| `/settimer 0` | `window_reset`, note=`settimer 0` |
| `/settimer N>0` | `settimer`, note=`sync …` |

### 9.3. Анализ

`scripts/billing_report.py` (в каталоге разработки): MD-отчёт — суммарный burn по всем проектам + секция на проект, окна восстанавливаются по инкрементам `reset_count`, пиковые минуты. Фильтры: `--project <хвост пути>` (регистронезависимо, кириллица ок), `--days N`, `--out report.md`.

```bash
python scripts/billing_report.py --project Комус --days 7 --out report.md
```

### 9.4. Отказоустойчивость

Любая ошибка записи/трима — warn в лог, `appendHistory → false`, работа расширения не меняется. Ретеншн-трим: дроп строк с `epoch_ms < now − 30 дней` под тем же локом.
