# Spec 007 — Delivery routing to owner + confirmation gating

**Date:** 2026-09-28
**Status:** approved for implementation
**Input:** RCA of 2026-09-28 incident (session `17-27-11-381Z`, TabDocLoad) + bundle research (chunk-4DKZACXI.js, pi 0.87.0)

## Problem (RCA summary)

Window reset 13:37:32Z after a wormsoft 429 (13:31:42Z, T2.2 subagent died,
parent chat idle). The extension scheduled «продолжи» (+60 s). Observed:

1. `fire:send-ok` logged by the owner process (pid 36212) at 13:38:33.623.
2. The message did **NOT** land in the owner chat
   (`sessions/--c--MyProjects-TabDocLoad--/…17-27-11-381Z_….jsonl` — zero
   13:38 entries). It landed in the foreign subagent session
   `…13-11-03-458Z_….jsonl` at 13:38:32.591 (the dead-but-alive subagent
   resumed work on glm-5.3-flash).
3. `fire:confirmed` fired at 13:38:38.559 on a **glm-5.3-flash call with
   0/0 tokens attributed to the foreign session** (history.csv 16:38:38).
   The arm was consumed/re-armed while the user's chat never saw «продолжи».
   Extension state looks healthy; the failure is silent.

## Root causes

**C1 — shared runtime slot (core, out of scope to fix here).**
`bindCore` does a plain slot assignment
`this.runtime.sendUserMessage = actions.sendUserMessage` into ONE runtime
object shared per resourceLoader. A subagent session created in-process with
the same resourceLoader re-points that slot to its own
`AgentSession.prompt()`. `assertActive()` only guards stale/failed contexts
after session replacement — it does not detect the re-point. So the
extension's captured `ctx.sendUserMessage` (and any ref captured via
`sessionBusOf`) routes through the shared slot and can deliver to a live
foreign subagent session.

**C2 — false-positive confirmation.** The successful-wormsoft-call handler
(the `callsInWindow++` block) confirms the pending arm on ANY successful
provider response in the process, without checking (a) which session file
the call is attributed to, (b) whether it happened after the actual
«продолжи» send, (c) whether the call is a real (token-bearing) call.
Background flash calls (title generation, retries) confirm the arm.

**C3 — ctx-based idle check is also routed through the shared refs.**
`ctx.isIdle()` may report the owner's idle state while the send path still
routes to the foreign session; it cannot detect mis-delivery.

## Design decisions

**D1 — post-send delivery verification (primary guard, extension-level).**
After `p.sendUserMessage("продолжи")` resolves, read the OWNER session jsonl
(`ownerKey`) and look for a user entry whose text is «продолжи» with
timestamp > send time (tolerance: -1.5 s, file clock vs wall clock).
- Delivered → current behaviour (`fire:send-ok`, pending).
- Not delivered → log `fire:send-misroute`, do NOT set the confirmed-pending
  state as satisfied, keep the arm pending, retry on the next tick
  (`RETRY_AFTER_FIRE_MS`). The retry re-runs D1 verification. Once the
  foreign subagent dies and the slot re-binds to the owner (or the owner's
  session_start re-captures fresh refs), delivery succeeds and normal flow
  resumes.

**D2 — confirmation gating.** In the successful-wormsoft-call handler, call
`armsConfirmSuccess` only when ALL of:
- call's sessionFile key == ownerKey (owner conversation);
- `pendingFiredResetAt !== null` (a delivered «продолжи» is pending);
- call has tokens > 0 (input or output) — excludes 0-token background calls.
Otherwise skip confirmation (pending stays; D1 retries / next real call in
the owner confirms). Additionally: `currentCtx = ctx` in the handler is
re-pointed ONLY for a same-key response (a foreign subagent's wormsoft
responses, INCLUDING 429, must not steal the owner ctx — this was the
second repoint mechanism in the incident).

**D3 — DROPPED (was: skip-send while a foreign session is alive).**
Conflicts with the spec 006 invariant "a foreign child session-start must
not block the owner's delivery" (session-isolation tests assert it). The
subagent-resume harm is accepted at extension level; D1 verification + the
existing retry loop heal delivery once the foreign session dies.

**D4 — file-based idle check (secondary).** Before sending, additionally
verify the owner jsonl has been quiet for > QUIET_SEC (existing constant,
file mtime). If the file was touched recently, another conversation may be
active — do not send. Prevents sending while a foreign/parent session is
mid-turn even when `ctx.isIdle()` lies.

**D5 — non-goals.** No pi core changes (global npm package — report upstream
separately). No direct session-file writes to inject messages. No changes to
window-reset detection, watchdog, fire lease, or history writers beyond the
gating hook.

## Risks / FAQ

- *Can D1 double-send if delivery is slow but real?* No — verification uses
  the send timestamp it observed; a later retry only happens if the user
  entry is absent.
- *Does the misroute retry wait 5 minutes?* The pace is RETRY_AFTER_FIRE_MS
  (5 min, the existing retry cadence); recovery after the subagent dies
  lands on the next retry tick.
- *Can the owner jsonl be unreadable (rotated)?* If read fails, treat as
  not-delivered but do not increment a misroute streak more than the
  existing staleAttempts cap (bounded path, no new runaway).
- *Does D2 break repeat re-arm?* No — confirmSuccess semantics unchanged;
  only its trigger condition is gated.
- *0-token call in the owner conversation right after send?* Excluded by
  D2's token check; the next real owner call confirms.

## Verification (executed 2026-09-28)

1. `npx tsx tests/delivery-gating.test.mts` — 32 asserts green (faithful
   mock): misroute -> retry -> delivery; misroute cap -> capitulation;
   confirm gating (foreign key / 0 tokens -> no confirm; owner + tokens ->
   confirm); ownerQuiet / verifyDelivered / isTokenBearing unit cases.
2. Full suite: 14 test files, 640 asserts, 0 FAIL, all exit 0 — including
   replacement, session-isolation, pending-window-retry, stale-capitulation,
   lifecycle, watchdog.e2e, exit-hygiene (meta), test.mts.
3. Baseline check: the 5 affected suites were green BEFORE the change
   (git stash) and green AFTER — no regression.
4. Log invariant: `fire:confirmed` only with a real owner delivery
   (asserted in the gating tests; checked against the owner jsonl).
