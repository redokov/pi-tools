# Design: Spec 018 — status-indicator-resilience

> Status: design:approved
> Requirements: requirements.md (FR-018-1..6, D-001..D-006; направление утверждено пользователем в чате, детализация — оркестратор)

## 1. Карта требований → дизайн

| FR | Решение |
|---|---|
| FR-018-1 | `StatusOutcome`-тип + коды возврата applyStatus (§3.1) |
| FR-018-2 | новый модуль `src/uidiag.ts`: `uidiag(reason, detail?)` (§2) |
| FR-018-3 | `refreshStatusContext(ctx, provider?)` в ui.ts (§3.3) |
| FR-018-4 | врезки index.ts: after_provider_response / model_select / session_start (§4.1–4.3) |
| FR-018-5 | небросающий `forceUpdate` в ui.ts (§3.2) + `isTuiOrDiag` в index.ts (§4.4–4.5) |
| FR-018-6 | failStreak в тике апдейтера (§3.4) |

## 2. Модуль src/uidiag.ts (новый, ~90 строк)

Отдельный модуль (D-002): тестовая изоляция путей, одна ответственность,
ui.ts не раздувается. Зависимости: только `node:fs`, `node:os`, `node:path`.

```ts
// Экспорты:
export function uidiag(reason: string, detail?: string): void;
export function setUidiagPathForTests(p: string): void;
export function resetUidiagPathForTests(): void;
```

- **Путь по умолчанию:** `~/.pi/agent/pi-billing-window-uidiag.log`
  (homedir + константа, паттерн state.ts/history.ts setPaths).
- **Строка:** `{"ts":"<ISO8601>","pid":<process.pid>,"reason":...,"detail":...}`
  — detail обрезается до 200 символов; строка ≤ ~200 байт.
- **Rate-limit (D-003):** module-level `let lastReason: string | null`;
  `reason === lastReason` → no-op; иначе append + `lastReason := reason`.
  Эпизод = подряд идущие одинаковые reason в жизни процесса.
- **Кап (>400 → 200):** на каждой записи `readFileSync` → split lines →
  `if (lines > 400) writeFileSync(lines.slice(-200).join("\n"))` → append
  новой строки. Записи редки (только отказы), файл мал — синхронно и дёшево
  (NFR-018-3). Файл не существует → appendFileSync создаёт.
- **Пассивность:** всё тело uidiag в try/catch → любой fs-вылет молча
  проглатывается (NFR-018-1).
- **Два окна:** appendFileSync одной короткой строки атомарен на уровне ОС
  для практических целей; pid различает процессы; race-loss приемлем
  (best-effort). Никаких lock-файлов — это НЕ state.

## 3. Изменения src/ui.ts

### 3.1 applyStatus → StatusOutcome (FR-018-1)

Сигнатура меняется с `void` на код (тело — те же ветки, каждая получает
явный return; логика/порядок веток НЕ меняются):

```ts
export type StatusOutcome =
  | "ok" | "cleared"
  | "bail:no-ctx" | "bail:no-ui" | "bail:provider" | "bail:no-state"
  | "error";

function applyStatus(ctx: any, key: string, provider?: string): StatusOutcome
```

Маппинг текущих веток (ui.ts ~69-97):
- `!ctx || !ctx.ui || typeof setStatus !== "function"` → `bail:no-ctx`
  (ctx=null) / `bail:no-ui`;
- `effectiveProvider !== "wormsoft"` → `cleared` (снятие строки —
  запланированный исход; бывший тихий return);

  > Примечание: provider-ветка возвращает "cleared", а не отдельный bail —
  > снятие строки ЕСТЬ успешное применение правила видимости; для
  > различения в тестах достаточно provider в ctx мока. БЕЗ лога (D-006).
- `resetAt === null` → `bail:no-state` (строка не трогается — окно ещё
  не создано, переходное; БЕЗ лога, D-006);
- текст установлен → `"ok"`.
- Любое исключение при доступе к ctx (`ctx.ui`, `ctx.model`, `setStatus`)
  → ПРОПАГИРУЕТСЯ наружу (не глотается) — «error» присваивает обёртка §3.2,
  которая одна владеет try/catch и диагностикой (единая точка).

### 3.2 applyStatusSafe + небросающий forceUpdate (FR-018-5a)

Приватный хелпер — единственное место try/catch вокруг applyStatus:

```ts
function applyStatusSafe(
  ctx: any, key: string, reason: string, provider?: string,
): StatusOutcome {
  try {
    return applyStatus(ctx, key, provider);
  } catch (err) {
    uidiag(`${reason}:error`, err instanceof Error ? err.message : String(err));
    return "error";
  }
}
```

`reason` кодирует ПУТЬ (`tick` / `force` / `refresh`) — пост-мортем видит,
кто отказал. Публичный `forceUpdate` делегирует ему и больше не бросает
(D-004 — одна точка защищает все 9 вызовов forceUpdateStatus в index.ts):

```ts
export function forceUpdate(ctx, key = DEFAULT_KEY, provider?): StatusOutcome {
  return applyStatusSafe(ctx, key, "force", provider);
}
```

Сигнатуры позиционных аргументов не меняются — index.ts без правок на
существующих вызовах.

### 3.3 refreshStatusContext (FR-018-3, D-005)

Новый экспорт:

```ts
export function refreshStatusContext(ctx: any, provider?: string): void
```

Алгоритм:
1. `!ctx` → тихий return.
2. `try { isTui = ctx.mode === "tui" } catch` → `uidiag("refresh:stale-ctx")`
   → return (мёртвый ctx — не лечим, ждём следующее событие).
3. `!isTui` → тихий return (non-tui процесс — норма).
4. `ctx !== currentCtx` → `currentCtx := ctx` (currentKey/currentInterval
   не трогаем: интервал жив, тик продолжает работать; БЕЗ остановки
   апдейтера — подмена прозрачна).
5. `applyStatusSafe(ctx, currentKey ?? DEFAULT_KEY, "refresh", provider)` —
   немедленное применение статуса.

Идемпотентность: повторный вызов с тем же ctx → шаг 5 (просто refresh).
Если апдейтер вообще не запускался (currentInterval === null) —
подменяет currentCtx и применяет статус однократно; запуск интервала —
не её зона (startStatusUpdater на session_start).

### 3.4 Тик: failStreak вместо навсегда-молчаливого catch (FR-018-6)

Замена тела setInterval в startStatusUpdater (ui.ts ~168-185):

```ts
currentInterval = setInterval(() => {
  if (!currentCtx || !currentKey) return;      // апдейтер остановлен
  const outcome = applyStatusSafe(currentCtx, currentKey, "tick");
  if (outcome === "error") {
    tickFailStreak++;
    if (tickFailStreak === 1) uidiag("tick:error", `streak start, key=${currentKey}`);
  } else {
    tickFailStreak = 0;
  }
}, intervalMs);
```

- Интервал продолжает тикать ВСЕГДА (D-005): подмена ctx из §3.3 оживляет
  виджет ближайшим тиком автоматически (stale-ctx тик дёшев: бросает
  мгновенно, fs не трогает).
- uidiag вызывается только на первом тике эпизода — «tick:error»; повторы
  подавлены и эпизодным rate-limit (§2), и условием `=== 1`.
- Тест-зонд: `export function getTickFailStreakForTests(): number`
  (сброс в stopStatusUpdater/startStatusUpdater — startStatusUpdater
  обнуляет streak как часть замены апдейтера).

## 4. Изменения src/index.ts

### 4.1 onAfterProviderResponse-хвост (~2872) — FR-018-4a + FR-018-5d

```ts
// БЫЛО:
//   if (ctx.mode === "tui") {
//     forceUpdateStatus(ctx);
//   }
// СТАЛО:
refreshStatusContext(ctx);
```

Обоснование замены (а не добавления рядом): refreshStatusContext при живом
tui-ctx делает ровно то же (applyStatus), при отличном ctx — чинит привязку
(FR-018-3), при stale — не бросает; `ctx.mode === "tui"` на stale ctx
бросал и убивал хвост с `await checkAndReset(emit, meta)` — теперь эта
цепочка неуязвима для косметики (FR-018-5). После замены хвост
`checkAndReset` выполняется безусловно.

### 4.2 onModelSelect (~2890-2902) — FR-018-4b

```ts
// БЫЛО:
//   currentCtx = ctx;
//   forceUpdateStatus(ctx, undefined, event?.model?.provider);
// СТАЛО:
currentCtx = ctx;
refreshStatusContext(ctx, event?.model?.provider);
```

provider передаётся явно (существующая семантика: ctx.model может быть
ещё не обновлён в момент события) — поэтому provider-параметр в
refreshStatusContext (§3.3).

### 4.3 onSessionStart (~2563) — FR-018-4c

```ts
stopStatusFn = startStatusUpdater(ctx);
refreshStatusContext(ctx);   // + немедленное применение после старта
```

startStatusUpdater уже подменяет currentCtx; refreshStatusContext
дублирует привязку безопасно и немедленно применяет статус (замена
ближайшего forceUpdateStatus(ctx) на ~2563 в том же блоке — оставшиеся
два forceUpdateStatus в session_start-блоке на ~2580 касаются
after-reset-состояния, НЕ трогаем).

### 4.4 handleWindowReset (~2185-2206) — FR-018-5b

Замена `ctxIsTui(ctx)` на различающий хелпер:

```ts
function isTuiOrDiag(ctx: ExtensionContext | null, reason: string): boolean {
  if (!ctx) return false;
  try {
    return ctx.mode === "tui";
  } catch {
    uidiag(`${reason}:stale-ctx`);
    return false;
  }
}
```

```ts
// БЫЛО:  if (!ctxIsTui(ctx)) return;
// СТАЛО: if (!isTuiOrDiag(ctx, "window-reset")) return;
```

Non-tui процесс (rpc/print) → false тихо (норма, D-006); stale-ctx →
след `window-reset:stale-ctx` + тихий return (notify с мёртвым ctx
невозможен — диагностика вместо него). Финальный `forceUpdateStatus(ctx)`
уже небросающий (§3.2) — других правок блок не требует.

### 4.5 refreshMarker (~993-999) — FR-018-5c

```ts
// БЫЛО:
//   if (!ctxIsTui(ctx)) return;
//   try { forceUpdateStatus(ctx); } catch {}
// СТАЛО:
if (!isTuiOrDiag(ctx, "marker")) return;
forceUpdateStatus(ctx);
```

catch удалён (forceUpdate не бросает); stale-ctx → `marker:stale-ctx`.

`ctxIsTui` остаётся для остальных мест index.ts, где stale-ctx —
шумная норма (минимальный diff); заменены только два тихих пути,
участвовавших в инциденте.

### 4.6 Импорты и VERSION

- index.ts: `import { uidiag } from "./uidiag.js";` + `refreshStatusContext`
  добавляется к существующему импорту из `./ui.js`.
- ui.ts: `import { uidiag } from "./uidiag.js";` — без цикла (uidiag ни
  от кого не зависит).
- VERSION bump (константа в index.ts, паттерн spec 017 T4).

## 5. Edge cases

- **Два окна пишут один uidiag-файл:** append одной короткой строки
  атомарен на уровне ОС для практических целей; rate-limit — per-process
  (модульный state), два окна с одинаковой причиной пишут по одной строке
  каждый — pid различает. Loss строки в race окне приемлем (best-effort).
- **Кап файла:** проверка на каждой записи (редко) — чтение маленького
  файла; обрезка до последних 200 строк: окно диагностики «последние
  эпизоды» всегда цело, файл не растёт.
- **НЕ блокирующие операции:** uidiag — только appendFileSync/…Sync
  коротких объёмов на редких отказах; никакого await в синхронных путях
  ui.ts (applyStatus остаётся sync); никаких новых таймеров (NFR-018-5).
- **refreshStatusContext при остановленном апдейтере:** подменяет ctx,
  применяет статус однократно, интервал не запускает (зона startStatusUpdater).
- **stopStatusUpdater/startStatusUpdater:** обнуляют tickFailStreak и
  lastReason uidiag НЕ сбрасывают (epizod-стейт живёт с процессом).
- **onSessionShutdown:** без изменений — таймаут-путь spec 002/012 не
  трогаем; подмена ctx от события следующей сессии чинит апдейтер сама.
- **applyStatusSafe при bail:no-state:** не ошибка, счётчик тика не растёт.

## 6. Тест-план (tests/test.mts, стиль assert + mkdtempSync + set*Paths)

Новая секция «=== Spec 018: ui resilience ===» (имена тестов):

1. `uidiag: writes JSON line with ts/pid/reason/detail` — parse строки,
   поля на месте.
2. `uidiag: episode rate-limit` — два подряд `uidiag("tick:error")` → 1
   строка; `uidiag("force:error")` → вторая строка; снова `tick:error` →
   третья (новый эпизод после смены reason).
3. `uidiag: cap >400 lines → last 200` — сеять 401 строку, записать,
   проверить 200.
4. `uidiag: fs failure swallowed` — путь в несуществующий каталог → не
   бросает.
5. `applyStatus: outcome codes` — мок-ctx (mode:"tui", model.provider
   "wormsoft", ui.setStatus спай) + state setPaths(tmpdir):
   ok / cleared(provider≠wormsoft, setStatus(key,undefined) был) /
   bail:no-ui / bail:no-state (state null) / bail:no-ctx.
6. `forceUpdate: never throws on stale ctx` — ctx с геттером ui,
   бросающим Error → возврат "error", uidiag-файл содержит "force:error".
7. `refreshStatusContext: swaps stale updater ctx and revives tick` —
   старт апдейтера с ctx1 (intervalMs минимальный, живой спай), затем
   «умерщвление» ctx1 (геттер ui начинает бросать), ждать тик → streak>0,
   строка "tick:error"; `refreshStatusContext(ctx2)` (живой) → следующий
   тик пишет в спай ctx2, streak 0. Инцидент-репродукция целиком.
8. `refreshStatusContext: stale/non-tui ctx quiet` — бросающий mode-геттер
   → строка "refresh:stale-ctx", не бросает; mode:"rpc" → тишина.
9. `refreshStatusContext: idempotent same-ctx` — двойной вызов →
   setStatus вызывался дважды, currentCtx не менялся (проба через тик).
10. `hasRefForTests` по-прежнему false-совместим (unref сохранён) —
    регресс spec 003.

Регрессия: все существующие сьюты зелёные; lifecycle/replacement/session-
isolation не изменяются поведенчески (замена ctxIsTui→isTuiOrDiag только
добавляет диагностику на бросающем пути). Live-RPC проба оркестратора:
свежий RPC-процесс, setStatus «[обновится в HH:MM]» — подтверждает, что
путь не сломан; двух-оконная репродукция инцидента (два TUI, /settimer 10,
reset, сверка обоих футеров + чтение uidiag.log).

## 7. Риски/FAQ реализации

- **Q: почему rate-limit не TTL-таймер?** Эпизод-дедуп проще, не требует
  таймеров (NFR-018-5) и бьёт главный источник залива — повторяющийся
  тик по мёртвому ctx.
- **Q: почему applyStatus сама не пишет uidiag?** Тогда reason не различал
  бы путь; единая точка try/catch в applyStatusSafe даёт reason
  «путь:причина» (пост-мортем-требование FR-018-2).
- **Q: подмена ctx без остановки интервала — безопасно?** Тик читает
  currentCtx каждый раз; подмена атомарна (sync присваивание); интервал
  и key не меняются — меньше состояний, чем рестарт апдейтера.
- **Q: cleared vs bail:provider?** Снятие строки при чужом провайдере —
  успешное применение правила видимости (by design), не отказ: "cleared".
- **Q: uidiag при отсутствии state-файла?** bail:no-state не логируется
  (переходное нормальное состояние до первого /settimer, D-006).
