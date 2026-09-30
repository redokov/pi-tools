# Spec 009: флаг едет за живым продолжением агента + самопрочинка refs при fork/replace

## Проблема (ночь 2026-09-29/30, evidence)

Ночной агент (MyTasks, окно pid 20084) не получает «продолжи» после сбросов,
если между сбросами окно агента выполняло fork/new/switchSession (сабагенты,
автопродолжения). 3 полных цикла отказа:

- Сброс 21:37:47Z #457: fire по ключу 20-15-55-420Z → send-error:stale 1/6
  (21:38:47) → 2/6 → 3/6; fork-цепочки 20:46/22:05/22:49/22:51 (owner-shift(blocked)).
- 22:58–23:06: refs на время «ожили» → fire прошёл → misroute 1/6, 2/6
  (записи «продолжи» нет в jsonl владельца — сообщение ушло в чужую сессию).
- Сброс 23:37:47Z #458: fire → stale-цепочка 4/6 (23:52) → 5/6 (00:32) →
  6/6 + **capitulation:after-6 01:32:01Z — флаг снят**.
- Сбросы 21:37 / 23:37 / 01:37 прошли без автопродолжения; агент ожил только от
  ручного «продолжи» (~03:52Z, firstCallEmittedAt после сброса 03:37).
- Флаг был взведён под ПРАВИЛЬНЫЙ ключ (живой разговор 20-15-55-420Z) — убила
  не привязка, а stale ctx расширения.

Инцидент 2026-09-29 19:39:54Z (тот же класс): «продолжи» для сброса #456 ушло в
сессию 19-27-22-379Z (fork/continuation), верификация по jsonl владельца
18-51-49-138Z дала ложный misroute — доставка фактически дошла до живого
разговора, но верификация читала старый ключ.

## Root cause (C1–C4)

- **C1**: любой ctx.fork()/newSession()/switchSession() инвалидирует
  захваченный pi/ctx расширения (правило pi) — refs становятся stale, даже если
  разговор «вернулся» к владельцу. Сабагент-активность агента между сбросами
  убивает refs.
- **C2**: session_start для fork/child сессий попадает в ownerBlocked-гейт
  (spec 006/008) → ранний return → **inline re-capture пропущен** → stale refs
  персистят до ручного вмешательства. probePiAlive() зондирует ТОЛЬКО module
  refs (piApi) — не различает «owner жив» от «refs живы, owner заменён»
  (C2-иллюзия spec 008).
- **C3**: порядок session_shutdown/session_start не гарантирован; когда
  shutdown не предшествует старту, sessionEpoch не инкрементируется →
  piApiEpoch === sessionEpoch при stale refs → adoptFreshRefs (T1 spec 008)
  даёт **no-op** — /cont-after-reset не лечит этот режим.
- **C4**: ownerBlocked блокирует не только shift, но и самопрочинку: refs
  stale/mis-target → каждый fire: stale → misroute → цепочка → капитуляция →
  флаг снят → ночной агент простаивает до ручного «продолжи».

## Дизайн-решения

### F1: гейт блокирует только shift, НЕ refs re-capture

В ownerBlocked early-return пути всё равно выполнять inline re-capture
(adoptFreshRefs-эквивалент из event/ctx) + ensureTickerStarted +
ensureSyncPoller. Инвариант spec 006 сохраняется: флаг не крадётся (ownerKey/
currentKey не меняются), но refs оживают после каждой fork/replace-цепочки.

Следствие: refs после re-capture указывают на child-сессию (event несёт ctx
child'а) → доставка уйдёт в child → верификация по ключу владельца даст ложный
misroute. Поэтому F1 обязателен только В ПАРЕ с F2.

### F2: fire-путь доставляет в разговор владельца независимо от refs' session

При fire, если refs' session ≠ ownerKey: `piApi.switchSession(ownerKey)` →
switchSession поднимает session_start для разговора владельца (incoming ===
ownerKey → НЕ blocked → полный старт → refs переснимаются fresh для владельца,
currentCtx = owner ctx) → затем p = piApi (перечитать ПОСЛЕ switch, старая p
инвалидирована) → sendUserMessage → доставка в владельца. Верификация по ключу
владельца → запись есть → send-ok → confirmed.

Альтернативы (отвергнуты):
- флаг едет за refs' session (carry на child): «продолжи» попадает в разговор
  сабагента — чужой агент, задача владельца не возобновляется (инцидент
  19:39:54Z показал, что сабагент отрабатывает «продолжи» вхолостую).
- флаг едет за freshest jsonl в проекте: сабагент-сессии могут быть свежее
  живого владельца — дискриминатор ненадёжен.

Открытые вопросы:
- switchSession меняет активную сессию ОКНА — если пользователь работает в
  другом разговоре окна, UI перескочит. Оценка: для ночного агента приемлемо;
  для интерактивного окна — риск, требует verifyDelivered-обратной связи
  (spec 007) и, возможно, switch-back после доставки.
- гонка fire ↔ session_start от switchSession: runGuarded
  watchdogEvalInFlight-гвард сериализует; redraw-логика handler'а (D-603) может
  дать 1 дубль — допустимо, ограничить pendingFiredResetAt.

### F3: верификация после switchSession-доставки

verifyDelivered (spec 007, 3 чтения jsonl владельца) остаётся гейтом: после
switchSession-доставки запись появляется в jsonl владельца → send-ok →
confirmed. Ложный misroute (реверификация сняла) — прежнее поведение.

## Инварианты (не ломать)

- spec 006: foreign child session-start не крадёт флаг владельца (ownerKey/
  currentKey не меняются в blocked-пути — F1 сохраняет).
- spec 007: реверификация 3 чтения jsonl, confirm gating, early pacing.
- spec 008: T1 adoptFreshRefs(ctx) в /cont-after-reset; T2 blocked-гейт
  piApiEpoch===sessionEpoch (условие остаётся, но блокирует только shift).
- ui.ts stale-тик try/catch; 14 сьютов exit 0 (replacement 22,
  session-isolation 36, exit-hygiene 18); tsc --noEmit чистый.
- Деплой через deploy.ps1 из корня проекта.

## Задачи

- [ ] T1: F1 — в ownerBlocked early-return пути добавить inline re-capture
      (adopt из event/ctx) + ensureTickerStarted + ensureSyncPoller. Тест:
      fork-цепочка → ownerBlocked → refs свежие → fire доставляет (флаг остаётся
      у владельца).
- [ ] T2: F2 — fire-путь: при refs' session ≠ ownerKey — switchSession(ownerKey)
      → перечитать piApi → sendUserMessage. Тест: refs stale/mis-target + живой
      owner → доставка в jsonl владельца (switchSession-путь), session_start
      владельца от switchSession отрабатывает полностью (не blocked).
- [ ] T3: F3 — верификация по ключу владельца после switchSession-доставки;
      тест: запись в jsonl владельца → send-ok → confirmed → re-arm.
- [ ] T4: верификация и деплой — 14 сьютов exit 0, tsc чистый, deploy.ps1,
      src↔extensions идентичен; живой вердикт: сброс с fork-активностью агента
      между сбросами → fire:send-ok → fire:confirmed без ручного вмешательства.

## Примечание

- Живой стенд на момент написания: /reload 04:42:44Z + /cont-after-reset 5
  (04:44:34Z) в окне агента pid 20084 — флаг armed под ключом 20-15-55-420Z
  (repeat=5, lastResetAtAtArm=03:37:47.560). Следующий сброс 05:37:47Z —
  проверка, пережили ли refs fork 04:45:50Z (если fire опять stale —
  подтверждение C1/C2, F1/F2 необходимы).
