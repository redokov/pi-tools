# Stage 0 — Факты и разведка (перед live-scenario тестированием)

Дата: 2026-09-2x. Репо: `C:\Tools\pi-billing-window` (ветка `master`,
последние коммиты: `176fbac` exit-hygiene spec 003, `608d1cc` T15 cont-after-reset).
Артефакт разведки. Только чтение/тесты, ничего не менялось.

## 1. Деплой: src репо vs рабочая копия расширения

- Рабочая копия: `~/.pi/agent/extensions/pi-billing-window/` — расширение там
  лежит **в исходниках .ts** (не скомпилированный .js); pi грузит `.ts`
  напрямую (tsx). В каталоге также `node_modules/typescript` (для
  self-hosted компиляции/запуска — артефакт сборки/установки).
- Diff по всем 10 файлам `src/*.ts` vs `~/.pi/agent/extensions/pi-billing-window/*.ts`
  → **все IDENtical** (arms, armslog, history, index, notifier, parser, state,
  ticker, ui, watchdog). Деплой актуален, в проде нет отличий от репо.
- `out/` в репо содержит только `meeting.manifest.json` — не относится к сборке.
- `deploy.ps1` копирует именно src/.ts список (`index,state,ticker,ui,parser,
  notifier,history,arms,armslog,watchdog` + package.json) в рабочую копию; тесты
  и docs не копируются. Вот почему ext-каталог имеет только эти файлы.

## 2. Базовый регресс

- Команда: `npx tsx tests/test.mts` → **136 passed, 0 failed** (EXIT=0).
  Покрывает formatDuration, parseDuration, notifier (пустой url / 401 / 200 /
  token / network error / timeout / 503), roundtrip.
- Полный набор .test.mts в репо `tests/` — **9 файлов**:
  1. `tests/test.mts` (базовый, 136 asserts — прогнан)
  2. `tests/arms.test.mts` (формат/фазы/TTL/remapKey)
  3. `tests/history.test.mts` (history.csv)
  4. `tests/lifecycle.test.mts` (9 сценариев)
  5. `tests/watchdog.test.mts` (юнит watchdog: computeFireAt/арм-таймер)
  6. `tests/watchdog.e2e.test.mts` (11 сценариев, реальная фабрика + мок pi)
  7. `tests/replacement.test.mts` (replacement/fork/resume/reload — spec 002)
  8. `tests/stale-capitulation.test.mts` (N=6 + backoff + notify — spec 002)
  9. `tests/exit-hygiene.test.mts` (unref всех таймеров — spec 003)
- Полный прогон всех 9 сьютов НЕ выполнялся (по ТЗ ниже гонялся только базовый).
- В рабочей копии расширения отдельно живут `test.mts` / `test-lifecycle.mts`
  — устаревшие копии тестов, в репозитории не актуальны (репо содержит
  полный набор выше).

## 3. Что должна делать механика (spec 002 + watchdog-redesign)

Источники: `.ai/sdd/specs/002-cont-after-reset-stale-session/{requirements,design,tasks}.md`,
`docs/watchdog-redesign.md`, `README.md §8a`.

- **Цель:** ночной агент, ведомый внешним скриптом `arm_cont_after_reset.py`,
  должен получить «продолжи» после сброса 2-часового окна ДАЖЕ после
  replacement/reload сессии; механизм либо доставляет, либо явно капитулирует
  с уведомлением — никогда не молчит и не висит вечным циклом.
- **Watchdog-модель:** one-shot таймер на границу окна
  (`computeFireAt = state.windowStartedAt + state.windowMs`), grace 60 c →
  `pi.sendUserMessage("продолжи")` (только не-idle), pending-ретраи каждые
  5 мин (`RETRY_AFTER_FIRE_MS`), синк-поллер 60 с только подхватывает внешние
  записи arms.json; ticker 5 мин — safety net. Poller 10 с удалён.
- **Инварианты spec 002:**
  1. Replacement не молчит: `session_start` переснимает `piApi/eventBus`
     (armslog `replacement:adopted`) либо пишет `replacement:waiting` +
     эпоха-гуард; маппинг `remapKey(reason)`: new/fork/replacement → carry,
     resume/reload/startup → repoint.
  2. Один fire на один сброс окна: модульный `lastFiredResetAt` (дедуп D-203).
  3. Капитуляция: stale-retry N=6 + эксп. backoff (5 мин→60 мин), на 6-й —
     disarm + armslog `capitulation:after-6` + notify через `notifier.ts`
     (`billing:cont-after-reset-capitulation`).
  4. T15 (инцидент 2026-09-27): доставка в полёте переживает sync-тики внутри
     grace и занятого агента (delivery-in-flight: grace не сбрасывается,
     retry-интервал доносит send). Сценарии 10/11 e2e.
- **Статус spec:** `.status` = `requirements:draft`; в tasks.md выполнены
  T01–T14 + T15; остаётся группа T12-верификация/T13-кросс-ревью отмечены,
  T15 [x]. Инцидентные логи: `diagnostics/arms-incident2-20260927-145610.log`.

## 4. Headless-возможности pi (как поднять сессию программно с задачей)

`pi --version` → **0.87.0** (`C:\Users\r.edokov\AppData\Roaming\npm\pi`).

- **Headless ДА:**
  - `pi --print|-p "задача"` — non-interactive: обработать промпт и выйти
    (one-shot, именно для live-сценария «ночной агент»).
  - `pi --mode json|rpc` — машинный вывод/protocol (rpc = программное
    управление сессией).
  - `pi --continue|-c` / `--resume|-r` / `--session-id <id>` — доадресация в
    конкретную сессию; `--fork` — форкнуть чужую сессию.
  - `--session-dir <dir>` — изолировать хранилище сессий (для тестовых
    песочниц), `--no-session` — эфемерно.
  - `--extension|-e <path>` / `--no-extensions|-ne` / `--skills|-s` / `--no-tools`
    — управление загрузкой расширений/инструментов.
  - Расширенный флаг: `--subagents-workflow-file=<path>` — прогнать workflow
    при старте (форма `=` обязательна).
  - `--provider <name>` / `--model <pattern>` — выбор провайдера/модели.
- **Ограничение/кавеат:** при старте выводится
  `FreeDeepseekAPI proxy not reachable at http://127.0.0.1:9655/health —
  Start it with: cd ~/.pi/mcp-servers/freedeepseek-api && node server.js`.
  Т.е. пакетный запуск с `--provider freedeepseek/deepseek` требует локального
  прокси; для live-теста надо либо поднять прокси, либо использовать другой
  провайдер (google — default). Модели вида `deepseek/*` НЕ замапились.
- **Команда запуска тестовой (headless) сессии (рекомендация):**
  `pi --print "задача" --provider <provider> --model <model> --session-id live-test-001
  --session-dir <тест.каталог> [--append-system-prompt ...]`
  (+ обязательно поднять freedeepseek прокси, если провайдер freedeepseek).

## 5. Внешний взвод: скрипт и контракт

- **В этом репо `scripts/` скрипта внешнего взвода НЕТ** — только
  `billing_report.py` (+ `tests/billing_report_test.py`). `arm_cont_after_reset.py`
  не существует ни в `c:/Tools`, ни в `~` (find ничего не нашёл).
- По README §8a и docs/DEV-WORKFLOW.md: `scripts/arm_cont_after_reset.py`
  живёт в **другом проекте `TabDocLoad`** (поддерживает `--repeat N`); здесь
  он только упоминается (src/index.ts:1111 — «external writer (night-agent
  helper scripts/arm_cont_after_reset.py)»).
- **Контракт внешнего взвода (что реально читает расширение):** прямая запись
  в `~/.pi/agent/pi-billing-window-arms.json` объекта `Arm` под ключом
  **файла сессии** (session path); подхватывается одним тиком sync-poller'а.
  Формат `Arm` (src/arms.ts):
  ```ts
  type Arm = {
    armedAt: number;            // epoch ms
    lastResetAtAtArm: number;   // state.lastResetAt в момент взвода (0 = любой следующий сброс)
    expiresAt: number;          // armedAt + ARMS_TTL_MS (8 ч)
    phase?: "armed" | "pending";
    lastFireAt?: number;        // только в pending
    repeat?: number;            // >1 = перевзвод на след. сброс; absent/1 = one-shot
  };
  type ArmMap = Record<string, Arm>; // key = session file path
  ```
- **Текущее состояние:** `~/.pi/agent/pi-billing-window-arms.json` = `{}`
  (2 байта, пустой — флаг не взведён), рядом `pi-billing-window-arms.lock`.
- **Покрытие контракта тестом:** `tests/watchdog.e2e.test.mts` **Scenario 6**
  (строки 561–623) — night-helper пишет `{ [sessionFile]: rec }` c
  `phase:"armed", repeat:1` → один `__syncWatchdogForTests()` → `isArmed()`,
  watchdog на границу окна, armslog `arm-seen`. Именно этот формат и должен
  воспроизвести live-тест внешнего взвода.
- Правка контракта в тестах: `setPaths(tmp)/resetPaths()` — тесты пишут в
  временные каталоги, НЕ трогая боевой arms.json.

## 6. Модули мониторинга / heartbeat

- **Нет.** В `src/` и `scripts/` нет heartbeat/мониторинга/метрик; каталога
  `utils/` нет. Ближайшие диагностические артефакты:
  - `armslog.log` (пишется в тот же каталог, что arms.json) — журнал событий
    взвода/fire/replacement/capitulation;
  - `diagnostics/arms-incident2-20260927-145610.log` — лог реального инцидента
    №2 (T15);
  - `history.csv` (§8b) — история вызовов;
  - `scripts/billing_report.py` — отчёт по биллингу/окнам (не мониторинг
    heartbeat-типа).

## 7. Замечания / отклонения (для учёта на след. этапах)

1. **README §8a рассинхронизирован внутри себя:** основной блок описывает
   watchdog-модель (sync-poller 60 с, poller 10 с удалён), но финальный абзац
   «Самовзведение флага агентом (ночная работа)» всё ещё описывает старую
   модель (`armed-poller`, «пустые тики (10 c)») — требует правки (задача
   T11 spec 002 не доведена до конца в этом хвосте).
2. `--subagents-workflow-file` — флаг **расширения**, форма обязана быть
   `--flag=value` (пробел «ест» следующий аргумент-промпт).
3. Провайдер freedeepseek требует локальный прокси :9655; дефолт — google.
4. В ext-каталоге лежат устаревшие `test.mts`/`test-lifecycle.mts` (не отсюда
   разработки) — не путать с репо-набором из 9 файлов.

## 8. Итоги одной строкой

| Вопрос | Ответ |
|---|---|
| Деплой актуален? | Да, 10/10 src .ts == рабочая копия ext |
| Базовый регресс | `test.mts`: 136 passed / 0 failed, EXIT=0 |
| Тестовых файлов | 9 *.mts в tests/ (8 сьютов + базовый) |
| Headless pi | Да: `-p/--print`, `--mode rpc`, `--session-id`, `--subagents-workflow-file` |
| Внешний взвод | Скрипт НЕ в этом репо (в TabDocLoad); контракт = прямая запись Arm в arms.json под ключом session-файла; Scenario 6 e2e |
| arms.json сейчас | `{}` (пусто), TTL 8 ч, файл `<key>=session-file` |
| Мониторинг/heartbeat | Нет; есть armslog.log + diagnostics/ инцидентных логов |
