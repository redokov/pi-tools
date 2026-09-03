# Техническое задание: доработка расширения `pi-transcribe`

## 1. Цель доработки

Преобразовать формат команд расширения `pi-transcribe` так, чтобы **имя модели стало частью самой команды**, и чтобы расширение **автоматически запускало суммаризацию через агент pi-coding-agent** после успешной транскрибации.

Новая раскладка:

| Команда | Эквивалентное поведение |
|---|---|
| `/transcribe file.mp4` | Транскрибировать `inbox/file.mp4` моделью `whisper-large` (русский), затем попросить LLM-агента сделать суммаризацию. |
| `/transcribe-gigaam file.mp4` | Транскрибировать `inbox/file.mp4` моделью `gigaam` (русский), затем попросить LLM-агента сделать суммаризацию. |

Старая команда `/transcribe` с флагом `--model gigaam|whisper-large` **сохраняется** как алиас: `/transcribe` без `--model` для русского **по умолчанию выбирает whisper-large** (а раньше — интерактивный prompt). Флаг `--model` остаётся валидным для обеих команд для совместимости (но если он задан, он **перекрывает** модель, заданную именем команды).

> **Важно.** Язык по умолчанию — `ru`. Флаг `--lang ru|en` продолжает работать в обеих командах. Формат `--format` — тоже (по умолчанию `text`).

---

## 2. Текущее состояние (что есть)

Проект: `C:\Tools\pi-transcribe\` (исходники) → `C:\Users\r.edokov\.pi\agent\extensions\pi-transcribe\` (установленная копия).

Структура:

```
pi-transcribe/
├── package.json        # pi.extension = ./src/index.ts, scripts: build, test
├── tsconfig.json       # strict, ESM, noEmit
├── src/
│   ├── index.ts        # registerCommand("transcribe"), handler
│   ├── pipeline.ts     # runPrepare / runTranscribe / run / spawn
│   ├── prompt.ts       # askModelChoice / askReuseManifest (через ctx.ui)
│   ├── output.ts       # readResult / truncateForChat / summarizeOut / fmtBytes
│   └── paths.ts        # PROJECT_DIR, INBOX/OUT/SCRIPTS, валидация имени
└── tests/
    └── test.mts        # юнит + интеграция (реальный python + ffmpeg)
```

Сейчас `index.ts`:
- `parseArgs` принимает `--model gigaam|whisper-large`;
- если `--model` не передан **и язык начинается с `ru`**, вызывается `askModelChoice(ctx.ui, lang)` через `ctx.ui.select`;
- затем `runPrepare` → `runTranscribe` → `readResult` → `pi.sendMessage({ customType: "pi-transcribe", ... })` печатает результат **кастомным сообщением**, в LLM-контекст текст не уходит.

**Что меняется:**

1. Команда `/transcribe` без `--model` для русского больше **не спрашивает** модель через `ctx.ui.select`, а сразу использует `whisper-large`.
2. Регистрируется вторая команда `/transcribe-gigaam`, которая для русского сразу использует `gigaam`. Для не-русского — обе команды также используют ту же модель по умолчанию (`whisper-large` для `/transcribe`, `gigaam` для `/transcribe-gigaam`), если пользователь явно не передал `--model`.
3. После успешной транскрибации расширение **отправляет агенту текст через `pi.sendUserMessage(...)`** с просьбой сделать краткое резюме на русском. Агент сам формирует саммари и выводит его пользователю в чат.

---

## 3. Целевое поведение

### 3.1. Команды

```
/transcribe [file] [флаги]
/transcribe-gigaam [file] [флаги]
/transcribe-status
```

- `file` — опционально; без него берётся самый свежий файл из `inbox/`.
- `--lang ru|en` — язык (по умолчанию `ru`).
- `--model gigaam|whisper-large` — **переопределяет** модель, заданную именем команды.
- `--format text|srt|vtt|json|verbose_json` — формат результата (по умолчанию `text`).
- `--help` / `-h` — справка.
- `--no-summary` — отключить автосуммаризацию через агента (по умолчанию саммари включено).
- `--summary-prompt <текст>` — **переопределить** системный промпт саммари (по умолчанию см. п. 3.4).

### 3.2. Алгоритм `/transcribe foo.mp4`

1. `parseArgs` → `{ file: "foo.mp4", lang: "ru", format: "text", model: undefined, summary: true }`.
2. `effectiveModel = args.model ?? "whisper-large"` (для `/transcribe-gigaam` — `"gigaam"`).
3. `resolveSourcePath(file)` → проверка, что файл в `inbox/`.
4. Проверить `out/foo.manifest.json`; если есть — спросить через `ctx.ui.confirm` "переиспользовать?". По умолчанию (UI недоступен) — **не** переиспользовать (даём prepare отработать заново, это безопасно).
5. `runPrepare(...)` → `out/foo.manifest.json`.
6. `runTranscribe(..., model=effectiveModel, noInteractive=true)`.
7. `readResult(baseName, format)` → текст.
8. Напечатать результат **как сообщение ассистента** в чате (через `pi.sendMessage({ customType: "pi-transcribe", display: true })` — для видимости пользователю; этот текст **не участвует в LLM-контексте**, чтобы не раздувать контекст транскрипцией целиком).
9. Если `args.summary === true`: отправить агенту через `pi.sendUserMessage(...)` (с `deliverAs: "followUp"`, если он ещё крутится, иначе без `deliverAs` — т.е. триггерит новый turn) **структурированный промпт** с транскрипцией (см. п. 3.4).
10. `ctx.ui.notify("Готово: out/foo.txt", "info")`.

### 3.3. Алгоритм `/transcribe-status`

Без изменений: показать `out/`.

### 3.4. Промпт саммари

Шаблон (на русском; пользователь видит, что агент делает):

```
Файл: {displayPath}
Модель транскрибации: {effectiveModel}
Язык: {lang}
Формат: {format}
Полный текст: {resultPath}

Транскрипция:
\"\"\"
{transcriptionText}
\"\"\"

Сделай краткое структурированное резюме на русском:
1. Главная тема / цель записи (1–2 предложения).
2. Ключевые тезисы списком (3–7 пунктов).
3. Принятые решения / договорённости (если есть).
4. Открытые вопросы / следующие шаги (если есть).
Если в записи есть шум, оговорки или неразборчивые фрагменты — упомяни их в конце отдельным пунктом.
```

Текст отправляется **через `pi.sendUserMessage(prompt, options)`** — агент обрабатывает его как обычное пользовательское сообщение.

Ограничения:
- Если длина транскрипции > **8000 символов** — в промпт саммари включить **первые 8000 символов + пометку**, что дальше обрезано; пользователю в `notify` дополнительно сказать, что полный текст — в `out/<name>.<ext>`. (Можно ужесточить до 16k, если тесты покажут, что агенту ок.)
- Если `--no-summary` — шаг 9 пропускается.

### 3.5. Идемпотентность и безопасность

- Если в момент вызова команды агент сейчас стримит — использовать `pi.sendUserMessage(prompt, { deliverAs: "followUp" })` (дождаться, пока он закончит инструменты).
- Если агент простаивает — `pi.sendUserMessage(prompt)` без `deliverAs` (триггерит turn немедленно).
- Команды должны корректно отрабатывать **без TUI UI** (`ctx.ui.select` / `ctx.ui.confirm` могут быть недоступны) — fallback на дефолты (см. п. 3.2 шаг 4).

---

## 4. Структура изменений

### 4.1. `src/paths.ts`

- Добавить константу `DEFAULT_MODEL_BY_COMMAND: Record<string, Model>`:
  ```ts
  export const DEFAULT_MODEL_BY_COMMAND: Readonly<Record<string, Model>> = {
    transcribe: "whisper-large",
    "transcribe-gigaam": "gigaam",
  };
  ```
- Реэкспорт типов не меняется.

### 4.2. `src/pipeline.ts`

- Без изменений (API совместимо).

### 4.3. `src/output.ts`

- Без изменений.

### 4.4. `src/prompt.ts`

- `askModelChoice` **оставить** (он ещё может использоваться), но `index.ts` его больше **не вызывает** для русского по умолчанию (см. п. 3.2).
- Добавить функцию `askReuseManifest` — оставить как есть (она уже есть).
- Добавить `buildSummaryPrompt(args): string` — формирует промпт по п. 3.4.

### 4.5. `src/index.ts` (главные изменения)

1. Вынести основной пайплайн в функцию `runPipeline(args, ctx, pi, defaultModel)` — принимает:
   - `args: ParsedArgs` (после парсинга),
   - `ctx`, `pi`,
   - `defaultModel: Model` — какую модель использовать, если `--model` не задан.
2. Парсер `parseArgs` дополнить флагами `--no-summary`, `--summary-prompt <текст>`, и расширить валидацию `--model`.
3. В `export default function (pi)` зарегистрировать **две команды**:
   ```ts
   pi.registerCommand("transcribe", { ..., handler: (args, ctx) => runPipeline(parseArgs(args), ctx, pi, "whisper-large") });
   pi.registerCommand("transcribe-gigaam", { ..., handler: (args, ctx) => runPipeline(parseArgs(args), ctx, pi, "gigaam") });
   pi.registerCommand("transcribe-status", { ... }); // без изменений
   ```
4. После `pi.sendMessage({ customType: "pi-transcribe", ... })` (шаг 8) добавить блок саммари:
   ```ts
   if (!parsed.noSummary) {
     const prompt = parsed.summaryPrompt ?? buildSummaryPrompt({ displayPath, model, lang, format, resultPath, text });
     if (pi.isStreaming?.() || ctx.ui.hasPending?.()) {
       pi.sendUserMessage(prompt, { deliverAs: "followUp" });
     } else {
       pi.sendUserMessage(prompt);
     }
     ctx.ui.notify("Запущена суммаризация агентом…", "info");
   }
   ```
   > Если методов `isStreaming` / `hasPending` нет в API — определять доступность через optional-chaining и fallback на `sendUserMessage(prompt)` без опций (он сам бросит, если стримит и опции нет — обернуть в try/catch и fallback на `deliverAs: "followUp"`).
5. `MAX_CHAT_LINES = 200` оставить; `PREPARE_TIMEOUT_MS`, `TRANSCRIBE_TIMEOUT_MS` — без изменений.
6. HELP_TEXT обновить (упомянуть `/transcribe-gigaam`, `--no-summary`).

### 4.6. `tests/test.mts`

Добавить/изменить юнит-тесты:

1. **`paths.ts`**: проверить `DEFAULT_MODEL_BY_COMMAND`.
2. **`pipeline.ts` argv**: тест `transcribeCommand({ ...args, model: "gigaam" })` и `whisper-large` (уже есть).
3. **`output.ts`**: без изменений.
4. **`prompt.ts`**:
   - `buildSummaryPrompt` — формирует ожидаемый текст (проверить наличие всех 4 разделов, имени файла, модели, языка, формата, фрагмента транскрипции, обёртки `"""..."""`).
   - При длинной транскрипции (> 8000 символов) — проверить, что текст обрезается и есть пометка об обрезке.
5. **`index.ts`** — парсер:
   - `parseArgs("foo.mp4 --no-summary")` → `{ file: "foo.mp4", noSummary: true, ... }`.
   - `parseArgs("foo.mp4 --summary-prompt 'сделай 3 пункта'")` → корректно распарсил `--summary-prompt`.
   - `parseArgs("foo.mp4 --model gigaam")` → `model: "gigaam"`.
   - `parseArgs("--help")` → `error === "HELP"`.
   - Все негативные кейсы (неизвестный флаг, пропущенное значение) — уже есть, проверить что не сломались.
6. **Интеграция с саммари не тестируется** (она зависит от LLM-агента, который не запущен в `npm test`); только **мок `pi.sendUserMessage`** через dependency injection или отдельный helper. Подход: вынести в `index.ts` функцию `dispatchSummary(pi, prompt, ctx)` и в тесте проверять, что при `noSummary=false` она вызвана с правильными аргументами через фейковый `pi`.

### 4.7. `package.json`

Без изменений (новая команда регистрируется в коде).

### 4.8. `README.md`

Обновить секции «Команды» и «Флаги» — добавить `/transcribe-gigaam`, `--no-summary`, `--summary-prompt`. В начало README добавить абзац: «Расширение также автоматически запрашивает у LLM-агента краткое резюме транскрипции (отключается `--no-summary`).»

---

## 5. API pi-coding-agent — что нужно знать агенту

- `pi.sendUserMessage(content, options?)`:
  - `content: string` или `ContentPart[]`,
  - `options.deliverAs?: "steer" | "followUp"` (при стриме — обязательно одно из них; без `deliverAs` вызов упадёт, если агент сейчас стримит),
  - без `deliverAs` и без стрима — отправляет **немедленно**, триггерит turn.
- `pi.sendMessage({ customType, content, display, details }, { deliverAs: "nextTurn", triggerTurn: false })` — кастомное сообщение, **не** идёт в LLM-контекст (поэтому транскрипцию показываем через `sendMessage`, а просьбу о саммари — через `sendUserMessage`).
- `ctx.ui.notify(msg, level)`, `ctx.ui.confirm(title, message)` — для UX.
- Если метод `pi.isStreaming()` отсутствует в типах — использовать `(pi as any).isStreaming?.()` и fallback.
- Полный референс: `C:\Users\r.edokov\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\docs\extensions.md` (см. секции `pi.sendMessage`, `pi.sendUserMessage`, `pi.registerCommand`).

---

## 6. Критерии приёмки (Definition of Done)

1. ✅ В `pi` доступны **две команды**: `/transcribe` и `/transcribe-gigaam`, плюс `/transcribe-status`.
2. ✅ `/transcribe foo.mp4` без `--model` использует `whisper-large`.
3. ✅ `/transcribe-gigaam foo.mp4` без `--model` использует `gigaam`.
4. ✅ `/transcribe foo.mp4 --model gigaam` — `model` из флага перекрывает дефолт команды.
5. ✅ После успешной транскрибации агент **получает** запрос на саммари (через `pi.sendUserMessage`), и пользователь видит резюме в чате после текста транскрипции.
6. ✅ `--no-summary` отключает шаг саммари.
7. ✅ `--summary-prompt <текст>` переопределяет системный промпт саммари.
8. ✅ Длинная транскрипция (>8000 символов) обрезается в промпте саммари с пометкой.
9. ✅ Все юнит-тесты зелёные (`npm test`).
10. ✅ `npm run build` без ошибок.
11. ✅ README обновлён: новые команды, флаги, поведение саммари.
12. ✅ Нет хардкоженного API-токена ни в исходниках, ни в тестах.
13. ✅ Установленная копия в `C:\Users\r.edokov\.pi\agent\extensions\pi-transcribe\` обновлена (синхронизирована с исходниками).

---

## 7. Что НЕ входит в задачу

- ❌ Не менять скрипты в `C:\MyProjects\transcribe\` (готовы, протестированы).
- ❌ Не реализовывать стриминг саммари в чат; агент сам управляет потоком.
- ❌ Не делать `--summary-model <…>` — модель для саммари — это модель самого pi-агента (настраивается через `pi --model ...` при запуске).
- ❌ Не вводить persistent state — состояние на диске в `out/`, как и было.

---

## 8. План работы

1. Прочитать `C:\Tools\pi-transcribe\` (этот файл + `README.md` + `src/*.ts` + `tests/test.mts`) — для понимания текущего кода.
2. Прочитать `C:\Users\r.edokov\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\docs\extensions.md` — секции про `sendMessage`, `sendUserMessage`, `registerCommand`.
3. Реализовать изменения в `src/paths.ts`, `src/prompt.ts`, `src/index.ts`.
4. Обновить `tests/test.mts` (новые юнит-тесты, мок `pi.sendUserMessage`).
5. Прогнать `npm test` и `npm run build` — оба зелёные.
6. Обновить `README.md`.
7. Скопировать (или rsync) `C:\Tools\pi-transcribe\` в `C:\Users\r.edokov\.pi\agent\extensions\pi-transcribe\`.
8. Сообщить пользователю отчёт: что сделано, результат тестов, как вызывать `/transcribe-gigaam`.

---

## 9. Команда запуска агента

(См. файл `RUN.md` рядом с этим TZ, либо воспользуйся командой ниже.)

```bash
pi --prompt "..."  -- см. RUN.md
```
