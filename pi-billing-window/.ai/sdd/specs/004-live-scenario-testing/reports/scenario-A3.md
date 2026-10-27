# Scenario A3 - внешний взвод headless-сессии + доставка

- Дата (UTC): 2026-09-28T09:09:30Z
- session-id (headless): live-T3-3  |  driver: live-T3-3-drv
- session-file (ключ): C:\Tools\pi-billing-window\.ai\sdd\specs\004-live-scenario-testing\sessions\2026-09-28T09-01-06-028Z_live-T3-3.jsonl
- метод взвода: scripts/arm_cont_after_reset.py --repeat 1 (внешняя запись arms.json)
- метод сброса: /settimer 0 из отдельной RPC-сессии-driver
- DEVIATION: головая сессия = pi --mode rpc вместо pi --print (цикл heartbeat надёжно держит процесс)

## Timeline delta (со строки 364)

```
2026-09-28T09:01:08.946Z | session-start | reason=startup key=2026-09-28T09-01-06-028Z_live-T3-3.jsonl armed=false pid=23400 host=DESKTOP-3PDA7V4 ep=0
2026-09-28T09:03:00.806Z | session-start | reason=startup key=2026-09-28T09-03-00-801Z_01a0e740-d4c1-72b7-a664-633e774310d8.jsonl armed=false
2026-09-28T09:03:08.954Z | arm-seen | repeat=1 phase=armed key=2026-09-28T09-01-06-028Z_live-T3-3.jsonl pid=23400 host=DESKTOP-3PDA7V4 ep=0
2026-09-28T09:03:08.974Z | fire:reset-ready | watchdog: сброс окна 2026-09-28T07:36:41.063Z, отправляю «продолжи» через 0 с key=2026-09-28T09-01-06-028Z_live-T3-3.jsonl pid=23400 host=DESKTOP-3PDA7V4 ep=0
2026-09-28T09:03:09.005Z | fire:send-ok | «продолжи» отправлен, флаг в pending до первого успешного ответа key=2026-09-28T09-01-06-028Z_live-T3-3.jsonl pid=23400 host=DESKTOP-3PDA7V4 ep=0
2026-09-28T09:03:14.563Z | session-start | reason=startup key=2026-09-28T09-03-12-107Z_live-T3-3-drv.jsonl armed=false pid=10020 host=DESKTOP-3PDA7V4 ep=0
2026-09-28T09:03:16.072Z | fire:confirmed | успешный ответ после «продолжи» — флаг снят/перевзведён key=2026-09-28T09-01-06-028Z_live-T3-3.jsonl pid=23400 host=DESKTOP-3PDA7V4 ep=0
2026-09-28T09:03:16.073Z | arm-gone | флаг исчез/истёк (sync-poller продолжает жить) key=2026-09-28T09-01-06-028Z_live-T3-3.jsonl pid=23400 host=DESKTOP-3PDA7V4 ep=0
```

## Evidence

```
[2026-09-28T09:01:17Z] session_start: 2026-09-28T09:01:08.946Z | reason=startup key=2026-09-28T09-01-06-028Z_live-T3-3.jsonl armed=false pid=23400 host=DESKTOP-3PDA7V4 ep=0
[2026-09-28T09:01:17Z] session_file: C:\Tools\pi-billing-window\.ai\sdd\specs\004-live-scenario-testing\sessions\2026-09-28T09-01-06-028Z_live-T3-3.jsonl
[2026-09-28T09:01:17Z] heartbeat_file: C:\Tools\pi-billing-window\.ai\sdd\specs\004-live-scenario-testing\sessions\A3-heartbeat.txt
[2026-09-28T09:01:17Z] heartbeat_task_started: fire-and-forget
[2026-09-28T09:02:17Z] beats_before_arm: 0
[2026-09-28T09:02:17Z] WARN: no heartbeat yet -- continue anyway
[2026-09-28T09:02:17Z] external_arm_rc: 0
[2026-09-28T09:02:17Z] external_arm_out: ARM key=C:\Tools\pi-billing-window\.ai\sdd\specs\004-live-scenario-testing\sessions\2026-09-28T09-01-06-028Z_live-T3-3.jsonl
  armedAt=2026-09-28T09:02:17Z expiresAt=2026-09-28T17:02:17Z (TTL 8h) repeat=1
  lastResetAtAtArm=0 phase=armed
  record=created; 1 other record(s) untouched; 1 expired pruned
  file=C:\Users\r.edokov\.pi\agent\pi-billing-window-arms.json | 
[2026-09-28T09:03:09Z] arm_seen: 2026-09-28T09:03:08.954Z | repeat=1 phase=armed key=2026-09-28T09-01-06-028Z_live-T3-3.jsonl pid=23400 host=DESKTOP-3PDA7V4 ep=0
[2026-09-28T09:03:09Z] arm_seen_sec: 52.0
[2026-09-28T09:03:11Z] arms_after_external_arm: {"C:\\Users\\r.edokov\\.pi\\agent\\sessions\\--c--Tools--\\2026-09-27T19-42-16-470Z_01a0e463-bb95-72b7-a664-631adedab83b.jsonl": {"armedAt": 1790573023356, "lastResetAtAtArm": 1790566528148, "expiresAt": 1790601823356, "repeat": 1}, "C:\\Tools\\pi-billing-window\\.ai\\sdd\\specs\\004-live-scenario-testing\\sessions\\2026-09-28T09-01-06-028Z_live-T3-3.jsonl": {"armedAt": 1790586137781, "expiresAt": 1790614937781, "repeat": 1, "lastResetAtAtArm": 0, "phase": "pending", "lastFireAt": 1790586188987}}
[2026-09-28T09:03:11Z] my_rec_external: {"armedAt": 1790586137781, "expiresAt": 1790614937781, "repeat": 1, "lastResetAtAtArm": 0, "phase": "pending", "lastFireAt": 1790586188987}
[2026-09-28T09:03:24Z] drive_cmd_settimer0: {"type": "response", "command": "prompt", "success": true}
[2026-09-28T09:03:24Z] lastResetAt_after_drive: 1790586203826
[2026-09-28T09:09:24Z] send_ok_pending: MISSING
[2026-09-28T09:09:24Z] flag_removed_after_confirm: True
[2026-09-28T09:09:24Z] fire_confirmed_lines: [('2026-09-28T09:03:16.072Z', 'fire:confirmed', 'успешный ответ после «продолжи» — флаг снят/перевзведён key=2026-09-28T09-01-06-028Z_live-T3-3.jsonl pid=23400 host=DESKTOP-3PDA7V4 ep=0')]
[2026-09-28T09:09:24Z] so_to_flag_removed_s: 0.0
[2026-09-28T09:09:26Z] heartbeat_tail: ['beat 2026-09-28T09:02:16Z', 'beat 2026-09-28T09:02:56Z', 'RESUMED 2026-09-28T09:03:16Z', 'beat 2026-09-28T09:03:36Z', 'beat 2026-09-28T09:04:16Z', 'beat 2026-09-28T09:04:56Z', 'beat 2026-09-28T09:05:36Z', 'beat 2026-09-28T09:06:16Z', 'beat 2026-09-28T09:06:56Z', 'beat 2026-09-28T09:07:36Z', 'beat 2026-09-28T09:08:16Z', 'beat 2026-09-28T09:08:56Z']
[2026-09-28T09:09:26Z] resumed_lines: ['RESUMED 2026-09-28T09:03:16Z']
[2026-09-28T09:09:26Z] negative_events: none
[2026-09-28T09:09:26Z] checks: {"external arm accepted (key)": true, "arm-seen <=60s": false, "send-ok (phase pending)": false, "flag removed (confirmed)": true, "RESUMED in heartbeat": true, "no negatives": true}
```

## Вердикт: FAIL
