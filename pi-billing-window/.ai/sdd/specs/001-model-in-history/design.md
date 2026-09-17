# Design: Model column in history CSV (001-model-in-history)

> Status: Draft
> Source: requirements.md (Draft; создание дизайна — по явному указанию владельца, гейт `requirements:approved` ещё не пройден)
> Scope: `pi-billing-window` (репо pi-tools, каталог `c:/Tools/Pi-billing-window`)

## 1. Context и проверенные факты

- Живой файл `~/.pi/agent/pi-billing-window-history.csv`: **3618 строк данных** старого
  12-колоночного формата. Заголовок (с BOM):
  `ts_iso,epoch_ms,kind,project,session,calls_in_window,reset_count,input,output,cache_read,cache_write,note`
- Пишут в файл два модуля: `src/index.ts` (kind=`call`, `manual_reset`, `settimer`,
  `settimer 0` → `window_reset`) и `src/ticker.ts::checkAndReset` (kind=`window_reset`,
  note=`auto`). Оба идут через `appendHistory()` → `withHistoryLock()` (proper-lockfile).
- `trimHistory()` берёт возраст строки по `split(",")[1]` (позиция `epoch_ms`) и
  сохраняет первую строку файла как заголовок «как есть» (детект `includes("ts_iso,")`).
- `scripts/billing_report.py` читает `csv.DictReader` по **именам** колонок; отсутствующая
  колонка / короткая строка → значение `None`.
- `ctx.model.id` доступен в `onAfterProviderResponse` (`src/index.ts`), где уже читается
  `ctx.model.provider`. `HistoryRow` → `buildRow()` → `csvEscape()` (RFC 4180 уже есть).
- **`deploy.ps1` НЕ копирует `history.ts`** (список `$files`: index/state/ticker/ui/parser/
  notifier/package.json). В `~/.pi/agent/extensions/pi-billing-window/` history.ts попал
  ручной копией — при изменении он не обновится. Это надо чинить в рамках фичи.

  > **[RESOLVED]** `deploy.ps1` теперь копирует и `history.ts`, и `arms.ts` (обе строки
  > присутствуют в массиве `$files`); пункт устарел и оставлен только как историческая
  > запись исследования.

## 2. Решения (Decisions)

### D-101 — Позиция колонки: **в конец, после `note`** (13-я)

**Decision:** `model` — последняя колонка: `...,cache_write,note,model`.

**Reason (альтернативы отброшены):**
- *После `session` (позиция 5)* — отвергнуто: (а) сдвиг индексов всех колонок правее
  ломает `trimHistory`'s `split(",")[1]` нет, но главное — (б) старые 12-ячеечные строки
  под новым заголовком **сдвигаются семантически**: значение `note` попало бы в `model`,
  `cache_write` в `note` и т.д. Потребовалась бы полная миграция всех 3618 строк.
- *В конец* — старые строки остаются позиционно валидными: `csv.DictReader` с
  13-колоночным заголовком для 12-ячеечной строки даёт `model=None` (restval), все
  остальные колонки читаются правильно. Менять нужно только заголовок, не данные.
- Критично для **coexistence при деплое**: после обновления заголовка старые ещё
  работающие pi-процессы (старый код) продолжат аппендить 12-ячеечные строки —
  при позиции «в конец» они корректно читаются как «без модели»; при вставке в
  середину — необратимо сдвигались бы.
- `trimHistory` не меняется вовсе (`epoch_ms` остаётся индексом 1).

**Impacts:** FR-001, FR-002, FR-003.

### D-102 — Миграция: одноразовый upgrade заголовка под локом при первом append

**Decision:** `ensureFileLocked()` (вызывается каждым `appendHistory` под локом)
расширяется до «ensure schema»: если файл существует и его первая строка — ровно
`LEGACY_HEADER`, файл переписывается с `HEADER` (13 колонок), данные не трогаются.
Idempotent: вторая проверка — header уже новый → no-op.

**Alternatives:**
- *Не трогать заголовок, писать 13-ю ячейку в новые строки* — отвергнуто: `DictReader`
  кладёт лишнюю ячейку в `restkey` (ключ `None`), колонка `model` в отчёте навсегда
  пустая; ручной парсинг по индексу ломается.
- *Переписать заголовок в `trimHistory()` на session_start* — отвергнуто: append может
  случиться раньше тика старта; единая точка истины — append-путь (файл вообще без
  append'ов не мигрируется, но тогда и новых строк нет — миграция не нужна).
- *Отдельный миграционный скрипт* — отвергнуто: лишний ручной шаг, механика
  check-and-fix-in-place проще и уже под локом.

**Атомарность:** полный файл ~360 КБ — rewrite дёшев, но делаем по образцу
`state.ts::writeStateSync`: пишем во временный файл `historyFile + ".tmp." + pid`
и `renameSync` (Windows: rename поверх существующего работает при отсутствии
открытых хэндлов; append/trim уже сериализованы тем же локом). BOM первой строки
сохраняется (читаем utf-8, `\uFEFF` остаётся в `lines[0]`, заменяем только суффикс
после BOM).

**Нераспознанный заголовок** (не legacy и не new): не трогаем, `console.warn` —
fire-and-forget политика истории сохраняется.

**Impacts:** FR-002, FR-003, NFR-003.

### D-103 — Откуда модель: `ctx.model?.id` в `onAfterProviderResponse`

**Decision:** в существующем вызове `appendHistory({kind:"call", ...})` добавляется
`model: ctx.model?.id ?? ""`. Провайдер-фильтр уже гарантирует `ctx.model` определён
(строка `providerName !== PROVIDER` выше), но fallback `""` оставляем для типовой
безопасности. Reset/settimer-строки (`index.ts`, `ticker.ts`) поле `model` не задают
→ `buildRow` пишет пустую ячейку.

**Reason:** D-001 из requirements (событие модель не несёт; `id` — каноническое имя,
как в сессионных файлах). Subagent-сессии грузят расширение сами → их `ctx.model.id`
попадает в их же `call`-строки без отдельной логики (D-003: признак main/subagent не вводим).

**Impacts:** FR-001, NFR-001, NFR-002.

### D-104 — Отчёт: per-model секция + группа «(no model)»

**Decision:** `billing_report.py` получает `"model"` в `load_rows` (через
`r.get("model") or ""` → None/пусто = нет модели) и новую секцию в `render()`
между «Total» и per-project: таблица `model | calls | input | output | cacheR | cacheW |
total`, только kind=`call`, сортировка по total tokens desc, пустая модель → одна
строка с меткой `(no model)`. Группировка — в том же единственном проходе по строкам
(NFR-002), без второго чтения файла.

**Impacts:** FR-003, FR-004.

## 3. Requirements Mapping

| Requirement | Покрытие |
|---|---|
| FR-001 колонка model | §4.1 (HistoryRow.model), §4.2 (index.ts), D-103 |
| FR-002 формат/целостность | §4.1 (HEADER, csvEscape наследуется), D-101, D-102 |
| FR-003 backward-compat CSV | D-101 (позиция в конец), D-102 (header upgrade), §4.3 |
| FR-004 per-model отчёт | §4.3, D-104 |
| FR-005 документация | §7 |
| FR-006 тесты | §5 |
| NFR-001..003 | D-103 (O(1), fire-and-forget), D-102 (без миграции данных) |

## 4. Точные изменения

### 4.1 `src/history.ts`

```ts
// типы
export type HistoryRow = {
  kind: HistoryKind;
  project?: string;
  session?: string;
  model?: string;          // НОВОЕ: ctx.model.id для call-строк
  callsInWindow?: number;
  resetCount?: number;
  usage?: HistoryUsage | null;
  note?: string;
};

// константы (вместо одного HEADER)
export const HEADER =
  "ts_iso,epoch_ms,kind,project,session,calls_in_window,reset_count," +
  "input,output,cache_read,cache_write,note,model";
const LEGACY_HEADER =                      // для детекта при миграции
  "ts_iso,epoch_ms,kind,project,session,calls_in_window,reset_count," +
  "input,output,cache_read,cache_write,note";
```

- `buildRow()`: в конец массива `cells` добавить `row.model ?? ""` (после `row.note ?? ""`).
  Экранирование уже общее (`cells.map(csvEscape)`) — модель с запятой/кавычкой
  экранируется автоматически.
- `ensureFileLocked()` → переименовать в `ensureSchemaLocked()` (private, вызов из
  `appendHistory` не меняется):
  1. файл не существует → создать с BOM + `HEADER` (как сейчас);
  2. файл существует → прочитать первую строку; если она (после снятия BOM) ===
     `LEGACY_HEADER` → **миграция**: прочитать файл, заменить первую строку на
     `HEADER`, записать через tmp+`renameSync` (см. D-102); если === `HEADER` → no-op;
     иначе (чужой заголовок) → `console.warn`, не трогать.
- `trimHistory()`, `withHistoryLock()`, `appendHistory()` (публичная сигнатура
  `appendHistory(row: HistoryRow, now?: number): Promise<boolean>`) — без изменений.

### 4.2 `src/index.ts`

Одна правка в `onAfterProviderResponse` (~строка 673, блок «History: one row per
successful call»):

```ts
const meta = historyMetaOf(ctx);
const modelId = ctx.model?.id ?? "";   // новая строка
const fresh = readStateSync();
void appendHistory({
  kind: "call",
  project: meta.project,
  session: meta.session,
  model: modelId,                      // новое поле
  callsInWindow: fresh?.callsInWindow,
  resetCount: fresh?.resetCount,
  usage: lastAssistantUsage(ctx),
});
```

`ticker.ts` и остальные `appendHistory`-вызовы в `index.ts` (manual_reset, settimer,
settimer 0) — **без изменений**: поле `model` не задано → пустая ячейка (FR-001).

### 4.3 `scripts/billing_report.py`

- `load_rows()`: в dict строки добавить `"model": (r.get("model") or "").strip()`.
  (`DictReader` вернёт `None` и для CSV без колонки, и для коротких старых строк.)
- Новая функция:

```python
def render_per_model(rows):
    """MD-таблица: модель × calls × input/output/cacheR/cacheW × total (kind=call)."""
    agg = {}  # model -> [calls, inp, out, cr, cw, tok]
    order = []  # первое вхождение, для стабильности
    for r in rows:
        if r["kind"] != "call":
            continue
        m = r["model"] or "(no model)"
        ...
    # сортировка по tok desc, вывод "| model | calls | in | out | cacheR | cacheW | total |"
```

- `render()`: после секции `## Total (all projects)` вставить:

```
## By model

| model | calls | input | output | cacheR | cacheW | total |
|---|---:|---:|---:|---:|---:|---:|
| zai/glm-5.3 | 120 | 1.2M | 340k | 8.9M | 12k | 10.4M |
| (no model) | 3518 | ... |
```

  Секция выводится всегда при наличии call-строк (даже если все без модели — тогда
  одна строка `(no model)`; если call-строк нет, секция опускается).
- Существующие секции (per-project, окна) не меняются. Фильтры `--days`/`--project`
  применяются ДО группировки (уже так: `rows` приходит отфильтрованным в `main`).

### 4.4 `deploy.ps1` (сопутствующий фикс)

Добавить `"history.ts"` (и `"arms.ts"` — тоже отсутствует в списке, но вне scope;
отметить как замечание в PR) в массив `$files`. Иначе новый `history.ts` не попадёт в
рабочую копию и деплой фичи будет неполным.

## 5. Тестовая стратегия

### 5.1 `tests/history.test.mts` (расширить, стиль — plain tsx + assert)

1. **Создание файла**: header оканчивается на `,note,model`; BOM на месте
   (существующий assert `startsWith("ts_iso,...,session,")` остаётся зелёным).
2. **call-строка**: `appendHistory({...base, model: "zai/glm-5.3"})` → строка
   оканчивается `,zai/glm-5.3`; без `model` → оканчивается `,` (пустая ячейка);
   reset-строки → пустая model-ячейка.
3. **Миграция**: hand-written файл с `LEGACY_HEADER` + 2 старые строки (12 ячеек) →
   `appendHistory` → header стал 13-колоночным, обе старые строки не изменены
   (байт-в-байт, включая BOM), новая строка 13-ячеечная; повторный append не
   переписывает header (файл после двух append'ов: header + 3 строки).
4. **Чужой заголовок**: файл с header `foo,bar` → append не мигрирует, строки
   дописываются, возвращается true (или warn — определить: append всё равно true,
   данные не ломаем).
5. **Конкурентность на миграции**: legacy-файл + 5 параллельных append'ов → ровно
   один header, 5 новых строк, старые строки целы (существующий лок-сценарий).
6. **trim на новом формате**: строки с model-колонкой, старые отбрасываются,
   header сохраняется (существующий сценарай + model в `base`).
7. **Экранирование**: `model: 'a,b"c'` → в CSV `"a,b""c"` (csvEscape уже тестируется,
   добавить один assert на модель с запятой).

### 5.2 `tests/billing_report.test.py` (новый, plain python + assert, без фреймворков)

Запуск: `python tests/billing_report_test.py`; импортирует `scripts/billing_report.py`
через `sys.path.insert(0, "scripts")`. Сценарии на tmp-файлах:
1. **Новый CSV** (13 колонок, 2 модели × 2 строки + reset-строка) → секция `## By model`
   содержит обе модели с корректными суммами; reset-строки в разрез не попадают.
2. **Legacy CSV** (12 колонок) → скрипт не падает, одна строка `(no model)` с суммой
   всех call-строк.
3. **Смешанный CSV** (мигрированный header + старые 12-ячеечные + новые 13-ячеечные
   строки) → две группы: конкретная модель + `(no model)` = старые строки.
4. **Пустой фильтр**: `--project`/`--days` отсекают строки и из per-model (вызов
   `load_rows` + `render` напрямую).
5. Существующие секции (Total, per-project) не регрессируют (пара asserts на
   содержимое).

### 5.3 `tests/lifecycle.test.mts`

Мок `makeCtx` уже содержит `model: { provider: "wormsoft" }` → дополнить до
`{ provider: "wormsoft", id: "test/model-1" }`. Существующий сценарий
after_provider_response → в полученной history-строке присутствует `test/model-1`
(если lifecycle-тест сейчас читает history.csv — добавить assert; если не читает,
добавить чтение одной строки). Новых моков не нужно.

E2E-прогоны (живой pi) — out of scope для авто-тестов; ручная проверка по §7 checklist.

## 6. Edge cases

| Случай | Поведение |
|---|---|
| `ctx.model === undefined` | `model: ""` — пустая ячейка (D-002 requirements); в `onAfterProviderResponse` практически недостижимо (provider-фильтр), но типобезопасно |
| Модель с `,`/`"`/переносом | `csvEscape` (уже существует, RFC 4180); тест 5.1.7 |
| Крах процесса во время header-миграции | tmp+`renameSync` — либо старый, либо новый файл целиком; lock-файл proper-lockfile переживает (stale lock отпускается по retries) |
| Старый pi-процесс аппендит после миграции | 12-ячеечная строка под 13-колоночным header → `DictReader` даёт `model=None` → группа `(no model)`; данные не сдвигаются (D-101) |
| Конкурентная миграция двух процессов | обе под `withHistoryLock` → вторая видит уже новый header → no-op |
| trim удаляет строки ниже лимита | header сохраняется «как есть» (уже так), `epoch_ms` остаётся `split(",")[1]` |
| Legacy-файл без BOM / с CRLF | header-детект — точное сравнение первой строки (после `strip("\r\n")`); миграция сохраняет все строки как прочитаны `split("\n")` (пустые отбрасываются trim'ом, не миграцией — миграция сохраняет пустые хвостовые как есть) |
| CSV-файл, созданный заново (удалён) | `HEADER` с `model` сразу — миграция не нужна |

## 7. Документация и развёртывание (FR-005)

### README.md

- §8b: обновить список колонок (добавить `model` после `note` с пометкой «старые строки
  до 2026-09 — пустые»), добавить строку таблицы «Модель вызова | колонка `model`»,
  добавить в описание отчёта секцию «разрез по моделям».
- §Тесты (строка ~153 и список ~167): добавить `tests/billing_report_test.py` и
  упоминание новых ассертов history-тестов.
- docs/ARCHITECTURE.md, docs/STATE.md — только если там перечислены колонки CSV
  (проверить при выполнении задачи; не дублировать).

### Развёртывание

1. Добавить `history.ts` в `$files` деплоя (§4.4) — **блокер**, без этого фича не
   доедет до рабочей копии.
2. `powershell -ExecutionPolicy Bypass -File .\deploy.ps1` из каталога разработки.
3. Перезапуск pi НЕ обязателен для миграции файла, но обязателен для нового кода:
   каждый запущенный pi-процесс держит старый JS в памяти до `/reload` (или полного
   закрытия окна). Практический чеклист: deploy → закрыть все окна pi → открыть заново.
4. Первый же wormsoft-вызов нового процесса мигрирует header (D-102). До этого отчёт
   можно строить хоть каждый день — старый формат читается.
5. Переходный период (старые окна ещё живы): их call-строки попадут в `(no model)` —
   ожидаемо, самозатухает за lifetime окон.

## 8. Риски

| Риск | Вероятность | Митигание |
|---|---|---|
| Header-миграция на большом файле (360 КБ) под append-локом | низкая (rewrite ~мс) | tmp+rename, лок уже сериализует; критсекция сравнима с trim |
| `renameSync` поверх открытого хэндла (антивирус/Excel держит CSV) | низкая | retry-политика отсутствует — append вернёт false, warn (существующая политика; следующий append повторит миграцию) |
| Забыт деплой history.ts | средняя (deploy.ps1 уже пропускает его) | §4.4 + задача в tasks.md с явной проверкой diff'а рабочей копии |
| Пользователь с ручными скриптами по индексам колонок | низкая | model в конце — индексы 0..11 не сдвинуты; README помечает |
| `(no model)` принимается за модель | — | метка с явными скобками, не совпадает с форматом `provider/model` |

## 9. Implementation FAQ

- **Менять ли `ticker.ts`?** Нет. Reset-строки без модели по дизайну (FR-001).
- **Писать ли `model` в `settimer`/`manual_reset`?** Нет — модель в момент команды
  не относится к событию; колонка пустая.
- **Нужен ли экспорт `LEGACY_HEADER`?** Нет, приватная константа; тест 5.1.3 пишет
  legacy-строку литералом.
- **Почему не `responseModel` из session entries?** Дублирует `ctx.model.id` с
  семантикой «предыдущий ответ» (Research Findings); D-103 проще и точнее.
- **Обновлять ли `package.json`/версию?** Нет внешних потребителей; minor-bump по
  усмотрению владельца, не блокер.
