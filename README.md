# pi-tools

Набор из 3 инструментов/расширений для [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).

---

## Список инструментов

| Инструмент | Тип | Назначение |
|---|---|---|
| **pi-billing-window** | Расширение pi | Отслеживает скользящее 2-часовое окно расхода токенов провайдера **wormsoft** (лимит 5M токенов/2ч). Публикует события в EventBus (`billing:window_reset`, `billing:window_about_to_reset`), показывает обратный отсчёт в статус-баре TUI, шлёт уведомления в pi-remote. Команды: `/billing-status`, `/billing-tick`, `/billing-reset`, `/settimer`. |
| **pi-remote** | Отдельный Node.js-сервер | Веб-терминал для удалённого доступа к AI-агенту (pi, aider, claude-code) через браузер. Работает поверх Tailscale VPN. Поддерживает несколько параллельных комнат (PTY-сессий), xterm.js в браузере, мобильный UI с панелью клавиш, системные уведомления. API: REST + WebSocket. |
| **pi-transcribe** | Расширение pi | Транскрибация аудио/видео через API wormsoft. Берёт файл из `inbox/`, запускает `prepare.py` → `transcribe.py` из проекта `C:\MyProjects\transcribe`, выводит результат в чат pi. Команды: `/transcribe`, `/transcribe-gigaam`, `/transcribe-status`. Поддерживает авто-саммаризацию через `pi.sendUserMessage`. |

---

## Требования

| Зависимость | Версия |
|---|---|
| **Node.js** | ≥ 20 (проверено на 22+) |
| **pi-coding-agent** | ≥ 0.1.0 (установлен глобально: `npm i -g @earendil-works/pi-coding-agent`) |
| **Python** | ≥ 3.10 (для pi-transcribe — скрипты `prepare.py`, `transcribe.py`) |
| **ffmpeg** | В PATH (для pi-transcribe — подготовка аудио) |
| **Tailscale** | Для pi-remote — VPN-доступ с телефона/другого устройства |
| **Windows 10/11** | pi-remote использует node-pty (ConPTY) — работает нативно на Windows |

> **Важно:** pi-billing-window и pi-transcribe — это **расширения pi**. Они загружаются автоматически, если лежат в `~/.pi/agent/extensions/<name>/` (копия из `c:/tools/<name>/src/`). pi-remote — отдельный сервер, запускается независимо.

---

## Структура репозитория

```
c:/tools/
├── README.md                 # этот файл
├── pi-billing-window/        # расширение: учёт токенов wormsoft
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/                  # исходники (index.ts, state.ts, ticker.ts, ui.ts, parser.ts, notifier.ts)
│   ├── tests/
│   ├── docs/                 # ARCHITECTURE.md, EVENTBUS.md, STATE.md, COMMANDS.md, DEV-WORKFLOW.md
│   └── examples/
├── pi-remote/                # веб-терминал (Node.js сервер)
│   ├── server.js             # основной код (HTTP + WS + xterm.js)
│   ├── start.bat             # запуск через cmd (нужен для AttachConsole)
│   ├── package.json
│   └── static/               # xterm.js, xterm.css, xterm-addon-fit.js (локально)
└── pi-transcribe/            # расширение: транскрибация
    ├── package.json
    ├── tsconfig.json
    ├── src/                  # index.ts, pipeline.ts, prompt.ts, output.ts, paths.ts
    ├── tests/
    ├── RUN.md                # инструкция по запуску агента для доработки
    └── TZ.md                 # техническое задание на доработку
```

---

## Установка зависимостей

Каждый инструмент — отдельный npm-пакет. Заходим в папку и ставим зависимости:

```powershell
# pi-billing-window
cd c:/tools/pi-billing-window
npm install

# pi-remote
cd c:/tools/pi-remote
npm install

# pi-transcribe
cd c:/tools/pi-transcribe
npm install
```

> **pi-remote:** `node-pty` имеет нативную зависимость. На Windows обычно ставится через prebuilds без проблем. Если `npm install` ругается на `node-gyp` — поставьте `windows-build-tools` или Visual Studio Build Tools.

---

## Сборка (type-check)

Все проекты используют TypeScript с `noEmit: true` — pi сам транспилирует исходники. Сборка = только проверка типов:

```powershell
# pi-billing-window
cd c:/tools/pi-billing-window
npx tsc -p tsconfig.json

# pi-transcribe
cd c:/tools/pi-transcribe
npx tsc -p tsconfig.json
# или: npm run build  (alias на tsc)

# pi-remote — чистый JS, сборка не нужна
```

---

## Запуск каждого инструмента

### 1. pi-billing-window (расширение pi)

Расширение подхватывается pi автоматически при старте, если исходники лежат в рабочей копии расширений.

**Вариант А — копирование (рекомендуется):**
```powershell
$dst = "$env:USERPROFILE\.pi\agent\extensions\pi-billing-window"
Copy-Item -Recurse -Force "c:/tools/pi-billing-window/src/*" $dst
```
Затем в pi: `/reload` или перезапуск pi.

**Вариант Б — симлинк (если pi читает через fs):**
```powershell
New-Item -ItemType SymbolicLink `
  -Path "$env:USERPROFILE\.pi\agent\extensions\pi-billing-window" `
  -Target "c:/tools/pi-billing-window"
```

**Проверка в TUI pi:**
```
/billing-status
```
Должен появиться тост с провайдером, остатком времени, количеством вызовов.

---

### 2. pi-remote (веб-терминал)

**Windows (проверенный способ):**
```bat
:: c:/tools/pi-remote/start.bat
@echo off
cd /d c:/tools/pi-remote
node server.js 7681 "C:\Users\USER\AppData\Roaming\npm\pi.cmd" "C:\MyProjects" 120
```
> Запускайте через `start "pi-remote" c:/tools/pi-remote/start.bat` — нужен настоящий консольный процесс для `AttachConsole` (node-pty).

**Параметры `server.js`:**
```
node server.js <port> <shell_cmd> <projects_root> <idle_timeout_sec>
```
- `port` — порт сервера (по умолчанию 7681)
- `shell_cmd` — что запускать в PTY (по умолчанию `pi.cmd` из npm)
- `projects_root` — корень проектов для кнопок на главной (по умолчанию `C:\MyProjects`)
- `idle_timeout_sec` — не используется (комнаты живут до явного удаления)

**После запуска:**
```
Pi Remote v2 listening on:
  http://localhost:7681
  http://100.x.y.z:7681    <-- Tailscale IP (откройте на телефоне)
Projects root: C:\MyProjects
Shell: C:\Users\USER\AppData\Roaming\npm\pi.cmd
```

Откройте `http://100.x.y.z:7681` в браузере телефона (через Tailscale).
- Главная: список комнат + создание новой
- `/room/:name` — терминал с xterm.js, панелью клавиш, тулбаром (Reconnect, Restart pi, Keys, Delete)

**Автозапуск (Windows Task Scheduler):**
См. `pi-remote/README.md` §6.4 — готовый скрипт `Register-ScheduledTask`.

---

### 3. pi-transcribe (расширение pi)

Аналогично pi-billing-window — копируем исходники в расширения pi:

```powershell
$dst = "$env:USERPROFILE\.pi\agent\extensions\pi-transcribe"
Copy-Item -Recurse -Force "c:/tools/pi-transcribe/src/*" $dst
```
Затем в pi: `/reload`.

**Требования для работы:**
1. Проект транскрибации: `C:\MyProjects\transcribe` (с `scripts/prepare.py`, `scripts/transcribe.py`, папками `inbox/`, `out/`)
2. В `C:\MyProjects\transcribe\.env` должен быть `WORMSOFT_API_TOKEN=ваш_токен`
3. Python 3.10+ и ffmpeg в PATH

**Проверка в TUI pi:**
```
/transcribe --help
/transcribe-status
```

**Команды:**
```
/transcribe                    # самый свежий файл из inbox/, модель whisper-large (по умолчанию)
/transcribe <file>             # конкретный файл из inbox/ или абсолютный путь
/transcribe --model gigaam     # переопределить модель
/transcribe --lang en          # язык (ru/en)
/transcribe --format srt       # формат вывода
/transcribe-gigaam             # тот же /transcribe, но модель по умолчанию gigaam
/transcribe-gigaam --no-summary  # отключить авто-саммаризацию
/transcribe-status             # список результатов в out/
```

После успешной транскрибации расширение **автоматически отправляет агенту pi** запрос на саммаризацию (структурированное резюме: тема, тезисы, решения, открытые вопросы). Отключается флагом `--no-summary`, промпт переопределяется `--summary-prompt`.

---

## Тестирование

### pi-billing-window
```powershell
cd c:/tools/pi-billing-window
npx tsx tests/test.mts
```
Покрывает: state (read/write/lock/mutate), ticker (checkAndReset, дедуп, about-to-reset), ui (renderStatusBar, mode !== tui), parser (все форматы, ошибки), notifier (успех, не-2xx, таймаут, сетевая ошибка).

### pi-transcribe
```powershell
cd c:/tools/pi-transcribe
npm test
```
Запускает:
- **Юнит-тесты** (без сети): paths.ts, output.ts, pipeline.ts, prompt.ts
- **Интеграционный тест** (с реальным python + ffmpeg):
  1. Генерирует `tests/fixtures/tiny_silent.wav` через ffmpeg
  2. Реальный `python scripts/prepare.py` → проверяет manifest
  3. Реальный `python scripts/transcribe.py --no-interactive` → проверяет результат
  
  > Шаг 3 **скипается**, если не задан `WORMSOFT_TEST_TOKEN` в окружении (токен нигде не хардкодится).

### pi-remote
Автоматизированных тестов нет. Ручная проверка — см. `pi-remote/README.md` §9.3–9.4:
- `curl /api/rooms` — пустой список
- `curl /static/xterm.js` — отдаёт JS
- Создать комнату через браузер или API
- Открыть `/room/:name`, проверить, что терминал рисуется, ввод проходит

**E2E через Chrome DevTools Protocol** (если есть доступ к CDP):
```js
// см. pi-remote/README.md §9.4 — полный скрипт проверки
```

---

## Переменные окружения (суммарная таблица)

| Инструмент | Переменная | Обязательность | Где задаётся |
|---|---|---|---|
| pi-billing-window | — | — | Никаких переменных, всё в `~/.pi/agent/pi-billing-window.json` |
| pi-remote | `PI_REMOTE_NOTIFY_TOKEN` | Опционально | Для приёма уведомлений от pi-billing-window (`/api/notify`) |
| pi-transcribe | `WORMSOFT_API_TOKEN` | **Да** | В `C:\MyProjects\transcribe\.env` (читают python-скрипты) |
| pi-transcribe | `WORMSOFT_TEST_TOKEN` | Для тестов | В окружении при запуске `npm test` |
| pi-transcribe | `TRANSCRIBE_PROJECT_DIR` | Опционально | Переопределяет `C:\MyProjects\transcribe` |

---

## Ссылки на документацию каждого инструмента

| Инструмент | Основной README | Дополнительные документы |
|---|---|---|
| **pi-billing-window** | `c:/tools/pi-billing-window/README.md` | `docs/ARCHITECTURE.md`, `docs/EVENTBUS.md`, `docs/STATE.md`, `docs/COMMANDS.md`, `docs/DEV-WORKFLOW.md`, `examples/subscribe.ts` |
| **pi-remote** | `c:/tools/pi-remote/README.md` | Внутри README: архитектура, код, адаптация, известные проблемы, запуск с нуля (Linux/macOS/Windows), E2E-проверка |
| **pi-transcribe** | `c:/tools/pi-transcribe/README.md` | `c:/tools/pi-transcribe/RUN.md` (инструкция для агента), `c:/tools/pi-transcribe/TZ.md` (техническое задание) |

---

## Быстрый старт для новичка (клонировал репозиторий — что делать)

```powershell
# 1. Клонировали в c:/tools
cd c:/tools

# 2. Поставили зависимости во все три инструмента
cd pi-billing-window; npm install; cd ..
cd pi-remote; npm install; cd ..
cd pi-transcribe; npm install; cd ..

# 3. Проверили типы
cd pi-billing-window; npx tsc -p tsconfig.json; cd ..
cd pi-transcribe; npx tsc -p tsconfig.json; cd ..

# 4. Установили расширения в pi (копированием исходников)
$ext = "$env:USERPROFILE\.pi\agent\extensions"
Copy-Item -Recurse -Force "pi-billing-window/src/*" "$ext\pi-billing-window"
Copy-Item -Recurse -Force "pi-transcribe/src/*" "$ext\pi-transcribe"

# 5. Подготовили проект транскрибации (только для pi-transcribe)
#    Нужна папка C:\MyProjects\transcribe с .env (WORMSOFT_API_TOKEN), scripts/, inbox/, out/

# 6. Запустили pi-remote (в отдельном окне)
start "pi-remote" c:/tools/pi-remote/start.bat

# 7. Запустили pi в проекте
pi

# 8. В TUI pi проверили:
/billing-status
/transcribe --help
/transcribe-status

# 9. На телефоне открыли http://<tailscale-ip>:7681 — веб-терминал готов
```

---

## Лицензия и поддержка

Внутренние инструменты. MIT-style (уточните у владельца при публикации).
Вопросы и баги — в трекер `pi-tools` или напрямую авторам расширений.

## Cyrillic/encoding practices


При работе с Cyrillic- именами файлов ( транскрибация pi-transcribe):


- **Python на Windows**: используйте `python -X utf8` или env `PYTHONUTF8=1` для всех скриптов с Cyrillic — default cp1251 мутирует Cyrillic в � (U+FFFD).
- **Type fresh**: при typing Cyrillic filenames в write/edit — type fresh, не copy из поврежденных tool-call.
- **Listing**: перечисление filenames через python (`os.listdir()`), bash `ls` formatting unreliable.
- **Byte verification**: для critical файлов — bash (`od`, `grep`) проверка bytes.
- **Cleanup**: command `/transcribe-fixnames` в pi-transcribe — удаляет U+FFFD и поврежденные Cyrillic из имен файлов out/.


Имя саммаризованного файла: `out/<ProjectName><CamelCaseWords>-<YYYY-MM-DD>.md` ( правила: `pi-transcribe/docs/summary.md`).
