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
  markFired,
  confirmSuccess,
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

  // --- markFired: pending phase + TTL extension -----------------------------
  switchKey("convP");
  const aP = await arm(7, T0 + 200_000);
  assert(aP !== null, "markFired: arm exists before firing");
  const fired = await markFired(T0 + 210_000);
  assert(fired !== null, "markFired returns the arm");
  const mp = getArm(T0 + 211_000);
  assert(mp?.phase === "pending", "markFired: phase = pending");
  assert(
    mp?.lastFireAt === T0 + 210_000,
    "markFired: lastFireAt recorded",
  );
  assert(
    mp !== null && mp.expiresAt === T0 + 200_000 + ARMS_TTL_MS,
    "markFired: does not shrink a longer existing TTL",
  );

  // markFired: extends a near-expiry arm to at least 1h from firing.
  switchKey("convS");
  const rawMap: Record<string, Arm> = JSON.parse(
    fs.readFileSync(af, "utf8"),
  );
  rawMap["convS"] = {
    armedAt: T0 + 230_000 - 60_000,
    lastResetAtAtArm: 1,
    expiresAt: T0 + 230_000 + 30 * 60_000, // only 30 min left
  };
  fs.writeFileSync(af, JSON.stringify(rawMap, null, 2), "utf8");
  const firedShort = await markFired(T0 + 230_000);
  assert(
    firedShort?.expiresAt === T0 + 230_000 + 60 * 60 * 1000,
    "markFired: extends a near-expiry arm to 1h",
  );

  // markFired with no arm under the current key -> null.
  switchKey("convQ");
  assert(
    await markFired(T0 + 240_000) === null,
    "markFired: null when no arm for the current key",
  );

  // --- confirmSuccess: removes ONLY a pending arm ---------------------------
  switchKey("convR");
  await arm(8, T0 + 250_000);
  assert(
    await confirmSuccess(T0 + 251_000) === false,
    "confirmSuccess: false while still phase=armed",
  );
  assert(isArmed(T0 + 252_000), "confirmSuccess: armed arm survives");
  switchKey("convP");
  assert(
    await confirmSuccess(T0 + 253_000) === true,
    "confirmSuccess: removes a pending arm",
  );
  assert(
    !isArmed(T0 + 254_000),
    "confirmSuccess: pending arm gone after confirmation",
  );
  assert(
    await confirmSuccess(T0 + 255_000) === false,
    "confirmSuccess: second call returns false (already gone)",
  );

  // --- repeat>1: confirmation re-arms instead of deleting -------------------
  switchKey("convRep3");
  const aRep3 = await arm(11, T0 + 300_000, 3);
  assert(aRep3?.repeat === 3, "repeat: arm stores repeat=3");
  await markFired(T0 + 310_000);
  assert(
    (await confirmSuccess(T0 + 320_000, { lastResetAt: 777 })) === true,
    "repeat: confirmation of a pending repeat arm returns true",
  );
  const reA = getArm(T0 + 321_000);
  assert(reA !== null, "repeat: arm survives confirmation");
  assert(reA?.repeat === 2, "repeat: decremented to 2");
  assert(reA?.phase === "armed", "repeat: phase back to armed");
  assert(
    reA?.lastResetAtAtArm === 777,
    "repeat: lastResetAtAtArm = passed lastResetAt",
  );
  assert(reA?.armedAt === T0 + 320_000, "repeat: armedAt = confirmation time");
  assert(
    reA?.expiresAt === T0 + 320_000 + ARMS_TTL_MS,
    "repeat: fresh TTL counted from confirmation time",
  );
  assert(
    reA?.lastFireAt === undefined,
    "repeat: lastFireAt dropped on re-arm",
  );

  // Chained: repeat 2 -> confirm -> repeat 1 -> confirm removes (2 fires).
  switchKey("convRep2");
  await arm(12, T0 + 330_000, 2);
  await markFired(T0 + 335_000);
  await confirmSuccess(T0 + 340_000, { lastResetAt: 5 });
  assert(
    getArm(T0 + 341_000)?.repeat === 1,
    "repeat: 2 -> 1 after the first confirmation",
  );
  await markFired(T0 + 345_000);
  assert(
    (await confirmSuccess(T0 + 350_000, { lastResetAt: 6 })) === true,
    "repeat: final confirmation handled",
  );
  assert(
    !isArmed(T0 + 351_000),
    "repeat: record removed once the last repetition is confirmed",
  );

  // --- repeat=1 (explicit) and no-repeat keep one-shot behaviour -----------
  switchKey("convRep1");
  await arm(13, T0 + 360_000, 1);
  await markFired(T0 + 365_000);
  assert(
    (await confirmSuccess(T0 + 370_000, { lastResetAt: 9 })) === true,
    "repeat=1: confirmation returns true (removed)",
  );
  assert(!isArmed(T0 + 371_000), "repeat=1: record removed");

  switchKey("convRepAbsent");
  await arm(14, T0 + 380_000);
  await markFired(T0 + 385_000);
  await confirmSuccess(T0 + 390_000, { lastResetAt: 9 });
  assert(
    !isArmed(T0 + 391_000),
    "no repeat field: classic one-shot removal preserved",
  );

  // --- omitted lastResetAt defaults to 0 (fires on any later reset) --------
  switchKey("convRepDefault");
  await arm(15, T0 + 400_000, 4);
  await markFired(T0 + 405_000);
  await confirmSuccess(T0 + 410_000); // no opts
  const reDef = getArm(T0 + 411_000);
  assert(
    reDef?.repeat === 3 && reDef?.lastResetAtAtArm === 0,
    "repeat: omitted lastResetAt defaults to 0",
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
