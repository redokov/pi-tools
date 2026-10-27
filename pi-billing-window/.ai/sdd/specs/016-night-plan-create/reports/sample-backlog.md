# Sample night backlog — образец результата meta-prompt-а (spec 016)

> Это демонстрация того, что агент в новой сессии должен написать после
> получения meta-prompt-а от `/night-plan create`. Файл прошёл валидацию
> реальным парсером (parseBacklog → ok, 2 задачи) и сборщиком prompt-ов
> (buildTaskPrompt → в лимите 16 КБ). Не является активным backlog-ом ночи.

## Task 1

Прибери тестовые артефакты проекта C:/Tools/pi-billing-window:

1. Найди все каталоги `__pycache__` и файлы `*.pyc` в дереве проекта, удали их.
2. Найди временные/debug-файлы (`*.tmp.*`, `*.head`, `nul`) вне `.git`, удали.
3. Проверь `git status --short`: не должно остаться мусорных untracked-файлов сверх осознанных артефактов спек.

Ограничения: ничего не коммить; не удаляй файлы спек, отчётов и сессий
(`.ai/sdd/**`, `reports/`, `sessions/`); не трогай deployed-копию.

## Acceptance

1. В дереве проекта нет `__pycache__` и `*.pyc`.
2. Нет временных файлов вида `*.tmp.*` и `*.head` вне `.git`.
3. `git status --short` не содержит мусорных временных артефактов.
4. Команды проверки выполнены, их вывод зафиксирован в ответе.
5. Заверши ответ строкой `TASK_RESULT: PASS` (если все критерии выполнены
   и подтверждены выводом команд) или `TASK_RESULT: FAIL` (с кратким
   объяснением, что именно не сошлось).

## Task 2

Сверь repo/deployed для расширения pi-billing-window:

1. Сравни каждый runtime-файл из списка deploy.ps1 между
   `C:/Tools/pi-billing-window/src` и
   `C:/Users/r.edokov/.pi/agent/extensions/pi-billing-window`.
2. Если найдены расхождения — НЕ исправляй их сам (это делает deploy.ps1),
   просто перечисли их в ответе с путями.
3. Запиши итоговую таблицу «файл → совпадает/расходится» в ответ.

Ограничения: только чтение; ничего не копируй и не перезаписывай;
`/reload` не выполняй.

## Acceptance

1. В ответе есть таблица по всем runtime-файлам из deploy.ps1
   (index.ts, state.ts, reset.ts, wakeups.ts, ui.ts, parser.ts,
   notifier.ts, history.ts, arms.ts, armslog.ts, watchdog.ts,
   firelease.ts, nightplan.ts, nightbacklog.ts, nightcreate.ts,
   nightrun-state.ts, nightrun-log.ts, nightrun.ts).
2. Каждый файл помечен «совпадает» или «расходится» (с путём).
3. Ни один файл не был изменён (git status без новых изменений src/).
4. Заверши ответ строкой `TASK_RESULT: PASS` (все файлы перечислены и
   помечены, изменений не делал) или `TASK_RESULT: FAIL` (с кратким
   объяснением).
