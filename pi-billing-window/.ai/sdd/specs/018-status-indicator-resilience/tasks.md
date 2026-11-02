# Tasks: Spec 018 — status-indicator-resilience

> Status: tasks:approved
> Design: design.md; Requirements: FR-018-1..6 (направление утверждено пользователем в чате, детализация — оркестратор)

## Readiness check

- Все Must Have FR покрыты задачами: FR-018-1 (T2), FR-018-2 (T1),
  FR-018-3 (T2), FR-018-4 (T3), FR-018-5 (T2/T3), FR-018-6 (T2, Should).
- Открытых Questions нет (Q-1..Q-4 answered в requirements.md).
- Верификация: `cd c:/Tools/pi-billing-window && npx tsx tests/test.mts`,
  полный прогон сьютов, live-RPC проба оркестратора.

## T1 — src/uidiag.ts: JSON-lines диагностика (FR-018-2, NFR-018-1/2/3)

- deps: —; priority: Must; estimate: 1h
- [ ] `uidiag(reason, detail?)`: JSON-строка {ts, pid, reason, detail
      (≤200 симв.)}; appendFileSync; эпизодный rate-limit (lastReason);
      кап >400 строк → последние 200; всё тело в try/catch (молча).
- [ ] `setUidiagPathForTests()` / `resetUidiagPathForTests()`
      (паттерн state.ts setPaths).
- [ ] тесты (design §6, №1–4): JSON-строка с полями; эпизодный rate-limit
      (2 подряд → 1 строка, смена reason → новая, возврат reason → новая);
      кап 401 → 200; fs-ошибка глотается.
- files: `src/uidiag.ts`, `tests/test.mts`
- verify: `npx tsx tests/test.mts` — секция uidiag зелёная
- acceptance: отказы обновления виджета оставляют rate-limited след;
  uidiag никогда не бросает; файл кэпится

## T2 — ui.ts: StatusOutcome, небросающий forceUpdate, refreshStatusContext, failStreak (FR-018-1, 3, 5a, 6)

- deps: T1; priority: Must; estimate: 1.5h
- [ ] `applyStatus` → `StatusOutcome` (коды по design §3.1; bail:provider
      → "cleared"; исключение пропагируется наружу).
- [ ] `applyStatusSafe(ctx, key, reason, provider?)` — единая точка
      try/catch + `uidiag("${reason}:error", msg)`.
- [ ] `forceUpdate` небросающий (делегирует applyStatusSafe, reason
      "force"; сигнатуры позиционных аргументов не меняются).
- [ ] `refreshStatusContext(ctx, provider?)` (design §3.3): живой tui-ctx
      отличный от currentCtx → подмена + немедленный apply; тот же →
      idempotent apply; stale → `refresh:stale-ctx`; non-tui → тихо.
- [ ] тик апдейтера: `applyStatusSafe(..., "tick")` + `tickFailStreak`
      (первый фейл эпизода → `uidiag("tick:error")`, успех → сброс;
      интервал продолжает тикать; `getTickFailStreakForTests()`).
- [ ] тесты (design §6, №5–10): коды исходов applyStatus; forceUpdate не
      бросает на бросающем ctx + след "force:error"; подмена stale-ctx и
      оживление тика (инцидент-репродукция); stale/non-tui тихо; идемпотент;
      unref-регресс.
- files: `src/ui.ts`, `tests/test.mts`
- verify: `npx tsx tests/test.mts` — секции T1+T2 зелёные
- acceptance: замёрзший апдейтер оживает от refreshStatusContext; тик
      не умирает молча навсегда; forceUpdate не бросает

## T3 — index.ts: точки самопочинки + диагностика тихих путей (FR-018-4, 5b–d)

- deps: T2; priority: Must; estimate: 1h
- [ ] `onAfterProviderResponse` ~2872: `if (ctx.mode === "tui")
      forceUpdateStatus(ctx);` → `refreshStatusContext(ctx);`
      (checkAndReset в хвосте больше не зависит от косметики).
- [ ] `onModelSelect` ~2890: `forceUpdateStatus(ctx, undefined, provider)` →
      `refreshStatusContext(ctx, event?.model?.provider)`.
- [ ] `onSessionStart` ~2563: `refreshStatusContext(ctx);` сразу после
      `stopStatusFn = startStatusUpdater(ctx);` (замена соседнего
      forceUpdateStatus(ctx)).
- [ ] `isTuiOrDiag(ctx, reason)` (design §4.4); в `handleWindowReset`
      (~2185): `ctxIsTui` → `isTuiOrDiag(ctx, "window-reset")`; в
      `refreshMarker` (~993): → `isTuiOrDiag(ctx, "marker")` + удалить
      мёртвый catch.
- [ ] импорт uidiag; VERSION bump.
- [ ] регресс: lifecycle/replacement/session-isolation сьюты без изменений
      поведения (замена добавляет только диагностику на бросающем пути).
- files: `src/index.ts`
- verify: `npx tsx tests/test.mts` (полный), `npx tsc -p tsconfig.json`,
  сьюты lifecycle/replacement/session-isolation зелёные
- acceptance: событие ответа LLM/смены модели/session_start чинит привязку
  апдейтера; stale-ранние-return'ы оставляют след; хвост
  after_provider_response неуязвим

## T4 — доки (наблюдаемость для пользователя)

- deps: T3; priority: Should; estimate: 0.5h
- [ ] README: раздел «Диагностика» — uidiag-файл (путь, формат, rate-limit,
      кап) и семантика оживления виджета.
- [ ] `.ai/sdd/INDEX.md` строка 018 (выполняется вместе с задачей, если
      ещё не обновлён).
- files: `README.md`
- verify: ручная вычитка
- acceptance: пользователь может сам прочитать uidiag-лог после инцидента

## T5 — полная верификация (инцидент-репродукция)

- deps: T1–T4; priority: Must; estimate: 1h
- [ ] `cd c:/Tools/pi-billing-window && npx tsx tests/test.mts` — все
      секции (включая spec 018 №1–10) зелёные.
- [ ] `npx tsc -p tsconfig.json`; все остальные tsx-сьюты
      (lifecycle, replacement, session-isolation, ping и др.);
      `python tests/billing_report_test.py`.
- [ ] Live-RPC проба оркестратора: свежий RPC-процесс, setStatus
      «[обновится в HH:MM]» — путь жив.
- [ ] Двух-оконная репродукция инцидента (оркестратор): два TUI-окна,
      `/settimer 10`, дождаться reset, сверить оба футера (без перезапуска
      окон) + прочитать `~/.pi/agent/pi-billing-window-uidiag.log`.
- [ ] отчёт: команды, exit code, вердикт по каждой.
- acceptance: индикаторы обоих окон показывают новую границу после reset
  без перезапуска; лог идентифицирует путь отказа (если был); все сьюты
  зелёные; host-процесс не падал
