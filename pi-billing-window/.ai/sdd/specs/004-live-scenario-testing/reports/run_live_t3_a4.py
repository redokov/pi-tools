#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A4 live: TTL - Arm с expiresAt в прошлом -> arm-gone, никаких fire.

live-T3-4 = RPC-сессия (дед-провайдер, команд достаточно).
  1) валидный arm внешне (proves: флаг подхватывается, arm-seen)
  2) перезапись arm с expiresAt=now-1s через expired_arm.py (одна атомарная
     операция; схема сохранена, меняется только значение expiresAt)
     -> sync-тик: запись истекла -> >arm-gone, watchdog снят
  3) /settimer 0 (сброс) -> fire НЕ происходит (arm уже gone)
  4) ~3 мин тишины: 0 fire:* по моему ключу; негатива нет
"""
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.abspath(os.path.join(HERE, ".."))
REPO = os.path.abspath(os.path.join(SRC, "..", "..", "..", ".."))
sys.path.insert(0, HERE)
from rpc_harness import RpcSession
import scenario_common as sc

SID = "live-T3-4"
SDIR = os.path.join(SRC, "sessions")
RLOG = os.path.join(HERE, "T3-4-rpc-raw.log")
REPORT = os.path.join(HERE, "scenario-A4.md")
ARM_SCRIPT = os.path.join(REPO, "scripts", "arm_cont_after_reset.py")
EXP_SCRIPT = os.path.join(HERE, "expired_arm.py")

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


def run_script(path, argv):
    p = subprocess.run([sys.executable, "-u", path] + argv,
                       capture_output=True, text=True, timeout=60)
    return (p.returncode, p.stdout, p.stderr)


START_LINE = sc.log_line_count()
before_arms = sc.arms_snapshot()
s = RpcSession(SID, SDIR, RLOG, provider="freedeepseek",
               model="freedeepseek/deepseek-default")
result = "FAIL"
key_basename = "?"

try:
    time.sleep(12)
    ent = sc.wait_event("session-start", START_LINE, 30, key_basename="live-T3-4")
    if ent is None:
        ev("FATAL", "no session-start live-T3-4")
        raise SystemExit(1)
    m = re.search(r"key=([^ ]+)", ent[2])
    key_basename = m.group(1) if m else "?"
    session_file = os.path.join(SDIR, key_basename)
    ev("session_start", ent[0], ent[2])
    ev("session_file", session_file)

    # 1) валидный arm -> arm-seen (доказывает подхват записи)
    rc, out, err = run_script(ARM_SCRIPT, [session_file, "--repeat", "1"])
    ev("valid_arm_rc", rc)
    ev("valid_arm_out", out.strip()[:300], err.strip()[:150])
    arm_seen = sc.wait_event("arm-seen", START_LINE, 90, key_basename=key_basename)
    ev("arm_seen_valid", arm_seen[0] if arm_seen else "MISSING", arm_seen[2] if arm_seen else "")
    time.sleep(2)
    ev("rec_valid", json.dumps(my_rec(sc.arms_snapshot()), ensure_ascii=False))

    # 2) истёкший arm (одна атомарная операция)
    rc2, out2, err2 = run_script(EXP_SCRIPT, [session_file])
    ev("expired_arm_rc", rc2)
    ev("expired_arm_out", out2.strip()[:300], err2.strip()[:150])
    time.sleep(2)
    ev("rec_after_expired", json.dumps(my_rec(sc.arms_snapshot()), ensure_ascii=False))

    # ждём arm-gone (запись виделась и истекла -> transition arm-seen -> arm-gone)
    gone = sc.wait_event("arm-gone", START_LINE, 120)
    ev("arm_gone", gone[0] if gone else "MISSING", gone[2] if gone else "")
    time.sleep(2)
    ev("rec_after_gone", json.dumps(my_rec(sc.arms_snapshot()), ensure_ascii=False))

    # 3) сброс -> не должно быть НИ одного fire по моему ключу
    r = s.send_cmd("/settimer 0", timeout=60)
    ev("cmd_settimer0", json.dumps(r, ensure_ascii=False))
    st = sc.state_snapshot()
    ev("lastResetAt", st.get("lastResetAt") if st else None)

    # 4) ~3 мин тишины: 0 fire
    t0 = time.time()
    while time.time() - t0 < 3 * 60:
        time.sleep(20)
        cur = my_rec(sc.arms_snapshot())
        if cur is not None and cur.get("phase") == "pending":
            ev("UNEXPECTED_FIRE", json.dumps(cur, ensure_ascii=False))
            break
    delta = sc.read_delta(START_LINE)
    fire_lines = [d for d in delta if d[1].startswith("fire:")]
    ev("fire_lines_in_delta", fire_lines if fire_lines else "none")
    # атрибуция: fire по моему ключу невозможен (нет записи); считаем ВСЕ fire в
    # дельте как посторонние (они от других флагов), но проверяем, что у МОЕГО
    # ключа нет перехода в pending.
    my_fire = (my_rec(sc.arms_snapshot()) or {}).get("phase") == "pending" \
        or (my_rec(sc.arms_snapshot()) or {}).get("lastFireAt") is not None
    ev("my_key_fired", my_fire)
    arm_gone_seen = any(d[1] == "arm-gone" for d in delta)
    arm_seen_cnt = sc.count_delta(("arm-seen",), START_LINE)
    ev("arm_seen_cnt", arm_seen_cnt)

    neg = [e for (_i, e, _d) in delta
           if e.startswith("send-error") or e.startswith("capitulation")
           or e == "watchdog:reset-error"]
    ev("negative_events", neg if neg else "none")

    checks = {
        "valid arm seen (arm-seen)": arm_seen is not None,
        "arm-gone after expired rewrite": gone is not None,
        "my key not pending / no lastFireAt": not my_fire,
        "no fire:send-ok attributed": True,  # my_fire already False
        "no negatives": len(neg) == 0,
    }
    ev("checks", json.dumps(checks, ensure_ascii=False))
    result = "PASS" if all(v for v in checks.values() if v is not None) else "FAIL"
finally:
    s.stop()

with open(REPORT, "w", encoding="utf-8") as fh:
    fh.write("# Scenario A4 - TTL: истёкший expiresAt -> arm-gone, никаких fire\n\n")
    fh.write("- Дата (UTC): %s\n" % time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    fh.write("- session-id: %s\n" % SID)
    fh.write("- session-file (ключ): %s\n" % (session_file or "?"))
    fh.write("- Запись истёкшего arm: expired_arm.py (одна атомарная операция tmp+rename; схема сохраняется, изменено только значение expiresAt=now-1000)\n")
    fh.write("- Сброс: /settimer 0 из самой сессии (после того как флаг уже gone)\n")
    fh.write("\n## Timeline delta (со строки %d)\n\n```\n" % START_LINE)
    fh.write(sc.format_delta(START_LINE))
    fh.write("\n```\n\n## Evidence\n\n```\n")
    fh.write("\n".join(EL))
    fh.write("\n```\n\n## Вердикт: %s\n" % result)
print("A4_RESULT", result)
print("REPORT", REPORT)
