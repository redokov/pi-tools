# Spec 010: commandCtx самопрочинка ночью + флаг переживает неудачные цепочки

## Проблема (ночь 2026-09-30 → 10-01, evidence из arms.log после хотфикса spec 009)

Хотфикс spec 009 работает (диагностика `fire:switch-failed` точная, повторные
попытки switch не блокируются неудачной первой), но ночной сценарий всё равно
падает — 2 полных цикла отказа:

- **19:42Z** (miRead, `15-13-14-679Z`): fire:switch-needed → fire:switch-failed
  **мгновенно (3 мс** — не 2.4 с, как в рабочем цикле 17:38) → fall-through →
  send через мёртвый piApi → stale 1/6. Причина (по логу хотфикса):
  `switchSession бросил: This extension ctx is stale...` — **commandCtx мёртв**
  после fork-цепочки 17:39/17:56/18:09/18:13 (4 fork'а; захвачен при
  /cont-after-reset 15:13).
- Рабочий цикл **23:37Z** (MyTasks, `19-53-23-964Z`): confirmed 23:46:28 —
  commandCtx был жив (пользователь вызвал команду после /reload 19:44) →
  switch-путь прошёл → createRuntime → factory re-run → piApi fresh → доставка.
  Fork 23:42 убил commandCtx снова.
- Сброс **01:37Z** (MyTasks): switch-needed ×4 (01:38/01:43/01:53/02:13) — все
  **fire:switch-failed «switchSession бросил stale»** → попытки 1/6→4/6,
  fall-through → send через мёртвый piApi → stale. Цепочка → капитуляция
  ~03:53 → флаг снят → ночной агент простаивает.
- **miRead-флаг сгорел по TTL** (не по капитуляции): confirm 17:39 → TTL заново
  8 ч (до 01:39); сбросы 19:37/21:37/23:37 без доставки TTL НЕ продлевали →
  флаг истёк во время неудачной цепочки → утром нужен повторный взвод.

## Root cause (C5–C6)

- **C5**: `commandCtx` умирает от КАЖДОЙ fork-цепочки (switchSession на мёртвом
  commandCtx бросает stale — fact по live 19:42/01:38–02:13) и оживляется
  ТОЛЬКО вызовом команды в окне (commandCtx = fresh ctx из текущего runtime)
  или /reload (factory пере-выполняется → piApi fresh для активной сессии).
  Ночью команд нет → switch-путь недоступен → все попытки fall-through через
  мёртвый piApi → stale-цепочка → капитуляция → флаг снят → ночной агент
  простаивает до утреннего вмешательства.
- **C5a**: `piApi` тоже мёртв после fork-цепочки: factory НЕ пере-выполняется
  при fork-подсессиях (jiti-модуль общий по cwd; `createRuntime` — только при
  switchSession/reload), а captured ctx инвалидируются правилом pi «after
  ctx.newSession(), ctx.fork(), ctx.switchSession()». Поэтому программный
  вызов команды через `piApi.sendUserMessage("/cmd",
  {expandPromptTemplates:true})` — тоже падает stale: fallback работает только
  при живом piApi (после /reload или после успешного switch-пути).
- **C6**: TTL флага продлевается ТОЛЬКО при markFired (PENDING_MS — комната
  подтверждения) / confirmSuccess (ARMS_TTL_MS заново). Сбросы окна БЕЗ
  доставки НЕ продлевают TTL → при длительных ночных неудачах флаг сгорает по
  TTL (miRead: expired 01:39), а после утреннего восстановления delivery
  нужен повторный взвод вручную.

## Дизайн-решения

### F1: флаг переживает ночные неудачные цепочки

- **F1a**: капитуляция (после 6 неудачных stale-попыток) в repeat-режиме
  (`repeat > 1`) НЕ снимает флаг, а ПАУЗИТ цепочку до следующего сброса окна:
  retry-интервал остановлен, staleRetryNotBefore = момент следующего сброса,
  флаг остаётся `armed`, sync-poller жив. При следующем сбросе — новая цепочка
  попыток; если к тому времени commandCtx ожил (пользователь вызвал команду)
  — delivery проходит. Одноразовый флаг (`repeat=1`) капитулирует как раньше
  (вечный ретрай не нужен).
- **F1b**: TTL продлевается при каждом сбросе окна: в checkAndReset при
  armed/pending флаге — `expiresAt = max(expiresAt, now + ARMS_TTL_MS)`
  (никогда не укорачивает). Флаг не сгорает по TTL во время ночных неудач.

Разрешение конфликта со spec 002 («капитуляция вместо вечного ретрая»):
вечный ретрай останавливается (цепочка паузится до сброса, попытки не
повторяются 6 раз подряд), но флаг не удаляется в repeat-режиме — ночной
сценарий требует, чтобы флаг пережил ночь. Пользователь может снять флаг
`--remove` при спокойном fire-цикле (как раньше).

### F2: восстановление delivery при первом живом ctx (условный fallback)

Программное исполнение команды: при fire, если commandCtx недоступен/мёртв,
а `piApi` ЖИВ (probePiAlive() === "live") — исполнить
`piApi.sendUserMessage("/billing-status", {expandPromptTemplates: true})`:
pi исполняет extension-команду ВМЕСТО отправки (no turn, no user entry), но
через текущий runtime → обёртка pi.registerCommand захватывает commandCtx =
fresh ctx → следующий switch-путь проходит. Ограничения (investigate):
- работает ТОЛЬКО при живом piApi (после /reload без fork'ов или после
  успешного switch-пути) — целевой ночной режим (piApi мёртв) НЕ покрывает;
- ломает существующие тесты (точные asserts sends.length в
  delivery-gating/pending-window-retry/lifecycle) и добавляет лишние
  send-записи — нужен гейт (только при switch-failed из-за stale commandCtx)
  и/или обновление тестов.

### F3: внешний CLI-путь для ночной доставки (требует исследования)

`pi` CLI в non-interactive/print/rpc режиме (`pi -p "продолжи" --session
<ownerKey>` или rpc-эквивалент) — новый процесс → fresh runtime → доставка
в владельца, БЕЗ captured ctx. Ночной helper-скрипт (аналог
`arm_cont_after_reset.py`) по расписанию или по сигналу из log
(fire:switch-failed) запускает доставку. Требует исследования: CLI-флаги
8.5/pi ( resume/session, non-interactive send), побочные эффекты (новый
процесс, блокировки state.lock), дискриминация владельца.

### F4: уведомление при switch-failed

При ПЕРВОМ fire:switch-failed из-за stale commandCtx (не на каждую попытку)
— notify пользователю через notifier (уходит в окно): инструкция «commandCtx
мёртв после fork-цепочки — вызови любую команду в окне (например
/billing-status), чтобы switch-путь ожил». Ночью пользователь спит — notify
виден утром/в истории; не спамит (1 раз на цепочку, флаг `notified`).

## Отвергнутые альтернативы

- switchSession через bindings.commandContextActions на мёртвом commandCtx —
  бросает stale (live fact).
- захват ctx fork-подсессий в ownerBlocked-пути для доставки/переключения —
  event-handler ctx (ExtensionContext) не имеет switchSession/sendUserMessage
  (types.d.ts:210/255) и не несёт api/events (investigation #3) — no-op.
- программное исполнение команды через мёртвый piApi — throws stale (C5a).
- флаг едет за refs' session — «продолжи» попадает в разговор сабагента
  (spec 009 design §F2-альтернативы).

## Инварианты (не ломать)

- spec 009: switch-путь при живом commandCtx (23:37-цикл confirmed —
  эталон); диагностика fire:switch-failed; повторные попытки switch
  (switchRoutedForReset только при успехе).
- spec 006/007/008: blocked-гейт, реверификация 3 чтения, confirm gating,
  adoptFreshRefs(ctx) в /cont-after-reset.
- spec 002: капитуляция для repeat=1; один fire на сброс; дедуп.
- 14 сьютов exit 0; tsc --noEmit чистый; деплой через deploy.ps1;
  коммит-месседжи через файл UTF-8 + git commit -F.

## Задачи

- [ ] T1: F1 — TTL-продление при сбросах окна (checkAndReset при armed/pending
      флаге: expiresAt = max(expiresAt, now + ARMS_TTL_MS)) + капитуляция в
      repeat-режиме НЕ disarm (пауза до следующего сброса). Тест: цепочка с
      TTL-истечением → флаг переживает (miRead-кейс); после оживления
      commandCtx delivery восстанавливается без повторного взвода.
- [ ] T2: F2 — программный вызов команды при живом piApi (гейт: только при
      switch-failed из-за stale commandCtx). Тест: commandCtx мёртв + piApi
      жив → sendUserMessage("/billing-status") исполняет команду → commandCtx
      обновляется → switch восстанавливается; при мёртвом piApi — без вызова.
- [ ] T3: F4 — notify при первом switch-failed на цепочку. Тест:
      fire:switch-failed ×N → notify отправлен 1 раз.
- [ ] T4: F3 — исследование pi CLI (print/rpc, --session, побочные эффекты)
      субагентом; прототип night helper-скрипта доставки по log-сигналу.
- [ ] T5: верификация и деплой — 14 сьютов exit 0, tsc чистый, deploy.ps1,
      diff src↔extensions; живой вердикт: ночной сброс с fork-активностью →
      после капитуляции-паузы флаг переживает, утренний вызов команды →
      delivery восстанавливается без повторного взвода.

## Порядок работ

1. T1 (самое важное: флаг переживает ночь) → T2 → T3.
2. T4 (исследование CLI — субагент) параллельно с T2/T3.
3. T5 + живой вердикт; коммит + пуш ПОСЛЕ вердикта (spec-файлы раньше).

## Примечание (текущий стенд на момент написания)

- MyTasks-флаг (`19-53-23-964Z`): armed, repeat=4, TTL до ~07:46Z — цепочка
  4/6 (02:13), попытка 5/6 ~02:53, 6/6 ~03:53 → капитуляция (до T1 — снимет).
- miRead-флаг (`15-13-14-679Z`): истёк по TTL 01:39 — нужен перевзвод
  /cont-after-reset в окне miRead.
- До T1 временная мера: после fork-активности (признак fire:switch-failed в
  log) — вызов ЛЮБОЙ команды в окне (commandCtx fresh) или /reload +
  команда. Единственный работающий путь восстановления delivery.
