#!/usr/bin/env python3
"""arm_cont_after_reset.py -- external "continue after reset" arming.

Writes/updates an Arm record for a pi conversation session in
~/.pi/agent/pi-billing-window-arms.json so the pi-billing-window extension's
60s sync-poller adopts it and fires "continue" into that conversation on the
next 2-hour billing window reset.

Contract follows src/arms.ts + tests/watchdog.e2e.test.mts scenario 6:
  - key  = absolute path of the session .jsonl file
  - Arm  = { armedAt, lastResetAtAtArm, expiresAt (ms epoch), phase?, lastFireAt?, repeat? }
  - repeat = total fires this arm is good for; absent/1 = one-shot
  - expired records (expiresAt <= now) are pruned on write, like arms.ts
  - atomic write via temp + os.replace; other records are never touched and
    existing fields of the target record are preserved unless overridden.
  - lastResetAtAtArm defaults to 0 (external helper does not know the window
    state; 0 guarantees the next reset fires, exactly as scenario 6).

ASCII-only output. No external dependencies.

Usage:
  python scripts/arm_cont_after_reset.py <session-path|session-id> [--repeat N] [--ttl H]
  python scripts/arm_cont_after_reset.py --check <session-path|session-id>
  python scripts/arm_cont_after_reset.py --remove <session-path|session-id>
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone

ARMS_FILE = os.path.join(
    os.path.expanduser("~"), ".pi", "agent", "pi-billing-window-arms.json"
)
SESSIONS_DIR = os.path.join(os.path.expanduser("~"), ".pi", "agent", "sessions")
DEFAULT_TTL_HOURS = 8
DEFAULT_REPEAT = 1


def now_ms():
    return int(time.time() * 1000)


def iso(ms):
    if ms is None:
        return "-"
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def die(msg):
    print("ERROR: " + msg)
    sys.exit(1)


def load_map(path):
    """Read Arms file as dict; missing/empty/corrupt -> {} (like readArmsSync)."""
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError as exc:
        die("cannot read " + str(path) + ": " + str(exc))
    if not text.strip():
        return {}
    try:
        data = json.loads(text)
    except ValueError as exc:
        die("malformed JSON in " + str(path) + ": " + str(exc))
    if not isinstance(data, dict):
        die("arms file root is not an object: " + str(path))
    return data


def save_map(path, arm_map):
    """Atomic write: temp file next to target, then os.replace (Windows-safe)."""
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp." + str(os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(arm_map, f, indent=2, ensure_ascii=True)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def resolve_session(arg):
    """Resolve session-path or session-id to the absolute .jsonl key.

    A value that looks like a path (contains a separator) or exists on disk is
    used verbatim (abspath). A bare filename is a session-id: search
    ~/.pi/agent/sessions/** for a unique match and return its full path.
    """
    if os.path.sep in arg or "/" in arg or os.path.exists(arg):
        return os.path.abspath(arg)
    name = arg if arg.endswith(".jsonl") else arg + ".jsonl"
    hits = []
    if os.path.isdir(SESSIONS_DIR):
        for root, _dirs, files in os.walk(SESSIONS_DIR):
            for f in files:
                if f == name:
                    hits.append(os.path.join(root, f))
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        die(
            "session-id '%s' matches %d files: %s"
            % (arg, len(hits), "; ".join(sorted(hits)))
        )
    die("session not found: " + arg + " (searched " + SESSIONS_DIR + ")")


def main():
    ap = argparse.ArgumentParser(
        description="External continue-after-reset arming for pi-billing-window."
    )
    ap.add_argument("session", help="session file path or session-id (.jsonl)")
    ap.add_argument(
        "--repeat",
        type=int,
        default=None,
        help="total fires this arm is good for (default %d)" % DEFAULT_REPEAT,
    )
    ap.add_argument(
        "--ttl",
        type=float,
        default=DEFAULT_TTL_HOURS,
        help="arm TTL in hours (default %d)" % DEFAULT_TTL_HOURS,
    )
    ap.add_argument("--check", action="store_true", help="show current record")
    ap.add_argument("--remove", action="store_true", help="delete record")
    ap.add_argument(
        "--file", default=ARMS_FILE, help="arms json path (default %s)" % ARMS_FILE
    )
    args = ap.parse_args()

    if args.check and args.remove:
        die("--check and --remove are mutually exclusive")
    if args.ttl <= 0:
        die("--ttl must be > 0")

    key = resolve_session(args.session)
    arm_map = load_map(args.file)
    now = now_ms()

    # Prune expired records on write, mirroring arms.ts pruneExpired().
    expired = [
        k
        for k, a in arm_map.items()
        if isinstance(a, dict) and a.get("expiresAt", 0) <= now
    ]
    for k in expired:
        del arm_map[k]

    existing = arm_map.get(key)

    if args.check:
        print("CHECK key=%s" % key)
        if existing is None:
            print("  record: none")
            return 0
        print(
            "  armedAt=%s expiresAt=%s repeat=%s"
            % (
                iso(existing.get("armedAt")),
                iso(existing.get("expiresAt")),
                existing.get("repeat", 1),
            )
        )
        print(
            "  phase=%s lastFireAt=%s"
            % (existing.get("phase", "-"), iso(existing.get("lastFireAt")))
        )
        print(
            "  lastResetAtAtArm=%s state=%s"
            % (
                existing.get("lastResetAtAtArm", 0),
                "expired" if existing.get("expiresAt", 0) <= now else "unexpired",
            )
        )
        return 0

    if args.remove:
        if existing is None:
            print("REMOVE key=%s already absent" % key)
            return 0
        del arm_map[key]
        save_map(args.file, arm_map)
        print("REMOVED key=%s" % key)
        return 0

    # --- Arm / update ---
    repeat = args.repeat if args.repeat is not None else DEFAULT_REPEAT
    if repeat < 1:
        die("--repeat must be >= 1")
    ttl_ms = int(args.ttl * 3600 * 1000)

    # Base = existing record (preserves phase/lastFireAt/history where present).
    rec = dict(existing) if isinstance(existing, dict) else {}
    rec["armedAt"] = now
    rec["expiresAt"] = now + ttl_ms
    if args.repeat is not None or "repeat" not in rec:
        rec["repeat"] = repeat
    # Keep an existing lastResetAtAtArm; new records get 0 (fire on next reset).
    rec.setdefault("lastResetAtAtArm", 0)
    rec.setdefault("phase", "armed")

    replaced = existing is not None
    others = len(arm_map) - (1 if replaced else 0)
    arm_map[key] = rec
    save_map(args.file, arm_map)

    print("ARM key=%s" % key)
    print(
        "  armedAt=%s expiresAt=%s (TTL %sh) repeat=%d"
        % (iso(now), iso(rec["expiresAt"]), args.ttl, rec["repeat"])
    )
    print(
        "  lastResetAtAtArm=%s phase=%s"
        % (rec["lastResetAtAtArm"], rec.get("phase", "armed"))
    )
    print(
        "  record=%s; %d other record(s) untouched; %d expired pruned"
        % ("updated" if replaced else "created", others, len(expired))
    )
    print("  file=%s" % args.file)
    return 0


if __name__ == "__main__":
    sys.exit(main())
