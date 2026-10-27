# Design: Spec 016 — /night-plan create

## 1. Component split

- `src/nightcreate.ts` — pure builder:
  - `suggestBacklogPath(cwd, date)` → `<cwd>/.ai/night/backlog-<date>.md`
    (path.join, forward slashes acceptable on Windows for pi paths).
  - `buildNightCreatePrompt(opts)` → full Russian Markdown meta-prompt.
    No fs, no Date.now(): all time/place inputs are parameters (testable).
- `src/index.ts` — command adapter inside `registerNightPlan`: `create`
  subcommand resolves cwd (`historyMetaOf(ctx).project` / ctx cwd),
  local date (`new Date().toISOString().slice(0,10)` — local-vs-UTC drift is
  acceptable for a file-name suggestion), default interval 22:00-08:00,
  writes the prompt file via `getNightsDir()`, notifies the path.

## 2. Command grammar

```
/night-plan create                       → usage error (goal required)
/night-plan create <цель>                → interval 22:00-08:00
/night-plan create 23:00-07:00 <цель>    → custom interval
```

First token matching `HH:MM-HH:MM` is the interval; the rest (joined argv,
not raw args, to normalize whitespace) is the goal. Interval is validated by
`parseHHMM` + from != to; invalid → usage error.

## 3. Meta-prompt shape (rendered by the builder)

Sections: роль и проект → цель ночи → куда положить backlog → строгий
формат (spec 015) → маркер результата → правила безопасности ночной работы →
как runner выполнит (кратко) → финальный шаг: вывести команды запуска.
The three launch commands are rendered verbatim from interval + backlogPath
so the user copies them without editing.

## 4. Safety

`create` is read-only with respect to plan/runner/arms/state: it writes only
the prompt artifact under the nights dir. It never emits sendUserMessage and
never registers timers. The generated prompt forbids the receiving agent
from running `/night-run` itself; the launch commands are printed FOR THE
USER to run in the owner session.

## 5. Failure modes

- Unreadable cwd → fall back to empty string; prompt still renders (the
  receiving agent resolves its own cwd anyway).
- Prompt-file write failure (lock-free single writer, mkdir -p) → error
  notify, no partial state anywhere else.

## 6. Tests

- `tests/nightcreate.test.mts` (pure): path suggestion; prompt contains cwd /
  goal / interval / path / format rules / marker / safety / launch commands;
  empty goal rejected at adapter level (builder takes non-empty goal as
  given).
- `tests/nightcreate.e2e.test.mts` (mock pi harness like nightrun.e2e):
  command writes file, notify carries path, plan file absent/unchanged,
  runner state absent, sends empty; empty-goal case → no file.
