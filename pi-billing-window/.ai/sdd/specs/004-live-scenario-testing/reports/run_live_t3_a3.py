#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A3 live: external arming of a HEADLESS (non-TUI) session + delivery.

live-T3-3 = headless RPC-сессия (non-interactive, НЕ вооружается командой
/cont-after-reset) c задачей heartbeat-цикла. Флаг пишется ВНЕШНЕ с помощью
scripts/arm_cont_after_reset.py --repeat 1 -> sync-поллер подхватывает
(arm-seen <=60s). Сброс окна -> драйвер-команда /settimer 0 ИЗ ДРУГОЙ
RPC-сессии (live-T3-3-drv) -> доставка "продолжи" в headless-сессию ->
агент отвечает RESUMED в A3-heartbeat.txt -> fire:confirmed, флаг снят.

DEVIATION: вместо pi --print используем pi --mode rpc (головая сессия без
TUI/команд-взвода). Свойство сценария (внешний взвод, а не /cont-after-reset)
сохранено. В --print цикл heartbeat ненадёжно держит процесс живым; RPC-сессия
остаётся живой, пока открыт stdin.
"""
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.abspath(os.path.join(HERE, ".."))
REPO = os.path.abspath(os.path.join(SRC, "..", "..", "..", ".."))  # pi-billing-window
sys.path.insert(0, HERE)
from rpc_harness import RpcSession
import scenario_common as sc

SID = "live-T3-3"
SDIR = os.path.join(SRC, "sessions")
HEARTBEAT = os.path.join(SDIR, "A3-heartbeat.txt")
RLOG = os.path.join(HERE, "T3-3-rpc-raw.log")
RLOG_DRV = os.path.join(HERE, "T3-3-drv-rpc-raw.log")
REPORT = os.path.join(HERE, "scenario-A3.md")
ARM_SCRIPT = os.path.join(REPO, "scripts", "arm_cont_after_reset.py")

EL = []


def ev(label, *vals):
    t = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    EL.append(f"[{t}] {label}: " + " | ".join(str(v) for v in vals))
    print(f"[{t}] {label}: " + " | ".join(str(v) for v in vals), flush=True)


session_file = None


def my_rec(rec=None):
    arms = rec if rec is not None else sc.arms_snapshot()
    if session_file is None:
        return None
    for k, v in arms.items():
        if os.path.normcase(k) == os.path.normcase(session_file):
            return v
    return None


def run_arm(argv):
    p = subprocess.run([sys.executable, "-u", ARM_SCRIPT] + argv,
                       capture_output=True, text=True, timeout=60)
    return (p.returncode, p.stdout, p.stderr)


TASK = (
    "You are a heartbeat agent. Append a line 'beat <current UTC ISO-8601>' to "
    "the file " + HEARTBEAT.replace("\\", "/") + " roughly every 40 seconds, "
    "flushing each write. Keep doing this forever, never terminating your work. "
    "If a new user message arrives containing the word 'continue' (in Cyrillic "
    "'продолжи' or English), append a line 'RESUMED <current UTC ISO-8601>' to "
    "the same file and keep looping and writing beats. Never stop until you "
    "receive the exact message 'стоп'."
)

START_LINE = sc.log_line_count()
before_arms = sc.arms_snapshot()

headless = None
drv = None
result = "FAIL"
key_basename = "?"

try:
    # --- 1. headless heartbeat session (working model, will respond) ---
    headless = RpcSession(SID, SDIR, RLOG)
    time.sleep(12)
    ent = sc.wait_event("session-start", START_LINE, 30, key_basename="live-T3-3")
    if ent is None:
        ev("FATAL", "no session-start live-T3-3")
        raise SystemExit(1)
    m = re.search(r"key=([^ ]+)", ent[2])
    key_basename = m.group(1) if m else "?"
    session_file = os.path.join(SDIR, key_basename)
    ev("session_start", ent[0], ent[2])
    ev("session_file", session_file)
    ev("heartbeat_file", HEARTBEAT)

    # start heartbeat task on the headless session (fire-and-forget: RPC
    # может не вернуть response-команду для обычного промпта, не ждём)
    payload = {"type": "prompt", "message": TASK}
    headless.proc.stdin.write(
        json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n")
    headless.proc.stdin.flush()
    ev("heartbeat_task_started", "fire-and-forget")
    # дожидаемся первого beat (агент жив, цикл работает)
    beats_before = 0
    for _ in range(6):
        try:
            beats_before = sum(1 for _ln in open(HEARTBEAT, encoding="utf-8", errors="replace")
                               if _ln.startswith("beat "))
        except FileNotFoundError:
            beats_before = 0
        if beats_before >= 1:
            break
        time.sleep(10)
    ev("beats_before_arm", beats_before)
    if beats_before < 1:
        ev("WARN", "no heartbeat yet -- continue anyway")

    # --- 2. external arming ---
    rc, out, err = run_arm([session_file, "--repeat", "1"])
    ev("external_arm_rc", rc)
    ev("external_arm_out", out.strip()[:400], err.strip()[:200])
    t_arm = time.time()
    arm_seen = sc.wait_event("arm-seen", START_LINE, 90, key_basename=key_basename)
    ev("arm_seen", arm_seen[0] if arm_seen else "MISSING", arm_seen[2] if arm_seen else "")
    arm_seen_sec = round(time.time() - t_arm, 1) if arm_seen else None
    ev("arm_seen_sec", arm_seen_sec)
    time.sleep(2)
    a1 = sc.arms_snapshot()
    ev("arms_after_external_arm", json.dumps(a1, ensure_ascii=False))
    rec_after = my_rec(a1)
    ev("my_rec_external", json.dumps(rec_after, ensure_ascii=False))

    # --- 3. reset via DRIVER RPC session (/settimer 0 не из headless) ---
    drv = RpcSession(SID + "-drv", SDIR, RLOG_DRV, provider="freedeepseek",
                    model="freedeepseek/deepseek-default")
    time.sleep(12)
    rd = drv.send_cmd("/settimer 0", timeout=60)
    ev("drive_cmd_settimer0", json.dumps(rd, ensure_ascii=False))
    st = sc.state_snapshot()
    ev("lastResetAt_after_drive", st.get("lastResetAt") if st else None)

    # ждём доставку: моя запись -> pending (send-ok) в <=6 мин
    pend = None
    deadline = time.time() + 360
    while time.time() < deadline:
        cur = my_rec(sc.arms_snapshot())
        if cur and cur.get("phase") == "pending":
            pend = cur
            break
        time.sleep(5)
    # fix(race): доставка может уложиться ДО запуска опроса (fire прямо на
    # arm-seen, когда окно уже было сброшено) и флаг успевает сгореть —
    # тогда phase==pending уже не увидеть. Считаем доказательством и строку
    # fire:send-ok в armslog по нашему key.
    send_ok_lines = [d for d in sc.read_delta(START_LINE)
                     if d[1] == "fire:send-ok" and key_basename in (d[2] or "")]
    ev("send_ok_pending", json.dumps(pend, ensure_ascii=False) if pend else "MISSING")
    ev("send_ok_armslog_lines", [f"{d[0]} {d[2][:80]}" for d in send_ok_lines] or "none")
    t_so = time.time()

    # ждём подтверждение: агент ответил RESUMED -> fire:confirmed, флаг снят
    gone = False
    deadline = time.time() + 360
    while time.time() < deadline:
        cur = my_rec(sc.arms_snapshot())
        if cur is None:
            gone = True
            break
        time.sleep(5)
    ev("flag_removed_after_confirm", gone)
    cf = [d for d in sc.read_delta(START_LINE) if d[1] == "fire:confirmed"]
    ev("fire_confirmed_lines", cf if cf else "none")
    ev("so_to_flag_removed_s", round(time.time() - t_so, 0) if gone else None)

    # --- 4. heartbeat / RESUMED evidence ---
    time.sleep(2)
    try:
        beats = [ln.strip() for ln in open(HEARTBEAT, encoding="utf-8", errors="replace")
                 if ln.strip()]
    except FileNotFoundError:
        beats = []
    resumed = [b for b in beats if b.startswith("RESUMED")]
    ev("heartbeat_tail", beats[-12:] if beats else "(файл пуст)")
    ev("resumed_lines", resumed if resumed else "none")

    neg = [e for (_i, e, _d) in sc.read_delta(START_LINE)
           if e.startswith("send-error") or e.startswith("capitulation")
           or e == "watchdog:reset-error"]
    ev("negative_events", neg if neg else "none")

    checks = {
        "external arm accepted (key)": rec_after is not None and rec_after.get("repeat") == 1,
        "arm-seen <=60s": arm_seen is not None and arm_seen_sec is not None and arm_seen_sec <= 60,
        "send-ok (phase pending)": pend is not None or len(send_ok_lines) > 0,
        "flag removed (confirmed)": gone,
        "RESUMED in heartbeat": len(resumed) >= 1,
        "no negatives": len(neg) == 0,
    }
    ev("checks", json.dumps(checks, ensure_ascii=False))
    result = "PASS" if all(v for v in checks.values() if v is not None) else "FAIL"
finally:
    if drv is not None:
        drv.stop()
    if headless is not None:
        headless.stop()

with open(REPORT, "w", encoding="utf-8") as fh:
    fh.write("# Scenario A3 - внешний взвод headless-сессии + доставка\n\n")
    fh.write("- Дата (UTC): %s\n" % time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    fh.write("- session-id (headless): %s  |  driver: %s-drv\n" % (SID, SID))
    fh.write("- session-file (ключ): %s\n" % (session_file or "?"))
    fh.write("- метод взвода: scripts/arm_cont_after_reset.py --repeat 1 (внешняя запись arms.json)\n")
    fh.write("- метод сброса: /settimer 0 из отдельной RPC-сессии-driver\n")
    fh.write("- DEVIATION: головая сессия = pi --mode rpc вместо pi --print (цикл heartbeat надёжно держит процесс)\n")
    fh.write("\n## Timeline delta (со строки %d)\n\n```\n" % START_LINE)
    fh.write(sc.format_delta(START_LINE))
    fh.write("\n```\n\n## Evidence\n\n```\n")
    fh.write("\n".join(EL))
    fh.write("\n```\n\n## Вердикт: %s\n" % result)
print("A3_RESULT", result)
print("REPORT", REPORT)
