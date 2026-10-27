# Tasks: Spec 015 — night backlog runner

> Status: executed 2026-10-26 (T01-T09 done, gates green, deployed synced).
> T10 review done; real backlog run still needs explicit user approval.

## Phase A — contracts and parser

- [x] **T01 — Define typed runner state and result contracts**
  - Files: future `src/nightrun.ts`, tests.
  - Add state/status/result types, versioned schema, and bounded evidence.
  - Gate: TypeScript compile; schema round-trip tests.

- [x] **T02 — Implement Markdown backlog parser**
  - Files: future `src/nightbacklog.ts`, `tests/nightbacklog.test.mts`.
  - Parse explicit `## Task N` + `## Acceptance`; reject ambiguous/duplicate/
    missing sections and oversized input; never return whole Markdown as prompt.
  - Gate: two-task parse, malformed inputs, size bound, no-giant-message test.

## Phase B — durable state and transitions

- [x] **T03 — Add locked atomic state store**
  - Files: future `src/nightrun-state.ts`, `tests/nightrun-state.test.mts`.
  - Store plan/backlog hash/currentTask/status/attempt/lastResult/updatedAt.
  - Gate: restart recovery, concurrent writes, no daytime-key collision.

- [x] **T04 — Add transition/idle journal**
  - Files: future `src/nightrun-log.ts`, tests.
  - Append bounded transition records with reason and task.
  - Gate: every state mutation emits a matching transition; idle reasons survive restart.

## Phase C — execution policy

- [x] **T05 — Implement one-task dispatcher**
  - Files: future `src/nightrun-dispatch.ts`, tests with mock sender.
  - Dispatch only current task and Acceptance; typed PASS/FAIL/429/owner-busy.
  - Gate: no whole-backlog prompt; PASS advances exactly once; duplicate result is idempotent.

- [x] **T06 — Implement retry, 429, and boundary policy**
  - Files: future runner module and tests.
  - Bounded FAIL retries; 429 preserves cursor; 08:00 blocks new sends.
  - Gate: all acceptance criteria 3–5.

- [x] **T07 — Implement stop/pause/resume/skip precedence**
  - Files: future command adapter and tests.
  - User stop stronger than automatic continuation; skip explicit and logged.
  - Gate: acceptance criteria 6–8.

## Phase D — integration and verification

- [x] **T08 — Add `/night-run` command adapter**
  - Files: future `src/index.ts`, deploy list only if runtime files are added.
  - Keep `/night-plan` reference-only and separate.
  - Gate: command unit tests; no production night started.

- [x] **T09 — Add static/mock regression suite**
  - Files: future `tests/nightrun*.test.mts`, Python report tests if needed.
  - Cover replacement, restart, 429, owner-busy, boundary, stop, and day/night isolation.
  - Gate: `npx tsc -p tsconfig.json`, targeted tests, `bash scripts/run_all_suites.sh`.

- [x] **T10 — Review, deploy plan, and explicit approval gate**
  - Inspect diff and deployment list; do not deploy/reload/run a night without
    explicit user approval. No 1C UI/E2E is needed for this spec.
  - Gate: review confirms `/night-plan` still does not execute backlog.
