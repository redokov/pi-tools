# E1-отчёт: in-process субагент инвалидирует piApi родителя? (spec 006, T-12 / design D-609)

- Дата: 2026-09-28, финальный прогон run4: 12:28–12:33Z (после деплоя с `/pbr-reload`).
- Драйвер: `reports/006-e1-subagent-stale.py` (e1-run1..4-console.log; сырые логи
  e1-parent-rpc-raw.log, e1-drv-rpc-raw.log).
- Модель: wormsoft/zai/glm-5.3-flash. Родитель: `e1-parent` pid=23504.
- Дочерний ключ: `2026-09-28T12-29-23-295Z_01a0e7fd-...jsonl` (тот же процесс, pid=23504).

## VERDICT: NO

## Гипотеза

«In-process субагент инвалидирует piApi родителя БЕЗ события замены
(session-start/replacement:adopted) родительского ключа».

## Доказательства (armslog, проверено оркестратором лично)

```
12:28:20.067Z | session-start | reason=startup key=...e1-parent.jsonl pid=23504 ep=0
12:29:20.074Z | arm-seen      | внешний взвод (lastResetAtAtArm переписан = текущий lastResetAt)
12:29:23.297Z | session-start | reason=startup key=...01a0e7fd... armed=true
              |               | owner-shift(blocked): e1-parent->01a0e7fd... (тот же pid=23504)
   [дочерний субагент отработал: agent_end, ответ "ГОТОВО" в raw-логе]
12:32:38.525Z | (real reset)  | /settimer 0 из drv-сессии
12:33:38.537Z | fire:reset-ready | сброс окна 12:32:38.525Z, «продолжи» через 0 с (grace 60с от сброса)
12:33:38.564Z | fire:send-ok    | флаг в pending
12:33:40.007Z | fire:confirmed  | флаг снят; arm-gone штатный
```

ASSERT-ы:
- (i) owner-shift залогирован: **True** (деталь `owner-shift(blocked): K_parent->K_child`,
  тот же pid — дочерняя сессия прошла через тот же модуль расширения).
- (ii) за период [child session-start, fire] НЕТ session-start /
  replacement:adopted для родительского ключа: **True**.
- (iii) `ctx=stale src=probe` на fire-пути родителя: **False** (0 строк).
- Родительский fire-путь чистый: reset-ready → send-ok → confirmed, дедуп 1 fire,
  grace 60.0с от сброса (12:32:38.525 → 12:33:38.537).

Вывод: С guard'ом D-608 (чужой session-start с живым интересом владельца
блокируется, detail `owner-shift(blocked)`) родительский ctx ПЕРЕЖИЛ дочернюю
сессию субагента — доставка сработала без события замены и без stale-маркеров.
Гипотеза «инвалидация без события замены» НЕ подтверждена.

## Решение Q-002 (судьба FR-402)

E1 = NO → полная изоляция по ключу (FR-402) **остаётся кандидатом / закрывается**
(по design.md 5.5: Must только при YES). Guard D-608 достаточен.

## НАХОДКА (смежная, из B2 — не относится к E1, но фиксируется)

Смежное свидетельство класса C1 из сценария B2: после `session_start(reason=reload)`
ПЕРВАЯ отправка получает stale ctx (`ctx=stale src=drain epoch-mismatch=1`),
восстановление ~1с. Это reload-путь, а не субагентный — в скоупе E1 не доказан,
передаётся в final-report как кандидат на отдельную задачу.

## DEVIATIONS (история отладки драйвера, run1–run3)

1. run1: arm_rc=2 (транзиентная ошибка arm-скрипта, err не выводился) + child не
   детектился из-за фильтра «key_base not in detail» — owner-shift всегда
   содержит родительский ключ как источник. Фиксы: err в вывод, retry arm,
   child-ключ извлекается из части после «->».
2. run2: REPO-путь неверен (3 уровня вверх вместо 5) → arm-скрипт не нашёлся.
   Фикс: REPO = 5 уровней.
3. run3: деталь guard'а `owner-shift(blocked):` не сматчилась регэкспом
   `owner-shift:`. Фикс: `owner-shift(?:\(blocked\))?:`.
4. run1–run3: wait_event при таймауте возвращает последнюю строку дельты —
   arm_seen выглядел как session-start. Учтено: при rc!=0 — FAIL/UNKNOWN.
