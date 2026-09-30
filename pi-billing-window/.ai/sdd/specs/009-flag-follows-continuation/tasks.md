# Spec 009: tasks

## T1: F1 — гейт блокирует только shift, не refs re-capture
- [ ] В ownerBlocked early-return пути (src/index.ts, onSessionStart) добавить:
  inline re-capture refs из event/ctx (adoptFreshRefs-эквивалент, без смены
  ownerKey/currentKey) + ensureTickerStarted + ensureSyncPoller.
- [ ] Тест: fork-цепочка (session_start child с другим ключом, живой probe) →
  ownerBlocked → refs свежие → fire доставляет; флаг остаётся у владельца
  (replacement.test.mts).

## T2: F2 — fire-путь доставляет в разговор владельца
- [ ] В fireContinue: при refs' session ≠ ownerKey — piApi.switchSession(ownerKey)
  → перечитать piApi (старая p инвалидирована switchSession) → sendUserMessage.
- [ ] session_start владельца от switchSession отрабатывает полностью (incoming
  === ownerKey → не blocked) — refs переснимаются fresh для владельца.
- [ ] Тест: refs stale/mis-target + живой owner → доставка в jsonl владельца
  (switchSession-путь); без ложного misroute (session-isolation.test.mts).

## T3: F3 — верификация после switchSession-доставки
- [ ] verifyDelivered по ключу владельца: запись в jsonl → send-ok → confirmed
  → re-arm (repeat-1). Тест: полный цикл fire → confirmed через
  switchSession-путь (lifecycle.test.mts).
- [ ] pendingFiredResetAt: ограничить дубль от redraw при in-flight доставке
  (max 1 повторный send на reset).

## T4: верификация и деплой
- [ ] 14 сьютов exit 0 (replacement 22+, session-isolation 36+, exit-hygiene 18),
  tsc --noEmit чистый.
- [ ] deploy.ps1, diff src↔extensions идентичен.
- [ ] Живой вердикт: окно агента с fork-активностью между сбросами → сброс →
  fire:send-ok → fire:confirmed БЕЗ ручного /cont-after-reset (ночной сценарий).
