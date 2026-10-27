# Scenario 005 NIGHT-MINI (fire-once-per-window live)

- Дата (UTC): 2026-09-28T11:26:03Z
- Коммит: 36f8ffa (pending-повтор 'продолжи' только после нового сброса окна)
- Модель: freedeepseek/deepseek-default (провайдер 127.0.0.1:9655 НЕ поднят = ночь/429: ответа нет, pending жив)
- session-id: live-T3-2
- session-file (ключ флага): C:\Tools\pi-billing-window\.ai\sdd\specs\004-live-scenario-testing\sessions\2026-09-27T18-09-23-316Z_live-T3-2.jsonl
- state до: {"windowStartedAt": 1790592916984, "lastResetAt": 1790592916984, "resetCount": 434, "callsInWindow": 12}

## Timeline delta (со строки 432)

```
2026-09-28T10:57:44.631Z | session-start | reason=startup key=2026-09-27T18-09-23-316Z_live-T3-2.jsonl armed=false pid=31912 host=DESKTOP-3PDA7V4 ep=0
2026-09-28T10:57:54.119Z | arm-seen | repeat=3 phase=armed key=2026-09-27T18-09-23-316Z_live-T3-2.jsonl pid=31912 host=DESKTOP-3PDA7V4 ep=0
2026-09-28T10:58:56.471Z | fire:send-ok | «продолжи» отправлен, флаг в pending до первого успешного ответа key=2026-09-27T18-09-23-316Z_live-T3-2.jsonl pid=31912 host=DESKTOP-3PDA7V4 ep=0
2026-09-28T11:18:44.773Z | fire:send-ok | «продолжи» отправлен, флаг в pending до первого успешного ответа key=2026-09-27T18-09-23-316Z_live-T3-2.jsonl pid=31912 host=DESKTOP-3PDA7V4 ep=0
2026-09-28T11:25:59.308Z | arm-gone | флаг исчез/истёк (sync-poller продолжает жить) key=2026-09-27T18-09-23-316Z_live-T3-2.jsonl pid=31912 host=DESKTOP-3PDA7V4 ep=0
```

## Evidence

```
[2026-09-28T10:57:54Z] session_start: 2026-09-28T10:57:44.631Z | reason=startup key=2026-09-27T18-09-23-316Z_live-T3-2.jsonl armed=false pid=31912 host=DESKTOP-3PDA7V4 ep=0
[2026-09-28T10:57:54Z] session_file: C:\Tools\pi-billing-window\.ai\sdd\specs\004-live-scenario-testing\sessions\2026-09-27T18-09-23-316Z_live-T3-2.jsonl
[2026-09-28T10:57:54Z] cmd_cont3: {"type": "response", "command": "prompt", "success": true}
[2026-09-28T10:57:54Z] arm_seen: 2026-09-28T10:57:54.119Z | repeat=3 phase=armed key=2026-09-27T18-09-23-316Z_live-T3-2.jsonl pid=31912 host=DESKTOP-3PDA7V4 ep=0
[2026-09-28T10:57:56Z] state_after_arm: {"C:\\Users\\r.edokov\\.pi\\agent\\sessions\\--c--Tools--\\2026-09-27T19-42-16-470Z_01a0e463-bb95-72b7-a664-631adedab83b.jsonl": {"armedAt": 1790573023356, "lastResetAtAtArm": 1790566528148, "expiresAt": 1790601823356, "repeat": 1}, "C:\\Users\\r.edokov\\.pi\\agent\\sessions\\--c--MyProjects-TabDocLoad--\\2026-09-27T17-27-11-381Z_01a0e3e8-0f14-727c-8553-0125dd2d68f8.jsonl": {"repeat": 20, "armedAt": 1790591668683, "lastResetAtAtArm": 1790590672370, "expiresAt": 1790620468683}, "C:\\Tools\\pi-billing-window\\.ai\\sdd\\specs\\004-live-scenario-testing\\sessions\\2026-09-27T18-09-23-316Z_live-T3-2.jsonl": {"armedAt": 1790593074114, "lastResetAtAtArm": 1790592916984, "expiresAt": 1790621874114, "repeat": 3}}
[2026-09-28T10:57:56Z] my_rec_after_arm: {"armedAt": 1790593074114, "lastResetAtAtArm": 1790592916984, "expiresAt": 1790621874114, "repeat": 3}
[2026-09-28T10:57:56Z] cmd_settimer0_R1: {"type": "response", "command": "prompt", "success": true}
[2026-09-28T10:57:56Z] reset1_lastResetAt: 1790593076412
[2026-09-28T10:58:56Z] fire_send_ok_1_lastFireAt: 1790593136420 | {'phase': 'pending'}
[2026-09-28T10:58:56Z] SILENCE-WINDOW-1: 15 min, no resets (FR1):
[2026-09-28T11:13:56Z] silence1_extra_fires: none
[2026-09-28T11:13:57Z] cmd_settimer0_R2: {"type": "response", "command": "prompt", "success": true}
[2026-09-28T11:13:57Z] reset2_lastResetAt: 1790594036801
[2026-09-28T11:20:57Z] fire_send_ok_2_lastFireAt: 1790594324741
[2026-09-28T11:20:57Z] extra_fires_after_reset2: none
[2026-09-28T11:20:59Z] my_rec_after_R2: {"armedAt": 1790593074114, "lastResetAtAtArm": 1790592916984, "expiresAt": 1790621874114, "repeat": 3, "phase": "pending", "lastFireAt": 1790594324741}
[2026-09-28T11:20:59Z] SILENCE-WINDOW-2: 5 min after reset#2 (FR1 again):
[2026-09-28T11:25:59Z] silence2_extra_fires: none
[2026-09-28T11:25:59Z] attributed_fire_send_ok_mine: none
[2026-09-28T11:25:59Z] fire_send_ok_other_flags: ['2026-09-28T10:58:56.471Z', '2026-09-28T11:18:44.773Z']
[2026-09-28T11:25:59Z] negative_events: none
[2026-09-28T11:25:59Z] checks: {"armed repeat==3": true, "send-ok#1 seen": true, "15min silence: no extra fires": true, "send-ok#2 exactly one after reset#2": true, "5min silence after reset#2": true, "attributed fire:send-ok == 2": false, "still pending (no false confirm)": true, "no negatives": true}
[2026-09-28T11:25:59Z] cleanup_disarm_cmd: ok
[2026-09-28T11:26:01Z] my_rec_after_disarm: null
```

## Вердикт: FAIL
