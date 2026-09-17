# Review — 001-model-in-history

> Status: done
> Reviewed: 2026-09-17
> Method: adversarial code review by a model from a different family
> (minimaxai/minimax-m3; implementation was done by GLM-family models).

## Verification evidence

- TS tests: history **52 passed / 0 failed**, lifecycle 6, arms 23, main suite 136 — all green
- Python tests: `tests/billing_report_test.py` — **32 passed / 0 failed**
- `npm run build` (tsc) — clean
- Smoke: `python scripts/billing_report.py --days 1` on the live legacy CSV —
  renders `## By model` with `(no model)` group, exit 0
- Post-deploy: all 8 extension files in
  `~/.pi/agent/extensions/pi-billing-window/` byte-identical to `src/`;
  live `pi-billing-window-history.csv` header migrated to 13 columns
  (one-time, data rows preserved, no `.tmp.*` orphans)

## Coverage

| Requirement | Status | Evidence |
|---|---|---|
| FR-001 model column in call rows | covered | history.test.mts (schema, append), index.ts:674 |
| FR-002 CSV format/lock/trim intact | covered | history tests (BOM, concurrency, trim, EOL) |
| FR-003 report backward-compat (legacy/mixed CSV) | covered | billing_report_test.py (legacy, mixed, no-model) |
| FR-004 per-model table | covered | `## By model` + tests (incl. empty-no-calls path) |
| FR-005 documentation | covered | README §8b/§6.3, docs/STATE.md §9.1, ARCHITECTURE.md |
| FR-006 tests | covered | 52 TS + 32 py, incl. CRLF and rename-failure cases |

## Adversarial review findings (minimax-m3) — verdict was "fix-then-ship"

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| F1 | major | CRLF legacy files became mixed-EOL after migration | Fixed: EOL detected before rewrite, join/append preserve file's EOL; test added |
| F2 | major | orphan `.tmp.<pid>` left on failed rename (Windows EBUSY/EPERM) | Fixed: try/finally unlinkSync; EPERM test added |
| F3 | major | empty `## By model` table when no call rows; untested | Fixed: section omitted; tests added |
| F4 | minor | `split_windows` TypeError on empty `reset_count` (pre-existing) | Fixed: `r["reset"] or 0`; tests added |
| F5 | minor | foreign-header warn didn't mention data misalignment | Fixed: message extended |
| F6 | minor | design.md claimed deploy.ps1 doesn't copy history.ts (stale) | Fixed: marked [RESOLVED] |

Nits (not fixed, accepted): brittle literal newline-count assertions in tests;
future "model normalization" task (ctx.model.id is a provider-assigned slug).

## Verdict

**Approved / shipped** — commit `5ffd86e` (pi-tools, master), deployed to
`~/.pi/agent/extensions/pi-billing-window/` via deploy.ps1. New rows carry
`model` once pi processes restart (running processes keep old in-memory code).
