# Техническое задание: исправление pi-billing-window + pi-remote

> Документ содержит полный контекст для последовательного выполнения двух задач агентом.
> Выполнять строго по очереди: сначала **Задача 1**, затем **Задача 2**.

---

## Общий контекст

### Проект 1 — `C:\Tools\pi-billing-window`
Расширение для `pi-coding-agent`, которое отслеживает 2-часовое скользящее окно расхода токенов у провайдера **wormsoft**.

**Архитектура уведомлений:**
- `src/ticker.ts` — каждые 5 минут (`TICK_MS = 5 * 60 * 1000`) вызывает `checkAndReset(emit)`.
- При истечении окна `checkAndReset` перезаписывает state (`windowStartedAt = now`, `lastResetAt = now`, `resetCount++`, `callsInWindow = 0`) и вызывает `emit("billing:window_reset", fresh)`.
- `src/index.ts` подписывается на `billing:window_reset` и дергает `handleWindowResetForNotify`, который через `src/notifier.ts::sendNotify()` делает fire-and-forget POST на `http://localhost:7681/api/notify`.
- `sendNotify` читает токен из `process.env.PI_REMOTE_NOTIFY_TOKEN` (файл `NOTIFY_TOKEN.txt` содержит `065faf3d2bfc98d285ec5178c707a856`).

**Состояние:**
- Файл: `%USERPROFILE%\.pi\agent\pi-billing-window.json`
- Начальное состояние (`makeInitialState`): `windowStartedAt = Date.now()`, `lastResetAt = 0`, `windowMs = 7200000`.

### Проект 2 — `C:\Tools\pi-remote`
Node.js сервер (`server.js`, ~600 строк), который предоставляет веб-терминал к PTY сессиям pi. Работает на `0.0.0.0:7681`.

**Архитектура комнат (`rooms: Map<name, RoomState>`):**
- Каждая комната содержит `proc` (node-pty), `clients: Set<WebSocket>`, `alive`, `lastOutput`.
- Виртуальная комната `__notify_index__` — только для WS рассылки уведомлений с главной страницы.

**Эндпоинт `/api/notify`:**
- Принимает POST с JSON `{ type, title, body, timestamp }`.
- Валидирует `X-Notify-Token`.
- Рассылает `JSON.stringify({ type: 'notify', notify: body })` **всем WebSocket клиентам всех комнат** (включая терминальные).

**Главная страница (`/` = `INDEX_HTML`):**
- Встроен в `server.js` как template literal.
- Имеет notify-only WS на `__notify_index__`.
- Обрабатывает `msg.type === 'notify'` и показывает toast + `new Notification(...)` (системное уведомление).

**Терминальная страница (`/room/:name` = `terminalPageHtml`):**
- Встроена в `server.js` как функция `terminalPageHtml`.
- WS подключается к конкретной комнате (`ws?room=NAME`).
- В `ws.onmessage` обрабатывает только `ready`, `out`, `exit`.
- **НЕ обрабатывает `type: 'notify'`** — уведомления от `/api/notify` приходят, но игнорируются.

**Idle watchdog (автоудаление):**
```js
// server.js: строки ~220-230
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.name === NOTIFY_ROOM_NAME) continue;
    const hasClients = room.clients.size > 0;
    if (room.alive && !hasClients && (now - room.lastOutput) > IDLE_TIMEOUT_MS) {
      console.log(`[*] room "${room.name}" idle... destroying`);
      destroyRoom(room.name);
    }
  }
}, 10000);
```
- `IDLE_TIMEOUT_MS = 120 * 1000` (2 минуты по умолчанию).
- Также есть `scheduleRoomCleanup` в `proc.onExit`:
```js
function scheduleRoomCleanup(room) {
  if (room.idleTimer) clearTimeout(room.idleTimer);
  room.idleTimer = setTimeout(() => {
    if (room.clients.size === 0) destroyRoom(room);
  }, IDLE_TIMEOUT_SEC * 1000);
}
```

---

## Задача 1. Уведомления от billing-window не приходят в pi-remote при окончании окна

### Диагностика
- Логи `remote-stdout.txt` показывают, что POST на `/api/notify` **доходит** до сервера (`[*] notify "Wormsoft: лимит обновлён" -> N clients`).
- Однако на терминальной странице (`/room/:name`) нет обработчика `msg.type === 'notify'`. Уведомление приходит по WS, но код его просто пропускает.
- Пользователь работает преимущественно в `/room/:name`, поэтому toast и системное уведомление не отображаются.

### Что нужно сделать
1. **В `C:\Tools\pi-remote\server.js` в `terminalPageHtml`** добавить в `ws.onmessage` обработку `msg.type === 'notify'`:
   - Показывать toast аналогично главной странице (fixed div в углу экрана).
   - Делать `new Notification(title, { body })` если permission granted.
   - Toast должен быть виден поверх xterm (высокий `z-index`).
2. **Toast должен содержать** `title` + `body` из `msg.notify`.
3. **Toast автоматически исчезает** через 10 секунд (fade out + remove).
4. **Сохранить обратную совместимость** — если `msg.type` неизвестен, игнорировать (как сейчас).

### Критерии приёмки (Задача 1)
- [ ] Открыть `/room/test` (комната создана).
- [ ] В другой сессии отправить POST на `/api/notify` с `title="Test"`, `body="Hello"`.
- [ ] Во вкладке `/room/test` появляется toast с текстом "Test / Hello".
- [ ] Если браузеру выдано permission на Notification — приходит системное уведомление.
- [ ] Toast исчезает через 10 сек.
- [ ] e2e тест (`test-e2e.js` или новый файл) проверяет эту цепочку: WS подключение к комнате → HTTP POST /api/notify → WS сообщение `type:notify` → toast в DOM.

### Тестирование (Задача 1)
- **Юнит-тесты не требуются** (изменения только во встроенном HTML в `server.js`).
- **E2E:** расширить `test-e2e.js` шагом:
  1. Подключиться к `ws?room=TARGET_ROOM`.
  2. Отправить POST `/api/notify`.
  3. Проверить через CDP (`Runtime.evaluate`), что в DOM появился toast-элемент.
- **Ручное тестирование:** запустить pi-remote, открыть комнату, отправить notify-mock (`node notify-mock.cjs`), увидеть toast.

---

## Задача 2. Убрать автоудаление сессии в pi-remote

### Диагностика
- `server.js` содержит два механизма автоудаления:
  1. `scheduleRoomCleanup` — через 120 сек после `proc.onExit` уничтожает комнату, если нет клиентов.
  2. `setInterval` idle watchdog — каждые 10 сек проверяет `!hasClients && (now - lastOutput) > IDLE_TIMEOUT_MS` и вызывает `destroyRoom()`.
- Пользователь хочет, чтобы сессия жила вечно (пока сам не закроет), и чтобы другие клиенты могли подключаться в любой момент.

### Что нужно сделать
1. **Удалить idle watchdog `setInterval`** (или закомментировать) в `server.js`. Комнаты больше не должны уничтожаться по таймауту без клиентов.
2. **Удалить `scheduleRoomCleanup`** из `proc.onExit`. При выходе PTY комната НЕ должна уничтожаться.
3. **При `proc.onExit`** только установить `room.alive = false` и разослать клиентам `type: 'exit'` (это уже есть).
4. **Разрешить подключение новых клиентов** к "мёртвой" комнате (`room.alive === false`):
   - WS handshake должен приниматься (не отклоняться).
   - Клиенту отправляется `type: 'ready'` с текущим `buffer` (если есть).
   - Клиент видит сообщение в `#msg`, что PTY завершён, и может нажать "Restart pi".
5. **Кнопка "Restart pi"** (`restartRoom()`) уже работает — она делает POST `/api/rooms/:name` и пересоздаёт комнату. Убедиться, что это работает после отключения PTY.
6. **Удалить упоминание `IDLE_TIMEOUT_MS`/`IDLE_TIMEOUT_SEC`** из `start.bat`, `start-with-token.bat` и логов старта (если есть).

### Критерии приёмки (Задача 2)
- [ ] Создать комнату, отключить всех WS клиентов.
- [ ] Подождать 5 минут.
- [ ] GET `/api/rooms` — комната всё ещё в списке.
- [ ] PTY процесс завершён (`room.alive === false`), но комната существует.
- [ ] Подключиться к комнате снова через WS — соединение успешно, приходит `ready`, виден буфер.
- [ ] Нажать "Restart pi" — комната пересоздаётся, PTY запускается заново.
- [ ] Удалить комнату через DELETE `/api/rooms/:name` — комната удаляется.
- [ ] E2E тест проверяет: создание → отключение клиентов → ожидание 10 сек → проверка что комната жива → переподключение → restart.

### Тестирование (Задача 2)
- **E2E:** добавить в `test-e2e.js` шаги:
  1. Создать комнату.
  2. Закрыть WS.
  3. Подождать 3 секунды.
  4. Проверить GET `/api/rooms`, что комната всё ещё есть.
  5. Снова подключиться WS, получить `ready`.
  6. Отправить `exit` в PTY, дождаться `type: 'exit'`.
  7. Подождать 3 секунды.
  8. Проверить GET `/api/rooms`, что комната всё ещё есть.
  9. Подключиться WS снова, убедиться что соединение открыто.
  10. Вызвать restart через API, убедиться что комната running.
- **Ручное тестирование:** запустить pi-remote, создать комнату, закрыть вкладку, подождать, открыть снова — сессия должна быть на месте.

---

## Общие требования к выполнению

### 1. Бекапы
- Перед началом работы **обязательно** сделать резервные копии:
  - `C:\Tools\pi-remote\server.js` → `server.js.bak.$(Get-Date -Format yyyyMMddHHmmss)`
  - `C:\Tools\pi-billing-window\NOTIFY_TOKEN.txt` (не трогать, но сохранить)
- Резервные копии должны остаться в файловой системе.

### 2. Разработка
- Изменения производить **только** в `C:\Tools\pi-remote\server.js` (обе задачи затрагивают только его).
- `pi-billing-window` **не требует изменений** — проблема не в отправке уведомлений, а в их приёме на терминальной странице.
- Соблюдать стиль существующего кода: vanilla JS в template literals, `var` вместо `let/const` (для консистентности с остальным frontend кодом в `server.js`), чистые функции для escape.

### 3. Тестирование (E2E)
- Запустить `node test-e2e.js` до изменений — убедиться что baseline проходит.
- После изменений запустить `node test-e2e.js` — убедиться что ничего не сломалось.
- Добавить новые e2e asserts в `test-e2e.js` для обеих задач (см. Критерии приёмки).
- Сделать скриншоты через CDP (`Page.captureScreenshot`) на ключевых шагах для визуальной верификации.

### 4. Обновление документации
- **README.md `C:\Tools\pi-remote`**:
  - Убрать упоминание "Grace-period очистка" и "Idle watchdog" как автоматических механизмов.
  - Добавить описание: "Комнаты живут до явного удаления через DELETE /api/rooms/:name или перезапуска сервера. PTY может быть перезапущён кнопкой Restart pi."
  - Упомянуть, что уведомления `/api/notify` теперь показываются и на терминальных страницах (`/room/:name`).
- **README.md `C:\Tools\pi-billing-window`** (если нужно):
  - Уточнить в разделе 6.5: уведомления приходят и на главную, и на терминальные страницы pi-remote.

---

## Чек-лист перед сдачей

- [ ] Бекапы созданы.
- [ ] `node test-e2e.js` проходит (0 failed).
- [ ] `node test-e2e-rooms.cjs` проходит (0 failed).
- [ ] Ручное тестирование задачи 1: отправка `/api/notify` → toast на `/room/:name`.
- [ ] Ручное тестирование задачи 2: комната жива 5+ минут после отключения всех клиентов.
- [ ] Документация обновлена.
- [ ] Изменения не затронули `pi-billing-window` (кроме README при необходимости).
