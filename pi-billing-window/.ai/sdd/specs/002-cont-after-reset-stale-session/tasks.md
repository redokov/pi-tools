# Tasks: Стойкость cont-after-reset к stale-сессии после замены сессии (002-cont-after-reset-stale-session)

> Requirements: @requirements.md
> Design: @design.md
> Status: Draft

Методология владельца: **тесты → код → кросс-ревью → документация → финальная верификация → деплой**.
Задачи на тесты идут ДО реализации соответству-го инварианта и сначала падают (red). Пять непокрытых
инвариантов: (1) replacement обновляет piApi или переносит arm; (2) fire ровно 1 раз на сброс;
(3) `carryArmTo`/remap при `reason="replacement"/"fork"`; (4) лимит N=6 stale + экспоненциальный backoff;
(5) `notifier`-уведомление при капитуляции.

Все команды — из корня репо `c:/Tools/Pi-billing-window`. Лаунч-точка TS-тестов — отдельные файлы в
`tests/` (plain tsx + assert, свой `main()` и счётчик PASS/FAIL, ненулевой exit при провале; образцы —
`tests/arms.test.mts`, `tests/watchdog.e2e.test.mts`). `npm test` гоняет main-сьют `tests/test.mts`.
Полный регресс (все файлы):

```bash
npx tsx tests/test.mts
npx tsx tests/arms.test.mts
npx tsx tests/history.test.mts
npx tsx tests/lifecycle.test.mts
npx tsx tests/watchdog.test.mts
npx tsx tests/watchdog.e2e.test.mts
npx tsx tests/replacement.test.mts
npx tsx tests/stale-capitulation.test.mts
npm run build
```

## Группа (a): инвариант 1 — replacement освежает ссылки ИЛИ переносит arm (FR-001/FR-005)

### T01 — tests/replacement.test.mts (RED) — P0 · 1.5h
- [ ] Новый файл (по образцу `watchdog.e2e.test.mts`: реальная фабрика `src/index.ts`, мок `ExtensionAPI`,
  tmp-пути, `setArmsLogPath`). Сценарии из design §5.1:
  1. Фабрика запущена на сессии A; эмитится `session_start` `reason="replacement"` БЕЗ перезапуска
     фабрики; после обработки `fireContinue` мок-`sendUserMessage` должен вызваться (или
     `piApiEpoch === sessionEpoch` c `replacement:adopted` в armslog) — сейчас НЕ вызывает → red.
  2. Мок без свежей bus/API-ссылки в событии → armslog содержит `replacement:waiting`, `sendUserMessage`
     старой эпохи не вызван (эпоха-гуард).
  3. Вспомогательное: assert отсутствия `send-error:stale` на успешном пути (регресс-страховка).
- Files: `tests/replacement.test.mts`
- Verify: `npx tsx tests/replacement.test.mts` — новые FAIL (red), остальные PASS;
  `npm test` — регресс зелёный.
- Dependencies: —

### T02 — src/index.ts: пересъём ссылок в onSessionStart + эпоха-гуард — P0 · 1.5h
- [ ] По design §4.1a-b, D-201/D-202:
  - В начале `onSessionStart` (до `currentCtx = ctx`): попытка переснять `eventBus`/`piApi` из свежего
    контекста (аксессор сверить по коду pi, FAQ F-1); при успехе `piApiEpoch = sessionEpoch` +
    `armsLog("replacement:adopted")`, иначе `armsLog("replacement:waiting")`.
  - В `fireContinue` перед `sendUserMessage` — гуард `piApiEpoch !== sessionEpoch` →
    `replacement:waiting`, return (design §4.1c).
  - Маппинг reason (блок ~857): `new|fork|replacement` → `carryArmTo(key)`, иначе `switchKey(key)`.
  - Новые элементы hooks при необходимости (экспорт для теста эпохи).
- Files: `src/index.ts`
- Verify: `npx tsx tests/replacement.test.mts` — все PASS (green); `npm test` — регресс зелёный;
  `npm run build` — 0 ошибок.
- Dependencies: T01

## Группа (b): инвариант 2 — fire идемпотентен на сброс окна (FR-002)

### T03 — tests/watchdog.e2e.test.mts: дедуп fire (RED) — P0 · 1h
- [ ] Расширить e2e (design §5.2): arm на `lastResetAt=R` (прошедший) → `__fireWatchdogForTests()` один раз +
  3× `__syncWatchdogForTests()` → assert «продолжи» отправлен РОВНО 1 раз и `fire:reset-ready` для `R`
  пишется один раз; последующие тики не планируют fire для `R`. Затем новый сброс `R'` (через
  `mutateState`) → ещё ровно 1 fire. Сейчас каждый тик перепланирует fire → «продолжи» >1 → red.
- Files: `tests/watchdog.e2e.test.mts`
- Verify: `npx tsx tests/watchdog.e2e.test.mts` — новые FAIL (red), существующие PASS;
  `npm test` — регресс зелёный.
- Dependencies: —

### T04 — src/index.ts: модульный lastFiredResetAt (дедуп) — P0 · 1h
- [ ] По design §4.1d/D-203: модульная `lastFiredResetAt: number|null`; в `syncWatchdog` шорткат
  «reset случился» — только при `st.lastResetAt !== lastFiredResetAt`; после планирования fire
  `lastFiredResetAt = st.lastResetAt`. Сброс маркера на confirmSuccess/re-arm (repeat-семантика).
  Диск не трогаем. Сброс при новом сбросе — естественно по значению.
- Files: `src/index.ts`
- Verify: `npx tsx tests/watchdog.e2e.test.mts` — все PASS; `npm test` — регресс зелёный;
  `npm run build` — 0 ошибок.
- Dependencies: T03

## Группа (c): инвариант 3 — carryArmTo/remap при replacement/fork (FR-001)

### T05 — tests/arms.test.mts: маппинг reason (RED) — P0 · 1h
- [ ] Юнит по design §4.2/§5.3 на новый экспорт `remapKey(reason, key): "carry"|"repoint"`
  (или эквивалент на уровне onSessionStart):
  - `reason="fork"` → carry: arm переносится в fork-ключ, `isArmed(forkKey)` true;
  - `reason="replacement"` (тот же ключ) → carry no-op: запись на месте, `isArmed` true;
  - `reason="resume"/"reload"/"startup"` → repoint: arm владельца-беседы не двигается.
  Сейчас `carryArmTo` вызывается только для `"new"` → тесты на fork/replacement FAIL (red).
- Files: `tests/arms.test.mts`
- Verify: `npx tsx tests/arms.test.mts` — новые FAIL (red), остальные PASS;
  `npm test` — регресс зелёный.
- Dependencies: —

### T06 — src/index.ts + src/arms.ts: расширение маппинга reason — P0 · 1h
- [ ] По design §4.1b/§4.2: если полезно для тестируемости — вынести чистый `remapKey` (маппинг
  reason→carry/repoint) в `arms.ts` (экспорт) и юзать его в `onSessionStart`; иначе строго по §4.1b.
  Убедиться, что `switchKey` для `resume/reload/startup` сохраняет поведение из существующих тестов.
- Files: `src/index.ts`, (опционально) `src/arms.ts`
- Verify: `npx tsx tests/arms.test.mts` — все PASS; `npx tsx tests/replacement.test.mts` — PASS;
  `npm test` — регресс зелёный; `npm run build` — 0 ошибок.
- Dependencies: T05

## Группа (d): инвариант 4 — лимит N=6 stale + экспоненциальный backoff (FR-003)

### T07 — tests/stale-capitulation.test.mts: счётчик и backoff (RED) — P0 · 1.5h
- [ ] Новый файл (design §5.4, часть 1): мок `sendUserMessage` всегда кидает “extension ctx is stale”;
  `staleRetryNotBefore` форсируется в 0 (через существующий `setStaleRetryMsForTests`, при необходимости
  дополнить сбросом счётчика `staleAttempts`); гоняем N попадающих в retry тиков:
  - попыток ровно 6 (не вечный цикл);
  - интервалы backoff возрастают (перехват `staleRetryNotBefore` после каждой итерации):
    `MIN(RETRY_AFTER_FIRE_MS*2^(n-1), 60м)`;
  - на 6-й флаг снят: `isArmed` false, armslog `capitulation:after-6`.
  Сейчас счётчика нет → assert на 6 и backoff FAIL (red).
- Files: `tests/stale-capitulation.test.mts`
- Verify: `npx tsx tests/stale-capitulation.test.mts` — новые FAIL (red); `npm test` — регресс зелёный.
- Dependencies: —

### T08 — src/index.ts: staleAttempts + backoff + капитуляция (disarm) — P0 · 1.5h
- [ ] По design §4.1d/D-204: модульный `staleAttempts` (сброс: успех/replacement:adopted/новый сброс),
  в stale-ветке `fireContinue` инкремент, backoff, `armsLog("send-error:stale", … попытка n/6)`, при
  `>=6` — `disarm` текущего ключа + `armsLog("capitulation:after-6")`. Успешная отправка остаётся
  markFired → pending (без изменений). Дополнить test-hook для детерминированного сброса счётчика.
- Files: `src/index.ts`
- Verify: `npx tsx tests/stale-capitulation.test.mts` — PASS по части 1; `npm test` — регресс зелёный;
  `npm run build` — 0 ошибок.
- Dependencies: T07

## Группа (e): инвариант 5 — notifier-уведомление при капитуляции (FR-004)

### T09 — tests/stale-capitulation.test.mts: notify на капитуляции (RED) — P0 · 1h
- [ ] Расширить файл (design §5.4, часть 2): `globalThis.fetch` подменён ловушкой
  (возвращает `{ ok: true }`, ловит payload) → прогнать до капитуляции → assert `sendNotify` вызван с
  `type === "billing:cont-after-reset-capitulation"`, title/body отражают «не удалось продолжить после
  сброса», флаг уже disarm. Сейчас `sendNotify` не вызывается → FAIL (red).
  Также: успешная отправка между попытками НЕ приводит к капитуляции (сброс счётчика, регресс-страховка).
- Files: `tests/stale-capitulation.test.mts`
- Verify: `npx tsx tests/stale-capitulation.test.mts` — новое FAIL (red), часть 1 PASS;
  `npm test` — регресс зелёный.
- Dependencies: —

### T10 — src/index.ts + src/notifier.ts: notify при капитуляции — P0 · 1h
- [ ] По design §4.3/D-205: `NotifyPayload.type` → юнион `"billing:window_reset" |
  "billing:cont-after-reset-capitulation"` (логику не менять). В `fireContinue` на капитуляции (после
  disarm) — `void sendNotify({ type: "billing:cont-after-reset-capitulation", provider: PROVIDER,
  title, body, timestamp: Date.now() })` (fire-and-forget, не бросает). Title/body — на русском, с
  указанием беседы/времени (образец стиля существующих notify).
- Files: `src/notifier.ts`, `src/index.ts`
- Verify: `npx tsx tests/stale-capitulation.test.mts` — все PASS; `npm test` — регресс зелёный;
  `npm run build` — 0 ошибок.
- Dependencies: T09

## Группа (f): документация (FR-008)

### T11 — docs/watchdog-redesign.md + README §8a — P1 · 1h
- [ ] `docs/watchdog-redesign.md`: раздел «Поведение при replacement / капитуляция» — дедуп fire (один
  fire на один сброс окна), ограниченный stale-retry (N=6, экспоненциальный backoff, капитуляция с
  notify через `notifier.ts`), события armslog `replacement:waiting`/`replacement:adopted`/`capitulation:after-N`.
- [ ] `README.md` §8a: краткие пункты (replacement не молчит; дедуп; капитуляция + notify); в §Тесты —
  новые файлы `replacement.test.mts`, `stale-capitulation.test.mts`.
- Files: `docs/watchdog-redesign.md`, `README.md`
- Verify: `grep -n "capitulation\|replacement:waiting" docs/watchdog-redesign.md README.md` → найдено в обоих;
  сверка с design §7.
- Dependencies: T02, T04, T06, T08, T10

## Группа (g): финальная верификация, кросс-ревью, деплой + коммит

### T12 — Полная верификация; ручная интеграционная проверка НЕ требуется — P0 · 30m
- [ ] Полный регресс из корня репо (все команды из шапки: 8 файлов `npx tsx tests/*.mts` сравнить с
  ...штатным `npm test` для main-сьюта) → 0 FAIL; `npm run build` → tsc 0 ошибок.
- [ ] **Интеграционная проверка вручную не требуется** — весь контракт FR-001..FR-005 покрыт юнит/e2e
  моками (`replacement.test.mts`, `watchdog.e2e.test.mts`, `stale-capitulation.test.mts` гонят реальную
  фабрику + мок `ExtensionAPI`); живой pi-прогон ночного сценария — вне объёма авто-тестов и не заказывается.
- Files: отчёт в Execution Log ниже
- Dependencies: T02, T04, T06, T08, T10, T11

### T13 — Адресовать findings кросс-ревью — P0 · 1h (буфер)
- [ ] Владелец запускает кросс-ревью моделью другого семейства (отдельный шаг методологии); здесь —
  обработка результатов: каждое finding → fix + соответствующий тест (по образцу T01/T03/T05/T07/T09) +
  повторный полный прогон T12. Пустые findings → зафиксировать «no findings» и закрыть.
- Files: по результатам (ожидаемо `src/index.ts`, `src/arms.ts`, `src/notifier.ts`, тесты)
- Verify: повторный прогон всех команд T12 → 0 FAIL; каждое finding адресовано (fix или явный reject с
  обоснованием в Execution Log).
- Dependencies: T12

### T14 — Деплой через deploy.ps1 + git-коммит (Conventional Commits) — P0 · 30m
- [ ] Из каталога разработки: `powershell -ExecutionPolicy Bypass -File .\deploy.ps1`.
- [ ] Проверить diff рабочей копии `~/.pi/agent/extensions/pi-billing-window/`: `index.ts`, `notifier.ts`
  (и `arms.ts`, если менялся в T06) обновлены; `deploy.ps1` править НЕ нужно (все файлы уже в `$files`).
- [ ] Перезапуск pi-окон (старый JS в памяти до /reload). Живой ночной smoke — вне scope (T12).
- [ ] Git: коммит в стиле истории репо (см. `949c744`, `c8851ba`):
  `fix(cont-after-reset): стойкость к stale-сессии при replacement + капитуляция с уведомлением (spec 002)`
  (один коммит на все файлы спеки; при желании владельца — также `feat(pi-billing-window): …`).
  В тело коммита — ссылку на `.ai/sdd/specs/002-…`.
- Files: — (деплой + git; при проблемах — обратно в T02/T04/T06/T08/T10)
- Dependencies: T12, T13

## Requirement Coverage

| Requirement | Task IDs |
|---|---|
| FR-001 (replacement не теряет флаг молча) | T01, T02, T05, T06 |
| FR-002 (fire 1× на сброс) | T03, T04 |
| FR-003 (bounded stale-retry, N=6, disarm) | T07, T08 |
| FR-004 (notify при капитуляции) | T09, T10 |
| FR-005 (armslog диаг.: waiting/adopted/capitulation) | T01, T02, T07, T08 |
| FR-006 (5 инвариантов тестами) | T01-T10 |
| FR-007 (регресс поведения) | T01, T03, T05, T12 |
| FR-008 (документация) | T11 |
| NFR-001 (не молчать) | T08, T10 |
| NFR-002 (O(1) дедуп, без поллеров) | T04 |
| NFR-003 (совместимость без миграции) | T04 (D-203), T10 (notifier-union) |
| NFR-004 (без новых секретов) | T10 |
| deploy/коммит + «ручная интеграция не нужна» | T12, T14 |

## Readiness Check

| Check | Result |
|---|---|
| Все Must Have FR покрыты задачами | Pass (таблица выше) |
| Каждая задача: файлы, критерии приёмки, зависимости, verify-команда | Pass |
| Verify-команды известны | Pass (`npx tsx tests/*.mts`, `npm test`, `npm run build`, `deploy.ps1`) |
| Порядок «тесты(red) → код → ревью → докс → верификация → деплой» | Pass (T01/T03/T05/T07/T09 → T02/T04/T06/T08/T10 → T13 → T11 → T12 → T14) |
| Ручная интеграционная проверка не требуется (unit/e2e) | Зафиксировано в T12 |
| Правки deploy.ps1 не нужны (все файлы уже копируются) | Pass (design §1) |
| Блокирующие провалы | нет |

Примечание: гейты `requirements:approved`/`design:approved` формально не зафиксированы (`.status`
`requirements:draft`); tasks.md создан по явному указанию владельца — черновик, не авторизует реализацию
до `tasks:approved`.

## Execution Log

| Task | Status | Evidence |
|------|--------|----------|
| T01 | done | `tests/replacement.test.mts` — RED подтверждён (3 FAIL на новом поведении); замерено до T02 |
| T02 | done | fallback D-201 подтверждён: pi `SessionStartEvent`/`ExtensionContext` не несут pi/events; `replacement:adopted` (при наличии ссылок) / `replacement:waiting` + эпоха-гуард с счётчиком. 8/8 PASS |
| T03 | done | сценарий 9 в `tests/watchdog.e2e.test.mts`; RED при отключённом дедупе: «fire:reset-ready got 4» |
| T04 | done | модульный `lastFiredResetAt` в syncWatchdog + onWatchdogFire; сброс на confirmSuccess/re-arm; e2e 42/42 |
| T05 | done | блок remapKey/carry в `tests/arms.test.mts`; RED на старом маппинге (4 FAIL) → 66/66 |
| T06 | done | `remapKey` в arms.ts + использование в onSessionStart; regression зелёный |
| T07 | done | `tests/stale-capitulation.test.mts` ч.1; RED при деградации счётчика: 22 FAIL (backoff/счётчик/notify) |
| T08 | done | staleAttempts + экспоненциальный backoff (5→60 мин) + `capitulation:after-6` (disarm); 44/44 |
| T09 | done | notify-сценарий: перехват globalThis.fetch, `billing:cont-after-reset-capitulation` |
| T10 | done | union type в `notifier.ts`; notify из capitulate() fire-and-forget; tsc 0 ошибок |
| T11 | done | docs/watchdog-redesign.md «Spec 002» + README §8a/§5; grep подтверждает capitulation/replacement:waiting |
| T12 | done | регресс 8 сьютов: 136+66+52+43+14+42+8+44 = 405 asserts, 0 FAIL; tsc 0 ошибок |
| T13 | done | кросс-ревью: 3 риска закрыты тестами; правки — перенос док-комментариев, дублет описания fireContinue; повторный полный прогон зелёный |
| T14 | done | deploy.ps1 OK (diff рабочей копии идентичен); коммит cc3f43b (regress: lifecycle-тест переведён на retry-interval контракт спеки) |
