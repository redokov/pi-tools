# Команда запуска агента для доработки pi-transcribe

Полное техническое задание — в `TZ.md` (рядом с этим файлом).

## Что нужно сделать

Агент должен прочитать `TZ.md`, изучить текущий код (`src/`, `tests/`), изучить API
расширений pi (`C:\Users\r.edokov\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\docs\extensions.md`)
и реализовать доработку: добавить команду `/transcribe-gigaam`, сделать `--model` опциональным
(по умолчанию whisper-large для `/transcribe`), и **включить автосуммаризацию транскрипции через самого
pi-агента** (через `pi.sendUserMessage(...)` после успешной транскрибации).

После — обновить тесты, README, синхронизировать установленную копию в
`C:\Users\r.edokov\.pi\agent\extensions\pi-transcribe\`, прогнать `npm test` и `npm run build`.

## Команда для запуска (выполнить в bash/PowerShell)

```bash
pi --prompt "Ты — senior TypeScript-разработчик расширений для pi-coding-agent.

Твоя задача: доработать расширение pi-transcribe по техническому заданию в файле C:\Tools\pi-transcribe\TZ.md. Прочитай его ПОЛНОСТЬЮ перед началом работы.

Краткая суть доработки (полное ТЗ — в TZ.md):
1) Разделить команду /transcribe на две: /transcribe (по умолчанию модель whisper-large) и /transcribe-gigaam (по умолчанию модель gigaam). Флаг --model продолжает работать и перекрывает дефолт.
2) После успешной транскрибации расширение должно автоматически отправлять агенту pi-coding-agent через pi.sendUserMessage(...) запрос на саммаризацию транскрипции (структурированное резюме на русском: тема, тезисы, решения, открытые вопросы). Саммари должно отключаться флагом --no-summary и переопределяться через --summary-prompt.
3) Длинные транскрипции (>8000 символов) в промпте саммари обрезать с пометкой.
4) Обновить юнит-тесты (включая мок pi.sendUserMessage), README, синхронизировать установленную копию в C:\Users\r.edokov\.pi\agent\extensions\pi-transcribe\.
5) Прогнать npm test и npm run build — оба должны быть зелёные.

Что нужно прочитать перед началом:
- C:\Tools\pi-transcribe\TZ.md (полное ТЗ)
- C:\Tools\pi-transcribe\README.md
- C:\Tools\pi-transcribe\src\index.ts, paths.ts, pipeline.ts, prompt.ts, output.ts
- C:\Tools\pi-transcribe\tests\test.mts
- C:\Users\r.edokov\AppData\Roaming\npm\node_modules\@earendil-works\pi-coding-agent\docs\extensions.md (особенно секции pi.sendMessage, pi.sendUserMessage, pi.registerCommand)

Ограничения:
- НЕ менять скрипты в C:\MyProjects\transcribe\.
- НЕ хардкодить API-токены.
- НЕ вводить persistent state — состояние остаётся на диске в out/.
- Стиль кода — как в текущем проекте (strict TS, ESM, no comments излишние).

В конце пришли отчёт в чат:
- что именно изменено в каждом файле,
- результат npm test (passed/failed/skipped),
- результат npm run build,
- путь к синхронизированной копии,
- пример вызова /transcribe-gigaam в TUI pi."
```

## Альтернатива: запуск из директории проекта

```bash
cd C:\Tools\pi-transcribe
pi --prompt "Реализуй доработку по TZ.md в текущей директории. Краткая суть: добавить команду /transcribe-gigaam (модель по умолчанию gigaam); /transcribe по умолчанию использует whisper-large; после успешной транскрибации — автоматически отправлять агенту через pi.sendUserMessage(...) запрос на саммаризацию. Флаги --no-summary и --summary-prompt должны работать. Обнови тесты, README и синхронизируй установленную копию в C:\Users\r.edokov\.pi\agent\extensions\pi-transcribe\. В конце дай отчёт: что сделано, npm test, npm run build, как вызвать /transcribe-gigaam."
```

## После того как агент закончит

1. Перезагрузить pi-сессию (`/reload` в TUI) или перезапустить `pi`.
2. Положить тестовый файл в `C:\MyProjects\transcribe\inbox\test.mp4`.
3. В TUI pi выполнить:
   ```
   /transcribe-gigaam test.mp4
   ```
4. Ожидаемый результат: текст транскрипции → саммари от агента (тема, тезисы, решения, открытые вопросы).
