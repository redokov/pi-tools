# Spec 012 — Tasks: absolute wake scheduler

## Header

- **Status:** tasks:draft
- **Requirements:** @requirements.md • **Design:** @design.md (§10 Sequencing — истина порядка слайсов; §17 R1–R3 — утверждённые решения)
- **Базовая дисциплина:** после КАЖДОЙ задачи — зелёный билд и зелёные тесты (`npm run build` + затронутые сьюты). Тикер продолжает работать параллельно с планировщиком до T7 (дедуп `lastResetAt + DEDUP_WINDOW_MS` сводит двойные вызовы `checkAndReset` к одному reset — design §8, FAQ).

## Coverage (кратко)

| FR / NFR | Tasks |
|----------|-------|
| FR-012-1 (файл+lock) | T2 |
| FR-012-2, FR-012-6 (якорь, автоинициализация) | T1, T4 |
| FR-012-3 (маржа 2 мин) | T1 |
| FR-012-4 (глубина 12, самовозобновление) | T1, T2, T4 |
| FR-012-5 (/settimer, reset) | T6 |
| FR-012-7 (setTimeout + sync-poller, дедуп) | T2, T4, T5 |
| FR-012-8 (существующий reset/fire-путь) | T3, T4 |
| FR-012-9 (429-ретрай, якорь возобновления) | T4 (следствие FR-012-2, без нового кода) |
| FR-012-10 (сгоревшие точки) | T1, T5 |
| FR-012-11 (note="wake HH:MM", /billing-status) | T3, T4, T6 |
| FR-012-12 (удаление тикера, about_to_reset) | T3, T4, T7 |
| NFR-012-1 (unref) | T2, T7 |
| NFR-012-2 (тихая деградация) | T2 |
| R1 (эпсилон 60 с) | T1 • R2 (полные 12 точек в /settimer) — T6 • R3 (arm-watchdog не трогать) — инвариант всех задач |

## T1 — wakeups.ts: константы + чистые функции (без I/O)

- **Приоритет:** Must (FR-012-2/3/4, R1) • **Зависимости:** нет
- **Work (src/wakeups.ts, design §4 Core Interfaces):**
  1. константы `WAKE_MARGIN_MS = 2*60_000`, `WAKE_DEPTH = 12`, `WAKE_BURNED_TTL_MS = 30*60_000` — экспортируемые;
  2. тип `WakeTable {version: 1; points: number[]; updatedAt: number; source: "firstCall"|"settimer"}`;
  3. чистые функции: `computeTableFromAnchor` (points = anchor + windowMs + margin + k·windowMs, k = 0..depth−1), `nextDuePoint` (минимальная не-сгоревшая: `p + WAKE_BURNED_TTL_MS > now`; null при пустой/сгоревшей), `dropBurnedPoints` (strict `now > p + ttl`), `appendAnchorPoint` (вставка anchor+windowMs+margin по возрастанию; **R1: точка ближе 60 с к существующей НЕ вставляется**; top-up хвоста до depth от последней точки; усечение свыше depth с конца — TD-004).
- **Tests (tests/test.mts, новый блок «wakeups pure functions»):** длина 12 и первый элемент anchor+w+m; шаг windowMs; nextDuePoint: пустая→null, будущая→она, прошедшая ≤TTL→она, сгоревшая→null, минимум из нескольких; dropBurnedPoints: граница ровно p+ttl не сгорает; appendAnchorPoint: вставка по возрастанию, top-up, усечение, **дубликат ближе 60 с не вставляется (R1)**.
- **Acceptance:** чистые функции детерминированы (I/O нет); новые тесты зелёные; существующий ticker-блок test.mts не тронут и зелёный.
- **Files:** `src/wakeups.ts` (create), `tests/test.mts` (modify — добавить блок).
- **Verify (gate):** `npm test` → exit 0; `npm run build` → exit 0.

## T2 — wakeups.ts: персистенция (lock) + wake-таймер-примитив (unref)

- **Приоритет:** Must (FR-012-1, FR-012-7, NFR-012-1/2) • **Зависимости:** T1
- **Work (src/wakeups.ts, TD-001/TD-003; паттерны state.ts/watchdog.ts):**
  1. `readWakeTable(): WakeTable | null` — толерантный sync-read как `readStateSync` (state.ts): нет файла/каталога → null; битый JSON, не-числовые points, version≠1 → null + **однократный** console.warn (флаг сбрасывается при успешном чтении); `points: []` легален;
  2. `mutateWakeTable(transform)` — одна мутация под proper-lockfile: маркер-файл `pi-billing-window-wakeups.lock`, lock-каталог, retry-бюджет как state.ts (retries 20, 100–200 ms); ELOCKED → тихий пропуск, не throw (NFR-012-2);
  3. one-shot таймер-примитив `armWakeTimer(whenMs, cb)` (unref, delay = max(0, when−now)), `clearWakeTimer()`, `hasRefForTests(): boolean | null` — отдельный handle, паттерн watchdog.ts.
- **Tests (tests/test.mts, блок «wakeups persistence & timer»):** write→read round-trip; битый JSON → null + warn один раз (второй вызов молчит); `points: []` читается; две параллельные mutateWakeTable не теряют точку; `armWakeTimer(...)` → `hasRefForTests() === false`; после `clearWakeTimer` → null.
- **Acceptance:** ни один кейс порчи wakeups.json не выбрасывает исключение; таймер не держит event loop.
- **Files:** `src/wakeups.ts` (modify), `tests/test.mts` (modify).
- **Verify (gate):** `npm test` → exit 0; `npm run build` → exit 0.

## T3 — reset.ts: дословный перенос checkAndReset + параметр note

- **Приоритет:** Must (FR-012-8, FR-012-11, FR-012-12; TD-002, TD-008) • **Зависимости:** T1 (механически; параллелизуемо)
- **Work:**
  1. создать `src/reset.ts`: перенести из ticker.ts ДОСЛОВНО `checkAndReset`, `DEDUP_WINDOW_MS`, `ABOUT_TO_RESET_MS`, `EmitFn`, `HistoryMeta`; единственное изменение сигнатуры — опциональный `note = "auto"`, попадающий в `appendHistory({kind: "window_reset", note})`; интервальную механику (TICK_MS, startTicker/stopTicker/hasRefForTests) НЕ переносить;
  2. `tests/test.mts`: импорт (строка 27, `../src/ticker.ts`) → `../src/reset.ts`; ticker-блок (302–460: null-state, не истекло, истекло+emit, дедуп, resetCount/callsInWindow/firstCallEmittedAt, about_to_reset) переключить на reset.ts, названия ассертов обновить по смыслу; добавить кейс: `note` попадает в history-строку, default "auto";
  3. `src/index.ts` и `src/ticker.ts` в этой задаче НЕ трогать (тикер продолжает работать, дедуп отфильтрует).
- **Acceptance:** test.mts зелёный на reset.ts; тикер и его вызовы в index.ts нетронуты; билд зелёный (ticker.ts ещё жив).
- **Files:** `src/reset.ts` (create), `tests/test.mts` (modify), `src/ticker.ts` (без изменений — удаляется в T7).
- **Verify (gate):** `npm test` → exit 0; `npm run build` → exit 0.

## T4 — index.ts: планировщик ensureWakeTimer + hook first_call + note="wake HH:MM"

- **Приоритет:** Must (FR-012-2/6/7/8/9/11, NFR-012-1) • **Зависимости:** T1, T2, T3
- **Work (src/index.ts, TD-005; точки интеграции — design §9 и FAQ §16):**
  1. импорт `wakeups.js` и `reset.js`; планировщик `ensureWakeTimer()` по паттерну `ensureGraceTimer` (index.ts:913): отменяет wake/about handle'ы, толерантно читает таблицу, `nextDuePoint` → `armWakeTimer(p, onWakeFire)`; about-таймер на `p − ABOUT_TO_RESET_MS` (если в будущем) → эмит `billing:window_about_to_reset` (Should, D-012); `stopWakeTimer()`; `onWakeFire`: consume головы под lock → `runGuarded(checkAndReset(emit, meta, "wake " + HH:MM(p)))` → `ensureWakeTimer()`;
  2. hook автоинициализации: в onAfterProviderResponse после записи `firstCallEmittedAt` (index.ts:2392–2393) — `mutateWakeTable(appendAnchor)` от свежего state + `ensureWakeTimer()`; событие `llm:first_call` (index.ts:2312) не менять по формату;
  3. перевзвод: listener `billing:window_reset`, `session_start` (существующий one-shot `checkAndReset` на 2257 сохранить), каждый fire; точки перевзвода — design §3 (список из 8 событий);
  4. fire-путь arms/grace/fireContinue НЕ трогать (D-008, FAQ); arm-watchdog НЕ трогать (R3).
- **Tests (tests/test.mts, блок «wake scheduler integration», tmp-пути по setPaths-паттерну, мок Date.now/короткие константы):** firstCall → таблица создана (source="firstCall"); сдвиг времени до точки → `billing:window_reset` в mock-emit + history-строка `note="wake HH:MM"`; голова потреблена, следующая точка взведена; спекулятивная точка до границы → no-op (без emit), точка потреблена.
- **Acceptance:** полный цикл якорь→точка→reset→history наблюдаем в тесте; тикер работает параллельно без двойных reset (дедуп); билд зелёный.
- **Files:** `src/index.ts` (modify), `tests/test.mts` (modify).
- **Verify (gate):** `npm test` → exit 0; `npm run build` → exit 0.

## T5 — index.ts: страховка в sync-poller + тихое погашение сгоревших

- **Приоритет:** Must (FR-012-7, FR-012-10; TD-007) • **Зависимости:** T4
- **Work (src/index.ts, интервал SYNC_POLL_MS — константа 325, колбэк 965–975):**
  1. в 60-с sync-тик рядом с `syncWatchdog()` (971): `nextDuePoint` → `now ≥ p` → тот же путь, что `onWakeFire` (consume + `checkAndReset` c "wake HH:MM") — идемпотентность через consume под lock + reset-дедуп;
  2. сгоревшая голова (`now > p + WAKE_BURNED_TTL_MS`) → `mutateWakeTable(purgeBurned)` БЕЗ стрельбы (тихо, FR-012-10); лавина точек после сна гасится одним purge;
  3. после каждой проверки — `ensureWakeTimer()`.
- **Tests (tests/test.mts):** таблица с точкой now−40 мин → sync-тик → точка погашена, emit НЕ вызван; точка now−2 мин (≤ TTL) → sync-тик → wake-путь (emit + note).
- **Acceptance:** опоздание доставки ограничено WAKE_MARGIN_MS + SYNC_POLL_MS; ни одного эмита в прошлое.
- **Files:** `src/index.ts` (modify), `tests/test.mts` (modify).
- **Verify (gate):** `npm test` → exit 0; `npm run build` → exit 0.

## T6 — команды: /settimer (обе ветки), /billing-reset, /billing-status

- **Приоритет:** Must (FR-012-5, FR-012-11; TD-006, R2) • **Зависимости:** T4
- **Work (src/index.ts):**
  1. `/settimer <N>`, N>0 (registerCommand 2663): после существующей state-мутации (`windowStartedAt = now − (windowMs − N)`; **`lastResetAt` НЕ трогать** — TD-006) — `mutateWakeTable(rebuild)` от `targetStartedAt`: **R2 — полные 12 точек через `computeTableFromAnchor`** (точка = now + N + маржа, хвост 2ч×k), source="settimer"; затем `ensureWakeTimer()`; существующий `syncWatchdog()` сохранить;
  2. `/settimer 0` и `/billing-reset` (2607): существующий немедленный reset без изменений; затем `mutateWakeTable(clear)` — `points: []`, source="settimer"; `ensureWakeTimer()` (точек нет → таймер снят);
  3. `/billing-status` (2551): дополнить вывод — «следующая точка: HH:MM» (локальное время `nextDuePoint`) либо «активной точки нет (окно не началось)» при `points: []` — не ошибка (US-002).
- **Tests (tests/test.mts):** программный вызов rebuild-логики `/settimer 60` → точка = now+60мин+маржа, хвост 12 точек шагом 2ч, `lastResetAt` не изменился (существующий ассерт сохраняется); ветка N=0 → `points: []`; форматирование статуса при наличии/отсутствии точки.
- **Acceptance:** `/settimer 60` перестраивает таблицу в 12 точек; после `/settimer 0` статус показывает «нет точки» до первого вызова.
- **Files:** `src/index.ts` (modify), `tests/test.mts` (modify).
- **Verify (gate):** `npm test` → exit 0; `npm run build` → exit 0.

## T7 — демонтаж тикера (одна задача, без промежуточного сломанного состояния)

- **Приоритет:** Must (FR-012-12, D-012, NFR-012-1) • **Зависимости:** T4, T5, T6
- **Work (единым коммитом/правкой):**
  1. `src/index.ts`: импорт `ticker.js` (42–47) → `checkAndReset` из `reset.js` (+ wakeups.js уже из T4); комментарий в шапке (строка 8) — описать планировщик; флаг `tickerStarted` (116) и `ensureTickerStarted` (~1871–1889) удалить; оба вызова запуска тикера (~2224–2230, комментарий 2087) → `ensureWakeTimer()`; `stopTicker()` в shutdown (1888) → `stopWakeTimer()`; все оставшиеся вызовы `checkAndReset` (1280, 2257, 2495, 2592) — из `reset.js`;
  2. удалить `src/ticker.ts` целиком;
  3. `tests/exit-hygiene.test.mts`: probe тикера (импорт 22, `startTicker/hasRefForTests/stopTicker` 50–57) → probe `armWakeTimer`: `hasRefForTests() === false` после взвода, `null` после `clearWakeTimer`;
  4. `tests/test.mts`: убедиться, что не осталось импортов/тестов ticker-интервала (блок уже на reset.ts после T3).
- **Acceptance:** `grep -rn "ticker" src/` пусто; билд и все сьюты зелёные; ни один таймер планировщика не держит event loop.
- **Files:** `src/ticker.ts` (delete), `src/index.ts` (modify), `tests/exit-hygiene.test.mts` (modify), `tests/test.mts` (verify/cleanup).
- **Verify (gate):** `npm run build` → exit 0; `npm test` → exit 0; `npx tsx tests/exit-hygiene.test.mts` → exit 0; `grep -rn "ticker" src/` → пусто; `bash scripts/run_all_suites.sh` → все сьюты exit 0.

## T8 — e2e-верификация + follow-up документация (вне кода спека)

- **Приоритет:** Should (Success Metrics, design §11 E2E, §7 UX) • **Зависимости:** T7
- **Work:**
  1. e2e (ручная, design §11): рабочий прогон с взведённым cont-after-reset — в history цепочка `kind="window_reset", note="wake HH:MM"` без дырок, «продолжи» уходит в idle-чат без ручного вмешательства; `/billing-status` показывает точку, совпадающую с расчётом; после `/settimer 0` — «нет точки» до первого вызова; `/billing-tick` (2578) — без изменений;
  2. change note в COMMANDS.md (`/settimer` управляет таблицей точек) и README — обязательный follow-up отдельным коммитом (вне рамок спека, requirements UX Notes).
- **Acceptance:** history без дырок при работающей машине; метрики Success Metrics наблюдаемы; follow-up зафиксирован.
- **Files:** docs (вне спека), ручной прогон.
- **Verify (gate):** `bash scripts/run_all_suites.sh` → все exit 0; ручной сценарий по чек-листу §11 пройден и зафиксирован в отчёте задачи.

## Порядок и инварианты

```text
T1 (чистые функции) → T2 (файл+lock+таймер) → T3 (reset.ts, параллелизуемо с T1)
     → T4 (планировщик в index.ts) → T5 (sync-страховка) → T6 (команды)
     → T7 (демонтаж тикера, единым шагом) → T8 (e2e + docs follow-up)
```

- После каждой задачи T1–T7: `npm run build` + `npm test` зелёные (тишер до T7 жив и работает параллельно — сломанного состояния нет).
- Инвариант всех задач: fire-путь arms, дедуп reset, paced-ретрай, arm-watchdog (R3) — не изменяются.

## T7 Addendum (оркестратор, 2026-10-24): watchdog unref

При приёмке T7 обнаружено: `watchdog.ts::armWatchdog` не делал `handle.unref()`
(ref'd setTimeout на границу окна ~2ч) — держал event loop любого встроенного
процесса (tsx-сьюты, тест-харнесы) до границы окна. Корневой баг существовал
до спека 012 (HEAD воспроизводится), T4-секция test.mts лишь вскрыла его
(первая гонка фабрики без session_shutdown teardown). Исправлено добавлением
`handle.unref()` с комментарием (unref-parity, spec 003/012). После фикса
test.mts: exit 0 за 4 с (202 passed), все сьюты run_all_suites зелёные
(единственный фейл в батче — флейк 120-с бюджета спавна под нагрузкой;
standalone exit-hygiene: 18/18).
