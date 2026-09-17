# Tasks: Model column in history CSV (001-model-in-history)

> Requirements: @requirements.md
> Design: @design.md
> Status: Draft

Методология владельца: **тесты → код → кросс-ревью → документация → финальная верификация → деплой**.
Задачи на тесты (T01, T03, T05) идут ДО соответствующей реализации (T02, T04, T06) и сначала
падают (red). Фикс `deploy.ps1` (T07) — сопутствующий, обязателен по design §4.4 (иначе фича
не доедет до рабочей копии: `history.ts` сейчас НЕ копируется деплоем).

Все команды — из корня репо `c:/Tools/Pi-billing-window`. Точка входа тестов TS —
отдельные файлы в `tests/` (plain tsx + assert, свой `main()` и счётчик PASS/FAIL,
ненулевой exit при провале; см. `tests/history.test.mts` как образец стиля).

Полный регресс-набор TS (все четыре файла):

```bash
npx tsx tests/test.mts
npx tsx tests/arms.test.mts
npx tsx tests/history.test.mts
npx tsx tests/lifecycle.test.mts
```

Python-тест: `python tests/billing_report_test.py` (новый файл, создаётся в T05).

---

## Группа (a): src/history.ts — схема с model + миграция заголовка

### T01 — tests/history.test.mts: тесты новой схемы и миграции (RED) — P0 · 1.5h
- [ ] Дополнить существующий `tests/history.test.mts` (не менять стиль: `assert(cond, name)`,
  `setPaths(join(tmp,...), join(tmp,...))` в `beforeEach`-аналоге, `read()`/`rows()`-хелперы).
  Сценарии из design §5.1 (номера — из design):
  1. **Создание файла**: первый append → первая строка (после снятия BOM) ===
     `ts_iso,epoch_ms,kind,project,session,calls_in_window,reset_count,input,output,cache_read,cache_write,note,model`;
     BOM на месте; существующий assert `startsWith("ts_iso,...,session,")` остаётся зелёным.
  2. **call-строка**: `appendHistory({...base, kind:"call", model: "zai/glm-5.3"})` →
     последняя строка оканчивается на `,zai/glm-5.3`; без `model` → оканчивается на `,`
     (пустая 13-я ячейка); reset-строка (`kind:"window_reset"`) → пустая model-ячейка,
     13 колонок.
  3. **Миграция**: hand-written файл `"\uFEFF" + LEGACY_HEADER + "\n"` + 2 старые строки
     (12 ячеек, legacy-строка — литералом в тесте, `LEGACY_HEADER` НЕ экспортируется,
     design §9) → `appendHistory` вернул true → header стал 13-колоночным, обе старые
     строки не изменены байт-в-байт, новая строка 13-ячеечная; повторный append НЕ
     переписывает header (файл: header + 3 строки).
  4. **Чужой заголовок**: файл с header `foo,bar\n` + строка → append возвращает true,
     header не изменился, строка дописана (данные не ломаем; design §5.1.4).
  5. **Конкурентность на миграции**: legacy-файл + `Promise.all` из 5 `appendHistory` →
     ровно один header (13 колонок), 5 новых строк, старые строки целы (по образцу
     существующего теста «5 параллельных аппендов»).
  6. **trim на новом формате**: строки с model-колонкой, часть старше `RETENTION_DAYS` →
     старые отброшены, header сохранён как есть (существующий сценарий + `model` в base).
  7. **Экранирование**: `model: 'a,b"c'` → в CSV строка содержит `"a,b""c"` (один assert
     на модель с запятой/кавычкой).
- Files: `tests/history.test.mts`
- Verify: `npx tsx tests/history.test.mts` — новые тесты FAIL (red), все существующие —
  PASS; `npx tsx tests/test.mts` — регресс без изменений.
- Dependencies: —

### T02 — src/history.ts: HEADER с model + ensureSchemaLocked + миграция — P0 · 1.5h
- [ ] `src/history.ts`, точные изменения по design §4.1:
  - `HistoryRow`: добавить поле `model?: string` (после `session`, комментарий
    `// ctx.model.id for "call" rows`).
  - `HEADER` (экспорт как сейчас): `...,cache_write,note,model` — 13 колонок
    (`model` в конце, D-101; порядок существующих колонок не менять).
  - Новая приватная константа `LEGACY_HEADER` = старый 12-колоночный заголовок
    (точное значение — текущий `HEADER` до правки).
  - `buildRow()`: в конец массива `cells` добавить `row.model ?? ""` (после `row.note ?? ""`).
  - `ensureFileLocked()` → переименовать в `ensureSchemaLocked()` (private, вызов из
    `appendHistory` не меняется):
    1. файл не существует → создать с BOM + `HEADER` + `\n` (как сейчас);
    2. файл существует → прочитать первую строку (`readFileSync(...).split("\n")[0]`,
       детект — точное сравнение после снятия `\uFEFF` и `strip("\r\n")` по edge-case
       таблице design §6); если === `LEGACY_HEADER` → миграция: прочитать весь файл,
       заменить первую строку на `HEADER`, записать через tmp-файл
       `historyFile + ".tmp." + process.pid` + `fs.renameSync` (атомарность, D-102;
       образец — `state.ts::writeStateSync`); BOM сохраняется (остаётся в `lines[0]`,
       заменяется только суффикс после BOM); если === `HEADER` → no-op; иначе (чужой
       заголовок) → `console.warn`, файл не трогать.
  - `trimHistory()`, `withHistoryLock()`, сигнатура `appendHistory(row, now?)` — без изменений.
- Files: `src/history.ts`
- Verify: `npx tsx tests/history.test.mts` — все PASS (green, включая новые из T01);
  `npx tsx tests/test.mts` — регресс зелёный (test.mts импортирует history-модуль);
  `npm run build` → tsc без ошибок.
- Dependencies: T01

---

## Группа (b): src/index.ts — передача ctx.model?.id

### T03 — tests/lifecycle.test.mts: мок ctx.model.id + assert на CSV-строку (RED) — P0 · 30m
- [ ] `tests/lifecycle.test.mts` (design §5.3):
  - `makeCtx()` (строка ~117): `model: { provider: "wormsoft" }` → дополнить до
    `model: { provider: "wormsoft", id: "test/model-1" }`.
  - В существующем сценарии after_provider_response: убедиться, что history-файл
    читается тестом (`setPaths` на tmp уже должен настраиваться; если сценарий не читает
    history.csv — добавить чтение последней строки) → assert: строка содержит
    `test/model-1` в 13-й ячейке (оканчивается на `,test/model-1`), `kind === "call"`.
  - Если в lifecycle-тесте есть state/history `setPaths` — проверить, что fixture
    изолирована (tmp-каталог), иначе миграция заденет живой файл.
- Files: `tests/lifecycle.test.mts`
- Verify: `npx tsx tests/lifecycle.test.mts` — новый assert FAIL (red), остальные PASS;
  `npx tsx tests/test.mts` — регресс без изменений.
- Dependencies: —

### T04 — src/index.ts: model в appendHistory вызова — P0 · 30m
- [ ] `src/index.ts`, `onAfterProviderResponse` (строка ~622, блок «History: one row per
  successful call», дизайн §4.2) — одна правка:

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

  Остальные `appendHistory`-вызовы (`manual_reset`, `settimer`, `settimer 0` в index.ts;
  всё в `ticker.ts`) — НЕ трогать: поле `model` не задано → пустая ячейка (FR-001, design §9).
- Files: `src/index.ts`
- Verify: `npx tsx tests/lifecycle.test.mts` — все PASS (green); `npx tsx tests/test.mts`
  — регресс зелёный; `npm run build` → 0 ошибок.
- Dependencies: T02, T03

---

## Группа (c): scripts/billing_report.py — per-model разрез

### T05 — tests/billing_report_test.py: новый python-тест (RED) — P0 · 1.5h
- [ ] Создать `tests/billing_report_test.py` (plain python + assert, без фреймворков;
  импорт тестируемого модуля: `sys.path.insert(0, "scripts")` → `import billing_report`;
  tmp-файлы через `tempfile`, cleanup в finally; exit-код ≠ 0 при любом провале — по
  образцу TS-тестов репо). Сценарии из design §5.2:
  1. **Новый CSV** (13 колонок с `model`): 2 модели × 2 call-строки + reset-строка →
     `render()` содержит секцию `## By model`, обе модели с корректными суммами
     (calls/input/output/cacheR/cacheW/total), reset-строки в разрез не попадают.
  2. **Legacy CSV** (12 колонок, без `model`) → `load_rows` + `render` не падают,
     per-model — одна строка `(no model)` с суммой всех call-строк.
  3. **Смешанный CSV** (13-колоночный header + старые 12-ячеечные + новые 13-ячеечные
     строки) → две группы: конкретная модель + `(no model)` (старые строки).
  4. **Фильтры**: строки за пределами `--days` / чужой `--project` не попадают в
     per-model (вызов `load_rows(path, days)` + `render` напрямую, как в `main()`).
  5. **Регресс**: существующие секции Total/per-project присутствуют и корректны
     (пара asserts на содержимое).
  6. **Пустая модель с пробелами**: значение `"  "` в CSV → группа `(no model)`
     (`load_rows` делает `(r.get("model") or "").strip()`).
- Files: `tests/billing_report_test.py`
- Verify: `python tests/billing_report_test.py` — новые тесты FAIL (red: секции
  `## By model` нет, `render_per_model` не существует); синтаксис файла — `python -m py_compile tests/billing_report_test.py`.
- Dependencies: —

### T06 — scripts/billing_report.py: load_rows + render_per_model — P0 · 1h
- [ ] `scripts/billing_report.py`, точные изменения по design §4.3:
  - `load_rows()` (строка ~60): в dict каждой строки добавить
    `"model": (r.get("model") or "").strip()`.
  - Новая функция `render_per_model(rows)`:
    MD-таблица `| model | calls | input | output | cacheR | cacheW | total |` с
    разделителем `|---|---:|---:|---:|---:|---:|---:|`; агрегация в ОДНОМ проходе по
    строкам (NFR-002, без второго чтения файла); только `kind == "call"`; пустая
    модель → одна строка с меткой `(no model)`; сортировка по total tokens desc
    (стабильная); форматирование чисел — существующим `fmt_k()`; числа — через
    существующий `_int()`/`tokens()`.
  - `render()` (строка ~171): после секции `## Total (all projects)` вставить
    `## By model` + результат `render_per_model(rows)`. Секция выводится при наличии
    хотя бы одной call-строки (даже если все без модели — одна строка `(no model)`);
    call-строк нет → секция опускается. Существующие секции (per-project, окна,
    пиковые минуты) не меняются.
  - Фильтры `--days`/`--project` применяются ДО группировки (уже так: `rows` приходит
    отфильтрованным в `main` — не менять).
- Files: `scripts/billing_report.py`
- Verify: `python tests/billing_report_test.py` — все PASS (green);
  smoke на живом файле (сейчас legacy 12 колонок): `python scripts/billing_report.py --days 0`
  — не падает, в секции By model одна строка `(no model)`.
- Dependencies: T05

---

## Группа (d): deploy.ps1 — фикс списка файлов

### T07 — deploy.ps1: копировать history.ts — P0 · 15m
- [ ] `deploy.ps1`, массив `$files` (строка ~24): добавить `"history.ts"` (между
  `"state.ts"` и `"ticker.ts"` — сохранить порядок как в `src/`). Это блокер деплоя
  фичи (design §4.4): сейчас `history.ts` попадает в рабочую копию только ручной
  копией и не обновляется. `arms.ts` тоже отсутствует в списке, но вне scope —
  отметить как замечание в PR/коммите (НЕ добавлять).
- Files: `deploy.ps1`
- Verify: `powershell -NoProfile -Command "Get-Content deploy.ps1 | Select-String 'history.ts'"`
  → строка найдена; dry-check (не выполнять полный деплой): список `$files` читается
  без синтаксических ошибок — `powershell -NoProfile -Command "[scriptblock]::Create((Get-Content deploy.ps1 -Raw)) | Out-Null; 'parse ok'"`.
- Dependencies: —

---

## Группа (e): документация

### T08 — README.md §8b + docs/STATE.md §9 (+ ARCHITECTURE при упоминании колонок) — P1 · 1h
- [ ] `README.md`:
  - §8b (строка ~253): обновить формат CSV — колонка `model` последняя (13-я), значение
    = `ctx.model.id` (канонический id pi, напр. `zai/glm-5.3`), пометка «старые строки
    до миграции — пустые»; строка таблицы событий: `call` — «с usage последнего ответа
    и моделью вызова»; в описание отчёта — новая секция «разрез по моделям»
    (`## By model`, группа `(no model)` = старые строки / недоступная модель).
  - §Тесты (строки ~151-154): добавить `python tests/billing_report_test.py` в список
    команд прогона.
- [ ] `docs/STATE.md`, §9 «Файл истории» (строка ~192): обновить образец header
  (строка ~201 — добавить `,model`), таблицу колонок (строка ~208+: строка
  `model` — «имя модели вызова, `ctx.model.id`; пустая для reset/settimer и старых
  строк»), упомянуть миграцию header под локом при первом append (tmp+rename,
  idempotent).
- [ ] `docs/ARCHITECTURE.md`: grep по `cache_write`/`ts_iso` — если перечислены колонки
  CSV, обновить аналогично; если только описание механики — не дублировать (design §7).
- CHANGELOG в репо отсутствует — не создавать.
- Files: `README.md`, `docs/STATE.md`, (условно) `docs/ARCHITECTURE.md`
- Verify: `grep -n "note,model" README.md docs/STATE.md` → найдено в обоих;
  `grep -n "billing_report_test" README.md` → найдено; ручная сверка секции
  с design §4/§7.
- Dependencies: T02, T04, T06

---

## Группа (f): финальная верификация, кросс-ревью, деплой

### T09 — Полная верификация всех тестов + сборка — P0 · 30m
- [ ] Полный регресс из корня репо:
  - `npx tsx tests/test.mts` → 0 FAIL
  - `npx tsx tests/arms.test.mts` → 0 FAIL
  - `npx tsx tests/history.test.mts` → 0 FAIL
  - `npx tsx tests/lifecycle.test.mts` → 0 FAIL
  - `python tests/billing_report_test.py` → 0 FAIL
  - `npm run build` → tsc 0 ошибок
- [ ] Smoke отчёта на живом legacy-файле: `python scripts/billing_report.py --days 0`
  — не падает, секция `## By model` с одной строкой `(no model)`.
- Files: отчёт в Execution Log ниже
- Dependencies: T02, T04, T06, T07, T08

### T10 — Адресовать findings кросс-ревью — P0 · 1h (буфер)
- [ ] После T09 владельцем запускается кросс-ревью моделью другого семейства (отдельный
  шаг методологии, НЕ задача реализации — здесь только обработка результатов).
  Задача: получить findings ревью (изменения T02/T04/T06/T07 против design.md) и
  адресовать каждое: fix + соответствующий тест (по образцу T01/T05) + повторный
  прогон полного набора из T09. Если findings пусты — зафиксировать «no findings»
  в Execution Log и закрыть задачу.
- Files: по результатам ревью (ожидаемо `src/history.ts`, `src/index.ts`,
  `scripts/billing_report.py`, тесты)
- Verify: повторный прогон всех команд из T09 → 0 FAIL; каждое finding имеет
  фикс или явный reject с обоснованием в Execution Log.
- Dependencies: T09

### T11 — Деплой + smoke на рабочей копии — P0 · 30m
- [ ] Из каталога разработки: `powershell -ExecutionPolicy Bypass -File .\deploy.ps1`.
- [ ] Проверить diff рабочей копии `~/.pi/agent/extensions/pi-billing-window/`:
  `history.ts` скопирован (ключевая проверка фикса T07), `index.ts` обновлён.
- [ ] Перезапуск pi: закрыть все окна pi (каждый живой процесс держит старый JS в
  памяти до /reload) → открыть заново (design §7, шаг 3).
- [ ] Smoke: выполнить хотя бы один wormsoft-вызов в новом pi-процессе →
  проверить последнюю строку `~/.pi/agent/pi-billing-window-history.csv`:
  header теперь 13-колоночный (миграция D-102 отработала на первом append),
  новая строка оканчивается на `,<model-id>`; отчёт
  `python scripts/billing_report.py --days 1` показывает модель в `## By model`.
- Files: — (развёртывание, без правок кода; при проблемах — обратно в T02/T04)
- Dependencies: T09, T10

---

## Requirement Coverage

| Requirement | Task IDs |
|---|---|
| FR-001 (колонка model = ctx.model.id) | T01, T02, T03, T04 |
| FR-002 (формат/целостность CSV) | T01, T02 |
| FR-003 (backward-compat CSV) | T01, T02, T05, T06 |
| FR-004 (per-model разрез) | T05, T06 |
| FR-005 (документация) | T08 |
| FR-006 (тесты) | T01, T03, T05 |
| NFR-001 (надёжность, fire-and-forget) | T02 |
| NFR-002 (производительность) | T04 (O(1)), T06 (один проход) |
| NFR-003 (совместимость без миграции данных) | T02 (D-102), T06 |
| deploy-блокер (design §4.4) | T07, T11 |

## Readiness Check

| Check | Result |
|---|---|
| Все Must Have FR покрыты задачами | Pass (таблица выше) |
| Каждая задача: файлы, критерии, зависимости, verify-команда | Pass |
| Verify-команды известны | Pass (`npx tsx tests/*.mts`, `python tests/billing_report_test.py`, `npm run build`, deploy.ps1 — README §Тесты, package.json) |
| Open-вопросы requirements закрыты дизайном | Pass (Q-001..003 → D-001..003; TD = D-101..104) |
| Порядок «тесты → код → ревью → докс → верификация → деплой» | Pass (T01/T03/T05 → T02/T04/T06 → T10 → T08 → T09 → T11) |
| Фикс deploy.ps1 в объёме задач | Pass (T07 — блокер T11) |
| Блокирующие провалы | нет |

Примечание: гейт `design:approved` формально не зафиксирован (`.status` был `design:draft`);
tasks.md создан по явному указанию владельца — черновик, не авторизует реализацию до
`tasks:approved`.

## Execution Log

| Task | Status | Evidence |
|------|--------|----------|
| — | — | — |
