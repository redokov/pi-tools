# Feature: Spec 014 — night plan (ночной контракт: авто-перевзвод, ночная книга, утренний отчёт)

> Status: requirements:approved
> Source: инцидент 2026-10-24-apkscen-night (корневая причина — протокольная: агент снял флаг по стоп-условию, ночь осталась без страховки); аудит утилизации 14–25.10 (56/144 окон простаивало, ночная утилизация ~50%); постановка пользователя от 2026-10-25: «ночная надёжность — слой 1 плана».
> Last Updated: 2026-10-25

## Header

Расширение pi-billing-window получает «ночной план» — внешний (вне беседы) контракт
страховки ночной сессии. План переживает дисарм агента, автоматически перевзводит
флаг cont-after-reset, ведёт книгу ночных окон и утром присылает отчёт.

## Requirements

### FR-014-1 — команда `/night-plan`
- `/night-plan` (без аргументов) или `/night-plan 22:00-08:00` — создать/обновить план
  на текущую ночь для **текущей беседы** (key = basename сессии, как в arms.json):
  - `fromLocal` (default "22:00"), `toLocal` (default "08:00"), интервал допускает
    переход через полночь (from > to);
  - `repeat` (default 6) — repeat-бюджет авто-перевзводов;
  - `backlogPath` (опционально, аргумент `backlog=<path>`) — только ссылка, механика
    очереди вне спеки;
  - план хранится в `~/.pi/agent/pi-billing-window-nightplan.json` (один активный план,
  паттерн state.ts: файл + lock-каталог + retry-бюджет);
  - `expiresAt = toLocal + 1 ч` (авто-истечение утром, план не живёт дольше ночи).
- `/night-plan off` — снять план досрочно.
- `/night-plan status` — показать план (from/to, repeat, backlog, активен/нет, флаг).
- Взвод плана НЕ взводит флаг сам (флаг взводится по мере необходимости инвариантом
  FR-014-2, либо руками `/cont-after-reset`).

### FR-014-2 — инвариант страховки (auto-rearm)
На каждом sync-тике (SYNC_POLL_MS, процесс-владелец state) при живом плане:
`planActive(now) ∧ localTime ∈ [from, to) ∧ arm(plan.key) отсутствует` →
`arms.arm(plan.key, repeat=plan.repeat, ttl до plan.expiresAt)` +
armslog `auto-rearm:from-plan` (с атрибуцией key/pid/host/ep через withAttr) +
notify (type `billing:night-plan-rearm`, fire-and-forget). Успешный auto-rearm —
единственное событие на «пропажу» флага в интервале плана (arm-gone-notify для
этого ключа в интервале гасится, чтобы не дублировать — см. FR-014-3).

### FR-014-3 — настойчивый notify при незастрахованном плане
Если инвариант не может восстановить флаг (arm() упал, lock, битый файл) или флаг
снят снова и auto-rearm повторяется чаще 1 раза в 30 мин — escalate: notify
`billing:night-plan-uninsured` с повтором каждые 10 мин, пока план активен и
ключ незастрахован (rate-limit в памяти процесса). Сценарий 23:23→09:33 из
инцидента 24.10 становится невозможен: пользователь узнаёт о снятии флага
в ту же минуту.

### FR-014-4 — ночная книга (night ledger)
На каждый `billing:window_reset`, если момент сброса ∈ интервал активного плана
(либо окно началось в интервале), дописывается строка в
`~/.pi/agent/pi-billing-window-nights/ledger.csv` (append-only, паттерн history.ts):
`ts_iso,epoch_ms,night_date,reset_at,calls_in_window,input,output,cache_read,arm_phase,verdict`
где arm_phase — состояние флага на момент сброса (`armed|pending|none`),
verdict — `used` (calls_in_window > 0) | `idle` (иначе). Причина простоя
уточняется утренним отчётом по armslog (capitulation / no-arm / delivery-failed),
на момент сброса фиксируются только факты.

### FR-014-5 — утренний отчёт
В `toLocal` (момент окончания плана) процесс-владелец генерирует
`~/.pi/agent/pi-billing-window-nights/report-<night_date>.md`:
- таблица окон ночи (из ledger + history.csv): окно, токены, вызовы, arm_phase,
  used/idle, причина простоя (по armslog за интервал: capitulation / no-arm /
  arm-gone-external / delivery-stale);
- итоги ночи: окон использовано/простаивало, токены, auto-rearm-события;
- при незастрахованных окнах — блок «потери» с оценкой (~5M кредитов/окно);
- если задан backlogPath — строка «backlog: <path>» (без исполнения).
Отправить notify `billing:night-report` с 2-строчным дайджестом (fire-and-forget).
Таймер утреннего отчёта — wall-clock setTimeout (unref, перевзвод на sync-тике),
планируется при взводе плана и на каждом session_start владельца.

### FR-014-6 — version stamp
Константа `VERSION` (формат `014.<date>`) в index.ts: дописывается как токен
`v=` через withAttr в строку `session_start` (только если токен отсутствует) и
показывается в `/billing-status`. Утренний отчёт включает версию — «ночь работала
на коде N» (защита от повторения deploy-разрыва 24.10).

## Acceptance

Сценарии приёмки (e2e, короткие интервалы):
1. план взведён → внешний disarm (удаление arms.json) → sync-тик → auto-rearm +
   `auto-rearm:from-plan` в armslog + notify;
2. сброс окна в интервале плана → строка в ledger (used и idle варианты);
3. в `toLocal` — файл report-<date>.md с таблицей окон + notify;
4. `/night-plan off` → инвариант не перевзводит, ledger/отчёт не пишутся;
5. истёкший план (now > expiresAt) игнорируется на sync-тике;
6. arm() падает (битый lock) → `billing:night-plan-uninsured` с повтором.

## NFR

- NFR-014-1: все таймеры unref; тест-хуки для детерминизма (интервалы/время —
  параметры модуля; никаких реальных минут в тестах).
- NFR-014-2: тихая деградация: битый/чужой nightplan.json → «нет плана» +
  однократный warn; ни одного необработанного исключения наружу (паттерн NFR-012-2).
- NFR-014-3: интервал-математика (переход через полночь) — чистые функции,
  полные юнит-тесты.
- NFR-014-4: автоперевзвод делает только процесс-владелец state (owner-guard,
  паттерн spec 006 D-607/D-608); чужие процессы план не трогают.
