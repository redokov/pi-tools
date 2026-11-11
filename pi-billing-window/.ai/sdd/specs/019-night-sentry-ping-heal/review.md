# Spec 019 — review

## Дата / вердикт

- 2026-11-11. **Merge readiness: GO** (деплой в рабочую копию уже выполнен
  вместе с исполнением — расширение пользовательское, не библиотека).

## Coverage (requirements → реализация → evidence)

| Req | Реализация | Evidence |
|---|---|---|
| FR-019-1 дозор «ночь без страховки» | `src/nightsentry.ts` (checkNoArmGap, dedupPassed, SENTRY_DEDUP_MS=1ч); `src/index.ts` nightSentryTick — крючки в 429-ветке и ветке успеха onAfterProviderResponse; отметка `state.sentry.lastNoArmNotifyAt`; notify `billing:night-no-arm` | nightsentry.test.mts 64/64 (интервалы/предикаты/дедуп); интеграционный крючок — код-ревью (e2e ночи не воспроизводим в CI) |
| FR-019-2 arm-gone в зоне ночи | `checkArmGoneNightGap` (NIGHT_ARM_GONE_REASONS, grace 2 ч); self-ветка arm-gone (ранее полностью тихая — именно она молчала в 19:10 инцидента) → отдельный notify; external-ветка → дополнение к bodyText без второго тоста | nightsentry.test.mts: 6 кейсов предиката (incl. ручной `off` исключён, граница grace) |
| FR-019-3 самовосстановление пинга | `ping.ts` sendPing шаг 2: цепочка `primary → PING_FALLBACK_MODEL → pickFallbackModels(readProviderPingModels(), …)` БЕЗ условия `mode0===undefined && primary===PING_MODEL`; успех закрепляется recordAutoResult в `state.ping.model` | ping-selfheal.test.mts 26/26: 404 на закэшированной мёртвой модели → ok на самой дешёвой живой; закрепление в state; пустой список провайдера → infra |
| FR-019-4 эскалация серии | `maybeEscalateInfraStreak`: streak ≥ 10 + дедуп 6 ч (`sentry.lastInfraNotifyAt`), notify `billing:ping-infra-streak`; ok/429 обнуляют отметку | ping-selfheal: порог 9/10, дедуп внутри 6 ч, повтор после 6 ч |
| FR-019-5 /night-check | `buildNightCheckReport` (чистый рендер, вердикты no-arm/window-low/ping-dead/plan-expired-file); registerNightCheck — только чтение | nightsentry.test.mts: сводка при всех разрывах, реплика инцидента (4 разрыва сразу), минимальный вход |
| FR-019-6 уборка протухшего плана | `nightplan.ts` readActivePlan: истёкший → null + clearPlan + armslog `night-plan:expired-cleanup`; nightPlanTick переведён на readActivePlan | nightplan-active.test.mts 12/12 (новый сьют): активный/истёкший/повторное чтение/пометка одна/boundary |

## Verification evidence

- Полный прогон: **27/27 сьютов exit 0** (run_all_suites.sh, 2026-11-11),
  включая регрессионные ping 66/66, nightplan 100/100, nightplan.e2e 76/76,
  watchdog, firelease, lifecycle.
- `npx tsc -p tsconfig.json`: новые/изменённые модули — 0 ошибок
  (25 ошибок в index.ts — ранее существующие: отсутствие пакета
  `@earendil-works/pi-coding-agent` в дев-копии даёт implicit-any у ВСЕХ
  обработчиков команд, включая прежние).
- Деплой: рабочая копия `~/.pi/agent/extensions/pi-billing-window/` содержит
  `nightsentry.ts`, VERSION = 019.2026-11-11.

## Findings (исправлены в ходе ревью)

1. **Пробел тест-покрытия FR-019-6:** readActivePlan не имел прямых тестов
   при implementation:done. Добавлен сьют `nightplan-active.test.mts`
   (12 кейсов), включая проверку, что уборка НЕ пишет в боевой armslog
   (перенаправление setArmsLogPath в тестах).
2. **Потеря sentry при reset:** checkAndReset пересобирает State явно —
   без `sentry: state.sentry` отметки дедупа терялись бы на каждом сбросе
   окна (найдено тестом закрепления, исправлено в reset.ts, регрессия
   покрыта ping-selfheal «sentry.lastInfraNotifyAt обнулён»).

## Ограничения / что не покрыто автоматикой

- Дозор и ночная добавка arm-gone проверены на уровне чистых предикатов;
  полный e2e «ночь + 429 + отсутствие взвода → тост» требует живой ночной
  сессии — остаётся ручной проверке ближайшей ночи (см. план пользователя:
  `/night-check` перед стартом).
- Самовосстановление модели пинга сработает в живой сессии на первом
  wake-пинге: проверить утром по `state.ping.lastDetail`
  (ожидается `…ms zai/glm-5.3:NVFP4 json`).

## Housekeeping

- INDEX.md: строка 019 = implementation:done → review:done.
- Документация: README §8i, таблица команд, docs/COMMANDS.md §8.
- Коммиты: 815c6f6 (код+тесты), e25663b (документация), ревью-коммит.
