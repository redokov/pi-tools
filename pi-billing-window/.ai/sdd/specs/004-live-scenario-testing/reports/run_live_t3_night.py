#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""spec 005 NIGHT-MINI live: fire-once-per-window (429-night scenario).

Сессия live-T3-2 с НЕрабочим провайдером (freedeepseek:9655 не слушается =
ночь/429: успешного ответа нет -> pending сохраняется, подтверждения нет,
ровно как продакшн-кейс 2026-09-27).

Поток (FR1/FR2):
  1. /cont-after-reset 3 -> arm-seen (repeat=3)
  2. /settimer 0 (reset#1) -> fire:reset-ready -> fire:send-ok#1 (my key -> pending)
  3. 15 мин тишины без сбросов: НЕТ новых fire:send-ok для моего ключа
     (старый код слал бы 3 штуки за 15 мин при RETRY_AFTER_FIRE_MS=5m)
  4. /settimer 0 (reset#2) -> РОВНО ОДИН новый fire:send-ok#2 (<=5 мин, retryTick)
  5. 5 мин тишины: повторов нет

Атрибуция по ключу: markFired() меняет lastFireAt/phase у МОЕЙ записи arms.json;
каждая fire:send-ok моего процесса = переход pending (новая lastFireAt).
Посторонние флаги (TabDocLoad/01a0e327/оркестратор) дают свои fire:send-ok в
общий arms.log при моих /settimer 0 -- они НЕ считаются (дельта arms.json по
моему ключу + совпадение таймстемпов с fire:send-ok).
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

SID = "live-T3-2"
SDIR = os.path.join(SRC, "sessions")
RLOG = os.path.join(HERE, "T3-2-night-rpc-raw.log")
REPORT = os.path.join(HERE, "scenario-005-night-mini.md")

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


START_LINE = sc.log_line_count()
before_arms = sc.arms_snapshot()
before_state = sc.state_snapshot()

s = RpcSession(SID, SDIR, RLOG, provider="freedeepseek",
               model="freedeepseek/deepseek-default")
result = "FAIL"
key_ent = None
key_basename = "?"

try:
    time.sleep(12)
    key_ent = sc.wait_event("session-start", START_LINE, 30, key_basename="live-T3-2")
    if key_ent is None:
        ev("FATAL", "no session-start live-T3-2")
        raise SystemExit(1)
    m = re.search(r"key=([^ ]+)", key_ent[2])
    key_basename = m.group(1) if m else "?"
    session_file = os.path.join(SDIR, key_basename)
    ev("session_start", key_ent[0], key_ent[2])
    ev("session_file", session_file)

    # ---- step 1: arm repeat=3 ----
    r = s.send_cmd("/cont-after-reset 3", timeout=60)
    ev("cmd_cont3", json.dumps(r, ensure_ascii=False))
    arm_seen = sc.wait_event("arm-seen", START_LINE, 30, key_basename=key_basename)
    ev("arm_seen", arm_seen[0] if arm_seen else "MISSING", arm_seen[2] if arm_seen else "")
    time.sleep(2)
    a0 = sc.arms_snapshot()
    rec0 = my_rec(a0)
    ev("state_after_arm", json.dumps(a0, ensure_ascii=False))
    ev("my_rec_after_arm", json.dumps(rec0, ensure_ascii=False))

    # ---- step 2: reset#1 -> fire:send-ok#1 ----
    r = s.send_cmd("/settimer 0", timeout=60)
    ev("cmd_settimer0_R1", json.dumps(r, ensure_ascii=False))
    st_r1 = sc.state_snapshot()
    reset1_at = st_r1.get("lastResetAt") if st_r1 else None
    ev("reset1_lastResetAt", reset1_at)
    last_fire1 = None
    cur0 = my_rec(sc.arms_snapshot())
    last_fire1 = cur0.get("lastFireAt") if cur0 else None
    deadline = time.time() + 240
    f1 = None
    while time.time() < deadline:
        cur = my_rec(sc.arms_snapshot())
        if cur and cur.get("lastFireAt") is not None and cur.get("lastFireAt") != last_fire1:
            f1 = cur["lastFireAt"]
            break
        time.sleep(3)
    ev("fire_send_ok_1_lastFireAt", f1 if f1 is not None else "MISSING",
       {"phase": (my_rec(sc.arms_snapshot()) or {}).get("phase")})
    if f1 is None:
        raise SystemExit(1)

    # ---- step 3: 15-минутная тишина (нет новых сбросов) ----
    ev("SILENCE-WINDOW-1: 15 min, no resets (FR1)")
    silence1_extra = []
    last_seen = f1
    t0 = time.time()
    while time.time() - t0 < 15 * 60:
        time.sleep(30)
        cur = my_rec(sc.arms_snapshot())
        if cur:
            lf = cur.get("lastFireAt")
            if lf is not None and lf != last_seen:
                silence1_extra.append((lf, cur.get("phase"), cur.get("repeat")))
                last_seen = lf
    ev("silence1_extra_fires", silence1_extra if silence1_extra else "none")
    no_extra_1 = len(silence1_extra) == 0

    # ---- step 4: reset#2 -> ровно ОДИН новый fire:send-ok#2 (retryTick <=5 мин) ----
    r = s.send_cmd("/settimer 0", timeout=60)
    ev("cmd_settimer0_R2", json.dumps(r, ensure_ascii=False))
    st_r2 = sc.state_snapshot()
    reset2_at = st_r2.get("lastResetAt") if st_r2 else None
    ev("reset2_lastResetAt", reset2_at)
    deadline = time.time() + 420   # 7 мин: retryTick на 5-мин интервале + slack
    f2 = None
    extra2 = []
    while time.time() < deadline:
        time.sleep(5)
        cur = my_rec(sc.arms_snapshot())
        if cur is None:
            continue
        lf = cur.get("lastFireAt")
        if lf is None or lf == last_seen:
            continue
        if f2 is None:
            f2 = lf
            last_seen = lf
        else:
            extra2.append(lf)
    ev("fire_send_ok_2_lastFireAt", f2 if f2 is not None else "MISSING")
    ev("extra_fires_after_reset2", extra2 if extra2 else "none")
    if f2 is None:
        raise SystemExit(1)
    time.sleep(2)
    ev("my_rec_after_R2", json.dumps(my_rec(sc.arms_snapshot()), ensure_ascii=False))

    # ---- step 5: 5-мин тишина после reset#2 ----
    ev("SILENCE-WINDOW-2: 5 min after reset#2 (FR1 again)")
    silence2_extra = []
    t0 = time.time()
    while time.time() - t0 < 5 * 60:
        time.sleep(30)
        cur = my_rec(sc.arms_snapshot())
        if cur:
            lf = cur.get("lastFireAt")
            if lf is not None and lf != last_seen:
                silence2_extra.append(lf)
                last_seen = lf
    ev("silence2_extra_fires", silence2_extra if silence2_extra else "none")
    no_extra_2 = len(silence2_extra) == 0

    # ---- итоговая атрибуция по arms.log ----
    delta = sc.read_delta(START_LINE)
    all_so = [d for d in delta if d[1] == "fire:send-ok"]
    my_fire_lines = []
    other_lines = []
    for (iso, e, d) in all_so:
        tms = None
        try:
            tms = int(time.mktime(time.strptime(iso[:23], "%Y-%m-%dT%H:%M:%S.%f")) * 1000)
        except Exception:
            pass
        is_mine = False
        if tms is not None:
            for f in (f1, f2):
                if f is not None and abs(tms - f) < 5000:
                    is_mine = True
        (my_fire_lines if is_mine else other_lines).append(iso)
    ev("attributed_fire_send_ok_mine", my_fire_lines if my_fire_lines else "none")
    ev("fire_send_ok_other_flags", other_lines if other_lines else "none")
    my_fire_log_count = len(my_fire_lines)

    neg = [e for (_i, e, _d) in delta
           if e.startswith("send-error") or e.startswith("capitulation")
           or e == "watchdog:reset-error"]
    ev("negative_events", neg if neg else "none")

    checks = {
        "armed repeat==3": rec0 is not None and rec0.get("repeat") == 3,
        "send-ok#1 seen": f1 is not None,
        "15min silence: no extra fires": no_extra_1,
        "send-ok#2 exactly one after reset#2": f2 is not None and len(extra2) == 0,
        "5min silence after reset#2": no_extra_2,
        "attributed fire:send-ok == 2": my_fire_log_count == 2,
        "still pending (no false confirm)": (my_rec(sc.arms_snapshot()) or {}).get("phase") == "pending",
        "no negatives": len(neg) == 0,
    }
    ev("checks", json.dumps(checks, ensure_ascii=False))
    result = "PASS" if all(v for v in checks.values() if v is not None) else "FAIL"

    # cleanup: снять свой флаг
    try:
        s.send_cmd("/cont-after-reset off", timeout=30)
        ev("cleanup_disarm_cmd", "ok")
    except Exception as e:
        ev("cleanup_disarm_cmd", "err " + str(e)[:100])
    time.sleep(2)
    ev("my_rec_after_disarm", json.dumps(my_rec(sc.arms_snapshot()), ensure_ascii=False))
finally:
    s.stop()

with open(REPORT, "w", encoding="utf-8") as fh:
    fh.write("# Scenario 005 NIGHT-MINI (fire-once-per-window live)\n\n")
    fh.write("- Дата (UTC): %s\n" % time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    fh.write("- Коммит: 36f8ffa (pending-повтор 'продолжи' только после нового сброса окна)\n")
    fh.write("- Модель: freedeepseek/deepseek-default (провайдер 127.0.0.1:9655 НЕ поднят = ночь/429: ответа нет, pending жив)\n")
    fh.write("- session-id: %s\n" % SID)
    fh.write("- session-file (ключ флага): %s\n" % (session_file or "?"))
    fh.write("- state до: %s\n" % json.dumps(
        {k: before_state[k] for k in ("windowStartedAt", "lastResetAt", "resetCount", "callsInWindow")}
        if before_state else {}, ensure_ascii=False))
    fh.write("\n## Timeline delta (со строки %d)\n\n```\n" % START_LINE)
    fh.write(sc.format_delta(START_LINE))
    fh.write("\n```\n\n## Evidence\n\n```\n")
    fh.write("\n".join(EL))
    fh.write("\n```\n\n## Вердикт: %s\n" % result)
print("NIGHT_RESULT", result)
print("REPORT", REPORT)
