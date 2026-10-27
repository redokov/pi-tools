# Design: Spec 015 — night backlog runner

> Status: implemented 2026-10-26 (src/nightbacklog.ts, src/nightrun-state.ts,
> src/nightrun-log.ts, src/nightrun.ts + /night-run wiring in src/index.ts;
> 133 unit/mock tests green; deployed copy synced). Original design below.

## 1. Command boundary

`/night-plan` and `/night-run` are deliberately different commands:

- `/night-plan` is the night-window safety contract: schedule, expiry,
  auto-rearm, ledger, and morning report. It does not execute user work.
- `/night-run` is the queue executor: parse tasks, own the cursor, dispatch
  one task, classify the result, persist state, and expose pause/resume/stop.

Keeping these responsibilities separate prevents a scheduling repair from
silently becoming a message-sending worker and lets a user keep a plan for
window safety without opting into backlog execution.

## 2. Components

1. **Backlog parser** — pure function. Reads a bounded UTF-8 Markdown file,
   recognizes `## Task N` and its following `## Acceptance`, returns ordered
   tasks. Rejects duplicate/missing/non-sequential task numbers and oversized
   sections. It never returns the entire document as a prompt.
2. **Runner state store** — file + lock + atomic temp/rename, separate from
   `pi-billing-window-nightplan.json` and from daytime arms state. Stores plan,
   backlog identity/hash, cursor, status, attempt/retry counters, last result,
   updatedAt, and boundary policy.
3. **Transition log** — append-only JSONL/CSV under the night-run directory;
   each record includes plan/task/from/to/action/reason/timestamp. It is the
   source for idle explanations and recovery diagnostics.
4. **Dispatcher** — sends only the current task plus its acceptance criteria;
   it uses the existing continuation/session-owner gates but never sends the
   whole Markdown file. It returns a typed result (`PASS`, `FAIL`, `429`,
   `OWNER_BUSY`, `STOPPED`) rather than mutating the cursor itself.
5. **Boundary guard** — checks the plan's local end before each dispatch and
   before advancing. `after-boundary` is a durable idle reason.
6. **Command adapter** — `/night-run status|pause|resume|skip|stop`; all
   mutations are serialized through the state store and transition log.

## 3. State machine

```text
idle -> running       /night-run resume or initial explicit start
running -> awaiting-result  dispatch accepted
awaiting-result -> running  PASS and next task exists
awaiting-result -> completed PASS on final task
awaiting-result -> failed    FAIL with retry budget exhausted
running -> paused      user pause or policy pause
running -> stopped     user stop (terminal until explicit new plan)
any active -> paused   429 / after-boundary / owner-busy (policy-specific)
```

A 429 does not change `currentTask`; it records `lastResult=429` and a
retry-after/idle reason. `skip` increments the cursor only as an explicit user
action and records that action. `stop` has a monotonic user-stop marker that
auto-rearm cannot clear.

## 4. Persistence and crash recovery

Before dispatch, persist `status=awaiting-result`, task number, attempt, and
an idempotency key. After result, persist result and transition before sending
or scheduling the next task. On startup, `awaiting-result` is recovered as
`running` with the same task and a bounded reconciliation attempt; it is never
assumed PASS. A file hash/path change invalidates the cursor unless the user
explicitly resumes.

All writes use the existing lock/retry/atomic-write pattern. State and
transition files are scoped by plan key so daytime work cannot overwrite a
night state.

## 5. Time and ownership

The runner may continue observing an in-flight task after the 08:00 boundary,
but `dispatch(currentTask)` checks the local boundary and refuses new sends.
The scheduler records `after-boundary`. Owner-busy, stale references, and
switch-needed remain delivery diagnostics; they do not advance the cursor.
The existing `cont-after-reset` arm is a safety mechanism, not proof that a
backlog task passed.

## 6. Result contract

The executor must receive an explicit PASS/FAIL marker according to the task's
Acceptance section. Natural-language success without a marker is `FAIL` or
`awaiting-result`, never an implicit PASS. A provider 429 is a separate
recoverable result. Result evidence is bounded and stored by reference or
truncated digest, not as an unbounded prompt transcript.

## 7. Safety and non-goals

- No 1C database operations, credit purchases, or full unattended night in
  this feature.
- No UI/E2E dependency for the initial runner; unit/mock tests are sufficient.
- No implementation in this session; future work must be separately approved.
- Existing `/night-plan backlog=<path>` behavior remains reference-only until
  this spec is implemented and tested.

## 8. Failure modes

- Missing/invalid backlog: `failed` before dispatch, reason `backlog-invalid`.
- Lock contention: remain at same task, reason `state-lock-busy`.
- 429: remain at same task, reason `429`.
- owner-busy/switch-needed: remain at same task, reason recorded; bounded retry.
- Process/session replacement: recover from durable `awaiting-result` state.
- 08:00 boundary: no new dispatch; state/log explain `after-boundary`.
