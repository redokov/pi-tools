# Развёртывание и диагностика уведомлений `billing:window_reset` → pi-remote

Это рабочая инструкция: что должно работать, как развернуть с нуля, и как пошагово локализовать проблему, если уведомление не приходит в браузер.

## 1. Архитектура end-to-end (напоминание)

```
pi-billing-window                pi-remote                       Браузер
─────────────────                ─────────                       ───────
after_provider_response          POST /api/notify                index.html
       │                              │                              │
       ▼                              ▼                              ▼
ticker.checkAndReset ──emit──▶ {type,provider,title,body}  ──403/400/200──▶ WS broadcast ──▶ showToast()
       │                       X-Notify-Token check                │
       │                       body validation                     ▼
       ▼                                                          new Notification()
sendNotify(payload)                                            (если tab visible/focused)
       │
       ▼
fetch(POST http://localhost:7681/api/notify)
   headers: { Content-Type, X-Notify-Token: env.PIE_REMOTE_NOTIFY_TOKEN }
   timeout: 3000 ms
```

**Три точки отказа**, проверяем последовательно:
1. **`sendNotify()` из pi** — доходит ли HTTP POST вообще.
2. **`pi-remote /api/notify`** — принимает ли запрос, авторизован ли, валиден ли body, рассылает ли WS.
3. **Браузер** — открыт ли pi-remote, разрешены ли нотификации, приходит ли WS-сообщение.

---

## 2. Предварительные требования

| Компонент | Минимум |
|---|---|
| Node.js | ≥ 18 (нужен нативный `fetch`, `AbortController`) |
| pi-coding-agent | установлен (`C:\Users\r\.pi\agent\…`) |
| pi-billing-window | развёрнут в `C:\Users\r\.pi\agent\extensions\pi-billing-window\` (см. `docs/DEV-WORKFLOW.md`) |
| pi-remote | код в `C:\Tools\pi-remote`, `npm install` выполнен |
| Браузер | Chrome / Edge / Firefox (любой с Notification API) |
| Порт | `7681` свободен на `localhost` |

---

## 3. Развёртывание с нуля

### Шаг 1. Запустить pi-remote

```powershell
# опционально: задать общий секрет (рекомендуется)
$env:PI_REMOTE_NOTIFY_TOKEN = "your-shared-secret-here"

cd C:\Tools\pi-remote
npm start
```

Ожидаемый вывод (важные строки помечены `>>`):
```
[+] HTTP+WS listening on http://0.0.0.0:7681
  [*] Projects root: C:\Tools
>>[!] PI_REMOTE_NOTIFY_TOKEN not set -- notify endpoint open without auth
```
или
```
>>  (строка про отсутствие токена НЕ печатается — значит токен задан)
```

**Проверка:** `curl http://localhost:7681/` отвечает HTML (страница списка проектов).

### Шаг 2. Открыть pi-remote в браузере

В Chrome/Edge: **`http://localhost:7681/`**.

**Проверки в DevTools (F12 → Console):**
```
[notify-ws] connecting to ws://localhost:7681/ws?room=__notify_index__
[notify-ws] connected
```

Если видите `[notify-ws] error` или `[notify-ws] closed` — WS-соединение не установилось. Проверьте, что сервер запущен и порт не блокируется файрволом/антивирусом.

**Проверка разрешения на нотификации:**
- В адресной строке слева — иконка замка/колокольчика. Если нотификации заблокированы → разблокировать.
- В Console: `Notification.permission` должно вернуть `"granted"` (или `"default"` с последующим `requestPermission()`).

### Шаг 3. Убедиться, что pi-billing-window знает про токен

Тот же секрет должен быть в окружении **процесса pi**:

```powershell
# Проверить, что токен виден внутри pi:
/billing-status
# (пока не шлёт уведомление, но проверит, что расширение загружено)
```

Чтобы передать токен **в pi**:
- **Вариант A** — переменная окружения всего процесса. В PowerShell:
  ```powershell
  $env:PI_REMOTE_NOTIFY_TOKEN = "your-shared-secret-here"
  # затем запустить pi как обычно
  ```
  В терминале Windows (cmd):
  ```cmd
  set PI_REMOTE_NOTIFY_TOKEN=your-shared-secret-here
  ```
  ⚠️ Это значение действует только в текущей сессии терминала. Для постоянного — прописать в системных env-переменных.

- **Вариант B** — системная переменная (GUI): `Система → Дополнительные параметры → Переменные среды → Создать…`, имя `PI_REMOTE_NOTIFY_TOKEN`, значение = секрет.

> **Главное правило:** значение `PI_REMOTE_NOTIFY_TOKEN` в окружении **pi** должно быть **побайтно равно** значению `PI_REMOTE_NOTIFY_TOKEN` в окружении **pi-remote**. Иначе pi-remote ответит `403 invalid token`.

### Шаг 4. Проверить, что pi-billing-window видит токен

В `notifier.ts` токен читается так:
```ts
const fromEnv = process.env.PI_REMOTE_NOTIFY_TOKEN;
if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
return null;
```

Если `process.env.PI_REMOTE_NOTIFY_TOKEN === undefined` или пустая строка — заголовок `X-Notify-Token` **не отправляется**.

Быстрая проверка через pi (если есть способ прокинуть в Node):
```powershell
node -e "console.log('TOKEN=' + JSON.stringify(process.env.PI_REMOTE_NOTIFY_TOKEN))"
```
Должно напечатать ваш секрет. Если `undefined` — pi его не видит.

### Шаг 5. Спровоцировать reset и проверить доставку

Самый быстрый способ:
```
/settimer 0
```

Это даёт немедленный reset (`windowStartedAt = now - 2ч` → окно сразу истекшее), и `checkAndReset()` эмитит `billing:window_reset` → `sendNotify()` → POST в pi-remote.

**Что должно произойти в течение ≤ 3 секунд:**

1. **Браузер:** всплывающее системное уведомление Windows с заголовком «Wormsoft: лимит обновлён» и телом «2-часовое окно сброшено (reset #N)…».
2. **Страница pi-remote:** toast в правом нижнем углу (живёт 10 секунд).
3. **DevTools Console браузера:**
   ```
   [notify-ws] msg: {"type":"notify","notify":{"type":"billing:window_reset","provider":"wormsoft","title":"Wormsoft: лимит обновлён","body":"...","timestamp":...}}
   ```
4. **Серверный лог pi-remote (`server.log` или stdout):**
   ```
   [*] notify "Wormsoft: лимит обновлён" -> N clients
   ```
   где `N` ≥ 1 (если `N = 0` — WS-клиенты не подключены → см. § 5.3).

### Шаг 6. Сохранить конфигурацию

Если на шаге 3 вы задали токен через `$env:…`, он не переживёт перезагрузку. Чтобы зафиксировать:

**Рекомендуемый способ — `.env` или системные переменные:**

- Для **pi-remote**: добавьте в `start.bat` строку `set PI_REMOTE_NOTIFY_TOKEN=...` перед `node server.js`.
- Для **pi**: задайте системную переменную окружения с тем же значением.

---

## 4. Сводка по «должно быть настроено»

| Где | Переменная | Значение |
|---|---|---|
| Процесс `pi` (или системная) | `PI_REMOTE_NOTIFY_TOKEN` | секрет |
| Процесс `pi-remote` (или системная) | `PI_REMOTE_NOTIFY_TOKEN` | **тот же** секрет |
| URL | (по умолчанию `http://localhost:7681/api/notify`) | если меняли — пробросить через `--url` (не реализовано; правка в `notifier.ts`) |
| Порт pi-remote | (по умолчанию `7681`) | если меняли — менять `DEFAULT_URL` в `notifier.ts` |

---

## 5. Диагностика: уведомление не приходит

Идите **снизу вверх** — от самого близкого к вам слоя.

### 5.1. Браузер не показывает ни toast, ни системное уведомление

**Шаг A. Подключён ли WS?**
- F12 → Console.
- Должны быть строки `[notify-ws] connecting to …` и `[notify-ws] connected`.
- Если `error`/`closed` — браузер не достучался до WS.

Возможные причины:
- pi-remote не запущен (или упал).
- Порт 7681 занят другим процессом (`netstat -ano | findstr :7681`).
- Антивирус / корпоративный файрвол блокирует localhost-порт.
- Браузер открыт не на `http://localhost:7681/` (например, `http://127.0.0.1:7681/` — обычно работает, но проверьте).

**Шаг B. Разрешены ли нотификации?**
- В Console: `Notification.permission` → должно быть `"granted"`.
- Если `"denied"` → настройки сайта блокируют. Слева от адреса → колокольчик → «Разрешить».

**Шаг C. Видны ли сообщения в WS?**
- Если `[notify-ws] msg: {...}` в Console есть, но toast не показывается — баг в `showToast()`. Откройте Sources → найдите функцию `showToast` в `server.js` (она инлайнится в HTML) → поставьте breakpoint → повторите `/settimer 0`.

### 5.2. Toast есть, системного уведомления нет

- macOS / Windows: разрешите «уведомления» в системных настройках для браузера.
- Браузер свёрнут или вкладка в фоне — современные браузеры всё равно показывают, но **проверьте режим «Не беспокоить» / Focus Assist**.
- В Console: `Notification.permission === "granted"`?

### 5.3. Сервер пишет `[*] notify "..." -> 0 clients`

Это значит `/api/notify` отработал, но **никто не слушает WS**.

Причины:
- В браузере не открыта вкладка `http://localhost:7681/` (или была свёрнута и ушла в сон — но WS обычно держится).
- Вкладка открыта, но JS упал до инициализации WS — смотреть Console на ошибки загрузки.
- Открыта другая комната (`/room/foo`), а не index. WS уведомлений подключается только на `/` (index).

**Проверка:** откройте `http://localhost:7681/` — увидите `[notify-ws] connected` в Console.

### 5.4. Сервер пишет `403 invalid token`

Токены не совпадают. Проверьте:

```powershell
# В двух разных окнах терминала — там, где запущен pi, и там, где pi-remote:
node -e "console.log(JSON.stringify(process.env.PI_REMOTE_NOTIFY_TOKEN))"
```

Должны быть **идентичные** строки (включая регистр, без кавычек, без пробелов).

Частые грабли:
- В одном терминале `set X=Y`, в другом `$env:X = "Y"` — работает, но если в `Y` есть пробелы в начале/конце — обрезаются по-разному.
- `start.bat` имеет `set PI_REMOTE_NOTIFY_TOKEN=` с пустым значением.

### 5.5. Сервер пишет `400 bad json` или `400 type and title required`

`sendNotify()` в pi формирует payload:
```ts
{
  type: "billing:window_reset",
  provider: "wormsoft",
  title: "Wormsoft: лимит обновлён",
  body: "2-часовое окно сброшено (reset #N). Свежие 5M токенов доступны.",
  timestamp: Date.now()
}
```

Поле `type` и `title` присутствуют — значит, **сервер получает не наш payload**.

Причины:
- Другой процесс шлёт на тот же `/api/notify`. В Wireshark/Postman отправьте тестовый запрос:
  ```powershell
  curl -X POST http://localhost:7681/api/notify `
    -H "Content-Type: application/json" `
    -d '{"type":"test","title":"hello","body":"world"}'
  ```
  Должен вернуть `{"ok":true,"delivered":N}`. Если 400 — что-то с валидацией.
- Между pi и pi-remote вклинился прокси, который переписывает body.

### 5.6. Сервер вообще ничего не пишет (даже `[*] notify …`)

Значит POST не дошёл до pi-remote.

Проверки:
- `curl http://localhost:7681/api/notify` — должен ответить 404 (GET не поддерживается) или попасть в лог как «Not found». Если нет — сервер не слушает.
- `Test-NetConnection localhost 7681` (PowerShell) или `Test-NetConnection -Port 7681`.
- `netstat -ano | findstr :7681` — должен быть `LISTENING`.
- Файрвол Windows:
  ```powershell
  Get-NetFirewallRule | Where-Object {$_.DisplayName -like "*7681*"}
  ```
  или просто разрешите порт вручную:
  ```powershell
  New-NetFirewallRule -DisplayName "pi-remote 7681" -Direction Inbound -LocalPort 7681 -Protocol TCP -Action Allow
  ```

### 5.7. POST уходит, но `sendNotify` возвращает `{ ok:false, error:'timeout' }`

`AbortController` срабатывает через 3 секунды. Причины:
- pi-remote **работает**, но обрабатывает другой запрос дольше 3 с (очень маловероятно — `/api/notify` это `for (room of rooms.values()) { for (ws of clients) ws.send(...) }`, микросекунды).
- pi-remote **висит** (например, на SSL handshake, если reverse-proxy).
- На пути что-то очень медленное — посмотрите `server.log`, нет ли там долгих операций.

### 5.8. `sendNotify` возвращает `{ ok:false, status:5xx }`

Это `response.ok === false`. Прочитайте `[notifier] non-2xx response: <code>` из `console.warn`. Коды:
- `500` — внутренняя ошибка pi-remote (баг в server.js).
- `502`/`503`/`504` — reverse-proxy перед pi-remote.
- `403` — неверный токен (см. § 5.4).

### 5.9. WS broadcast прошёл (`[*] notify ... -> 1 clients`), но в браузере ничего

- Обновите страницу pi-remote: WS мог отвалиться, а новое соединение ещё не установилось.
- В браузере `chrome://inspect/#devices` или `edge://inspect/#devices` — нет ли там чего-то, что перехватывает WS.
- Откройте `ws://localhost:7681/ws?room=__notify_index__` в [WebSocket-клиенте](https://www.piesocket.com/websocket-tester) и вручную вызовите `/settimer 0` — должно прийти `{type:"notify",...}`.

### 5.10. Систематический способ диагностики

Запустите всё руками в одном окне PowerShell:

```powershell
# 1. Поднять pi-remote с известным токеном
$env:PI_REMOTE_NOTIFY_TOKEN = "diag-secret-123"
cd C:\Tools\pi-remote
npm start
# (в другом окне — продолжение)
```

```powershell
# 2. Сымитировать POST из pi через curl
$headers = @{ "Content-Type" = "application/json"; "X-Notify-Token" = "diag-secret-123" }
$body = '{"type":"billing:window_reset","provider":"wormsoft","title":"Test","body":"hello","timestamp":1700000000000}'
Invoke-RestMethod -Method Post -Uri "http://localhost:7681/api/notify" -Headers $headers -Body $body
# ожидаем: @{ok=True; delivered=N}
```

Если `Invoke-RestMethod` вернул `delivered >= 1` — сервер принял и разослал. Дальше смотрим браузер (§ 5.1).

Если `Invoke-RestMethod` вернул 403 — токен не совпадает.
Если 400 — payload неполный.

---

## 6. Чек-лист «зелёный свет»

Перед тем как рапортовать «не работает», пройдите:

- [ ] `curl http://localhost:7681/` → HTML 200.
- [ ] В браузере открыт `http://localhost:7681/` (не `127.0.0.1` с https, не другая комната).
- [ ] F12 → Console: `[notify-ws] connected` есть.
- [ ] `Notification.permission === "granted"` в Console.
- [ ] `PI_REMOTE_NOTIFY_TOKEN` одинаков в окружении pi и pi-remote (проверить `node -e "console.log(process.env.PI_REMOTE_NOTIFY_TOKEN)"`).
- [ ] `curl POST /api/notify` с тем же токеном возвращает `{"ok":true,"delivered":≥1}`.
- [ ] В `server.log` есть строка `[*] notify "..." -> N clients`.
- [ ] `/settimer 0` в pi вызывает `console.warn` в pi (если включён debug) и/или строку в server.log.

Если все 8 — механизм работает. Если что-то не так — соответствующая секция § 5.

---

## 7. Полный «runbook» запуска с нуля

```powershell
# === Терминал 1: pi-remote ===
$env:PI_REMOTE_NOTIFY_TOKEN = "shared-secret"
cd C:\Tools\pi-remote
npm start
# ждём "[+] HTTP+WS listening on http://0.0.0.0:7681"

# === Браузер ===
# открыть http://localhost:7681/
# F12 → Console: убедиться, что [notify-ws] connected

# === Терминал 2: pi ===
$env:PI_REMOTE_NOTIFY_TOKEN = "shared-secret"  # ТОТ ЖЕ
cd <ваш проект>
pi
# дождаться загрузки TUI

# === В pi ===
/billing-status
# должен показать состояние окна

/settimer 0
# через ≤3 с:
#   - toast в браузере (правый нижний угол)
#   - системное уведомление Windows
#   - строка в server.log pi-remote
```

Если что-то пошло не так — см. § 5.
