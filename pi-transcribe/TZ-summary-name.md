# ТЗ: Название саммаризованного файла по содержанию + дата

## Цель
Саммаризованный файл pi-transcribe получает название **отперую на содержание** транскрипции, в CamelCase (CamelCaseWords), с датой в формате `YYYY-MM-DD` (например `2026-08-31`) в конце, перед расширением.

Пример: `meeting.mp4` → `out/Обсуждение�Плана�Версий-2026-08-31.md` ( вместо текущого `out/meeting-sum.md`)

## Контекст (уже изучен)
- `src/prompt.ts`: `summaryFileInstruction(baseName)` возвращает обязательную инструкцию с фиксированного путём `out/<basename>-sum.md`. `summaryPathFor(baseName)` возвращает этот путь.
- `src/summary.ts`: `buildSummaryPrompt(req, customPrompt)` — вставляет `summaryFileInstruction(req.baseName)` в оба варианта (customPrompt и default). `SummaryRequest` содержит `baseName`.
- Название по содержанию генерирует **сам агент-суммаризатор** ( он читает транскрипт и знает содержание), поэтому изменение — в инструкции ( prompt), не в коде пайплайна.
- Правила саммаризации: `c:/MyProjects/transcribe/docs/summary.md` — путь в инструкции надо актуализировать на новый репозиторий: `c:/tools/pi-transcribe/docs/summary.md`, файл `docs/summary.md` надо перенести/создать.
- `tests/test.mts`: нет тестов для `summaryPathFor` / `summaryFileInstruction` / `buildSummaryPrompt` — надо добавить.

## Задачи

### 1. Изменение инструкции (src/prompt.ts)
- `summaryFileInstruction(baseName, date)`:
  - instruct агента: **создать файл с название отперую на содержание** транскрипции (CamelCaseWords, без пробелов/спец симв, русский или англий — по содержанию), + `-YYYY-MM-DD.md` в конце, перед расширением.
  - Каталог: `out/`. Файл уже может существовать (manifest reuse) — в случае reuse перезаписать по правилам.
  - Структура «# Саммари: <basename>» + метаданные + TL;DR + темы + решения + открыт вопросы — сохранить из текущого ТЗ.
  - В чат — краткий итог и путь к файлу.
- `summaryPathFor` актуализировать: старый `out/<basename>-sum.md` использовать только как fallback для reuse-проверки ( если механизм reuse зависит от него — актуализировать соответствильно).

### 2. Дата (src/prompt.ts или src/summary.ts)
- Дату `YYYY-MM-DD` вычислять при построении prompt ( дата транскрипции/сегодня) и pass into instruction. Без Date.now() в workflow-скриптах — обычный код.

### 3. docs/summary.md
- Перенести/создать `docs/summary.md` в pi-transcribe ( правила структуры саммаризов файла), актуализировать путь в инструкции.

### 4. Тесты (tests/test.mts)
- `summaryFileInstruction` содержит `-YYYY-MM-DD.md`, CamelCase- инструкцию, каталог `out/`
- `buildSummaryPrompt` (customPrompt и default) вставляет новую инструкцию
- Отсутствие тестов для старого `-sum.md` пути — убрать/актуализировать

## Верификация
- `npm test` (unit) — все тесты green
- e2e тест — реальная транскрибация + саммаризация, проверить что файл `out/<CamelCaseName>-YYYY-MM-DD.md` создается
- результат показать пользователю, ** не пушить до одобрения**
