# Design: Spec 012 — absolute wake scheduler

> Requirements: @requirements.md
> Status: Draft
> Last Updated: 2026-10-24

## 1. Executive Summary

Постоянный 5-минутный `setInterval`-тикер (ticker.ts) заменяется крон-подобной
таблицей абсолютных wake-точек в общем файле
`~/.pi/agent/pi-billing-window-wakeups.json` и самокорректирующимся
`setTimeout`-планировщиком в каждом процессе. Якорём точки служит уже
записываемый `state.firstCallEmittedAt` (момент первого расхода кредитов после
reset): точка = `firstCallEmittedAt + windowMs + WAKE_MARGIN_MS` (плавающее
окно wormsoft, D-002). Срабатывание точки вызывает существующий `checkAndReset`
(дедуп `lastResetAt` + `DEDUP_WINDOW_MS` + lock — без изменений), который
эмитит `billing:window_reset`; далее работает нетронутый fire-путь arms
(isIdle + ownerQuiet + firelease). Страховкой от дрейфа `setTimeout` служит
существующий 60-сек sync-poller (`SYNC_POLL_MS`).

Ключевые архитектурные ходы: (1) новый модуль `src/wakeups.ts` — чистые
функции расчёта точек (юнит-тестируемые) + CRUD таблицы под proper-lockfile по
доказанному паттерну state.ts/arms.ts + one-shot wake-таймер-примитив в стиле
watchdog.ts (тестируемость unref-требования NFR-012-1); (2) ticker.ts
превращается в `src/reset.ts` — `checkAndReset` переносится дословно, получает
опциональный параметр `note` (для `note="wake HH:MM"`), вся интервальная
механика (TICK_MS, startTicker/stopTicker) удаляется; (3) планировщик
`ensureWakeTimer()` в index.ts по паттерну `ensureGraceTimer` — перевзводится
от wall-clock на каждом событии, меняющем расписание.

Главный trade-off: таблица частично спекулятивна (хвост 2ч×k от якоря);
спекулятивные точки, сработавшие раньше фактической границы, дают безвредный
no-op `checkAndReset` (окно ещё не истекло), а точность обеспечивают реальные
якорные точки от каждого первого вызова. Сон машины сознательно вне области
(D-010): сгоревшие точки (now > точка + 30 мин) гасятся тихо, восстановление —
ручной `/settimer`.

## 2. Requirements Mapping

| Requirement | Design Coverage | Notes |
|-------------|-----------------|-------|
| FR-012-1 (файл таблицы + lock) | §4 Data Model, TD-003 | файл `~/.pi/agent/pi-billing-window-wakeups.json`, маркер-файл + lock-каталог `<file>.lock` + retry-бюджет — паттерн state.ts/arms.ts дословно |
| FR-012-2 (якорь = плавающее окно) | §4 Core Interfaces, TD-004 | точка = `firstCallEmittedAt + windowMs + WAKE_MARGIN_MS`; нет firstCall → нет активной точки (`points: []` ≡ «окно не началось») |
| FR-012-3 (маржа 2 мин) | §4 Core Interfaces | `WAKE_MARGIN_MS = 2 * 60_000`; входит в каждую точку (и в `/settimer`-точку) |
| FR-012-4 (глубина 12, самовозобновление) | TD-004 (правила мутаций) | срабатывание → сдвиг головы; новый якорь → вставка точки + top-up хвоста до 12; переполнение → усечение с конца |
| FR-012-5 (/settimer управляет таблицей) | §4 API/Integration, TD-006 | N>0: rebuild от `targetStartedAt` (точка = now + N + маржа), `lastResetAt` не трогается; N=0 и /billing-reset: таблица очищается, следующая точка — от следующего firstCall |
| FR-012-6 (автоинициализация) | §3 Data Flow (событие llm:first_call) | первый успешный вызов после reset дописывает якорную точку; таблица существует без ручных команд |
| FR-012-7 (setTimeout + sync-poller + дедуп) | §4 (ensureWakeTimer), TD-005, TD-007 | unref, wall-clock-перевзвод, страховка в существующем `SYNC_POLL_MS`-интервале; межпроцессный дедуп — существующий, без изменений |
| FR-012-8 (точка → существующий reset/fire-путь) | §3 Data Flow, §5 | точка → `checkAndReset` → emit → существующий listener/fire-путь; гейтинг не дублируется |
| FR-012-9 (429 → ретрай + коррекция якоря) | §8 Edge Cases, TD-004 | paced-ретрай `RETRY_AFTER_FIRE_MS` не трогаем; первый успешный ответ после возобновления = новый якорь → таблица сама приходит к реальному расписанию |
| FR-012-10 (сгоревшие точки гасятся тихо) | TD-004, §8 Edge Cases | `dropBurnedPoints` (TTL 30 мин) в sync-poller и при каждом перевзводе; без стрельбы в прошлое |
| FR-012-11 (наблюдаемость) | TD-008, §4 (/billing-status), §12 | `note="wake HH:MM"` через параметр `checkAndReset`; `/billing-status` показывает следующую точку локальным временем |
| FR-012-12 (удаление тикера, about_to_reset) | TD-002, TD-007 | ticker.ts → reset.ts (без интервала); `billing:window_about_to_reset` — вторичный таймер на точка − ABOUT_TO_RESET_MS (Should) |
| NFR-012-1 (event loop) | TD-001, §11 | все таймеры планировщика unref; probe `hasRefForTests()` в wakeups.ts (паттерн watchdog.ts / ui.ts) |
| NFR-012-2 (тихая деградация) | TD-003, §8 Edge Cases | битый/чужой/пустой wakeups.json → «нет таблицы» + однократный warn; ни одного необработанного исключения наружу |

## 3. System Architecture

### Component Overview

| Component | Responsibility | Boundaries | Notes |
|-----------|----------------|------------|-------|
| `src/wakeups.ts` (новый) | (a) чистые функции расчёта точек; (b) CRUD таблицы wake-точек в файле под proper-lockfile; (c) one-shot wake-таймер-примитив `armWakeTimer/clearWakeTimer/hasRefForTests` | не знает про emit, state, arms, history; единственная точка знания о формате wakeups.json | паттерны: файл+lock — state.ts/arms.ts; таймер — watchdog.ts |
| `src/reset.ts` (бывший ticker.ts) | детектор границы окна: `checkAndReset` (дедуп, reset, emit, history) + `DEDUP_WINDOW_MS`, `ABOUT_TO_RESET_MS`, `EmitFn`, `HistoryMeta` | никакой интервальной механики; не знает про таблицу точек | код перенесён дословно; добавлен опциональный `note` (TD-008) |
| `src/index.ts` (правки) | планировщик: `ensureWakeTimer/stopWakeTimer/onWakeFire`; перевзвод на событиях; страховка в sync-poller; интеграции /settimer, /billing-reset, /billing-status, llm:first_call | не дублирует гейтинг fire-пути; не меняет fire-механику arms | паттерн `ensureGraceTimer` (index.ts:915) |
| `src/state.ts` (без изменений) | state.json, lock, `firstCallEmittedAt` | якорь читается, не пишется планировщиком | `firstCallEmittedAt` — готовый якорь D-002 |
| `src/arms.ts`, fire-путь (без изменений) | «продолжи» только в idle-чаты с взведённым флагом | планировщик туда не заходит | D-008: единая точка изменения семантики доставки |

### Data / Control Flow

```mermaid
flowchart TD
    subgraph Источники_якоря
        A[llm:first_call<br/>firstCallEmittedAt] -->|appendAnchorPoint| W
        S[/settimer N>0/] -->|rebuildFromAnchor| W
        Z[/settimer 0, /billing-reset/] -->|clearTable| W
    end
    W[wakeups.json<br/>points: epoch_ms[], lock] -->|nextDuePoint| T
    T[ensureWakeTimer<br/>setTimeout unref] -->|точка − now| F[onWakeFire]
    T -.->|точка − 5 мин| AB[billing:window_about_to_reset]
    P[sync-poller 60 c<br/>SYNC_POLL_MS] -->|now ≥ точки| F
    P -->|точка + 30 мин<br/>без reset| DB[dropBurnedPoints<br/>тихо]
    F -->|consumeFirstPoint| W
    F --> C[checkAndReset<br/>дедуп lastResetAt] -->|billing:window_reset| E[существующий listener<br/>→ grace → fireContinue]
    C -->|kind=window_reset<br/>note='wake HH:MM'| H[history.csv]
```

Точки перевзвода `ensureWakeTimer()` (отмена старого таймера + взвод нового от
wall-clock, всегда идемпотентно): `llm:first_call` (после append якорной
точки), listener `billing:window_reset`, обе ветки `/settimer`, `/billing-reset`,
`session_start`, каждый `onWakeFire` (переход к следующей точке), каждый
sync-тик после `dropBurnedPoints`.

## 4. Implementation Design

### Component / Module Structure

```text
src/
  wakeups.ts        (new)   чистые функции + таблица (файл+lock) + wake-таймер-примитив
  reset.ts          (new)   checkAndReset + константы (перенос из ticker.ts)
  ticker.ts         (del)   удалён целиком
  state.ts                  без изменений
  arms.ts / watchdog.ts / history.ts / ui.ts / parser.ts   без изменений
  index.ts          (mod)   планировщик, события, команды
tests/
  test.mts          (mod)   ticker-тесты → wakeups/reset-тесты
  exit-hygiene.test.mts (mod) unref-probe тикера → unref-probe wake-таймера
```

### Core Interfaces

```ts
// wakeups.ts — константы
export const WAKE_MARGIN_MS = 2 * 60_000;      // FR-012-3 (D-003)
export const WAKE_DEPTH = 12;                   // FR-012-4 (D-004)
export const WAKE_BURNED_TTL_MS = 30 * 60_000;  // FR-012-10 (D-010)

// wakeups.ts — чистые функции (без I/O, юнит-тестируемые)
export type WakeTable = {
  version: 1;
  points: number[];            // epoch ms, строго возрастающие, ≤ WAKE_DEPTH
  updatedAt: number;           // epoch ms
  source: "firstCall" | "settimer";
};

export function computeTableFromAnchor(
  anchorTs: number, windowMs: number, marginMs: number, depth: number,
): WakeTable;
// points = [anchor + windowMs + margin + k*windowMs, k = 0..depth-1]

export function nextDuePoint(table: WakeTable | null, now: number): number | null;
// минимальная точка p с p + WAKE_BURNED_TTL_MS > now (не сгоревшая);
// null — таблицы нет, она пуста или голова сгорела

export function dropBurnedPoints(table: WakeTable, now: number, ttlMs: number): WakeTable;
// выбрасывает точки с now > p + ttlMs (чистая функция; персистенция — отдельно)

export function appendAnchorPoint(table: WakeTable, anchorTs: number,
  windowMs: number, marginMs: number, depth: number): WakeTable;
// вставка anchor+windowMs+margin по возрастанию; top-up хвоста до depth
// (last + windowMs, пока длина < depth); усечение до depth с конца

// wakeups.ts — персистенция (одна мутация под lock, паттерн mutateState)
export function readWakeTable(): WakeTable | null;          // толерантный sync-read
export function mutateWakeTable(transform: (t: WakeTable | null)
  => { next: WakeTable | null }): Promise<void>;
// операции поверх: rebuildFromAnchor / appendAnchor / consumeFirst / purgeBurned / clear

// wakeups.ts — one-shot таймер-примитив (паттерн watchdog.ts)
export function armWakeTimer(whenMs: number, cb: () => void): void; // unref, delay = max(0, when−now)
export function clearWakeTimer(): void;
export function hasRefForTests(): boolean | null;            // NFR-012-1

// reset.ts — единственное изменение сигнатуры (TD-008)
export async function checkAndReset(
  emit: EmitFn, meta?: HistoryMeta, note = "auto",
): Promise<boolean>;
// note попадает в appendHistory({kind: "window_reset", note}); wake-вызовы
// передают "wake HH:MM" (локальное время сработавшей точки)
```

### Data Model / State

Файл `~/.pi/agent/pi-billing-window-wakeups.json`, общий для всех процессов
pi (как state/arms/history). Схема (version 1):

```json
{
  "version": 1,
  "points": [1761300000000, 1761307200000],
  "updatedAt": 1761289000000,
  "source": "firstCall"
}
```

- `points` — абсолютные epoch-ms моменты пробуждения, строго возрастающие,
  максимум `WAKE_DEPTH` (12) записей. Пустой массив — легальное состояние
  «окно не началось» (FR-012-2), эквивалентное отсутствию файла для
  планировщика.
- `source` — происхождение последней перестройки: `"firstCall"` (автоинициализация,
  FR-012-6) или `"settimer"` (ручная коррекция, FR-012-5). Информационное поле
  для диагностики, на логику не влияет.
- Парсинг-толерантность как `readStateSync` (state.ts): отсутствующий файл →
  `null`; битый JSON, не-числовые `points`, чужая схема (`version` ≠ 1,
  `points` не массив чисел) → `null` + однократный `console.warn`
  (флаг «уже жаловались», сбрасывается при успешном чтении); `null` трактуется
  всеми потребителями как «нет таблицы» (NFR-012-2). Восстановление — тихое
  пересоздание при следующем якоре; повреждённый файл перезаписывается.
- Конкурентный доступ: маркер-файл `pi-billing-window-wakeups.lock`,
  lock-каталог `<...>.lock/` через proper-lockfile, retry-бюджет как у state.ts
  (retries: 20, min 100 ms, max 200 ms). ELOCKED не фатален: мутация
  пропускается, следующий якорь/тик повторит (NFR-012-2). Никаких новых
  примитивов синхронизации (Constraints).

### API / Integration Contract

| Method / Event | Path / Topic | Purpose | Request | Response / Result |
|----------------|--------------|---------|---------|-------------------|
| событие pi | `llm:first_call` (после записи `firstCallEmittedAt` в state, index.ts onAfterProviderResponse) | дописать якорную точку + перевзвод | `firstCallEmittedAt` из свежего state | `mutateWakeTable(appendAnchor)`, `ensureWakeTimer()` |
| событие EventBus | `billing:window_reset` (существующий listener) | перевзвод планировщика после reset | — | `ensureWakeTimer()` (хвост таблицы остаётся) |
| событие pi | `session_start` | взвод планировщика при старте/reload | — | `ensureWakeTimer()`; существующий one-shot `checkAndReset` для уже истекшего state (index.ts:2257) сохраняется |
| команда | `/settimer <N>`, N > 0 | rebuild таблицы от `targetStartedAt = now − (windowMs − N)` | — | `mutateWakeTable(rebuild, source="settimer")`; `lastResetAt` не трогается (существующее поведение); `ensureWakeTimer()`; существующий `syncWatchdog()` сохраняется |
| команда | `/settimer 0` и `/billing-reset` | немедленный reset (существующий код) + пересборка «от следующего firstCall» | — | существующий reset-код; затем `mutateWakeTable(clear)` — `points: []`, `source="settimer"`; `ensureWakeTimer()` (точек нет → таймер снят) |
| команда | `/billing-status` (существующая) | показать следующую точку | — | дополнение к текущему выводу: «следующая точка: HH:MM» (локальное время `nextDuePoint`) либо «активной точки нет (окно не началось)» |
| команда | `/billing-tick` (существующая) | отладочный принудительный reset-чек | — | без изменений: прямой `checkAndReset` |
| внутренний | `onWakeFire` (index.ts) | исполнение точки | точка p | `consumeFirstPoint(p)`; `runGuarded(() => checkAndReset(emit, meta, "wake HH:MM"))`; `ensureWakeTimer()`; вторично взводится about-таймер следующей точки |
| внутренний | sync-poller (`SYNC_POLL_MS`, index.ts:970) | страховка дрейфа setTimeout + тихое погашение | таблица | `now ≥ nextDuePoint` → тот же путь, что `onWakeFire`; голова сгорела (`now > p + WAKE_BURNED_TTL_MS`) → `dropBurnedPoints` без стрельбы; затем `ensureWakeTimer()` |
| событие EventBus | `billing:window_about_to_reset` (Should, D-012) | предупреждение о близости reset | — | вторичный unref-таймер на `p − ABOUT_TO_RESET_MS` (5 мин), эмит `{provider, msRemaining}` по свежему state; взводится вместе с wake-таймером, если момент в будущем |

## 5. Integration Points

| System | Purpose | Auth / Permissions | Failure Handling |
|--------|---------|--------------------|------------------|
| state.ts (`firstCallEmittedAt`, `windowMs`, `lastResetAt`) | чтение якоря и параметров окна | локальный файл + lock (существующий) | state = null → планировщик бездействует (нет окна — нет точек) |
| reset.ts `checkAndReset` | единственный reset-путь (D-008) | — | ELOCKED → тихо, повтор на следующем событии; ошибка → warn, никогда не наружу |
| arms.ts / fire-путь (grace → fireContinue) | доставка «продолжи» после reset | нет изменений | нет изменений (specs 002/006/007/009/011) |
| history.ts `appendHistory` | строка `window_reset` c note | lock (существующий) | fire-and-forget, never throws (существующее) |
| существующий arm-watchdog (watchdog.ts, `computeFireAt` по `windowStartedAt`) | таймер границы для armed-разговора | нет изменений | остаётся как есть: его `checkAndReset` ("auto") и wake-`checkAndReset` ("wake") дедупятся `lastResetAt` + `DEDUP_WINDOW_MS` — двойной вызов безвреден |
| host-процесс pi | расширение живёт внутри | — | ни один таймер не держит loop (unref); ни одна ошибка wakeups.json не пробрасывается (NFR-012-1/2) |

## 6. Security / Permissions / Privacy

- **Authentication:** Not applicable (локальные файлы пользователя).
- **Authorization:** Not applicable; файл в `~/.pi/agent/` наследует права
  домашнего каталога, как state/arms/history.
- **Input validation:** чтение wakeups.json валидирует схему (числа, version);
  всё недоверенное → «нет таблицы» (NFR-012-2). `/settimer`-парсинг не меняется
  (parseDuration + clamp — вне области).
- **Sensitive data:** таблица содержит только epoch-ms и два строковых
  enum-значения — нет PII, путей проектов, текстов сообщений.
- **Abuse cases:** конкурентная запись многих процессов закрыта lock'ом;
  злонамеренно огромный `points`-массив ограничивается усечением до
  `WAKE_DEPTH` при первой же мутации.

## 7. UX / Accessibility

- `/billing-status` дополнительно показывает «следующая точка: HH:MM» локальным
  временем; при `points: []` — явное «активной точки нет (окно не началось)»,
  не ошибка (requirements UX Notes).
- Состояния планировщика невидимы пользователю в нормальном потоке: якорь
  создаётся сам (US-002), reset-уведомление — существующий notify по
  `billing:window_reset`.
- После сна машины: `/billing-status` молчит о сгоревших точках (они погашены
  тихо); пользовательский путь восстановления — `/settimer N` (US-003).
- Изменение справки COMMANDS.md (`/settimer` теперь управляет таблицей точек)
  и README — вне рамок спека; фиксируется здесь как обязательное follow-up
  (requirements, UX Notes).

## 8. Edge Cases

| Case | Expected Behavior |
|------|-------------------|
| Нет firstCall после reset (окно не началось) | `points: []` / файла нет → таймер снят, `/billing-status`: «нет точки»; не ошибка (FR-012-2) |
| wakeups.json битый / пустой / чужая схема / нет каталога | `readWakeTable` → null + однократный warn; планировщик = «нет точки»; файл пересоздаётся на следующем якоре (NFR-012-2) |
| Два процесса одновременно поймали точку | оба зовут `checkAndReset`; дедуп `lastResetAt + DEDUP_WINDOW_MS` + lock пропускает второго; оба потребляют точку (идемпотентный сдвиг головы) (D-007) |
| Точка сработала, но окно ещё не истекло (спекулятивный хвост / дрейф якоря) | `checkAndReset` — no-op (без emit), точка всё равно потребляется; точность восстанавливает ближайшая реальная якорная точка (FR-012-9); погрешность ≤ маржа + δ первого вызова |
| 429 после «продолжи» | существующий paced-ретрай `RETRY_AFTER_FIRE_MS`; первый успешный ответ = новый `firstCallEmittedAt` → новая якорная точка; таблица сама съезжает к реальному расписанию (D-009) |
| Машина спала через границу; включилась с точкой в прошлом | `now ≤ p + 30 мин` → одна стрельба через дедуп; `now > p + 30 мин` → `dropBurnedPoints`, тихо, без emit (FR-012-10); восстановление — ручной `/settimer` |
| Лавина сгоревших точек после долгого сна | все точки старше TTL гасятся одним `dropBurnedPoints` на первом sync-тике; ни одного эмита в прошлое |
| `/settimer 0` / `/billing-reset` | reset существующим кодом (напрямую, мимо дедупа `checkAndReset` — как сейчас); таблица очищается; следующая точка — от следующего firstCall |
| Долгий LLM-вызов пересёк границу | существующий post-call `checkAndReset` (index.ts:2495) остаётся; wake-точка затем дедупится |
| ELOCKED на мутации таблицы | мутация пропускается тихо (warn не спамится); перевзвод на следующем событии восстановит консистентность |
| Точка в прошлом при взводе (`ensureWakeTimer`, delay ≤ 0) | таймер взводится с delay 0 — срабатывает немедленно; далее обычный путь (дедуп/сгоревшие отсекут лишнее) |
| session_start с уже истекшим state | существующий one-shot `checkAndReset` (index.ts:2257) отрабатывает reset; `ensureWakeTimer` берёт уже обновлённую таблицу |

## 9. Impact Analysis

| Component | Impact Type | Description and Risk | Required Action |
|-----------|-------------|----------------------|-----------------|
| src/wakeups.ts | new | весь планировщик точки: функции, файл, lock, таймер-примитив | создать (Sequencing шаг 1) |
| src/reset.ts | new (переименование ticker.ts) | `checkAndReset` + константы перенесены дословно; `+note`; риск регресса минимален — код не меняется | перенести, обновить импорты |
| src/ticker.ts | deprecated → deleted | TICK_MS, startTicker/stopTicker/hasRefForTests удалены | удалить после перевода импортов |
| src/index.ts | modified | импорты (42–46), `tickerStarted`/`ensureTickerStarted` (113, 1875, 2167, 2230), stopTicker в shutdown (1887), `/settimer` (обе ветки), `/billing-reset`, `/billing-status`, onAfterProviderResponse (первый вызов), sync-poller, константы | правки по TD-002/005/006; fire-путь не трогать |
| tests/test.mts | modified | ticker-блок (295–330+) → тесты wakeups.ts (чистые функции, CRUD, толерантность) + checkAndReset из reset.ts (включая note) | переписать блок |
| tests/exit-hygiene.test.mts | modified | probe тикера → probe `armWakeTimer` (unref) | заменить 3 строки |
| docs/COMMANDS.md, README | modified (вне спека) | `/settimer` управляет таблицей; отметить как follow-up | отдельный коммит после имплементации |
| state.ts / arms.ts / watchdog.ts / history.ts / ui.ts / parser.ts | unchanged | — | — |

## 10. Development Sequencing

1. `src/wakeups.ts` — чистые функции + персистенция + таймер-примитив; юнит-тесты
   функций — нет зависимостей от остальных шагов.
2. `src/reset.ts` — дословный перенос `checkAndReset` из ticker.ts + параметр
   `note`; импорты test.mts переключить на reset.ts — зависит от 1 только
   механически (параллелизуемо).
3. `src/index.ts`: `ensureWakeTimer/stopWakeTimer/onWakeFire`, hook
   `llm:first_call` (append якоря), listener `billing:window_reset`,
   `session_start`, страховка в sync-poller — зависит от 1–2.
4. `/settimer` (обе ветки), `/billing-reset`, `/billing-status` — зависит от 3.
5. Удаление ticker.ts: чистка импортов/флагов/констант (index.ts:42, 113,
   1875, 2167, 2230, 1887), удаление файла, обновление exit-hygiene.test.mts —
   финальный шаг, зависит от 3–4.
6. Ручная e2e-верификация (§11) + change note в COMMANDS.md/README (вне спека).

## 11. Testing / Verification Strategy

### Unit / Component

- `computeTableFromAnchor`: длина 12, первый элемент = anchor + windowMs +
  margin, шаг windowMs; глубина/маржа параметризованы.
- `nextDuePoint`: пустая таблица → null; точка в будущем → она; точка в
  прошлом ≤ TTL → она; точка сгоревшая → null; несколько точек → минимальная
  не сгоревшая.
- `dropBurnedPoints`: граница ровно `p + ttl` (не сгорела, strict >), пачка
  смешанных возрастов.
- `appendAnchorPoint`: вставка по возрастанию; top-up хвоста до 12; усечение
  с конца при переполнении; точка-дубликат рядом с существующей — обе
  остаются (пусть сработают по очереди, см. FAQ).
- `checkAndReset` (reset.ts): существующие кейсы из ticker-блока test.mts
  (null-state, не истекло, истекло + emit, дедуп, about_to_reset) +
  новый: `note` попадает в history-строку; default "auto".
- Персистенция: write→read round-trip; битый JSON → null + однократный warn
  (второй вызов молчит); `points: []` легален; lock-конкуренция (две
  параллельные мутации не теряют точку).
- NFR-012-1: `armWakeTimer(...).hasRefForTests() === false`; после
  `clearWakeTimer` — null (замена ticker-probe в exit-hygiene.test.mts).

### Integration / API

- Симуляция полного цикла (tmp-пути через setPaths-паттерн): firstCall →
  таблица создана; время сдвинуто моком Date.now / короткими константами →
  срабатывание → `billing:window_reset` в mock-emit + history note "wake HH:MM"
  → consumption головы → следующая точка.
- `/settimer 60` (программный вызов логики rebuild): точка = now + 60 мин +
  маржа, хвост 2ч×k, `lastResetAt` не изменился (существующий ассерт
  сохраняется).
- Сгоревшая точка: подстановка таблицы с точкой now − 40 мин → sync-тик →
  точка погашена, emit не вызван.

### E2E / Manual

- Ночь с взведённым cont-after-reset: chain `window_reset` в history без дырок
  (note="wake HH:MM"), «продолжи» уходит без ручного вмешательства (Success
  Metrics).
- `/billing-status` показывает точку, совпадающую с расчётом; после
  `/settimer 0` — «нет точки» до первого вызова.

### Project Verification

- Lint: not applicable (в проекте нет lint-скрипта)
- Typecheck: `npm run build` (tsc -p tsconfig.json)
- Test: `npm test` (tsx tests/test.mts) + `tsx tests/exit-hygiene.test.mts`
- Build: `npm run build`

## 12. Observability / Operations

- **Logs:** однократный `console.warn` на битый wakeups.json (сбрасывается
  после успешного чтения); ELOCKED-диагностика в armslog по паттерну state.ts.
- **Metrics (пассивные, через существующий history.csv):** строки
  `kind="window_reset"` c `note="wake HH:MM"` vs `"auto"` / `"settimer 0"` —
  прямо показывают, что reset доставлен планировщиком; дырки в цепочке —
  главная метрика спека (Success Metrics).
- **Alerts:** нет новых; существующий notify по `billing:window_reset`.
- **Support/debugging:** wakeups.json читаем напрямую; `/billing-status`
  показывает следующую точку; `/billing-tick` — принудительный чек без
  ожидания точки.

## 13. Migration / Rollout

- **Migration:** не требуется — wakeups.json создаётся с нуля при первом
  firstCall (FR-012-6); state.json/arms.json не меняются. Первый запуск новой
  версии в середине окна: точка появится от следующего firstCallEmittedAt
  (якорь уже пишется текущей версией), либо немедленно от `/settimer N`.
- **Feature flag:** отсутствует; старый тикер удаляется (D-012), обратной
  совместимости не требуется (таблица — надстройка над state, формат
  событий не меняется).
- **Rollout:** один релиз; выход — полная замена тикера.
- **Rollback:** git revert; отсутствие wakeups.json для старого кода
  безвредно (старый тикер игнорирует файл).

## 14. Technical Decisions

### TD-001: модуль wakeups.ts объединяет таблицу и wake-таймер-примитив

- **Decision:** `src/wakeups.ts` содержит (a) чистые функции, (b) персистенцию
  таблицы, (c) one-shot таймер-примитив `armWakeTimer/clearWakeTimer/
  hasRefForTests` — отдельный handle, паттерн watchdog.ts.
- **Why:** index.ts не импортируется юнит-тестами (side effects), поэтому
  unref-требование NFR-012-1 должно проверяться на экспортируемом примитиве;
  watchdog.ts — доказанный precedent one-shot-модуля. Переиспользовать
  сам watchdog.ts нельзя: у него единственный handle, занятый arm-логикой.
- **Trade-off:** у модуля две ответственности (файл и таймер) вместо одной;
  принято ради тестируемости без расширения количества модулей.
- **Alternatives:** таймер целиком в index.ts (нетестируемо); расширение
  watchdog.ts вторым handle (запутывает единственную ответственность
  arm-механизма).

### TD-002: ticker.ts → reset.ts; checkAndReset сохраняется дословно + note

- **Decision:** `checkAndReset`, `DEDUP_WINDOW_MS`, `ABOUT_TO_RESET_MS`,
  `EmitFn`, `HistoryMeta` переносятся в новый `src/reset.ts` без изменений
  логики; добавляется только опциональный параметр `note` (default "auto").
  Интервальная механика (TICK_MS, startTicker/stopTicker/hasRefForTests)
  удаляется; файл ticker.ts удаляется.
- **Why:** `checkAndReset` — единственный reset-путь (вызывается планировщиком,
  post-call, /billing-tick, session_start) и обязан остаться; имя ticker.ts
  после удаления тикера лжёт. Отдельный reset.ts сохраняет разделение
  «когда проверять» (wakeups) vs «как проверять» (reset).
- **Trade-off:** механический churn импортов в index.ts и test.mts; риск
  регресса минимален — код переносится, а не переписывается.
- **Alternatives:** оставить checkAndReset в ticker.ts (лживое имя, мёртвый
  код интервала вокруг); перенести checkAndReset в wakeups.ts (смешение
  «хранилище расписания» и «детектор границы»); перенести в index.ts
  (index уже 128 КБ, нетестируем).

### TD-003: формат таблицы version 1 + парсинг-толерантность как state.ts

- **Decision:** `{version: 1, points: number[], updatedAt, source}`; чтение
  строго валидирует схему, любое отклонение → null + однократный warn;
  `points: []` — легальное «окно не началось».
- **Why:** NFR-012-2 требует нуля падений при любом состоянии файла;
  `readStateSync` — доказанный в бою паттерн тихой деградации. `version`
  оставляет место для будущих смен схемы без угадывания.
- **Trade-off:** не-числовые точки молча отбрасываются целиком (вся таблица),
  а не поэлементно — восстановление тривиально (следующий якорь).
- **Alternatives:** поэлементная фильтрация точек (сложнее, выигрыш нулевой —
  таблица пересоздаётся якорем); throw + запрет запуска (нарушает NFR-012-2).

### TD-004: правила мутаций таблицы (сдвиг, top-up, сгоревшие, ручные)

- **Decision:** четыре операции, каждая — одна `mutateWakeTable`-мутация под
  lock: (1) срабатывание/страховка → голова потребляется безусловно
  (результат `checkAndReset` не влияет — дедуп уже отработал);
  (2) новый якорь → `appendAnchorPoint`: вставка `anchor + windowMs + margin`
  по возрастанию, top-up хвоста до 12 от последней точки, усечение свыше 12
  с конца; (3) sync-тик/перевзвод → purge точек с `now > p +
  WAKE_BURNED_TTL_MS`; (4) `/settimer 0` / `/billing-reset` → clear
  (`points: []`), следующая точка от следующего firstCall (FR-012-5/6).
- **Why:** FR-012-4: сдвиг головы + дописывание хвоста дают самовозобновление;
  усечение с конца (а не с головы) никогда не теряет активную точку —
  теряются только дальние спекулятивные точки, которые следующий якорь
  восстановит. Безусловное потребление головы закрывает гонку «два процесса
  потребляют одну точку» идемпотентно.
- **Trade-off:** спекулятивные хвостовые точки могут сработать раньше
  фактической границы — безвредный no-op `checkAndReset` (окно не истекло);
  реальную точность несёт якорная точка от каждого firstCall (FR-012-9).
- **Alternatives:** rebuild всей таблицы на каждом якоре (нарушает FR-012-4
  «дописывается в хвост», теряет дальние точки); дедупликация близких точек
  (не нужна: двойная стрельба отфильтрована reset-дедупом, порядок срабатывания
  детерминирован).

### TD-005: планировщик ensureWakeTimer по паттерну ensureGraceTimer

- **Decision:** модульные handle'ы wake/about таймеров в index.ts;
  `ensureWakeTimer()` идемпотентен: отменяет оба старых таймера, читает
  таблицу (толерантно), берёт `nextDuePoint`, взводит unref-setTimeout с
  `delay = max(0, p − now)` → `onWakeFire`; about-таймер на `p −
  ABOUT_TO_RESET_MS`, если в будущем. Перевзвод на каждом событии-источнике
  (llm:first_call, window_reset, обе ветки /settimer, /billing-reset,
  session_start, каждый fire, sync-тик после purge). Снятие — в
  `stopWatchdogTimers`-подобном `stopWakeTimer` на shutdown/reload.
- **Why:** wall-clock-пересчёт на каждом перевзводе устойчив к дрейфу
  setTimeout (D-007); паттерн ensureGraceTimer (index.ts:915) уже в коде и
  проверен e2e. Отмена-перед-взводом исключает задвоение таймеров при
  пачке событий.
- **Trade-off:** на каждый sync-тик делается sync-read wakeups.json —
  дёшево (файл < 1 КБ, 1 чтение/мин), принято.
- **Alternatives:** setInterval-поллинг точек (то, что удаляем);
  LongTimer-цепочки (сложнее без выигрыша при 24-часовой глубине).

### TD-006: /settimer — rebuild в обеих ветках, lastResetAt нетронут

- **Decision:** N > 0: `rebuild` от `targetStartedAt` (точка = now + N + margin,
  хвост 2ч×k, source="settimer") после существующей state-мутации;
  `lastResetAt` не меняется (существующее поведение COMMANDS.md §4
  сохраняется дословно). N = 0: существующий немедленный reset, затем clear
  таблицы (source="settimer") — «пересборка от следующего firstCall».
- **Why:** FR-012-5; untouched `lastResetAt` — критично: иначе ручной sync
  подавил бы ближайший авто-reset дедупом `checkAndReset`.
- **Trade-off:** в ветке N=0 таблица пуста до первого вызова — окно честно
  «не начато» (FR-012-2).
- **Alternatives:** в ветке N=0 оставить старый хвост (спекулятивные точки
  от предыдущего якоря ложны после ручного reset — отклонено).

### TD-007: страховка в существующем sync-poller

- **Decision:** в интервал `SYNC_POLL_MS` (index.ts:970) перед/после
  `syncWatchdog()` добавляется wake-проверка: `nextDuePoint` → `now ≥ p` →
  тот же путь, что `onWakeFire` (consume + checkAndReset c "wake HH:MM");
  сгоревшая голова → `dropBurnedPoints` без стрельбы; затем
  `ensureWakeTimer()`.
- **Why:** D-007/FR-012-7: setTimeout может дрейфовать/теряться при
  нагрузке — 60-сек poller гарантирует верхнюю границу опоздания
  `WAKE_MARGIN_MS + SYNC_POLL_MS` (Success Metrics). Poller уже существует
  и живёт во всех окнах.
- **Trade-off:** двойной путь срабатывания (таймер + poller) — сведён к
  идемпотентности: consume под lock + reset-дедуп.
- **Alternatives:** отдельный интервал для wake (лишний таймер);
  полагаться только на setTimeout (возвращаемся к проблеме спека).

### TD-008: note="wake HH:MM" через параметр checkAndReset

- **Decision:** `checkAndReset(emit, meta?, note = "auto")`; wake-места
  вызова (onWakeFire, sync-страховка) форматируют локальное HH:MM
  сработавшей точки и передают в note; существующие вызовы не меняются
  (default "auto").
- **Why:** FR-012-11/D-011: одна точка записи history (внутри
  `checkAndReset`), атрибуция передаётся снаружи — никакого дублирования
  append-логики.
- **Trade-off:** none — сигнатура обратно совместима.
- **Alternatives:** append в месте вызова fire (дублирует appendHistory,
  рассинхрон с reset-фактом).

## 15. Known Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Два процесса одновременно стреляют точку | High (ожидаемо) | Low | существующий дедуп `lastResetAt + DEDUP_WINDOW_MS` + lock (D-007); безусловное consume идемпотентно (TD-004) |
| Sleep-машины: пропущенные окна без reset-эмитов | Medium | Medium | сознательное ограничение D-010: сгоревшие точки гасятся тихо; восстановление — ручной `/settimer`; автопересчёт после сна вне области |
| Битый/чужой wakeups.json | Low | Medium | тихая деградация «нет таблицы» + однократный warn; пересоздание якорем (NFR-012-2) |
| Дрейф setTimeout при большой нагрузке | Medium | Low | wall-clock-перевзвод на каждом событии + 60-сек страховка (TD-005/007) |
| Спекулятивная хвостовая точка срабатывает раньше границы | Medium (штатно) | Low | no-op `checkAndReset`; якорная точка от следующего firstCall восстанавливает точность (TD-004) |
| Сосуществование с arm-watchdog (computeFireAt по windowStartedAt) | Medium | Low | оба зовут `checkAndReset`; дедуп отфильтрует; history-note различит "wake"/"auto" (§5) |
| Потеря about_to_reset при снятии about-таймера | Low | Low | Should-have (D-012); перевзвод вместе с wake-таймером на каждом событии |
| ELOCKED на mutateWakeTable (бюджет ретраев исчерпан) | Low | Low | тихий пропуск мутации; консистентность восстановит следующий якорь/событие (§8) |

## 16. Implementation FAQ

**Q:** Что считается «якорем» и где он берётся?  
**A:** Якорь = `state.firstCallEmittedAt` (уже пишется при первом успешном
вызове окна, index.ts:2392). Точка = якорь + `windowMs` + `WAKE_MARGIN_MS` —
это timestamp ПЕРВОГО вызока, а не начала окна. Никаких новых записей в
state.json планировщик не делает.

**Q:** Что удалить из index.ts при демонтаже тикера?  
**A:** Импорт ticker.js (строки 42–46 → импорт reset.js), флаг
`tickerStarted` (113), `ensureTickerStarted` (1875) и оба вызова (2167,
2230), `stopTicker()` в shutdown (1887 → `stopWakeTimer()`), комментарий
про тикер в шапке (строка 8). `checkAndReset` остаётся — теперь из reset.js.

**Q:** Нужно ли трогать fire-путь (grace, fireContinue, switchSession)?  
**A:** Нет. Точка → `checkAndReset` → emit `billing:window_reset` →
существующий listener планирует grace → `fireContinue` (isIdle + ownerQuiet +
firelease уже внутри). Планировщик — только детектор границы (D-008).

**Q:** onWakeFire и sync-страховка могут совпасть по времени?  
**A:** Оба идут через один и тот же путь: consume под lock (идемпотентен —
второй увидит уже сдвинутую голову) + `checkAndReset` (дедуп lastResetAt).
Plus `runGuarded` сериализует перекрытия в этом процессе.

**Q:** Почему consumer сдвигает голову даже если checkAndReset не сбросил?  
**A:** Точка — одноразовая по определению (FR-012-4 «первая запись
потребляется»). Не-сброс означает «окно ещё живо» (спекулятивная точка или
дрейф δ первого вызова) — повторная стрельба в ту же точку бессмысленна,
точность вернёт якорная точка. Гонку «сброс уже сделал другой процесс»
закрывает reset-дедуп, а не удержание точки.

**Q:** Как обрабатывается существующий arm-watchdog, стреляющий по
`windowStartedAt + windowMs`?  
**A:** Никак не изменяется. Его fire вызовет тот же `checkAndReset` — дедуп
сводит двойной вызов к одному reset; в history различие видно по note
("wake" vs "auto"). Сближение/замена arm-watchdog на wake-таблицу — вне
области спека (Non-Goals: fire-путь не трогаем).

**Q:** Что показывает `/billing-status`, если окно не началось?  
**A:** Явное «активной точки нет (окно не началось)» — не ошибка (US-002,
FR-012-2).

**Q:** Почему `/settimer N>0` не трогает `lastResetAt`?  
**A:** Существующее поведение (COMMANDS.md §4): ручной sync не должен
подавлять ближайший авто-reset дедупом `checkAndReset`. Сохранено дословно
(FR-012-5, TD-006).

**Q:** Какие константы вводятся и где живут?  
**A:** `WAKE_MARGIN_MS = 2 мин`, `WAKE_DEPTH = 12`, `WAKE_BURNED_TTL_MS =
30 мин` — в wakeups.ts (экспортируемые, для тестов). `WINDOW_MS`,
`SYNC_POLL_MS`, `ABOUT_TO_RESET_MS`, `DEDUP_WINDOW_MS`,
`RETRY_AFTER_FIRE_MS` — существующие, без изменений.

## 17. Open Questions — RESOLVED (оркестратор, 2026-10-24)

- **R1 (дубликаты точек):** ввести минимальный интервал 60 с в `appendAnchorPoint` (точка ближе 60 с к существующей не вставляется). Reset-дедуп остаётся страховкой.
- **R2 (хвост после /settimer N>0):** единообразно — полные 12 точек от якоря (`computeTableFromAnchor`), как и для auto-якоря. Основание: FR-012-5/D-005 утверждает хвост = точка + 2ч×k, k=1..11, без исключений для source="settimer".
- **R3 (arm-watchdog):** в этом спеке не трогать; перевод watchdog на wake-таблицу — backlog-кандидат после обкатки (риск для fire-пути спеков 002/009).
