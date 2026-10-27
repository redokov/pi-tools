# Spec 016 implementation report — 2026-10-26

## Delivered

`/night-plan create [HH:MM-HH:MM] <цель ночи>` — генератор meta-prompt-а
ночного прогона (spec 016).

- `src/nightcreate.ts` — pure builder: `suggestBacklogPath(cwd, date)` →
  `<cwd>/.ai/night/backlog-<date>.md`; `buildNightCreatePrompt(opts)` —
  русский Markdown meta-prompt (проект/цель/формат spec 015/маркер
  TASK_RESULT/правила безопасности/семантика runner-а/команды запуска).
  Ни fs, ни часов — все входы параметрами.
- `src/index.ts` — ветка `create` в registerNightPlan: опциональный интервал
  (default 22:00-08:00, валидация parseHHMM + from≠to), обязательная цель,
  дата `toLocaleDateString("sv-SE")`, atomic tmp+rename запись в
  `nights/create-prompt-<date>.md`, notify с путём и инструкцией.
- Safety: create не пишет план/runner state/arms, не отправляет сообщения,
  не регистрирует таймеры. Агент в новой сессии сам runner не запускает —
  команды запуска печатаются ДЛЯ пользователя.

## Tests (38 new, all green)

- `tests/nightcreate.test.mts` — 22 (path suggestion, содержание промта:
  cwd/цель/формат/лимиты/маркер/безопасность/команды/интервал/fallback/
  детерминизм).
- `tests/nightcreate.e2e.test.mts` — 16 (мок pi: файл записан, notify с
  путём, план и runner state НЕ созданы, sends пуст; usage при пустой цели
  и неверном интервале; кастомный интервал в командах).

## Gates (exit 0)

`tsc`; `run_all_suites.sh` — 23 сьюта exit 0 (прежние не сломаны);
`git diff --check` clean. Deploy: `nightcreate.ts` добавлен в deploy.ps1,
deployed-копия синхронизирована. `/reload` не выполнялся; реальный
meta-prompt не генерировался в живой сессии (только в тестах).
