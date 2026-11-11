# Report: Spec 019 — исполнение

- **Дата:** 2026-11-11
- **Статус:** implementation:done (деплой выполнен)

## Исполнено (T1–T4)

| Задача | Артефакты | Проверка |
|---|---|---|
| T1 nightsentry.ts | `src/nightsentry.ts`, `tests/nightsentry.test.mts` | 64/64 |
| T2 пинг-самовосстановление | `src/ping.ts` (цепочка фолбэков без зависимости от кэша, `readProviderPingModels`/`pickFallbackModels`, эскалация серии), `src/notifier.ts` (+2 типа), `src/reset.ts` (sentry переживает reset), `src/state.ts` (SentryState) | ping-selfheal 26/26, ping 66/66 (без регрессий) |
| T3 интеграция | `src/index.ts`: nightSentryTick (429-ветка + успех), ночная добавка arm-gone (обе ветки), `/night-check`, nightPlanTick → readActivePlan; `src/nightplan.ts`: readActivePlan + уборка протухшего файла | полный прогон сьютов — все exit 0 (exit-hygiene 18/18) |
| T4 деплой | `deploy.ps1` (+nightsentry.ts), VERSION 019.2026-11-11 | рабочая копия `~/.pi/agent/extensions/pi-billing-window/` содержит nightsentry.ts, версия 019 |

## Ключевые решения при исполнении

- **D-002 уточнён:** фолбэк не запускался не только из-за условия
  `mode0 === undefined && primary === PING_MODEL`, но и потому, что
  `state.ping.model` был закэширован мёртвой моделью. Цепочка теперь:
  primary → PING_FALLBACK_MODEL → 3 самые дешёвые живые модели провайдера;
  успех закрепляется в `state.ping.model` существующим `recordAutoResult`.
- **Sentry переживает reset:** `checkAndReset` пересобирает State явно и
  терял бы `state.sentry` — добавлено сохранение поля (как с `ping`).
- **Эскалация серии (FR-019-4):** отметка `sentry.lastInfraNotifyAt`,
  дедуп 6 ч; успех/429 обнуляют отметку — новая серия начинается с порога 10.

## Операционные следствия (без ручных правок конфигов)

- Мёртвая модель пинга `openai/gpt-oss:20b` self-heal-ится на первый же
  wake-пинг: 404 → цепочка → самая дешёвая живая (сейчас `zai/glm-5.3:NVFP4`).
- Протухший `pi-billing-window-nightplan.json` (с 31.10) убирается первым
  sync-тиком живой сессии (armslog: `night-plan:expired-cleanup`).

## Что осталось пользователю (процедурно)

- Перед ночным прогоном: `/night-check` — сводка и вердикт.
- Страховка ночи: `/night-plan 22:00-08:00 repeat=6` (переживает снятие
  флага агентом) или ручной `/cont-after-reset 6`; дозор теперь предупредит,
  если ночь начнётся без того и без другого.
