# Scenario 005 NIGHT-MINI (fire-once-per-window live)

- Дата (UTC): 2026-09-27T18:38:44Z
- Коммит: 36f8ffa (pending-повтор 'продолжи' только после нового сброса окна)
- Модель: freedeepseek/deepseek-default (провайдер 127.0.0.1:9655 НЕ поднят = ночь/429: ответа нет, pending жив)
- session-id: live-T3-2
- session-file (ключ флага): C:\Tools\pi-billing-window\.ai\sdd\specs\004-live-scenario-testing\sessions\2026-09-27T18-09-23-316Z_live-T3-2.jsonl
- state до: {"windowStartedAt": 1790532479845, "lastResetAt": 1790532479845, "resetCount": 411, "callsInWindow": 8}

## Timeline delta (со строки 300)

```
2026-09-27T18:09:25.650Z | session-start | reason=startup key=2026-09-27T18-09-23-316Z_live-T3-2.jsonl armed=false
2026-09-27T18:09:34.994Z | arm-seen | repeat=3 phase=armed key=2026-09-27T18-09-23-316Z_live-T3-2.jsonl
2026-09-27T18:10:37.323Z | fire:reset-ready | watchdog: сброс окна 2026-09-27T18:09:37.286Z, отправляю «продолжи» через 0 с
2026-09-27T18:10:37.375Z | fire:reset-ready | watchdog: сброс окна 2026-09-27T18:09:37.286Z, отправляю «продолжи» через 0 с
2026-09-27T18:10:37.455Z | fire:send-ok | «продолжи» отправлен, флаг в pending до первого успешного ответа
2026-09-27T18:11:06.556Z | arm-seen | repeat=10 phase=armed key=2026-09-27T13-57-14-949Z_01a0e327-da45-74d2-bffc-cacd20bd4e66.jsonl
2026-09-27T18:27:07.601Z | fire:reset-ready | watchdog: сброс окна 2026-09-27T18:26:07.596Z, отправляю «продолжи» через 0 с
2026-09-27T18:27:08.605Z | fire:reset-ready | watchdog: сброс окна 2026-09-27T18:26:07.596Z, отправляю «продолжи» через 0 с
2026-09-27T18:27:08.618Z | send-error:stale | pi устарел: This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession() — попытка 1/6, повтор через 5 мин
2026-09-27T18:27:10.619Z | fire:reset-ready | watchdog: сброс окна 2026-09-27T18:26:07.596Z, отправляю «продолжи» через 0 с
2026-09-27T18:30:25.687Z | fire:send-ok | «продолжи» отправлен, флаг в pending до первого успешного ответа
2026-09-27T18:32:08.623Z | send-error:stale | pi устарел: This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession() — попытка 2/6, повтор через 10 мин
2026-09-27T18:35:24.193Z | fire:send-ok | «продолжи» отправлен, флаг в pending до первого успешного ответа
2026-09-27T18:35:37.451Z | fire:send-ok | «продолжи» отправлен, флаг в pending до первого успешного ответа
2026-09-27T18:38:39.958Z | arm-gone | флаг исчез/истёк (sync-poller продолжает жить)
```

## Evidence

```
[2026-09-27T18:09:34Z] session_start: 2026-09-27T18:09:25.650Z | reason=startup key=2026-09-27T18-09-23-316Z_live-T3-2.jsonl armed=false
[2026-09-27T18:09:34Z] session_file: C:\Tools\pi-billing-window\.ai\sdd\specs\004-live-scenario-testing\sessions\2026-09-27T18-09-23-316Z_live-T3-2.jsonl
[2026-09-27T18:09:35Z] cmd_cont3: {"type": "response", "command": "prompt", "success": true}
[2026-09-27T18:09:35Z] arm_seen: 2026-09-27T18:09:34.994Z | repeat=3 phase=armed key=2026-09-27T18-09-23-316Z_live-T3-2.jsonl
[2026-09-27T18:09:37Z] state_after_arm: {"C:\\Users\\r.edokov\\.pi\\agent\\sessions\\--c--Tools--\\2026-09-27T13-57-14-949Z_01a0e327-da45-74d2-bffc-cacd20bd4e66.jsonl": {"armedAt": 1790531673368, "lastResetAtAtArm": 1790530473047, "expiresAt": 1790560473368, "repeat": 1}, "C:\\Users\\r.edokov\\.pi\\agent\\sessions\\--c--MyProjects-TabDocLoad--\\2026-09-27T17-27-11-381Z_01a0e3e8-0f14-727c-8553-0125dd2d68f8.jsonl": {"armedAt": 1790531684307, "lastResetAtAtArm": 1790530473047, "expiresAt": 1790560484307, "repeat": 10}, "C:\\Tools\\pi-billing-window\\.ai\\sdd\\specs\\004-live-scenario-testing\\sessions\\2026-09-27T18-09-23-316Z_live-T3-2.jsonl": {"armedAt": 1790532574989, "lastResetAtAtArm": 1790532479845, "expiresAt": 1790561374989, "repeat": 3}}
[2026-09-27T18:09:37Z] my_rec_after_arm: {"armedAt": 1790532574989, "lastResetAtAtArm": 1790532479845, "expiresAt": 1790561374989, "repeat": 3}
[2026-09-27T18:09:37Z] cmd_settimer0_R1: {"type": "response", "command": "prompt", "success": true}
[2026-09-27T18:09:37Z] reset1_lastResetAt: 1790532577286
[2026-09-27T18:10:37Z] fire_send_ok_1_lastFireAt: 1790532637307 | {'phase': 'pending'}
[2026-09-27T18:10:37Z] SILENCE-WINDOW-1: 15 min, no resets (FR1): 
[2026-09-27T18:26:07Z] silence1_extra_fires: none
[2026-09-27T18:26:07Z] cmd_settimer0_R2: {"type": "response", "command": "prompt", "success": true}
[2026-09-27T18:26:07Z] reset2_lastResetAt: 1790533567596
[2026-09-27T18:33:07Z] fire_send_ok_2_lastFireAt: 1790533825666
[2026-09-27T18:33:07Z] extra_fires_after_reset2: none
[2026-09-27T18:33:09Z] my_rec_after_R2: {"armedAt": 1790532574989, "lastResetAtAtArm": 1790532479845, "expiresAt": 1790561374989, "repeat": 3, "phase": "pending", "lastFireAt": 1790533825666}
[2026-09-27T18:33:09Z] SILENCE-WINDOW-2: 5 min after reset#2 (FR1 again): 
[2026-09-27T18:38:39Z] silence2_extra_fires: none
[2026-09-27T18:38:39Z] attributed_fire_send_ok_mine: none
[2026-09-27T18:38:39Z] fire_send_ok_other_flags: ['2026-09-27T18:10:37.455Z', '2026-09-27T18:30:25.687Z', '2026-09-27T18:35:24.193Z', '2026-09-27T18:35:37.451Z']
[2026-09-27T18:38:39Z] negative_events: ['send-error:stale', 'send-error:stale']
[2026-09-27T18:38:39Z] checks: {"armed repeat==3": true, "send-ok#1 seen": true, "15min silence: no extra fires": true, "send-ok#2 exactly one after reset#2": true, "5min silence after reset#2": true, "attributed fire:send-ok == 2": false, "still pending (no false confirm)": true, "no negatives": false}
[2026-09-27T18:38:40Z] cleanup_disarm_cmd: ok
[2026-09-27T18:38:42Z] my_rec_after_disarm: null
```

## Вердикт: FAIL

## Аддендум оркестратора (2026-09-27 19:45Z)

Вердикт переприписан: **PASS (по существу)**. Формальные причины FAIL в
скрипте — следствие неатрибутивности armslog (см.
diagnostics/2026-09-27-stale-ctx-missed-boundary.md):
- "attributed fire:send-ok == 2" — send-ok строки не несут ключ сессии,
  в окне прогонялись 3 параллельных взвода (оркестратор 01a0e327,
  TabDocLoad, live-T3-2), по дельте и arms.json цепочка live-T3-2 полная:
  18:10:37 (после R1) и 18:30:25 (после R2).
- "no negatives" — send-error:stale принадлежат ДРУГИМ флагам
  (01a0e327, см. инцидент stale-ctx), у live-T3-2 негативных не было.

Существенные критерии семантики spec 005 — все подтверждены:
15-мин тишина после send-ok#1 (0 повторов между сбросами), ровно один
повтор после reset#2, тишина после него.
