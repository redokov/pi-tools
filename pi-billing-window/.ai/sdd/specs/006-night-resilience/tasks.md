# Spec 006 — Tasks: night-resilience (stale-ctx диагностика, межпроцессный дедуп, атрибуция, субагент-наблюдаемость)

> Status: Approved (оркестратор, 2026-09-27; исполняется по графу; коммиты — оркестратор после каждой зелёной задачи)
> Source: `.ai/sdd/specs/006-night-resilience/design.md` (Approved) + `requirements.md` (Approved)
> Исполнитель: субагенты wormsoft/*; **каждая задача = ОДИН последовательный субагент**.
> Ограничения субагентов: ТЕСТЫ+КОД — да; commit/push/deploy — НЕТ (решает оркестратор).
> Коммиты ставит оркестратор после каждого пройденного task'а.

## Глобальные ограничения (константа на все задачи, повтор из requirements/design, НЕ нарушать)

1. **Форматы `arms.json`/`state.json` неизменны** (D-004): ни одна задача не пишет в их схему; межпроцессный дедуп — только sidecar-маркер-файл вне профиля session (D-007).
2. **Словарь событий armslog НЕ расширяется** (D-006): вся атрибуция — аддитивно в деталях строк; новых слов событий не вводится.
3. **Каждый тест-сьют обязан завершаться** явным `process.exit(failed > 0 ? 1 : 0)` в конце (инцидент: replacement.test.mts «прошёл», но не exited; exit-hygiene гонит e2e-список и требует exit 0).
4. **Каждый прогон сьюта — под timeout 120 с** (`timeout 120 npx tsx tests/<имя>.test.mts`; exit-hygiene сам использует `SPAWN_TIMEOUT_MS = 120_000`).
5. **Регресс-база (NR-3): ≥443 asserts, 10 существующих сьютов, 0 FAIL** (+ новые сьюты аддитивно); капитуляционные/002-тесты без изменений ожиданий.
6. Логика `checkAndReset`/ticker и протокол pi не меняются; правки — только в части пути переусыновления / дедуп-маркера / атрибуции в рамках решений 006 (design §13).
7. **TDD-порядок жёсткий**: RED-задача пишет тест и доказывает FAIL; только затем GREEN-задача реализует и доводит до GREEN. Ни одна GREEN-задача не опережает свою RED.
8. Грепы/мониторы 004 (`scenario_monitor.py`, `run_a1.py`) работают без правок схемы: токены пишутся в КОНЕЦ detail после всей существующей семантики, через единый helper `withAttr` (без дублей токенов).
9. Хук-контракт тестов: `setPaths`/`setArmsLogPath`/`__syncWatchdogForTests`/`__fireWatchdogForTests`/`__retryTickForTests`/`__resetStaleStateForTests`/`setStaleRetryMsForTests`; моки `makeMockPi`/`makeCtx` по образцу `replacement.test.mts`/`lifecycle.test.mts`.

---

## T-01 — RED: `tests/attribution.test.mts` (атрибуция + признак stale-эпохи)

- **Dep:** —
- **Цель:** зафиксировать ожидания D-601/D-602/D-606 (FR-101/103/301/303): fire-путь-строки несут аддитивный блок ` key=… pid=… host=… ep=…`, признаки `ctx=stale src=…`/`epoch-mismatch=1`, без дублей токенов и без нарушения `.includes()`-подстрок старой семантики.
- **Файлы (создать):** `tests/attribution.test.mts` (новый, стиль replacement.test.mts: makeMockPi/makeCtx; форс `piApiEpoch !== sessionEpoch`; тестовый хук, если нужен, добавляет Green-пара — тест пишется первым).
- **Покрытие (~35-45 asserts):**
  - fire-путь-строки `fire:reset-ready`, `fire:send-ok`, `fire:confirmed`, `send-error`, `send-error:stale`, `replacement:waiting`, `replacement:adopted`, `capitulation:after-N`, `session-start`, `arm-seen`, `arm-gone` несут блок ` key=<basename> pid=<pid> host=<host> ep=<эпоха>` в КОНЦЕ detail;
  - helper не дублирует существующий `key=` (строки `session-start`/`arm-seen`, где `key=` уже есть) — ровно один токен каждого вида;
  - stale-эпоха (`piApiEpoch!==sessionEpoch`) → `send-error:stale` несёт `ctx=stale src=epoch-guard epoch-mismatch=1`; fire-планирование при мёртвых ссылках (в `onWatchdogFire` до `fire:reset-ready`) → `ctx=stale src=drain epoch-mismatch=1`;
  - probe-stale (`getSessionName` бросает) → `ctx=stale src=probe` на ближайшей fire-строке;
  - цепочка `1/6 ep=2 … 3/6 ep=7` различима по эпохам (каждая деталь сквозь прогрессию staleAttempts несёт свой `ep=`/`pid=`);
  - старые `.includes()`-подстроки (`"fire:send-ok"`, `"«продолжи»"` и т.п.) целы на атрибутированных строках.
- **Критерий приёмки:** `timeout 120 npx tsx tests/attribution.test.mts` → RUNS, `N passed, M failed (M>0)`, завершение через `process.exit` — **RED по причине отсутствия `withAttr`/probe** (не по ошибке загрузки).
- **Объём:** 1 новый сьют; asserts попадают в базу после GREEN T-02.

## T-02 — GREEN: probe (D-601) + `withAttr`-атрибуция (D-606) + признак (D-602) в `src/index.ts`

- **Dep:** T-01
- **Цель:** реализовать модульный probe `probePiAlive(): "live"|"stale"` (try/catch на `getSessionName`; ничего не шлёт, не бросает) и helper `withAttr(detail)` (модульные key/pid/host/ep + `staleAttr()`; добавляет ТОЛЬКО отсутствующие токены, никогда не переписывает существующие); признак D-602 в двух точках.
- **Файлы (править):** `src/index.ts` (модульные `probeState`/`probePiAlive()`/`withAttr()`/host&ep-получение; вызовы probe в `onSessionStart`, в цикле `syncWatchdog`, в начале `fireContinue` до epoch-guard; токен-блок на строках ниже). `src/armslog.ts` НЕ трогать. `src/arms.ts` НЕ трогать.
- **Несущие токены строки (FR-301):** `fire:reset-ready`, `fire:send-ok`, `fire:confirmed`, `send-error`, `send-error:stale`, `replacement:waiting`, `replacement:adopted`, `capitulation:after-N`, `session-start`, `arm-seen`, `arm-gone`. **НЕ трогаем** `watchdog:eval-error`, `watchdog:reset-error`, `block:no-pi`.
- **Критерий приёмки:** `timeout 120 npx tsx tests/attribution.test.mts` → GREEN (0 failed); существующие 10 сьютов по-прежнему 0 FAIL (атрибуция аддитивна).
- **Объём:** 1 новый сьют зелёный; asserts-база +≈40.

## T-03 — RED: `tests/firelease.test.mts` + `tests/firelease.e2e.test.mts` (+ RED-stub `src/firelease.ts`)

- **Dep:** —
- **Цель:** зафиксировать ожидания дедупа (FR-201..204, D-604/D-605) на юнитах (чистый модуль) и cross-process e2e; создать минимальный RED-stub экспортного API, чтобы сьюты грузились и FAIL'или по причине «нет логики», а не по отсутствию модуля.
- **Файлы (создать):** `tests/firelease.test.mts`, `tests/firelease.e2e.test.mts`, `src/firelease.ts` (RED-stub: только сигнатуры `acquireFireLease`/`releaseFireLease`/…, ветки „not implemented“: `ok:false` / «TODO»; НИКАКОЙ реальной логики).
- **Покрытие (юнит, ~35-45 asserts):** acquire через O_EXCL → `ok:true`; чужой живой маркер (TTL жив + pid жив) → skip `ok:false, holderPid`; takeover при истёкшем TTL → `ok:true, replaced:true`; takeover при «мёртвом pid»; release только при совпадении `pid`+`ep` (не сносит чужую аренду после takeover); два разных keyId → два независимых маркера (два fire); рестарт-имитация (второй инстанс, маркер на месте) → нет re-fire; TTL-константа = 10 мин; никаких persistent-таймеров (exit-parity).
- **Покрытие (e2e, ~15-20 asserts):** две независимые копии firelease-состояния на ОДИН маркер-каталог (эмуляция двух процессов файловой арендой) → ровно 1 `fire:reset-ready` на `(key, reset)`; два ключа на общий сброс → 2 fire (FR-201).
- **Критерий приёмки:** оба сьюта RUNS + FAIL (RED) с корректной причиной; каждый завершается `process.exit`.
- **Объём:** 2 новых сьюта; asserts-база +≈55 (после GREEN T-04/T-05).

## T-04 — GREEN: `src/firelease.ts` — реальный модуль арендного маркера

- **Dep:** T-03
- **Цель:** sidecar-аренда `(armedKey, lastResetAt)` атомарным `fs.openSync(path,"wx")` + TTL/pid-живость + lazy-takeover (bounded ≤3), TTL `FIRE_LEASE_TTL_MS = 10*60_000`, compare-and-remove release; каталог `~/.pi/agent/pi-billing-window-fires/<keyId>/<lastResetAt>.mark` (`keyId = sha1(armsKey).slice(0,16)`), JSON-формат design §6.1; без зависимостей от pi; без persistent-таймеров (единственный опциональный `setTimeout(unref)`).
- **Файлы (править):** `src/firelease.ts` (заменить RED-stub на реализацию). `src/index.ts` НЕ трогать (это T-05).
- **Критерий приёмки:** `timeout 120 npx tsx tests/firelease.test.mts` → GREEN (unit, без интеграции с index.ts); тест не держит процесс.
- **Объём:** юнит T-03 зелёный (e2e — после интеграции T-05).

## T-05 — GREEN: интеграция firelease в `src/index.ts` + exit-hygiene SUITES

- **Dep:** T-04
- **Цель:** единый helper `planFireForReset(st): Promise<boolean>` и врезка: (1) `onWatchdogFire` — lease-захват до `fire:reset-ready`; `!ok` → молчаливый skip (без лога, без `lastFiredResetAt`, без grace; watchdog на след. границу); `ok` → текущее поведение; (2) short-circuit `syncWatchdog` (~603-612) через тот же helper — при занятой аренде не трогать `lastFiredResetAt`, ставить watchdog на след. границу; (3) `fireContinue` — send-gating «аренда ещё моя» перед `sendUserMessage` (отобрана → не шлём, pacing); (4) release-точки: `fire:confirmed`, `capitulation:after-N`, disarm/`arm-gone`, ПЕРВЫЙ stale-failure (сохранять свой retry-цикл; повторный acquire перед следующей попыткой), non-stale `send-error`. Расширить `SUITES` в `tests/exit-hygiene.test.mts` новыми сьютами (attribution/firelease/firelease.e2e/session-isolation) + закрыть пробел `pending-window-retry`.
- **Файлы (править):** `src/index.ts` (helper/release-точки/lease-вызовы), `src/firelease.ts` (при необходимости экспортная поверхность), `tests/exit-hygiene.test.mts` (SUITES).
- **Критерий приёмки:** `firelease.test.mts` + `firelease.e2e.test.mts` GREEN; `exit-hygiene` green (все сьюты exit 0, timeout 120); существующие 10 сьютов 0 FAIL.
- **Объём:** asserts-база +≈55 (юнит+e2e); регресс 10 сьютов держится.

## T-06 — RED: `tests/session-isolation.test.mts` (owner-shift + guard)

- **Dep:** —
- **Цель:** зафиксировать ожидания FR-401/D-607 и (гейтируемого) FR-402/D-608: чужой `session-start` при живом delivery владельца даёт строку с деталью `owner-shift`, не перехватывает `currentCtx` и не трогает таймеры/epoch владельца.
- **Файлы (создать):** `tests/session-isolation.test.mts` (новый; моки makeCtx с разными session-файлами, reason=startup/resume чужого ключа при живом `armsGetArm()`/in-flight delivery).
- **Покрытие (~20-30 asserts):** (a) чужой `session-start` (другой key, reason=startup) → в detail строки `session-start` есть `owner-shift: K_old->K_new` (FR-401); (b) при `hasLiveOwnerInterest()` guard D-608 блокирует: `currentCtx` остаётся у владельца, `sessionEpoch` НЕ инкрементируется, `stopWatchdogTimers` не вызывается для чужой сессии; (c) `session-shutdown` дочерней сессии (чужой key) рано выходит ДО `sessionEpoch++`; (d) легитимный same-key и carry-сессия НЕ блокируются (ownerKey обновляется).
- **Критерий приёмки:** RUNS + FAIL (RED) по причине отсутствия ownerKey/guard; `process.exit`.
- **Объём:** 1 новый сьют; asserts-база +≈25 (после T-07).

## T-07 — GREEN: D-607 owner-shift + D-608 guard в `src/index.ts`

- **Dep:** T-06
- **Цель:** модульная `ownerKey: string | null`; в `onSessionStart` — деталь `owner-shift: K_old->K_new` при чужом ключе; guard D-608 строго до `currentCtx = ctx`: блок, если `ownerKey!==null && incomingKey!==ownerKey && remapKey(reason)==="repoint" && hasLiveOwnerInterest()` → лог `owner-shift(blocked)` и `return` без перехвата currentCtx/currentKey/piApi/eventBus/staleAttempts/таймеров. ownerKey обновляется ТОЛЬКО: первый session-start, совпадающий ключ, carry-причина, команда `/cont-after-reset`.
- **Файлы (править):** `src/index.ts`. `src/arms.ts` НЕ трогать (`remapKey` переиспользуется как есть).
- **Критерий приёмки:** `timeout 120 npx tsx tests/session-isolation.test.mts` → GREEN; существующие 10 сьютов 0 FAIL (легитимные fork/reload не задеты — lifecycle/replacement зелёные).
- **Объём:** asserts-база +≈25.

## T-08 — RED: FR-102 — форс-перерис после переусыновления (расширение существующих сьютов)

- **Dep:** T-02 (probe live → стабильный харнесс)
- **Цель:** зафиксировать «перерис на первом же тике после adopted»: задержка граница→`fire:send-ok` после переусыновления ≤ одного backoff-шага (≤5 мин), stale-цепочки старой эпохи после переусыновления прекращаются (FR-102).
- **Файлы (править):** `tests/replacement.test.mts` (+ сценарий: stale на границе → adopted → `__retryTickForTests()` даёт `fire:send-ok`; нет `send-error:stale` старой эпохи после adopted), `tests/watchdog.e2e.test.mts` (+ кейс перехода probe stale→live при in-flight delivery → форс-`fireContinue`).
- **Покрытие (+~8-12 asserts):** send-ok на первом же `__retryTickForTests`; `ep=` на send-ok = новая эпоха; ни одной stale-строки с `ep=` старой эпохи после adopted.
- **Критерий приёмки:** изменённые сьюты RUNS + FAIL по отсутствию форс-перериса; `process.exit`.
- **Объём:** аддитивно к 2 существующим сьютам.

## T-09 — GREEN: D-603 — сброс backoff + форс-перерис на переусыновлении/stale→live

- **Dep:** T-08
- **Цель:** единое правило D-603 (a/b/c): на `onSessionStart` в ветке `replacement:adopted` и на каждом sync-тике — если `probeState` перешёл stale→live ИЛИ первый после stale-цепочки успешный epoch-guard, И есть in-flight доставка/armed с `lastFiredResetAt === st.lastResetAt` → `staleAttempts=0; staleRetryNotBefore=0` + `ensureRetryInterval()` + `void runGuarded(fireContinue)` (после пере-проверки idle и lease). Переходы probe логируются аддитивно в следующую fire-строку (`src=probe`). Сценарий (a) `/reload` — уже здоров, без доп. действий.
- **Файлы (править):** `src/index.ts`.
- **Критерий приёмки:** FR-102-кейсы `replacement.test.mts` + `watchdog.e2e.test.mts` GREEN; существующие 10 сьютов 0 FAIL.
- **Объём:** asserts-база +~10.

## T-10 — GREEN-docs: FORMAT.md + docs/watchdog-redesign.md + README §8a (D-610/FR-303)

- **Dep:** T-02, T-07 (форматы/токены уже в коде)
- **Цель:** задокументировать грамматику токенов (design §7.1, D-610) и новые механизмы (firelease/owner-shift/guard) для мониторинга и читателей.
- **Файлы (создать):** `FORMAT.md` в `.ai/sdd/specs/006-night-resilience/` (единый префикс и порядок токенов ` key=… pid=… host=… ep=… [ctx=stale src=…] [epoch-mismatch=1]`, правило дедуп-токенов, список несущих строк, джойн `(key, host, ep)`, полный `path=` только в session-start). **Файлы (править):** `docs/watchdog-redesign.md` (токены/маркер/owner-shift/guard), `README.md` §8a (аддитивные токены + firelease/owner-shift).
- **Критерий приёмки:** документы согласованы с реализацией; `scenario_monitor.py`/`run_a1.py`-грепы парсят без правок схемы; `git status` по src — чисто (только .md).
- **Объём:** без asserts.

## T-11 — Деплой: `deploy.ps1` += firelease.ts + md5-диф src↔деплой

- **Dep:** T-05
- **Цель:** новый файл `src/firelease.ts` попадает в фиксированный список копирования (в отличие от 002, где правок не было); деплой-копия бит-в-бит совпадает с исходником. Фактический deploy/перезапуск делает оркестратор ПОСЛЕ этой задачи.
- **Файлы (править):** `deploy.ps1` (`$files` += `"firelease.ts"`).
- **Критерий приёмки:** 1) `grep -n "firelease" deploy.ps1` находит запись; 2) контрольный md5-диф всех `src/*.ts` + `package.json` между каталогом проекта и рабочим каталогом расширения — 0 различий (хелпер `scripts/diff_deploy.py` или powershell `Get-FileHash`); 3) deploy/запуск НЕ выполнять — только верификация готовности.
- **Объём:** без asserts (контрольная верификация).

## T-12 — E1-эксперимент: драйвер `reports/006-e1-subagent-stale.py` + отчёт

- **Dep:** T-07 (owner-shift/guard), T-09 (probe/перерис)
- **Цель:** детерминированный эксперимент «in-process субагент инвалидирует ctx родителя без события замены?» (Q-002, design §5.5) — доставляемый скрипт и честный отчёт YES/NO/UNKNOWN; журнал — единственный источник доказательства.
- **Файлы (создать):** `.ai/sdd/specs/006-night-resilience/reports/006-e1-subagent-stale.py`, `.ai/sdd/specs/006-night-resilience/reports/006-e1-report.md`. Харнесс: `rpc_harness.RpcSession`/`scenario_common.py` из `.ai/sdd/specs/004-live-scenario-testing/reports/` (без правок 004).
- **План шагов (design §5.5):** (1) `RpcSession(parent)` → ждать `session-start` родителя, снять key/pid/ep; (2) взвод arm (`/cont-after-reset`) → ждать `arm-seen`; (3) prompt на запуск in-process субагента → ждать `session-start` с ЧУЖИМ key (owner-shift); (4) форс-сброс окна родителя (`/settimer 0` или запись state) → наблюдать `ctx=stale src=probe` на fire-строке родителя; (5) ASSERT: owner-shift есть; за [child session-start, fire] НЕТ `session-start`/`replacement:adopted` родительского ключа; `src=probe` есть; вердикт YES/NO/UNKNOWN; (6) повтор после D-608: доставляется ли «продолжи» родителю после завершения субагента.
- **Критерий приёмки:** скрипт запускается, проходит или честно печатает NO/UNKNOWN; шаги воспроизводимы; отчёт фиксирует вердикт E1 и рекомендацию для FR-402 (Must/кандидат/закрыть).
- **Объём:** asserts в python-драйвере (~10-15), отчёт.

## T-13 — Регресс-гейт: полный прогон всех сьютов + assert-база + build

- **Dep:** T-02, T-05, T-07, T-09 (все GREEN-коллаборации на месте)
- **Цель:** документально доказать NR-3/ограничение 5: база ≥443 asserts, все 14 сьютов (10 существующих + attribution + firelease + firelease.e2e + session-isolation) — 0 FAIL, каждый под timeout 120, каждый завершается process.exit; сборка чистая.
- **Файлы (править):** при необходимости закрыть пробелы `tests/exit-hygiene.test.mts` SUITES (если не сделано в T-05). Без изменения логики.
- **Команды и ожидания:**
  - регресс: цикл по `tests/*.test.mts` c `timeout 120 npx tsx "$f" | tail -3` → каждая строка `N passed, 0 failed`;
  - суммарный `passed` по всем сьютам ≥ 443 (по отчётам сьютов);
  - `timeout 120 npx tsx tests/exit-hygiene.test.mts` → все сьюты exit 0;
  - `npm run build` → clean (type-check);
  - капитуляционные сьюты 002 (`stale-capitulation.test.mts`, `replacement.test.mts`) без изменений 0 FAIL.
- **Объём:** верификация + asserts-summary в отчёт.

## T-14 — Live-верификация ПОСЛЕ деплоя (A3/A4/B1/B2 + повтор night-mini)

- **Dep:** деплой оркестратором (T-11 применён, окна обновлены `/reload`); код из T-02..T-09/T-12.
- **Цель:** на живой pi-сессии подтвердить: атрибутированные строки дают однозначный вердикт, межпроцессный дедуп тих (1 `fire:reset-ready` на сброс на ключ), owner-shift/guard не ломают легитимные сценарии; night-mini по журналу → PASS (FR-302).
- **Файлы (создать):** `.ai/sdd/specs/006-night-resilience/reports/scenario-A3.md`, `scenario-A4.md`, `scenario-B1.md`, `scenario-B2.md`, `scenario-006-night-mini.md` (по форме 004-отчётов). Готовые драйверы из `.ai/sdd/specs/004-live-scenario-testing/reports/`: `run_live_t3_a3.py` (A3: внешний взвод, arm-seen ≤60с, доставка), `run_live_t3_a4.py` (A4: TTL/истёк — нет arm-seen/fire), `run_live_t3_night.py` (night-mini: arm → settimer 0 → send-ok → тишина 15 мин, 0 повторов, PASS по атрибуции), `run_live_t3_1.py` (шаблон RpcSession-драйвера для B1/B2).
- **Сценарии B1/B2 (по `scenarios.md` 004 + re-use RpcSession):** B1 — `/settimer 5m` реальная граница → watchdog-fire → grace ≈60±10с → доставка; B2 — взвод → `/reload` ДО границы → доставка ПОСЛЕ `session-start(reload)`, повторного fire того же сброса нет.
- **Критерий приёмки (таблица):** | A3: arm-seen ≤60с, доставка, флаг снят | A4: нет arm-seen/fire, нет негатива | B1: fire от watchdog, grace ≈60±10с | B2: доставка после session-start(reload), dedup жив | night-mini: 1 send-ok на сброс, 0 повторов, PASS по атрибуции через джойн `(key,host,ep)` |. Атрибуция: каждая fire-путь-строка несёт токены; дублей `fire:reset-ready` на `(key,reset)` нет.
- **Объём:** live-артефакты (логи/отчёты), без asserts кода.

---

## Readiness Check (Must-покрытие и маппинг требований)

| Requirement | Решение | Задачи | Тип | Готовность по задачам |
|---|---|---|---|---|
| FR-101 (признак epoch-mismatch) | D-601/D-602 | T-01, T-02 | Must | при GREEN T-02
| FR-102 (send-ok ≤1 backoff после переусыновления) | D-603 | T-08, T-09 | Must | при GREEN T-09
| FR-103 (счётчик по эпохе/процессу) | D-606 (ep=/pid=) | T-01, T-02 | Should | при GREEN T-02
| FR-201 (≤1 fire на (key,reset)) | D-604 | T-03, T-04, T-05 | Must | при GREEN T-05
| FR-202 (переживает рестарт) | D-604 маркер-файл | T-03, T-04 | Must | при GREEN T-04
| FR-203 (takeover stale-держателя) | D-604 release+TTL+pid | T-03, T-04, T-05 | Must | при GREEN T-05
| FR-204 (unref; защита от лока) | D-605 | T-03, T-04, T-13 | Should | при GREEN T-04
| FR-301 (токены на fire-пути) | D-606 | T-01, T-02 | Must | при GREEN T-02
| FR-302 (вердикт по журналу; night-mini PASS) | §7/§10; атрибуция | T-02, T-10, T-14 | Must | после T-14
| FR-303 (формат фиксирован, парсится) | D-610 | T-10, T-13 | Should | при GREEN T-10
| FR-401 (owner-shift) | D-607 | T-06, T-07 | Must | при GREEN T-07
| FR-402 (изоляция; гейт E1) | D-608 guard + E1 | T-06, T-07, T-12 | Should (гейт) | после вердикта E1
| NR-1 (не молчать; armslog не бросает) | firelease не трогает контракт | T-04, T-05, T-13 | Must | при GREEN T-13
| NR-2 (наблюдаемость вердикта) | токены читаются без правок | T-02, T-10, T-14 | Must | после T-14
| NR-3 (≥443 asserts, 10 сьютов, совместимость) | аддитивность | T-13 | Must | при GREEN T-13
| NR-4 (нет доп. пулла; unref) | D-605 lazy TTL | T-04, T-13 | Must | при GREEN T-13
| NR-5 (профиль-независимость; смерть держателя) | ~/.pi/agent/pi-billing-window-fires/ | T-03, T-04 | Should | при GREEN T-04
| E1 (Q-002) | §5.5 D-609 | T-12 | Must (достав.) | после T-12
| Деплой (новый src-файл) | D-610 | T-11 | Must | после T-11 (применяет оркестратор)
| Live-верификация после деплоя | A3/A4/B1/B2 + night-mini | T-14 | Must | после деплоя

Каждая Must-строка закрыта ≥1 задачей; каждая задача T-01..T-14 маппится на эту таблицу (ссылка в каждом блоке).

## Порядок исполнения (граф зависимостей)

```
T-01 ─► T-02 ─┬─► T-08 ─► T-09 ─┐
             ├─► T-06 ─► T-07 ─┼─► T-10 ─► T-13 ─► (деплой) ─► T-14
T-03 ─► T-04 ─► T-05 ──────────┘        │
                                         ├─► T-12  (T-07+T-09)
                                         └─► T-11  (T-05)
```

Задачи без межслойных зависимостей (T-01, T-03, T-06) инициализируются последовательными субагентами; RED-пары (T-01/T-02, T-03/T-04, T-06/T-07, T-08/T-09) исполняются строго парой, red первой. После каждого зелёного task'а оркестратор коммитит; при 429/отвале агента повтор начинается с того же task'а без потерь (тест-файлы уже на диске).

## Шпаргалка команд (для субагентов)

- Unit: `timeout 120 npx tsx tests/<имя>.test.mts`
- Регресс-сводка: `for f in tests/*.test.mts; do timeout 120 npx tsx "$f" | tail -2; done`
- Exit-hygiene: `timeout 120 npx tsx tests/exit-hygiene.test.mts`
- Type-check: `npm run build`
- Хуки: `__syncWatchdogForTests` / `__fireWatchdogForTests` / `__retryTickForTests` / `__resetStaleStateForTests` / `setStaleRetryMsForTests` / `setArmsLogPath` / `setPaths` (src/index.ts, src/state.ts, src/arms.ts, src/history.ts)
- E1/Live: `rpc_harness.py`, `scenario_common.py`, `run_live_t3_*.py` в `.ai/sdd/specs/004-live-scenario-testing/reports/` (без правок 004)
