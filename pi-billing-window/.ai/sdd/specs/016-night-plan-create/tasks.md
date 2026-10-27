# Tasks: Spec 016 — /night-plan create

## Phase A — builder

- [x] **T01 — Pure prompt builder + path suggestion**
  - Files: `src/nightcreate.ts`, `tests/nightcreate.test.mts`.
  - `suggestBacklogPath`, `buildNightCreatePrompt` (no fs/clock).
  - Gate: tsc; content-invariant unit tests.

## Phase B — command adapter

- [x] **T02 — `/night-plan create` subcommand**
  - Files: `src/index.ts`.
  - Grammar: optional interval + required goal; default 22:00-08:00;
    writes prompt to nights dir; notify path; no plan/runner/sends.
  - Gate: tsc; mock e2e test.

## Phase C — verification and deploy

- [x] **T03 — Tests, gates, docs, deploy**
  - Files: `tests/nightcreate.e2e.test.mts`, `deploy.ps1`, `README.md`.
  - Gate: full suite green; deploy sync; README section updated.
