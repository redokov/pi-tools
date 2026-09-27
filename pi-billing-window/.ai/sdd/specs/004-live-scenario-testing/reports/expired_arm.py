#!/usr/bin/env python3
"""expired_arm.py -- write/overwrite an Arm record with expiresAt in the PAST
(now - 1000 ms), schema identical to src/arms.ts / scripts/arm_cont_after_reset.py.
Only the single key given is written; other records are untouched (no prune,
minimal side effect). Write is atomic (temp + os.replace).

Usage:
  python expired_arm.py <session-file-absolute|session-id>
"""
import argparse
import json
import os
import sys
import time

ARMS_FILE = os.path.join(os.path.expanduser("~"), ".pi", "agent",
                         "pi-billing-window-arms.json")
SESSIONS_DIR = os.path.join(os.path.expanduser("~"), ".pi", "agent", "sessions")


def resolve(arg):
    if os.path.sep in arg or "/" in arg or os.path.exists(arg):
        return os.path.abspath(arg)
    name = arg if arg.endswith(".jsonl") else arg + ".jsonl"
    hits = []
    if os.path.isdir(SESSIONS_DIR):
        for root, _ds, files in os.walk(SESSIONS_DIR):
            for f in files:
                if f == name:
                    hits.append(os.path.join(root, f))
    if len(hits) == 1:
        return hits[0]
    sys.exit("ERROR: session not found: " + arg)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session")
    ap.add_argument("--file", default=ARMS_FILE)
    args = ap.parse_args()
    key = resolve(args.session)
    with open(args.file, "r", encoding="utf-8") as fh:
        arm_map = json.load(fh)
    now = int(time.time() * 1000)
    # Schema identical to arms.ts Arm; only expiresAt points into the past.
    arm_map[key] = {
        "armedAt": now,
        "lastResetAtAtArm": 0,
        "expiresAt": now - 1000,
        "phase": "armed",
        "repeat": 1,
    }
    tmp = args.file + ".tmp." + str(os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(arm_map, fh, indent=2, ensure_ascii=True)
        fh.write("\n")
    os.replace(tmp, args.file)
    print("EXPIRED_ARM key=%s" % key)
    print("  expiresAt=%d (now-1000) -> already expired at write" % (now - 1000))
    print("  records=%d total, others untouched" % len(arm_map))


if __name__ == "__main__":
    main()
