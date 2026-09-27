# Feature: Стойкость cont-after-reset к stale-сессии после замены сессии (002-cont-after-reset-stale-session)

> Status: Draft
> Source: производственный инцидент — диагностика 2026-09-26 20:53–21:44 UTC (см. Incident Context)
> Scope: расширение `pi-billing-window` (репо pi-tools, каталог `c:/Tools/Pi-billing-window`)

## Overview

cont-after-reset («взведи флаг — продолжи работу после сброса окна» для ночного агента) опирается на
watchdog-механику (`src/watchdog.ts`, синк-поллер 60 с, grace-таймер, retry через `pi.sendUserMessage`).
При замене/перезагрузке сессии pi несколько звеньев цепочки теряют актуальность: ссылки на
`piApi`/`eventBus` захвачены только фабрикой, перенос arm'а делается только на `reason="new"`, одна
неудача отправки по stale уходит в бесконечный повторительный цикл вместо явной капитуляции. В итоге
«продолжи» не доставляется ни разу, а флаг молча сгорает по TTL (`arm-gone`).

Фича делает lifecycle стойким: при replacement сессионные ссылки обновляются (или arm переносится),
fire идемпотентен на один сброс окна, stale-retry ограничен (backoff, N=6, капитуляция с уведомлением),
диагностика в armslog различает «жду переусыновления» и «капитуляция». Биллинг-счёт, логика окна
(`checkAndReset`, ticker) и формат `arms.json`/`state.json` — вне scope.

## Incident Context (root cause, установлен 2026-09-26 20:53–21:44 UTC)

Производственный сбой: после замены/перезагрузки сессии pi watchdog каждые 60 с планировал fire, каждые
5 мин ловил «extension ctx is stale», «продолжи» в тред не попало ни разу за 50 минут, затем arm истёк
(`arm-gone`). Установленные причины:

1. **src/index.ts:1425-1426** — `piApi`/`eventBus` захватываются ТОЛЬКО фабрикой; `onSessionStart` их не
   обновляет. Replacement не перевыполняет фабрику → вечный stale.
2. **src/index.ts:473-478** — `syncWatchdog` перепланирует fire на уже случившийся сброс каждые 60 с
   (не идемпотентен per reset); `fireContinue` при stale не делает `armsMarkFired` → цикл
   «fire:reset-ready» каждые 60 с.
3. **src/arms.ts:162-165 + src/index.ts:857-863** — `switchKey` перепривязывает `currentKey`, но
   `carryArmTo` (arms.ts:196-217) вызывается только при `reason="new"`, не при replacement/fork →
   новая сессия не переусыновляет флаг.
4. **stale-retry не ограничен** (index.ts:201-213, 598-612) — вечный цикл вместо капитуляции.

## Business Context

- **Цель:** ночной агент, ведомый внешним скриптом `arm_cont_after_reset.py`, должен получить «продолжи»
  после сброса окна ДАЖЕ если сессия была заменена/перезагружена — без ручного вмешательства и без
  потери флага.
- **Сигнал ценности:** механизм либо доставляет «продолжи» и агент продолжает работу, либо явно
  уведомляет о капитуляции — но никогда не молчит и не висит вечным циклом.

## User Stories

### US-001: Replacement не теряет флаг молча
**As a** пользователь ночного агента cont-after-reset
**I want** чтобы после замены сессии этот же процесс продолжал мочь слать «продолжи»
**So that** флаг не сгорает молча (arm-gone) без единой доставки

**Acceptance Criteria:**
- После `session_start` с `reason="replacement"/"fork"/"resume"/"reload"` процесс либо обновляет
  `piApi`/`eventBus` (эпоха актуальна), либо переносит/переусыновляет arm в новую сессию: оба пути
  приводят к тому, что отправка «продолжи» снова возможна.
- Если ни один путь невозможен (ссылки не добыть) — **явное** действие: notify через `notifier.ts` +
  disarm, без тишины.
- `sendUserMessage` из старой эпохи не вызывается после replacement (guard по `piApiEpoch`).

### US-002: Один fire на один сброс окна
**As a** разработчик расширения
**I want** чтобы один и тот же сброс окна не порождал повторные fire каждые 60 с
**So that** нет шумового цикла «fire:reset-ready» и повторов отправки

**Acceptance Criteria:**
- Для `lastResetAt = R` отправка «продолжи» планируется **не более одного раза** за оконный сброс,
  сколько бы тиков sync-poller'а (60 с) ни прошло.
- Новый сброс с `lastResetAt' > R` снова разрешает один fire (repeat-семантика arm'а сохраняется).

### US-003: Капитуляция вместо вечного ретрая
**As a** пользователь ночного агента
**I want** чтобы при устойчивом stale механизм не ретраил вечно
**So that** я узнаю о проблеме (уведомление), а не обнаруживал флаг сгоревшим по TTL

**Acceptance Criteria:**
- После **максимум N=6** неудачных попыток отправки по stale: флаг текущей беседы снимается (disarm),
  в armslog пишется `capitulation:after-N`, уходит notify через `notifier.ts`.
- Между попытками — экспоненциальный backoff (возрастающие интервалы), не равномерный.
- Уведомление не требует новых секретов/токенов.

### US-004: Диагностика различима
**As a** разработчик расширения
**I want** по armslog отличать «replacement, ждём переусыновления» от «капитуляция после N попыток»
**So that** разбор ночного инцидента занимает минуты, а не восстановление по смутным следам

**Acceptance Criteria:**
- Новые события armslog: `replacement:waiting` (замена сессии, ждём переусыновления) и
  `capitulation:after-N` (капитуляция с N). Существующие события (`fire:reset-ready`, `send-error:stale`,
  `arm-gone`) остаются.
- Каждое событие — одна строка в `~/.pi/agent/pi-billing-window-arms.log`, не бросает исключений.

## Functional Requirements

### FR-001 — Replacement не теряет флаг молча — Must Have
WHEN сессия заменяется (replacement/fork/resume/reload) и в беседе взведён arm
THE SYSTEM SHALL обновить сессионные ссылки `piApi`/`eventBus` в `onSessionStart` ИЛИ перенести/переусыновить
флаг в новую сессию, так что «продолжи» снова отправляемо
AND WHEN ни один путь невозможен THE SYSTEM SHALL уведомить через `notifier.ts` и снять флаг — без молчания.

### FR-002 — Fire идемпотентен на одно оконное окно — Must Have
WHEN сброс окна `lastResetAt = R` уже обработан fire
THE SYSTEM SHALL НЕ планировать повторный fire для того же R (дедупликация по `lastResetAt`),
независимо от числа тиков sync-poller'а.

### FR-003 — Ограниченный stale-retry с backoff — Must Have
WHEN отправка «продолжи» падает с «extension ctx is stale»
THE SYSTEM SHALL повторить попытку с экспоненциальным backoff'ом, не более N=6 попыток за оконный сброс
AND WHEN лимит исчерпан THE SYSTEM SHALL disarm текущего arm и уведомить через `notifier.ts`.

### FR-004 — Капитуляция через notifier, без новых секретов — Must Have
WHEN срабатывает капитуляция (FR-003)
THE SYSTEM SHALL отправить уведомление тем же механизмом `notifier.ts` (существующий токен
`X-Notify-Token`/`PI_REMOTE_NOTIFY_TOKEN`), без ввода новых каналов доставки и секретов.

### FR-005 — Диагностика в armslog — Must Have
THE SYSTEM SHALL логировать в armslog различимые события: `replacement:waiting` и `capitulation:after-N`
(плюс `replacement:adopted` при успешном переусыновлении), сохраняя существующий формат строк.

### FR-006 — Тесты 5 инвариантов — Must Have
THE SYSTEM SHALL покрыть юнит/e2e-тестами (plain tsx + assert, hook-детерминизм без реальных минут,
по образцу `tests/watchdog.e2e.test.mts`) инварианты: (1) replacement обновляет piApi или переносит arm;
(2) fire ровно 1 раз на сброс; (3) `carryArmTo`/remap при `reason="replacement"/"fork"`; (4) лимит N=6 +
экспоненциальный backoff; (5) `notifier`-уведомление при капитуляции.

### FR-007 — Регресс существующего поведения — Must Have
THE SYSTEM SHALL сохранить: guard'ы idle/stale/epoch, repeat-режим (`repeat>1` перевзвод, confirmSuccess),
перенос на `/new`, TTL, дедупликацию двойных сбросов `checkAndReset`, тайминги watchdog по
`docs/watchdog-redesign.md`.

### FR-008 — Документация — Should Have
THE SYSTEM SHALL отразить новый lifecycle в `docs/watchdog-redesign.md` и README (§8a, `cont-after-reset`):
поведение при replacement, дедуп fire, капитуляция с уведомлением, новые события armslog.

## Non-Functional Requirements

### NFR-001 — Надёжность
- Контракт «не молчать»: любая недостижимость отправки заканчивается капитуляцией с уведомлением,
  а не вечным циклом. Ни один новый путь не бросает исключений наружу (fire-and-forget политика).

### NFR-002 — Производительность
- Дедупликация fire — O(1) сравнение `lastResetAt` (модульный маркер), без I/O и новых поллеров.
- Backoff — арифметика в памяти; новых таймеров сверх существующих (retry/grace/sync) не вводим.

### NFR-003 — Совместимость (без миграции)
- Формат `arms.json` и `state.json` НЕ меняется (дедуп-счётчики — состояние процесса, не файла).
  Существующие на диске `arms.json` остаются валидными. (см. Out of Scope)
- `notifier.ts` остаётся pure-модулем (без side-эффектов на импорте), API `sendNotify` не ломается.

### NFR-004 — Безопасность
- Уведомления используют существующий `X-Notify-Token`/`PI_REMOTE_NOTIFY_TOKEN`; новых секретов нет.

## Out of Scope

- **Изменение формата `arms.json`/`state.json` без миграции** — dedup/счётчики попыток живут в памяти
  процесса, не персистятся в файлы; формат фаз `armed`/`pending`, TTL и repeat-семантики не трогаем.
- **Биллинг-счётчик и логика окна** — `checkAndReset`, `ticker.ts`, `TRIM`, `billing_report.py` не
  меняются (инвариант FR-002 — про дедуп fire, не про счёт/reset-детект).
- **Протокол pi** — события `session_start`/`session_shutdown`, lifecycle и EventBus pi не модифицируются.
- **Конфигурируемость N и backoff** — константы модуля (N=6, base=RETRY_AFTER_FIRE_MS), не настройки.
- **Ретроспективная диагностика** — бэкфилл разбора старых инцидентов; только новые события вперёд.
- **Новые каналы доставки уведомлений** — только существующий `notifier.ts` → pi-remote.

## Decisions

### D-001 — Явная капитуляция, не вечный ретрай
**Decision:** при исчерпании N=6 попыток stale — disarm + notifier-уведомление, вместо бесконечного цикла.
**Reason:** инцидент показал, что вечный ретрай без markFired делает механизм бесполезным (50 мин,
0 доставок, arm-gone). Явная капитуляция переводит «тихий провал» в «известный провал с уведомлением».
**Impacts:** FR-003, FR-004, NFR-001.

### D-002 — Один fire на сброс окна (дедуп по lastResetAt)
**Decision:** один fire на один `lastResetAt`; повторные тики sync-poller'а не перепланируют fire для
того же сброса. Новый сброс разблокирует следующий fire (repeat-семантика сохраняется).
**Reason:** цикл «fire:reset-ready» каждые 60 с — прямой источник повторных попыток и шума; дедуп
устраняет причину, а не симптом.
**Impacts:** FR-002, FR-003.

### D-003 — Уведомление через существующий notifier.ts
**Decision:** notify при капитуляции (и при невозможности переусыновления) идёт через `sendNotify`
(`notifier.ts`), расширяя тип payload (новый type-литерал), без новых каналов и токенов.
**Reason:** механизм уже деплоится и авторизует X-Notify-Token; повторное использование — наименьшее
изменение (NFR-004).
**Impacts:** FR-003, FR-004, NFR-004.

### D-004 — Состояние процесса, не файла
**Decision:** дедуп fire и счётчик попыток — модульные переменные процесса (не поля `arms.json`).
**Reason:** «не менять формат arms.json без миграции» (Out of Scope); рестарт процесса естественно
перевзводит механизм (существующая семантика ре-усыновления arm'а).
**Impacts:** FR-002, FR-003, NFR-003.

## Questions

_(Открытых критических нет. Q-001 «как получить свежую ссылку pi/events в onSessionStart» — решается в
дизайне: пересъём из ctx/event, иначе B-путь переноса arm, иначе Notify+disarm; Q-002 «N конфигурируем?»
→ D-001/D-004: нет, константа модуля.)_

## Glossary

- **Extension ctx is stale** — ошибка pi при использовании `pi`/`ctx`, захваченных до замены сессии
  (docs: Session replacement lifecycle).
- **replacement / fork / resume / reload** — `reason` события `session_start` pi.
- **fire** — срабатывание watchdog'а: точный `checkAndReset` + планирование «продолжи» через grace.
- **capitulation** — капитуляция: disarm + notify после N неудачных stale-попыток.
- **armslog** — персистентный append-only диагностический лог `~/.pi/agent/pi-billing-window-arms.log`
  (`src/armslog.ts`), строки `ISO | event | detail`.
