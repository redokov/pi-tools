# Spec 005 — Design: pending resend gated by window reset

## Current flow (что меняем)

```
onWatchdogFire → graceTimer(60с) → fireContinue():
  sendUserMessage("продолжи") → send-ok → markFired() → phase="pending"
retryTick (каждые 5 мин):
  phase=="pending" → если now - max(lastFireAt, last429At) >= 5 мин → fireContinue()
  phase=="armed"  → deliveryInFlight || staleAttempts>0 → fireContinue()
```

Проблема: pending-ветка отправляет по таймауту, а не по событию сброса окна.

## New flow

1. Новый модульный маркер `pendingFiredResetAt: number | null` (index.ts):
   значение `state.lastResetAt`, на ДАННЫЙ сброс которого была отправлена
   последняя «продолжи». Устанавливается в `fireContinue()` сразу после
   успешной отправки (той же точкой, где `markFired()`), сбрасывается в
   `null` на подтверждении (`confirmSuccess`/снятие флага) и в
   `__resetStaleStateForTests()`.
2. `retryTick()`, pending-ветка — новое условие отправки:

   ```ts
   if (arm.phase === "pending") {
     if (st === null) return;
     const firedReset = pendingFiredResetAt ?? 0;
     if (st.lastResetAt === firedReset) return;   // сброса не было — ждём
     await fireContinue();                         // новый сброс → повтор
   }
   ```

   Тик остаётся каждые `RETRY_AFTER_FIRE_MS` (FR6: поллинг, не условие).
   Реальная задержка повтора = до 5 мин ПОСЛЕ границы сброса (синхронно с
   поллингом; sync-poller 60с всё равно зовёт syncWatchdog, watchdog
   сам arm'ится на границу — тайминги сохраняются).
3. Grace на повторе: `fireContinue()` вызываемый из retryTick при новом
   сбросе отправляет сразу (граница уже прошла, grace отработал в
   onWatchdogFire; НЕ ждём ещё 60с) — так же, как сейчас ведёт себя
   armed-ветка deliveryInFlight.
4.armed-ветка (`deliveryInFlight`/`staleAttempts`) НЕ меняется — T15-инвариант
   «доставка в полёте доезжает» сохраняется.
5. `st?.last429At` больше НЕ участвует в pacing pending-ветки (429 — это
   признак «втёмную отправлять нельзя», лечится ожиданием нового сброса).

## Что НЕ меняется

- `markFired()`, TTL, `PENDING_MS`, фазы, формат arms.json/state.json.
- Stale-retry (D-204): backoff, капитуляция после 6, notify.
- Дедуп D-203 (`lastFiredResetAt`): один fire на один сброс при планировании.
- Watchdog-модель: one-shot таймер на границу, grace 60с, sync-poller 60с.

## Rationale

Модель пользователя: «продолжи» = «окно сброшено, работай». Между сбросами
окна новая попытка бессмысленна (429 не кончился) и вредна (спам, лишние
вызовы). Сигнал «есть новый сброс» уже есть — `state.lastResetAt`.

## Risks / edge cases

- **«продолжи» потерялось при доставке, ответа не будет до нового сброса** —
  осознанный компромисс: deliveryInFlight-ветка (armed) покрывает сбой
  самой отправки (stale), а потеря ответа лечится следующей границей (2ч),
  не 5-мин спамом.
- **Процесс перезапущен между сбросами**: `pendingFiredResetAt=null` →
  retryTick воспримет «нет маркера» как необходимость повторить при
  следующем сбросе; маркер null при pending-фазе = считать «отправлялось»
  только если новый сброс наступил ПОСЛЕ arm'а (`st.lastResetAt >
  arm.lastResetAtAtArm` + уже был send-ok... упрощение: null → ждать нового
  сброса, т.е. `firedReset=0` — безопасно, лишний повтор только на границе).
- **Тесты, кодировавшие 5-мин повтор**: перевести на новую семантику
  (grep `RETRY_AFTER_FIRE_MS` / `pending` в tests/).

## Tests

- Юнит-новый: `tests/pending-window-retry.test.mts`: (а) send-ok → 3 тика
  retryTick без сброса → 0 отправок; (б) новый reset → ровно 1 отправка;
  (в) ещё тики без сброса → тишина; (г) подтверждение между тиками снимает
  флаг.
- E2e-новый (в watchdog.e2e.test.mts, мок pi как в scenario 6): сценарий
  «429-ночь»: arm → reset → send-ok → тики 10/20 мин → тишина → новый reset
  → 1 отправка.
- Регресс: 9 сьютов, 0 FAIL; deps: обновить ожидания старых pending-тестов.
