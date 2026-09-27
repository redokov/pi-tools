# Spec 005 — Tasks

Последовательное исполнение агентами wormsoft/deepseek-ai/deepseek-v4-flash.
Каждый агент: ТЕСТЫ+КОД — да; commit/push/deploy — НЕТ (оркестратор).

## T1 — RED: тесты новой семантики (flash)

1. Новый сьют `tests/pending-window-retry.test.mts` по design.md «Tests»
   (юнит-уровень + export `__testRetryTick__`-хук при необходимости, по
   образцу `__resetStaleStateForTests` в src/index.ts).
2. Grep старых тестов: `grep -rn "RETRY_AFTER_FIRE_MS\|pending" tests/` —
   список тестов, кодирующих 5-мин повтор; обновить ИХ ожидания НЕ менять
   (это T2), только перечислить в отчёте.
3. Прогон нового сьюта → RED (FAIL из-за старой логики). Приложить вывод.

## T2 — GREEN: реализация (flash)

1. `src/index.ts`: маркер `pendingFiredResetAt`, новая pending-ветка
   retryTick, сброс маркера в confirmSuccess + `__resetStaleStateForTests`
   (по design.md). `src/arms.ts` не трогать (константа остаётся).
2. Прогон T1-сьюта → GREEN.
3. Обновить тесты из п.1-2 задачи T1 (старая 5-мин семантика → новая).
4. Полный регресс 9 сьютов: 0 FAIL. Приложить суммы.
5. `npm run build` → clean.

## T3 — Live verify (flash; после deploy оркестратором)

1. Deploy выполнен оркестратором (в т.ч. перезапуск/`/reload` живых окон
   не нужен — тестируем новые сессии).
2. RPC-харнесс из 004/reports (rpc_harness.py, run_a1.py) → прогон A1
   (ожидание PASS) + новый live-сценарий «pending-ночь-мини»: arm →
   settimer 0 → send-ok → 15 мин тишины (0 повторов в arms.log) →
   отчёт reports/scenario-005-night-mini.md.
3. A3/A4 (внешний взвод, TTL) — если не успел стадия 2.
