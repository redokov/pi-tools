# Сценарий night-mini-2 — повтор ночного сценария (T-14, после деплоя 83b4a15/a867fa1)

- Дата: 2026-09-28 10:57–11:26Z. Модель: мёртвый провайдер (freedeepseek:9655 не слушается —
  моделирует ночь/429: ответа нет, pending жив). LLM-вызовов нет, окно wormsoft не расходуется.
- Драйвер: `004-live-scenario-testing/reports/run_live_t3_night.py` (night-run2-console.log).
- Сессия: `2026-09-27T18-09-23-316Z_live-T3-2.jsonl`, pid=31912, ep=0.

## VERDICT: PASS (по существу; единственный FAIL-check драйвера — артефакт подсчёта атрибуции, armslog проверен оркестратором лично)

## Хронология (armslog ~/.pi/agent/pi-billing-window-arms.log)

```
10:57:44.631Z | session-start | reason=startup key=...live-T3-2.jsonl pid=31912 ep=0
10:57:54.119Z | arm-seen      | repeat=3 phase=armed
10:58:56.471Z | fire:send-ok  | «продолжи» отправлен, флаг в pending (сброс #1)
   [тишина ~20 мин: НИ ОДНОГО лишнего fire, ни одного send-error/capitulation]
11:18:44.773Z | fire:send-ok  | «продолжи» отправлен (сброс #2)
11:25:59.308Z | arm-gone      | после /cont-after-reset off (cleanup), my_rec=null
```

- По одному send-ok на каждый сброс (10:58:56 и 11:18:44), атрибуция полная
  (key+host+ep в каждой строке), РОВНО 2 send-ok суммарно — подтверждено
  grep'ом оркестратора.
- Тишина между сбросами: 19 мин 48 с, без лишних fire и негативов.
- Pending жив после send-ok (ответа от мёртвого провайдера нет) — no false
  confirm: ни одной fire:confirmed/capitulation строки.
- Финал: driver disarm → флаг снят чисто.

## DEVIATIONS

1. Чек драйвера «attributed fire:send-ok == 2» посчитал 1 из-за своего
   подсчёта (по key+reset в дельте) — обе строки send-ok в armslog
   корректно атрибутированы. Суть сценария (1 send-ok на сброс, 15 мин
   тишина) выполняется.
2. Сбросы #1/#2 в этом прогоне созданы самим драйвером (/settimer 0 из
   drv-сессии, мёртвый провайдер на команд достаточно).
