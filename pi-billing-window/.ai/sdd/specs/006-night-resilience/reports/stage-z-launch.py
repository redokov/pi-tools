#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""stage-z-launch.py -- Stage Z (spec 006): финальный ночной выжигатель.

Один фоновый python-процесс, который:
  1) поднимает headless RPC-сессию (рабочая модель wormsoft/zai/glm-5.3-flash)
     с heartbeat-задачей (beat каждые ~40с, RESUMED при доставке «продолжи»);
  2) взводит арм ВНЕШНЕ (arm_cont_after_reset.py --repeat 20), переписывает
     lastResetAtAtArm = текущий lastResetAt (иначе немедленный fire
     «пропущенного сброса» — арм должен ждать РЕАЛЬНОЙ границы);
  3) запускает scripts/scenario_monitor.py (nohup-подобный subprocess,
     poll 300с, отчёт в 006/reports/stage-z-status.log);
  4) держит сессию живой (main loop sleep), останавливается по --max-hours
     или SIGINT/kill.

PASS-критерии ночи (по журналу/heartbeat, проверяются утром):
  - heartbeat растёт после каждого сброса (RESUMED на каждый boundary);
  - fire:confirmed на каждой границе;
  - окна ×2+ (несколько границ подряд);
  - доставка в пределах <=1 backoff-шага (5 мин) после сброса.
"""
import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
R004 = os.path.abspath(os.path.join(HERE, "..", "..", "004-live-scenario-testing", "reports"))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", ".."))
sys.path.insert(0, R004)
from rpc_harness import RpcSession  # noqa: E402
import scenario_common as sc  # noqa: E402

SID = "stagez"
SDIR = os.path.join(R004, "sessions")
RLOG = os.path.join(HERE, "stagez-rpc-raw.log")
HEARTBEAT = os.path.join(HERE, "STAGE-Z-heartbeat.txt")
ARM_SCRIPT = os.path.join(REPO, "scripts", "arm_cont_after_reset.py")
MONITOR_SCRIPT = os.path.join(REPO, "scripts", "scenario_monitor.py")
ARMS_JSON = os.path.join(os.path.expanduser("~"), ".pi", "agent",
                         "pi-billing-window-arms.json")

TASK = (
    "You are a heartbeat agent. Append a line 'beat <current UTC ISO-8601>' to "
    "the file " + HEARTBEAT.replace("\\", "/") + " roughly every 40 seconds, "
    "flushing each write. Keep doing this forever, never terminating your work. "
    "If a new user message arrives containing the word 'continue' (in Cyrillic "
    "'продолжи' or English), append a line 'RESUMED <current UTC ISO-8601>' to "
    "the same file and keep looping and writing beats. Never stop until you "
    "receive the exact message 'стоп'."
)


def ev(label, *vals):
    t = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print(f"[{t}] {label}: " + " | ".join(str(v) for v in vals), flush=True)


def beats():
    try:
        return sum(1 for ln in open(HEARTBEAT, encoding="utf-8", errors="replace")
                   if ln.startswith("beat "))
    except FileNotFoundError:
        return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repeat", type=int, default=20)
    ap.add_argument("--max-hours", type=float, default=12.0)
    args = ap.parse_args()
    start_line = sc.log_line_count()

    s = RpcSession(SID, SDIR, RLOG)
    time.sleep(12)
    ent = sc.wait_event("session-start", start_line, 30, key_basename=SID)
    if ent is None:
        ev("FATAL", "нет session-start stagez")
        return 1
    key_base = ent[2].split("key=")[1].split(" ")[0]
    session_file = os.path.join(SDIR, key_base)
    ev("session_start", ent[0], ent[2][:150])
    ev("session_file", session_file)
    ev("heartbeat_file", HEARTBEAT)

    # heartbeat-задача
    s.proc.stdin.write(json.dumps(
        {"type": "prompt", "message": TASK}, ensure_ascii=False).encode("utf-8") + b"\n")
    s.proc.stdin.flush()
    ev("heartbeat_task_started", "fire-and-forget")
    for _ in range(12):
        if beats() >= 1:
            break
        time.sleep(10)
    ev("beats_before_arm", beats())

    # внешний взвод: repeat=20
    p = subprocess.run([sys.executable, "-u", ARM_SCRIPT, session_file,
                        "--repeat", str(args.repeat)],
                       capture_output=True, text=True, timeout=60)
    ev("arm_rc", p.returncode, (p.stdout or "").strip()[:200], (p.stderr or "").strip()[:150])
    if p.returncode != 0:
        p = subprocess.run([sys.executable, "-u", ARM_SCRIPT, session_file,
                            "--repeat", str(args.repeat)],
                           capture_output=True, text=True, timeout=60)
        ev("arm_rc_retry", p.returncode)
    # lastResetAtAtArm = текущий lastResetAt (арм ждёт РЕАЛЬНОЙ границы)
    st = sc.state_snapshot() or {}
    cur_reset = int(st.get("lastResetAt") or 0)
    if cur_reset > 0:
        try:
            with open(ARMS_JSON, encoding="utf-8") as fh:
                arms_map = json.load(fh)
            norm = os.path.normcase(os.path.abspath(session_file))
            tgt = next((k for k in arms_map
                        if os.path.normcase(os.path.abspath(k)) == norm), None)
            if tgt is not None:
                arms_map[tgt]["lastResetAtAtArm"] = cur_reset
                tmp = ARMS_JSON + ".tmp-sz"
                with open(tmp, "w", encoding="utf-8") as fh:
                    json.dump(arms_map, fh, ensure_ascii=False, indent=2)
                os.replace(tmp, ARMS_JSON)
                ev("lastResetAtAtArm_rewritten", cur_reset)
        except Exception as e:
            ev("WARN_rewrite", str(e))

    # монитор в фоне (detached)
    try:
        subprocess.Popen([sys.executable, "-u", MONITOR_SCRIPT,
                          "--heartbeat", HEARTBEAT,
                          "--poll-secs", "300",
                          "--max-hours", str(args.max_hours),
                          "--session", session_file,
                          "--report", os.path.join(HERE, "stage-z-status.log")],
                         stdout=open(os.path.join(HERE, "stage-z-monitor-console.log"), "ab"),
                         stderr=subprocess.STDOUT)
        ev("monitor_started", "poll 300s")
    except Exception as e:
        ev("WARN_monitor", str(e))

    ev("STAGE_Z_RUNNING", "repeat=%d" % args.repeat, "main loop держит сессию живой")
    deadline = time.time() + args.max_hours * 3600
    last_beats = beats()
    try:
        while time.time() < deadline:
            time.sleep(300)
            b = beats()
            if b > last_beats:
                ev("heartbeat_growth", f"{last_beats} -> {b}")
            last_beats = b
            if not s.alive():
                ev("WARN", "RPC-сессия умерла -- перезапуск с тем же session-file")
                s.stop()
                s = RpcSession(SID, SDIR, RLOG)
                time.sleep(12)
    except KeyboardInterrupt:
        pass
    finally:
        s.stop()
    ev("STAGE_Z_DONE", "beats_total=%d" % beats())
    return 0


if __name__ == "__main__":
    sys.exit(main())
