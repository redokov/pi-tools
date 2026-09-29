# Spec 008: tasks

## T1: piApi/eventBus re-capture в /cont-after-reset handler
- [x] Хелпер `adoptFreshRefs(ctx, source)` — re-capture piApi/eventBus из свежего
  ctx + `piApiEpoch = sessionEpoch` + сброс staleAttempts/staleRetryNotBefore + лог
  `replacement:adopted`. session-start сохранил собственный inline re-capture
  (sessionBusOf(event, ctx) — event может нести ссылки; команде event не передаётся).
- [x] Вызов в handler'е `cont-after-reset` после `armsSwitchKey(key)`.
- [x] Тест: мёртвый piApi → /cont-after-reset → piApi свежий → fire доставляет
  (replacement.test.mts, testContAfterResetAdoptsFreshRefs, 6 asserts).

## T2: blocked-гейт по epoch
- [x] В blocked-условии добавить `piApiEpoch === sessionEpoch`.
- [x] Тест: другой ключ + живой probe + piApiEpoch !== sessionEpoch → смена
  проходит (не blocked), ключ переезжает (session-isolation.test.mts,
  testEpochMismatchLetsShiftThrough, 4 asserts).

## T3: arm lifecycle после confirmed
- [x] Auto-re-arm уже реализован в arms.confirmSuccess (repeat>1 → перевзведение
  с repeat-1, fresh TTL/lastResetAtAtArm); документирован в README (8a:
  «когда взводить заново» + repeat-режим).
- [x] Тесты: arms.test.mts (repeat>1: 2→1→удаление) + lifecycle.test.mts
  (repeat-e2e: repeat=3 → fire → confirmed → repeat=2 → fire → …) — уже были.

## T4: верификация и деплой
- [x] Все 14 сьютов exit 0, tsc --noEmit чистый.
- [x] deploy.ps1, diff src↔extensions идентичен.
- [x] Коммит + пуш (spec 008) — после живого вердикта.
- [x] Живой вердикт: обе сессии взведены `/cont-after-reset 3`, сброс
  2026-09-29T15:37:32Z — обе fire:send-ok → fire:confirmed в log.

## Примечание к реализации (2026-09-29)

- Также подключён к runner'у осиротевший тест spec 007
  (testStaleOwnerCtxLetsShiftThrough, живой цикл fire:send-reverify) — его
  последний ассерт был RED-остатком («запись arms.json переехала под новый
  ключ»); правильное поведение (repoint НЕ переносит запись, флаг остаётся у
  своего разговора) зафиксировано в ассерте.
- Итоговые счётчики: replacement 22 PASS (было 16), session-isolation 36 PASS
  (было 26).

## Живой вердикт T4 (2026-09-29, закрывающий)

- Отложенный агент «spec008-verdict» (EpgCjkpuWb) не отработал — вычищен до
  срабатывания; вердикт выполнен вручную по log/arms.json.
- Сброс 2026-09-29T15:37:32.705Z, оба окна:
  - c:/Tools pid 27932 key=14-29-29-644Z: fire:send-reverify → fire:send-ok
    (15:38:35Z) → fire:confirmed (15:38:50Z). Полный цикл.
  - TabDocLoad pid 29644 key=10-34-06-756Z: fire:send-reverify → fire:send-ok
    (15:46:11Z) → fire:confirmed (15:46:41Z); повторный полный цикл 15:53:11Z →
    15:53:26Z. T3 re-arm 3→2 подтверждён живьём (arm-seen repeat=2 phase=armed
    сразу после confirmed).
- send-error:stale НЕ фейлит: stale-цепочки (попытки 1/6–3/6) у обоих ключей
  разрешались в send-ok+confirmed; capitulation:after-6 в log только ДО сброса
  (14:59:41Z pid 29644, снятый флаг был перевзведён через /cont-after-reset —
  доставка восстановилась, T1 подтверждена живьём).
- arms.json: старые ключи потреблены (обе сессии заменены /new), lifecycle
  здоров — новые сессии c:/Tools 16-08-51-983Z (repeat=2 phase=armed) и MyTasks
  15-50-39-465Z (repeat=6 phase=armed) в armed.
- Вердикт: PASS → коммит + пуш origin master.
