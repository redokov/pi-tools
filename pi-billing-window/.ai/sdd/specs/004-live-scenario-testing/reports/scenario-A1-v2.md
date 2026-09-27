# Scenario A1 (v2, spec 005 live) - одноразовая доставка

- Дата (UTC): 2026-09-27T18:09:13Z
- Модель: wormsoft/zai/glm-5.3-flash, провайдер: wormsoft
- session-id: live-T3-1
- session-file (ключ флага): C:\Tools\pi-billing-window\.ai\sdd\specs\004-live-scenario-testing\sessions\2026-09-27T18-01-49-503Z_live-T3-1.jsonl
- session-start: 2026-09-27T18:07:48.720Z | reason=startup key=2026-09-27T18-01-49-503Z_live-T3-1.jsonl armed=false
- Глобальные счётчики ДО: {"fire:reset-ready": 155, "fire:send-ok": 19, "fire:confirmed": 5, "session-start": 63}
- Глобальные счётчики ПОСЛЕ: {"fire:reset-ready": 157, "fire:send-ok": 20, "fire:confirmed": 6, "session-start": 64}
- arms.json до взвода: {"C:\\Users\\r.edokov\\.pi\\agent\\sessions\\--c--Tools--\\2026-09-27T13-57-14-949Z_01a0e327-da45-74d2-bffc-cacd20bd4e66.jsonl": {"armedAt": 1790531673368, "lastResetAtAtArm": 1790530473047, "expiresAt": 1790560473368, "repeat": 1}, "C:\\Users\\r.edokov\\.pi\\agent\\sessions\\--c--MyProjects-TabDocLoad--\\2026-09-27T17-27-11-381Z_01a0e3e8-0f14-727c-8553-0125dd2d68f8.jsonl": {"armedAt": 1790531684307, "lastResetAtAtArm": 1790530473047, "expiresAt": 1790560484307, "repeat": 10}}
- state до: {"windowStartedAt": 1790532123481, "lastResetAt": 1790532123481, "resetCount": 410, "callsInWindow": 23}

## Замечание об атрибуции fire:reset-ready

`fire:reset-ready` пишет КАЖДЫЙ extension-хост, увидевший сброс окна (в т.ч. посторонние флаги TabDocLoad/01a0e327/оркестратор), поэтому в общем arms.log в дельте может быть >1 строки на один сброс. Ключевая атрибуция идёт по arms.json моего ключа: send-ok=1 и confirmed=1. Строка fire:reset-ready без следующего send-ok в дельте - посторонняя цепочка (НЕ FAIL по правилам прогона).

## Timeline delta (со строки 293)

```
2026-09-27T18:07:48.720Z | session-start | reason=startup key=2026-09-27T18-01-49-503Z_live-T3-1.jsonl armed=false
2026-09-27T18:07:57.551Z | arm-seen | repeat=1 phase=armed key=2026-09-27T18-01-49-503Z_live-T3-1.jsonl
2026-09-27T18:08:59.850Z | fire:reset-ready | watchdog: сброс окна 2026-09-27T18:07:59.845Z, отправляю «продолжи» через 0 с
2026-09-27T18:08:59.863Z | fire:reset-ready | watchdog: сброс окна 2026-09-27T18:07:59.845Z, отправляю «продолжи» через 0 с
2026-09-27T18:08:59.903Z | fire:send-ok | «продолжи» отправлен, флаг в pending до первого успешного ответа
2026-09-27T18:09:07.146Z | fire:confirmed | успешный ответ после «продолжи» — флаг снят/перевзведён
2026-09-27T18:09:07.146Z | arm-gone | флаг исчез/истёк (sync-poller продолжает жить)
```

## Evidence

```
[2026-09-27T18:07:57Z] session_start: 2026-09-27T18:07:48.720Z | reason=startup key=2026-09-27T18-01-49-503Z_live-T3-1.jsonl armed=false
[2026-09-27T18:07:57Z] session_file: C:\Tools\pi-billing-window\.ai\sdd\specs\004-live-scenario-testing\sessions\2026-09-27T18-01-49-503Z_live-T3-1.jsonl
[2026-09-27T18:07:57Z] arms_before_arm: {"C:\\Users\\r.edokov\\.pi\\agent\\sessions\\--c--Tools--\\2026-09-27T13-57-14-949Z_01a0e327-da45-74d2-bffc-cacd20bd4e66.jsonl": {"armedAt": 1790531673368, "lastResetAtAtArm": 1790530473047, "expiresAt": 1790560473368, "repeat": 1}, "C:\\Users\\r.edokov\\.pi\\agent\\sessions\\--c--MyProjects-TabDocLoad--\\2026-09-27T17-27-11-381Z_01a0e3e8-0f14-727c-8553-0125dd2d68f8.jsonl": {"armedAt": 1790531684307, "lastResetAtAtArm": 1790530473047, "expiresAt": 1790560484307, "repeat": 10}}
[2026-09-27T18:07:57Z] cmd_cont: {"type": "response", "command": "prompt", "success": true}
[2026-09-27T18:07:57Z] arm_seen: 2026-09-27T18:07:57.551Z | repeat=1 phase=armed key=2026-09-27T18-01-49-503Z_live-T3-1.jsonl
[2026-09-27T18:07:59Z] arms_after_arm: {"C:\\Users\\r.edokov\\.pi\\agent\\sessions\\--c--Tools--\\2026-09-27T13-57-14-949Z_01a0e327-da45-74d2-bffc-cacd20bd4e66.jsonl": {"armedAt": 1790531673368, "lastResetAtAtArm": 1790530473047, "expiresAt": 1790560473368, "repeat": 1}, "C:\\Users\\r.edokov\\.pi\\agent\\sessions\\--c--MyProjects-TabDocLoad--\\2026-09-27T17-27-11-381Z_01a0e3e8-0f14-727c-8553-0125dd2d68f8.jsonl": {"armedAt": 1790531684307, "lastResetAtAtArm": 1790530473047, "expiresAt": 1790560484307, "repeat": 10}, "C:\\Tools\\pi-billing-window\\.ai\\sdd\\specs\\004-live-scenario-testing\\sessions\\2026-09-27T18-01-49-503Z_live-T3-1.jsonl": {"armedAt": 1790532477546, "lastResetAtAtArm": 1790532123481, "expiresAt": 1790561277546, "repeat": 1}}
[2026-09-27T18:08:00Z] cmd_settimer0: {"type": "response", "command": "prompt", "success": true}
[2026-09-27T18:09:00Z] fire_reset_ready: 2026-09-27T18:08:59.850Z | watchdog: сброс окна 2026-09-27T18:07:59.845Z, отправляю «продолжи» через 0 с
[2026-09-27T18:09:00Z] fire_send_ok: 2026-09-27T18:08:59.903Z | «продолжи» отправлен, флаг в pending до первого успешного ответа
[2026-09-27T18:09:08Z] fire_confirmed: 2026-09-27T18:09:07.146Z | успешный ответ после «продолжи» — флаг снят/перевзведён
[2026-09-27T18:09:08Z] durations_s: {'cont_to_rr': 62.0, 'rr_to_so': 0.0, 'so_to_cf': 8.0}
[2026-09-27T18:09:11Z] arms_after_confirm: {"C:\\Users\\r.edokov\\.pi\\agent\\sessions\\--c--Tools--\\2026-09-27T13-57-14-949Z_01a0e327-da45-74d2-bffc-cacd20bd4e66.jsonl": {"armedAt": 1790531673368, "lastResetAtAtArm": 1790530473047, "expiresAt": 1790560473368, "repeat": 1}, "C:\\Users\\r.edokov\\.pi\\agent\\sessions\\--c--MyProjects-TabDocLoad--\\2026-09-27T17-27-11-381Z_01a0e3e8-0f14-727c-8553-0125dd2d68f8.jsonl": {"armedAt": 1790531684307, "lastResetAtAtArm": 1790530473047, "expiresAt": 1790560484307, "repeat": 10}}
[2026-09-27T18:09:11Z] negative_events: none
[2026-09-27T18:09:11Z] delta_counts: {'fire:reset-ready': 2, 'fire:send-ok': 1, 'fire:confirmed': 1}
[2026-09-27T18:09:11Z] checks: {"arm-seen with key": true, "fire:reset-ready seen (my chain)": true, "fire:send-ok==1": true, "fire:confirmed==1": true, "flag removed after confirm": true, "no negatives": true}
```

## «продолжи» и ответ агента в session-файле

```
строк с 'продолжи' в session: 5
{"type":"message","id":"3e626f8a","parentId":"da5bc8d5","timestamp":"2026-09-27T18:03:03.508Z","message":{"role":"user","content":[{"type":"text","text":"продолжи"}],"timestamp":1790532183500}}
{"type":"custom","customType":"run-timer-state","data":{"currentRunStartMs":1790532183503,"currentRunPrompt":"продолжи"},"id":"d18cbc2c","parentId":"c272847f","timestamp":"2026-09-27T18:03:16.830Z"}
{"type":"message","id":"e8f5a953","parentId":"d18cbc2c","timestamp":"2026-09-27T18:08:59.866Z","message":{"role":"user","content":[{"type":"text","text":"продолжи"}],"timestamp":1790532539860}}
{"type":"message","id":"4ad12db5","parentId":"e8f5a953","timestamp":"2026-09-27T18:09:07.279Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Need to figure out what \"продолжи\" means — continue prior work. Look at stage0-facts.md and run logs to understand state.","thinkingSignature":"reasoning_content"},{"type":"toolCall","id":"call_2e93277d8cab413eb4aaa739","name":"bash","arguments":{"command":"head -60 stage0-facts.md; echo ---; cat A1-driver.log; echo ---; head -30 scenario-A1.md"}}],"api":"openai-completions","provider":"wormsoft","model":"zai/glm-5.3-flash","usage":{"input":27,"output":69,"cacheRead":24000,"cacheWrite":0,"reasoning":0,"totalTokens":24096,"cost":{"input":21.6,"output":193.2,"cacheRead":7200,"cacheWrite":0,"total":7414.8}},"stopReason":"toolUse","timestamp":1790532539884,"responseId":"chatcmpl-1d836573-c31f-4ba6-8136-bc2f3ab58e7e","rawStopReason":"tool_calls"}}
{"type":"custom","customType":"run-timer-state","data":{"currentRunStartMs":1790532539865,"currentRunPrompt":"продолжи"},"id":"c929b238","parentId":"1484f4cb","timestamp":"2026-09-27T18:09:13.207Z"}
```

## Вердикт: PASS
