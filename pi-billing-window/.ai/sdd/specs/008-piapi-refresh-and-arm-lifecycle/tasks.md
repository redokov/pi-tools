# Spec 008: tasks

## T1: piApi/eventBus re-capture в /cont-after-reset handler
- [ ] Хелпер `adoptFreshRefs(ctx)` (или расширение sessionBusOf) — re-capture
  piApi/eventBus из свежего ctx + `piApiEpoch = sessionEpoch` + сброс
  staleAttempts/staleRetryNotBefore + лог `replacement:adopted`.
- [ ] Вызов в handler'е `cont-after-reset` после `armsSwitchKey(key)`.
- [ ] Тест: мёртвый piApi → /cont-after-reset → piApi свежий → fire
  доставляет (mock-pi).

## T2: blocked-гейт по epoch
- [ ] В blocked-условии добавить `piApiEpoch === sessionEpoch`.
- [ ] Тест: другой ключ + живой probe + piApiEpoch !== sessionEpoch → смена
  проходит (не blocked), ключ/arms.json переезжают.

## T3: arm lifecycle после confirmed
- [ ] Решить auto-re-arm vs /cont-after-reset N (минимум: repeat>1 →
  confirmed → перевзведение с repeat-1).
- [ ] README: когда нужно взводить заново.
- [ ] Тест: repeat=2 → fire → confirmed → флаг перевзведён (repeat=1).

## T4: верификация и деплой
- [ ] Все 14 сьютов exit 0, tsc --noEmit чистый.
- [ ] deploy.ps1, diff src↔extensions идентичен.
- [ ] Коммит + пуш (spec 008).
- [ ] Живой вердикт: обе сессии взведены `/cont-after-reset 3`, следующий
  сброс — обе fire:send-ok → fire:confirmed в log.
