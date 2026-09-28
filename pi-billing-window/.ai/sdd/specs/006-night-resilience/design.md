# Spec 006 — Design: night-resilience (stale-ctx диагностика, межпроцессный дедуп, атрибуция, субагент-наблюдаемость)

> Status: Approved (оркестратор, 2026-09-27; поправка D-608: blocked-path не трогает currentCtx; условие — hasLiveOwnerInterest: живой флаг ИЛИ in-flight доставка)
> Source: `.ai/sdd/specs/006-night-resilience/requirements.md` (Approved, 2026-09-27; поправка FR-201: дедуп per-armed-key)
> Scope: `pi-billing-window` (репо `C:\Tools\pi-billing-window`, ветка `master`)
> Поведение: НИКАКИХ правок кода в этом документе; только решения + план эксперимента; реализация — отдельными задачами.

## 0. Что принимается как данность (установленные факты о pi, не перепроверять)

(a) `/reload` → `session_shutdown` → invalidate → полный re-import модуля → фабрика запускается заново со свежим `pi`; все module-level переменные сброшены; после `/reload` расширение здорово.
(b) Замена сессии (`/new`, `/resume`, `/fork`) → `dispose()`/`invalidate()` старой сессии → старый `pi` вечно бросает «ctx is stale»; свежий `pi` появляется только через новую фабрику (новый runner/runtime).
(c) In-process субагенты: дочерняя сессия в ТОМ ЖЕ процессе запускает ту же фабрику/модуль — module instance ОБЩИЙ; все module-level переменные (`currentCtx`, `sessionEpoch`, `piApi`, `piApiEpoch`, таймеры, `staleAttempts`) делятся между главной и дочерними сессиями процесса. `onSessionShutdown` субагента способен остановить таймеры родителя и мутировать `sessionEpoch`. Гипотеза «dispose субагентской сессии инвалидирует общий runtime → родительский piApi умирает БЕЗ события замены для родителя» — НЕ доказана, требует эксперимента **E1**.
(d) `ctx.reload()` изнутри обёрнут `assertActive()` → сталый ctx не может сам вызвать reload; `ExtensionContext` не имеет `sendUserMessage`; единственный канал доставки — `pi` из фабрики.
(e) Любой runtime-метод (например `getSessionName()`) обёрнут `assertActive()` → try/catch-проба читает staleness БЕЗ отправки сообщений (дешёвый probe).
(f) Внешняя доставка (второй pi-процесс, append в сессию) НЕ запускает turn в живом процессе (TUI не наблюдает файл). Внешний watchdog `night_watchdog.py` — вне скоупа 006.

## 1. Context по коду (актуальный master)

- `src/index.ts` — оркестрация. Ключевые точки (номера приблизительные, по grep):
  - фабрика `export default` (~1697): `eventBus = pi.events; piApi = pi; piApiEpoch = sessionEpoch;` — единственный источник свежего `pi`.
  - module-level state: `currentCtx` (~90), `eventBus` (~100), `piApi` (~155), `sessionEpoch` (~163), `piApiEpoch` (~172), `staleAttempts` (~240), `lastFiredResetAt` (~245), `pendingFiredResetAt` (~263), `staleRetryNotBefore` (~288), таймеры `retryTimer/graceTimer/syncTimer` (~195-205).
  - `syncWatchdog()` (~533): планирование fire для перейдённой границы (стр. ~603-612: `lastFiredResetAt = st.lastResetAt; fireAt = min(fireAt, lastResetAt + grace)` → немедленный fire); «T15/H0» (стр. ~588-600): in-flight доставка держит `ensureGraceTimer`/`ensureRetryInterval`.
  - `onWatchdogFire()` (~651): `checkAndReset` → `lastFiredResetAt = base` → `armsLog("fire:reset-ready", …)` → grace-таймер → `fireContinue`. **Точка дублей fire:reset-ready из разных процессов (инцидент 18:27:07/08).**
  - `noteStaleFailure(kind, detail)` (~716): `staleAttempts++`, backoff, `armsLog("replacement:waiting"|"send-error:stale", …)`, `ensureRetryInterval()`, капитуляция при ≥6.
  - `fireContinue()` (~738): pacing `staleRetryNotBefore` → idle-check → `block:no-pi` при `piApi===null` → epoch-guard (`piApiEpoch !== sessionEpoch` → `noteStaleFailure("waiting",…)`) → `sendUserMessage("продолжи")` → `armsMarkFired()` → `staleAttempts=0` → `pendingFiredResetAt` → `fire:send-ok`; catch stale → `noteStaleFailure("stale",…)`.
  - `capitulate()` (~703): `armsDisarm()` + `capitulation:after-N` + `sendNotify` (D-205).
  - `sessionBusOf()` (~988): probe по `api/pi/extensionApi` + `events/eventBus/bus` в event/ctx; сегодня возвращает `null` в проде (002, FAQ F-1).
  - `onSessionStart()` (~1017): `currentCtx = ctx` (стр. 1042 — БЕЗУСЛОВНО, это точка перехвата чужим ключом); D-201 re-capture; `subscribeToBillingEvents`; `ensureTickerStarted`; маппинг `remapKey` (стр. ~1128-1135): carry (new/fork/replacement) / repoint (resume/reload/startup); `armsLog("session-start", "reason=… key=<base> armed=…")` (стр. 1143).
  - `onSessionShutdown()` (~1348): guard `if (_ctx && currentCtx && _ctx !== currentCtx) return;` → `sessionEpoch++` → стоп таймеров/подписок. **Если `currentCtx` перезаписан ctx дочерней сессии, guard пропускает shutdown субагента → sessionEpoch++ и остановка таймеров родителя.**
  - `arm-seen`/`arm-gone` (~552/544) в `syncWatchdog`.
- `src/arms.ts` — `currentKey` (модульный, ~121), `switchKey` (~186, repoint), `carryArmTo` (~194, перенос записи), `remapKey` (~178), фазы `armed/pending`, TTL `ARMS_TTL_MS=8h`, `RESET_GRACE_MS=60s`, `RETRY_AFTER_FIRE_MS=5min`. Форматы `arms.json`/`state.json` НЕ меняются (D-004).
- `src/armslog.ts` — append-only, формат `ISO | event | detail`, никогда не бросает; ротация 512 KiB.
- Формат парсинга мониторинга (`scripts/scenario_monitor.py`, `LINE_RE = ^(\S+) \| ([^|]+) \| (.*)$`): токены внутри detail не ломают парсер; словари `KEY_EVENTS`/`SEND_ERROR_EVENTS` — только существующие события, новых НЕ добавляем (D-006).
- `deploy.ps1` копирует фиксированный список `src/*.ts` + `package.json` (строки 29-42); **добавление нового файла `src/firelease.ts` требует правки deploy.ps1** (в отличие от 002, где правок не было).
- rpc-harness (для E1): `.ai/sdd/specs/004-live-scenario-testing/reports/rpc_harness.py` → `RpcSession(sid, sdir, rawlog)`; `send_cmd("/cmd")`, `--mode rpc`, JSONL из stdin/stdout; `scenario_common.py` (wait_event по armslog, дельта-счётчики).

## 2. Требования-инварианты, которые НЕ трогаем (несмотрямые границы)

- Форматы `arms.json`/`state.json`, логика `checkAndReset`/ticker, протокол pi (D-004 — из 002).
- Дедуп fire модульный `lastFiredResetAt` D-203 (002); bounded stale-retry D-204 (капитуляция после 6, никогда не молчать); fire-once-per-window `pendingFiredResetAt` D-005 (005).
- Словарь событий armslog НЕ расширяется (D-006, принята в requirements): вся атрибуция — аддитивно в деталях строк.
- Межпроцессный дедуп — вне схем state/arms (D-007, принята в requirements): sidecar с TTL/unref.
- Субагент-инвалидация — только наблюдаемость (FR-401); поведенческая изоляция гейтится экспериментом E1 (D-008, Q-002).

## 3. Requirements Mapping

| Requirement | Раздел дизайна | Ключевые решения |
|---|---|---|
| FR-101 (ранний признак epoch-mismatch, без новых слов) | §5.2, §5.3 | D-601 probe, D-602 аддитивный токен `epoch-mismatch` |
| FR-102 (send-ok ≤1 backoff-шаг после переусыновления) | §5.4 | D-603 сброс pacing на переусыновлении (a/b/c) |
| FR-103 (счётчик stale привязан к эпохе/процессу) | §7.2 | D-606 `ep=`/`pid=` в детали `send-error:stale` |
| FR-201 (≤1 fire на сброс на ключ; два ключа не дедуплятся) | §6.1 | D-604 firelease per `(armedKey,lastResetAt)` |
| FR-202 (переживает рестарт) | §6.1 | D-604 маркер-файл вне модуля |
| FR-203 (takeover при stale-держателе) | §6.1 | D-604 release на stale/капитуляции/подтверждении + TTL + pid-живость |
| FR-204 (unref; защита от застрявшего лока) | §6.2 | D-605 ленивый TTL, без persistent-таймера |
| FR-301 (токен `key=/pid=/host=/ep=` на строках fire-пути) | §7.1 | D-606 единый формат в КОНЦЕ detail; helper `withAttr` |
| FR-302 (вердикт per-reset по журналу; night-mini PASS) | §7, §10 | группировка по `key=`+`ep=`; эмуляция атрибуции на журнале инцидента |
| FR-303 (формат фиксирован и парсится мониторами) | §7.1 | D-610 грамматика токенов + `FORMAT.md` |
| FR-401 (owner-shift при чужом session-start) | §8.1 | D-607 аддитивная деталь `owner-shift` в `session-start` |
| FR-402 (изоляция по ключу — за экспериментом) | §8.2, §5.5 | D-608 минимальный guard; полная изоляция — после E1 |
| NR-1 (не молчать; armslog не бросает) | §6, §12 | firelease не трогает armslog-контракт; капитуляционные тесты 002 без изменений |
| NR-2 (наблюдаемость вердикта) | §7, §10 | токены читаются мониторами без правок схемы |
| NR-3 (совместимость; ≥443 asserts, 10 сьютов) | §7.1, §12 | `.includes()`-подстроки целы; новые сьюты аддитивны |
| NR-4 (нет доп. пулла; unref) | §6.2 | маркер-файл + ленивый TTL; новых интервалов нет |
| NR-5 (профиль-независимость; смерть держателя) | §6.1 | каталог `~/.pi/agent/pi-billing-window-fires/`; takeover по pid/TTL |

## 4. Архитектурный обзор (четыре механизма)

1. **Probe-staleness (F1)** — дешёвая попытка чтения staleness через runtime-метод (e), интегрированная в существующие точки (session_start, sync-тик, fireContinue). Признак `epoch-mismatch` — аддитивен в деталь, не новое слово события.
2. **Firelease (F2)** — новый sidecar-модуль `src/firelease.ts`: межпроцессный арендный маркер `(armedKey, lastResetAt)` через атомарный `wx`+O_EXCL, TTL+pid-живость, lazy-takeover. Форматы state/arms не трогает.
3. **Attr (F3)** — helper `withAttr(detail)` в `src/index.ts` (плюс документ `FORMAT.md`): единый блок ` key=… pid=… host=… ep=…` в конец detail строк fire-пути; существующие подстроки `.includes()` не нарушаются.
4. **Owner-shift (F4)** — аддитивная деталь `owner-shift: K1->K2` в `session-start` (FR-401) + минимальный guard D-608, чтобы чужой `session-start` не перехватывал `currentCtx`/`currentKey`/таймеры владельца при живом delivery.

Ни одно из изменений не добавляет слов в словарь событий и не меняет форматы файлов.

---

## 5. F1 — Stale-ctx: ранняя диагностика и минимизация задержки

### 5.1 Проблема (из инцидента 2026-09-27)

- Epoch-guard (D-201) срабатывает только когда `piApiEpoch !== sessionEpoch`. В сценарии (c) sessionEpoch НЕ мутируется (нет `session_shutdown` родителя) → guard считает ссылки «свежими», хотя `piApi` уже мёртв → `sendUserMessage` падает с «ctx is stale» на каждой попытке → цепи 5→10→20→40 мин. Модульный ДЕШЁВЫЙ probe (e) видит смерть ссылки даже без bump эпохи — это и есть недостающее раннее обнаружение.
- В сценарии (b) свежий `pi` появляется только через новую фабрику; пока её нет — модуль не может исцелиться сам. 006 не может это починить (ограничение (d)); минимум 006 — «диагностировать раньше + атрибутировать наглядно + гарантировать доставку на ПЕРВОМ тике ПОСЛЕ того, как свежие ссылки появились».

### 5.2 D-601 — Probe `probePiAlive(): "live" | "stale"` (раннее обнаружение)

**Decision:** модульный helper в `src/index.ts`:
```ts
let probeState: "live" | "stale" | "unknown" = "unknown";
function probePiAlive(): "live" | "stale" {
  if (piApi === null) return "stale";
  try {
    const p = piApi as unknown as { getSessionName?: () => unknown };
    p.getSessionName?.();          // любой runtime-метод обёрнут assertActive (факт e)
    probeState = "live";
  } catch {
    probeState = "stale";          // "ctx is stale" — ссылка инвалидирована
  }
  return probeState;
}
```
Ничего не шлёт, никогда не бросает (try/catch), `O(1)`. Вызывается:
- в `onSessionStart` — мгновенная картина после любого session_start;
- в `syncWatchdog()` (тот же цикл 60 с, что уже ходит) — регулярная картина без новых таймеров;
- в начале `fireContinue()` перед epoch-guard — свежий статус на момент попытки.

**Атрибуция (FR-101):** результат probe НЕ порождает новых слов события (D-006). Наблюдение прошивается в деталь строк fire-пути через helper `withAttr` (§7.1): когда `probeState==="stale"` или `piApiEpoch !== sessionEpoch`, строка получает токен `ctx=stale src=<probe|epoch-guard>` (+ `epoch-mismatch=1` для случая epoch-guard). Признак FR-101 — «различимый epoch-mismatch»: токен `epoch-mismatch=1` в детали.
**Alternatives:** отдельное событие `probe:stale` — отвергнуто (D-006); только лог в консоль — отвергнуто (NR-2: вердикт по журналу).
**Impacts:** FR-101, FR-103, NR-2.

### 5.3 D-602 — Аддитивный признак epoch-mismatch в двух точках

**Decision:** в `noteStaleFailure(kind, detail)` при `kind==="waiting"` деталь уже несёт `(piApiEpoch=…, sessionEpoch=…)` — дополняем токеном `ctx=stale src=epoch-guard epoch-mismatch=1` (не меняя существующих подстрок). В `onWatchdogFire` перед `armsLog("fire:reset-ready", …)` — если `probePiAlive()==="stale" || piApiEpoch !== sessionEpoch` → в деталь дописывается `ctx=stale src=drain epoch-mismatch=1` (признак, что fire планируется при мёртвых ссылках). Оба — по грамматике §7.1.
**Verify:** `tests/attribution.test.mts` — unit на stale-эпоху: fire-строка содержит и `epoch-mismatch`, и старые подстроки `.includes()`.
**Impacts:** FR-101, FR-103, NR-3.

### 5.4 D-603 — Сброс backoff/перерис на переусыновлении (различие (a)/(b)/(c))

**Decision:** единое правило обнуления pacing/счётчика + «немедленный перерис»:
1. **Сценарий (a) — `/reload`:** свежий модуль → `staleAttempts=0`, `staleRetryNotBefore=0`, `piApiEpoch === sessionEpoch` (все 0) — уже здоров; ничего дополнительно.
2. **Сценарий (b) — replacement/другая сессия, epoch-bump:** в `onSessionStart` в ветке `replacement:adopted` (D-201) уже: `staleAttempts=0; staleRetryNotBefore=0`. **Дополнение:** если модуль в in-flight доставке для последнего `lastResetAt` (T15/H0-маркер жив) — вызываем `void runGuarded(fireContinue)` СРАЗУ после adopted (не ждём следующий тик) → доставка на первом же владении свежих ссылок, обычно «меньше одного тика», в худшем случае ≤ одного backoff-шага. Перед вызовом — пере-проверка idle и lease (§6).
3. **Сценарий (c) — субагент без epoch-bump:** probe (D-601) детектит «ссылки мертвы» при `piApiEpoch === sessionEpoch`. Исцеление приходит только при появлении свежего `pi` (новая фабрика). Правило: **на каждом `onSessionStart` и каждом sync-тике, если `probeState` перешёл stale→live ИЛИ впервые после stale-цепочки выполнен epoch-guard, И есть in-flight доставка/armed c `lastFiredResetAt === st.lastResetAt`** → сбросить `staleAttempts`/`staleRetryNotBefore` и перерисовать: `ensureRetryInterval()` + `void runGuarded(fireContinue)`. Переходы probe логируются аддитивно в следующий fire-путь-строке (`src=probe`).
4. **Любой новый сброс окна** — уже сбрасывает `staleAttempts` в `syncWatchdog` (сохраняется).

**Alternatives:** ждать следующего тика (без форс-перериса) — латентность до 5 мин сверх; приемлемо, но форс-перерис дешевле и точнее. Полная изоляция по ключу (лечить (c) навсегда) — отвергнуто: вне скоупа до E1 (Q-002/FR-402).
**Impacts:** FR-102, FR-103, NR-1.
**Ограничение, фиксируем явно:** пока нет новой фабрики, (c)/(b)-процесс с мёртвым `pi` НЕ может доставить (ограничение (d)); 006 гарантирует диагностику + доставку на первом тике после появления свежих ссылок, не саму регенерацию ссылок.

### 5.5 E1 — Эксперимент «in-process субагент инвалидирует ctx родителя?» (ДОСТАВЛЯЕМЫЙ тест-скрипт)

### D-609 — E1 как отдельная доставляемая задача

**Decision:** E1 — отдельная задача реализации; план фиксируется здесь как контракт; драйвер `reports/006-e1-subagent-stale.py` (+ отчёт `reports/006-e1-report.md`). Запускается после внедрения D-601/D-607 (источники наблюдаемости).
- **Харнесс:** `rpc_harness.RpcSession` (из 004) — живая сессия `pi --mode rpc` (родитель). Дочерняя сессия создаётся в ТОМ ЖЕ процессе через prompt, который запускает вложенный агент (subagent в том же runner/runtime).
- **Наблюдаемость:** после внедрения D-601/D-607 протокол фиксирует:
  - `session-start` дочернего ключа с деталью `owner-shift: K_parent->K_child` (FR-401);
  - переход probe → `ctx=stale src=probe` на fire-путь-строке родителя БЕЗ предшествующего `session-start`/`replacement:adopted` родителя — прямое доказательство «инвалидация без события замены».
- **План шагов E1 (драйвер `reports/006-e1-subagent-stale.py` в каталоге спеки):**
  1. `RpcSession(parent)` → wait `session-start` для родителя; снять параметры (key/pid/ep из журнала).
  2. Взвести arm родителя (`/cont-after-reset`) → ждать `arm-seen` (key=parent).
  3. Отправить prompt, который форсирует запуск in-process субагента (Agent-вызов с узкой задачей) → ДОЖДАТЬСЯ в журнале `session-start` с ЧУЖИМ key (деталь owner-shift).
  4. Форс-сброс окна родителя (внешне `/settimer 0` или запись state) → наблюдать probe: строка `fire:reset-ready`/`send-error:stale` родителя с `ctx=stale src=probe`.
  5. ASSERT-ы по журналу: (i) owner-shift залогирован; (ii) за период [child session-start, fire] НЕТ `session-start`/`replacement:adopted` для родительского ключа; (iii) `src=probe` присутствует; (iv) вердикт гипотезы YES/NO/UNKNOWN.
  6. Повтор после внедрения D-608 (guard): (iv') доставляется ли «продолжи» родителю после того, как дочерняя сессия «отвалилась» (субагент завершён).
- **Критерии приёмки E1:** скрипт проходит (или честно печатает NO/UNKNOWN), шаги воспроизводимы, журнал — единственный источник доказательства.
- **Влияние:** результат E1 решает Q-002: полная изоляция по ключу (FR-402) включается как Must (если YES) или остаётся кандидатом / закрывается (если NO).

---

## 6. F2 — Межпроцессный дедуп сброса (firelease sidecar)

### 6.1 D-604 — Арендный маркер `(armedKey, lastResetAt)` через O_EXCL

**Decision:** новый модуль `src/firelease.ts` (чистый, тестируемый, без зависимостей от pi). Аренда = атомарно создаваемый файл.

- **Каталог маркеров:** `~/.pi/agent/pi-billing-window-fires/<keyId>/<lastResetAt>.mark`, где
  - `<keyId>` = `sha1(armsKey).slice(0, 16)` (профиль-независим, NR-5; полный путь ключа хранится ВНУТРИ маркера для атрибуции и чтения);
  - `<lastResetAt>` = `String(st.lastResetAt)` — значение, по которому дедуплицируется именно этот сброс;
  - каталог — «профиль», вне `arms.json`/`state.json` (D-007/D-004); имя намеренно не пересекается с существующими артефактами.
- **Формат маркера (JSON):**
  ```json
  { "locked_at": 1790000000000, "pid": 4821, "host": "ws-node-7",
    "ep": 3, "reset": 1790000000000, "key": "C:\\...\\session file.json",
    "mode": "planned" }
  ```
- **`acquireFireLease(key, reset)` (поток):**
  1. `try` атомарный `fs.openSync(markerPath, "wx")` (O_EXCL) + запись содержимого → **acquired**.
  2. При `EEXIST` — прочитать содержимое. **skip**, если маркер «живой»: `now - locked_at < FIRE_LEASE_TTL_MS` И `pidAlive(holderPid)`. Возврат `{ ok:false, holderPid, holderEpoch }` (для атрибуции — какой процесс держит).
  3. Takeover, если маркер «мёртв» (TTL истёк ЛИБО `pid` не жив): `rmSync` + повтор `wx` (bounded ≤3; при конкуренции двух takers второй получает EEXIST и уходит в skip, fail-safe «не дублировать») → **acquired** (takeover).
  4. Возврат `{ ok:true, replaced?:true }` или `{ ok:false, holderPid }`.
- **`releaseFireLease(key, reset, myPid)`:** удаляет маркер ТОЛЬКО если `content.pid === myPid` и `content.ep === мой sessionEpoch` (не сносить чужую новую аренду после takeover) → compare-and-remove (read+check+rm; окно гонки документировано ниже).
- **Точки в коде (все планирующие fire места):**
  1. `onWatchdogFire` (~684): `const lease = await acquireFireLease(key, base)`; если `!lease.ok` → НЕ логировать `fire:reset-ready`, НЕ ставить `lastFiredResetAt`, НЕ планировать grace для этого reset — дедуп пройден молча (опционально аддитивным `heldBy=pid` в следующую строку arm-семейства; по умолчанию молчание); watchdog уже стоит на СЛЕДУЮЩЕЙ границе. Если `ok` → текущее поведение (лог + grace).
  2. `syncWatchdog` short-circuit (~603-612): тем же helper'ом `planFireForReset(st)` — если lease взять нельзя (маркер чужой и живой) → `armWatchdog(computeFireAt(st))` на следующую границу, НЕ трогая `lastFiredResetAt`.
  3. Единый внутренний helper `planFireForReset(st): Promise<boolean>` на оба места — одна точка маркер-логики, чтобы не разъехаться.
- **Send-gating (at-most-once «продолжи»):** в `fireContinue` перед `sendUserMessage` — проверка «аренда ещё моя»: если маркер отобран по TTL/смерти → НЕ отправляем, уходим в pacing (другой процесс доставит). Отправляет только обладатель аренды.
- **Освобождение (release-точки):**
  - `fire:confirmed` (успех) → `releaseFireLease`;
  - `capitulation:after-N` → `releaseFireLease`;
  - `disarm`/`arm-gone` (флаг снят) → `releaseFireLease`;
  - **stale-failure** (FR-203, «TTL/сброс») → `releaseFireLease` на ПЕРВОМ же stale-провале, с сохранением собственного retry-цикла (затем повторный acquire перед следующей попыткой — backoff-асимметрия даёт другому процессу шанс доставить первым);
  - non-stale `send-error` → аналогично release.
- **Restart-survival (FR-202):** маркер — файл; свежий процесс при планировании того же `(key, reset)` видит живой маркер (TTL/pid жив) → skip → повторного fire нет. Модульный `lastFiredResetAt` при рестарте `null`, поэтому защита — именно маркер.
- **Два ключа одновременно (FR-201):** маркеры в разных `<keyId>/` каталогах — не пересекаются; каждый ключ получает свой fire на общий сброс.
- **Один ключ, два процесса:** выигрывает первый acquire; второй skip ⇒ один `fire:reset-ready` на (key, reset) на всех процессах.

**Risks (задокументировать):**
- Гонка «два живых держателя» после takeover — вероятность низкая (O_EXCL + backoff-асимметрия), следствие — дубль «продолжи», который АТРИБУЦИЯ (FR-301) делает видимым и вердиктным (дубль = ANOMALY-флаг ночного монитора, не скрытая потеря).
- Молчаливый пропуск fire из-за живого маркера (другой процесс «занял и не доставил») — защищён TTL 10 мин и release-on-stale: максимум задержка ≈ TTL до takeover (FR-203).
- Compare-and-remove гонка (release между чтением и rm) — риск минимален; при потере аренды эффект = дублирующий fire на следующем тике (атрибутируемый), не потеря.

### 6.2 D-605 — Ленивый TTL + unref/exit-hygiene

**Decision:** `FIRE_LEASE_TTL_MS = 10 * 60_000` (один с лишним backoff-шаг; заметно меньше 2-часового окна; достаточно для полной доставки в норме). TTL проверяется ТОЛЬКО при доступе (lazy) — НИКАКИХ persistent-таймеров в firelease: acquire/release/check — синхронные fs-операции; повторные попытки wx — bounded ≤3 немедленно. Если понадобится отложенный takeover — единственный `setTimeout(...).unref()`, без удержания процесса (spec 003). Exit-hygiene: ни один новый интервал не добавляется ⇒ тест exit-hygiene расширяется на firelease (нет открытых хендлов).
**Impacts:** FR-204, NR-4, NR-5.

---

## 7. F3 — Аддитивная атрибуция armslog

### 7.1 D-606 — Единый формат токенов ` key=… pid=… host=… ep=…`

**Decision (грамматика, документируется в `FORMAT.md`):**
```
<существующий detail>  key=<basename> pid=<pid> host=<host> ep=<п> [ctx=stale src=<probe|epoch-guard|drain>] [epoch-mismatch=1]
```
Правила:
- Блок разделяется одним пробелом и пишется В КОНЦЕ detail-строки (после всей существующей семантики) — мониторы (LINE_RE `.*`) и `.includes()`-тесты не ломаются.
- `key=` — **basename** сессии (без пути; то, что уже парсится `run_a1.py` через `re.search(r"key=([^ ]+)")`); полный путь остаётся только в `session-start`-строке (`path=…`) для джойна по host (Q-004: basename может быть не уникален между ветками одного хоста — джойн `(key + host + ep)`).
- `pid=` — `process.pid`; `host=` — `os.hostname()` (обрезанный до первого `.`/`/`, ASCII-безопасен); `ep=` — `sessionEpoch` в момент строки.
- **Дедуп слов:** helper `withAttr(detail)` НЕ дублирует уже присутствующие в detail токены `key=`/`pid=`/`host=`/`ep=` (иначе `session-start`/`arm-seen`, где `key=` уже есть, получат второй `key=` и могут сломать first-match парсеры). Реализация: regex-поиск существующих токенов, из блока добавляются только отсутствующие.
- `ctx=stale src=…` / `epoch-mismatch=1` — признаки F1 (§5), появляются только на строках с признаком.
- Реализация: helper в `src/index.ts` `function withAttr(detail: string): string` (читает модульные key/pid/host/ep + `staleAttr()`); `armslog.ts` НЕ трогаем (контракт never-throw и формат без изменений).

**Какие строки НЕСУТ токены (fire-путь, FR-301):** `fire:reset-ready`, `fire:send-ok`, `fire:confirmed`, `send-error`, `send-error:stale`, `replacement:waiting`, `replacement:adopted`, `capitulation:after-N`, `session-start`, `arm-seen`, `arm-gone`. **НЕ трогаем:** `watchdog:eval-error`, `watchdog:reset-error`, `block:no-pi` (служебные, не в FR-301; минимизация поверхности). ВНУТРИ fire-пути detail остаётся на русском (существующие подстроки); токены — строго ASCII.
**Verify:** `tests/attribution.test.mts` (грамматика + отсутствие дублей токенов), полный регресс 10 сьютов 0 FAIL, `.includes()`-наборы старых тестов не тронуты.

### 7.3 D-610 — Документирование формата и деплой

**Decision:** грамматика токенов фиксируется в документе `FORMAT.md` (каталог спеки 006) и в `docs/watchdog-redesign.md`; `scenario_monitor.py`/night-monitor используют её без правок схемы (FR-303). Деплой: в `deploy.ps1` добавить `"firelease.ts"` в `$files` (новый файл src; в отличие от 002).

### 7.2 Решение FR-103 (счётчик по эпохе/процессу)

Уже есть «попытка N/6» в `noteStaleFailure`; плюс `ep=`/`pid=` в блоке → цепочка «1/6 ep=3 pid=A … 3/6 ep=7 pid=B» распознаётся монитором как МЕЖПРОЦЕССНОЕ смешивание (инцидент 19:07-19:27), а не одна прогрессия. Атрибуция `session-start` (owner-shift) даст точку смены владельца.

---

## 8. F4 — Owner-shift наблюдаемость и минимальная изоляция

### 8.1 D-607 — Owner-shift в `session-start` (FR-401, Must)

**Decision:** модульная переменная `ownerKey: string | null` (владелец «глобального состояния обсуждения» — текущий conversation, на который указывает `currentKey`, обслуживаемый таймерами). Устанавливается в `onSessionStart` после маппинга (там, где уже пишется `session-start`). Если при новом `session-start` `key ≠ ownerKey` (ownerKey не null) → деталь строки `session-start` дополняется аддитивно: `owner-shift: K_old->K_new`. Эта строка — единственный признак FR-401; она же — доказательство для E1.
**Verify:** `tests/session-isolation.test.mts` (эмуляция чужого `session-start` → деталь `owner-shift`).

### 8.2 D-608 — Минимальный guard «не трогать таймеры/epoch владельца» (FR-402, Should, гейтится E1)

**Decision (минимальный фикс, НЕ полная изоляция):** в `onSessionStart` строго до строки `currentCtx = ctx`:
```ts
const incomingKey = sessionKeyOf(ctx);
const reason = String((event as {reason?:string}|null)?.reason ?? "");
if (
  ownerKey !== null &&
  incomingKey !== ownerKey &&
  remapKey(reason) === "repoint" &&          // resume/reload/startup
  hasLiveOwnerInterest()                     // живой флаг (armed/pending) ИЛИ in-flight доставка для ownerKey
) {
  // КРИТИЧНО: currentCtx остаётся ctx ВЛАДЕЛЬЦА — иначе shutdown-гвард
  // (_ctx !== currentCtx) пропустит смерть дочерней сессии и убьёт
  // таймеры/epoch владельца. TUI-статус продолжает показывать владельца.
  armsLog("session-start", `reason=${reason} key=<incoming> armed=… owner-shift(blocked): ${ownerKeyBasename}->${incomingKey}`);
  // НЕ: currentCtx = ctx, НЕ: armsSwitchKey(incomingKey), НЕ: переснятие piApi/eventBus по чужому ключу,
  // НЕ: сброс staleAttempts по чужому поводу — delivery владельца остаётся нетронутым.
  return;
}
```
Почему именно «repoint + другой ключ»: семантика `remapKey` (arms.ts) уже говорит «arm stays with the conversation that created it; repoint не двигает запись». Значит repoint на чужой ключ — это и есть «чужая сессия» (дочерний субагент, reason=startup по живым наблюдениям), и не перехватывать `currentKey`/`currentCtx`/таймеры — безопасно и консервативно. Условие блокировки — `hasLiveOwnerInterest()`: у владельца есть живой флаг (armed/pending, не истёк) ЛИБО in-flight доставка; «занятость» без флага не блокируем (сессии-сироты не мешают идентичной переустановке состояния).
Следствие для защиты таймеров: `currentCtx` остаётся у владельца, поэтому `onSessionShutdown` дочерней сессии (`_ctx !== currentCtx`) корректно **раньше выходит** — `sessionEpoch++` и `stopWatchdogTimers()` родителя НЕ выполняются (закрывает часть гипотезы (c) о мутации epoch/таймеров без события замены).
`ownerKey` обновляется ТОЛЬКО: (i) при первом session-start; (ii) при session-start с совпадающим ключом; (iii) при carry-причине; (iv) на командах `/cont-after-reset` (сознательно привязываем к новому ключу). При живом delivery чужого владельца смену `ownerKey` не делаем.
**Альтернатива:** полная per-key изоляция глобального состояния (generic map key→state) — отвергнута: без эксперимента (Q-002) поведение неизвестно, риск сломать легитимные fork/reload; оставлено E1.
**Что остаётся за E1:** (a) каким `reason` pi маркирует session-start дочернего субагента — если это `"startup"/"resume"`, guard закрывает сценарий (c); если `"new"` — нужен доп. механизм (вне 006); (b) реально ли dispose дочерней сессии убивает общий runtime без события замены — только E1 докажет.
**Impacts:** FR-401, FR-402 (гейт), NR-1, E1.

---

## 9. Риски и компромиссы (по решениям)

| Решение | Риск / компромисс | Митигация |
|---|---|---|
| D-601 probe | probe на `getSessionName` может упасть не по stale (внутренняя ошибка) | try/catch всё равно даёт «stale» — консервативно к отправке; влияет как признак, не как блокер |
| D-602 признак | признак на «первой строке периода» может оказаться на соседней строке, если fire-путь прерван | токены включаются на ЛЮБОЙ fire-строке с `ctx=stale`; монитор ищет по всем; отчётность по `src=` |
| D-603 перерис | форс-`fireContinue` сразу после adopted может наткнуться на не-idle/занятую аренду → «пропуск попытки» | задержка ≤5 мин (следующий тик уже есть — `ensureRetryInterval` активен); FR-102 «≤1 шаг» держится в худшем случае |
| D-604 маркер | (1) гонка двух держателей → дубль «продолжи»; (2) ложный молчаливый skip при живом, но «висячем» держателе | (1) O_EXCL + backoff-асимметрия + дубли атрибутируемы/ANOMALY; (2) TTL 10 мин + release-on-stale — задержка до takeover ≤TTL |
| D-604 маркер | маркер остаётся после краха процесса до TTL → задержка до delivery до 10 мин | компромисс «надёжность дедупа vs задержка»; FR-203 удовлетворяется release/stale/TTL; приоритет — не дублировать |
| D-605 lazy TTL | если все процессы мёртвы, маркер живёт до TTL (10 мин) и блокирует экстренный внешний delivery | принимается: ночной watchdog внешний (f) не зависит от маркера; TTL короткий |
| D-606 формат | дедуп слов мог бы «вычистить» существующий `key=` из строки, ломая парсеры | helper только ДОБАВЛЯЕТ отсутствующие токены; никогда не удаляет/переписывает существующие |
| D-607 owner-shift | `ownerKey`-семантика неочевидна при fork (несколько веток одной беседы) | ownerKey = conversation, на который указывает currentKey; fork → carry (владелец переезжает) — покрыто тестами 002 |
| D-608 guard | guard «repoint+чужой ключ» может ошибочно заблокировать легитимный resume другого окна того же процесса | легитимных таких кейсов в pi в одном процессе нет (одна сессия = один процесс); риск низкий; полная проверка — E1 |
| Все | старые процессы (без 006) с новым маркер-файлом — см. FAQ F-5 | маркер — чистый файл, старый код его просто не знает (модульный D-203 остаётся внутри старого) |

## 10. Edge cases

| Случай | Поведение |
|---|---|
| Два процесса, один ключ, один сброс | один acquire выигрывает → один `fire:reset-ready`; второй skip, watchdog на след. границу |
| Два ключа, один сброс | два маркера в разных `<keyId>/` → два fire (по одному на ключ) — FR-201 |
| Рестарт процесса с живым маркером и перейдённой границей | маркер жив → повторного fire нет — FR-202 |
| Держатель stale / мёртв | release-on-stale / TTL / pid-мёртв → другой процесс доставляет — FR-203 |
| Идентичные `lastResetAt` в разных каталогах | маркеры не пересекаются (разные keyId) — корректно |
| `piApi===null` (`block:no-pi`) у держателя | маркер держится с живым pid → другие skip до TTL (10 мин) → takeover; own retry продолжается |
| `probeState` stale→live (новая фабрика) | перерис на первом же владении: `ensureRetryInterval` + форс-`fireContinue` (D-603) |
| Чужой `session-start` при живом delivery владельца | D-608 guard: не трогаем currentKey/currentCtx/таймеры/epoch; деталь owner-shift |
| Капитуляция | `releaseFireLease`; флаг снят; notify (D-205) — «не молчать» держится |
| `fire:confirmed` | release маркера + существующий флоу (repeat/re-arm) |
| Ротация лога / обрезка | токены внутри detail; монитор обрабатывает строку целиком — без правок |
| old-процесс (без 006) рядом с новым | старый логирует без токенов; межпроцессный дедуп «новый против старого» НЕ работает (старый не пишет маркер) — принято, см. FAQ F-5 |

---

## 11. Implementation FAQ

- **F-1: что если два окна (процесса) у ОДНОГО ключа одновременно?** Маркер per `(key, reset)` — один выигрывает аренду; второй не планирует fire и молчит (watchdog на след. границу). Если выигравший «висячий» — TTL 10 мин даёт takeover. Рекомендация мониторинга: опциональный аддитивный `heldBy=pid` в следующей строке arm-заметного события, если нужно видеть « кто держит» (не default).
- **F-2: `piApi === null` в `fireContinue` (`block:no-pi`)?** Не stale, не капитуляция; маркер НЕ освобождается (holder жив), другие процессы skip до TTL — защита от двойной отправки. Флаг не теряется; retry продолжается; после новой фабрики `probeState→live` → перерис.
- **F-3: маркер взять НЕ удалось (живой чужой), а доставка критична?** Это штатный дедуп: другой процесс доставит. Takeover автоматически при TTL/смерти владельца. Форс-обход маркера НЕ предусмотрен (нарушил бы FR-201/202).
- **F-4: новые строки обязаны сохранять `.includes()`-совместимость.** Да — токены пишутся В КОНЕЦ detail, после существующего русского текста; грепы `run_a1.py` (`key=([^ ]+)` на session-start) и `.includes("fire:send-ok")` и т.п. не ломаются (helper не дублирует `key=`).
- **F-5: поведение СТАРЫХ процессов (код без 006) рядом с новым.** Старый код не пишет/не читает маркер firelease → межпроцессный дедуп работает только «новый против нового»; «новый против старого» — маркер пишет новый, старый его не видит (возможны дубли fire:reset-ready от старого). Ночной деплой: обновляем ВСЕ окна/стенды разом (как и раньше — по /reload); одиночный старый процесс даёт атрибутируемый дубль (NR-3), не потерю.
- **F-6: как измерить FR-102 («≤1 backoff-шаг»)?** night-monitor парсит пару `fire:reset-ready` → `fire:send-ok` по `(key, ep)`; порог = 5 мин (RETRY_AFTER_FIRE_MS); > 1 шага — FAIL, а строка источника `src=` (probe/epoch-guard) объясняет задержку.
- **F-7: нужна ли миграция данных?** Нет (D-004): маркер — sidecar, форматы state/arms не меняются; старые arms.json читаются как есть.
- **F-8: deploy.** В `deploy.ps1` в `$files` добавить `"firelease.ts"`; `docs/watchdog-redesign.md` и README §8a — новые токены/маркер/owner-shift.

---

## 12. Тестовая стратегия (FR → файлы, подход, без кода)

Стиль — plain tsx + assert (как `tests/watchdog.e2e.test.mts`); `setPaths`/`setArmsLogPath`/хуки `__syncWatchdogForTests`/`__fireWatchdogForTests`/`__retryTickForTests`; детерминированные моки времени. Каждая задача на тест — RED до реализации.

| FR | Файл | Подход |
|---|---|---|
| FR-101/FR-103 | `tests/attribution.test.mts` (новый) | форс `piApiEpoch!==sessionEpoch`; assert `ctx=stale src=…`/`epoch-mismatch=1` и `ep=`/`pid=` на `send-error:stale`/`fire:reset-ready`; цепочка `staleAttempts` различима по эпохе |
| FR-102 | `tests/replacement.test.mts` (расширить) / `watchdog.e2e` | stale на границе → adopted → следующий `__retryTickForTests` даёт `fire:send-ok` (форс-перерис); нет stale-строк старой эпохи после adopted |
| FR-201/202/203/204 | `tests/firelease.test.mts` (новый, юнит; «два инстанса» = две аренды на один каталог) | acquire/skip; два ключа → два fire; restart-имитация (второй инстанс, маркер на месте) → нет re-fire; takeover по TTL и по «мёртвому pid»; release на confirm/capitulate/stale; exit-hygiene (нет новых таймеров) |
| FR-201 cross-process | `tests/firelease.e2e.test.mts` (новый) | две независимые копии firelease-состояния на ОДИН маркер-каталог (эмуляция двух процессов файловой арендой) → 1 fire:reset-ready на (key,reset); два ключа → 2 fire |
| FR-301/302/303 | `tests/attribution.test.mts` + `scripts/scenario_monitor.py` (без изменений схемы) | assert грамматики ` key=… pid=… host=… ep=…`; старые `.includes()`-наборы зелёные; «эмуляция атрибуции» на выгруженном журнале инцидента → night-mini PASS; монитор парсит без правок |
| FR-401 | `tests/session-isolation.test.mts` (новый) | эмуляция чужого `session-start` (reason=startup, другой key) при живом delivery → строка с `owner-shift`; таймеры владельца живут; `currentCtx` не перехвачен |
| FR-402 (гейт) | E1-скрипт (§5.5) | вердикт E1 → решение о полной изоляции отдельной задачей |
| NR-1..NR-3, регресс | полный набор 10+ сьютов | `npx tsx tests/*.test.mts` → 0 FAIL, asserts ≥443 (+ новые); капитуляционные/002-тесты без изменений |

**Новые файлы:** `tests/firelease.test.mts`, `tests/firelease.e2e.test.mts`, `tests/attribution.test.mts`, `tests/session-isolation.test.mts`, `src/firelease.ts`, `docs/watchdog-redesign.md` (обновление), `FORMAT.md`; **E1:** `reports/006-e1-subagent-stale.py` (+ отчёт `reports/006-e1-report.md`). **Правки:** `src/index.ts` (probe/attr/owner-shift/guard/lease-вызовы), `deploy.ps1` (+firelease.ts).

## 13. Out of scope (повтор, не реализуется)

- Форматы arms/state (D-004), логика checkAndReset/ticker, протокол pi, словарь событий (D-006), механика сброса окна, SLA окна.
- Поведенческая изоляция по ключу сессии (FR-402) — за экспериментом E1 (Q-002); здесь только FR-401 наблюдаемость.
- Внешний watchdog (`night_watchdog.py`) — вне скоупа (факт (f)).
- Полная регенерация ссылок без новой фабрики (ограничение (d)) — 006 гарантирует диагностику + доставку на первом тике после свежих ссылок, не саму регенерацию.

## 14. Открытые вопросы (перенос)

- **Q-001** (почему reload не переснял ссылки / ни одного replacement:waiting за инцидент) — частично адресуется D-601/D-603 (probe + перерис); полный ответ в E1-наблюдениях.
- **Q-002** (валидна ли субагент-инвалидация) — E1 (§5.5); от вердикта зависит Must/Should для FR-402.
- **Q-003** (механизм межпроцессного дедупа) — решён как sidecar-аренда (D-604): атомарный файл + TTL + pid-живость.
- **Q-004** (pid/host канон) — решение: `pid=process.pid`, `host=os.hostname()` (первый label), `key=` basename; джойн `(key,host,ep)`; полный путь — только в `session-start`.
- **Q-005** (FR-102 — Must-метрика или ориентир) — фиксируем как порог вердикта night-monitor (5 мин); оставить ориентиром, если live-измерение покажет систематический оверхед.
- **Q-006** (pending-hb) — вне требований 006; остаётся метрикой наблюдения.
