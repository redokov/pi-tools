# Feature: Гигиена завершения тест-процессов (003-suite-exit-hygiene)

> Status: Approved (владелец: автономный режим, «действовать без участия человека»)
> Source: обнаружено при хотфиксе T15 спеки 002 — `npx tsx tests/replacement.test.mts`
> печатает «8 passed, 0 failed», но процесс не завершается (exit по таймауту).
> Воспроизводится и на HEAD до T15, т.е. предсуществующая проблема.
> Scope: расширение `pi-billing-window` (репо pi-tools, каталог `C:\Tools\pi-billing-window`).

## Overview

Тест-сьюты расширения обязаны завершать процесс после вывода сводки: `npx tsx tests/*.mts`
должен давать управляемый регресс без `timeout`-обёрток и сиротских node-процессов.
Сейчас `replacement.test.mts` виснет: в сценарии 2 финальный `session_shutdown` передаёт
старый ctx, race-гард `onSessionShutdown` (`_ctx !== currentCtx → return`) корректно пропускает
teardown — защита новее сессии важнее, — но оставшиеся «живыми» интервалы
(statusUpdater 30 с в ui.ts, ticker в ticker.ts) НЕ unref'нуты и держат event loop навечно.
Экспериментальная верификация: добавление `.unref()` обоим интервалам → exit=0 (сделано в песочнице,
не в коммите). Остальные таймеры (syncTimer, retryTimer, graceTimer) уже unref'нуты — parity.

## Root Cause (установлен 2026-09-27, экспериментально)

1. `src/ui.ts` `startStatusUpdater` — `setInterval(...)` без `unref()`;
   `src/ticker.ts` `startTicker` — `setInterval(...)` без `unref()`.
2. `tests/replacement.test.mts` сценарий 2 — намеренный «late shutdown со старым ctx»
   (покрывает race-гард), teardown пропускается → интервалы из п.1 остаются живыми.
3. Следствие-компаньон: сиротские зависшие node-процессы накапливаются и являются
   кандидатом на источник мимолётных крашей `test.mts` (exit=1 без сводки), наблюдавшихся
   при прогоне сьютов подряд.

## Functional Requirements

### FR-001 — Тест-сьют завершает процесс — Must Have
WHEN все asserts сьюта выполнены и сводка выведена
THE SYSTEM (набор тестов) ЗАВЕРШИТ процесс с корректным exit-кодом в пределах 60 с
БЕЗ принудительного `process.exit` и без висячих интервалов.

### FR-002 — Periodic-таймеры не держат процесс (production hygiene) — Must Have
WHEN расширение создаёт любой периодический таймер (ticker, statusUpdater, sync/retry/grace)
THEN каждый обязан быть `unref()`-нут — паритет с уже unref'нутыми watchdog-таймерами.
Timing-семантика в живом pi не меняется: `unref` влияет только на completion.

### FR-003 — Юнит-контракт unref проверяем — Must Have
Оба интервала (ticker.ts, ui.ts) обязаны предоставить test-пробу `hasRefForTests(): boolean | null`
(null = интервал не запущен), чтобы юнит-тест зафиксировал `hasRef() === false` после старта.

### FR-004 — e2e-регрессия «exit hygiene» — Must Have
Мета-сьют `tests/exit-hygiene.test.mts`: спавнит каждый из 8 сьютов
(`node <tsx-cli> tests/<suite>.test.mts`), ждёт завершения с таймаутом,
asserts: exit code === 0. Список сьютов фиксирован; сам мета-сьют себя не спавнит.

### FR-005 — Без регрессии поведения — Must Have
Ticker/statusUpdater продолжают стрелять в живом pi (unref не отменяет интервалы);
сценарий 2 replacement-сьита не меняется (он намеренно покрывает race-гард);
форматы arms.json/state.json не затрагиваются.

## Non-Functional Requirements

- NFR-001: Мета-сьют сам не должна добавлять >2–3 мин к полному регрессу (последовательный спавн, один процесс за раз).
- NFR-002. Никаких новых зависимостей (child_process + существующий tsx CLI).

## Out of Scope
- Изменение race-гарда `onSessionShutdown` (семантика корректна: защищает более новую сессию).
- Синхронизация «флейка» `test.mts` в принципе — фиксируется как следствие FR-001 (уход сирот), не отдельная фича.
