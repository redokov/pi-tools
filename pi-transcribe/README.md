# pi-transcribe

Расширение для [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), которое из TUI `pi` одной командой запускает полный цикл транскрибации аудио/видео через API провайдера **wormsoft** (`https://ai.wormsoft.ru/api/v1/audio/transcriptions`).

Расширение не хранит своё состояние и не дублирует API-токен — оно только вызывает готовые скрипты проекта **`C:\MyProjects\transcribe`** (`scripts/prepare.py`, `scripts/transcribe.py`). Токен `WORMSOFT_API_TOKEN` читается скриптом из `.env` проекта транскрибации.

## Команды

| Команда | Что делает |
|---|---|
| `/transcribe` | Берёт самый свежий файл из `inbox/`, спрашивает модель (если не задан `--model`), запускает prepare → transcribe, печатает результат в чат. |
| `/transcribe <file>` | Конкретный файл из `inbox/` (например `meeting.mp4`). Абсолютный путь тоже можно: `/transcribe C:\Videos\a.mp4`. |
| `/transcribe-status` | Содержимое `out/`: манифесты и готовые результаты, сгруппированные по имени. |

### Флаги `/transcribe`

| Флаг | Значение | По умолчанию |
|---|---|---|
| `--lang <ru\|en>` | ISO-639-1 код языка | `ru` |
| `--model <gigaam\|whisper-large>` | Пропустить интерактивный выбор модели | спрашивает через `ctx.ui.select` |
| `--format <text\|srt\|vtt\|json\|verbose_json>` | Формат результата | `text` |
| `--help` | Справка | — |

Если для файла уже есть `out/<name>.manifest.json` (prepare уже отработал), расширение спросит «переиспользовать?» — и да, по умолчанию продолжит без повторного prepare.

Результат печатается в чат как сообщение; при длине больше 200 строк выводится первая часть с пометкой, где лежит полный файл (`out/<name>.<ext>`).

## Установка

Расширение уже лежит в `C:\Users\r.edokov\.pi\agent\extensions\pi-transcribe\` (копия из `C:\Tools\pi-transcribe`). Пи-агент обнаруживает подпапку автоматически (`*/index.ts` — глобальный scope). Перезагрузите сессию `/reload` (или перезапустите `pi`), и команды `/transcribe`, `/transcribe-status` появятся.

Проверка:

```powershell
# из любой директории
pi   # затем в TUI
/transcribe --help
/transcribe-status
```

## Переменные окружения

| Переменная | Обязательность | Где используется |
|---|---|---|
| `WORMSOFT_API_TOKEN` | **да** | в `C:\MyProjects\transcribe\.env` или в окружении; читают сами `prepare.py`/`transcribe.py`. В код/конфиг расширения **не дублируется**. |
| `WORMSOFT_TEST_TOKEN` | только для теста | `tests/test.mts` — если не задан, интеграционный API-вызов **скипается** с понятным сообщением (см. ниже). |
| `TRANSCRIBE_PROJECT_DIR` | опционально | переопределить корень проекта транскрибации (по умолчанию `C:\MyProjects\transcribe`). Используется и тестами. |

## Тесты

```powershell
# юнит-тесты (без сети) + интеграция с реальным python + ffmpeg
npm test

# только типизация
npm run build
```

Юнит-тесты: `paths.ts` (путь, валидация имени, защита от traversal), `output.ts` (чтение результата, truncation, группировка `out/`), `pipeline.ts` (построение argv + spawn на fake-скриптах), `prompt.ts` (выбор модели через `ctx.ui.select`).

Интеграционный тест:
1. генерирует `tests/fixtures/tiny_silent.wav` (2 секунды sine 440 Hz) через `ffmpeg`;
2. реальный `python scripts/prepare.py` на этом fixture → проверяет `exit 0` и наличие `out/tiny_silent.manifest.json`;
3. реальный `python scripts/transcribe.py ... --no-interactive` → проверяет `exit 0` и наличие `out/tiny_silent.txt`.

Шаг 3 **пропускается** с явным сообщением, если `WORMSOFT_TEST_TOKEN` не задан в окружении. Токен **нигде не хардкодится** — ни в исходниках, ни в тестах.

## Структура

```
pi-transcribe/
├── package.json       # поле pi.extension -> src/index.ts; type: module
├── tsconfig.json      # strict, ESM, noEmit
├── src/
│   ├── index.ts       # /transcribe, /transcribe-status; оркестратор
│   ├── pipeline.ts    # runPrepare() / runTranscribe() / prepareCommand / transcribeCommand
│   ├── prompt.ts      # askModelChoice / askReuseManifest (через ctx.ui)
│   ├── output.ts      # readResult / truncateForChat / summarizeOut / fmtBytes
│   └── paths.ts       # PROJECT_DIR, INBOX/OUT/SCRIPTS, валидация имени, setProjectDir
└── tests/
    ├── test.mts       # юнит + интеграция
    └── fixtures/      # tiny_silent.wav генерируется на лету
```

Без таймеров, без persistent state, без web-интерфейса, без `proper-lockfile` — состояние только на диске в `C:\MyProjects\transcribe\out\`.
