# Живые сценарии: инвариант «взведённая после 429 задача продолжается после сброса окна»

Проверяемый инвариант: если в сессии взведён флаг `/cont-after-reset`, то после
сброса 2-часового окна биллинга (провайдер вернул токены) в зависшую сессию
доставляется «продолжи», задача возобновляется, а флаг подтверждается и
сгорает (или перевзводится в режиме repeat). Механика описана в
`src/arms.ts` / `src/watchdog.ts` / `src/index.ts` (spec 002) и
`docs/watchdog-redesign.md`.

Артефакт — ТОЛЬКО план прогона. Никакой код не создаётся; everything ниже —
команды для инженера-исполнителя.

---

## 0. Общий испытательный харнесс

### 0.1 Пути артефактов (глобальная площадка)

| Артефакт | Путь |
|---|---|
| Лог событий armslog | `ARM_LOG=~/.pi/agent/pi-billing-window-arms.log` |
| Хранилище флагов | `ARMS_JSON=~/.pi/agent/pi-billing-window-arms.json` (ключ = **абсолютный путь файла сессии**) |
| Стейт окна (только чтение) | `~/.pi/agent/pi-billing-window.json` |
| Отчёты сценариев | `<repo>/.ai/sdd/specs/004-live-scenario-testing/reports/scenario-XX.md` |
| Каталог тест-сессий | `<repo>/.ai/sdd/specs/004-live-scenario-testing/sessions/` |

### 0.2 Тестовая pi-сессия

- Модель: `wormsoft/zai/glm-5.3-flash`, провайдер `wormsoft` (работает).
- Headless-запуск (A3, A4, C1 — нужен живой процесс):
  ```
  pi --print "<task>" --provider wormsoft --model wormsoft/zai/glm-5.3-flash \
     --session-id live-<XX> --session-dir <repo>/.../sessions
  ```
- Интерактивные сценарии (A1, A2, B1, B2 — нужны `/команды` внутри живого
  окна): запустить pi (TUI, та же модель), команды вводить в окне.
- Все таймеры механизма unref'нуты (spec 003) — процесс pi не «держится»
  таймерами; сессию для ночи/долгих прогонов держит сама задача агента
  (см. C1).

### 0.3 Триггер сброса окна — обязательный раздел (механика по коду `ticker.ts`/`index.ts`)

- `/billing-tick` — это **`checkAndReset()`-проба**, а НЕ форс-сброс: он
  сбрасывает окно только если `elapsed >= windowMs` (окно реально истекло)
  И `now - lastResetAt >= DEDUP_WINDOW_MS` (**10 мин**, `ticker.ts`).
  Свежее 2-часовое окно `/billing-tick` НЕ сбросит (ответ «reset не произошёл»).
- Детерминированный форс-сброс (lastResetAt продвигается немедленно):
  `/settimer 0` (безусловный, эквивалент `/billing-reset`).
- Для A1/A2 с буквальным `/billing-tick`: окно необходимо предварительно
  довести до истечения (`/settimer N` с долгим wait) и гарантировать, что
  последний реальный сброс был ≥10 мин назад, иначе дедуп подавит.
- Быстрые сценарии (A1, A2) используют `/settimer 0` как канонический
  форс-сброс; `/billing-tick` включается как шаг-проверка состояния.

### 0.4 Грепы (хелперы)

```bash
ARM=~/.pi/agent/pi-billing-window-arms.log
AJS=~/.pi/agent/pi-billing-window-arms.json
# снимок флагов
python -c "import json,os;m=json.load(open(os.path.expanduser('~/.pi/agent/pi-billing-window-arms.json')));print(json.dumps(m,ensure_ascii=False,indent=2))"
# счётчик событий
grep -cF "fire:reset-ready"  "$ARM"   # должно быть 1 на сброс
grep -cF "fire:send-ok"      "$ARM"   # 1 на сброс
grep -cF "fire:confirmed"    "$ARM"   # 1 на сброс (one-shot) 
grep -cE "send-error|send-error:stale|capitulation:after|watchdog:reset-error" "$ARM"   # 0 — негатив
```

### 0.5 Эталонные строки armslog (формат `ISO | event | detail`)

| Событие | Точная подстрока для `grep -F` |
|---|---|
| старт сессии | `session-start` (detail `reason=… key=… armed=…`) |
| флаг увиден синк-поллером | `arm-seen` (detail `repeat=N phase=armed key=…`) |
| флаг исчез/истёк | `arm-gone` (detail `флаг исчез/истёк…`) |
| спланирован fire после сброса | `fire:reset-ready` (detail `watchdog: сброс окна …, отправляю «продолжи» через N с`) |
| «продолжи» отправлен | `fire:send-ok` (detail `«продолжи» отправлен, флаг в pending…`) |
| успешный ответ подтвердил | `fire:confirmed` (detail `успешный ответ после «продолжи» — флаг снят/перевзведён`) |
| ошибка доставки | `send-error` |
| stale-ошибка | `send-error:stale` (detail `…попытка n/6, повтор через M мин`) |
| замена сессии: ссылки не пересняты | `replacement:waiting` |
| замена сессии: ссылки пересняты | `replacement:adopted` |
| капитуляция | `capitulation:after-6` |
| ошибка сброса watchdog | `watchdog:reset-error` |

---

## A1. Базовый: взвод → форс-сброс → одноразовая доставка

**Предусловия**
- Живое интерактивное окно pi (TUI), модель `wormsoft/zai/glm-5.3-flash`,
  расширение развёрнуто (рабочая копия синхронна репо — stage0: 10/10 файлов).
- Инвариант чистоты: `python -c "import json,os;print(json.load(open(os.path.expanduser('~/.pi/agent/pi-billing-window-arms.json'))))"` → ожидаем `{}`.
- Известен **базовый счётчик событий** до прогона (чтобы считать дельту):
  `grep -cF "fire:confirmed" "$ARM"`.
- Окно НЕ пересекает реальную границу во время прогона (взвод перед `/settimer 0` — окно свежее; сам `/settimer 0` и есть сброс).

**Шаги**
1. `/cont-after-reset` → уведомление «взведён … Одноразовый флаг».
2. `/settimer 0` — безусловный реальный сброс (дедуп не применяется); уведомление «Таймер: окно сброшено».
3. Дополнительная проверка состояния: `/billing-status` (показывает свежее окно, resets+1).
4. Ожидание ≤2 мин (синк-поллер ≤60с увидит сброс, watchdog уйдёт на lastResetAt+grace, grace 60с → отправка).

**Ожидаемые события armslog (по-порядку, с грепами)**

| № | Команда проверки | Ожидание |
|---|---|---|
| 1 | `grep -F "arm-seen" "$ARM"` | есть, detail с `repeat=1 phase=armed` |
| 2 | снаpshot arms.json | ключ сессии есть, `phase="armed"`, `expiresAt` ≈+8ч |
| 3 | после `/settimer 0` до ≤2 мин: `grep -F "fire:reset-ready"` | ровно 1 строка |
| 4 | `grep -F "fire:send-ok"` | ровно 1 строка |
| 5 | `grep -F "fire:confirmed"` | ровно 1 строка (после первого успешного ответа агента) |
| 6 | снапshot arms.json | ключа сессии БОЛЬШЕ НЕТ (флаг снят) |

**PASS-критерии (по шагам)**
- Ш1→Ш2: `arm-seen` появился не позднее секунд после `/cont-after-reset`; флаг в arms.json one-shot (повтор не задан).
- Ш3: `fire:reset-ready` ровно 1 (дедуп D-203 не дал цикла перепланирования; повторные синк-тики не дублируют).
- Ш4: `fire:send-ok` ровно 1.
- Ш5: `fire:confirmed` ровно 1 (first success after «продолжи»).
- Ш6: по arms.json флаг снят; агент в окне фактически продолжил (последнее сообщение после «продолжи»).
- **Негатив:** `grep -cE "send-error|send-error:stale|capitulation:after|watchdog:reset-error|replacement:waiting" "$ARM"` == 0 (в дельте прогона).

**Что фиксировать в `reports/scenario-A1.md`**
- Дата, ветка/коммит, версия pi, model id, session-id, session-file (ключ флага).
- Копию команд грепов и их вывод (дельты счётчиков до/после).
- Снимки arms.json после Ш1 и Ш6.
- Таймлайн событий armslog (ISO … event …) из дельты прогона.
- Ответ агента после «продолжи» (скрин/TUI-транскрипт).
- Вердикт PASS/FAIL + при FAIL — гипотеза по первому отсутствующему событию.

**Длительность:** ~5 мин.

---

## A2. Repeat: `/cont-after-reset 3` → 3 сброса → перевзвод ×2, сгорание на 3-м

**Предусловия** — как A1 (чистый ARMS_JSON, известна дельта счётчиков).
Логика: repeat=3; каждый подтверждённый fire перевзводит флаг с `repeat-1`;
3-й fire — одноразовый (repeat=1), подтверждение удаляет флаг (4-го не будет).

**Шаги**
1. `/cont-after-reset 3` → уведомление «Режим повтора: 3 срабатываний всего (repeat=3)».
2. Форс-сброс №1: `/settimer 0`. Ожидание ≤2 мин → fire-цепочка R1.
3. **Дождаться подтверждения перевзвода** (см. PASS Ш3) перед 2-м сбросом.
4. Форс-сброс №2: `/settimer 0`. Ожидание ≤2 мин → fire-цепочка R2.
5. **Дождаться подтверждения перевзвода** (repeat 2→1).
6. Форс-сброс №3: `/settimer 0`. Ожидание ≤2 мин → fire-цепочка R3 — финальная.
7. Контроль отсутствия 4-го fire.

**Ожидаемые события и проверки (грепы)**

| № | Команда | Ожидание |
|---|---|---|
| 1 | `grep -F "arm-seen" "$ARM" | tail -1` | detail `repeat=3 phase=armed` |
| 1b | снапshot: `AJS` | `.repeat == 3` |
| 2 | `grep -cF "fire:reset-ready"` | =1 ; `grep -cF "fire:confirmed"` =1 |
| 3 | снапshot: `AJS` | `.repeat == 2`, `phase=="armed"`, `lastResetAtAtArm` == lastResetAt(R1) — **перевзвод состоялся** |
| 4 | счётчики | всего fire:reset-ready=2, fire:confirmed=2 |
| 5 | снапshot: `AJS` | `.repeat == 1` (ещё есть, уже one-shot) |
| 6 | счётчики | fire:reset-ready=3, fire:confirmed=3 |
| 6b | снапshot: `AJS` | ключа сессии БОЛЬШЕ НЕТ (сгорел на 3-м подтверждении) |
| 7 | после доп. `/settimer 0` + 2 мин | `grep -cF "fire:send-ok"` остаётся =3 (4-го нет) |

**Важно про интервалы и /billing-tick:** между сбросами ОБЯЗАТЕЛЬНО ждать
`fire:confirmed` и подтверждение декремента repeat в arms.json. Свежие
`/settimer 0` идут подряд без ограничения 10-мин дедупа (в отличие от
`/billing-tick` — тот на свежих <10 мин подавится). Если использовать
буквальный `/billing-tick`: каждый следующий тик на истечённом окне будет
дедупнут (10 мин) — интервалы тогда должны быть >10 мин.

**PASS-критерии**
- Ш1: arm-seen repeat=3; arms.json repeat=3.
- Ш2: fire:confirmed=1 (один раз на R1) — НЕ два.
- Ш3: repeat 3→2 (перевзвод с новым TTL и lastResetAtAtArm=R1).
- Ш4–Ш5: repeat 2→1, счётчики монотонны (2 и 2).
- Ш6: repeat 1→флаг удалён; fire:confirmed=3 суммарно; fire:reset-ready=3.
- Ш7: 4-го сброса fire:send-ok НЕТ (после исчерпания флаг не стреляет).
- **Негатив (в дельте):** capitulation/send-error/watchdog:reset-error == 0.

**Что фиксировать в `reports/scenario-A2.md`**
- Таймлайн всех 3 fire-цепочек (ISO каждой строки fire:*).
- Снимки arms.json после каждого сброса (repeat 3→2→1→∅, phase, lastResetAtAtArm).
- Интервал фактический между сбросами (для оценки дедупа/grace).
- Транскрипт агента после каждого «продолжи».
- Вердикт PASS/FAIL + какое событие/актера перевзвода нарушилось при FAIL.

**Длительность:** ~15–20 мин (3 цикла по ~5 мин).

---

## A3. Внешний взвод: запись в arms.json под ключом НОВОЙ сессии → arm-seen → доставка

Проверяет контракт ночного helper-скрипта: прямая запись `Arm` в arms.json
под ключом **абсолютного пути session-файла** подхватывается синк-поллером
(≤60с, событие `arm-seen`) — точно как Scenario 6 e2e (строки 561–623).
Формат записи НЕ менять.

**Предусловия**
- Headless-сессия запущена и ЖИВАЯ (процесс pi должен работать весь прогон):
  ```
  pi --print "Изучи каталог inventory; затем раз в ~40с дописывай в <repo>/.../sessions/A3-heartbeat.txt строку 'beat <ISO>'; когда придёт сообщение 'продолжи' — напиши ответ 'RESUMED <ISO>' и продолжай цикл. Не завершайся, пока не получишь сообщение 'стоп'." \
     --provider wormsoft --model wormsoft/zai/glm-5.3-flash \
     --session-id live-A3 --session-dir <repo>/.../sessions
  ```
- Определить session-file (ключ флага): `find <repo>/.../sessions -name '*.jsonl'`.
- ARMS_JSON чист до прогона; известна дельта счётчиков.
- **Формат записи (точная копия Scenario 6, только значения адаптировать):**
  ```python
  import json, os, time
  key = r"<АБС.ПУТЬ/SESSION-FILE/имя.jsonl>"
  now = int(time.time() * 1000)
  m = { key: {
        "armedAt": now,
        "lastResetAtAtArm": 0,                     # 0 = любой след. сброс
        "expiresAt": now + 8 * 3600 * 1000,        # +8ч (ARMS_TTL_MS)
        "phase": "armed",
        "repeat": 1,
      } }
  tmp = os.path.expanduser("~/.pi/agent/pi-billing-window-arms.json") + ".tmp"
  open(tmp, "w").write(json.dumps(m, indent=2)) ; os.replace(tmp, os.path.expanduser("~/.pi/agent/pi-billing-window-arms.json"))
  ```
  (запись атомарная tmp+rename — как в `arms.writeArmsSync`; формат JSON не менять).

**Шаги**
1. Записать Arm внешним способом (скрипт выше).
2. Ожидание ≤60 с — синк-поллер 60с подхватит.
3. Проверка: `grep -F "arm-seen" "$ARM"` (detail с `repeat=1 phase=armed key=<basename>`).
4. Проверка: снапshot arms.json — запись на месте (под ключом session-файла).
5. Сброс: для headless — внешний «пуш границы»: переписать
   `~/.pi/agent/pi-billing-window.json` со `windowStartedAt = now - windowMs - 5000`
   (окно заведомо истекло; lastResetAt не трогать; формат state.ts не менять).
   След. синк-тик/тикер → checkAndReset видит истёкшее окно → реальный сброс →
   `fire:reset-ready` → grace 60с → `fire:send-ok`.
   Для интерактивного варианта сценария: `/billing-tick` на истёкшем окне (см. 0.3).
6. Ожидание ≤2 мин → доставка.

**Ожидаемые события armslog**

| № | Греп | Ожидание |
|---|---|---|
| 1 | `grep -F "arm-seen"` | появился ≤60с после записи, `repeat=1 phase=armed key=<basename A3>` |
| 2 | снапshot AJS | `phase=="armed"`, ключ = session-file |
| 3 | `grep -F "fire:reset-ready"` | 1 — после сброса |
| 4 | `grep -F "fire:send-ok"` / `grep -F "fire:confirmed"` | по 1; флаг удалён |

**PASS-критерии**
- Внешний взвод подхвачен без каких-либо команд окна: `arm-seen` в пределах
  60с от записи.
- `fire:reset-ready`→`fire:send-ok`→`fire:confirmed` ровно по одному; флаг снят.
- A3-heartbeat.txt получил новую строку после сброса (агент жив и продолжил).
- **Негатив:** `send-error|capitulation|watchdog:reset-error` == 0.

**Что фиксировать в `reports/scenario-A3.md`**
- Точный session-file (ключ), копию записанного JSON.
- Время записи vs время `arm-seen` (латентность подхвата; PASS ≤60с).
- Снимки arms.json на каждом шаге.
- Таймлайн fire-цепочек; хвост heartbeat-файла (возобновление после сброса).
- Способ сброса (гран-пуш state / /billing-tick) — отметить вариант.

**Длительность:** ~10 мин.

---

## A4. TTL: запись с истёкшим expiresAt → arm-gone, ничего не стреляет

**Предусловия** — headless-сессия (или любое живое окно); ARMS_JSON чист;
известна дельта счётчиков; формат записи — как в Scenario 6, но `expiresAt` в
прошлом (меняем ТОЛЬКО значение, формат полей не трогаем).

**Шаги**
1. Записать Arm: `expiresAt = now - 1с` (в прошлом), `lastResetAtAtArm: 0`,
   `phase: "armed"`, `repeat: 1`. Атомарно (tmp+rename).
2. Ожидание ≤60 с (синк-тик).
3. Сброс (если нужно): `/settimer 0` (интерактив) ИЛИ гран-пуш state (headless).
4. Ожидание ~3 мин (дольше grace+send, чтобы исключить «поздний» fire).

**Ожидаемые события и проверки**

| № | Греп/команда | Ожидание |
|---|---|---|
| 1 | `grep -F "arm-seen"` | за дельту прогона НЕТ (запись истекла до чтения → `getArm===null`) |
| 2 | `grep -F "fire:reset-ready"` / `fire:send-ok` / `fire:confirmed` | НЕТ (0 по дельте) |
| 3 | снапshot AJS | записи нет или она вычищена (prune) при ближайшей записи (в т.ч. от `/settimer 0`) |
| 4 | `grep -F "arm-gone"` | возможен, если флаг ранее «виделся» в этой сессии (связка arm-seen→arm-gone); в чистом старте — 0, это НЕ FAIL |
| 5 | негатив `capitulation|send-error` | 0 |

**PASS-критерии**
- Истёкший флаг НЕ приводит к arm-seen и к fire: отсутствие `fire:*` в дельте
  прогона (а значит, «продолжи» не уходит).
- Никаких send-error/capitulation (неполнота отброшена тихо, как задумано).
- Формат записи сохранён (поле `expiresAt` только значение).

**Что фиксировать в `reports/scenario-A4.md`**
- Копию записанного JSON (отметить, что изменения только в значении expiresAt).
- Время записи; хвост armslog за наблюдаемое окно (что НЕ появилось).
- Снимок arms.json после прогона.
- Вердикт PASS/FAIL.

**Длительность:** ~5 мин.

---

## B1. Реальная граница: /settimer 5m → watchdog-fire → grace 60с → доставка

Проверяет, что fire приходит не от форс-сброса, а от **реального watchdog**
на границе окна (`computeFireAt = windowStartedAt + windowMs`, затем grace).

**Предусловия**
- Интерактивное окно pi (TUI), модель как в A1.
- Убедиться, что последний реальный сброс был ≥10 мин назад (иначе дедуп
  `checkAndReset` подавит reset на границе). Контроль: `/billing-status` —
  если resets свежий, подождать до 10+ мин или начать иной сценарий.

**Шаги**
1. `/settimer 5` — граница через ~5 мин (windowStartedAt «состарен»; lastResetAt НЕ трогается).
2. `/cont-after-reset` → arm-seen.
3. НЕ вмешиваться: ждать реального истечения (~5 мин). На границе watchdog
   (onWatchdogFire) сам делает checkAndReset → reset → `fire:reset-ready`
   (detail `watchdog: сброс окна …` — это от watchdog, не от /billing-tick).
4. Grace 60с → `fire:send-ok`; первый успешный ответ → `fire:confirmed`.

**Проверки**

| № | Греп | Ожидание |
|---|---|---|
| 1 | `grep -F "arm-seen"` | есть (repeat=1) |
| 2 | `grep -F "fire:reset-ready" "$ARM" \| tail -1` | одна строка; detail начинается с `watchdog: сброс окна` (реальный watchdog) |
| 3 | `grep -cF "fire:reset-ready"` | =1 (никаких дополнительных /billing-tick) |
| 4 | `grep -cF "fire:send-ok"` / `fire:confirmed` | по 1 |
| 5 | снапshot AJS | флаг снят |

**PASS-критерии**
- События строго в порядке: fire:reset-ready (от watchdog) → fire:send-ok →
  fire:confirmed; интервал между reset-ready и send-ok ≈ **60±10 с** (grace).
- Ровно 1 fire на сброс, флаг снят, негатив (send-error/capitulation) пуст.
- Форс-сбросы (/settimer 0, /billing-tick) ВО ВРЕМЯ прогона не использовались.

**Что фиксировать в `reports/scenario-B1.md`**
- `/billing-status` до/после (подтвердить 10-мин границу дедупа).
- Таймстампы `fire:reset-ready` и `fire:send-ok` (вычислить фактический grace).
- Таймлайн полный; вердикт.

**Длительность:** ~10 мин.

---

## B2. Reload переживает доставку: взвод → /reload ДО границы → доставка

Проверяет: флаг переживает перезапуск сессии (repoint, `remapKey("reload")`
= repoint; `ensureSyncPoller` перезапускается на session_start) и доставка
всё равно происходит после реальной границы.

**Предусловия**
- Интерактивное окно pi (TUI), модель как в A1; окно доведено до границы
  через ≥10 мин (см. B1 про дедуп 10 мин).

**Шаги**
1. `/settimer 12` — граница через ~12 мин.
2. `/cont-after-reset` → arm-seen (флаг на ключе текущей сессии).
3. `/reload` (перезапуск сессии в pi; альтернатива — выход и
   `pi --resume <session-id>` — тот же repoint) **до границы**.
4. Контроль переподхвата: на старте `ensureSyncPoller()` сразу видит флаг →
   второе `arm-seen` (в новом процессе счетчик `lastArmSeenKey` чист).
   Если pi делает reload в том же процессе — признак переподхвата = тот же
   `session-start` c `reason=reload … armed=true`.
5. Ждать реальной границы (~остаток 12 мин) → watchdog → reset → grace → доставка.

**Ожидаемые события armslog**

| № | Греп | Ожидание |
|---|---|---|
| 1 | `grep -F "session-start" "$ARM" \| tail -2` | новый `reason=reload`, `armed=true` (флаг пережил) |
| 2 | `grep -F "arm-seen"` | повторное arm-seen после reload (или подтверждение armed=true) |
| 3 | `grep -F "fire:reset-ready" "$ARM" \| tail -1` | 1, detail `watchdog: сброс окна…` — ПОСЛЕ строки session-start reload |
| 4 | `grep -cF "fire:send-ok"` / `fire:confirmed` | по 1 |
| 5 | негатив | `capitulation:after-6` — 0; `replacement:waiting` — 0 (при успешном переподхвате) |

**PASS-критерии**
- Доставка (`fire:send-ok` + `fire:confirmed`) происходит ПОСЛЕ события
  `session-start … reason=reload`: reload не убил механизм.
- Порядок строк в armslog строго: … session-start(reload) → fire:reset-ready →
  fire:send-ok → fire:confirmed.
- Нет `capitulation:after-6` (флаг не сгорел молча), флаг снят после доставки.

**Что фиксировать в `reports/scenario-B2.md`**
- Команду reload (точная — /reload или полный перезапуск `pi --resume`).
- Хвост armslog вокруг reload (session-start/arm-seen/воcстановление).
- Таймлайн: взвод → reload → граница → fire.
- Снимки arms.json до reload и после доставки.

**Длительность:** ~15 мин.

---

## C1. Ночь: «выжигатель токенов» до 429 + repeat=3 → возобновление после каждого сброса

Full-stack проверка инварианта на реальной биллинговой сессии wormsoft:
агент жжёт токены в цикле до 429, останавливается, после каждого сброса окна
получает «продолжи» и возобновляет — 2+ реальных окна подряд.

**Предусловия**
- Headless pi, модель `wormsoft/zai/glm-5.3-flash`, провайдер wormsoft.
- Перед стартом: ARMS_JSON чист; известна дельта счётчиков и `resetCount`
  из `~/.pi/agent/pi-billing-window.json`.
- Ночь/минимум 4–5 часов непрерывного процесса (2 реальных сброса по 2ч + запас).
- **Задача-выжигатель** (промпт сессии) должна:
  - генерировать токены в цикле (длинные рассуждения до упора) до получения 429;
  - heartbeat: дописывать строку `beat <ISO>` (и `reset-gap <ISO>` после паузы)
    в `<repo>/.../sessions/C1-heartbeat.txt` **каждые ~2 мин**;
  - при появлении сообщения «продолжи» — ответить `RESUMED <ISO>` и вернуться
    в цикл (не останавливаться навсегда).
- Взвод repeat=3 — внешней записью (native-night путь; формат Scenario 6;
  эквивалент интерактивной команды `/cont-after-reset 3`):
  `repeat: 3`, `lastResetAtAtArm: 0`, `expiresAt: +8ч`, `phase: "armed"`.

**Шаги**
1. Запустить сессию-выжигатель (команда в 0.2, task из предусловий).
2. Записать Arm repeat=3 атомарно (после старта сессии, ключ — её session-file).
3. **Мониторинг (poller-цикл inline, файла не создаём):**
   ```bash
   while sleep 60; do
     tail -1 ~/.pi/agent/pi-billing-window-arms.log
     tail -1 <repo>/.../sessions/C1-heartbeat.txt
     grep -cF "fire:confirmed" ~/.pi/agent/pi-billing-window-arms.log
     python -c "import json,os;print(json.load(open(os.path.expanduser('~/.pi/agent/pi-billing-window-arms.json'))))"
   done >> <repo>/.../reports/scenario-C1-monitor.log
   ```
4. Дождаться 2-го реального сброса окна (resetCount +≥2 от старта).
5. На каждом сбросе — зафиксировать цепочку fire: и возобновление heartbeat.
6. Остановить монитор; снять финальные снапшоты.

**Ожидаемые события (на каждый реальный сброс Rs)**

| № | Греп | Ожидание |
|---|---|---|
| 1 | `grep -F "arm-seen"` | 1 раз при старте, detail `repeat=3` |
| 2 | `grep -F "fire:reset-ready"` | по одной строке на сброс (реальный watchdog) |
| 3 | `grep -F "fire:send-ok"` | по одной на сброс |
| 4 | `grep -F "fire:confirmed"` | по одной на сброс (после RESUMED) |
| 5 | `grep -cF "fire:confirmed"` | ≥2 (требование C1: окна ×2+) |
| 6 | heartbeat: grep -c "beat" | новые строки в каждом интервале после паузы; пауза ≈ 2–4 мин (сброс+grace+возобновление) |
| 7 | снапshot AJS (после 3-го сброса) | ключа нет (repeat 3→2→1→∅) |
| 8 | негатив | `capitulation:after-6` == 0 |

**PASS-критерии**
- Произошло ≥2 реальных сброса окна (resetCount прирост ≥2, fire:confirmed ≥2).
- Heartbeat **возобновился после каждого сброса**: в C1-heartbeat.txt есть
  заключительные строки каждого интервала ПОСЛЕ строки next `fire:confirmed`;
  разрыв файла между последним beat до сброса и первым после — ≤ ~5 мин
  (иначе флаг мог сгореть или grace сорван).
- fire-цепочки полные и непересекающиеся (нет двойного fire на один сброс).
- `capitulation` не происходила; флаг исчерпан на 3-м сбросе.

**Что фиксировать в `reports/scenario-C1.md`**
- Команды запуска сессии и записи Arm (с точным session-file-ключом).
- `scenario-C1-monitor.log` (полный poller-лог) как приложение.
- Таймлайн всех fire-цепочек с ISO (grep-копия).
- График/последовательность heartbeat-строк (доказательство возобновления,
  не «агент просто очнулся сам»: сопоставить timestamp RESUMED/fire:confirmed).
- Итоговые счётчики: fire:reset-ready/fire:send-ok/fire:confirmed, resetCount.
- Вердикт PASS/FAIL; при FAIL — точка разрыва (heartbeat остановился навсегда /
  fire:confirmed нет / capitulation).

**Длительность:** ночь: от взвода до 2-го сброса ≈ 4–4.5 ч, полный прогон до
сгорания repeat (~3 сброса) ≈ 6–6.5 ч (лимит TTL 8 ч соблюдается).

---

## Сводка длительностей и критериев

| Сценарий | Проверяет | Длительность | Ключевой PASS |
|---|---|---|---|
| A1 | базовый one-shot | ~5 мин | fire:confirmed=1, флаг снят, негатив пуст |
| A2 | repeat 3× (перевзвод) | ~15–20 мин | repeat 3→2→1→∅, счётчики монотонны, 4-го нет |
| A3 | внешний взвод + arm-seen ≤60с | ~10 мин | arm-seen ≤60с, доставка, флаг снят |
| A4 | TTL (истёк) | ~5 мин | нет arm-seen/fire, нет негатива |
| B1 | реальный watchdog + grace 60с | ~10 мин | fire от watchdog, grace ≈60±10с |
| B2 | reload до границы | ~15 мин | доставка ПОСЛЕ session-start(reload) |
| C1 | ночь, 2+ окна, 429, heartbeat | ночь (6–6.5ч) | fire:confirmed≥2, heartbeat возобновился на каждом окне, capitulation=0 |

Общий негатив для всех сценариев (в дельте прогона):
`grep -cE "send-error|send-error:stale|capitulation:after|watchdog:reset-error" "$ARM"` == 0.
