# Сценарий B1 — /settimer → watchdog-fire → grace ≈60с от границы → доставка (T-14)

- Дата: 2026-09-28, финальный прогон run4: 10:06–10:19Z, после деплоя 83b4a15.
- Модель: wormsoft/zai/glm-5.3-flash (дефолт rpc_harness).
- Драйвер: `.ai/sdd/specs/004-live-scenario-testing/reports/run_live_t3_b1.py`
  (консоль B1-run4-console.log; предыдущие прогоны run1–run3 — B1-run-console.log/B1-run2/B1-run3).
- Сессия: `2026-09-28T09-37-56-061Z_live-B1.jsonl`, pid=21936.

## VERDICT: PASS (по существу; единственный FAIL-check драйвера мерял grace не от того момента — драйвер исправлен)

## Хронология (armslog, проверено оркестратором лично)

```
10:06:41.087Z | arm-seen          | repeat=1 phase=armed key=...live-B1.jsonl (внешний взвод, ≤60s)
10:06:41.088Z | session-start     | reason=startup armed=true (арм пережил перезапуск сессии)
   [граница /settimer 11m: реальный сброс окна]
10:17:52.370Z | (real reset)      | lastResetAt=10:17:52.370 (сброс окна 09:17:52Z... — фикс. в state)
10:18:23.399Z | fire:reset-ready  | «сброс окна 10:17:52.370Z, отправляю «продолжи» через 29 с»
10:18:52.409Z | fire:send-ok      | флаг в pending
10:19:00.152Z | fire:confirmed    | успешный ответ — флаг снят
10:19:00.153Z | arm-gone          | штатное снятие после confirmed
```

- **Граница → доставка = ровно 60.0с** (10:17:52.370 → 10:18:52.409) — совпадает с
  `resetGraceMs` (60с) с точностью до миллисекунды.
- Дедуп: ровно 1× fire:reset-ready / send-ok / confirmed на сброс (delta_key_attr_counts).
- Негативных событий (send-error:stale / capitulation / watchdog:reset-error / arm-gone
  до confirmed) — 0.

## Почему grace меряется от сброса, а не от fire-строки

`src/index.ts` (onWatchdogFire): `delay = max(0, base + resetGraceMs - now)` —
«a reset that happened before the fire does not wait the grace twice». Watchdog
тикает шагом ~30с, поэтому при границе 10:17:52 fire случился в 10:18:23
(опоздание 31с) → задержка 29с, итого от границы ровно 60с. Чек драйвера
«45..90s (fire→send-ok)» мерял неверный интервал; исправлен на
«45..90s от момента сброса» (парсинг base из detail fire:reset-ready).

## DEVIATIONS (история отладки драйвера, run1–run3)

1. run1/run2: взвод с `lastResetAtAtArm=0` → немедленный fire «пропущенного
   сброса» ДО /settimer, сценарий съедался. Фикс: драйвер атомарно переписывает
   `lastResetAtAtArm = текущий lastResetAt` после внешнего взвода.
2. run1–run3: `/settimer N` трактует голое N как МИНУТЫ (300 = 5 часов,
   660 = 11 часов) — граница уходила за горизонт. Фикс: `/settimer 11m`.
3. Дедуп checkAndReset (10 мин): если прошлый сброс <10 мин до fire, real-reset
   подавляется и grace вырождается в 0 (run1: base=09:34:16, fire=09:38:56).
   Гарантия корректности: длительность >10 мин (11m).
4. `scenario_common.wait_event` при таймауте возвращает последнюю строку delta
   (не None) — в run3 драйвер «нашёл» чужую owner-shift строку. Учтено:
   совпадение фильтруется по key_basename; при MISSING значение — артефакт.
