# Scenario A4 - TTL: истёкший expiresAt -> arm-gone, никаких fire

- Дата (UTC): 2026-09-28T09:37:19Z
- session-id: live-T3-4
- session-file (ключ): C:\Tools\pi-billing-window\.ai\sdd\specs\004-live-scenario-testing\sessions\2026-09-28T09-32-11-114Z_live-T3-4.jsonl
- Запись истёкшего arm: expired_arm.py (одна атомарная операция tmp+rename; схема сохраняется, изменено только значение expiresAt=now-1000)
- Сброс: /settimer 0 из самой сессии (после того как флаг уже gone)

## Timeline delta (со строки 373)

```
2026-09-28T09:32:13.343Z | session-start | reason=startup key=2026-09-28T09-32-11-114Z_live-T3-4.jsonl armed=false pid=34152 host=DESKTOP-3PDA7V4 ep=0
2026-09-28T09:33:13.355Z | arm-seen | repeat=1 phase=armed key=2026-09-28T09-32-11-114Z_live-T3-4.jsonl pid=34152 host=DESKTOP-3PDA7V4 ep=0
2026-09-28T09:33:13.374Z | fire:reset-ready | watchdog: сброс окна 2026-09-28T09:03:23.826Z, отправляю «продолжи» через 0 с key=2026-09-28T09-32-11-114Z_live-T3-4.jsonl pid=34152 host=DESKTOP-3PDA7V4 ep=0
2026-09-28T09:33:13.438Z | fire:send-ok | «продолжи» отправлен, флаг в pending до первого успешного ответа key=2026-09-28T09-32-11-114Z_live-T3-4.jsonl pid=34152 host=DESKTOP-3PDA7V4 ep=0
2026-09-28T09:34:13.362Z | arm-gone | флаг исчез/истёк (sync-poller продолжает жить) key=2026-09-28T09-32-11-114Z_live-T3-4.jsonl pid=34152 host=DESKTOP-3PDA7V4 ep=0
```

## Evidence

```
[2026-09-28T09:32:22Z] session_start: 2026-09-28T09:32:13.343Z | reason=startup key=2026-09-28T09-32-11-114Z_live-T3-4.jsonl armed=false pid=34152 host=DESKTOP-3PDA7V4 ep=0
[2026-09-28T09:32:22Z] session_file: C:\Tools\pi-billing-window\.ai\sdd\specs\004-live-scenario-testing\sessions\2026-09-28T09-32-11-114Z_live-T3-4.jsonl
[2026-09-28T09:32:22Z] valid_arm_rc: 0
[2026-09-28T09:32:22Z] valid_arm_out: ARM key=C:\Tools\pi-billing-window\.ai\sdd\specs\004-live-scenario-testing\sessions\2026-09-28T09-32-11-114Z_live-T3-4.jsonl
  armedAt=2026-09-28T09:32:22Z expiresAt=2026-09-28T17:32:22Z (TTL 8h) repeat=1
  lastResetAtAtArm=0 phase=armed
  record=created; 1 other record(s) untouched; 0 expired prune | 
[2026-09-28T09:33:14Z] arm_seen_valid: 2026-09-28T09:33:13.355Z | repeat=1 phase=armed key=2026-09-28T09-32-11-114Z_live-T3-4.jsonl pid=34152 host=DESKTOP-3PDA7V4 ep=0
[2026-09-28T09:33:16Z] rec_valid: {"armedAt": 1790587942865, "expiresAt": 1790616742865, "repeat": 1, "lastResetAtAtArm": 0, "phase": "pending", "lastFireAt": 1790587993386}
[2026-09-28T09:33:16Z] expired_arm_rc: 0
[2026-09-28T09:33:16Z] expired_arm_out: EXPIRED_ARM key=C:\Tools\pi-billing-window\.ai\sdd\specs\004-live-scenario-testing\sessions\2026-09-28T09-32-11-114Z_live-T3-4.jsonl
  expiresAt=1790587995949 (now-1000) -> already expired at write
  records=2 total, others untouched | 
[2026-09-28T09:33:18Z] rec_after_expired: {"armedAt": 1790587996949, "lastResetAtAtArm": 0, "expiresAt": 1790587995949, "phase": "armed", "repeat": 1}
[2026-09-28T09:34:14Z] arm_gone: 2026-09-28T09:34:13.362Z | флаг исчез/истёк (sync-poller продолжает жить) key=2026-09-28T09-32-11-114Z_live-T3-4.jsonl pid=34152 host=DESKTOP-3PDA7V4 ep=0
[2026-09-28T09:34:16Z] rec_after_gone: {"armedAt": 1790587996949, "lastResetAtAtArm": 0, "expiresAt": 1790587995949, "phase": "armed", "repeat": 1}
[2026-09-28T09:34:17Z] cmd_settimer0: {"type": "response", "command": "prompt", "success": true}
[2026-09-28T09:34:17Z] lastResetAt: 1790588056985
[2026-09-28T09:37:17Z] fire_lines_in_delta: [('2026-09-28T09:33:13.374Z', 'fire:reset-ready', 'watchdog: сброс окна 2026-09-28T09:03:23.826Z, отправляю «продолжи» через 0 с key=2026-09-28T09-32-11-114Z_live-T3-4.jsonl pid=34152 host=DESKTOP-3PDA7V4 ep=0'), ('2026-09-28T09:33:13.438Z', 'fire:send-ok', '«продолжи» отправлен, флаг в pending до первого успешного ответа key=2026-09-28T09-32-11-114Z_live-T3-4.jsonl pid=34152 host=DESKTOP-3PDA7V4 ep=0')]
[2026-09-28T09:37:17Z] my_key_fired: False
[2026-09-28T09:37:17Z] arm_seen_cnt: 1
[2026-09-28T09:37:17Z] negative_events: none
[2026-09-28T09:37:17Z] checks: {"valid arm seen (arm-seen)": true, "arm-gone after expired rewrite": true, "my key not pending / no lastFireAt": true, "no fire:send-ok attributed": true, "no negatives": true}
```

## Вердикт: PASS
