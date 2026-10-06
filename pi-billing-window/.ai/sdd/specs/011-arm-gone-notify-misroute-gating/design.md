# Spec 011 — Design

## Header

- **Status:** design:approved (утверждено ТЗ пользователя от 2026-10-06)
- **Requirements:** `requirements.md` (FR-011-1 … FR-011-5)

## Requirements → Design Mapping

| Requirement | Решение | Компонент |
|---|---|---|
| FR-011-1 (arm-gone notify) | TD-011-1: snapshot + маркеры само-снятия | syncWatchdog (index.ts ~1036–1054) |
| FR-011-2 (switch-gating) | TD-011-2: блок instead of fall-through + TD-011-3 instant retry | fireContinue switch-ветка (~1418–1526) |
| FR-011-3 (confirmed-budget) | TD-011-4: notify в confirmed-ветке | confirmed handler (~2229–2253) |
| FR-011-4 (дедуп) | TD-011-1: маркер `selfArmGoneKind` | те же точки |
| FR-011-5 (housekeeping) | TD-011-5 | `.ai/sdd/` |

## Контекст (что уже есть)

- `syncWatchdog()` (index.ts): на каждом тике читает arm/state. Переход
  «был → нет» сейчас только логируется (`arm-gone`, index.ts:1046).
- `fireContinue()` (index.ts:1384): при `lastSessionStartKey != ownerKey`
  и `switchRoutedForReset !== curReset` вызывает `trySwitchToOwner()`.
  Провал → лог `fire:switch-failed` (1459) → **fall-through к обычной
  отправке** (комментарий на 1461) — источник misroute из аудита.
- Спека 010: при первом switch-failed из-за stale commandCtx — notify
  (`switchFailedNotified`), программный `switch-revive:cmd` — вызов
  `/billing-status` через живой piApi, чтобы обёртка registerCommand
  перезахватила свежий commandCtx.
- `capitulate()` (1240) / `pauseChainUntilNextReset()` (1308): образец
  notify через `sendNotify({type, provider, title, body, timestamp})`.
- confirmed-ветка (~2229): `armsConfirmSuccess()` возвращает boolean;
  при repeat>1 перевзводит запись (`repeat-1`), при repeat<=1 удаляет её.
- `arms.getArm()` даёт текущую запись (`phase`, `repeat`, `expiresAt`).

## Technical Decisions

### TD-011-1 — arm-gone notify: snapshot последней записи + маркеры само-снятия

Модульное состояние:

- `lastArmSeen: { phase, repeat, expiresAt } | null` — snapshot последней
  живой записи, обновляется в `syncWatchdog()` при `arm !== null`
  (вместе с существующим `lastArmSeenKey`);
- `selfArmGoneKind: "off" | "capitulation" | "confirmed-exhausted" | null`
  — маркер «флаг сняли мы сами, уведомление уже есть/не нужно».

Точки установки маркера:

1. `/cont-after-reset off` → перед `armsDisarm()` пометить `"off"`
   (уведомление не нужно: действие пользователя, у него есть
   ctx.ui.notify);
2. `capitulate()` → `"capitulation"` (свой notify уже отправляется);
3. confirmed-ветка: если `armsConfirmSuccess()` вернул true и флаг был
   снят (repeat<=1) → `"confirmed-exhausted"` (D3-notify с N=0 уже
   сообщит пользователю — FR-011-4).

В arm-gone-переходе (`arm === null && lastArmSeenKey !== null`):

- если `selfArmGoneKind !== null` → как сейчас: только лог
  `arm-gone` (дополнить атрибутом kind), маркер сбросить;
- иначе → определить reason по `lastArmSeen`:
  - `expiresAt <= now` → `ttl-expired`;
  - `phase === "pending" && (repeat ?? 1) <= 1` → `repeat-exhausted`
    (снял confirmSuccess — другой процесс или этот до рестарта);
  - иначе (внешнее удаление записи) → body описывает «запись исчезла из
    arms.json (внешнее изменение)», reason-поле — `ttl-expired`
    (канонических значений два, см. D-011-1);
- отправить `sendNotify({ type: "billing:cont-after-reset-arm-gone",
  provider: PROVIDER, title: "cont-after-reset: флаг сгорел", body:
  <reason-зависимый текст + подсказка взвести снова>, timestamp })`,
  fire-and-forget.

Многопроцессность: два процесса одного ключа → оба увидят arm-gone и оба
могут отправить notify. Это соответствует существующему поведению
capitulation-notify (тоже без межпроцессного дедупа) и не является
регрессией; fire-аренда в этой точке не нужна (событие информационное).

### TD-011-2 — switch-gating: блок вместо fall-through

В `fireContinue()`, ветка непрошедшего switch:

```
switchRes = await trySwitchToOwner(ownerKey)
if (switchRes.ok) { /* как сейчас: маркер + wait-loop */ }
else {
  лог fire:switch-failed (текст: причина, «повтор switch на следующей попытке»)
  [spec 010 notify при первом stale-commandCtx — без изменений]
  revived = false
  if (staleCommandCtx && probePiAlive()==="live" && эпохи совпали && piApi) {
    try { await piApi.sendUserMessage("/billing-status", {expandPromptTemplates:true});
          лог switch-revive:cmd; revived = true }
    catch { лог switch-revive:failed }
  }
  switched = false
  if (revived) {
    retry = await trySwitchToOwner(ownerKey)      // TD-011-3
    if (retry.ok) { switchRoutedForReset = curReset; wait-loop; switched = true;
                    лог fire:switch-retry-ok }
    else            лог fire:switch-retry-failed
  }
  if (!switched) {
    armsLog("fire:switch-blocked", withAttr("switch на владельца не прошёл — «продолжи» не отправляю, повтор на retry-тике"))
    ensureRetryInterval()   // NFR-011-2: без stale-счёта, но тик обязан жить
    return                 // ← ГЛАВНОЕ: никакой отправки
  }
}
```

Инвариант D2: `sendUserMessage("продолжи")` достижим ТОЛЬКО при
`lastSessionStartKey === ownerKey` (switch не нужен, прошёл сейчас или
прошёл в этом сбросе — `switchRoutedForReset === curReset`).
`fire:send-misroute` из сценария «switch нужен и не прошёл» становится
недостижимым.

Счётчики: switch-blocked НЕ инкрементирует `staleAttempts` (ложная
капитуляция запрещена — повтор может пройти после revive), bounded
одноразовым notify спеки 010 (`switchFailedNotified`) и TTL флага;
retry-интервал (`ensureRetryInterval`) гарантирует следующий тик.

delivery-in-flight (спека 005, T15): гейт стоит в начале новой попытки
отправки и не трогает grace-таймер, pacing (`staleRetryNotBefore`) и
pending-маркеры; блокнутый раунд их не сбрасывает.

### TD-011-3 — мгновенный switch-retry после revive (решение ТЗ)

**Решение: ДА, делать.** Ускоряет 19:17-сценарий с ~5 мин (retry-тик
RETRY_AFTER_FIRE_MS) до секунд: revive синхронно перезахватывает
commandCtx, и повторный switch в том же раунде почти всегда проходит.
Ограничители: ровно один мгновенный retry на один switch-failed-раунд;
провал → switch-blocked (return) — снова через retry-тик; успех — маркер
`switchRoutedForReset` ставится как при первом прохождении (semantics
«max 1 УСПЕШНЫЙ switch на сброс» сохраняется). Безопасность повторного
switchSession: он идемпотентен (поднимает session_start владельца;
неудачный не переключает активную сессию — уже зафиксировано в спеке 009).

### TD-011-4 — confirmed-notify: бюджет автопродолжений

В confirmed-ветке (после `confirmed === true`):

```
const remaining = armsGetArm()?.repeat ?? 0;   // перевзвод уже сделан confirmSuccess
sendNotify({
  type: "billing:cont-after-reset-confirmed",
  title: `cont-after-reset: продолжи доставлен${remaining > 0 ? ` (осталось ${remaining})` : ""}`,
  body: remaining > 0
    ? `«продолжи» доставлен и подтверждён. Осталось автопродолжений: ${remaining}.`
    : `«продолжи» доставлен и подтверждён. Автопродолжения исчерпаны — флаг снят. Для продолжения взведите снова: /cont-after-reset N.`,
  ...
})
```

`armsGetArm()` после `armsConfirmSuccess()` даёт перевзведённую запись
(`repeat-1`) либо null (флаг снят → N=0). Вызывается внутри `if
(confirmed)`, т.е. ≤ 1 notify на окно. Если repeat-снятие — здесь же
ставится маркер `selfArmGoneKind = "confirmed-exhausted"` (TD-011-1).

### TD-011-5 — SDD housekeeping

- `.ai/sdd/INDEX.md`: добавить строки 004–011 (артефакты по факту
  наличия файлов);
- `.status` для 004–010 (сейчас отсутствуют у всех семи): по фактическому
  состоянию — кампании/фичи реализованы и развёрнуты (README §8a
  документирует 005–010 как живое поведение; 004 — выполненный прогон
  сценариев с reports/final-report.md), формализованного review.md нет →
  `implementation:done` для 004–010. 011 — по своему жизненному циклу.

### TD-011-6 — Восстановление зелёного бейзлайна тестов (предусловие T5, ВЫПОЛНЕНО)

Перед реализацией D1–D4 полный прогон сьютов был красным (8 из 14 FATAL) —
регрессия, не связанная с дефектами аудита, но блокирующая гейт T5. Два
инфраструктурных фикса (коммиты предстоят вместе со спекой):

1. **state.ts withLock** — proper-lockfile вызывает `realpath(путь_лока)`
   ДО создания лока; на несуществующем пути это детерминированный ENOENT.
   Фикс ec9c495/e5cda97 (ELOCKED-инцидент) убрал пред-создание файла —
   все state-локующие сьюты упали. Возвращено пред-создание маркер-файла
   по образцу arms.ts/history.ts (доказанно работает в проде); NOTE-коммент
   исправлен: лок-КАТАЛОГ proper-lockfile — это `<lock>.lock`, маркер-файл
   с ним не конфликтует.
2. **arms.ts / history.ts withLock** — `retries: 8` с дефолтным бэкоффом
   proper-lockfile (первый шаг ~1 с) превращает benign-гонку одного тика
   (markFired vs extendArmTtl) в задержку всего раунда доставки;
   `fire:send-ok` дописывается позже, чем e2e-ассерты читают лог —
   детерминированный RED watchdog.e2e «probe→live» (документированная
   гонка из спеки 010). Бюджет ретраев сужен до state.ts-паттерна
   (retries 20, factor 1, 100–200 мс).

Доказательство: `bash scripts/run_all_suites.sh` — 14/14 exit 0
(тёплый прогон; первый прогон после правок может флакать на
timing-ассерты из-за холодной компиляции tsx — известная хрупкость,
не логики).

## Edge Cases

1. **arm-gone при TTL в repeat-режиме**: `extendArmTtl` (спека 010)
   продлевает TTL на сбросах, поэтому ttl-expired ночью маловероятен;
   при обнаружении — notify (FR-011-1).
2. **switch-blocked навсегда** (commandCtx мёртв и revive не помогает):
   1 notify спеки 010 на цепочку + retry-тики до TTL/следующего сброса;
   не молчит и не капитулирует ложно.
3. **confirmed в чужой сессии**: confirm-гейт спеки 007
   (`confirmEligible`) уже отсекает — D3-notify не отправится.
4. **двойной notify при кросс-процессном confirm**: процесс-владелец
   шлёт D3 (N=0), второй процесс видит arm-gone без маркера → D1
   `repeat-exhausted`. Допустимо (редкий случай, оба сообщения правдивы);
   зафиксировано в FR-011-4 как граница дедупа.
5. **fire:confirmed у repeat=1**: D3-notify N=0 и suppression D1 —
   пользователь получает ровно одно сообщение об исчерпании.

## Verification Strategy

- Юнит-сьюты (новые + правка существующих), все через `npx tsx`:
  - `tests/arm-gone-notify.test.mts` (T2): ttl-expired notify;
    repeat-exhausted (внешнее удаление pending-записи); off — без notify;
    capitulation — только capitulation-notify; confirmed-exhausted —
    D3-notify и подавленный D1.
  - `tests/session-isolation.test.mts` / `tests/delivery-gating.test.mts`
    (T3): обновить ассерты старого fall-through (Rv-A: вместо «send
    ушёл» — «send НЕ ушёл, fire:switch-blocked в логе»); новые кейсы:
    switch-failed → sendUserMessage("продолжи") не вызывается; revive +
    instant retry ok → доставка в владельца в том же раунде; retry
    failed → blocked.
  - confirmed-notify (T4): в lifecycle-стиле — fake fetch (как
    capitulation-тесты), N>0 и N=0 формулировки.
- Финальный гейт: `bash scripts/run_all_suites.sh` (все сюты exit 0) +
  `python tests/billing_report_test.py`.

## Risks

- **R1:** instant retry switchSession в тестах с моками может не
  обновить `lastSessionStartKey` синхронно → ждать wait-loop'ом
  (существующий механизм, `switchWaitRounds` перенастраиваем в тестах).
- **R2:** правка Rv-A/Rv-B тестов меняет семантику спеки 010 —
  фиксировано в tasks.md требованием «обновить по смыслу, сохранив
  инварианты 010 (notify + revive)».

## Implementation FAQ

- **Почему не убрать misroute-механику целиком?** Она защищает случай
  «switch не нужен, но слот переехал» (T15-смежный) и остаётся.
- **Почему switch-blocked не считается stale-попыткой?** Иначе 6
  блокировок ложно капитулировали бы живой после revive флаг.
- **Куда ставить маркер confirmed-exhausted?** В confirmed-ветке сразу
  после чтения remaining, до armsLog("fire:confirmed").
