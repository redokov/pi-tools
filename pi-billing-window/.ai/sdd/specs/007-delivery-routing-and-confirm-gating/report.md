# Spec 007 — report (live observations)

**Date:** 2026-09-28
**Status:** implemented + deployed; live repro verdict pending (next reset)

## Executed

1. Bundle research (pi 0.87.0, chunk-4DKZACXI.js): `sendUserMessage` routes
   through a SHARED runtime slot (`bindCore` plain slot assignment); a live
   in-process subagent session re-points it at itself. `assertActive()` does
   not detect the re-point.
2. Fixes in `src/index.ts`: D1 delivery verification (post-send jsonl check
   on the owner key + misroute retry, cap 6 -> capitulation), D2 confirm
   gating (owner key + pendingFiredResetAt + tokens > 0; `currentCtx` guard
   against foreign wormsoft responses), D4 file-quiet check. D3 DROPPED
   (conflicts with spec 006 invariant). Review follow-ups applied
   (misroute streak reset on a fresh reset; capitulation cause telemetry).
3. Test infrastructure: `tests/delivery-gating.test.mts` (32 asserts,
   faithful mock that writes the owner jsonl) + `setVerifyDeliveredForTests`
   stub in the 7 old suites + token-bearing default entries in 4 suites.
4. Full suite: 14 files, 640 asserts, 0 FAIL, exit 0. Baseline (git stash)
   confirmed no regression.
5. Deploy: `deploy.ps1` -> `~/.pi/agent/extensions/pi-billing-window`,
   verified identical to src.

## Live observation (reset 17:37:32Z, reset #442, OLD code still running)

3 pi sessions open, 2 reloaded + armed /cont-after-reset:

| Session | Result | Evidence |
|---|---|---|
| RLMvsCodeIndex (pid 712) | resumed | fire:reset-ready 17:37:47 -> send-ok 17:38:32 -> confirmed 17:38:50 |
| c:\Tools (pid 9628) | delivered ~33 min late | lease (keyId d59c13f6, mode=planned) taken 17:38:09 by the sync tick re-plan WITHOUT a fire:reset-ready log; the 17:38:29 watchdog delivery did not happen (no send-ok/send-error in arms.log); watchdog fired 17:41:47 (+0 s) while the agent was streaming -> silent skip; the retry delivered at 18:10:09 (send-ok -> confirmed 18:10:16 -> arm-gone) |

This is the old-code baseline the fix addresses: (a) late re-plan after a
foreign process performed the reset, (b) silent delivery miss between the
sync-tick re-plan and the watchdog (no send-ok/send-error in the log),
(c) streaming-agent skip without a logged reason.

## What the new code changes for the next reset

- The late re-plan + silent dedup hole is covered: a send that resolves but
  does not appear in the owner jsonl logs `fire:send-misroute` and is
  re-driven; a busy/quiet owner logs `block:owner-busy` instead of silence.
- A foreign subagent's flash response can no longer confirm the arm
  (`fire:confirmed` gated by owner key + tokens > 0).

## Live verdict, reset #443 (19:37:32Z) -- detection WORKS, one fix round-trip

The new code detected the misroute IN REAL TIME (no silence): the reloaded
TabDocLoad session (pid 3628) logged `fire:send-misroute` — the send went to
a foreign session. The owner jsonl (17-27-11-381Z) actually DID receive the
user entry at 19:38:32.646 (+17 ms after the send) — pi appends the entry a
few ms AFTER `sendUserMessage` resolves, so the fast file read missed it and
reported a FALSE misroute (the review's theoretical async-append risk,
confirmed live). Follow-up applied: one re-verify after 2.5 s
(`fire:send-reverify`) before declaring a misroute, plus early pacing so the
retry loop cannot re-drive a second parallel send during the grace. New test
B2 (late append -> re-verify -> send-ok, no misroute) — 35 asserts green,
full suite re-run green, redeployed identical to src.

## Live observation, reset #444 (21:37:32Z) -- timing gap between deploys

The re-verify fix was deployed at 21:40:29Z, but BOTH user processes
started earlier (pid 9924 c:\Tools at 20:58:55Z, pid 3628 17-27-11-381Z at
19:10:11Z) and run the FIRST-fix code (no re-verify). Observed: false
misroutes again (the owner jsonl entries 21:38:35.727 / 21:45:56.477 ARE
present), attempts 1-2/6 for pid 9924 -> would capitulate after 6; pid 3628
had attempts 2-5/6 for #443, the fresh reset #444 reset the streak (review
follow-up works live), fire:reset-ready 21:37:35 -> send went to a foreign
session (no log for it). Strengthened the re-verify to a loop of
DELIVERED_REVERIFY_ROUNDS=3 re-reads (2.5/5/7.5 s, cumulative 15 s max)
against a slow jsonl flush. 35 asserts green, suite re-run green, redeployed
identical to src.

## Live confirmation (21:57:13Z) -- bounded capitulation, not silence

pid 3628 (17-27-11-381Z, first-fix code): attempt 6/6 -> `capitulation:after-6`
("после 6 misroute-попыток" -- the misroute-cause telemetry) -> флаг снят,
уведомление отправлено, arm-gone. The review's contract holds live: a
persistent misroute ends in a VISIBLE disarm + notification instead of a
silent loop.

## Live observation, resets #447/#448 (07:38Z / 09:38Z) -- stale-shift defect

c:\Tools (pid 34872): SECOND full live cycle confirmed -- fire:reset-ready
(+0s) -> send -> `fire:send-reverify (rev 1)` caught the late append ->
`fire:send-ok` -> `fire:confirmed` 07:38:49. The re-verify fix works
consistently live.

The 17-27-11-381Z window kept failing with send-error:stale: session-switch
chains (/reload /new) carried the arm key to the newest file, but every
later session-start with a different key was BLOCKED and per spec 006 the
blocked path deliberately does not refresh the captured ctx -- the ctx
stayed dead and the fire could never send. ROOT CAUSE: the "live interest"
check ignored ctx staleness. Fix: the blocked shift now requires
`probePiAlive() === "live"` -- a dead owner ctx lets the shift through so
the delivery follows the user's actual conversation (new session-start
hook path). New test (e) in session-isolation (stale owner ctx -> shift
proceeds, no owner-shift(blocked), key+arms.json move) -- 26 passed there,
full suite re-run green (exit 0 x14), redeployed identical to src.

## Live repro verdict (after user reloads the 2 sessions + /cont-after-reset)

- Both sessions fire on the next reset (19:37:32Z) -> hypothesis about the
  own-marker dedup on the watchdog path NOT confirmed; close T5.
- Still silent -> the new code's `fire:send-misroute` / `block:*` lines in
  arms.log name the remaining hole.
