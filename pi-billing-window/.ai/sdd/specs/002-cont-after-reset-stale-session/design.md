# Design: Стойкость cont-after-reset к stale-сессии после замены сессии (002-cont-after-reset-stale-session)

> Status: Draft
> Source: requirements.md (Draft; создание дизайна — по явному указанию владельца, гейт `requirements:approved` ещё не пройден)
> Scope: `pi-billing-window` (репо pi-tools, каталог `c:/Tools/Pi-billing-window`)

## 1. Context и проверенные факты

Все номера строк проверены по текущему `master` (первая ревизия с watchdog-моделью, `ae84182`).

- **`src/index.ts:1425-1426`** — фабрика захватывает `eventBus = pi.events; piApi = pi; piApiEpoch = sessionEpoch`.
  Комментарий утверждает «фабрика перевызывается на сессию», но инцидент показал: при replacement фабрика
  НЕ перевыполняется, `onSessionStart` (`src/index.ts:795-878`) не освежает ни `piApi`, ни `eventBus`, ни
  `piApiEpoch` → весь process продолжает таскать ссылки на мёртвую сессию → `sendUserMessage` всегда
  «extension ctx is stale».
- **`src/index.ts:473-478`** — `syncWatchdog()`: если `st.lastResetAt > arm.lastResetAtAtArm`, то
  `fireAt = min(fireAt, lastResetAt + resetGraceMs)` → при прошедшем grace `fireAt` в прошлом → немедленный
  fire на КАЖДОМ тике синк-поллера (60 с). `fireContinue` на stale-ошибке не вызывает `armsMarkFired`
  (фаза остаётся `armed`) → «fire:reset-ready» каждые 60 с (шум + повторы отправки каждые `staleRetryMs`).
- **`src/arms.ts:162-165` `switchKey`** — только `currentKey = newKey`, запись не двигается.
  **`src/index.ts:857-863`** — в `onSessionStart` `carryArmTo(key)` вызывается ТОЛЬКО при `reason==="new"`;
  заменa/fork идут в `switchKey` → флаг не переусыновляется в новую сессию.
  **`src/arms.ts:196-217` `carryArmTo`** — двигает запись `oldKey→newKey` под локом, правит `currentKey`.
- **`src/index.ts:201-213`** — `staleRetryMs`-пацинг; **`src/index.ts:556-618` `fireContinue`** —
  блок `staleRetryNotBefore` (557), guard `block:no-pi` (574), успех: `armsMarkFired()` + `fire:send-ok` (594-596),
  stale: `staleRetryNotBefore = now + staleRetryMs` (607) + `send-error:stale` (608-612) и ранний `return` —
  БЕЗ счётчика попыток и БЕЗ капитуляции.
- **`src/armslog.ts`** — append-only лог `~/.pi/agent/pi-billing-window-arms.log`, `ISO | event | detail`,
  никогда не бросает. Существующие события (grep): `session-start`, `arm-gone`, `block:no-pi`,
  `fire:reset-ready`, `fire:send-ok`, `fire:confirmed`, `send-error:stale`, `send-error`,
  `watchdog:reset-error`, `arm-seen`.
- **`src/notifier.ts`** — `sendNotify(payload, opts)` → POST на pi-remote, header `X-Notify-Token`
  (env `PI_REMOTE_NOTIFY_TOKEN`), fire-and-forget, никогда не бросает. `NotifyPayload.type` сейчас
  единственный литерал `"billing:window_reset"`.
- **`src/state.ts`** — `{ windowStartedAt, lastResetAt, resetCount, ... }`; полей для дедупа нет.
- **Тесты**: `tests/arms.test.mts` (юнит arms.ts, хуки `setPaths`), `tests/watchdog.test.mts` (юнит таймера),
  `tests/watchdog.e2e.test.mts` (годит РЕАЛЬНУЮ фабрику через мок `ExtensionAPI`; хуки
  `__syncWatchdogForTests`/`__fireWatchdogForTests`/`__retryTickForTests`/`setStaleRetryMsForTests`/
  `setResetGraceMsForTests`), `tests/lifecycle.test.mts`, `tests/test.mts`. `notifier` использует глобальный
  `fetch` → перехватываем `globalThis.fetch` в тестах.
- **`deploy.ps1`** копирует `index.ts, state.ts, ticker.ts, ui.ts, parser.ts, notifier.ts, history.ts,
  arms.ts, armslog.ts, watchdog.ts, package.json` + README + tsconfig — все файлы, которые правит эта
  спека, уже в списке, правок deploy.ps1 НЕ требуется.
- **git log** (Conventional Commits): `9509c744 fix(cont-after-reset): не убивать poller после stale-ошибки…`,
  `c8851ba fix(pi-billing-window): stale ctx после замены сессии — epoch-guard…`, `5ffd86e feat(pi-billing-window): model column…`.

## 2. Решения (Decisions)

### D-201 — Освежение сессионных ссылок в onSessionStart + строгий epoch-guard
**Decision:** `onSessionStart` ПЕРЕД остальной инициализацией пытается переснять `piApi`/`eventBus` из
свежего контекста сессии (точный аксессор сверить в задаче T02: `event`/`ctx` может нести ссылку на
текущий `pi`/bus; если нет — решаем B-путь D-202). При успехе: `piApiEpoch = sessionEpoch`, `armsLog("replacement:adopted")`.
Каждый потребитель `piApi`/`eventBus` (fireContinue, notify, emit) проверяет `piApiEpoch === sessionEpoch`
и при рассинхроне логирует `replacement:waiting` и НЕ трогает устаревшие ссылки.
**Alternatives:** вообще не слать из старой эпохи и ждать новый factory-run — отвергнуто: при инциденте
factory-run не случился за 50 мин → флаг сгорает молча (условие сдачи FR-001 нарушено).
**Impacts:** FR-001, FR-005.

### D-202 — Перенос/переусыновление arm при replacement/fork (расширение carry)
**Decision:** маппинг reason в `onSessionStart` расширяется: `"new"` → `carryArmTo(key)` (как сейчас),
`"replacement"` → `carryArmTo(key)` если ключ изменился / иначе repoint (replacement одной беседе — запись
на месте, нужен только D-201 для отправки), `"fork"` → `carryArmTo(key)` (перенос в fork-беседу, ключ новый),
`"resume"/"reload"/"startup"` → `switchKey(key)` (repoint, как сейчас). Для «replacement с тем же ключом»
`carryArmTo` по факту no-op на диске — главный фикс отправки — D-201; D-202 страхует fork и смену ключа.
**Alternatives:** один `carryArmTo` на ВСЕ причины — отвергнуто: `resume`/`reload` к чужой беседе не должен
двигать arm владельца-беседы (существующая семантика «arm остаётся с беседой, что его создала»).
**Impacts:** FR-001, FR-003, FR-007.

### D-203 — Fire идемпотентен per reset: модульный `lastFiredResetAt`
**Decision:** модульная переменная `lastFiredResetAt: number | null` в `src/index.ts`. В `syncWatchdog`
шорткат «reset уже случился → немедленный fire» применяется только если `st.lastResetAt !== lastFiredResetAt`
(новый сброс); после планирования fire для `R` ставим `lastFiredResetAt = R`. При новом сбросе `R' > R`
дедуп не мешает (сравнение по значению). Сброс маркера на confirmSuccess/re-arm. Диск не трогаем.
**Alternatives:** поле `lastFiredResetAt` в `state.json`/`arms.json` — отвергнуто: нарушает non-goal
«формат файлов не менять без миграции»; модульная память достаточно (цикл 60 с — внутри процесса).
**Impacts:** FR-002, FR-003, NFR-002, NFR-003.

### D-204 — Ограниченный stale-retry: backoff + N=6 + капитуляция
**Decision:** счётчик `staleAttempts` (модульный, сброс: успешная отправка / переусыновление / новый
сброс). В stale-ветке `fireContinue`: `staleAttempts++; backoff(staleAttempts) = MIN(RETRY_AFTER_FIRE_MS * 2^(staleAttempts-1), CAP)`
(CAP = 60 мин); `staleRetryNotBefore = now + backoff`; `armsLog("send-error:stale", "… попытка N/6")`.
При `staleAttempts >= 6` → капитуляция: `disarm` текущего ключа + `sendNotify` (D-205) +
`armsLog("capitulation:after-6")`; таймеры/поллер продолжают жить, флаг снят.
**Alternatives:** сдаться сразу на первом stale — отвергнуто: замена сессии может уже идти, 1-2 попытки
могут пройти; N=6 даёт окно для ре-усыновления, но конечное.
**Impacts:** FR-003, FR-004, NFR-001.

### D-205 — Notify при капитуляции через существующий notifier.ts
**Decision:** расширить `NotifyPayload.type` до юниона: `"billing:window_reset" | "billing:cont-after-reset-capitulation"`.
При капитуляции `sendNotify({ type: "billing:cont-after-reset-capitulation", provider, title, body,
  timestamp })`; token/url/timeout-механика не меняется. Тест перехватывает `globalThis.fetch`.
**Alternatives:** новый модуль/канал — отвергнуто (NFR-003/004, duplicт механизма).
**Impacts:** FR-004, NFR-003, NFR-004.

### D-206 — Диагностика: различимые события
**Decision:** новые события armslog: `replacement:waiting` (замена сессии, ссылки ещё не свежие),
`replacement:adopted` (onSessionStart переснял ссылки), `capitulation:after-N` (капитуляция). Формат
строк и ротация не меняются. Существующие события не переименовываются.
**Impacts:** FR-005.

## 3. Requirements Mapping

| Requirement | Покрытие |
|---|---|
| FR-001 (replacement не теряет флаг) | §4.1, §4.2, D-201, D-202 |
| FR-002 (fire 1× на сброс) | §4.1 (syncWatchdog/fireContinue), D-203 |
| FR-003 (bounded stale-retry N=6) | §4.1 (fireContinue), D-204 |
| FR-004 (notify при капитуляции) | §4.3 (notifier), D-205 |
| FR-005 (armslog диаг.) | §4.1 (armsLog), D-206 |
| FR-006 (5 инвариантов тестами) | §5 |
| FR-007 (регресс) | §5.5 (полный прогон), §6 |
| FR-008 (документация) | §7 |
| NFR-001..004 | D-204 (не молчать), D-203 (O(1)), D-004/D-203 (без миграции), D-205 (без секретов) |

## 4. Точные изменения

### 4.1 `src/index.ts`

**a. Освежение ссылок в `onSessionStart` (начало обработчика, до `currentCtx = ctx`):**
```ts
// Если session_start несёт текущую API/bus-ссылку — переснять пиApi/eventBus.
const fresh = sessionBusOf(event, ctx);            // см. Implementation FAQ F-1: точный аксессор
if (fresh) {
  eventBus = fresh.bus;
  piApi = fresh.api;
  piApiEpoch = sessionEpoch;
  armsLog("replacement:adopted", "ссылки пересняты в session_start");
} else {
  armsLog("replacement:waiting", "ссылки не пересняты — ждём/капитулируем через stale-retry");
}
```

**b. Расширение маппинга reason (блок ~857-863):**
```ts
const reason = (event as { reason?: string } | null)?.reason;
if (reason === "new" || reason === "fork" || reason === "replacement") {
  await armsCarryArmTo(key);   // fork/replacement: перенос или no-op при той же беседе
} else {
  armsSwitchKey(key);          // resume/reload/startup: repoint (как сейчас)
}
```

**c. Эпоха-гард в `fireContinue` (перед `sendUserMessage`, ~556-618):**
```ts
if (piApiEpoch !== sessionEpoch) {
  armsLog("replacement:waiting", "ссылки из прошлой эпохи — не шлю, жду переусыновления");
  return;
}
```

**d. Счётчик попыток + дедуп + капитуляция:**
```ts
let lastFiredResetAt: number | null = null;   // D-203 (модуль, диск не трогаем)
let staleAttempts = 0;                        // D-204
const STALE_MAX_ATTEMPTS = 6;
const STALE_BACKOFF_CAP_MS = 60 * 60_000;
// - в syncWatchdog: условие «reset уже случился» → `st.lastResetAt !== lastFiredResetAt`,
//   и после планирования fire: `lastFiredResetAt = st.lastResetAt`;
// - в stale-ветке fireContinue: staleAttempts++, backoff = min(RETRY_AFTER_FIRE_MS * 2^(n-1), CAP),
//   armsLog("send-error:stale", `… попытка ${n}/${STALE_MAX_ATTEMPTS}`),
//   if (staleAttempts >= STALE_MAX_ATTEMPTS) { await armsDisarm(key); void sendCapitulationNotify();
//                                              armsLog("capitulation:after-6", …); return; }
// - сброс staleAttempts: успешная отправка, replacement:adopted, confirmSuccess/новый сброс.
// - успешная отправка остаётся: armsMarkFired() (фаза pending) + fire:send-ok (без изменений).
```

### 4.2 `src/arms.ts`

Правки **не требуются** (D-202 расширяется на стороне вызова в index.ts); `carryArmTo`/`switchKey` — как есть.
Новый чисто локализующий хелпер (опционально, для тестируемости): `export function remapKey(reason: string, key: string): "carry" | "repoint"`,
возвращающий ветку маппинга §4.1b, чтобы тест §5.3 мог его импортировать без реальной сессии. Если хелпер
не выносится — T05/T06 тестируют маппинг на уровне `onSessionStart` (e2e-фабрика).

### 4.3 `src/notifier.ts`

Единственная правка — расширение типа:
```ts
export type NotifyPayload = {
  type: "billing:window_reset" | "billing:cont-after-reset-capitulation";
  provider: string; title: string; body: string; timestamp: number;
};
```
Логика `sendNotify` без изменений.

## 5. Тестовая стратегия

Стиль — plain tsx + assert (по `tests/watchdog.e2e.test.mts` и `tests/arms.test.mts`): свои моки, tmp-каталоги,
`setPaths`, хуки `__syncWatchdogForTests/__fireWatchdogForTests/__retryTickForTests`, никаких реальных минут. Каждая
задача на тест (T01/T03/T05/T07/T09) — RED до реализации. Лаунч-точка каждого файла — `npx tsx tests/<file>.mts`;
`npm test` (Main suite) остаётся зелёным на каждом шаге.

### 5.1 `tests/replacement.test.mts` (новый) — инвариант 1 (FR-001/FR-005)
1. Фабрика с мок-API сессии A; эмит `session_start` `reason="replacement"` (НЕ перезапуская фабрику);
   assert: после обработки `fireContinue` не бросает stale, а шлёт «продолжи» (мок-`sendUserMessage` вызван)
   ИЛИ `piApiEpoch === sessionEpoch` после `replacement:adopted`.
2. Когда переснять ссылки нельзя (мок без bus/API в ctx) → assert armslog содержит `replacement:waiting`,
   `sendUserMessage` старой эпохи НЕ вызван (guard).
3. `capitulation` достижимо только через обратные попытки (покрывается в §5.4, здесь только журнал `waiting`).

### 5.2 `tests/watchdog.e2e.test.mts` (расширить) — инвариант 2 (FR-002)
Сценарий: взвести arm на `lastResetAt=R` в прошлом (grace прошедший) → `__fireWatchdogForTests()` 1 раз
и 3 дополнительных `__syncWatchdogForTests()` → assert «продолжи» отправлен РОВНО 1 раз, `fire:reset-ready`
логируется для `R` один раз; последующие тики не планируют fire для `R`. Потом новый сброс `R'` (мутация
state через `mutateState`) → ещё ровно 1 fire (repeat-семантики).

### 5.3 `tests/arms.test.mts` (расширить) — инвариант 3 (FR-001)
`session_start`-маппинг через `remapKey` (или эквивалент):
- `reason="fork"` → carry: arm переносится из `convA` в fork-ключ, `isArmed(forkKey)` true;
- `reason="replacement"` (тот же ключ) → carry no-op: запись на месте, `isArmed` true;
- `reason="resume"/"reload"/"startup"` → repoint: arm владельца-беседы НЕ двигается (существующий тест).

### 5.4 `tests/stale-capitulation.test.mts` (новый) — инварианты 4 и 5 (FR-003/FR-004/FR-005)
1. Мок `sendUserMessage` всегда кидает “extension ctx is stale”; `staleRetryNotBefore` форсируется в 0;
   гоняем `__retryTickForTests`/`__fireWatchdogForTests` N раз: assert попыток ровно 6;
   интервалы backoff возрастают (перехват `staleRetryNotBefore` после каждой итерации);
2. На 6-й: `disarm` снял флаг (`isArmed` false), armslog `capitulation:after-6`;
3. `globalThis.fetch` подменён ловушкой → assert `sendNotify` вызван с
   `type === "billing:cont-after-reset-capitulation"` и корректными title/body (инвариант 5);
4. Успешный отправка между попытками сбрасывает `staleAttempts` (фаза pending, не капитуляция).

### 5.5 Регресс
Полный набор (см. T12): `tests/test.mts`, `tests/arms.test.mts`, `tests/history.test.mts`,
`tests/lifecycle.test.mts`, `tests/watchdog.test.mts`, `tests/watchdog.e2e.test.mts` (+ два-три новых) и
`npm run build` (tsc). Интеграционная проверка вручную НЕ требуется — всё через unit/e2e моки.

## 6. Edge cases

| Случай | Поведение |
|---|---|
| Replacement без свежей ссылки в ctx | `replacement:waiting`; guard эпохи блокирует отправку; stale-retry дойдёт до капитуляции с notify (не молча) |
| Fork беседы с arm'ом | carryArmTo двигает запись в fork-ключ (D-202); подтверждение «продолжи» снимает её там |
| Два сброса в один тик синк-поллера | дедуп по значению `lastResetAt`: старый `R` не пере-fire'ится, новый `R'` — fire; `checkAndReset` уже дедуплицирует двойные сбросы <10 мин |
| `staleAttempts` при успешной отправке | сброс счётчика → капитуляция не сработает ложно |
| Proz-рестарт | модульные счётчики обнуляются → механизм перевзводится заново (существующая семантика); формат файлов не затронут |
| `notifier` недоступен (no url / timeout) | `sendNotify` не бросает, `{ok:false}`; armslog и disarm уже сделаны — уже не молчание, журнал есть |
| repeat>1: подтверждённая отправка | confirmSuccess перевзводит флаг; `lastFiredResetAt` сброшен, следующий сброс снова даёт 1 fire |
| `piApiEpoch!==sessionEpoch` в момент до `replacement:adopted` | отправка отложена (guard) — «replacement:waiting»; не дублируется и не падает |

## 7. Документация и развёртывание (FR-008)

- `docs/watchdog-redesign.md`: раздел «Поведение при replacement / капитуляция» — обновление контракта
  (guard-ы, дедуп fire, N=6+backoff, notify при капитуляции, события armslog).
- `README.md` §8a: краткие пункты того же; упоминание новых задач-хуков/тестов в §Тесты.
- Развёртывание: `powershell -ExecutionPolicy Bypass -File .\deploy.ps1` (все изменяемые файлы уже в `$files`,
  правки deploy.ps1 НЕ нужны) → перезапуск pi-окон (старый JS в памяти до /reload).

## 8. Риски

| Риск | Вероятность | Митигация |
|---|---|---|
| Свежую ссылку pi/events не удаётся добыть из ctx в onSessionStart | средняя | B-путь D-202 (перенос arm) + C-путь notify+disarm через капитуляцию; контракт «не молчать» держится в любом случае |
| Дедуп fire гасит легитимный переfire (два реальных сброса) | низкая | сравнение по значению `lastResetAt` + `checkAndReset` уже дедуплицирует двойные сбросы; тест §5.2 с `R'` |
| Счётчик попыток протекает между разными беседами | низкая | сброс на переусыновлении/успехе; key-scoping в arms.ts остаётся |
| `notifier` payload type-union ломает существующих потребителей pi-remote | низкая | новый литерал аддитивен; остальные поля не меняются |
| Регресс e2e (hovering timers, epoch) | средняя | полный набор §5.5 обязателен перед деплоем |

## 9. Implementation FAQ

- **F-1: как добыть свежую `pi`/bus-ссылку в onSessionStart?** Проверить в T02: сигнатура события и `ctx`
  (поля типа `ctx.api`, `ctx.events`, либо переданные хэндлеру ссылки). Если никакой — `fresh==null` и остаётся
  B/C-путь (D-201 это допускает).
- **Нужны ли правки в arms.ts?** Нет (§4.2); маппинг reason расширяется на стороне вызова.
- **Почему дедуп в памяти, а не в файле?** D-004/non-goal: без миграции формата; внутри процесса маркер достаточен
  (цикл 60 с — внутри процесса, рестарт перевзводит механизм).
- **Что со старым `staleRetryNotBefore`-пацингом?** Сохраняется, но теперь назад по нему идёт счётчик N и backoff.
- **Менять ли polling?** Нет: sync-poller 60 с, retry/grace-таймеры остаются; добавляется только логика дедупа/счётчика.
- **Бил-линг и reset-механика?** Не трогаем: `checkAndReset`, `ticker.ts`, история — вне scope инвариант 002.
- **Нужна ли миграция arms.json/state.json?** Нет (D-004).
