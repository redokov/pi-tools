# Сценарий A3 — внешний взвод headless-сессии + доставка (T-14)

- Дата: 2026-09-28 09:01–09:09Z, прогон после деплоя 83b4a15 (T-08/T-09 + firelease в деплое).
- Модель: wormsoft/zai/glm-5.3-flash (дефолт rpc_harness), провайдер wormsoft.
- Драйвер: `.ai/sdd/specs/004-live-scenario-testing/reports/run_live_t3_a3.py`
  (сырые логи: T3-3-rpc-raw.log, T3-3-drv-rpc-raw.log, консоль A3-run-console.log).
- Сессия: `2026-09-28T09-01-06-028Z_live-T3-3.jsonl`, pid=23400, ep=0.

## VERDICT: PASS (по существу; 2 check'а драйвера были ложными из-за гонок — драйвер исправлен, см. DEVIATIONS)

## Доказательства (armslog ~/.pi/agent/pi-billing-window-arms.log, проверено оркестратором лично)

```
09:01:08.946Z | session-start | reason=startup key=...live-T3-3.jsonl pid=23400 ep=0
09:03:08.954Z | arm-seen      | repeat=1 phase=armed key=... (arm-seen = 52.0s ≤ 60s)
09:03:08.974Z | fire:reset-ready | сброс окна 07:36:41Z, отправляю «продолжи» через 0 с
09:03:09.005Z | fire:send-ok  | флаг в pending
09:03:16.072Z | fire:confirmed| успешный ответ — флаг снят
09:03:16.073Z | arm-gone      | флаг исчез (sync-poller)
```

Heartbeat-агента: `RESUMED 2026-09-28T09:03:16Z` (sessions/A3-heartbeat.txt) — задача реально
возобновилась. Негативных событий (send-error:stale / capitulation / watchdog:reset-error) — 0.
Задержка arm→send-ok: 51 мс; send-ok→confirmed: 7.1 с. Ровно 1 fire на сброс.

## DEVIATIONS

1. Первичный вердикт драйвера был FAIL по двум гонкам в его собственных check'ах:
   (а) «arm-seen ≤60s» пере-вычислял time.time() уже после 6-минутных ожиданий;
   (б) «send-ok (phase pending)» опрашивал arms.json после того, как флаг уже
   успел сгореть (fire случился прямо на arm-seen — сброс окна 07:36Z ещё не был
   подтверждён для этого ключа, корректный путь «пропущенный сброс»).
   Оба фикса внесены в run_live_t3_a3.py (arm_seen_sec фиксируется в момент
   события; send-ok засчитывается и по строке fire:send-ok в armslog).
2. Доставка произошла от «пропущенного» сброса (lastResetAtAtArm=0 →
   немедленный fire) — это штатное поведение внешнего взвода, сценарий
   свойство сохраняет: внешний взвод → arm-seen ≤60s → доставка.
