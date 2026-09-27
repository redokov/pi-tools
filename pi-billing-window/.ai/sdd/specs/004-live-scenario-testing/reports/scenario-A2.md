# Scenario A2 - repeat 3x (perevzvod 3->2->1->gone)

- DatA (UTC): 2026-09-27T14:33:03Z
- session-id: live-A2
- session-file (kluch): C:\Tools\pi-billing-window\.ai\sdd\specs\004-live-scenario-testing\sessions\2026-09-27T14-18-09-478Z_live-A2.jsonl
- session-start: 2026-09-27T14:18:11.814Z | reason=startup key=2026-09-27T14-18-09-478Z_live-A2.jsonl armed=false
- Global counters DO: {"fire:reset-ready": 149, "fire:send-ok": 6, "fire:confirmed": 3, "session-start": 51}
- Global counters POSLE: {"fire:reset-ready": 153, "fire:send-ok": 8, "fire:confirmed": 3, "session-start": 52}
- arms.json do: {"C:\\Users\\r.edokov\\.pi\\agent\\sessions\\--c--Tools--\\2026-09-27T13-57-14-949Z_01a0e327-da45-74d2-bffc-cacd20bd4e66.jsonl": {"armedAt": 1790517539964, "lastResetAtAtArm": 1790516097644, "expiresAt": 1790546339964, "repeat": 1}}
- state do: {"windowStartedAt": 1790518415356, "lastResetAt": 1790518415356, "resetCount": 402, "callsInWindow": 18}

## Timeline delta (so stroki 244)

```
2026-09-27T14:18:11.814Z | session-start | reason=startup key=2026-09-27T14-18-09-478Z_live-A2.jsonl armed=false
2026-09-27T14:18:21.198Z | arm-seen | repeat=3 phase=armed key=2026-09-27T14-18-09-478Z_live-A2.jsonl
2026-09-27T14:19:23.510Z | fire:reset-ready | watchdog: сброс окна 2026-09-27T14:18:23.491Z, отправляю «продолжи» через 0 с
2026-09-27T14:19:23.549Z | fire:send-ok | «продолжи» отправлен, флаг в pending до первого успешного ответа
2026-09-27T14:23:25.901Z | fire:reset-ready | watchdog: сброс окна 2026-09-27T14:22:25.885Z, отправляю «продолжи» через 0 с
2026-09-27T14:27:28.306Z | fire:reset-ready | watchdog: сброс окна 2026-09-27T14:26:28.290Z, отправляю «продолжи» через 0 с
2026-09-27T14:29:11.855Z | fire:send-ok | «продолжи» отправлен, флаг в pending до первого успешного ответа
2026-09-27T14:31:30.690Z | fire:reset-ready | watchdog: сброс окна 2026-09-27T14:30:30.688Z, отправляю «продолжи» через 0 с
```

## Evidence

```
[2026-09-27T14:18:21Z] session_start: 2026-09-27T14:18:11.814Z | reason=startup key=2026-09-27T14-18-09-478Z_live-A2.jsonl armed=false
[2026-09-27T14:18:21Z] session_file: C:\Tools\pi-billing-window\.ai\sdd\specs\004-live-scenario-testing\sessions\2026-09-27T14-18-09-478Z_live-A2.jsonl
[2026-09-27T14:18:21Z] cmd_cont3: {"type": "response", "command": "prompt", "success": true}
[2026-09-27T14:18:21Z] arm_seen: 2026-09-27T14:18:21.198Z | repeat=3 phase=armed key=2026-09-27T14-18-09-478Z_live-A2.jsonl
[2026-09-27T14:18:23Z] arms_after_arm_r3: {"C:\\Users\\r.edokov\\.pi\\agent\\sessions\\--c--Tools--\\2026-09-27T13-57-14-949Z_01a0e327-da45-74d2-bffc-cacd20bd4e66.jsonl": {"armedAt": 1790517539964, "lastResetAtAtArm": 1790516097644, "expiresAt": 1790546339964, "repeat": 1}, "C:\\Tools\\pi-billing-window\\.ai\\sdd\\specs\\004-live-scenario-testing\\sessions\\2026-09-27T14-18-09-478Z_live-A2.jsonl": {"armedAt": 1790518701193, "lastResetAtAtArm": 1790518415356, "expiresAt": 1790547501193, "repeat": 3}}
[2026-09-27T14:18:23Z] --- reset #1 ---: 
[2026-09-27T14:18:23Z] cmd_settimer0_1: {"type": "response", "command": "prompt", "success": true}
[2026-09-27T14:22:23Z] fire_confirmed_1: 2026-09-27T14:19:23.549Z | «продолжи» отправлен, флаг в pending до первого успешного ответа
[2026-09-27T14:22:25Z] arms_after_R1: {"C:\\Users\\r.edokov\\.pi\\agent\\sessions\\--c--Tools--\\2026-09-27T13-57-14-949Z_01a0e327-da45-74d2-bffc-cacd20bd4e66.jsonl": {"armedAt": 1790517539964, "lastResetAtAtArm": 1790516097644, "expiresAt": 1790546339964, "repeat": 1}, "C:\\Tools\\pi-billing-window\\.ai\\sdd\\specs\\004-live-scenario-testing\\sessions\\2026-09-27T14-18-09-478Z_live-A2.jsonl": {"armedAt": 1790518701193, "lastResetAtAtArm": 1790518415356, "expiresAt": 1790547501193, "repeat": 3, "phase": "pending", "lastFireAt": 1790518763505}}
[2026-09-27T14:22:25Z] repeat/phase/lastResetAtAtArm: 3 | pending | mismatch
[2026-09-27T14:22:25Z] --- reset #2 ---: 
[2026-09-27T14:22:26Z] cmd_settimer0_2: {"type": "response", "command": "prompt", "success": true}
[2026-09-27T14:26:26Z] fire_confirmed_2: 2026-09-27T14:23:25.901Z | watchdog: сброс окна 2026-09-27T14:22:25.885Z, отправляю «продолжи» через 0 с
[2026-09-27T14:26:28Z] arms_after_R2: {"C:\\Users\\r.edokov\\.pi\\agent\\sessions\\--c--Tools--\\2026-09-27T13-57-14-949Z_01a0e327-da45-74d2-bffc-cacd20bd4e66.jsonl": {"armedAt": 1790517539964, "lastResetAtAtArm": 1790516097644, "expiresAt": 1790546339964, "repeat": 1}, "C:\\Tools\\pi-billing-window\\.ai\\sdd\\specs\\004-live-scenario-testing\\sessions\\2026-09-27T14-18-09-478Z_live-A2.jsonl": {"armedAt": 1790518701193, "lastResetAtAtArm": 1790518415356, "expiresAt": 1790547501193, "repeat": 3, "phase": "pending", "lastFireAt": 1790518763505}}
[2026-09-27T14:26:28Z] repeat/phase/lastResetAtAtArm: 3 | pending | mismatch
[2026-09-27T14:26:28Z] --- reset #3 ---: 
[2026-09-27T14:26:28Z] cmd_settimer0_3: {"type": "response", "command": "prompt", "success": true}
[2026-09-27T14:30:28Z] fire_confirmed_3: 2026-09-27T14:29:11.855Z | «продолжи» отправлен, флаг в pending до первого успешного ответа
[2026-09-27T14:30:30Z] arms_after_R3: {"C:\\Users\\r.edokov\\.pi\\agent\\sessions\\--c--Tools--\\2026-09-27T13-57-14-949Z_01a0e327-da45-74d2-bffc-cacd20bd4e66.jsonl": {"armedAt": 1790517539964, "lastResetAtAtArm": 1790516097644, "expiresAt": 1790546339964, "repeat": 1}, "C:\\Tools\\pi-billing-window\\.ai\\sdd\\specs\\004-live-scenario-testing\\sessions\\2026-09-27T14-18-09-478Z_live-A2.jsonl": {"armedAt": 1790518701193, "lastResetAtAtArm": 1790518415356, "expiresAt": 1790547501193, "repeat": 3, "phase": "pending", "lastFireAt": 1790519351834}}
[2026-09-27T14:30:30Z] flag_absent_after_R3: False
[2026-09-27T14:30:30Z] --- extra reset #4 (control, no fire expected) ---: 
[2026-09-27T14:30:30Z] cmd_settimer0_4: {"type": "response", "command": "prompt", "success": true}
[2026-09-27T14:33:00Z] fourth_fire_check: {'send_ok_before4': 2, 'send_ok_after4': 2, 'confirmed_total': 0}
[2026-09-27T14:33:00Z] negative_events: none
[2026-09-27T14:33:00Z] delta_counts: {'fire:reset-ready': 4, 'fire:send-ok': 2, 'fire:confirmed': 0}
[2026-09-27T14:33:00Z] checks: {"arm-seen repeat=3": true, "arms repeat==3 after arm": true, "R1 repeat 3->2": false, "R1 phase armed": false, "R1 lastResetAtAtArm align": false, "R2 repeat 2->1": false, "R3 flag absent": false, "fire:confirmed==3 total": false, "no 4th send-ok": false, "no negatives": true}
```

## Verdict: FAIL
