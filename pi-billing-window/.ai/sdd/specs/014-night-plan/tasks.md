# Tasks: Spec 014 — night plan

> Design: @design.md
> Status: draft

## Task 1 — `src/nightplan.ts` + юнит-тесты

Чистый модуль (паттерн wakeups.ts/state.ts):
- константы путей + `setPaths()/resetPaths()` (tmp в тестах);
- `NightPlan` тип, `readPlan()`, `writePlan(plan)` (lock: proper-lockfile, retry-бюджет),
  `clearPlan()`;
- `parseHHMM(s)`, `inInterval(now, from, to)` (wrap полночь), `nextOccurrence(now, hhmm)`,
  `nightDateFor(now, from)`;
- `appendLedger(row)`, `readLedger(nightDate)`;
- `buildMorningReport(plan, ledgerRows, historyRows): string` (md, шапка version
  передаётся параметром);
- парсер строк history.csv (фильтр по epoch-диапазону, суммы input/output/cache_read).

Гейт: `npx tsc -p tsconfig.json` && `npx tsx tests/nightplan.test.mts` (≥25 кейсов:
интервалы incl. wrap/граничные, CRUD под lock, ledger roundtrip, отчёт-рендер).

## Task 2 — интеграция в `src/index.ts`

- `VERSION` const + withAttr-токен `v=` в session_start + показ в /billing-status;
- команда `/night-plan` (парсер аргументов: `off` | `status` | `[HH:MM-HH:MM] [repeat=N] [backlog=<path>]`);
- аккумулирование input/output/cache_read в State (3 поля, запись в существующем
  mutateState на after_provider_response, обнуление на reset);
- инвариант §5.1–5.2 в sync-тике (owner-guard, arm(), armslog, notify, rate-limit Map);
- гашение arm-gone-notify для ключа плана в интервале (§5.2);
- подписчик `billing:window_reset` → appendLedger;
- `ensureMorningTimer()` (unref, wall-clock, перевзвод на sync-тике и session_start
  владельца) + генерация отчёта + notify;
- тест-хуки `__nightPlanTickForTests()`, `__fireMorningForTests()`.

Гейт: tsc && `bash scripts/run_all_suites.sh` — все exit 0 (существующие сьюты
адаптировать минимально, семантику не менять).

## Task 3 — e2e-сюит `tests/nightplan.e2e.test.mts`

Lifecycle-style (мок pi, реальные tmp-файлы), сценарии из Acceptance requirements.md
(6 штук: auto-rearm после внешнего disarm; ledger used/idle; morning-отчёт в toLocal;
plan off; истёкший план; битый lock → uninsured с rate-limit).

Гейт: `npx tsx tests/nightplan.e2e.test.mts` && полный run_all_suites.sh зелёный.

## Task 4 — deploy + docs

- `deploy.ps1`: добавить `nightplan.ts` в список;
- README: раздел «Night plan» (команда, инвариант, ledger, отчёт, version stamp);
- CHANGELOG-строка в README; прогон deploy в рабочую копию;
- smoke вживую: `/night-plan status` (после рестарта pi пользователем).

Гейт: diff репо↔рабочая копия пустой по src/*; run_all_suites.sh зелёный.
