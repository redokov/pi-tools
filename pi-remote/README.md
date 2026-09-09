# Удалённый доступ к AI-агенту через веб-терминал

> Документ для коллеги. Описывает архитектуру, технологии и компромиссы готового решения, чтобы можно было адаптировать под своё окружение.

## 1. Цель и сценарий

**Задача:** работать с локальным AI-агентом (CLI, интерактивный TUI) на ноутбуке, но иметь возможность с телефона:
- видеть, что происходит в сессии;
- вмешиваться (отправлять команды, отвечать на вопросы);
- вести параллельно несколько сессий (по одной на проект), не путать их.

**Сценарий использования:**
- Днём сидишь за ноутом, работаешь с агентом в окне терминала.
- Уходишь — оставляешь вкладку браузера открытой на ноуте (агент продолжает думать/работать).
- С телефона через VPN открываешь ту же сессию, читаешь вывод, отвечаешь на вопросы агента.
- Возвращаешься к ноуту — всё уже сделано, сессия общая.

## 2. Архитектура

```
┌─────────────────┐         Tailscale         ┌──────────────────┐
│  Телефон        │   ◄───── VPN tunnel ────►  │  Ноутбук         │
│  (браузер)      │                            │                  │
│  PWA / Safari   │   WS / HTTP                │  Node.js сервер  │
│  + xterm.js     │   http://100.x.y.z:7681    │  + node-pty      │
└─────────────────┘                            └──────────────────┘
                                                          │
                                                          ▼
                                                  ┌──────────────┐
                                                  │ AI-агент     │
                                                  │ (например,   │
                                                  │  pi, aider,  │
                                                  │  claude-code)│
                                                  └──────────────┘
```

**Ключевые принципы:**
1. **PTY разделяется между клиентами** — все подключённые клиенты видят один и тот же ввод/вывод. Нет «мастера и слейва» — оба равноправные наблюдатели.
2. **PTY живёт на ноуте**, не в браузере. Закрытие телефона не убивает сессию.
3. **Несколько комнат** = несколько параллельных PTY (по одному на проект).
4. **Комнаты живут до явного удаления** — PTY-сессия не уничтожается автоматически при отключении клиентов или завершении процесса. Комнату можно удалить через DELETE /api/rooms/:name или перезапустить кнопкой "Restart pi". Если PTY завершился, комната остаётся доступной для переподключения и рестарта.
5. **Аутентификация — один админ с паролем** — пароль задаётся в `.env` (`PI_REMOTE_PASSWORD`); без него сервер не стартует (fail-closed). Сессия — долгоживущая cookie (по умолчанию 30 дней, скользящий TTL), так что с телефона не надо логиниться каждую неделю. Подробнее — п. 5.9.

## 3. Технологический стек

| Компонент | Технология | Почему именно это |
|---|---|---|
| Сервер | **Node.js 24** | Был под рукой, есть prebuilt нативные модули |
| Нативный PTY | **node-pty 1.1.0** (prebuilt для win32-x64) | Единственный способ получить настоящий ConPTY на Windows. Активно поддерживается Microsoft, используется в VS Code |
| WebSocket | **ws 8.18** | Минималистичная и быстрая WS-библиотека |
| Терминал в браузере | **xterm.js 6** (локальный бандл в `static/`) + fit-аддон | Стандарт де-факто для эмуляции терминала в браузере |
| Транспорт | **Tailscale VPN** | Приватная сеть без публичного IP, peer-to-peer, бесплатно для личного использования |
| Файрвол Windows | Правило на интерфейс `Tailscale` | Дефолтного правила может не быть — нужно явно открыть порт |
| Менеджер процессов | **Task Scheduler** (встроен в Windows) | Автозапуск без сторонних утилит |

## 4. Структура решения

```
C:\Tools\pi-remote\
├── server.js          # основной сервер: HTTP + WebSocket + аутентификация
├── start.bat          # запуск через cmd (даёт настоящую консоль)
├── .env               # ПАРОЛЬ и настройки (в git/backup не класть)
├── .env.example       # шаблон .env (без секретов)
├── package.json
├── node_modules\      # node-pty, ws
├── static\
│   ├── xterm.js       # 283 КБ — терминал-эмулятор
│   ├── xterm.css
│   └── xterm-addon-fit.js
└── server.log
```

**Ключевая особенность — встроенные HTML-страницы.** Фронтенд (`/` для главной, `/room/:name` для терминала) **встроены прямо в `server.js`** как template-literal константы. Это сознательное упрощение: однофайловое приложение, не нужен отдельный фронт-билд. Для 1000 строк UI это нормально, для 100к строк — нет.

## 5. Подробный разбор кода

### 5.1. Архитектура сервера

```js
// rooms: Map<roomName, RoomState>
const rooms = new Map();
```

Каждая комната — это:
- имя (идентификатор),
- `cwd` (рабочая директория),
- `cmd` (что запустить, по умолчанию `pi`),
- `pty` (нативный процесс),
- `clients: Set<WebSocket>` (подключённые браузеры).

### 5.2. PTY-слой (node-pty)

```js
// node-pty prebuilds (1.1.0 / 1.2.0-beta) на этой машине обнуляют 0x5C (backslash)
// в строках, передаваемых в нативный слой: "C:\\Users\\..." -> "C:Users..." ->
// "File not found". Forward slashes доживают и принимаются и conpty, и winpty,
// поэтому cmd и cwd нормализуем в forward slashes прямо перед spawn.
const toForwardSlashes = (p) => p.replace(/\\/g, '/');

const proc = pty.spawn(toForwardSlashes(cmd), [], {
  name: 'xterm-256color',
  cols: 120, rows: 30,
  cwd: toForwardSlashes(cwd),
  env: { ...process.env, TERM: 'xterm-256color' },
  useConpty: true   // явный conpty — стабильнее winpty для TUI (ansi/курсор)
});
```

**Важно:**
- `cols/rows` — виртуальный размер терминала. **Должен совпадать** с тем, что в `term.options.cols/rows` на клиенте, иначе TUI рисуется криво.
- `cwd` — стартовая директория. Нельзя менять в рантайме (PTY не имеет chdir-API на Windows; на Linux — `process.chdir()`).
- `name: 'xterm-256color'` — чтобы программы внутри думали, что мы в нормальном терминале, и не отключали цвета/курсор.
- **Пaths → forward slashes.** Windows-пути с `\\` в аргументах `pty.spawn()` ломаются (см. п. 7, «Чёрный экран: File not found: C:Users...»). Нормализация обязательна.
- **`useConpty: true`** — принудительно использовать ConPTY (не WinPTY). ConPTY корректно передаёт ANSI-escape, конус и input modes, которых требует pi TUI; WinPTY иногда терял input. Если conpty падает — вернуть `useConpty: false` (WinPTY).

```js
proc.onData(data => {
  // data — бинарный буфер с ANSI-escape-последовательностями
  const payload = JSON.stringify({ type: 'out', data: Buffer.from(data).toString('base64') });
  for (const ws of room.clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
});
```

**Base64-кодирование** обязательно: xterm.js умеет принимать либо строки, либо `Uint8Array`. Через JSON проще всего передать как base64-строку.

```js
proc.onExit(({ exitCode }) => {
  // оповещаем клиентов, что PTY умер; комната остаётся для переподключения
  room.alive = false;
});
```

### 5.3. WebSocket-протокол

Клиент → сервер:
```json
{ "type": "in",     "data": "<base64>"  }   // ввод с клавиатуры
{ "type": "resize", "cols": 120, "rows": 30 } // ресайз окна
{ "type": "ping" }                          // keepalive
```

Сервер → клиент:
```json
{ "type": "ready", "room": "komus", "cwd": "...", "clients": 2 }
{ "type": "out",   "data": "<base64>"  }   // вывод PTY
{ "type": "exit",  "code": 0 }
{ "type": "error", "error": "no such room" }
```

**`room` передаётся в query-string:** `ws://host/ws?room=komus`. Это проще, чем держать сессионный state.

### 5.4. HTTP API

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/` | Главная страница — список комнат + форма создания (требует сессию) |
| GET | `/login` | Страница входа (поле пароля) |
| POST | `/api/login` | Проверить пароль, выдать сессионную cookie `{password, next}` |
| POST | `/api/logout` | Удалить сессию и погасить cookie |
| GET | `/room/:name` | Терминальная страница (xterm.js) (требует сессию) |
| GET | `/api/rooms` | Список активных комнат (JSON) |
| POST | `/api/rooms` | Создать комнату: `{name, cwd, cmd}` |
| GET | `/api/rooms/:name` | Инфо о комнате |
| POST | `/api/rooms/:name` | Перезапустить PTY (тот же cwd/cmd) |
| DELETE | `/api/rooms/:name` | Убить комнату |
| GET | `/api/projects` | Список подпапок в `PROJECTS_ROOT` (для UI) |
| GET | `/static/*` | Локальные статические файлы (xterm.js) |
| GET | `/health` | Healthcheck (без аутентификации) |

### 5.9. Аутентификация

Один пользователь — администратор с паролем. Много пользователей / смена пароля из UI /
HTTPS-терминация / CSRF-токены — вне объёма (пароль хранится в `.env` в открытом виде осознанно).

**Как задать пароль.** Файл `.env` рядом с `server.js` (шаблон — `.env.example`):

```
PI_REMOTE_PASSWORD=<секрет>
# опционально:
PI_REMOTE_SESSION_TTL_HOURS=720   # время жизни сессии, часы (по умолчанию 720 = 30 дней)
PI_REMOTE_NOTIFY_TOKEN=<токен>     # токен для /api/notify
```

Мини-парсер `.env` (строки `KEY=VALUE`, `#`-комментарии, trim) встроен в `server.js`, без
зависимостей. **Переменные реального окружения перекрывают файл.** Значения из `.env` никогда
не логируются. Сгенерировать пароль:
`node -e "console.log(require('crypto').randomBytes(9).toString('hex'))"`

**Поведение без пароля — fail-closed.** Если `PI_REMOTE_PASSWORD` не задан ни в env, ни в
`.env` (в т.ч. пустой), сервер печатает понятную ошибку и завершается с кодом 1.

**Флоу.** Неаутентифицированный запрос на страницу (`/`, `/room/*`) → редирект 302 на
`/login?next=<оригинальный путь>`; после ввода пароля — редирект обратно на `?next=`
(валидация: только пути, начинающиеся с одного `/`, без схемы — защита от open redirect).
API без сессии → `401 {"error":"unauthorized"}`. WebSocket-апгрейд без сессии отклоняется
ДО handshake (plain 401, соединение рвётся). Фронтенд при 401 от fetch и при потере сессии
на WS сам уводит браузер на `/login`.

**Сессии.** `Map<token, session>` в памяти сервера; токен — `crypto.randomBytes(32)` в hex.
Cookie `pi_session`: `HttpOnly`, `Path=/`, `SameSite=Lax`, `Max-Age = TTL`; флаг `Secure`
добавляется только если запрос пришёл по https (`x-forwarded-proto` или TLS-сокет) — по
голому HTTP внутри Tailscale Secure сломал бы cookie. TTL скользящий (каждый визит
продлевает и серверную сессию, и cookie), чистка протухших — раз в час. Перезапуск
сервера инвалидирует все сессии (приемлемо: логин заново один раз).

**Безопасность.** Сравнение пароля — `crypto.timingSafeEqual` по sha256-хэшам обеих сторон
(constant-time). Rate limit на `POST /api/login`: 5 неудач с одного IP → блок на 60 секунд
(429 `too many attempts`). Ответы страниц и API — `Cache-Control: no-store`.

**Что НЕ защищено паролем (исключения):** `GET /health` и `POST /api/notify` — последний
остаётся на своём machine-to-machine токене `X-Notify-Token` (`PI_REMOTE_NOTIFY_TOKEN`),
cookie там не участвует; pi-billing-window продолжает работать как раньше.

**Logout.** Кнопка `Logout` на главной странице → `POST /api/logout` (сессия удаляется,
cookie гасится) → редирект на `/login`.

E2E: `test-e2e-auth.cjs` (fail-closed, 302/401, cookie, WS-upgrade, logout, notify,
rate limit); mobile/delete/rooms-тесты логинятся через CDP-форму.

### 5.5. Жизненный цикл комнаты

Комнаты не уничтожаются автоматически. PTY может завершиться (`room.alive = false`), но комната остаётся в `rooms` до явного удаления через `DELETE /api/rooms/:name` или перезапуска сервера. Это позволяет:
- переподключиться к комнате после завершения PTY и посмотреть буфер вывода;
- перезапустить PTY кнопкой "Restart pi" без потери истории и URL.

```js
// server.js: при выходе PTY только устанавливаем флаг
proc.onExit(({ exitCode }) => {
  room.alive = false;
  // клиенты получают { type: 'exit', exitCode }
});
```

### 5.6. Транслитерация имени

JS-валидация с кириллицей в regex-ах **ненадёжна** (зависит от флага `u`). Решение — **транслитерировать** на клиенте:

```js
function safeRoomName(s) {
  const map = { 'а':'a','б':'b','в':'v', /* ... */ 'я':'ya' };
  let out = '';
  for (const ch of s.toLowerCase()) {
    out += map[ch] !== undefined ? map[ch] : (/[a-z0-9_-]/.test(ch) ? ch : '_');
  }
  return out.replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
}
```

Пользователь вводит «Комус», получает «komus» — обратная связь зелёной подсветкой поля.

### 5.7. Frontend: главная страница

Список комнат + форма создания. Особенности:
- **Не inline-строки в `onclick`** — это ломается на путях с обратным слэшем (`\M` в JS-строке = escape-последовательность, и путь «C:\MyProjects\Комус» превращается в «C:MyProjectsКомус»). Используем `data-атрибуты`:
  ```js
  `<button data-name="${name}" data-path="${path}" class="pbtn">`
  ```
  И отдельно навешиваем обработчик через `querySelectorAll('.pbtn').forEach(b => b.onclick = ...)`.
- **Авто-обновление списка** каждые 5 секунд (`setInterval(load, 5000)`).
- **Кнопки проектов** генерируются из `GET /api/projects` — не нужно хардкодить.
- **«✕ Close session» на каждой карточке комнаты** — завершает сессию: `DELETE /api/rooms/:name` (убивает PTY, комната исчезает из списка). Действие подтверждается `confirm()`; отмена ничего не меняет.

### 5.8. Frontend: терминальная страница

**xterm.js v6 + FitAddon** (бандл лежит локально в `static/`, отдаётся через `/static/*`):
```js
const term = new Terminal({ fontSize: 14, fontFamily: 'Consolas, Menlo, monospace', cursorBlink: true });
const fit = new (typeof FitAddon !== 'function' ? FitAddon.FitAddon : FitAddon)();
term.loadAddon(fit);
term.open(document.getElementById('x'));
fit.fit();
```

**Scrollback=1000** (дефолт xterm) — компромисс: больше = больше памяти в браузере телефона, меньше = не видно истории.

**Мобильный viewport.** Meta-tag `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`:
- `interactive-widget=resizes-content` — системная клавиатура сжимает layout, а не перекрывает его (Chrome 108+): низ UI и панель клавиш всегда выше клавиатуры, терминал рефиттится.
- `viewport-fit=cover` + `env(safe-area-inset-*)` — корректные отступы на устройствах с «чёлкой»/жест-баром.

**Запрет горизонтального дрейфа (фикс «текст уезжает вправо при наборе»).** При IME-композиции Android Chrome панорамирует страницу/`.xterm-viewport` по горизонтали, когда каретка у правого края. Лечится комбинацией:
- клампинг `scrollLeft` на scroll-событии (capture-фаза) + подстраховка `setInterval(250)`;
- CSS: `#x { overflow:hidden }`, `#x .xterm { touch-action: pan-y }` (вертикальный скролл жестом разрешён, горизонтальный pan жестом отключён).

**Скролл к курсору при вводе** (курсор всегда в видимой зоне, IME-композиция не уходит за край):
```js
xterm.onData(function (d) {
  sendInput(d);
  setTimeout(function () { scrollToBottom(); }, 0);
});
// scrollToBottom(): xterm v6 в этом бандле отдаёт buffer.viewportY только на чтение,
// поэтому скроллим публичным API, запись viewportY оставлена как fallback:
function scrollToBottom() {
  if (typeof xterm.scrollToBottom === 'function') xterm.scrollToBottom();
  else xterm.buffer.active.viewportY = Math.max(0, xterm.buffer.active.length - xterm.rows);
}
```

**Кнопка «↓ Bt» (scroll to bottom).** Показывается, когда пользователь оторвался от дна
(`viewportY < buffer.length - rows - 1`), прячется на дне; тап возвращает на дно.
`term.onScroll` не срабатывает при программном `term.write()`, поэтому позиция проверяется
`setInterval(500)` + мгновенно после каждого `fit()`. Кнопка fixed в правом нижнем углу,
44×44, тёмная тема, отступ с учётом `safe-area-inset-bottom`.

**Поворот и ресайз.** Триггеры `window.resize` + `orientationchange` + `visualViewport.resize`,
дебаунс ~150 мс, повторный `fit()` через double-rAF после смены ориентации:
- **поворот** (изменилось соотношение сторон) — refit и **всегда к дну**;
- **открытие/закрытие клавиатуры** (`visualViewport.resize` без смены ориентации) — позиция чтения сохраняется, чтобы вид не прыгал при наборе.

**Панель клавиш («⌨ Keys» в тулбаре).** Скрыта по умолчанию; состояние — в `localStorage`
(ключ `piKeysPanel`). Панель — обычный блок внизу flex-колонки (не fixed): не перекрывает
ввод TUI, терминал рефиттится в оставшееся место; 2 ряда с горизонтальным скроллом на узком
экране; тач-таргеты ≥ 44px; отправка — на `touchstart` c `preventDefault()` (фокус xterm не
теряется), на десктопе — клик. Все клавиши шлют те же байты, что и клавиатура, через общую
функцию `sendInput(d)` (WS `{type:'in', data:base64}`):

| Кнопка | Байты в PTY | Кнопка | Байты в PTY |
|---|---|---|---|
| Esc | `1b` | Ctrl+C | `03` — прервать / очистить ввод |
| Tab | `09` | Ctrl+D | `04` — EOF / выход |
| ↑ ↓ ← → | `1b 5b 41 / 42 / 44 / 43` | Ctrl+Z | `1a` — suspend |
| Home / End | `1b 5b 48` / `1b 5b 46` | Ctrl+U | `15` — стереть строку до курсора |
| PgUp / PgDn | `1b 5b 35 7e` / `1b 5b 36 7e` | Ctrl+R | `12` — поиск по истории |
| Enter | `0d` | Ctrl+L | `0c` — очистить экран |

Плюс дубль кнопки «↓ Bt» в правом ряду панели. Backspace не вынесен (есть на системной
клавиатуре). Ctrl-комбинации — готовые байты в один тап (вариант A ТЗ), sticky-модификатор
не делается. E2E: `test-e2e-mobile.cjs` (T1–T5, мобильная эмуляция через raw CDP).

**Тулбар комнаты:** `Reconnect` (переподключить WS), `Restart pi` (пересоздать PTY той же комнаты),
«⌨ Keys» (панель клавиш), `Delete` (завершить сессию: `DELETE /api/rooms/:name` — убивает PTY,
удаляет комнату и возвращает на главную; confirm-guarded).

**Уведомления `/api/notify`** доставляются и на терминальные страницы (`/room/:name`) в виде toast + системное Notification.

## 6. Точки адаптации (где менять под своё окружение)

### 6.1. Команда по умолчанию (не pi)

```js
const SHELL_CMD = process.argv[3] || path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'pi.cmd');
```

Заменить на свой агент:
- `aider`, `claude`, `cursor-cli` — обычно `pip install` или `npm install -g`, бинарь в `~/.local/bin/aider` или `~/AppData/Roaming/npm/claude.cmd`.
- На macOS/Linux: `~/.local/bin/aider` или `/usr/local/bin/aider`.

### 6.2. Корневая папка проектов

```js
const PROJECTS_ROOT = (process.argv[4] || 'C:\\MyProjects').replace(/^"|"$/g, '');
```

Передать как 3-й аргумент:
```bash
node server.js 7681 "/path/to/aider" "/Users/me/Projects" 120
```

### 6.3. Shell вместо прямого запуска команды

Если хочется запускать через `bash -lc "aider"`, меняем:
```js
const SHELL_CMD = process.argv[3] || 'bash';
const SHELL_ARGS = os.platform() === 'win32' ? [] : ['-lc', 'aider'];
// в pty.spawn:
pty.spawn(SHELL_CMD, SHELL_ARGS, { ... })
```

### 6.4. Порт и автозапуск

**Windows:** Task Scheduler (уже настроено в скрипте `Register-ScheduledTask`).
**macOS:** launchd — `~/Library/LaunchAgents/com.user.pi-remote.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.user.pi-remote</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/me/Tools/pi-remote/server.js</string>
    <string>7681</string>
    <string>/usr/local/bin/aider</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```
И `launchctl load ~/Library/LaunchAgents/com.user.pi-remote.plist`.

**Linux:** systemd unit `~/.config/systemd/user/pi-remote.service`:
```ini
[Unit]
Description=Pi Remote
[Service]
ExecStart=/usr/bin/node /home/me/Tools/pi-remote/server.js 7681 /usr/local/bin/aider
Restart=always
[Install]
WantedBy=default.target
```
И `systemctl --user enable --now pi-remote`.

### 6.5. Tailscale firewall

**Windows:** правило на интерфейс (уже создано в скрипте `New-NetFirewallRule -InterfaceAlias "Tailscale"`).
**macOS:** `socketfilterfw` или `pf`. Tailscale по умолчанию в профиле `private` — порт должен быть открыт.
**Linux:** `ufw allow in on tailscale0 to any port 7681`.

### 6.6. Прокси-режим для уже запущенного PTY (advanced)

Сейчас сервер **сам спавнит** PTY. Если хочется подключаться к **уже работающему** терминалу (например, ты в Tmux/WezTerm), нужна другая архитектура:
- **WezTerm** (кроссплатформенный) умеет отдавать свой `mux server` по TCP — тогда клиент подключается прямо к нему.
- **tmux** (Linux/macOS) — `tmux -L mypipe new -d -s pi "aider"` + клиент подключается к `/tmp/mypipe`. Можно пробросить через WebSocket (wstty, gotty).

Это существенно сложнее, обычно не нужно. Описанное решение покрывает 95% кейсов «мне нужно видеть сессию с телефона».

### 6.7. HTTPS без предупреждений

Tailscale умеет выдавать сертификаты для `100.x.y.z` через Let's Encrypt (функция `tailscale cert`). Тогда `https://100.116.160.70:7681` будет без предупреждения «не защищено». Потребуется TLS-терминация (прокси перед Node) — например, через `caddy` или прямой TLS-модуль в Node.

## 7. Известные проблемы и фиксы (что пришлось править)

| Симптом | Причина | Фикс |
|---|---|---|
| `taskkill /F /IM node.exe` убил pi-сессии | Убили весь node, не только наш сервер | Убивать только по конкретному PID: `taskkill /F /PID 12345` |
| Сервер падает с `Error: AttachConsole failed` | node-pty требует настоящую консоль; в фоне без `start` — не работает | Запускать через `.bat` файл, который вызывается через `start` |
| `tmux` не найден в cmd | Это Linux-утилита, в Windows её нет | Использовать WSL или альтернативу (node-pty) |
| `New-NetFirewallRule` — Access is denied | PowerShell без админа | Запускать с `-Verb RunAs` |
| Валидация имени не пропускает кириллицу | JS-regex без флага `u` не работает с `\u`-классами | Транслитерировать на клиенте |
| Путь в onclick ломается: `C:\MyProjects\Комус` → `C:MyProjectsКомус` | `\M`, `\К` в JS-строке — escape-последовательности | Использовать `data-атрибуты` + `dataset`, а не inline onclick |
| Чёрный экран: `FitAddon is not a constructor` | Локальный `xterm-addon-fit.js` экспортирует `{ FitAddon: class }`, а не класс. `new FitAddon()` в `onmessage` бросал исключение → xterm не создавался | `new (typeof FitAddon !== 'function' ? FitAddon.FitAddon : FitAddon)()` — корректно для обеих форм экспорта |
| Чёрный экран: `File not found: C:Users...pmpi.cmd` | Prebuild node-pty обнуляет `0x5C` (backslash) в строках, передаваемых в нативный слой. `C:\\Users\\r.edokov\\...pi.cmd` → `C:Usersr.edokov...pmpi.cmd` → CreateProcess падает | Нормализовать `cmd` и `cwd` в forward slashes перед `pty.spawn()`: `p.replace(/\\/g, '/')`. ConPTY и WinPTY оба принимают `/` |
| Чёрный экран: `ready` приходит раньше `Terminal` | WebSocket-`ready` arrives before local `xterm.js` / `xterm-addon-fit.js` loaded, `new Terminal()` в `onmessage` бросает | Сервер отдаёт xterm.js и fit-аддон из `static/` через `/static/*` (локально, без CDN). Кэш `no-store`. FitAddon конструктор — см. выше |
| Комната убивается через 120 c, даже если клиент смотрит | Idle watchdog не учитывал `clients.size`, убивал комнату без вывода PTY | Watchdog удалён; комнаты живут до явного удаления |
| Ввод пишется в середине экрана | xterm не скроллит к курсору при `term.onData` | Принудительный скролл к дну после ввода; в xterm v6 `buffer.viewportY` read-only — используется `term.scrollToBottom()` (возврат фичи в v2.1) |
| Кнопка «↓ Bt» не показывается после `term.write` | `onScroll` не срабатывает при программном выводе | `setInterval` каждые 500мс проверяет позицию (возврат фичи в v2.1) |
| Текст «уезжает вправо» при наборе на телефоне, возвращается после пробела | IME-композиция растёт за правый край, Android Chrome панорамирует страницу/`.xterm-viewport` | Viewport-meta (`interactive-widget=resizes-content`), клампинг `scrollLeft` (capture + setInterval 250), `#x{overflow:hidden}`, `touch-action: pan-y` (v2.1) |
| После поворота телефона видна середина скроллбака | `fit()` меняет rows, старый `viewportY` перестаёт означать «дно» | После поворота (смена аспекта) — всегда к дну; ресайз от клавиатуры позицию сохраняет (v2.1) |
| На телефоне кнопки тулбара не влезают, «⌨ Keys» обрезана | `#bar` — flex без переноса, ширина 390px | `flex-wrap:wrap` в `#bar` (v2.1) |
| `npm install` блокирует postinstall (EBUSY) | node-pty имеет prebuild, `postinstall` не обязателен | `--ignore-scripts` или просто перезапустить после `node-gyp rebuild` (не критично) |

## 8. Куда развивать (идеи для следующих итераций)

- **Push-уведомления** (ntfy.sh) — когда PTY «молчит» N секунд после получения данных → пуш на телефон. Удобно: агент подумал, ответил, и ты сразу знаешь.
- **HTTPS через Tailscale** (`tailscale cert`) — убрать предупреждение Safari.
- **PWA на рабочий стол телефона** — в Safari: «Поделиться → На экран Домой», будет как обычное приложение.
- **Список «частых» проектов** на главной — сейчас 56 кнопок, нужно скроллить.
- **Авто-сохранение истории** PTY в файл — если процесс умер, можно посмотреть последние N строк.
- **Аутентификация** (Tailscale ACL) — если в tailnet есть другие люди, ограничить доступ.
- **Вложенные комнаты** (по типу tmux session/window/pane) — несколько «окон» внутри одной комнаты.
- **Автоматический выбор conpty/winpty** — сейчас `useConpty: true` хардкод. Можно авто-детект по `os.release()` (build ≥ 18309 → conpty, иначе winpty) с фоллбэком при ошибке spawn.
- **Локальный xterm.js из npm-пакета** — сейчас `static/xterm.js` скачан вручную. Можно `npm i @xterm/xterm @xterm/addon-fit` и отдавать из `node_modules/` через тот же `/static/*`-маршрут, чтобы не зависеть от jsdelivr при обновлении версий.

## 9. Запуск с нуля (для проверки)

### 9.1. Linux / macOS

```bash
# 1. Установить Node.js 18+
node --version

# 2. Создать папку
mkdir -p /opt/pi-remote && cd /opt/pi-remote
mkdir -p static

# 3. Скачать xterm.js локально (обязательно — см. п. 7, чёрный экран)
curl -sL -o static/xterm.js https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js
curl -sL -o static/xterm.css https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css
curl -sL -o static/xterm-addon-fit.js https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js

# 4. package.json
cat > package.json <<EOF
{
  "name": "pi-remote",
  "dependencies": {
    "node-pty": "^1.1.0",
    "ws": "^8.18.0"
  }
}
EOF

# 5. Установить
npm install

# 6. Скопировать server.js (из этого репо)
cp /path/to/server.js .

# 7. Запустить
node server.js 7681 /usr/local/bin/aider /Users/me/Projects
```

### 9.2. Windows (проверенный сценарий)

**Критичные отличия от Linux:**

1. **node-pty prebuilds ломают backslash** в путях (см. п. 7). `server.js` уже нормализует `cmd`/`cwd` в forward slashes — ничего менять не нужно, но **не отключайте** эту нормализацию, если хотите запустить `pi.cmd` с путём `C:\\...`.
2. **Запуск через `.bat` + `start`**, иначе `AttachConsole failed`.
3. **Пароль обязателен (fail-closed)** — создайте `.env` рядом с `server.js`
   (`copy .env.example .env` + впишите `PI_REMOTE_PASSWORD`). Без пароля сервер завершится
   с кодом 1. Сервер сам читает `.env` — лаунчеры менять не нужно.
4. **Токен для `/api/notify`** — можно тоже задать в `.env`; либо по старому сценарию, если
   pi-billing-window шлёт уведомления, передать токен в запуске:
   ```bat
   @echo off
   setlocal
   set /p PI_REMOTE_NOTIFY_TOKEN=<C:\Tools\pi-billing-window\NOTIFY_TOKEN.txt
   cd /d C:\Tools\pi-remote
   node server.js 7681 "C:\Users\USER\AppData\Roaming\npm\pi.cmd" "C:\MyProjects" 120
   endlocal
   ```

```bat
:: start.bat
@echo off
cd /d C:\Tools\pi-remote
node server.js 7681 "C:\Users\USER\AppData\Roaming\npm\pi.cmd" "C:\MyProjects" 120
```

```bat
:: Запуск в фоне (из другой консоли)
start "pi-remote" C:\Tools\pi-remote\start.bat
```

### 9.3. Проверка после запуска

```bash
# Сервер поднялся (health — без аутентификации)
curl -s http://localhost:7681/health
# {"ok":true,...}

# Без пароля — страницы редиректят на логин, API отдаёт 401
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" http://localhost:7681/
# 302 http://localhost:7681/login?next=%2F
curl -s http://localhost:7681/api/rooms
# {"error":"unauthorized"}

# Логин (сессия в cookie — дальше ходим с ней)
curl -s -c /tmp/pi-cookie.txt -X POST http://localhost:7681/api/login \
  -H "Content-Type: application/json" -d '{"password":"<ПАРОЛЬ>"}'
# {"ok":true,"next":"/"}
curl -s -b /tmp/pi-cookie.txt http://localhost:7681/api/rooms
# {"rooms":[]}

# Локальный xterm.js отдаётся (с cookie)
curl -s -b /tmp/pi-cookie.txt -I http://localhost:7681/static/xterm.js | head -3
# HTTP/1.1 200 OK
# Content-Type: application/javascript; charset=utf-8
# Cache-Control: no-store

# Создать комнату через браузер или API (с cookie)
# curl -s -b /tmp/pi-cookie.txt -X POST http://localhost:7681/api/rooms -H "Content-Type: application/json" -d '{"name":"test","cwd":"C:\\MyProjects"}'
# (на Windows через curl из bash — лучше делать через браузер, см. п. 9.4)
```

### 9.4. E2E-проверка через Chrome DevTools Protocol

Все основные сценарии автоматизированы (vanilla Node + raw CDP, без playwright):

```bat
cd /d C:\Tools\pi-remote
node test-e2e-auth.cjs     :: аутентификация: fail-closed, 302/401, cookie, WS-upgrade, logout, notify, rate limit
node test-e2e-delete.cjs   :: удаление комнат (UI index + room, свой тест-сервер на 7981)
node test-e2e-mobile.cjs   :: мобильный UI T1–T5 (свой тест-сервер на 7981)
node test-e2e-rooms.cjs    :: создание комнат/auto-name/restart (живой сервер на 7681;
                           :: SKIP + exit 0, если сервер не запущен или без аутентификации)
```

auth/delete/mobile спавнят собственные тест-серверы (порт 7981/7983) со своим паролем в env —
продакшн-инстанс не затрагивается. rooms ходит на живой сервер и логинится паролем из `.env`
(пароль не логируется). Если нужен ручной прогон через CDP (порт 9222 или attach к Chrome) —
не забудьте сначала войти (см. п. 9.3, `/api/login` + cookie):

```js
// 0. Логин (иначе / редиректит на /login, а API отдаёт 401)
await page.evaluate(async () => {
  const r = await fetch('/api/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: '<ПАРОЛЬ>' }) });
  return r.json();
});

// 1. Открыть главную
await page.goto('http://localhost:7681/');

// 2. Создать комнату
await page.evaluate(async () => {
  const r = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'e2e-test', cwd: 'C:\\MyProjects\\tryouts' })
  });
  return r.json();
});

// 3. Открыть комнату
await page.goto('http://localhost:7681/room/e2e-test');
await new Promise(r => setTimeout(r, 5000)); // ждать загрузки xterm

// 4. Проверить, что терминал создан
const hasXterm = await page.evaluate(() => !!document.querySelector('.xterm'));
console.assert(hasXterm, 'xterm не создан — чёрный экран');

// 5. Отправить ввод и проверить, что он дошёл
await page.evaluate(() => {
  ws.send(JSON.stringify({ type: 'in', data: btoa(unescape(encodeURIComponent('H'))) }));
});
await new Promise(r => setTimeout(r, 1000));
const tail = await page.evaluate(() =>
  (document.querySelector('.xterm-rows')?.textContent || '').slice(-200)
);
console.assert(tail.includes('H'), 'ввод не дошёл до PTY');
```

**Критерий успеха:** терминал открыт, статус-бар pi-агента виден (`C:\MyProjects\... (master)`, `(wormsoft)`, `[осталось: N:NN м.]`), введённые символы отображаются в TUI.

После запуска вывод:
```
  [+] HTTP+WS listening on http://0.0.0.0:7681
      http://100.x.y.z:7681    <-- Tailscale (use from phone)
    Projects root: C:\MyProjects
    Shell: C:\Users\me\AppData\Roaming\npm\pi.cmd
    Session TTL: 720h (sliding)

  Press Ctrl+C to stop
```

Открыть `http://100.x.y.z:7681` в браузере телефона.

## 10. Лицензия и оговорки

Решение собрано в одном файле (`server.js`), без сборщиков и фреймворков. Зависимости только рантайм (node-pty, ws) и фронтенд (xterm.js). Всё через npm/CDN, ничего не форкали.

`node-pty` имеет **нативную зависимость** — при `npm install` может потребоваться `node-gyp`, Python, MSVC build tools. На практике на современных системах (Node 20+, prebuilt бинарники) ставится без проблем.
