# Feature: Spec 016 — /night-plan create (night-run prompt generator)

> Status: implemented 2026-10-26 (src/nightcreate.ts + /night-plan create;
> 38 unit/e2e tests green; deployed synced).
> Depends on: Spec 014 night plan, Spec 015 night-run (backlog format).

## Goal

`/night-run` requires a strictly-formatted backlog file (spec 015), and the
launch sequence (plan + double resume) is easy to get wrong. `/night-plan
create` closes the human gap: it generates a ready-to-paste meta-prompt that
instructs a fresh agent session to (a) adapt night tasks to the project,
(b) write a valid backlog file, and (c) print the exact launch commands.

The extension itself never invents night tasks, never writes the backlog, and
never starts the runner — the creative work stays with the agent in the new
session; `/night-plan create` only renders the contract.

## Requirements

### FR-016-1 — command surface

`/night-plan create [HH:MM-HH:MM] <цель ночи>` — optional interval (default
`22:00-08:00`), free-text goal (required, non-empty). Unknown/empty goal →
usage error notify, no side effects.

`create` MUST NOT create or modify the night plan, MUST NOT touch runner
state, MUST NOT send messages, MUST NOT start anything.

### FR-016-2 — meta-prompt content

The generated prompt (Russian, Markdown) MUST instruct the receiving agent to:

1. Work in the given project cwd, explore it as needed.
2. Produce the backlog at the suggested path
   `<cwd>/.ai/night/backlog-<YYYY-MM-DD>.md`.
3. Follow the spec 015 format strictly: sequential `## Task N`, mandatory
   `## Acceptance` per task, no gaps/duplicates, compact tasks (file ≤ 2 MB,
   task ≤ 64 KB), self-contained tasks for unattended overnight work.
4. Make each task's Acceptance demand an explicit final-line marker
   `TASK_RESULT: PASS` / `TASK_RESULT: FAIL` (unmarked text is not PASS).
5. Respect night-run safety: no interactive questions mid-task, no
   destructive ops, unit/mock/static tests only, no 1C DB mutations, no real
   overnight start by the agent itself.
6. End by printing the exact launch commands for the user to copy:
   `/night-plan <interval> backlog=<path>`, then `/night-run resume` twice,
   in the owner session.

The prompt embeds: project cwd, goal text, interval, backlog path, date,
and a short summary of runner semantics (one task at a time, PASS-chain,
429/boundary handling) so the tasks are shaped for real night behavior.

### FR-016-3 — delivery

The full prompt is written to
`~/.pi/agent/pi-billing-window-nights/create-prompt-<YYYY-MM-DD>.md`
(atomic write, mkdir -p). The notify shows the file path plus a one-line
"open, copy into a new session" instruction. No clipboard side effects.

### FR-016-4 — purity and testability

The prompt builder is a pure function (no fs, no clock) taking
{cwd, goal, fromLocal, toLocal, date, backlogPath}; the command adapter
resolves cwd/date/paths and calls it. Unit tests cover content invariants;
an e2e-style mock test covers the command (file written, plan/runner state
untouched, no sends).

## Acceptance criteria

1. `/night-plan create доделай тесты spec 015` writes a prompt file and
   notifies its path; plan file and runner state are unchanged; no
   sendUserMessage calls.
2. The prompt contains: cwd, goal, strict format rules, marker requirement,
   safety rules, suggested backlog path, and the exact three launch commands
   with the given interval and path.
3. Empty goal → usage notify, no file.
4. Custom interval lands in both the prompt's launch commands and the
   plan-summary line.
5. `npx tsc -p tsconfig.json` green; new unit + e2e tests green; full suite
   green; deployed copy synced (new runtime file in deploy.ps1).
