# Сценарий B2 — взвод → /reload ДО границы → доставка ПОСЛЕ session-start(reload), дедуп (T-14)

- Дата: 2026-09-28, финальный прогон run3: 10:52–10:56Z (повтор run2 10:46–10:49Z), после деплоя с `/pbr-reload`.
- Модель: wormsoft/zai/glm-5.3-flash. Драйвер: `004-live-scenario-testing/reports/run_live_t3_b2.py`
  (B2-run3-console.log, B2-run2-console.log).
- Сессия: `2026-09-28T10-32-49-901Z_live-B2.jsonl`, pid=9936 (run3).

## VERDICT: PASS (10/10 чеков; подтверждено двумя независимыми прогонами)

## Хронология run3 (armslog, проверено оркестратором лично)

```
10:52:xx | session-start  | reason=startup (новый pid 9936, ep=0)
10:53:5x | arm-seen       | внешний взвод, lastResetAtAtArm переписан = текущий lastResetAt
10:53:5x | session-start  | reason=reload (СТРОГАЯ проверка: event==session-start, reason=reload, наш key)
   [+ флаг пережил reload — запись в arms.json на месте]
10:55:26 | fire:reset-ready | сброс окна (settimer 0 из drv-сессии)
10:55:26 | send-error:stale | pi устарел после reload — попытка 1/6 (release lease, T-05)
10:55:26 | fire:reset-ready | повтор после stale-провала (lease освобождён)
10:55:26 | fire:send-ok    | 1 фактическая доставка на сброс
10:56:26 | fire:confirmed  | флаг снят; arm-gone штатный
```

- Доставка произошла ПОСЛЕ session-start(reload); РОВНО одна фактическая
  доставка (send-ok=1) и одно подтверждение на сброс (дедуп D-604 с учётом
  документированной release-точки T-05 «первый stale-провал»).
- Негативов (capitulation / watchdog:reset-error / arm-gone до confirmed) — 0.

## НАХОДКА (класс C1, передаётся в E1/T-12 и final-report)

После `session_start(reason=reload)` (модуль пересоздан, фабрика со свежим pi)
ПЕРВАЯ отправка всё равно попадает в stale ctx («This extension ctx is stale
after session replacement or reload», `ctx=stale src=drain epoch-mismatch=1`
на fire-строке). Восстановление — ~1с (release → re-fire → send-ok), инвариант
доставки не нарушен, но это прямое свидетельство «инвалидация без
переусыновления» в reload-пути — усиливает аргумент FR-402 (изоляция по ключу).

## DEVIATIONS

1. `/reload` — встроенная TUI-команда, через RPC-prompt недостижима (проверено
   по бандлу pi 8.5.4: switch(command.type) не содержит reload; prompt уходит
   модели как обычное сообщение — воспроизведено в run1). Добавлена команда
   расширения `/pbr-reload` (ctx.reload() → session.reload(), reason=reload) —
   commit feat(spec-006), задеплоена.
2. run1: чек «session-start(reason=reload)» ложно прошёл — wait_event при
   таймауте возвращает последнюю строку дельты. Фикс: строгая валидация
   совпадения (reload_ok), таймаут теперь = FAIL.
3. Внешний взвод с lastResetAtAtArm=0 порождал немедленный fire до reload —
   драйвер переписывает lastResetAtAtArm = текущий lastResetAt (как в B1).
4. Дедуп-чек ужесточён семантически: 1 фактическая доставка на сброс;
   дополнительный fire:reset-ready допускается ТОЛЬКО при intervening
   send-error:stale (документированная release-точка). run2/run3 оба
   воспроизвели stale-провал → восстановление.
