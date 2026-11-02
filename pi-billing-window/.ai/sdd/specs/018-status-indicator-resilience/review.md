# Review: Spec 018 — status-indicator-resilience

> Status: review:done
> Date: 2026-11-02
> Verified against: requirements.md (FR-018-1..6), design.md (§3, §6), tasks.md (T1–T5)

## Verification evidence

| Command | Exit | Result |
|---|---|---|
| `npx tsx tests/test.mts` | 0 | **230 passed, 0 failed** (секция Spec 018: №1–10 все зелёные) |
| `npx tsc -p tsconfig.json --noEmit` | 0 | No errors found (strict) |
| `bash scripts/run_all_suites.sh` (25 сьютов) | 0 | все exit 0: arm-gone-notify 48, arms 90, attribution 35, delivery-gating, exit-hygiene 18, firelease.e2e 20, firelease 45, history 71, lifecycle 66, nightbacklog 22, nightcreate.e2e 16, nightcreate 22, nightplan.e2e 76, nightplan 100, nightrun-state 23, nightrun.e2e 28, nightrun 60, pending-window-retry 14, ping 66, replacement 34, session-isolation 68, stale-capitulation 69, watchdog.e2e 58, watchdog 15 — 0 failed |
| `python tests/billing_report_test.py` | 0 | 39 passed, 0 failed |
| Live-RPC проба (`python /tmp/rpc_test.py`, pi --mode rpc, glm-5.3-flash:NVFP4) | 0 | `extension_ui_request setStatus statusKey="billing-window" statusText="[обновится в 18:14]"` — путь setStatus жив; uidiag.log свежим процессом **не тронут** (mtime и 3 строки без изменений) |
| `powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1` | 0 | 22 файла скопированы, включая **uidiag.ts** (добавлен в список deploy.ps1 в рамках T5); `cmp` src/*.ts ↔ extensions/pi-billing-window/*.ts — все 20 .ts byte-identical, DIFF_FAIL=0 |

## Requirements coverage

| FR | Evidence |
|---|---|
| FR-018-1 applyStatus → код исхода | test.mts: «applyStatus: wormsoft + state -> 'ok'», «non-wormsoft -> 'cleared'» (+ setStatus(key, undefined)), «'bail:no-ui'», «no state file -> 'bail:no-state'», «null ctx -> 'bail:no-ctx'» |
| FR-018-2 uidiag JSON-lines + rate-limit + кап + глотание fs-ошибок | test.mts: «line has ts (ISO8601)/pid/reason/detail»; «consecutive same reason -> 1 line», «different reason -> new episode», «returning to a previous reason starts a new episode»; «cap -- >400 lines trimmed to the last 200», «cap keeps the newest»; «fs failure swallowed (never throws)». Модуль src/uidiag.ts (D-002), деплой подтверждён |
| FR-018-3 refreshStatusContext | test.mts: «swap applies the status to the new ctx immediately», «revived interval keeps ticking on the new ctx (incident reproduction)», «stale ctx does not throw» + «'refresh:stale-ctx' in uidiag», «non-tui ctx is quiet», «same ctx -> one apply per call (idempotent, no restart)», «binding unchanged» |
| FR-018-4 точки самопочинки index.ts | код: index.ts:2891 `refreshStatusContext(ctx)` (after_provider_response), :2921 `refreshStatusContext(ctx, event?.model?.provider)` (onModelSelect), :2577 после `stopStatusFn = startStatusUpdater(ctx)` (onSessionStart); VERSION = "018.2026-11-02" |
| FR-018-5 обновления из обработчиков не бросают | test.mts: «forceUpdate: never throws on a stale ctx», «stale ctx -> 'error'», «'force:error' in uidiag»; isTuiOrDiag в index.ts:1009 (marker), :2205 (window-reset); «stale ctx leaves 'refresh:stale-ctx'» |
| FR-018-6 (Should) счётчик неудач тика | test.mts: «tick: stale ctx grows the fail streak», «first failure of an episode leaves 'tick:error' in uidiag», «successful tick resets the streak to 0»; регресс spec 003: «updater interval stays unref'd (hasRef false)», «hasRefForTests null after stop» |

## Task mapping

| Task | Status | Evidence |
|---|---|---|
| T1 uidiag.ts + тесты №1–4 | PASS | все «uidiag:*» зелёные; setUidiagPathForTests/resetUidiagPathForTests |
| T2 ui.ts StatusOutcome/applyStatusSafe/refreshStatusContext/failStreak | PASS | тесты №5–10 зелёные, включая полную инцидент-репродукцию (stale ctx1 → tick:error → refreshStatusContext(ctx2) → тик оживает на ctx2) |
| T3 index.ts точки самопочинки + isTuiOrDiag | PASS | grep подтверждает 3 точки refreshStatusContext + isTuiOrDiag в marker/window-reset; lifecycle 66, replacement 34, session-isolation 68, ping 66 — 0 failed (регресс) |
| T4 README «Диагностика» | PASS | README.md §8h «Диагностика виджета статуса (uidiag, spec 018)» — путь, формат, rate-limit, кап |
| T5 полная верификация | PASS | таблица evidence выше; deploy с uidiag.ts, diff byte-identical |

## Findings

1. **deploy.ps1 не содержал uidiag.ts в списке копирования** — расширение было бы задеплоено без нового модуля, index.ts упал бы на import в рабочей копии. Fixed в рамках T5: добавлен в список (разрешённая правка вне src/). После фикса deploy зелёный, cmp всех .ts = identical.
2. Живой uidiag.log содержит 3 валидные строки `tick:error` от 2026-11-02 (pids 30500/14500/6128) — формат корректен, это след старого инцидента/тестов; свежий RPC-процесс новых строк не пишет (норма: живой ctx не отказывает).

## Ограничения верификации

- **Двух-оконная TUI-репродукция инцидента** требует живых TUI-окон пользователя — помечена как **manual**. Пользователю: в обоих окнах выполнить `/pbr-reload` для подхвата нового кода, затем `/settimer 10` и наблюдать футеры; при замерзании — `cat ~/.pi/agent/pi-billing-window-uidiag.log` покажет путь и причину отказа (JSON-lines с pid окна).
- Live-RPC проба подтверждает путь setStatus в свежем процессе, но не репродуцирует деградацию долго живущих окон (stale ctx) — эта ветка покрыта юнит-инцидент-репродукцией (тест №7) и ждёт manual-проверки.
- delivery-gating.test.mts не печатает сводку passed/failed, но exit 0.

## Merge readiness

READY — весь автотестовый контур зелёный (230 + 25 сьютов + 39 python), деплой в рабочую копию выполнен byte-identical (uidiag.ts включён), live-RPC путь setStatus подтверждён. Ручная двух-оконная проверка вынесена в чек-лист выше.
