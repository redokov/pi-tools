# Spec 010: tasks

## T1: F1 — флаг переживает ночные неудачные цепочки
- [ ] TTL-продление при сбросах окна: в checkAndReset (src/ticker.ts или
      src/index.ts — где выполняется сброс) при armed/pending флаге текущего
      ключа — `expiresAt = max(expiresAt, now + ARMS_TTL_MS)` (никогда не
      укорачивает; не трогать repeat/phase/lastFireAt). Хелпер в src/arms.ts:
      `extendArmTtl(key, ms)`.
- [ ] Капитуляция в repeat-режиме (repeat > 1) НЕ disarm: пауза до следующего
      сброса окна (staleRetryNotBefore = момент следующего сброса, retry-
      интервал остановлен, sync-poller жив, флаг остаётся armed). Для
      repeat=1 — капитуляция как раньше (disarm + notify).
- [ ] Тест (arms.test.mts + stale-capitulation.test.mts):
      (a) TTL-продление при сбросе (expiresAt не укорачивается, продлевается
      при armed/pending);
      (b) капитуляция repeat>1 — флаг остаётся armed, retry паузится до
      сброса; repeat=1 — disarm как раньше;
      (c) miRead-кейс: цепочка с TTL-истечением → флаг переживает, после
      оживления commandCtx delivery восстанавливается без повторного взвода.

## T2: F2 — программный вызов команды при живом piApi (условный fallback)
- [ ] Гейт: только при fire:switch-failed из-за stale commandCtx И
      probePiAlive() === "live" И piApiEpoch === sessionEpoch. Исполнить
      `piApi.sendUserMessage("/billing-status", {expandPromptTemplates: true})`
      — pi исполняет extension-команду (no turn, no user entry) → обёртка
      pi.registerCommand захватывает commandCtx = fresh ctx.
- [ ] При мёртвом piApi — без вызова (stale-путь как раньше).
- [ ] Тест (session-isolation.test.mts): commandCtx мёртв (null) + piApi жив
      → sendUserMessage("/billing-status") вызван → commandCtx обновился →
      switch-путь восстанавливается; при мёртвом piApi — sendUserMessage
      команды НЕ вызван.
- [ ] Проверить побочные эффекты: точные asserts sends.length в
      delivery-gating/pending-window-retry/lifecycle — лишних send-записей
      не быть (гейт не срабатывает в этих сценариях).

## T3: F4 — notify при первом switch-failed на цепочку
- [ ] При ПЕРВОМ fire:switch-failed из-за stale commandCtx на цепочку
      (флаг `switchFailedNotified` на reset) — notify через notifier
      (billing:cont-after-reset-capitulation-канал или отдельный): инструкция
      «commandCtx мёртв после fork-цепочки — вызови любую команду в окне».
- [ ] Тест (stale-capitulation.test.mts): fire:switch-failed ×N → notify
      отправлен ровно 1 раз.

## T4: F3 — исследование pi CLI (субагент, investigation-only)
- [ ] pi CLI non-interactive/print/rpc: флаги --session/--resume, -p,
      rpc-порт; можно ли послать сообщение в СУЩЕСТВУЮЩУЮ сессию (ownerKey)
      новым процессом без fork'ов; побочные эффекты (блокировки
      state.lock, новый процесс, дискриминация владельца).
- [ ] Прототип night helper-скрипта scripts/cont_now.py: по log-сигналу
      (fire:switch-failed) запускает доставку через CLI. НЕ внедрять в
      расширение.

## T5: верификация и деплой
- [ ] 14 сьютов exit 0, tsc --noEmit чистый.
- [ ] deploy.ps1, diff src↔extensions идентичен.
- [ ] Живой вердикт: ночной сброс с fork-активностью → цепочка до
      капитуляции-паузы → флаг ПЕРЕЖИВАЕТ ночь (armed, TTL продлён);
      утренний вызов команды в окне → delivery восстанавливается
      (fire:send-ok → fire:confirmed) БЕЗ повторного взвода.

## Порядок работ

1. T1 → T2 → T3; T4 параллельно (субагент).
2. T5 + живой вердикт; коммит + пуш ПОСЛЕ вердикта (spec-файлы раньше).

## Временные меры (до реализации T1–T3)

- После fork-активности (признак fire:switch-failed в log) — вызов ЛЮБОЙ
  команды в окне (например /billing-status; commandCtx fresh) или /reload +
  команда. Единственный работающий путь восстановления delivery.
- miRead-флаг истёк по TTL 01:39 — перевзвод /cont-after-reset N.
- Утром после капитуляции — перевзвод в обоих окнах при необходимости.
