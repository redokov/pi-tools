#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A2: repeat=3, 3 resets -> perevzvod 3->2->1->gone (no 4th fire)."""
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, HERE)
from rpc_harness import RpcSession
import scenario_common as sc

SID = "live-A2"
SDIR = os.path.join(SRC, "sessions")
RLOG = os.path.join(HERE, "A2-rpc-raw.log")
REPORT = os.path.join(HERE, "scenario-A2.md")

lines_of_evidence = []


def ev(label, *vals):
    t = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    lines_of_evidence.append(f"[{t}] {label}: " + " | ".join(str(v) for v in vals))


def g_count(name):
    try:
        p = os.path.expanduser("~/.pi/agent/pi-billing-window-arms.log")
        with open(p, encoding="utf-8", errors="replace") as fh:
            return sum(1 for ln in fh if (" " + name + " ") in ln)
    except Exception:
        return 0


def key_rec(armsmap, session_file):
    for k, v in armsmap.items():
        if os.path.normcase(k) == os.path.normcase(session_file):
            return v
    return None


pre = {e: g_count(e) for e in ("fire:reset-ready", "fire:send-ok",
                               "fire:confirmed", "session-start")}
START_LINE = sc.log_line_count()
before_arms = sc.arms_snapshot()
before_state = sc.state_snapshot()

s = RpcSession(SID, SDIR, RLOG)
result = "FAIL"
key_ent = None
session_file = None
try:
    time.sleep(12)
    key_ent = sc.wait_event("session-start", START_LINE, 30, key_basename="live-A2")
    if key_ent is None:
        ev("FATAL", "no session-start live-A2")
        raise SystemExit(1)
    m = re.search(r"key=([^ ]+)", key_ent[2])
    key_basename = m.group(1) if m else "?"
    session_file = os.path.join(SDIR, key_basename)
    ev("session_start", key_ent[0], key_ent[2])
    ev("session_file", session_file)

    r = s.send_cmd("/cont-after-reset 3", timeout=60)
    ev("cmd_cont3", json.dumps(r, ensure_ascii=False))
    arm_seen = sc.wait_event("arm-seen", START_LINE, 30, key_basename=key_basename)
    ev("arm_seen", arm_seen[0] if arm_seen else "MISSING", arm_seen[2] if arm_seen else "")
    time.sleep(2)
    a0 = sc.arms_snapshot()
    r0 = key_rec(a0, session_file)
    ev("arms_after_arm_r3", json.dumps(a0, ensure_ascii=False))

    cycles = []
    for i in range(1, 4):
        ev(f"--- reset #{i} ---")
        r = s.send_cmd("/settimer 0", timeout=60)
        ev(f"cmd_settimer0_{i}", json.dumps(r, ensure_ascii=False))
        st_before = sc.state_snapshot()
        reset_at = st_before.get("lastResetAt") if st_before else None
        cf = sc.wait_event("fire:confirmed", START_LINE, 240)
        ev(f"fire_confirmed_{i}", cf[0] if cf else "MISSING", cf[2] if cf else "")
        so = sc.count_delta(("fire:send-ok",), START_LINE)
        time.sleep(2)
        arms = sc.arms_snapshot()
        rec = key_rec(arms, session_file)
        if i < 3:
            rep = rec.get("repeat") if rec else None
            phase = rec.get("phase", "armed") if rec else None
            lra = rec.get("lastResetAtAtArm") if rec else None
            exp_lra = ("==resetAt(" + str(reset_at) + ")"
                       if lra and reset_at and abs(lra - reset_at) < 2000 else "mismatch")
            ev("arms_after_R%d" % i, json.dumps(arms, ensure_ascii=False))
            ev("repeat/phase/lastResetAtAtArm", rep, phase, exp_lra)
            cycles.append({"repeat": rep, "phase": phase, "lra_align": exp_lra})
        else:
            ev("arms_after_R3", json.dumps(arms, ensure_ascii=False))
            ev("flag_absent_after_R3", rec is None)
            cycles.append({"repeat": None, "flag_absent": rec is None})

    ev("--- extra reset #4 (control, no fire expected) ---")
    r = s.send_cmd("/settimer 0", timeout=60)
    ev("cmd_settimer0_4", json.dumps(r, ensure_ascii=False))
    so_before4 = sc.count_delta(("fire:send-ok",), START_LINE)
    time.sleep(150)
    so_after4 = sc.count_delta(("fire:send-ok",), START_LINE)
    cf4 = sc.count_delta(("fire:confirmed",), START_LINE)
    ev("fourth_fire_check", {"send_ok_before4": so_before4,
                              "send_ok_after4": so_after4, "confirmed_total": cf4})

    neg = [e for (_i, e, _d) in sc.read_delta(START_LINE)
           if e.startswith("send-error") or e.startswith("capitulation")
           or e == "watchdog:reset-error" or e == "replacement:waiting"]
    ev("negative_events", neg if neg else "none")

    send_ok = sc.count_delta(("fire:send-ok",), START_LINE)
    confirmed = sc.count_delta(("fire:confirmed",), START_LINE)
    rr = sc.count_delta(("fire:reset-ready",), START_LINE)
    ev("delta_counts", {"fire:reset-ready": rr, "fire:send-ok": send_ok,
                         "fire:confirmed": confirmed})

    checks = {
        "arm-seen repeat=3": (arm_seen is not None and "repeat=3" in (arm_seen[2] or "")
                               and key_basename in (arm_seen[2] or "")),
        "arms repeat==3 after arm": (r0 or {}).get("repeat") == 3,
        "R1 repeat 3->2": bool(cycles) and cycles[0].get("repeat") == 2,
        "R1 phase armed": bool(cycles) and cycles[0].get("phase") == "armed",
        "R1 lastResetAtAtArm align": bool(cycles) and cycles[0].get("lra_align") not in ("mismatch", "?"),
        "R2 repeat 2->1": len(cycles) > 1 and cycles[1].get("repeat") == 1,
        "R3 flag absent": len(cycles) > 2 and cycles[2].get("flag_absent") is True,
        "fire:confirmed==3 total": confirmed == 3,
        "no 4th send-ok": send_ok == 3 and so_after4 == 3,
        "no negatives": len(neg) == 0,
    }
    ev("checks", json.dumps(checks, ensure_ascii=False))
    result = "PASS" if all(v for v in checks.values() if v is not None) else "FAIL"
finally:
    post = {e: g_count(e) for e in ("fire:reset-ready", "fire:send-ok",
                                    "fire:confirmed", "session-start")}
    s.stop()

with open(REPORT, "w", encoding="utf-8") as fh:
    fh.write("# Scenario A2 - repeat 3x (perevzvod 3->2->1->gone)\n\n")
    fh.write("- DatA (UTC): %s\n" % time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    fh.write("- session-id: %s\n" % SID)
    fh.write("- session-file (kluch): %s\n" % (session_file or "?"))
    fh.write("- session-start: %s | %s\n" % ((key_ent[0] if key_ent else "?"),
                                               (key_ent[2] if key_ent else "")))
    fh.write("- Global counters DO: %s\n" % json.dumps(pre, ensure_ascii=False))
    fh.write("- Global counters POSLE: %s\n" % json.dumps(post, ensure_ascii=False))
    fh.write("- arms.json do: %s\n" % json.dumps(before_arms, ensure_ascii=False))
    fh.write("- state do: %s\n" % json.dumps(
        {k: before_state[k] for k in ("windowStartedAt", "lastResetAt",
                                      "resetCount", "callsInWindow")}
        if before_state else {}, ensure_ascii=False))
    fh.write("\n## Timeline delta (so stroki %d)\n\n```\n" % START_LINE)
    fh.write(sc.format_delta(START_LINE))
    fh.write("\n```\n\n## Evidence\n\n```\n")
    fh.write("\n".join(lines_of_evidence))
    fh.write("\n```\n\n## Verdict: %s\n" % result)
print("A2_RESULT", result)
print("REPORT", REPORT)
