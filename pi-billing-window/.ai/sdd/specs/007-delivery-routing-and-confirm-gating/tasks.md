# Spec 007 — Tasks

## T1 — DONE Delivery verification helper (D1)

**Files:** `src/index.ts` (helpers verifyDelivered / ownerQuiet / isTokenBearing)
**Acceptance:**
- `verifyDelivered(ownerKey, sendTimeMs, text): boolean` — reads owner jsonl,
  finds user entry with `text` and timestamp within [sendTimeMs-1500, +∞).
- Read failure → false (bounded by caller).
**Verify:** unit test in `tests/` with fake jsonl fixtures.

## T2 — DONE Send path: verify + misroute (D1, D3, D4)

**Files:** `src/index.ts` (send path in ticker/reset fire)
**Acceptance:**
- After `sendUserMessage` resolves → `verifyDelivered`; not delivered →
  `fire:send-misroute`, arm stays pending, no pendingFiredResetAt set.
- D3 (refsForeign) DROPPED — conflicts with the spec 006 invariant
  (foreign child session-start must not block owner delivery).
- File-quiet check (owner jsonl mtime > resetGraceMs) before send.
**Verify:** unit tests + existing tests stay green.

## T3 — DONE Confirmation gating (D2)

**Files:** `src/index.ts` (successful-call handler)
**Acceptance:** `armsConfirmSuccess` called only when call sessionFile ==
ownerKey AND timestamp > pendingFiredResetAt AND tokens > 0.
**Verify:** unit tests with fake call metadata; foreign-key / pre-send /
0-token cases → no confirm.

## T4 — DONE Regression run

**Files:** `tests/test.mts`
**Acceptance:** full suite green including replacement, session-isolation,
pending-window-retry, stale-capitulation, lifecycle.
**Verify:** `npm run test` exit 0.

## T5 — DONE (deploy) / live verdict pending

**Files:** `deploy.ps1` (existing)
**Executed:** extension deployed via deploy.ps1, verified identical to src.
Live baseline observed on reset #442 (OLD code): 1 of 2 armed resumed,
the other delivered ~33 min late (late re-plan + silent delivery miss +
streaming skip) — see report.md. Verdict after user reloads both sessions
and /cont-after-reset: both fire on the next reset -> close T5.
**Verify:** arms.log shows `fire:send-ok` only with owner jsonl entry;
`fire:confirmed` only after real owner response.

## T6 — DONE

**Executed:** adversarial review (wormsoft glm-5.3) — verdict SHIP,
non-blocking follow-ups applied (misroute streak reset on fresh reset;
capitulation cause telemetry).
