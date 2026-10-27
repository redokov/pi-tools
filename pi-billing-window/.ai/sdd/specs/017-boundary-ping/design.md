# Design: Spec 017 — boundary-ping

> Status: design:approved
> Requirements: requirements.md (FR-017-1..12, D-001..D-009 утверждены)

## 1. Карта требований → дизайн

| FR | Решение |
|---|---|
| FR-017-1, 6 | `pingBoundaryFlow()` в новом `src/ping.ts` внутри `onWakeFire` (§3) |
| FR-017-2, 3 | `sendPing()` с деревом попыток json→fallback-модель→sse (§4) |
| FR-017-4 | `handlePingLimit()`: re-anchor / retry-точки (§5.2) |
| FR-017-5 | `handlePingInfra()`: streak → слепой fallback (§5.3) |
| FR-017-7 | маркер `ping.lastBoundary` в state (§5.1) |
| FR-017-8 | burned-head ветка `onWakeFire` с `blindOnInfra=false` (§6) |
| FR-017-9 | `manualPing()` + команда `/ping-wormsoft` (§7) |
| FR-017-10 | `ping.disabled` + `/billing-ping` (§7) |
| FR-017-11 | пинг не проходит через пайплайн pi → механизмы окна его не видят (§2) |
| FR-017-12 | history/armslog/notify/статус-строка (§8) |

## 2. Архитектура

Новый модуль **`src/ping.ts`** (~350 строк) — вся логика пинга, включая вызов
`checkAndReset` на исходе «ok». `index.ts` получает минимальную врезку:
`onWakeFire` вместо безусловного `checkAndReset` вызывает `pingBoundaryFlow`;
burned-head ветка — probe-режим того же флоу. Модули `reset.ts`, `wakeups.ts`
(одно дополнение), `state.ts` (одно поле), `history.ts` (одно значение kind)
меняются минимально; `firelease.ts` НЕ используется (D-007).

```
onWakeFire (index.ts, spec 012)
  └─ consume head (с новым guard: cur.points[0] === firedPoint)
  └─ pingBoundaryFlow({firedPoint, note, emit, meta, blindOnInfra})
       ├─ ping disabled / state null → legacy: checkAndReset (или тихо на burned)
       ├─ recorded result для этой границы (ping.lastBoundary === firedPoint)?
       │    ok → checkAndReset (dedup защищает) → applyPingAnchor
       │    429/infra → идемпотентные handle* (§5)
       ├─ иначе: loadPingConfig() → sendPing() (§4)
       │    ok    → record → history/armslog → checkAndReset → applyPingAnchor
       │    429   → record → last429At → handlePingLimit
       │    infra → record → handlePingInfra (blindOnInfra ? слепой reset : retry)
```

Почему `checkAndReset` вызывается из ping.ts, а не из index.ts: единая точка
«исход пинга → действие над окном», идемпотентность и тестируемость всего флоу
в одном модуле (index.ts остаётся орkestратором таймеров).

## 3. Интеграция в onWakeFire (index.ts)

```ts
// БЫЛО: await checkAndReset(emit, meta, wakeNoteOf(firedPoint));
// СТАЛО:
await pingBoundaryFlow({
  firedPoint,
  note: wakeNoteOf(firedPoint),
  emit: buildEmitFn(),
  meta: historyMetaOf(currentCtx),
  blindOnInfra: true,   // обычная граница: infra-fallback разрешает слепой reset
});

// burned-head (после purge):
await pingBoundaryFlow({
  firedPoint: burnedPoint,
  note: `probe ${wakeNoteOf(burnedPoint)}`,
  emit, meta,
  blindOnInfra: false,  // spec 012: не стрелять в прошлое вслепую
});
```

Guard потребления головы (баг-фикс spec 012, обнаружен при проектировании):
два процесса, сработавшие на одну точку, оба делали `points.slice(1)` — второй
съедал лишнюю точку. Новый guard: трансформация потребляет голову только если
`cur.points[0] === firedPoint`. Хвост всё равно восстанавливается якорями, но
guard делает двойное срабатывание строго no-op.

## 4. sendPing — транспорт (ping.ts)

### 4.1 Конфиг

`loadPingConfig()` читает `~/.pi/agent/models.json` → `providers.wormsoft.baseUrl`
и `~/.pi/agent/auth.json` → `wormsoft.key`. Толерантно (битый JSON / нет полей →
null → infra-путь). Пути переопределяемы для тестов `setPingConfigPaths()`.
Локальная константа `PING_PROVIDER = "wormsoft"` (дублирует index.PROVIDER —
без циклического импорта).

### 4.2 Запрос

```
POST {baseUrl}/chat/completions
Authorization: Bearer <key>
{ "model": <model>, "messages": [{"role":"user","content":"ping"}],
  "max_tokens": 2, "stream": false|true }
```

### 4.3 Дерево попыток (резолв mode + model, D-002/D-003)

```
attempt(model, mode) → {200: ok(+usage), 429: limit, статус, ошибка сети/таймаут}

1. attempt(resolvedModel, "json")            // resolvedModel = ping.model ?? PING_MODEL
   200/429 → результат, mode="json"
2. статус ∈ {400,404,422} и model === PING_MODEL:
   attempt(PING_FALLBACK_MODEL, "json") → 200/429 → результат, model=fallback
3. статус ∈ {400,404,405,406,415,501} (протокол/модель):
   attempt(model, "sse") → 200/429 → результат, mode="sse"
   (sse: статус из заголовков; первый чанк reader → abort; usage unknown)
4. иначе (401/403/5xx/сеть/таймаут) → infra(lastError)
```

Рабочие mode/model кэшируются в state.ping при исходе ok/limit. Таймаут 30 с:
AbortController + `setTimeout(...).unref()` + clearTimeout по завершении.
429 не ретраится внутри пинга (нужен сырой статус). usage парсится толерантно
(`prompt_tokens|input_tokens`, `prompt_tokens_details.cached_tokens`).

Инъекция для тестов: `setPingFetchForTests(impl)` + опциональный `timeoutMs`.

## 5. pingBoundaryFlow — машина состояний границы

### 5.1 Записанный результат (dedup, FR-017-7 / D-007)

`state.ping.lastBoundary` — маркер границы последнего авто-пинга. Процесс,
заставший `lastBoundary === firedPoint`, НЕ пингует: ok → checkAndReset
(dedup reset 10 мин защищает от дубля; покрывает смерть победителя до reset'а);
429/infra → идемпотентные handle* (§5.4).

### 5.2 handlePingLimit (429, FR-017-4)

```
st.firstCallEmittedAt = fc
fc определён и fc > windowStartedAt:
    re-anchor: windowStartedAt := fc
    wake-таблица := computeTableFromAnchor(fc)   // полная перестройка, kills stale grid
    retryAttempt := 0; armsLog ping:429-reanchor; notify (info)
fc определён и fc === windowStartedAt: no-op (другой процесс уже re-anchor'ил)
fc нет (unknown anchor):
    retryAttempt++
    > PING_RETRY_MAX(12): armsLog ping:429-cap + notify (однократно) — точки не пишем
    иначе: insertRetryPoint(now + 10 мин); armsLog ping:429-unknown-anchor N/12
```

Обоснование корректности re-anchor: провайдер якорит окно первым запросом любого
потребителя ключа ⇒ наш fc ≥ истинного якоря ⇒ fc+2h — верхняя граница конца
окна ⇒ повторный пинг на ней уже не встретит 429 (сходится за одну коррекцию).

`last429At := now` — честный сигнал для pacing'а cont-after-reset.

### 5.3 handlePingInfra (FR-017-5)

```
infraStreak++
streak ≥ 3:
    blindOnInfra? → checkAndReset (слепой legacy reset; dedup защищает)
                    + однократный notify ping:infra-fallback (infraNotified до восстановления)
    burned (blindOnInfra=false)? → только retry-точка (spec 012 «не стрелять в прошлое»)
streak 1..2: insertRetryPoint(now + 2 мин)
burned-путь (слепой reset запрещён) БЕЗ капа ретраился бы вечно --
кап PING_INFRA_BURNED_MAX=30 (~1 час): probe-пинги останавливаются с
однократным notify до восстановления транспорта.
```
infraStreak/infraNotified сбрасываются на первом реальном сигнале (ok/429).

### 5.4 Идемпотентность handle* (параллельные процессы + записанный результат)

- re-anchor: применяется только при `fc > windowStartedAt` (после чужого
  re-anchor условие ложно).
- retry-точки: `insertRetryPoint` с epsilon 60 с (дубль точки не вставляется);
  повторное инкрементное перепланирование — no-op.
- слепой reset: dedup checkAndReset (10 мин).
- retryAttempt/infraStreak могут дважды инкрементироваться в race — безопасно
  (кап срабатывает на раунд раньше, notify дедуплируется флагом).

### 5.5 applyPingAnchor (FR-017-6)

После checkAndReset на исходе ok (reset фактически случился: `lastResetAt`
свежий) и если `firstCallEmittedAt` ещё не установлен:
`firstCallEmittedAt := sentAt` (момент ОТПРАВКИ пинга) и wake-таблица :=
`computeTableFromAnchor(sentAt)`. Тогда первый реальный вызов не создаёт
двойной якорь (точка уже есть — appendAnchorPoint не сработает по флагу
firstCallEmittedAt), а сетка идёт от пинга. llm:first_call НЕ эмитится.

## 6. wake-таблица

Единственное дополнение к `wakeups.ts` — чистая `insertRetryPoint(table, ts)`:
вставка точки с epsilon-дедупликацией (WAKE_APPEND_EPSILON_MS) и сортировкой.
Retry-точки (10 мин / 2 мин) — обычные точки: планировщик, safety-net 60 с и
burned-TTL работают без изменений. Re-anchor и ping-anchor делают ПОЛНУЮ
перестройку `computeTableFromAnchor` (авторитетный якорь), убирая stale-grid.

## 7. Команды

- **`/ping-wormsoft`** → `manualPing()`: sendPing, тост
  `пинг → 200 OK, 84 мс, 12 ток (gpt-oss:20b)` / `пинг → 429 (лимит исчерпан)` /
  `пинг → infra: <err>`; history kind="ping" note="manual"; armsLog ping:manual;
  обновляет ping.lastAt/lastStatus/mode/model, НО lastBoundary/last429At/окно —
  не трогает.
- **`/billing-ping on|off|status`** (дефолтный аргумент status): ping.disabled;
  off = точный legacy-путь на границах.
- **`/billing-status`**: + строка `ping: on|off, <mode>, <model>, <lastStatus HH:MM>`.

## 8. Наблюдаемость

- history: kind="ping" (auto ok/infra/manual, usage+model в строке),
  kind="429" note="ping probe". Схема CSV не меняется (kind — значение).
- `billing_report.py`: без изменений — все секции фильтруют kind=="call",
  ping-строки в разрезы не попадают (проверяется тестом).
- armslog: ping:ok / ping:429-reanchor / ping:429-unknown-anchor / ping:429-cap /
  ping:infra / ping:infra-fallback / ping:manual.
- notify (pi-remote): re-anchor (info), 429-cap, infra-fallback.
- EventBus: `billing:ping` {status, latencyMs, usage?} — для внешних подписчиков.

## 9. Схема state (аддитивная, толерантная)

```ts
// state.ts
import type { PingState } from "./ping.js";   // type-only, без runtime-цикла
type State = { ...; ping?: PingState };

// ping.ts
type PingState = {
  disabled?: boolean;        // /billing-ping off
  mode?: "json" | "sse";     // рабочий режим (D-003)
  model?: string;            // рабочая модель (если фолбэк)
  lastAt?: number;           // последний пинг (auto или manual)
  lastStatus?: "ok" | "429" | "infra";
  lastBoundary?: number;     // маркер границы авто-пинга (dedup, D-007)
  lastDetail?: string;       // latency/error
  infraStreak?: number;      // FR-017-5
  infraNotified?: boolean;
  retryAttempt?: number;     // FR-017-4 unknown-anchor
};
```

## 10. Проверки (verification strategy)

Юнит-сьют `tests/ping.test.mts` (паттерн существующих сьютов: переопределение
путей state/wake/history/armslog, инъекция fetch/notify):

1. `loadPingConfig` — ok/нет файлов/битый JSON/нет полей → null.
2. `sendPing` — 200+usage (legacy и новый формат), 429, фолбэк-модель на 400,
   sse-фолбэк, сеть/таймаут → infra; 429 не ретраится.
3. Флоу ok → reset выполнен, firstCallEmittedAt=sentAt, таблица от sentAt.
4. Флоу 429 c поздним fc → re-anchor + rebuild; без fc → retry-точка +10 мин;
   12 попыток → cap + notify, точек больше нет.
5. Флоу infra ×2 → retry-точки, ×3 → слепой reset + notify once; burned
   (blindOnInfra=false) → слепого reset нет.
6. Dedup: записанный ok → checkAndReset без пинга; записанный 429 после
   чужого re-anchor → no-op.
7. disabled → fetch не вызывается, checkAndReset вызывается (legacy).
8. manualPing → ничего не пишет в lastBoundary/last429At.
9. `insertRetryPoint` — epsilon, сортировка.
10. Exit hygiene: таймаут-таймер unref (hasRef-проба, паттерн spec 003).

Регресс: все существующие сьюты зелёные (`npx tsc`, tsx-сьюты, python-тесты);
поведение ping-off = бит-в-бит старое.

## 11. Риски/FAQ реализации

- **Q: почему checkAndReset внутри ping.ts?** Единая точка «исход → действие»,
  идемпотентность, тестируемость без таймеров index.ts.
- **Q: пинг в полёте, процесс умер?** Соседний процесс на той же границе не
  видит результата → пингует сам (авто-failover, лучше firelease-TTL).
- **Q: два пинга в race-окне?** Допустимо (D-007), 0.12 кр вместо 0.06.
- **Q: sse-usage?** Unknown — стоимость видна в history только для json-режима;
  некритично (NFR-017-1).
- **Q: reasoning-модели?** max_tokens=2 капитит completion; скрытые токены
  ограничены; контроль по usage в history.
