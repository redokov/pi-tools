# Инструкция для автономного агента: исправление двух дефектов pi-remote

> **Контекст.** Репозиторий `C:\Tools\pi-remote` — веб-сервер на Node.js (`server.js`),
> отдающий HTML со встроенным xterm.js. Страница `index` (`/`) содержит форму «New session»
> с тремя полями: **Name**, **Project** (select), **CWD** (текстовый input), и кнопкой
> **Start**. После нажатия `Start` фронт идёт на `/room/:name`, где рендерится xterm
> в браузере, который через WebSocket подключается к PTY-комнате на сервере.
>
> Изучи `C:\Tools\pi-remote\server.js` целиком перед началом. Тебе нужно внести правки
> в HTML-стринги внутри `server.js` (никаких отдельных файлов шаблонов нет — HTML
> хранится в константах `INDEX_HTML` и `terminalPageHtml`).
>
> Все тесты — через **Chrome DevTools MCP** (см. раздел «Диагностика через Chrome»).

---

## Дефект 1 — Имя сессии не заполняется автоматически

### Симптом
На `/` пользователь выбирает проект из `<select id="cwd">`, поле **Name** остаётся пустым.
Он вынужден вводить имя вручную.

### Ожидаемое поведение
При выборе значения в селекте поле `<input id="name">` должно автоматически заполниться
**транслитерированным** именем выбранной подпапки (последний сегмент пути, без префикса
корня проектов), в нижнем регистре, латиницей, цифры и `_/-` сохраняются, остальное → `_`,
макс. 40 символов. Поле `CWD` заполняется уже сейчас (`sel.onchange`) — это не трогай,
только добавь логику автоимени.

### Алгоритм транслитерации
Используй эту карту (русский → латиница, остальное заменяй на `_`):

```js
const TRANSLIT = {
  а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'i',к:'k',л:'l',
  м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',
  щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'
};
function autoNameFromCwd(cwd) {
  if (!cwd) return '';
  const seg = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  const low = seg.toLowerCase();
  let out = '';
  for (const ch of low) {
    out += TRANSLIT[ch] ?? (/[a-z0-9_-]/.test(ch) ? ch : '_');
  }
  out = out.replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'room';
  return out;
}
```

Вставка — внутри `loadProjects()`, в обработчике `sel.onchange`, добавь вторую строку
**после** присвоения `cwdCustom.value`:

```js
document.getElementById('name').value = autoNameFromCwd(sel.value);
```

Также вызывай `autoNameFromCwd(...)` один раз при `loadProjects()` — для уже выбранного
значения, когда селект только что заполнился (на случай, если юзер не кликает повторно).

### Критерий приёмки (Дефект 1)
- При выборе проекта поле `Name` заполняется транслитом имени подпапки.
- Ввод имени руками продолжает работать (поле не readonly).
- Если в селекте выбрана пустая опция-«root» (`value === ''`) — поле `Name` очищается.

---

## Дефект 2 — После нажатия Start открывается чёрное окно с красным «connected»

### Симптом (со слов пользователя)
> «Если зайти, выбрать проект и нажать кнопку Start — открывается окно с чёрным фоном,
> в нём красным пишется *connected* и больше ничего не происходит. Окна pi не видно.»

### Что известно до диагностики
- `#msg` в `terminalPageHtml` стилизован `color:#f77` (красный) на чёрном фоне → ровно то,
  что видит пользователь. Содержимое ставится из `logMsg('connected')` в `ws.onopen`.
- Через 3 секунды `logMsg` сам очищает надпись — но если после `connected` нет `ready`
  от сервера (или xterm не рендерится), юзер успевает увидеть только «connected».
- Вероятные причины (проверять по порядку, не додумывать заранее):
  1. PTY падает сразу после `spawn` (например, бинарь `pi.cmd` не найден,
     `cwd` не существует, или конфликт путей с обратными слешами — в коде есть
     `toForwardSlashes` для node-pty prebuilds).
  2. На стороне клиента JS-исключение в `onmessage` после `msg.type === 'ready'` —
     тихо глохнет, xterm не появляется. Возможные источники: `Buffer` (нет в браузере),
     `unescape` deprecation, `FitAddon.FitAddon` undefined.
  3. Размеры контейнера `#x` нулевые при первом `fit.fit()` — `proposeDimensions`
     возвращает `null` и xterm остаётся без буфера.

### Диагностика через Chrome DevTools

Агент **обязан** пройти шаги ниже перед тем, как что-либо менять в `server.js`.

#### Шаг 0 — подготовка окружения
1. Проверь, что Node ≥ 18 и установлены зависимости:
   ```powershell
   cd C:\Tools\pi-remote
   npm install
   ```
2. Запусти сервер в фоне:
   ```powershell
   Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory "C:\Tools\pi-remote" -RedirectStandardOutput "C:\Tools\pi-remote\server.log" -RedirectStandardError "C:\Tools\pi-remote\server.log" -NoNewWindow
   ```
   Подожди 1 секунду, проверь `server.log` — должна появиться строка `[+] HTTP+WS listening`.
3. Создай тестовую папку проекта, если корень `C:\MyProjects` пустой:
   ```powershell
   New-Item -ItemType Directory -Force -Path "C:\MyProjects\test-prj"
   ```

#### Шаг 1 — открыть index через Chrome DevTools
1. Вызови `chrome_devtools_list_pages`. Если пусто — `chrome_devtools_navigate` на `http://localhost:7681/`.
2. Через `chrome_devtools_evaluate` выполни диагностику:
   ```js
   JSON.stringify({
     title: document.title,
     selectOptions: [...document.querySelectorAll('#cwd option')].map(o => ({value:o.value, text:o.textContent})),
     nameInputExists: !!document.getElementById('name'),
     xtermLoaded: typeof Terminal,
     fitAddonLoaded: typeof FitAddon,
     serverReachable: (await fetch('/health')).status
   })
   ```
3. Если `xtermLoaded` или `fitAddonLoaded` не `object`/`function` — это **первопричина**:
   xterm-скрипты не загружаются. Проверь Network → `/static/xterm.js` и `/static/xterm-addon-fit.js`
   (используй `chrome_devtools_evaluate` чтобы посмотреть `performance.getEntriesByType('resource')`).

#### Шаг 2 — воспроизвести дефект
1. Через `chrome_devtools_evaluate` программно заполни форму и кликни `Start`:
   ```js
   document.getElementById('cwdCustom').value = 'C:\\MyProjects\\test-prj';
   document.getElementById('name').value = 'test-prj';
   // Запрет редиректа: перехватим
   const origAssign = window.location.assign;
   window.location.assign = () => {};
   document.querySelector('.new button').click();
   ```
2. Подожди 1.5 секунды. Прочитай `document.body.innerText` — что показывается?
3. Проверь, есть ли в DOM `<div class="xterm">` (созданный xterm при `xterm.open`).
4. Прочитай серверный лог — пришла ли строка `[+] room "..." created`?
   Если нет — PTY не стартанул, смотри `[!] pty spawn failed ...`.

#### Шаг 3 — если PTY не стартанул
Скопируй строку из лога и устрани причину в `createRoom()` в `server.js`. Типовые случаи:
- `File not found` для cmd — поправь `DEFAULT_SHELL_CMD` или передай абсолютный путь.
- `cwd does not exist` — проверь, что фронт передаёт корректный путь
  (см. сломанный `\\\\` vs `\\` в `loadProjects` — `d.root + '\\\\' + p` генерирует
  строку с **литеральными четырьмя обратными слэшами**, которые JS превращает в два).

#### Шаг 4 — если PTY стартанул, но xterm не виден
Подпишись на все ошибки:
```js
window.addEventListener('error', e => console.error('WIN-ERR', e.message, e.filename, e.lineno));
window.addEventListener('unhandledrejection', e => console.error('UNH-REJ', e.reason));
ws && ws.addEventListener && (ws.onerror = e => console.error('WS-ERR', e));
```
Затем через `chrome_devtools_evaluate` вызови:
```js
window.__diag = { logs: [] };
const origLog = console.log, origErr = console.error;
console.log = (...a) => { window.__diag.logs.push(a.join(' ')); origLog(...a); };
console.error = (...a) => { window.__diag.logs.push('ERR: ' + a.join(' ')); origErr(...a); };
```
Открой `/room/<существующая комната>` через `chrome_devtools_navigate`. Прочитай `window.__diag.logs` через 2 секунды — там будет видна либо ошибка JS, либо `connected` без последующего `ready`.

#### Шаг 5 — фикс
Внеси правки в `server.js` (HTML в `terminalPageHtml`), чтобы:
1. **Гарантировать создание xterm** до любых `fit.fit()` — обернуть в `try { ... } catch (e) { logMsg('xterm init failed: ' + e.message); }` и явно логировать.
2. **Подождать готовности DOM** — не вызывать `fit.fit()` пока `getBoundingClientRect().height === 0`. Использовать `requestAnimationFrame` дважды или `ResizeObserver`.
3. **Не падать на отсутствии `Buffer`** в браузере — заменить `Buffer.from(msg.data, 'base64').toString('binary')` на `atob(msg.data)` (последний работает везде; xterm принимает и бинарную строку, и latin1).
4. **Гасить редирект `room.exists` красиво** — если `r.status === 409` в `createRoom()`, просто `window.location.href = '/room/...'` без ошибки.

После фикса повтори Шаг 2 и убедись, что:
- В DOM есть `<canvas>` или `<div class="xterm-rows">` после `connected`.
- `document.getElementById('msg').textContent === ''` через 5 секунд.
- Курсор xterm мигает (проверь `document.querySelector('.xterm-cursor')`).

---

## E2E-тесты (обязательная часть сдачи)

Создай файл `C:\Tools\pi-remote\test-e2e-rooms.cjs` (vanilla Node + `ws` + `playwright`-headless через `chrome_devtools_*` MCP, **без** puppeteer). Минимум три сценария:

1. **`auto-name.cy.js`-style** — открыть `/`, выбрать проект, проверить, что `<input id="name">` заполнен транслитом.
2. **`start.cy.js`-style** — выбрать проект, нажать `Start`, дождаться загрузки `/room/:name`, проверить:
   - `document.querySelector('.xterm')` существует;
   - `document.querySelector('.xterm-cursor')` существует;
   - `document.getElementById('msg').textContent === ''` (или нет текста про ошибку);
   - в `server.log` есть строка `[+] client joined "..."`.
3. **`idempotent-restart.cy.js`-style** — нажать `Restart pi` на странице комнаты, убедиться, что xterm снова активен, в логе — `[+] room "..." created`.

Сценарии оформляй **как функции**, не как jest/mocha. Запуск:
```bash
node C:\Tools\pi-remote\test-e2e-rooms.cjs
```
В конце скрипт печатает `OK` или `FAIL <step> <reason>` с ненулевым exit-кодом при провале.

**Скриншоты** — обязательны. Сохрани их в `C:\Tools\pi-remote\e2e-room-fixed.png`, `e2e-start-after.png`, `e2e-restart.png`.

---

## Чек-лист сдачи (verification before completion)

Перед тем как сказать «готово», агент **обязан** запустить и показать вывод:

```powershell
# 1. type-check (Node, без TS, но прогон через node --check на server.js)
node --check C:\Tools\pi-remote\server.js

# 2. e2e
node C:\Tools\pi-remote\test-e2e-rooms.cjs
# Ожидаемый вывод: три строки "OK: ..." и финальное "ALL OK"

# 3. ручная проверка через Chrome DevTools — три скриншота сохранены

# 4. серверный лог не содержит "pty spawn failed" или "exit"
Select-String -Path C:\Tools\pi-remote\server.log -Pattern "spawn failed|Error"
```

Если хоть один пункт падает — не отдавай результат, чини дальше.

---

## Формат финального отчёта

В конце напиши:

1. **Что было сломано** (по пунктам, со ссылками на строки в `server.js`).
2. **Какие правки внесены** (дифф по сути, без полного файла).
3. **Результат e2e** — вывод скрипта и список созданных скриншотов.
4. **Любые оставшиеся риски** — что не покрыто тестами, что может сломаться в следующих сценариях.

---

## Чего НЕ делать

- **Не** создавай новых файлов шаблонов HTML — правь только стринги в `server.js`.
- **Не** подключай внешние CDN — xterm.js уже лежит в `static/`.
- **Не** модифицируй `safeRoomName` и `toForwardSlashes` без явной причины.
- **Не** правь `pi-billing-window` — задача только в `pi-remote`.
- **Не** устанавливай puppeteer/playwright как npm-зависимость — используй
  `chrome_devtools_*` MCP, который уже доступен.
