# Tasks: Spec 019 — ночной дозор, пинг-самовосстановление, предстарт ночи

> Design: @design.md
> Status: done (T1–T4 исполнены 2026-11-11, все сьюты зелёные, деплой в рабочую копию выполнен)
> Порядок: 1 → 2 → 3 → 4 (3 зависит от 1 и 2; 4 — сборка/деплой всего).

## Task 1 — `src/nightsentry.ts` + юнит-тесты

Чистый модуль (паттерн nightplan.ts):
- константы `NIGHT_FROM = "22:00"`, `NIGHT_TO = "08:00"`;
- `inNightInterval(nowMs, fromHHMM?, toHHMM?)` (wrap полночи);
- `hoursBeforeNight(nowMs, fromHHMM): number` — сколько часов до начала
  ночи (для arm-gone-добавки «за 2 ч до ночи»);
- `checkNoArmGap(input): NightGap | null` — предикат FR-019-1
  (вход: nowMs, armed, planActive, nightFrom/To);
- `checkArmGoneNightGap(input): NightGap | null` — предикат FR-019-2
  (вход: nowMs, reason, nightFrom/To, graceMs = 2 ч);
- `dedupPassed(lastAt | undefined, nowMs, minIntervalMs)` — чистый дедуп;
- `buildNightCheckReport(input): { text: string; verdict: string[] }` —
  FR-019-5 (окно/взвод/план/пинг/вердикт, markdown-таблица);
- `SENTRY_DEDUP_MS = 3600_000`, `ARM_GONE_GRACE_MS = 2*3600_000`,
  `INFRA_ESCALATE_MS = 6*3600_000`, `PING_STREAK_THRESHOLD = 10`.

Гейт: `npx tsc -p tsconfig.json` && `npx tsx tests/nightsentry.test.mts`
(≥25 кейсов: интервалы incl. wrap/граничные 22:00/08:00, предикаты при
armed/plan-комбинациях, дедуп-границы, рендер сводки при всех разрывах).

## Task 2 — `src/ping.ts`: модель-фолбэк без зависимости от кэша + эскалация

- `readProviderModelIds(modelsFile, baseUrl): string[]` (толерантно,
  кэш 10 мин, setPaths-хук `setPingModelsFile`) и
  `pickFallbackModels(ids, exclude, limit = 3)` — чистая сортировка не нужна
  внутри (цены читает вызывающий тестовый/fixtures-слой: функция принимает
  уже отсортированный список);
- `sendPing`: шаг 2 выполняется при любой комбинации кэша mode/model —
  цепочка `primary → PING_FALLBACK_MODEL → pickFallbackModels(...)`;
- модель-ошибка = 400/404/422 (как сейчас), но фолбэк не зависит от
  `mode0 === undefined && primary === PING_MODEL`;
- эскалация FR-019-4: в месте учёта infraStreak — при
  `streak >= PING_STREAK_THRESHOLD && dedup(lastInfraNotifyAt, 6ч)` →
  `state.sentry.lastInfraNotifyAt` + notifier-оповещение (передаётся
  колбэком `onInfraEscalate`, чтобы ping.ts не знал ctx).

Гейт: `npx tsc -p tsconfig.json` && `npx tsx tests/ping-selfheal.test.mts`
(≥15 кейсов: 404 на закэшированной модели → фолбэк живой моделью,
закрепление модели, пустой список провайдера → infra, эскалация
дедуп-периода, сортировка выбора).

## Task 3 — интеграция в `src/index.ts` + `src/nightplan.ts`

- nightplan.ts: `readActivePlan()` (D-005) + перевод инварианта/отчётов
  на неё + armslog-пометка при уборке;
- index.ts: (a) крючок дозора в `after_provider_response`
  (FR-019-1: ночь + armed=false + плана нет + дедуп 1/ч → notifier +
  setStatus); (b) ночная добавка в arm-gone-переход (FR-019-2);
  (c) команда `/night-check` (FR-019-5) — чтение state/arms/plan/ping,
  `buildNightCheckReport`, вывод в чат; (d) связка эскалации пинга
  (onInfraEscalate → notifier);
- state.ts: расширение типа `State` полем `sentry?`
  (`lastNoArmNotifyAt?`, `lastArmGoneNightNotifyAt?`, `lastInfraNotifyAt?`).

Гейт: `npx tsc -p tsconfig.json` && все сьюты (`npm test` / run_all_suites):
202 + 48 + 18 + новые — все зелёные; вручную: `/billing-status` показывает
версию v=019.x.

## Task 4 — деплой и проверка на живом расширении

- `VERSION` → 019.1, `powershell deploy.ps1` в рабочую копию
  `~/.pi/agent/extensions/pi-billing-window/`;
- smoke в новой сессии: `/night-check` выводит сводку;
  state.ping.model обновится на живую модель при первом wake-пинге
  (проверка утром по `state.ping.lastDetail`);
- обновить `.ai/sdd/INDEX.md` (строка 019) и `.status`.

Гейт: рабочая копия содержит новые файлы (nightsentry.js), tsc чистый,
сводка `/night-check` на экране.
