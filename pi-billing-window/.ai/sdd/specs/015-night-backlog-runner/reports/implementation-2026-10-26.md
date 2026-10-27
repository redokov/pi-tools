# Spec 015 implementation report — 2026-10-26

## Scope delivered

`/night-run` backlog runner per spec 015: parser, durable state, transition
log, runner policy, command adapter, production wiring, unit/mock tests,
deploy sync. No 1C/UI/E2E, no real night run, no /reload (constraints held).

## Files

New: `src/nightbacklog.ts`, `src/nightrun-state.ts`, `src/nightrun-log.ts`,
`src/nightrun.ts`, `tests/nightbacklog.test.mts`, `tests/nightrun-state.test.mts`,
`tests/nightrun.test.mts`, `tests/nightrun.e2e.test.mts`.

Modified: `src/index.ts` (registerNightRun + nightRunDeliver/nightRunTick/
nightRunObserveResult/nightRunRedriveOnReset hooks), `deploy.ps1` (4 runtime
files), `README.md` (section 8d), spec 015 status files. Prior-session ledger
fix (nightplan.ts / billing_report.py / state.ts / reset.ts) untouched.

## Key design points

- State: `~/.pi/agent/pi-billing-window-nightrun.json` + `.lock` (atomic
  tmp+rename, proper-lockfile 20 retries, tolerant read, schema v1).
- Prompt: one task + acceptance + explicit `TASK_RESULT: PASS|FAIL` marker
  requirement; never the whole Markdown. Caps: file 2MB / task 64KB / prompt 16KB.
- Result contract: PASS (advance/complete), FAIL (bounded retry, default 2,
  exhaustion -> failed), 429 (paused, cursor kept, re-drive on window reset),
  OWNER_BUSY / SWITCH_NEEDED (delivery diagnostics, cursor kept), STOPPED,
  BOUNDARY_BLOCKED. Unmarked assistant text is never PASS.
- Dispatch drivers: explicit /night-run resume; PASS chain within a window;
  billing:window_reset re-drive (incl. 429 resume and awaiting-result
  recovery). No background timer. userStop blocks everything; /night-plan
  re-arm does not clear it.
- Durable awaiting-result before every send; restart recovery keeps the same
  task and attempt, never auto-PASS. Backlog hash mismatch invalidates cursor.
- Day/night isolation: separate state/lock/log files; runner never touches
  pi-billing-window.json / arms.json / nightplan state. Verified in e2e:
  /billing-reset does not advance the night cursor.

## Gates (all exit 0, final full run after last edit)

- `npx tsc -p tsconfig.json` — no errors.
- New suites: nightbacklog 22, nightrun-state 23, nightrun 60, nightrun.e2e 28
  (133 total).
- `bash scripts/run_all_suites.sh` — all 21 suites exit 0, prior suites intact
  (nightplan 100/76, replacement 34, session-isolation 68, ...).
- `py_compile` + `python3 tests/billing_report_test.py` — 39 passed.
- `git diff --check` — clean (pre-existing trailing whitespace in a prior
  session report fixed, whitespace-only).
- Deployed copy `~/.pi/agent/extensions/pi-billing-window` synced via
  deploy.ps1; repo/deployed diff empty. /reload NOT run.

## Not done by design (needs explicit user action)

1. `/reload` to load the new extension code.
2. First real `/night-run resume` on a live plan with a real backlog.
3. Live validation of the PASS-marker observer against real assistant
   replies (mock-covered only).

No real backlog task was dispatched during this implementation.
