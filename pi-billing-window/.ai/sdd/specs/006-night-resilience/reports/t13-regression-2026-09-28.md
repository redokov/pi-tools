# T-13 — регресс-гейт после T-08/T-09 (2026-09-28)

Прогон оркестратора лично, каждый сьют под `timeout 150 npx tsx`, код возврата 0 у всех.

| Сьют | Результат |
|---|---|
| tests/test.mts | 136 passed, 0 failed |
| tests/arms.test.mts | 66 passed, 0 failed |
| tests/watchdog.e2e.test.mts | 58 passed, 0 failed (было 56 — +2 FR-102) |
| tests/history.test.mts | 52 passed, 0 failed |
| tests/stale-capitulation.test.mts | 44 passed, 0 failed |
| tests/firelease.test.mts | 45 passed, 0 failed |
| tests/lifecycle.test.mts | 45 passed, 0 failed |
| tests/attribution.test.mts | 35 passed, 0 failed |
| tests/arms.test.mts (дубль-строки нет — это 66) | — |
| tests/replacement.test.mts | 16 passed, 0 failed (было 14 — +2 FR-102) |
| tests/session-isolation.test.mts | 26 passed, 0 failed |
| tests/firelease.e2e.test.mts | 20 passed, 0 failed |
| tests/pending-window-retry.test.mts | 14 passed, 0 failed |
| tests/watchdog.test.mts | 14 passed, 0 failed |
| tests/exit-hygiene.test.mts | 17 passed, 0 failed |

Итого 14 сьютов (включая tests/test.mts, который glob `tests/*.test.mts` не покрывает),
суммарно **577 asserts, 0 FAIL**. `npm run build` (tsc) — чистый, exit 0.

## Изменения

- T-08/T-09 (FR-102/D-603): `src/index.ts` — форс-перерис доставки после
  `replacement:adopted` (in-flight: `lastFiredResetAt === st.lastResetAt` →
  `void runGuarded(fireContinue)`); на sync-тиках при переходе probe stale→live
  или первом успешном epoch-guard после stale-цепочки — сброс
  `staleAttempts/staleRetryNotBefore` + `ensureRetryInterval()` + форс
  `fireContinue` (гейт: arm жив, probe live, тот же сброс). Тесты: +4 assert'а.
- T-11: `deploy.ps1` — `firelease.ts` добавлен в `$files` (11 файлов деплоя).
- Хелпер `resetStaleStateForTests()` в replacement.test.mts перестал быть
  no-op (импорт named-export вместо обращения к свойству фабрики).

RED→GREEN подтверждён: до T-09 новые assert'ы падали
(replacement 14/2, watchdog.e2e 56/2), после — 0 failed.
