# ТЗ: Watchdog-driven cont-after-reset (redesign)

Проект: `C:\Tools\pi-billing-window` (репо `C:/Tools`). Рабочая копия: `~\.pi\agent\extensions\pi-billing-window`.

## Проблема

Сейчас cont-after-reset реализован как вечный poller (10 с), который на каждом тике читает arms.json + state и решает, не пора ли послать «продолжи». Reset детектируется лениво (ticker 5 мин), попытки paced 10 мин. Хочим точный watchdog вместо постоянного опроса.

## Новая модель (контракт)

1. **/settimer всегда взводит watchdog** на момент обнуления окна: `fireAt = state.windowStartedAt + state.windowMs` (при `/settimer <dur>` это `now + dur`).
2. **Watchdog сработал** (граница окна):
   - выполняем `checkAndReset()` (сброс окна, эвенты, история — как сейчас);
   - если взведён cont-after-reset — ждём `RESET_GRACE_MS` (60 с) и шлём «продолжи» (существующие guard'ы: только если агент idle, только не-stale pi);
   - пока процесс не пошёл (нет успешного ответа после отправки) — **попытки каждые 5 минут** (`ATTEMPT_INTERVAL_MS = 5 мин`, было 10 мин).
3. **Процесс пошёл** (первый успешный ответ провайдера после «продолжи», `confirmSuccess`):
   - `repeat > 1` → перевзвод (существующая логика arms.ts) + **watchdog на следующую границу** `state.windowStartedAt + state.windowMs` (≈ t+2 ч от сброса);
   - одноразовый → флаг снят, watchdog очищен.
4. **Poller 10 с удалён.** Вместо него медленный sync-poller (`SYNC_POLL_MS = 60 с`), его единственная задача — заметить внешние записи в arms.json (ночной helper-скрипт) и пересинхронизировать watchdog. Сам он никогда ничего не шлёт.
5. `/cont-after-reset [N|off]` — после arm/disarm вызвать resync watchdog. `/settimer` — после мутации state вызвать resync. session_start — resync. session_shutdown — остановить watchdog/retry/sync-poller (существующие epoch/stale правила сохранить).

Watchdog взводится по известной границе окна **всегда, когда есть живой state** (даже без arm'а) — тогда он при срабатывании делает точный reset без 5-минутного запаздывания ticker'а. Ticker (5 мин) остаётся как safety net, не менять. `checkAndReset` дедуплицирует двойные сбросы (последние <10 мин) — менять не надо.

### Сохранить (не ломать)

- Guard'ы: idle-проверка перед отправкой, stale-pi обработка (`staleRetryNotBefore`), epoch-проверки замены сессии, сериализация параллельных вычислений (`armedEvalInFlight` → аналог), `armsLog` диагностика.
- arms.ts: форматы файлов, фазы `armed`/`pending`, repeat-семантика, TTL. `RETRY_AFTER_FIRE_MS` меняет значение 10 мин → 5 мин (= `ATTEMPT_INTERVAL_MS`).
- Тест-хуки для детерминизма: вместо `__tickArmedForTests()` — `__syncWatchdogForTests()` (resync) и `__fireWatchdogForTests()` (принудительное срабатывание).

### Тестируемость

Все тайминги — параметры/константы модуля; тесты гоняют короткие интервалы (10–50 мс) и хуки, никаких реальных минут ждать нельзя.

## Разбивка (последовательно, минимальные токены)

### Task 1 — `src/watchdog.ts` + юнит-тесты
Новый модоль управления одним one-shot таймером на процесс:
- `computeFireAt(state: {windowStartedAt, windowMs}): number`;
- managed timer: `armWatchdog(fireAt: number, cb: () => void)` (clearTimeout + setTimeout, delay = max(0, fireAt-now)), `clearWatchdog()`, `hasWatchdog()`;
- юнит: `tests/watchdog.test.mts` (helpers + таймер на коротких задержках, повторный arm заменяет предыдущий, negative delay = немедленно).
- Гейт: `npx tsc -p tsconfig.json` && `npx tsx tests/watchdog.test.mts`.

### Task 2 — интеграция в `src/index.ts`
- Удалить `ARMED_POLL_MS` poller и `boundaryResetTimer`, заменить на watchdog + retry-interval (5 мин) + sync-poller (60 с).
- Встроить во все точки (см. «Новая модель» п.5). Гейт: tsc + все существующие тесты адаптировать и зелёить.

### Task 3 — e2e-сценарии (lifecycle-style, реальные файлы + мок pi)
Новый `tests/watchdog.e2e.test.mts` (по образцу lifecycle.test.mts), покрывает:
1. /settimer 30m при armed → watchdog взведён на now+30m (проверить fireAt);
2. watchdog fire → reset окна + «продолжи» отправлен (после grace), флаг → pending;
3. 429 → повторная попытка не раньше 5 мин, успешный ответ → confirmSuccess;
4. repeat>1 после confirm → watchdog перевзведён на новую границу (≈ t+2ч); одноразовый → arm снят, watchdog очищен;
5. внешняя запись в arms.json (ночной сценарий) подхватывается sync-poller'ом ≤60 с;
6. session_shutdown останавливает все таймеры (regression).

### Task 4 — deploy + docs
- `deploy.ps1`: добавить `watchdog.ts` в список копируемых файлов.
- README §8a/архитектура: кратко отразить watchdog-модель. Запустить deploy.
