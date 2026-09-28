# Итоговый отчёт — spec 006 night-resilience (2026-09-28)

## VERDICT ПО ИНВАРИАНТУ

**Подтверждён** при условиях: доставка «продолжи» на границе 2-часового окна
доставляется ВОВРЕМЯ (A3/B1: граница → доставка = ровно 60.0с = resetGraceMs;
B2: доставка после session-start(reload)), работа возобновляется (RESUMED в
heartbeat-агенте), флаг сгорает чисто (fire:confirmed), дедуп держится (1
фактическая доставка на сброс), несколько окон подряд (night-mini: 2 сброса
подряд по одному send-ok, тишина 19 мин 48 с). Дефект stale-ctx (C1: доставка
опаздывала на ~40 мин) устранён связкой D-601 probe + D-603 форс-перерис +
D-608 guard + D-604 firelease.

Ограничение (дизайн (d)): процесс с мёртвым pi НЕ может доставить до появления
свежих ссылок — 006 гарантирует диагностику (ctx=stale src=probe|drain) и
доставку на первом тике после появления свежих ссылок.

## Матрица сценариев (все после деплоя 83b4a15 / a867fa1, live, glm-5.3-flash)

| Сценарий | Вердикт | Доказательство (armslog, время+событие) |
|---|---|---|
| A3 внешний взвод + доставка | **PASS** | 09:03:08 arm-seen (52с) → 09:03:09 fire:send-ok → 09:03:16 fire:confirmed → RESUMED 09:03:16; негативов 0 (scenario-A3.md) |
| A4 истёкший TTL | **PASS** | 09:33:18 expiresAt rewrite → 09:34:13 arm-gone; после settimer 0 fire НЕТ; негативов 0 (scenario-A4.md) |
| B1 /settimer → watchdog-fire → grace → доставка | **PASS** | 10:06:41 arm-seen → граница 10:17:52.370 → 10:18:23 fire:reset-ready → 10:18:52 fire:send-ok → 10:19:00 confirmed; граница→доставка ровно 60.0с (scenario-B1.md) |
| B2 reload до границы + дедуп | **PASS** | 10:53 session-start(reason=reload) → 10:55:26 send-error:stale (1-я попытка) → release → re-fire → send-ok → 10:56:26 confirmed; 1 доставка на сброс (scenario-B2.md) |
| night-mini-2 (2 сброса подряд) | **PASS** | 10:57:54 arm-seen repeat=3 → send-ok 10:58:56 → send-ok 11:18:44 → arm-gone 11:25:59 (disarm); тишина 19 мин 48с; no false confirm (scenario-night-mini-2.md) |
| T-12 E1 (субагент инвалидирует ctx?) | **NO** | 12:29:23 owner-shift(blocked) child-start (тот же pid) → нет родительского session-start в периоде → 12:33:38 fire чистый → confirmed; гипотеза опровергнута (006-e1-report.md) |
| Stage Z (финальная ночь) | ⏳ идёт | запущен 12:34:58Z, repeat=20, граница ≈14:32Z, 14h, монитор stage-z-status.log; PASS-критерии в stage-z-launch.py |

## Судьба каждого бага (C1-аддендум 27–28.09)

1. **stale-цепочка 1/6→4/6, доставка не подтверждена** (граница 21:35Z) —
   устранён: D-601 probe (детект мёртвых ссылок) + D-603 форс-перерис
   (T-08/T-09, коммит 83b4a15: сброс backoff + `runGuarded(fireContinue)` на
   adopted и на переходе probe stale→live). Live: B2 — восстановление после
   stale-провала за ~1с; A3/B1 — доставка вовремя.
2. **Таймеры убиты чужим session_shutdown субагента** — устранён: D-608 guard
   (T-06/T-07, ba8e2cf) + ownerKey-изоляция; live: E1 NO — ctx родителя
   пережил дочернюю сессию, owner-shift(blocked) залогирован.
3. **Флаг молча истёк по TTL** — устранён: notification-путь капитуляции
   (D-205) + firelease release-точки; live: A4 — arm-gone детектируется
   корректно, no silent TTL-expiry в ночных прогонах (night-mini: нет false
   confirm, arm-gone только от disarm).
4. **Внешний night_watchdog: fired=0 (too-early)** — вне скоупа 006 (внешний
   монитор), зафиксировано в C1-аддендуме; FORMAT.md (T-10, a5a559b) даёт
   монитору грамматику токенов/маркеров.
5. **НОВАЯ находка (B2): первая отправка после `/pbr-reload` → stale ctx**
   (`ctx=stale src=drain epoch-mismatch=1`), восстановление ~1с. Класс C1
   (reload-путь). Кандидат на отдельную задачу; инвариант доставки не нарушен.

## E1 → FR-402

E1 вердикт **NO** → полная изоляция по ключу (FR-402) остаётся кандидатом /
закрывается (guard D-608 достаточен). Результат в 006-e1-report.md.

## Регресс

- T-13 (83b4a15): 14 сьютов, 577 asserts, 0 FAIL, build чистый
  (reports/t13-regression-2026-09-28.md).
- После добавления `/pbr-reload` (a867fa1): build чистый, сьюты зелёные;
  финальный прогон — см. /tmp/regress-final.log (результат дублируется утром
  в этот отчёт).
- exit-hygiene: 17/17 (SUTES-лист проверяет process.exit у всех сьютов).

## Статус деплоя

- Пуш: 7828e98..a867fa1 → origin/master (вкл. T-08/T-09/T-11/T-13, драйверы,
  отчёты A3/A4/B1/B2/night/E1, /pbr-reload).
- Деплой: deploy.ps1 (firelease.ts в $files — T-11); md5-диф всех 11 src/*.ts +
  package.json/README/tsconfig ↔ ~/.pi/agent/extensions/pi-billing-window/ —
  идентичны (дважды: после 83b4a15 и после a867fa1).

## Остаток (утро)

- Stage Z: morning-проверка PASS-критериев по stage-z-status.log /
  STAGE-Z-heartbeat.txt / armslog (fire:confirmed на каждой границе, heartbeat
  растёт, окна ×2+, доставка ≤1 backoff-шага после сброса) → дописать сюда.
- Финальный прогон регресса (если /tmp/regress-final.log ещё не завершён).
