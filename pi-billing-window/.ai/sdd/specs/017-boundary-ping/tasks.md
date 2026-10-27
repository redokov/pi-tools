# Tasks: Spec 017 — boundary-ping

> Status: implementation:done
> Design: design.md; Requirements: FR-017-1..12

## Readiness check

- Все Must Have FR покрыты задачами: FR-1,4,5,6,7,8 (T3/T4), FR-2,3 (T1/T2),
  FR-9,10 (T5), FR-11 (T2/T4), FR-12 (T5/T6).
- Открытых Questions нет (D-001..D-009 утверждены).
- Верификация: `npx tsc -p tsconfig.json`, `npx tsx tests/ping.test.mts`,
  все существующие tsx-сьюты, `python tests/billing_report_test.py`.

## T1 — ping.ts: конфиг + транспорт (FR-017-2, FR-017-3, NFR-017-1/2/4)

- deps: —; priority: Must; estimate: 1.5h
- [x] `loadPingConfig()` (models.json/auth.json, толерантно, `setPingConfigPaths`)
- [x] `sendPing()`: дерево попыток json → fallback-модель(400/404/422) →
      sse(400/404/405/406/415/501); таймаут 30 c unref; инъекция fetch/timeout
- [x] usage-парсер (legacy + input_tokens/cached_tokens)
- [x] тесты: конфиг (4 кейса), транспорт (6 кейсов), 429 без ретрая
- files: `src/ping.ts`, `tests/ping.test.mts`
- verify: `npx tsx tests/ping.test.mts` (секция T1) зелёная
- acceptance: sendPing возвращает {ok|limit|infra, mode, model, sentAt, usage?}

## T2 — инфраструктура состояния (FR-017-7, 11, 12)

- deps: T1; priority: Must; estimate: 1h
- [x] `PingState` + `State.ping?` в state.ts (type-only импорт)
- [x] `HistoryKind` + "ping" в history.ts
- [x] `insertRetryPoint()` в wakeups.ts (чистая, epsilon)
- [x] тесты: insertRetryPoint (epsilon/сортировка), ping-строка в CSV
- files: `src/state.ts`, `src/history.ts`, `src/wakeups.ts`
- verify: tsx-сьюты history/wake не сломаны
- acceptance: state.ts компилируется, kind="ping" пишется

## T3 — pingBoundaryFlow: машина границы (FR-017-1, 4, 5, 6, 7)

- deps: T1, T2; priority: Must; estimate: 2.5h
- [x] флоу: disabled/legacy → recorded-result → ping → ok(checkAndReset+
      applyPingAnchor) / limit(handlePingLimit) / infra(handlePingInfra)
- [x] идемпотентные handle* (§5.4 design)
- [x] `manualPing()` (FR-017-9: без lastBoundary/last429At/мутаций окна)
- [x] armslog ping:*, notify-инъекция, EventBus `billing:ping`
- [x] тесты флоу: кейсы 3–8 из design §10
- files: `src/ping.ts`, `tests/ping.test.mts`
- verify: `npx tsx tests/ping.test.mts` зелёный целиком
- acceptance: ok → верифицированный reset+якорь; 429 → подавление+re-anchor;
  infra → streak → слепой fallback; dedup по lastBoundary

## T4 — интеграция в onWakeFire (FR-017-1, 8)

- deps: T3; priority: Must; estimate: 1h
- [x] consume-guard `cur.points[0] === firedPoint` (баг-фикс двойного consume)
- [x] замена checkAndReset → pingBoundaryFlow (blindOnInfra=true)
- [x] burned-head: purge + probe (blindOnInfra=false)
- [x] VERSION bump
- files: `src/index.ts`
- verify: `npx tsc -p tsconfig.json`; lifecycle/wake-сьюты зелёные
- acceptance: wake-граница идёт через пинг; burned-head тих для слепого пути

## T5 — команды (FR-017-9, 10, 12)

- deps: T3; priority: Must; estimate: 1h
- [x] `/ping-wormsoft` (manualPing + тост)
- [x] `/billing-ping on|off|status`
- [x] строка пинга в `/billing-status`
- files: `src/index.ts`
- verify: tsc; ручная проверка команд в TUI (запись в отчёт ревью)
- acceptance: три команды работают, ping-off = legacy

## T6 — доки и индекс

- deps: T4, T5; priority: Must; estimate: 0.5h
- [x] README §8f (boundary-ping), COMMANDS.md (2 новые команды + статус-строка)
- [x] `.ai/sdd/INDEX.md` строка 017
- [x] проверка: billing_report.py не меняется (kind-фильтр уже "call"-only)
- verify: ручная вычитка
- acceptance: доки соответствуют реализации

## T7 — полная верификация

- deps: T1–T6; priority: Must; estimate: 0.5h
- [x] `npx tsc -p tsconfig.json`
- [x] все tsx-сьюты (включая новые) + `run_all_suites.sh` если применимо
- [x] `python tests/billing_report_test.py`
- [x] отчёт: команды, exit code, вердикт по каждой
- acceptance: всё зелёное; diff-поведение ping-off подтверждено тестами
