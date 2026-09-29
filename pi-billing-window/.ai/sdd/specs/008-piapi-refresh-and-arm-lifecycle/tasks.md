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
- [ ] Коммит + пуш (spec 008) — ПОСЛЕ живого вердикта (не коммитить до живого
  вердикта, кроме spec-файлов).
- [ ] Живой вердикт: обе сессии взведены `/cont-after-reset 3`, следующий
  сброс — обе fire:send-ok → fire:confirmed в log.

## Примечание к реализации (2026-09-29)

- Также подключён к runner'у осиротевший тест spec 007
  (testStaleOwnerCtxLetsShiftThrough, живой цикл fire:send-reverify) — его
  последний ассерт был RED-остатком («запись arms.json переехала под новый
  ключ»); правильное поведение (repoint НЕ переносит запись, флаг остаётся у
  своего разговора) зафиксировано в ассерте.
- Итоговые счётчики: replacement 22 PASS (было 16), session-isolation 36 PASS
  (было 26).
