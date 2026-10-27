# Review: Spec 017 — boundary-ping

> Status: review:done
> Date: 2026-10-27
> Verified against: requirements.md (FR-017-1..12), design.md, tasks.md (T1–T7)

## Verification evidence

| Command | Exit | Result |
|---|---|---|
| `npx tsc -p tsconfig.json` | 0 | типы чистые (strict, ES2022) |
| `npx tsx tests/ping.test.mts` | 0 | **66 passed, 0 failed** |
| `bash scripts/run_all_suites.sh` (25 сьютов) | 0 | все exit 0 (см. сводку ниже) |
| `npx tsx tests/test.mts` (вне глоба раннера) | 0 | 202 passed, 0 failed |
| `python tests/billing_report_test.py` | 0 | 39 passed, 0 failed |
| `powershell -File deploy.ps1` | 0 | рабочая копия обновлена (ping.ts задеплоен) |

Сводка раннера: arm-gone-notify 48, arms 90, attribution 35, delivery-gating, exit-hygiene 18,
firelease.e2e 20, firelease 45, history 71, lifecycle 66, nightbacklog 22, nightcreate.e2e 16,
nightcreate 22, nightplan.e2e 76, nightplan 100, nightrun-state 23, nightrun.e2e 28, nightrun 60,
pending-window-retry 14, **ping 66**, replacement 34, session-isolation 68, stale-capitulation 69,
watchdog.e2e 58, watchdog 14 — 0 failed во всех.

## Requirements coverage

| FR | Evidence |
|---|---|
| FR-017-1 пинг гейтит reset | ping.test: «ok -> checkAndReset выполнен», «429 -> reset подавлен», «recorded ok -> reset без пинга» |
| FR-017-2 модель gpt-oss:20b + фолбэк | ping.test: «400 на основную -> фолбэк-модель 200» (модель и фолбэк-запрос проверены по телу запроса) |
| FR-017-3 stream:false → sse-фолбэк + кэш режима | ping.test: «протокольная ошибка -> sse-фолбэк», «sse-запрос со stream=true»; mode/model кэшируются в recordAutoResult (тест «lastStatus/lastAt записаны» + ok-path) |
| FR-017-4 429: re-anchor / unknown retry / кап | ping.test: «429 -> windowStartedAt := firstCallEmittedAt», «таблица перестроена от fc», «retry-точка +10 мин», «cap -> notify ровно один», «recorded 429 после re-anchor -> no-op» |
| FR-017-5 infra: retry → слепой fallback | ping.test: «infra x3 -> слепой reset», «notify fallback ровно один», «no-config -> streak=1, retry-точка»; burned-кап 30 (тест 3.8b) |
| FR-017-6 пинг якорит окно | ping.test: «якорь пинга: firstCallEmittedAt = sentAt», «wake-таблица перестроена от пинга» |
| FR-017-7 dedup lastBoundary | ping.test: «recorded ok -> reset без пинга» (fetch не звался); state.ping переживает reset (фикс reset.ts: `ping: state.ping`) |
| FR-017-8 burned-head probe | ping.test: «burned ok -> верифицированный reset», «burned infra x3 -> слепого reset НЕТ», burned-кап |
| FR-017-9 /ping-wormsoft | ping.test (manualPing): ok/429, «lastBoundary НЕ записан», «last429At НЕ записан», «окно НЕ тронуто», history note=manual |
| FR-017-10 /billing-ping on/off/status | setPingDisabled тесты (вкл/выкл + bootstrap без state); команда в index.ts |
| FR-017-11 пинг невидим механизмам окна | транспорт мимо пайплайна pi (нет after_provider_response); manualPing не пишет last429At; авто-429 пишет last429At намеренно (pacing) |
| FR-017-12 наблюдаемость | history kind=ping/429-строки (тесты читают CSV), armslog ping:*, notify-пейдгоады (рекордер в тестах), `billing:ping` на шине, строка ping= в /billing-status |

## Findings / fixes made during implementation

1. **reset.ts терял `ping` при reset** — checkAndReset строит State заново; без фикса
   `ping.lastBoundary` (dedup) и кэш mode/model пропадали на каждом reset. Fixed:
   `ping: state.ping` в transform. Покрыто тестом «ok -> ping.lastBoundary записан».
2. **consume-guard в onWakeFire** (баг-фикс spec 012, найден при проектировании):
   два процесса на одной wake-точке съедали две точки (`slice(1)` дважды). Fixed:
   потребление только при `cur.points[0] === firedPoint`.
3. **Retry-точки при отсутствии wake-файла** — mutateWakeTable с `cur === null`
   молча не создавал таблицу. Fixed: bootstrap таблицы с одной retry-точкой.
4. **Burned-путь infra без капа** — слепой fallback там запрещён, ретраи были бы
   бесконечными. Fixed: `PING_INFRA_BURNED_MAX = 30` + однократный notify
   (design §5.3 дополнен).
5. **setPingDisabled без state-файла** — no-op. Fixed: bootstrap минимального state.

## Deviations from design

- **D-007 реализован через state-маркер вместо firelease** (запланировано в design):
  `ping.lastBoundary` — авто-failover при смерти пингующего в полёте, без TTL-ожидания;
  race-окно секунд допускает редкий двойной пинг (0.12 кр — ничто). Тесты покрывают.

## Manual verification (осталось пользователю)

- [ ] Живой `/ping-wormsoft` в TUI-сессии (ожидание: `200 OK … gpt-oss:20b`).
- [ ] Живая граница окна: ближайший wake-fire с пингом (armslog `ping:ok`,
      history kind=ping) — проверить после ближайшего сброса окна.
- [ ] `/billing-ping off` → следующая граница вслепую (armslog без ping:ok),
      затем `/billing-ping on`.

## Merge readiness

READY — весь автотестовый контур зелёный, деплой в рабочую копию выполнен,
ручные проверки вынесены в чек-лист выше (требуют живой TUI-сессии).
