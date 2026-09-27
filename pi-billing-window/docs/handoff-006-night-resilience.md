# HANDOFF: pi-billing-window — ночная устойчивость (сессия-продолжение)

> Промт для новой сессии. Скопировать целиком в первое сообщение новой сессии
> в каталоге c:/Tools (или открыть сессию в C:/Tools/pi-billing-window).

---

Режим: Полностью автономно, без вопросов. Ты — оркестратор: работу выполняют
субагенты на моделях провайдера wormsoft (wormsoft/deepseek-ai/deepseek-v4-flash
для механики; следующая ступень family — если флэш не тянет), ты принимаешь
решения, лично верифицируешь ключевое, коммиттишь и пушишь. Планирование задач
веди через скилы sdd (sdd-idea → sdd-prd → sdd-spec → sdd-tasks → sdd-exec):
новые фичи/фиксы оформляй в спеках каталога .ai/sdd/specs/ (следующий номер —
006), каждый шаг — отдельный субагент, каждый гейт проверяешь ты.

## ЦЕЛЬ (инвариант, общий для всего проекта)

Запущенная на ночь задача в pi (провайдер wormsoft), упирающаяся в лимит
кредитов (429), сама продолжается после сброса 2-часового окна: «продолжи»
доставляется ВОВРЕМЯ (на границе окна), работа возобновляется, повторяется
на нескольких окнах подряд (repeat-режим). Механика в расширении
pi-billing-window — проверяем её вживую.

Дополнительная цель этой сессии: устранить известный дефект, при котором
доставка «продолжи» на границе ОПОЗДАЛА на ~40 минут из-за stale-ctx
(детали ниже, «Инцидент 2026-09-27»), и закрыть дыры диагностики.

## КОНТЕКСТ ПРОЕКТА

- Каталог: C:\Tools\pi-billing-window (репо pi-tools, push работает). HEAD
  на момент передачи: 84aabbf (задеплоено; сверить git log).
- Расширение грузится во ВСЕ pi-окна; рабочая копия
  ~/.pi/agent/extensions/pi-billing-window/ (деплой: powershell -ExecutionPolicy
  Bypass -File C:\Tools\pi-billing-window\deploy.ps1; после деплоя старые
  окна держат старый код до /reload).
- Живые данные: ~/.pi/agent/pi-billing-window.json (state),
  ~/.pi/agent/pi-billing-window-arms.json (формат НЕ менять),
  ~/.pi/agent/pi-billing-window-arms.log (главный источник доказательств).
- Тесты (10 сьютов, базовая линия 443 asserts / 0 FAIL): npx tsx tests/<...>:
  test.mts (базовый, имя без .test — только его можно звать по-другому),
  arms, history, lifecycle, watchdog, watchdog.e2e, replacement,
  stale-capitulation, pending-window-retry, exit-hygiene (*.test.mts).
  Каждый сьют обязан завершаться process.exit (был инцидент: сьют «прошёл,
  но повис» — всегда обёртывай прогон в timeout 120).
  Сборка: npm run build. Деплой: см. выше.
- Pi-команды в сессии: /cont-after-reset [N|off], /settimer <t>
  (форс-сброс = /settimer 0; /billing-tick — только проба checkAndReset
  с дедупом 10 мин), /billing-status.
- Headless-команды: pi --mode rpc исполняет команды расширений сообщением
  {"type":"prompt","message":"/cmd"} (см. docs rpc.md, строки ~65-69).
  Готовый харнесс: .ai/sdd/specs/004-live-scenario-testing/reports/
  (rpc_harness.py, scenario_common.py, run_live_t3_night.py,
  run_live_t3_a3.py, run_live_t3_a4.py). Тестовая модель для сессий:
  wormsoft/zai/glm-5.3-flash (провайдер wormsoft; freedeepseek-прокси
  :9655 лежит — не использовать).
- Словарь armslog: session-start, arm-seen, arm-gone, fire:reset-ready,
  fire:send-ok, fire:confirmed, send-error, send-error:stale,
  replacement:waiting/adopted, capitulation:after-N, watchdog:reset-error.
  Тайминги: окно 2ч, grace 60с, sync-poller 60с, retry-поллинг 5 мин,
  stale-backoff 5→60 мин, capitulation N=6, TTL флага 8ч.
- Полная механика: .ai/sdd/specs/002-cont-after-reset-stale-session/,
  003 (exit-hygiene), 005 (fire-once-per-window — ВЫПОЛНЕНА, регресс 443/0),
  docs/watchdog-redesign.md, README §8a. Спека 004 — live-сценарии
  (scenarios.md: A1-A4, B1-B2, C1).

## ГОТОВОЕ И ОТКРЫТОЕ

Сделано (не переделывать):
- Spec 005 fire-once-per-window закоммичена, задеплоена, подтверждена live:
  «продолжи» ровно один раз на границу, между сбросами тишина.
- A1 live: PASS (18:07Z, отчёт scenario-A1-v2.md).
- Night-mini live: PASS по существу (formal FAIL из-за неатрибутивности
  armslog — send-ok строки не несут ключ сессии).
- Скил ~/.pi/agent/skills/unattended-night-run/SKILL.md — автозащита ночной
  работы (взвод arm_cont_after_reset.py от $PI_SESSION_FILE).
- Ночной монитор scenario_monitor.py отработал ночь по сессии TabDocLoad —
  отчёт: .ai/sdd/specs/004-live-scenario-testing/reports/night-status.log.

Открытое (это и есть работа):
1. УТРО: дистиллировать ночь — night-status.log + armslog (grep fire:*,
   send-error, capitulation) + рост активности TabDocLoad-сессии. Вердикт
   по C1: сколько окон покрыто, доставка на каждой границе вовремя или
   опоздала (сверить время fire:reset-ready → fire:send-ok).
2. SPEC 006 (главное): stale-ctx на границе — «продолжи» опоздало на ~42 мин
   (инцидент ниже). Через скилы sdd: requirements → design → tasks, потом
   последовательные агенты RED→GREEN→регресс→deploy. Кандидаты-темы для
   дизайна (проверить, не принимать на веру): почему session_start
   reason=reload не переснял piApi/eventBus (ни одного
   replacement:waiting/adopted за инцидент); in-process субагенты staled'ят
   ctx родителя; межпроцессный дедуп сброса отсутствует (fire:reset-ready
   ×2 от двух окон на один сброс); атрибутивность armslog (добавить ключ
   сессии в детали fire:send-ok / send-error — аддитивно, словарь не
   менять, проверить грепы тестов). Не менять вслепую: форматы
   arms.json/state.json, checkAndReset/ticker-логику, протокол pi.
3. Не прогнанные live-сценарии: A3 (внешний взвод, скрипт готов),
   A4 (TTL), B1 (/settimer 5m граница), B2 (reload до границы). После
   spec 006 деплоя — прогнать все четыре + повторить night-mini.
4. Ночь: C1-выжигатель на червяке-флэше (arm через скрипт с repeat,
   heartbeat-файл, монитор scenario_monitor.py). PASS = heartbeat растёт
   после каждого сброса, fire:confirmed на каждой границе, окна ×2+.

ИНЦИДЕНТ 2026-09-27 (источник spec 006, детали:
.ai/sdd/specs/004-live-scenario-testing/diagnostics/2026-09-27-stale-ctx-missed-boundary.md):
граница 18:26:07 → fire:reset-ready ×2 (два процесса, один сброс) →
send-error:stale «попытка 1/6» → цепочка 5→10→20→40 мин → send-ok только
в 19:08:18 (+42 мин) → confirmed 19:36:44. D-204 bounded-retry спас
(капитуляции не случилось), но гарантия «доставка на границе» не выдержала.

## ПРОТОКОЛ ЭКОНОМИИ ТОКЕНОВ (обязателен для всех агентов)

1. Файлы вместо контекста: логи/отчёты — на диск в
   .ai/sdd/specs/006-*/reports/ и diagnostics/; в чат — вердикты и пути.
2. Ответ субагента ≤15 строк по шаблону: VERDICT: PASS/FAIL/DEVIATION /
   EVIDENCE: <файл:строки> + 1-3 цитаты / DEVIATIONS / NEXT.
3. Брифы самодостаточны и минимальны: точные пути, команды, ожидаемые
   события. Не пересказывать историю сессии.
4. Grep, а не read: большие файлы (arms.log, сессии jsonl) — только
   grep -E | tail -N, wc -l, точечные sed -n. Никогда — целиком.
5. Мониторинг — скриптом, не агентом: poller пишет дистиллят, агент читает.
6. Субагенты НЕ делают: commit, push, deploy, правки prod-кода без приказа.
   Только чтение/анализ/черновики/скрипты/тесты со сводкой.
7. Ты лично верифицируешь: ключевые строки armslog каждого сценария (одна
   команда grep), итоги тестов перед коммитом, все git-операции, md5-diff
   src↔деплой после deploy.
8. 429 УБИВАЕТ субагентов: делай задачи маленькими и самодостаточными,
   каждый субагент СРАЗУ пишет промежуточные результаты в reports/ (чтобы
   смерть агента не теряла работу), вердикт — в конце. Если агент умер от
   429 — оцени наследенное с диска сам, не переобращайся к нему.

## КОНВЕЙЕР (последовательно; каждая стадия — субагент wormsoft-флэш)

Стадия 0 — дистиллят ночи (флэш): Вход: night-status.log, arms.log,
TabDocLoad-сессия. Выход: reports/morning-distill.md + вердикт C1
(доставки вовремя/с опозданием/пропуски по каждой границе).
Гейт: ты лично сверяешь пару ключевых границ grep-ом.

Стадии 1-N — SDD-цикл spec 006 (стадия = скил sdd):
- sdd-idea→sdd-prd: агент формулирует requirements по инциденту
  (+кандидаты-темы выше), кладёт в .ai/sdd/specs/006-*/. Ты читаешь.
- sdd-spec: агент пишет design.md (решения по каждому кандидату,
  компромиссы, риски). Ты правишь при отклонениях.
- sdd-tasks: агент раскладывает в tasks.md (RED-тесты → GREEN-фикс →
  регресс → deploy → live-verify → ночь). Ты утверждаешь.
- sdd-exec: последовательные субагенты по задачам; ты — гейты: тесты,
  регресс 443+/0, build, md5-диф деплоя, live-сценарии (grep fire-цепочек
  лично), git-операции, Conventional Commits, push.

Стадия Z — финальная ночь: C1-выжигатель с repeat, монитор, утро —
утренний отчёт: матрица сценариев PASS/FAIL с цитатами armslog (время +
событие) | судьба каждого бага (hash / отложено с причиной) | регресс |
статус деплоя | вердикт по инварианту: подтверждён/не подтверждён и при
каких условиях.
