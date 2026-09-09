/**
 * arms.test.mts -- unit tests for src/arms.ts (cont-after-reset flags).
 *
 * Run: .\node_modules\.bin\tsx.cmd tests/arms.test.mts
 */

import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  setPaths,
  resetPaths,
  switchKey,
  carryArmTo,
  arm,
  disarm,
  isArmed,
  getArm,
  resetReadyToFire,
  ARMS_TTL_MS,
  RESET_GRACE_MS,
  type Arm,
} from "../src/arms.ts";

let tmp: string;
let pass = 0;
let fail = 0;

function assert(cond: boolean, name: string): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL  ${name}`);
  }
}

async function main(): Promise<void> {
  tmp = mkdtempSync(join(tmpdir(), "billing-arms-"));
  const af = join(tmp, "arms.json");
  const al = join(tmp, "arms.lock");
  setPaths(af, al);

  // Epoch slightly in the FUTURE relative to the real clock: arms.ts prunes
  // expired records against real Date.now(), so past synthetic times would be
  // treated as already-expired and dropped.
  const T0 = Date.now() + 60_000;

  // --- arm / isArmed / getArm ------------------------------------------------
  switchKey("convA");
  assert(!isArmed(T0), "not armed before arming");
  const a = await arm(1000, T0);
  assert(a !== null, "arm returns an Arm");
  assert(isArmed(T0), "armed after arm()");
  const g = getArm(T0);
  assert(g !== null && g.armedAt === T0, "armedAt = arming time");
  assert(g !== null && g.lastResetAtAtArm === 1000, "records lastResetAtAtArm");
  assert(
    g !== null && g.expiresAt === T0 + ARMS_TTL_MS,
    "expiresAt = armedAt + TTL",
  );

  // --- idempotent re-arm keeps original marker --------------------------------
  await arm(9_000_000, T0 + 60_000); // later reset must NOT overwrite the marker
  const g2 = getArm(T0 + 60_000);
  assert(
    g2 !== null && g2.lastResetAtAtArm === 1000,
    "re-arm keeps original marker",
  );

  // --- /new: carryArmTo moves the record to the new conversation ------------
  await carryArmTo("convB");
  assert(isArmed(T0 + 70_000), "arm survives /new (carried to new conv)");
  const moved = getArm(T0 + 70_000);
  assert(
    moved !== null && moved.lastResetAtAtArm === 1000,
    "carried arm keeps marker",
  );

  // --- /resume to an unrelated conv: repoint only, arm stays behind --------
  switchKey("convOther");
  assert(!isArmed(T0 + 80_000), "other conversation is NOT armed (no carry)");
  // Coming back to convB re-adopts it.
  switchKey("convB");
  assert(isArmed(T0 + 90_000), "back to armed conv is armed again");

  // --- disarm ----------------------------------------------------------------
  assert(await disarm(T0 + 120_000) === true, "disarm removes flag");
  assert(!isArmed(T0 + 120_000), "not armed after disarm");
  assert(await disarm(T0 + 130_000) === false, "second disarm returns false");

  // --- stale record gone after disarm (fresh process points to convA) -------
  switchKey("convA");
  assert(!isArmed(T0 + 140_000), "no stale record for convA after disarm");

  // --- restart survival: arm, then a new process repoints to same key --------
  switchKey("convA");
  await arm(42, T0 + 150_000);
  // simulate a fresh process by resetting module state: re-run arm-only path is
  // same module, so just verify record is on disk under convA and pickable.
  assert(isArmed(T0 + 151_000), "convA armed on disk");
  switchKey("convA");
  assert(isArmed(T0 + 152_000), "re-adopted after restart-like repoint");

  // --- TTL expiry ------------------------------------------------------------
  const expCheck = T0 + 150_000 + ARMS_TTL_MS + 1;
  assert(getArm(expCheck) === null, "getArm returns null after TTL");
  assert(!isArmed(expCheck), "isArmed false after TTL");

  // --- resetReadyToFire (pure, consistent base epoch) ------------------------
  const BASE = Date.now() + 500_000;
  const armX: Arm = {
    armedAt: BASE,
    lastResetAtAtArm: BASE,
    expiresAt: BASE + ARMS_TTL_MS,
  };
  const resetAt = BASE + 60_000; // a reset 60s after arming
  assert(
    !resetReadyToFire(armX, { lastResetAt: resetAt - 2000 }, resetAt),
    "no fire: reset not yet past marker",
  );
  assert(
    resetReadyToFire(armX, { lastResetAt: resetAt }, resetAt + RESET_GRACE_MS + 1),
    "fire: reset after marker and grace elapsed",
  );
  assert(
    !resetReadyToFire(
      armX,
      { lastResetAt: resetAt },
      resetAt + RESET_GRACE_MS - 1,
    ),
    "no fire yet: grace not elapsed",
  );
  assert(
    !resetReadyToFire(armX, { lastResetAt: resetAt }, resetAt - 1),
    "no fire: before reset timestamp",
  );

  // cleanup
  resetPaths();
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (fail > 0) process.exit(1);
}

void main();
