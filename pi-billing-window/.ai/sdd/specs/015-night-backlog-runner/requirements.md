# Feature: Spec 015 — night backlog runner

> Status: implemented (unit/mock tests + deploy sync done 2026-10-26). A real
> backlog run still requires explicit user action (`/reload`, then
> `/night-run resume` on a real plan).
> Depends on: Spec 014 night plan and the ledger/report reliability fix.

## Goal

`/night-plan ... backlog=<path>` currently stores only a reference. A future
implementation must execute the referenced Markdown backlog sequentially,
without confusing scheduling/insurance with queue execution.

## Requirements

### FR-015-1 — explicit backlog format

The backlog is UTF-8 Markdown with explicit task sections:

```markdown
## Task 1
...
## Acceptance
...
## Task 2
...
## Acceptance
...
```

A parser MUST reject ambiguous task boundaries rather than sending the whole
file as one prompt. Acceptance text belongs to the preceding task.

### FR-015-2 — durable runner state

The runner stores state on disk, atomically and under a lock:

```json
{
  "plan": "night-2026-10-26",
  "backlog": "...",
  "currentTask": 1,
  "status": "running",
  "lastResult": null,
  "updatedAt": 0
}
```

Allowed statuses include `running`, `paused`, `stopped`, `failed`, and
`completed`. Every transition and its reason is appended to a transition log.

### FR-015-3 — sequential execution and persistence

Tasks are sent strictly one at a time. After a successful continuation, the
runner persists the result and advances to the next task. State is persisted
after every task attempt and before/after every externally visible transition.
A task is never silently skipped.

### FR-015-4 — failures and retries

PASS advances to the next task. FAIL stops the runner or uses a bounded retry
budget configured by the plan. The retry count and reason are durable. A 429
must preserve the current task and resume later; it must never advance the
cursor.

### FR-015-5 — time boundary

At 08:00, the runner MUST stop dispatching new tasks. An already-running task
may finish according to its bounded timeout policy, but no new task may be
sent after the boundary.

### FR-015-6 — commands

Provide separate commands:

- `/night-run status`
- `/night-run pause`
- `/night-run resume`
- `/night-run skip`
- `/night-run stop`

A user stop has higher precedence than automatic continuation and cannot be
undone by `/night-plan` auto-rearm. `skip` must be explicit and logged.

### FR-015-7 — isolation from daytime work

Daytime current tasks and the night queue MUST have distinct state keys,
transition logs, and ownership. A daytime continuation must not advance the
night cursor.

### FR-015-8 — observability and idle reasons

The transition log records timestamp, plan, task, previous/new status, action,
and reason. Idle periods record a reason such as `paused`, `429`,
`owner-busy`, `after-boundary`, or `awaiting-result`.

### FR-015-9 — safety boundaries

The runner MUST NOT mutate the 1C database, purchase credits, or start a
full unattended night without explicit user action. The runner must not send
the entire Markdown document as one giant message.

## Acceptance criteria

1. A two-task backlog parses into exactly two tasks with separate acceptance
   text.
2. PASS of task 1 persists `currentTask=2`; a restart resumes task 2.
3. FAIL either stops or retries only within the configured bounded budget.
4. A 429 preserves the same task and writes an idle/429 transition.
5. A boundary check prevents a new dispatch at/after 08:00.
6. User stop wins over an automatic continuation attempt.
7. Day and night state cannot cross-advance each other.
8. Status and transition log expose every pause and reason.
9. The runner never sends the complete Markdown file as one message.
10. Unit/mock tests cover all criteria; no UI/E2E or real overnight run is
    required for the initial implementation.
