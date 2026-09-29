# Spec 008: piApi refresh + arm lifecycle после смены сессий

## Контекст (live-наблюдения 07:38Z–13:37Z, 2026-09-29)

Spec 007 закрыт (коммит f7239d5): D1 post-send verify + реверификация (3
чтения jsonl) работает стабильно — **4 полных живых цикла** (c:\Tools
05:46/07:38/11:38, TabDocLoad 12:04), каждый раз `fire:send-reverify` ловил
позднюю довпись → `fire:send-ok` → `fire:confirmed`. Confirm gating,
ownerQuiet, capitulate(cause), stale-тик ui.ts (крах pi от /reload) — всё
проверено живьём.

Но TabDocLoad не продолжился на сбросе #450 (13:37:32Z): **arm исчез в
13:10Z** (два arm-gone), к сбросу флага не было → fire не случился. Плюс
вскрылись два системных дефекта в цепочке смен сессий:

### C1: piApi пересняется только main()/shift — /cont-after-reset НЕ обновляет

`piApi` перезаписывается в двух местах (src/index.ts):
- main() при загрузке расширения (`piApi = pi`);
- session-start SHIFT-путь (`replacement:adopted`, `piApi = fresh.api`).

`/cont-after-reset` обновляет `currentCtx`/`ownerKey`/`armsSwitchKey`, но НЕ
piApi. После смены сессий (reload/new) fire продолжает падать с
send-error:stale, хотя команда перепривязала владельца — send-путь шлёт
через `p = piApi` (строка ~1238), а не через currentCtx.

### C2: probe «live» при мёртвом piApi — blocked съедает законную смену

Смена сессий в окне (07:49, 07:56, 08:01, 08:49 /new, 08:59, 10:38, 12:08,
12:35) переносила ключ arm на новейший файл (owner-shift, не blocked), но
последующие session-start с другим ключом были blocked: проверка
`hasLiveOwnerInterest()` + `probePiAlive() === "live"` сказала «live»,
хотя piApi вскоре оказался мёртв (fire → send-error:stale). Гипотеза: main()
при /reload пересняет piApi ДО стрельбы session-start hook → probe «live» →
blocked → ownerKey остаётся на старом файле → verify сверяет старый jsonl →
несоответствие ключ/разговор навсегда.

## План исправления (для новой сессии)

### T1: piApi/eventBus re-capture в /cont-after-reset handler
- В handler'е `cont-after-reset` (src/index.ts ~380): после
  `currentCtx = ctx; ownerKey = key; armsSwitchKey(key)` — вызвать
  re-capture свежих ссылок из ctx команды (как в shift-пути: `sessionBusOf`
  → `piApi = fresh.api; piApiEpoch = sessionEpoch; staleAttempts = 0;
  staleRetryNotBefore = 0` + `replacement:adopted`-лог). Команда получает
  СВЕЖИЙ ctx при каждом вызове — это универсальное восстановление без
  перезагрузки.
- Проверить сигнатуру `sessionBusOf(event, ctx)` — команде event не
  передаётся; возможно нужен вариант без event или вынести re-capture в
  хелпер `adoptFreshRefs(ctx)`.
- Тест: мок с мёртвым piApi → /cont-after-reset → piApi свежий → fire
  доставляет.

### T2: blocked-гейт по epoch, не только по probe
- В blocked-условии (~1585): добавить
  `piApiEpoch === sessionEpoch` — если ссылки принадлежат заменённой сессии,
  «live»-probe фиктивен (main() переснял ссылки, но ownerKey — нет) → смена
  должна пройти и ownerKey переехать на актуальный разговор.
- Тест: session-start с другим ключом при живом probe, но
  piApiEpoch !== sessionEpoch → смена проходит (не blocked), ключ + запись
  arms.json переехали.

### T3: arm lifecycle после confirmed
- Решить: confirmed → авто-перевзведение (arm живёт) или документировать
  `/cont-after-reset N`. Сейчас после confirmed флаг снят и arm-gone —
  пользователь обязан взводить заново после каждого сброса; в live это
  привело к «arm исчез к 13:10 → сброс без fire».
- Минимальный вариант: confirmed → `armsRearmSameKey(repeat-1)` при
  repeat>1; при repeat=1 — снять (текущее поведение). Документировать в
  README.

### T4: живой вердикт
- Перезагрузить/возобновить обе сессии, взвести `/cont-after-reset 3`
  в обеих, дождаться следующего сброса, сверить log.

## Инварианты (не ломать)

- Spec 006: foreign child session-start не блокирует доставку владельца;
  currentCtx владельца не переуказывается при живом ctx.
- Spec 007: реверификация (3 чтения jsonl, DELIVERED_REVERIFY_ROUNDS=3),
  confirm gating (только token-bearing), early pacing перед реверификацией.
- ui.ts: stale-тик пропускается молча (крах pi от /reload закрыт).
- Тесты: 14 сьютов exit 0 (~640 asserts), tsc чистый; round-trip не нужен
  (нет структурных правок метаданных).

## Файлы

- src/index.ts (fireContinue ~1238–1330, session-start hook ~1570–1650,
  /cont-after-reset ~380, probePiAlive ~225)
- src/ui.ts (interval try/catch — закрыто)
- tests/session-isolation.test.mts (blocked/e-stale-shift)
- tests/delivery-gating.test.mts (реверификация B/B2, misroute C)
- tests/exit-hygiene.test.mts (unref + stale-тик)
- State: pi-billing-window-arms.json (arm: phase/repeat/expiresAt),
  pi-billing-window-arms.log (маркеры), pi-billing-window.json (окно)
