# Feature: Model column in history CSV (001-model-in-history)

> Status: Draft
> Source: запрос пользователя (сессия 2026-09-16)
> Scope: расширение `pi-billing-window` (репо pi-tools, каталог `c:/Tools/Pi-billing-window`)

## Overview

Расширение пишет per-call историю в `~/.pi/agent/pi-billing-window-history.csv`, но не логирует
имя модели. Анализ «какая модель сколько сожгла» требует ручного маппинга по времени/сессиям.
Фича добавляет колонку `model` в CSV-строку вызова, разрез по моделям в `billing_report.py`
и обновляет документацию.

## Research Findings (для архитектора)

Исходники проверены: `src/index.ts`, `src/history.ts`; типы pi SDK
(`dist/core/extensions/types.d.ts`, pi-ai `dist/types.d.ts`); расширение `@tintinweb/pi-subagents`
(`~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents/src/agent-runner.ts`); живые сессионные
файлы `~/.pi/agent/sessions/`.

### Откуда брать имя модели — вывод

**Первичный источник: `ctx.model.id`** — уже доступен в обработчике `after_provider_response`
(`src/index.ts::onAfterProviderResponse`), там же, где сейчас читается `ctx.model.provider`
для фильтрации по провайдеру. Расширение уже полагается на `ctx.model` в этом хуке — доверие
тот же уровень.

Точные имена полей (pi-ai, `Model<TApi>`):

| Поле | Тип | Пример значения |
|---|---|---|
| `ctx.model.id` | `string` | `"zai/glm-5.3"`, `"minimaxai/minimax-m3"`, `"wormsoft/agent/high"` |
| `ctx.model.name` | `string` | `"zai/glm-5.3"` (в `~/.pi/agent/models.json` чаще всего = id) |
| `ctx.model.provider` | `ProviderId` | `"wormsoft"` |

Именно `id` пишется в сессионные файлы как `model_change.modelId` и как
`AssistantMessage.model` (проверено на живом `.jsonl`: `"model":"zai/glm-5.3"`). То есть
`id` — каноническое имя модели в pi, оно же фигурирует во всех остальных артефактах pi.
`provider` в `id` НЕ входит (id = `"zai/glm-5.3"`, не `"wormsoft/zai/glm-5.3"`).

**Событие `after_provider_response` модель НЕ несёт** — подтверждено по типам
(`AfterProviderResponseEvent = { type, status, headers }`) и по коду эмиттера
(`dist/core/sdk.js::onResponse` — прокидывает только `response.status`/`response.headers`;
callback получает `_model`, но в событие его не кладёт). Других событий с моделью на
момент вызова нет.

**Вторичный/альтернативный источник: `AssistantMessage.model`** — записи сессии
(`ctx.sessionManager.getEntries()`), которые `lastAssistantUsage()` уже сканирует для
usage-токенов. Поля `AssistantMessage`: `model: string` (проверено), `responseModel?: string`.
⚠️ Ограничение: `after_provider_response` стреляет «после получения HTTP-ответа, до
потребления стрима», поэтому последняя assistant-запись в сессии может быть ещё
предыдущим ответом — для модели (стабильной в рамках сессии) это не критично, для
usage расширение уже живёт с этой семантикой. Для колонки `model` надёжнее `ctx.model.id`.

**Fallback:** `ctx.model` может быть `undefined` (ранний startup / RPC-режим —
см. комментарий в `index.ts`); тогда пишем пустое значение в колонку (не `"unknown"` —
пустая ячейка консистентна с существующими nullable-колонками `input`/`output`, а
`"unknown"` породило бы фантомную «модель» в отчёте).

### Subagent-вызовы

- Subagent-сессии pi-subagents — это дочерние `AgentSession` **в том же процессе**, и
  «Child AgentSessions load normal extensions» (`agent-runner.ts:302`), т.е.
  `pi-billing-window` получает их `after_provider_response` с их собственным `ctx.model`.
  → Модель субагента попадёт в историю корректно, отдельной логики не нужно.
- **Признак main-loop/subagent НЕ вводим:** файлы сессий структурно не различаются
  (nested-сессии по умолчанию in-memory → `sessionKeyOf()` даёт `ephemeral:<pid>`;
  персистентные пишутся в тот же каталог с тем же форматом имени, отличаясь только
  опциональным `parentSession`-метаданными внутри файла). Надёжного дискриминатора на
  уровне расширения нет — колонку не выдумываем.

### CSV и конкурентность (проверено)

- Текущий заголовок (`src/history.ts::HEADER`):
  `ts_iso,epoch_ms,kind,project,session,calls_in_window,reset_count,input,output,cache_read,cache_write,note`
- Все аппенды уже под `proper-lockfile` (`withHistoryLock`, lock-файл
  `~/.pi/agent/pi-billing-window-history.lock`), тест «5 параллельных аппендов» существует.
  Новая колонка наследует эту защиту без изменений механики.
- `trimHistory()` парсит строки по индексу колонки `epoch_ms` (split(",")[1]) — вставка
  `model` НЕ должна сдвигать позицию 1 (безопасно добавить колонку в конец или рядом с
  `session`; аккуратнее — **в конец, после `note`** или между `session` и
  `calls_in_window`; решает дизайн, но порядок существующих колонок менять нельзя
  без миграции).
- `billing_report.py` читает через `csv.DictReader` по именам колонок → старые CSV
  (без `model`) уже совместимы, отсутствующая колонка даёт `None` → фильтр
  «пустая модель = старые строки».

## Business Context

- **Цель:** увидеть, какая модель (например `zai/glm-5.3` vs `minimaxai/minimax-m3`) жгёт
  лимит wormsoft, без ручного маппинга по журналам.
- **Сигнал ценности:** отчёт `billing_report.py` сразу показывает per-model burn →
  осознанный выбор модели под задачи и тайминг окон.

## User Stories

### US-001: Model attribution в истории
**As a** пользователь wormsoft-лимита
**I want** чтобы каждая строка вызова в history CSV содержала имя модели
**So that** анализ расхода не требовал ручного сопоставления по времени

**Acceptance Criteria:**
- Новые строки kind=`call` содержат колонку `model` со значением `ctx.model.id`
  (например `zai/glm-5.3`).
- Строки kind=`window_reset`/`manual_reset`/`settimer` имеют пустую `model` (модель
  не определена) — либо согласованное решение дизайна.
- При `ctx.model === undefined` колонка `model` пустая, запись не падает.

### US-002: Разрез по моделям в отчёте
**As a** пользователь wormsoft-лимита
**I want** таблицу «модель × calls × input/output/cacheR/cacheW × токены» в MD-отчёте
**So that** я вижу, какая модель съедает лимит

**Acceptance Criteria:**
- `billing_report.py` выводит секцию per-model (только kind=`call`).
- Старые CSV без колонки `model` читаются без ошибок; строки без модели агрегируются
  в отдельную группу (например `(unknown)` / «без модели»), не теряются и не валят скрипт.

### US-003: Документация актуальна
**As a** разработчик расширения
**I want** README и docs, отражающие новый формат CSV и отчёт
**So that** формат истории задокументирован в одном месте

## Functional Requirements

### FR-001 — Колонка model в CSV — Must Have
WHEN расширение дописывает строку kind=`call` в history CSV
THE SYSTEM SHALL включать значение имени модели из `ctx.model.id` обрабатываемого вызова
SO THAT каждая запись вызова атрибутируется моделью.
- Значение — ровно `Model.id` (канонический идентификатор pi, как в сессионных файлах).
- `ctx.model` недоступен → пустая ячейка.
- Не-CALL события (`window_reset`, `manual_reset`, `settimer`): колонка присутствует,
  значение пустое.

### FR-002 — Формат и целостность CSV — Must Have
WHEN CSV-файл создаётся заново
THE SYSTEM SHALL писать заголовок, включающий колонку `model`, сохраняя имена и порядок
существующих колонок без изменений.
- Значение эскейпится по RFC 4180 (модели с `/` и `:` не требуют кавычек, но механика
  общая).
- Аппенд выполняется под существующим `proper-lockfile`-локом; конкурентная запись
  нескольких pi-процессов не ломает строки.
- `trimHistory()` продолжает корректно определять возраст строк после смены схемы.

### FR-003 — Backward compatibility CSV — Must Have
WHEN `billing_report.py` читает CSV со старым заголовком (без `model`)
THE SYSTEM SHALL обрабатывать файл без ошибок и относить строки к группе
«без модели» (отдельная строка таблицы, не «потерянные»).

### FR-004 — Per-model разрез в отчёте — Must Have
WHEN отчёт строится по CSV, содержащему строки с моделью
THE SYSTEM SHALL вывести таблицу per-model: модель | calls | input | output | cache_read
| cache_write | total tokens (только kind=`call`, в рамках действующих фильтров
`--days`/`--project`).
- Строки без модели агрегируются в одну группу с явной пометкой (например `(no model)`).
- Существующие секции отчёта (Total, per-project, окна) сохраняются.

### FR-005 — Документация — Should Have
THE SYSTEM SHALL обновить README (§8b, примеры CSV/отчёта) и, при необходимости,
`docs/ARCHITECTURE.md` / `docs/DEV-WORKFLOW.md`: новая колонка, формат значения,
backward-compat поведение отчёта.

### FR-006 — Тесты — Must Have
THE SYSTEM SHALL покрыть юнит-тестами (по образцу `tests/history.test.mts`):
- заголовок с `model` при создании файла;
- значение модели в строке call, пустое — в reset-строках и при `ctx.model === undefined`;
- конкурентные аппенды (существующий сценарий) со схемой с `model`;
- `trimHistory` на файле со схемой с `model`;
- `billing_report.py`: смешанный CSV (старые строки без model + новые) → per-model таблица
  и группа «без модели».

## Non-Functional Requirements

### NFR-001 — Надёжность (наследование политики history.ts)
- Ошибка получения модели (`ctx.model` undefined, исключение при чтении) никогда не
  влияет на счёт окна, сбросы, уведомления — колонка просто пустеет (fire-and-forget
  политика `appendHistory`).

### NFR-002 — Производительность
- Получение модели — O(1) чтение `ctx.model.id`, без дополнительного I/O.
- `billing_report.py`: группировка по модели — в рамках существующего прохода по строкам,
  без второго чтения файла.

### NFR-003 — Совместимость
- Расширение работает с уже существующим history-файлом (без миграции: старые строки
  остаются валидными, новая схема применяется к создаваемым заново файлам; смешанный
  файл обрабатывается отчётом).

## Out of Scope

- Признак main-loop/subagent в CSV (нет надёжного дискриминатора на уровне расширения —
  см. Research Findings).
- Бэкфилл `model` для исторических строк.
- Учёт cost ($) иRate-лимитов per-model.
- Поддержка нескольких провайдеров (фильтр wormsoft остаётся).
- Изменение формата session-файлов или событий pi.

## Decisions

### D-001 — Источник модели: `ctx.model.id`
**Decision:** имя модели берётся из `ctx.model.id` в `after_provider_response`.
**Reason:** единственный прямой источник в момент вызова; событие модель не несёт
(проверено по `AfterProviderResponseEvent` и эмиттеру в `sdk.js`); расширение уже
использует `ctx.model.provider` там же.
**Impacts:** FR-001.

### D-002 — Fallback: пустая ячейка, не «unknown»
**Decision:** при недоступной модели пишется пустая ячейка; отчёт агрегирует такие строки
в отдельную группу.
**Reason:** консистентно с nullable-колонками usage; «unknown» создал бы фантомную модель.
**Impacts:** FR-001, FR-003, FR-004.

### D-003 — Колонка main/subagent не вводится
**Decision:** не добавлять признак main-loop/subagent.
**Reason:** сессионные файлы структурно неразличимы (nested-сессии in-memory →
`ephemeral:<pid>`; персистентные — тот же формат). Модель субагента при этом пишется
корректно (child-сессии грузят обычные расширения).
**Impacts:** Out of Scope.

## Questions

_(Открытых критических нет; Q-001..Q-003 решены как D-001..D-003.)_

## Glossary

- **Model.id** — канонический идентификатор модели pi (`zai/glm-5.3`), совпадает с
  `AssistantMessage.model` в сессионных файлах.
- **history CSV** — `~/.pi/agent/pi-billing-window-history.csv`, append-only, UTF-8 BOM,
  lock `proper-lockfile`, ретеншн 30 дней.
- **Группа «без модели»** — агрегат строк `call` с пустой `model` (старые строки или
  недоступный `ctx.model`).
