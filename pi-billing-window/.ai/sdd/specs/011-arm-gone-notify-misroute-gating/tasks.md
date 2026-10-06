# Spec 011 — Tasks

## Header

- **Status:** tasks:approved (утверждено ТЗ пользователя от 2026-10-06)

## T0 — DONE Восстановление зелёного бейзлайна (вне дефектов D1–D4)

- **Приоритет:** Must (блокер гейта T5) • Выполнено main-агентом до старта T1
- **Work:** два инфраструктурных фикса по TD-011-6 (state.ts пред-создание
  маркер-файла лока; arms.ts/history.ts тесный бюджет ретраев).
- **Verify (gate):** `bash scripts/run_all_suites.sh` — 14/14 exit 0
  (2026-10-06, тёплый прогон) — зафиксировано выше.

## T1 — DONE D4: SDD housekeeping (INDEX.md + .status 004–010)

- **Приоритет:** Should (FR-011-5) • **Модель субагента:** flash
  (`wormsoft/zai/glm-5.3-flash:NVFP4`) • **Зависимости:** нет
- **Work:**
  - `.ai/sdd/INDEX.md`: дополнить таблицу строками 004–010 (артефакты по
    фактическому наличию файлов) и 011-arm-gone-notify-misroute-gating
    (requirements/design/tasks);
  - создать `.ai/sdd/specs/00{4,5,6,7,8,9}*/.status` и
    `010-command-ctx-selfhealing/.status` со значением
    `implementation:done` (по факту: реализовано и развёрнуто, README §8a
    документирует как живое поведение; формализованного review.md нет);
  - строки 001–003 не трогать.
- **Acceptance:** INDEX содержит 001–011; у каждого каталога 004–011 есть
  `.status` с валидным значением из SDD-конвенции.
- **Files:** `.ai/sdd/INDEX.md`, `.ai/sdd/specs/004..010/.status`
- **Verify (gate):** `ls` + `cat` — все `.status` существуют и валидны;
  INDEX-таблица полная.

## T2 — DONE D1: arm-gone notify + юнит-тесты

- **Приоритет:** Must (FR-011-1, FR-011-4) • **Модель:** default
  (наследование) • **Зависимости:** T1 (синхронно по порядку)
- **Work (src/index.ts, по design TD-011-1):**
  1. модульное состояние `lastArmSeen` (snapshot phase/repeat/expiresAt,
     обновлять в `syncWatchdog` при живом arm) и
     `selfArmGoneKind: "off"|"capitulation"|"confirmed-exhausted"|null`;
  2. маркеры: `/cont-after-reset off`-ветка (~2660) → `"off"`;
     `capitulate()` (~1237) → `"capitulation"`;
  3. arm-gone-переход (~1046): при маркере — лог с атрибутом kind, без
     notify; иначе — notify
     `type: "billing:cont-after-reset-arm-gone"` c reason
     `ttl-expired` (expiresAt <= now) / `repeat-exhausted`
     (phase==="pending" && (repeat ?? 1) <= 1), body с подсказкой взвести
     снова; сбрасывать snapshot/маркер.
- **Tests:** новый сьют `tests/arm-gone-notify.test.mts` в стиле
  lifecycle/arms-сьютов; notifier мокать перехватом `globalThis.fetch`
  (как capitulation-тесты в stale-capitulation.test.mts:327). Кейсы:
  ttl-expired → notify; внешнее удаление pending repeat=1 → notify
  repeat-exhausted; `off` → notify НЕТ; капитуляция → только
  capitulation-notify; сброс тестового состояния — по образцу
  `__resetStaleStateForTests`.
- **Acceptance:** сьют зелёный; существующие сюты не сломаны (прогнать
  stale-capitulation + lifecycle).
- **Files:** `src/index.ts`, `tests/arm-gone-notify.test.mts`
- **Verify (gate):** `npx tsx tests/arm-gone-notify.test.mts` → exit 0;
  `npx tsx tests/stale-capitulation.test.mts` → exit 0.

## T3 — DONE D2: switch-gating (запрет fall-through) + мгновенный retry + тесты

- **Приоритет:** Must (FR-011-2) • **Модель:** default • **Зависимости:** T2
- **Work (src/index.ts, fireContinue ~1418–1526, по design TD-011-2/3):**
  1. в else-ветке непрошедшего switch: сохранить логику notify спеки 010
     (`switchFailedNotified`) и revive (`switch-revive:cmd` /
     `switch-revive:failed`);
  2. после успешного revive — ОДИН мгновенный `trySwitchToOwner(ownerKey)`
     (`fire:switch-retry-ok` / `fire:switch-retry-failed`); при успехе —
     маркер `switchRoutedForReset = curReset` + существующий wait-loop;
  3. если switch так и не прошёл — `armsLog("fire:switch-blocked", …)`,
     `ensureRetryInterval()`, `return` — БЕЗ отправки «продолжи»;
     удалить fall-through-комментарий (1461);
  4. не трогать: grace/pacing/delivery-in-flight (спека 005),
     misroute-механику после состоявшейся отправки, epoch-guard.
- **Tests:** обновить `tests/session-isolation.test.mts` (Rv-A ~925–960,
  Rv-B ~1036) и `tests/delivery-gating.test.mts` — ассерты старого
  fall-through («send ушёл») заменить по смыслу: send НЕ уходит, в логе
  `fire:switch-blocked`; инварианты 010 (notify + revive) сохранить.
  Новые кейсы: (а) switch-failed, revive не помогает →
  sendUserMessage("продолжи") не вызывается вовсе; (б) revive ок +
  retry ок → доставка в владельца в том же раунде.
- **Acceptance:** инвариант D2: «продолжи» недостижим при
  непрошедшем switch; оба сьюта зелёные.
- **Files:** `src/index.ts`, `tests/session-isolation.test.mts`,
  `tests/delivery-gating.test.mts`
- **Verify (gate):** `npx tsx tests/session-isolation.test.mts` → exit 0;
  `npx tsx tests/delivery-gating.test.mts` → exit 0.

## T4 — DONE D3: confirmed-notify (бюджет автопродолжений) + тесты

- **Приоритет:** Must (FR-011-3, FR-011-4) • **Модель:** default •
  **Зависимости:** T3
- **Work (src/index.ts, confirmed-ветка ~2229–2253, по design TD-011-4):**
  1. после `confirmed === true`: `const remaining = armsGetArm()?.repeat ?? 0`;
  2. при `remaining === 0` → маркер `selfArmGoneKind = "confirmed-exhausted"`
     (дедуп с D1, FR-011-4);
  3. `sendNotify({ type: "billing:cont-after-reset-confirmed", … })`:
     N>0 → «осталось автопродолжений: N»; N=0 → «автопродолжения
     исчерпаны — взведите снова: /cont-after-reset N»; fire-and-forget.
- **Tests:** в стиле lifecycle (fake fetch): confirmed с repeat>1 → notify
  «осталось N» (N = repeat-1); confirmed с repeat=1 → notify N=0-фразой И
  отсутствие последующего arm-gone-notify; чужая сессия (confirm-гейт 007)
  → notify нет.
- **Acceptance:** confirmed-notify уходит ровно один раз на подтверждение.
- **Files:** `src/index.ts`, подходящий сьют (расширить
  `tests/arm-gone-notify.test.mts` или lifecycle-файл — по фактической
  структуре хелперов).
- **Verify (gate):** новый/расширенный сьют → exit 0.

## T5 — DONE Финальная верификация

- **Приоритет:** Must • **Модель:** main-агент (не субагент) •
  **Зависимости:** T1–T4
- **Work:** `bash scripts/run_all_suites.sh` — ВСЕ сьюты exit 0;
  `python tests/billing_report_test.py` — exit 0. Выводы команд — в
  review.md. Затем sdd-review: review.md, README §8a, docs/EVENTBUS.md
  (новые notify-типы `billing:cont-after-reset-arm-gone`,
  `billing:cont-after-reset-confirmed`; лог `fire:switch-blocked`).
- **Acceptance:** полный гейт зелёный; артефакты обновлены.
- **Verify (gate):** exit 0 обоих команд, зафиксированный вывод.

## Coverage

- FR-011-1 → T2; FR-011-2 → T3; FR-011-3 → T4; FR-011-4 → T2+T4;
  FR-011-5 → T1. NFR-011-1..4 → инварианты внутри T2–T5.
- Must Have покрыты задачами; Won't Have — в Boundaries requirements.md.
