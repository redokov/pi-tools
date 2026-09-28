# FORMAT — Грамматика атрибутивных токенов armslog (spec 006, F3/F4)

Механизмы спеки 006 (`006-night-resilience`): F1 (probe stale), F2 (firelease),
F3 (аддитивная атрибуция armslog), F4 (owner-shift / guard). Этот документ — единый
источник формата токенов для `scenario_monitor.py` / `run_a1.py` / night-monitor
(FR-303) и для читателей журнала `~/.pi/agent/pi-billing-window-arms.log`.

## 1. Грамматика токенов (D-606)

```
<detail>  key=<basename> pid=<pid> host=<host> ep=<эпоха>
          [ctx=stale src=<probe|epoch-guard|drain>] [epoch-mismatch=1]
```

Правила:

- Блок дописывается **в конец** detail-строки, отделяется одним пробелом. Токены —
  строго ASCII; сам detail остаётся на русском (существующие подстроки и
  `.includes()`-тесты не нарушаются — мониторы используют `.*`-парсинг всей строки).
- `key=` — **basename** сессии (без пути): `k.split(/[\\/]/).pop()`. Это ровно то,
  что уже выбирает `run_a1.py` через `re.search(r"key=([^ ]+)")`.
- `pid=` — `process.pid`;
- `host=` — `os.hostname()`, обрезанный на первом `.`/`/` (один ASCII-лейбл;
  `\S+`-парсер валиден);
- `ep=` — `sessionEpoch` в момент строки (монотонный счётчик переусыновлений сессии).
- **Полный путь сессии (`path=…`) появляется ТОЛЬКО в строке `session-start`** — это
  точка джойна по хосту (Q-004: basename не уникален между ветками одного хоста,
  стыковка цепочек идёт по тройке `(key, host, ep)`).
- Признаки stale-состояния (F1) появляются только на строках, где они фактически
  наблюдались: `ctx=stale src=…` и опционально `epoch-mismatch=1`.

## 2. Правило дедупа токенов (D-606, `withAttr`)

Helper `withAttr(detail, stale?)` в `src/index.ts`:

- **только добавляет отсутствующие токены** — перед добавлением каждого из
  `key=`/`pid=`/`host=`/`ep=` проверяет regex `\b<token>=` и пропускает уже
  присутствующие. Никогда не удаляет и не переписывает существующие (иначе
  `session-start`/`arm-seen`, где `key=` уже есть в detail, получили бы второй
  `key=` и сломали first-match-парсеры).
- `ctx=stale src=…` добавляется, только если в detail ещё нет `ctx=stale`
  (проверка `\bctx=stale`), и вместе с `epoch-mismatch=1`, если признак задан.
- Источник stale-признака:
  1. явный параметр `stale` (передаёт вызывающий код — например `fire:reset-ready`
     с `src=drain`);
  2. иначе, если `probeState === "stale"` → `src=probe`;
  3. иначе, если `piApiEpoch !== sessionEpoch` → `src=epoch-guard` +
     `epoch-mismatch=1`.
- Чистая функция: никогда не бросает; `armslog.ts` не изменяется.

## 3. Варианты `src=` (семантика признаков F1)

| `src=` | Условие | Где |
|---|---|---|
| `probe` | `probePiAlive()==="stale"` — ссылка на pi мертва по факту (D-601), либо stale-ветка провала отправки (`noteStaleFailure kind="stale"`, D-602) | fire-путь, попытка доставки |
| `epoch-guard` | `piApiEpoch !== sessionEpoch` — ссылки из прошлой эпохи, отправку не шлём (D-201), всегда с `epoch-mismatch=1` | `replacement:waiting` (обе точки), `noteStaleFailure kind="waiting"` |
| `drain` | `fire:reset-ready` планируется при мёртвых ссылках: `piApi === null` ИЛИ probe stale ИЛИ расхождение эпох (D-602) — признак «fire планируется при мёртвых ссылках» | `fire:reset-ready`, с `epoch-mismatch=1` |

## 4. Несущие строки (fire-путь, FR-301) — 11 событий

Эти события оборачиваются `withAttr` в `src/index.ts` (фактические точки кода на
момент grep; номера строк могут смещаться при правках другого агента):

| # | Событие | Точка в `src/index.ts` |
|---|---|---|
| 1 | `arm-gone` | `~671` (`syncWatchdog`, флаг исчез/истёк) |
| 2 | `arm-seen` | `~681` (в detail уже `key=…` — дедуп, второй `key=` не добавится) |
| 3 | `fire:reset-ready` | `~817` (`onWatchdogFire`, может быть `ctx=stale src=drain epoch-mismatch=1`) |
| 4 | `capitulation:after-N` | `~842` (`capitulate`) |
| 5 | `send-error:stale` | `~872` (`noteStaleFailure kind="stale"`, `ctx=stale src=probe`) |
| 6 | `fire:send-ok` | `~947` (`fireContinue`, после успешной отправки) |
| 7 | `send-error` | `~960` (не-stale провал отправки) |
| 8 | `replacement:waiting` | `~872` (`noteStaleFailure kind="waiting"`, `src=epoch-guard epoch-mismatch=1`) и `~1233` (adopt-ветка `onSessionStart` — свежие ссылки не найдены) |
| 9 | `replacement:adopted` | `~1228` (пересняты ссылки pi/events) |
| 10 | `session-start` | `~1202` (guard-ветка, detail `owner-shift(blocked): …`) и `~1326` (штатная ветка, `owner-shift: old->new`) |
| 11 | `fire:confirmed` | `~1429` (подтверждение успешным ответом) |

Итого: 11 имён событий; в коде 12 точек-обёрток (`session-start` и
`replacement:waiting` — по две точки). Проверка: `tests/attribution.test.mts`
(грамматика + отсутствие дублей токенов). `ep=`/`pid=` в блоке позволяют монитору
отличить прогрессию одного процесса от межпроцессного смешивания (FR-103:
«1/6 ep=3 pid=A … 3/6 ep=7 pid=B» = смена владельца, не одна цепочка).

## 5. НЕ несущие строки (служебные, вне FR-301)

`withAttr` НЕ применяется (проверено grep'ом — обёрток нет):

- `watchdog:eval-error` (`~632`) — ошибка оценки watchdog;
- `watchdog:reset-error` (`~798`) — ошибка сброса окна;
- `block:no-pi` (`~917`) — `piApi` ещё не захвачен, флаг сохранён.

Причина: минимизация поверхности — это не строки fire-пути доставки «продолжи».

## 6. Джойн цепочек (Q-004, FR-302)

- Первичная склейка `fire:reset-ready → fire:send-ok → fire:confirmed` идёт по тройке
  `(key, host, ep)` (basename + хост + эпоха одного процесса).
- Смена `ep=` (или `pid=`/`host=`) внутри одной цепочки попыток = межпроцессная
  смена владельца доставки — ночной монитор поднимает ANOMALY/verdict-флаг, а не
  интерпретирует как единую прогрессию.
- `session-start` с полным `path=` и `owner-shift` — точка привязки цепочки к
  фактическому файлу сессии и точка смены владельца.

## 7. Firelease-маркеры (F2, D-604/D-605)

Межпроцессный дедуп сброса: аренда = атомарно создаваемый файл.

- **Каталог:** `~/.pi/agent/pi-billing-window-fires/<keyId>/<lastResetAt>.mark`
  - `<keyId>` = `sha1(armsKey).slice(0, 16)` — профиль-независим (NR-5); полный
    путь ключа лежит ВНУТРИ маркера;
  - `<lastResetAt>` = `String(st.lastResetAt)` — значение, по которому
    дедуплицируется именно этот сброс (разделитель ключ × сброс).
- **Формат (JSON):**
  ```json
  { "locked_at": 1790000000000, "pid": 4821, "host": "ws-node-7",
    "ep": 3, "reset": 1790000000000, "key": "C:\\...\\session file.json",
    "mode": "planned" }
  ```
- **TTL:** `FIRE_LEASE_TTL_MS = 10 мин`, проверяется только при доступе (lazy) —
  без persistent-таймеров; единственный `setTimeout(...).unref()` для отложенного
  takeover (D-605, spec 003).
- **acquire (O_EXCL):** `wx`-открытие; при `EEXIST` — skip, если маркер живой
  (`now - locked_at < TTL` И `pidAlive(holder)`); **takeover**, если мёртв
  (TTL истёк ЛИБО pid не жив): `rm` + повтор `wx` (≤3; конкуренция двух taker'ов →
  второй получает EEXIST и уходит в skip — fail-safe «не дублировать»).
- **release (compare-and-remove):** `content.pid === myPid` И
  `content.ep === мой sessionEpoch` — чужую новую аренду после takeover не сносим.
- **Точки обвязки:** единый helper `planFireForReset(st)` для `onWatchdogFire` и
  short-circuit `syncWatchdog`; send-gating — «продолжи» шлёт только держатель аренды.
- **Release-точки:** `fire:confirmed` (успех), `capitulation:after-N`, `disarm`/
  `arm-gone`, ПЕРВЫЙ stale-провал (FR-203; повторный acquire перед следующей
  попыткой — backoff-асимметрия даёт другому процессу шанс доставить первым),
  не-stale `send-error`.
- **Свойства:** restart-survival (FR-202) — живой маркер-файл гасит повторный fire
  свежего процесса; два ключа одновременно (FR-201) — разные `<keyId>/` не
  пересекаются; один ключ, два процесса — один fire на (key, reset); известный риск
  — гонка двух живых держателей после takeover → дубль «продолжи», который атрибуция
  делает видимым (ANOMALY, FR-301), не скрытой потерей.

## 8. Owner-shift / guard (F4, D-607/D-608)

- `ownerKey` — сессия-владелец глобального состояния (тот conversation, на который
  указывает `currentKey` и чьи таймеры/эпоха обслуживаются). Устанавливается на
  первом старте, совпадающем ключе, carry-причине и команде `/cont-after-reset`.
- **D-607:** если новый `session-start` с ключом `≠ ownerKey` (ownerKey не null),
  штатная строка `session-start` дополняется аддитивно
  `owner-shift: <old_basename>-><new_basename>` — единственный журнальный признак
  FR-401 и доказательство для E1.
- **D-608 (guard):** если `ownerKey !== null` И пришёл чужой ключ И
  `remapKey(reason) === "repoint"` (resume/reload/startup) И
  `hasLiveOwnerInterest()` (живой armed/pending флаг ИЛИ in-flight доставка
  владельца) — `currentCtx` и `ownerKey` НЕ переустанавливаются, таймеры/эпоха
  владельца не трогаются; пишется `session-start` с деталью
  `owner-shift(blocked): <old>-><new>` и `return`. Так `session_shutdown` дочерней
  сессии корректно рано выходит (`_ctx !== currentCtx`) и не мутирует epoch/таймеры
  родителя (гипотеза (c), Q-002/E1).
- Токены в обеих `session-start`-строках (`key=… ep=… pid=… owner-shift…`)
  дают ночному монитору точку смены владельца доставки.
