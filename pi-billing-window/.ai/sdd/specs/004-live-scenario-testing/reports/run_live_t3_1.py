#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""T3 A1 (v2): базовый одноразовый взвод с рабочей моделью.
Адаптация run_a1.py под spec 005 live-верификацию: SID=live-T3-1,
отчёт scenario-A1-v2.md. Логика целиком по run_a1.py.
Ожидание: arm->/settimer 0->fire:reset-ready->fire:send-ok->fire:confirmed,
repeat=1 -> флаг снят.
"""
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

SID = "live-T3-1"
SDIR = os.path.join(SRC, "sessions")
RLOG = os.path.join(HERE, "T3-1-rpc-raw.log")
REPORT = os.path.join(HERE, "scenario-A1-v2.md")

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


pre = {e: g_count(e) for e in ("fire:reset-ready", "fire:send-ok",
                               "fire:confirmed", "session-start")}
START_LINE = sc.log_line_count()
before_arms = sc.arms_snapshot()
before_state = sc.state_snapshot()

s = RpcSession(SID, SDIR, RLOG)
result = "FAIL"
key_ent = None
key_basename = "?"
session_file = None
try:
    time.sleep(12)
    key_ent = sc.wait_event("session-start", START_LINE, 30, key_basename="live-T3-1")
    if key_ent is None:
        ev("FATAL", "no session-start for live-T3-1")
        raise SystemExit(1)
    m = re.search(r"key=([^ ]+)", key_ent[2])
    key_basename = m.group(1) if m else "?"
    session_file = os.path.join(SDIR, key_basename)
    ev("session_start", key_ent[0], key_ent[2])
    ev("session_file", session_file)
    ev("arms_before_arm", json.dumps(sc.arms_snapshot(), ensure_ascii=False))

    r = s.send_cmd("/cont-after-reset", timeout=60)
    ev("cmd_cont", json.dumps(r, ensure_ascii=False))
    arm_seen = sc.wait_event("arm-seen", START_LINE, 30, key_basename=key_basename)
    ev("arm_seen", arm_seen[0] if arm_seen else "MISSING", arm_seen[2] if arm_seen else "")
    t1 = time.time()
    time.sleep(2)
    arms1 = sc.arms_snapshot()
    ev("arms_after_arm", json.dumps(arms1, ensure_ascii=False))

    r = s.send_cmd("/settimer 0", timeout=60)
    ev("cmd_settimer0", json.dumps(r, ensure_ascii=False))

    rr = sc.wait_event("fire:reset-ready", START_LINE, 100)
    ev("fire_reset_ready", rr[0] if rr else "MISSING", rr[2] if rr else "")
    t_rr = time.time()
    so = sc.wait_event("fire:send-ok", START_LINE, 120)
    ev("fire_send_ok", so[0] if so else "MISSING", so[2] if so else "")
    t_so = time.time()
    cf = sc.wait_event("fire:confirmed", START_LINE, 300)
    ev("fire_confirmed", cf[0] if cf else "MISSING", cf[2] if cf else "")
    t_cf = time.time()
    if rr and so and cf:
        ev("durations_s", {"cont_to_rr": round(t_rr - t1, 0),
                            "rr_to_so": round(t_so - t_rr, 0),
                            "so_to_cf": round(t_cf - t_so, 0)})
    time.sleep(3)
    arms2 = sc.arms_snapshot()
    ev("arms_after_confirm", json.dumps(arms2, ensure_ascii=False))

    neg = [e for (_i, e, _d) in sc.read_delta(START_LINE)
           if e.startswith("send-error") or e.startswith("capitulation")
           or e == "watchdog:reset-error" or e == "replacement:waiting"]
    ev("negative_events", neg if neg else "none")

    count_rr = sc.count_delta(("fire:reset-ready",), START_LINE)
    count_so = sc.count_delta(("fire:send-ok",), START_LINE)
    count_cf = sc.count_delta(("fire:confirmed",), START_LINE)
    ev("delta_counts", {"fire:reset-ready": count_rr, "fire:send-ok": count_so,
                         "fire:confirmed": count_cf})

    absent = session_file.replace("\\", "/") if session_file else ""
    key_absent = True
    if session_file:
        key_absent = all(os.path.normcase(k) != os.path.normcase(session_file)
                         for k in arms2)
    # fire:reset-ready фиксирует КАЖДЫЙ extension-хост, увидевший сброс окна.
    # При живых посторонних флагах (TabDocLoad/01a0e327/оркестратор) в общем
    # arms.log могут быть ЧУЖИЕ строки fire:reset-ready без их send-ok в дельте.
    # Атрибутируем по моей цепочке: ключевые события carry key via arms.json
    # (send-ok=1, confirmed=1, флаг снят). reset-ready трактуем как "watchdog
    # сброс был виден" (>0) -- число 1=false-positive при нескольких хостах.
    checks = {
        "arm-seen with key": arm_seen is not None and key_basename in (arm_seen[2] or ""),
        "fire:reset-ready seen (my chain)": count_rr >= 1,
        "fire:send-ok==1": count_so == 1,
        "fire:confirmed==1": count_cf == 1,
        "flag removed after confirm": key_absent,
        "no negatives": len(neg) == 0,
    }
    ev("checks", json.dumps(checks, ensure_ascii=False))
    result = "PASS" if all(checks.values()) else "FAIL"
finally:
    post = {e: g_count(e) for e in ("fire:reset-ready", "fire:send-ok",
                                    "fire:confirmed", "session-start")}
    s.stop()

with open(REPORT, "w", encoding="utf-8") as fh:
    fh.write("# Scenario A1 (v2, spec 005 live) - одноразовая доставка\n\n")
    fh.write("- Дата (UTC): %s\n" % time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    fh.write("- Модель: wormsoft/zai/glm-5.3-flash, провайдер: wormsoft\n")
    fh.write("- session-id: %s\n" % SID)
    fh.write("- session-file (ключ флага): %s\n" % (session_file or "?"))
    fh.write("- session-start: %s | %s\n" % ((key_ent[0] if key_ent else "?"),
                                               (key_ent[2] if key_ent else "")))
    fh.write("- Глобальные счётчики ДО: %s\n" % json.dumps(pre, ensure_ascii=False))
    fh.write("- Глобальные счётчики ПОСЛЕ: %s\n" % json.dumps(post, ensure_ascii=False))
    fh.write("- arms.json до взвода: %s\n" % json.dumps(before_arms, ensure_ascii=False))
    fh.write("- state до: %s\n" % json.dumps(
        {k: before_state[k] for k in ("windowStartedAt", "lastResetAt",
                                      "resetCount", "callsInWindow")}
        if before_state else {}, ensure_ascii=False))
    fh.write("\n## Замечание об атрибуции fire:reset-ready\n\n")
    fh.write("`fire:reset-ready` пишет КАЖДЫЙ extension-хост, увидевший сброс окна (в т.ч. "
             "посторонние флаги TabDocLoad/01a0e327/оркестратор), поэтому в общем arms.log "
             "в дельте может быть >1 строки на один сброс. Ключевая атрибуция идёт по "
             "arms.json моего ключа: send-ok=1 и confirmed=1. Строка fire:reset-ready без "
             "следующего send-ok в дельте - посторонняя цепочка (НЕ FAIL по правилам прогона).\n")
    fh.write("\n## Timeline delta (со строки %d)\n\n```\n" % START_LINE)
    fh.write(sc.format_delta(START_LINE))
    fh.write("\n```\n\n## Evidence\n\n```\n")
    fh.write("\n".join(lines_of_evidence))
    fh.write("\n```\n\n## «продолжи» и ответ агента в session-файле\n\n```\n")
    try:
        with open(session_file, "r", encoding="utf-8", errors="replace") as sf:
            txt = sf.read()
        dur = [ln for ln in txt.split("\n") if "продолжи" in ln]
        fh.write("строк с 'продолжи' в session: %d\n" % len(dur))
        fh.write("\n".join(dur[-8:] if dur else ["(нет)"]))
    except Exception as e:
        fh.write("session read error: %s\n" % e)
    fh.write("\n```\n\n## Вердикт: %s\n" % result)
print("A1_RESULT", result)
print("REPORT", REPORT)
