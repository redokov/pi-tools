# Design: Гигиена завершения тест-процессов (003-suite-exit-hygiene)

> Status: Approved (владелец: автономный режим)
> Scope: `pi-billing-window` (репо pi-tools)

## 1. Проверенные факты (диагностика 2026-09-27)

- `src/ui.ts` `startStatusUpdater` (~line 134): `currentInterval = setInterval(...)` — без `unref()`.
- `src/ticker.ts` `startTicker` (~line 107): `intervalHandle = setInterval(...)` — без `unref()`.
- `src/index.ts` watchdog-таймеры (`syncTimer`, `retryTimer`, `graceTimer`) уже `unref()` — паритет.
- `process._getActiveHandles()` на Windows неинформативен (возвращает `[]` при живом цикле) —
  диагноз построен эмпирически: патч `unref()` обоих интервалов → `replacement.test.mts` exit=0.
- `replacement.test.mts` сценарий 2: финальный `session_shutdown({}, ctx)` передаёт ctx ПЕРВОЙ
  сессии, а `currentCtx` уже replacement-ctx → race-гард в `onSessionShutdown` пропускает
  teardown. Это КОРРЕКТНАЯ продакшн-семантика (поздний shutdown для замещённой сессии не должен
  рвать таймеры новой); сценарий намеренно её покрывает и НЕ меняется.
- `node_modules/tsx/dist/cli.mjs` существует → спавн `process.execPath [cli.mjs, tests/<suite>.test.mts]`
  без `npx`-накладных; `Timeout.hasRef()` доступен и надёжен для юнит-контракта.

## 2. Decisions

### D-301 — unref обоих интервалов (production hygiene)
`currentInterval.unref()` в `ui.ts` сразу после `setInterval`; `intervalHandle.unref()` в `ticker.ts`.
Trade-off: при завершении главного хоста интервалы молча умрут — это и есть цель (никогда не
держать процесс). Альтернатива (teardown «на всякий случай» в гарде) отвергнута: меняла бы
семантику race-гарда. Impacts: FR-002, FR-005.

### D-302 — Тест-пробы `hasRefForTests(): boolean | null`
`ticker.ts`: `export function hasRefForTests(): boolean | null` — `intervalHandle === null ? null : intervalHandle.hasRef()`.
`ui.ts`: то же для `currentInterval`. Проба чистая (никаких side-effects), null = не запущен.
Альтернатива (assert через `process._getActiveHandles`) отвергнута: на Windows не работает.
Impacts: FR-003.

### D-303 — Мета-сьют `tests/exit-hygiene.test.mts` (unit + e2e в одном файле)
1. **Unit-часть**: старт ticker'а (без emit-акций) и statusUpdater'а (tui-mock ctx) →
   `hasRefForTests() === false` для обоих → стоп. RED сейчас (обе `true`), GREEN после D-301.
2. **E2e-часть**: последовательный спавн всех 8 сьютов (кроме самого exit-hygiene) через
   `execFile(process.execPath, [tsxCli, suite])`, таймаут 90 с на сьют, сбор stdout/stderr в память;
   asserts: exit code === 0 для каждого; на не-нуль — FAIL-строка с хвостом вывода (для диагностики).
   Замеренное время спавна сьюта ~2–5 с → полный мета-сьют ≈ 1–2 мин.
Impacts: FR-001, FR-004, NFR-001, NFR-002.

### D-304 — Race-гард и сценарий 2 replacement не трогаются
Гард корректен; сценарий 2 ценен как его регрессия. Дыра была не в пропущенном teardown,
а в не-unref'нутых интервалах — закрывается D-301, фиксируется D-303.

## 3. Requirements Mapping

| Requirement | Покрытие |
|---|---|
| FR-001 (сьюты завершаются) | D-301, D-303 (e2e-часть) |
| FR-002 (unref паритет) | D-301 |
| FR-003 (юнит-контракт unref) | D-302, D-303 (unit-часть) |
| FR-004 (e2e-регрессия exit) | D-303 |
| FR-005 (без регрессии) | D-304, прогон всех сьютов |
| NFR-001/002 | D-303 (последовательный спавн, без новых зависимостей) |

## 4. Edge cases

| Случай | Поведение |
|---|---|
| Спавненный сьют не уложился в 90 с | FAIL с выводом хвоста stderr/stdout спавна |
| Сьют упал с не-нуль exit | FAIL-строка с exit-кодом и хвостом вывода (диагностика) |
| Интервал не запущен при пробе | `hasRefForTests() === null` — unit-тест стартует интервалы сам, null невозможен на тестируемом пути |
| Windows-пути к cli.mjs | `join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs")` — уже проверено существованием файла |

## 5. Тестовая стратегия
RED → GREEN по спеке 002: T01 (тесты, RED) → T02 (фикс, GREEN) → T03 (docs) → T04 (регресс+deploy+коммит).
Механические черновики (файл теста, правки доков) — субагенты на дешёвых моделях; верификация, прогоны и решения — владелец-агент.
