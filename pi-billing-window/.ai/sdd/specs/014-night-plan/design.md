# Design: Spec 014 — night plan

> Requirements: @requirements.md
> Status: draft
> Last Updated: 2026-10-25

## 1. Executive Summary

Четыре добавления к существующей механике cont-after-reset: (1) новый модуль
`src/nightplan.ts` — план-файл (CRUD под proper-lockfile по паттерну state.ts),
интервал-математика с переходом через полночь, append-only ночная книга и чистые
функции сборки утреннего отчёта; (2) инвариант страховки на существующем
sync-тике (SYNC_POLL_MS) — единственная точка auto-rearm; (3) hook на
`billing:window_reset` → строка книги; (4) wall-clock таймер утреннего отчёта по
паттерну ensureWakeTimer (unref, перевзвод на sync-тике/session_start).

Ключевой принцип: план — контракт ВНЕ беседы. Дисарм агента (штатный или
стоп-условием) не отменяет план; страховку восстанавливает инвариант, а не
дисциплина агента. Дубликаты уведомлений исключаются: arm-gone-notify для ключа
плана в интервале гасится, если инвариант успешно перевзвёл (одно событие
`auto-rearm:from-plan` вместо двух).

## 2. Requirements Mapping

| Requirement | Design | Notes |
|---|---|---|
| FR-014-1 | §4 `/night-plan`, nightplan.ts CRUD | один активный план на аккаунт (как state); lock-паттерн state.ts дословно |
| FR-014-2 | §5.1 инвариант sync-тика | arm() из arms.ts без изменений; атрибуция withAttr |
| FR-014-3 | §5.2 escalate + rate-limit | память процесса (Map lastNotifyAt), без новых файлов |
| FR-014-4 | §6 ledger hook | emit `billing:window_reset` уже есть — подписчик в index.ts |
| FR-014-5 | §7 morning report | читает ledger + history.csv (парсер строк history в nightplan.ts), armslog не парсит — причины из in-memory счётчиков ночи + verdict |
| FR-014-6 | §9 VERSION | токен `v=` через withAttr (только добавляет) |
| NFR-014-1..4 | §11 | тест-хуки `__nightPlanForTests`, параметры интервалов |

## 3. Data Flow (ночь, таймлайн)

```
22:00  /night-plan 22:00-08:00 → plan.json {key,from,to,repeat,expiresAt}
       (флаг может отсутствовать — до первого исчерпания лимита он не нужен)
...    сессия работает; 429 → агент молчит; окно истекает →
       checkAndReset → emit billing:window_reset →
         a) fire-путь arms (существующий): «продолжи»
         b) НОВОЕ: ledger-строка (если сброс в интервале плана)
       агент снял флаг по стоп-условию (инцидент-сценарий) →
       sync-тик: planActive ∧ inInterval ∧ нет arm → arm(key, repeat) +
       armslog auto-rearm:from-plan + notify night-plan-rearm
08:00  morning-таймер: report-<date>.md (ledger + history) + notify night-report
09:00  expiresAt: план мёртв, sync-тик больше ничего не перевзводит
```

## 4. Модель данных

`nightplan.json` (один активный план; TTL в самом файле, мусор не собираем —
перезапись при следующем /night-plan):
```json
{
  "key": "<session basename>", "fromLocal": "22:00", "toLocal": "08:00",
  "repeat": 6, "backlogPath": null, "createdAt": 1793000000000,
  "expiresAt": 1793043600000, "nightDate": "2026-10-25"
}
```
`nightDate` — дата, к которой относится ночь (для ledger/отчёта): если from>to,
ночь «начинается» в from; ночь 22:00 25-го → 08:00 26-го имеет nightDate="25".
`inInterval(localMinutes, from, to)` — чистая функция, полночь = from>to wrap.

`nights/ledger.csv` (append, каталог создаётся при первом взводе плана):
`ts_iso,epoch_ms,night_date,reset_at,calls_in_window,input,output,cache_read,arm_phase,verdict`

## 5. Инвариант страховки (index.ts, sync-тик)

### 5.1 auto-rearm
Порядок проверок (все дешёвые, O(1) файловые чтения уже в тике):
1. plan = readPlan(); if (!plan || now > plan.expiresAt || !inInterval(now)) skip.
2. Guard владельца: действует только процесс, владеющий state (текущий ownerKey
   совпадает / currentCtx жив) — паттерн D-607/D-608. Чужой процесс — только
   armslog-наблюдение, без мутаций.
3. if (getArmForKey(plan.key)) — застрахован; сбросить escalate-счётчик; skip.
4. await arms.arm(plan.key, {repeat: plan.repeat, ttl: до expiresAt}) →
   armslog `auto-rearm:from-plan` (withAttr) + notify night-plan-rearm.
   Ошибка arm() → §5.2.

### 5.2 escalate (uninsured)
Неудача arm() либо повторная пропажа флага: notify night-plan-uninsured с
rate-limit 10 мин (Map в памяти: lastUninsuredNotifyAt). В armslog —
`night-plan:uninsured` на каждом событии (без rate-limit, лог полный).

Взаимодействие с arm-gone-notify (spec 011): в подписчике arm-gone, если
planActive ∧ key=plan.key → НЕ слать `billing:cont-after-reset-arm-gone`
(инвариант либо уже перевзвёл, либо шлёт night-plan-uninsured). Отдельный флаг
гашения не нужен: инвариант на следующем sync-тике (≤60 с) перекрывает окно
дублирования.

## 6. Ночная книга

Подписчик `billing:window_reset` в index.ts (после существующего fire-пути):
`appendLedger({night_date, reset_at, callsInWindow, input, output, cache_read,
armPhase, verdict})`. Токены окна берутся из state (callsInWindow уже там;
input/output/cache_read — аккумулировать в state onAfterProviderResponse —
3 числовых поля в State, писать под существующим lock, отдельного файла нет).
armPhase = getArmForKey(plan.key)?.phase ?? "none" на момент сброса.

## 7. Утренний отчёт

`ensureMorningTimer()`: при взводе плана и на session_start владельца —
setTimeout(unref) на wall-clock `toLocal` ближайшей ночи; сработал →
`buildMorningReport(plan, ledgerRows, historyRows)` (чистая функция в
nightplan.ts: группировка ledger-строк по reset_at, суммы токенов из history.csv
по интервалам окон, verdict/причина) → md-файл + notify. Причина простоя:
`idle` + armPhase=none → "no-arm (не был застрахован на момент сброса)";
armPhase=armed/pending и calls=0 → "delivery: см. armslog" (без парсинга armslog
в v1 — честная пометка, полный разбор глазами по утра).

## 8. Edge Cases

- Машина спала всю ночь: сгоревший morning-таймер (now > to + 30 мин) — тихо
  гасим, отчёт по требованию `/night-plan status` (показывает ledger ночи).
- План взведён днём (from в будущем): инвариант неактивен до from; morning-таймер
  взводится на ближайшие to.
- Смена сессии ночью (replacement): plan.key не перезаписывается автоматически —
  авто-rearm перевзводит флаг на plan.key; если сессия-владелец умерла (ключ
  сменён remapKey=carry) — инвариант продолжит страховать carry-ключ. При
  /night-plan в НОВОЙ сессии план перезаписывается на новый key.
- Два pi-процесса: действует только владелец state (NFR-014-4).

## 9. Version stamp

`export const VERSION = "014.2026-10-25"` в index.ts; в строке session_start
(withAttr) и в `/billing-status`; утренний отчёт шапкой `version: <VERSION>`.

## 10. Trade-offs

- Один активный план на аккаунт (не per-беседа): ночных марафон-сессий в
  практике одна; per-key планы — усложнение без подтверждённой потребности.
- Причины простоя v1 — частичные (без парсинга armslog): честная пометка
  вместо фантазий; полный классификатор — после первой недели телеметрии.
- Ledger пишет только процесс-владелец (как и вся механика reset).

## 11. Тестируемость

- nightplan.ts: `setPaths()` для tmp-каталогов (паттерн arms.ts), все тайминги —
  параметры; чистые функции interval/report — без моков.
- Тест-хуки в index.ts: `__nightPlanTickForTests()` (инвариант вручную),
  `__fireMorningForTests()`. Сьюты на коротких интервалах 10–50 мс.
- Гейты: tsc + новые сьюты + все существующие зелёные (регрессии недопустимы —
  смотрите exit-коды run_all_suites.sh, не только summary).

## 12. Observability

armslog-события: `night-plan:armed`, `night-plan:auto-rearm`, `night-plan:uninsured`,
`night-plan:morning-report`. notifer-типы: `billing:night-plan-rearm`,
`billing:night-plan-uninsured`, `billing:night-report`. Ledger + отчёты — файлы.
