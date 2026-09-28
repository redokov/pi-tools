#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""B1 live: real window boundary via /settimer 300 + watchdog fire + grace.

Scenario (night-resilience, T-14):
  1) RPC-сессия live-B1 (РАБОЧАЯ модель wormsoft/zai/glm-5.3-flash).
     session-start по key= из armslog; лёгкий fire-and-forget промпт
     «ответь READY и жди» (как heartbeat в a3 -- не ждём ответа).
  2) Внешний взвод arm_cont_after_reset.py --repeat 1 -> arm-seen <=60s.
  3) ИЗ ЭТОЙ ЖЕ питон-программы отправляем в live-B1 /settimer 300
     (send_cmd) -> граница окна = now+300s -> watchdog сработает через 5 мин.
  4) Ждём в armslog watchdog-fire (fire:reset-ready с detail 'watchdog: сброс
     окна', атрибутирован по key=) -> затем fire:send-ok. Измеряем grace
     = send-ok - reset-ready, ожидание ~60+/-10s (допуск 45..90s).
  5) fire:confirmed (агент ответил) -> флаг снят (запись исчезла из arms.json),
     таймаут 6 мин.
  6) Негатив: 0 send-error:stale / capitulation / watchdog:reset-error за
     прогон; arm-gone ДО fire:confirmed = преждевременная потеря флага = FAIL
     (после confirmed arm-gone легитимен -- как в проде A3).

VERDICT по checks -> exit code 0 (PASS) / 1 (FAIL). Все RpcSession остановлены в finally.
"""
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.abspath(os.path.join(HERE, ".."))
REPO = os.path.abspath(os.path.join(SRC, "..", "..", "..", ".."))  # pi-billing-window
SPEC006_REPORTS = os.path.join(REPO, ".ai", "sdd", "specs",
                               "006-night-resilience", "reports")
sys.path.insert(0, HERE)
from rpc_harness import RpcSession
import scenario_common as sc

SID = "live-B1"
SDIR = os.path.join(SRC, "sessions")
RLOG = os.path.join(HERE, "T3-B1-rpc-raw.log")
REPORT = os.path.join(SPEC006_REPORTS, "scenario-B1.md")

# Длительность до границы. Должна быть > 10-мин дедупа checkAndReset, иначе
# на fire реальный сброс подавляется дедупом, base (lastResetAt) остаётся
# старым и grace-задержка max(0, base+60s-now) вырождается в 0 (дизайн:
# "reset that happened before the fire does not wait the grace twice").
# 660s = 11 мин гарантируют real-reset в момент fire -> grace ~60s.
# /settimer трактует голое число как МИНУТЫ (src/index.ts: «/settimer 60»).
# Берем минуты и явно суффиксим «m». 11 мин > 10-мин дедупа checkAndReset ->
# на fire произойдёт real-reset (base=now) -> grace-задержка ~60 с.
SETTIMER_MIN = int(os.environ.get("B1_SETTIMER_MIN", "11"))
ARM_SCRIPT = os.path.join(REPO, "scripts", "arm_cont_after_reset.py")

try:
    os.makedirs(SPEC006_REPORTS, exist_ok=True)
except Exception:
    pass

EL = []


def ev(label, *vals):
    t = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    EL.append(f"[{t}] {label}: " + " | ".join(str(v) for v in vals))
    print(f"[{t}] {label}: " + " | ".join(str(v) for v in vals), flush=True)


def iso_ts(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


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


PROMPT = (
    "Отвечай ровно одним словом READY и затем ожидай следующего сообщения. "
    "Не завершай работу и не уходи в длинный поток размышлений. "
    "Когда придёт новое сообщение -- продолжай с него."
)


def key_delta_events(start, base):
    """Все записи дельты, чей detail несёт наш key=basename (атрибуция D-606)."""
    return [d for d in sc.read_delta(start)
            if base and base in (d[2] or "")]


def key_count(event, start, base):
    return len([d for d in key_delta_events(start, base) if d[1] == event])


START_LINE = sc.log_line_count()
before_arms = sc.arms_snapshot()

headless = None
result = "FAIL"
key_basename = "?"
start_ent = None

try:
    # --- 1. primary headless RPC session (working model) ---
    headless = RpcSession(SID, SDIR, RLOG)  # дефолт: wormsoft/zai/glm-5.3-flash
    time.sleep(12)
    ent = sc.wait_event("session-start", START_LINE, 30, key_basename="live-B1")
    if ent is None:
        ev("FATAL", "no session-start live-B1")
        raise SystemExit(1)
    start_ent = ent
    m = re.search(r"key=([^ ]+)", ent[2])
    key_basename = m.group(1) if m else "?"
    session_file = os.path.join(SDIR, key_basename)
    ev("session_start", ent[0], ent[2])
    ev("session_file", session_file)

    # лёгкий промпт (fire-and-forget, как heartbeat в a3 -- ответа не ждём)
    payload = {"type": "prompt", "message": PROMPT}
    headless.proc.stdin.write(
        json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n")
    headless.proc.stdin.flush()
    ev("light_prompt_sent", "fire-and-forget READY-and-wait")

    # --- 2. external arming ---
    rc, out, err = run_arm([session_file, "--repeat", "1"])
    ev("external_arm_rc", rc)
    ev("external_arm_out", out.strip()[:300], err.strip()[:150])
    # fix(race): external arm по умолчанию ставит lastResetAtAtArm=0 ->
    # sync-поллер сразу видит «пропущенный сброс» и стреляет ДО /settimer,
    # что съедает весь сценарий B1. Переписываем lastResetAtAtArm = текущий
    # lastResetAt (атомарно, как expired_arm.py), чтобы fire случился только
    # на границе, установленной /settimer.
    st_now = sc.state_snapshot() or {}
    cur_reset = int(st_now.get("lastResetAt") or 0)
    if cur_reset > 0:
        with open(sc.ARMS_FILE if hasattr(sc, "ARMS_FILE") else os.path.join(
                os.path.expanduser("~"), ".pi", "agent",
                "pi-billing-window-arms.json"), encoding="utf-8") as fh:
            arms_map = json.load(fh)
        norm = os.path.normcase(os.path.abspath(session_file))
        tgt = next((k for k in arms_map if os.path.normcase(os.path.abspath(k)) == norm), None)
        if tgt is not None:
            arms_map[tgt]["lastResetAtAtArm"] = cur_reset
            tmp = arms_file_path = os.path.join(os.path.expanduser("~"), ".pi", "agent",
                                                "pi-billing-window-arms.json") + ".tmp-b1"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(arms_map, fh, ensure_ascii=False, indent=2)
            os.replace(tmp, os.path.join(os.path.expanduser("~"), ".pi", "agent",
                                         "pi-billing-window-arms.json"))
            ev("lastResetAtAtArm_rewritten", cur_reset)
    t_arm = time.time()
    arm_seen = sc.wait_event("arm-seen", START_LINE, 90, key_basename=key_basename)
    ev("arm_seen", arm_seen[0] if arm_seen else "MISSING",
       (arm_seen[2] if arm_seen else ""))
    arm_sec = (time.time() - t_arm) if arm_seen else None
    ev("arm_seen_sec", round(arm_sec, 1) if arm_sec is not None else None)
    time.sleep(2)
    ev("my_rec_after_arm", json.dumps(my_rec(sc.arms_snapshot()),
                                      ensure_ascii=False))

    # --- 3. real boundary: watchdog fire in ~5 min ---
    rd = headless.send_cmd(f"/settimer {SETTIMER_MIN}m", timeout=60)
    ev("cmd_settimer", json.dumps(rd, ensure_ascii=False))
    st = sc.state_snapshot()
    ev("state_after_settimer", json.dumps(
        {k: st[k] for k in ("windowStartedAt", "windowMs", "lastResetAt")}
        if st else {}, ensure_ascii=False))

    # --- 4. watchdog-fire (fire:reset-ready) -> grace -> fire:send-ok ---
    wf = sc.wait_event("fire:reset-ready", START_LINE, 800,
                       key_basename=key_basename)
    ev("watchdog_fire_reset_ready", (wf[0] if wf else "MISSING"),
       (wf[2] if wf else ""))
    t_wf = time.time()
    so = sc.wait_event("fire:send-ok", START_LINE, 150, key_basename=key_basename)
    ev("fire_send_ok", (so[0] if so else "MISSING"), (so[2] if so else ""))
    t_so = time.time()
    grace = None
    grace_from_reset = None
    if wf and so:
        a, b = iso_ts(wf[0]), iso_ts(so[0])
        if a is not None and b is not None:
            grace = b - a
        # Инвариант FR-102/D-603: доставка ~grace(60s) от МОМЕНТА СБРОСА
        # (base=lastResetAt), а не от fire-строки: delay = base+60s-now,
        # поэтому при позднем fire (watchdog тикает с шагом ~30s) разность
        # fire->send-ok меньше 60с на величину опоздания watchdog'а.
        m = re.search(r"сброс окна (\S+Z)", wf[2] if wf else "")
        if m and b is not None:
            try:
                base = datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S.%fZ")\
                    .replace(tzinfo=timezone.utc).timestamp()
                grace_from_reset = b - base
            except ValueError:
                pass
    ev("grace_s", round(grace, 1) if grace is not None else None)
    ev("grace_from_reset_s", round(grace_from_reset, 1) if grace_from_reset is not None else None)
    ev("watchdog_to_sendok_s", round(t_so - t_wf, 1))
    # snapshot deltas: флаг → pending (send-ok произошёл)
    time.sleep(2)
    ev("my_rec_after_sendok", json.dumps(my_rec(sc.arms_snapshot()),
                                         ensure_ascii=False))

    # --- 5. fire:confirmed + flag removed (timeout 6 min) ---
    cf = sc.wait_event("fire:confirmed", START_LINE, 360, key_basename=key_basename)
    ev("fire_confirmed", (cf[0] if cf else "MISSING"), (cf[2] if cf else ""))
    gone = False
    deadline = time.time() + 360
    while time.time() < deadline:
        if my_rec(sc.arms_snapshot()) is None:
            gone = True
            break
        time.sleep(5)
    ev("flag_removed_after_confirm", gone)
    if cf:
        ev("sendok_to_confirmed_s", round(time.time() - t_so, 1))

    # --- 6. negativity ---
    delta = sc.read_delta(START_LINE)
    neg_bad = [e for (_i, e, _d) in delta
               if e.startswith("send-error")
               or e.startswith("capitulation")
               or e == "watchdog:reset-error"]
    ev("negative_events_stale_cap_reseterr", neg_bad if neg_bad else "none")
    # arm-gone ДО confirmed = преждевременная потеря флага (после confirmed -- легитимно)
    arm_gone_delta = [d for d in delta if d[1] == "arm-gone"]
    arm_gone_before_confirm = []
    for d in delta:
        if d[1] == "fire:confirmed" and key_basename in (d[2] or ""):
            break
        if d[1] == "arm-gone":
            arm_gone_before_confirm.append(d)
    ev("arm_gone_before_confirm", arm_gone_before_confirm if arm_gone_before_confirm
       else "none")
    ev("arm_gone_total", arm_gone_delta if arm_gone_delta else "none")

    ev("delta_key_attr_counts", json.dumps({
        "fire:reset-ready": key_count("fire:reset-ready", START_LINE, key_basename),
        "fire:send-ok": key_count("fire:send-ok", START_LINE, key_basename),
        "fire:confirmed": key_count("fire:confirmed", START_LINE, key_basename),
    }, ensure_ascii=False))

    checks = {
        "arm-seen <=60s": arm_seen is not None and arm_sec is not None
        and arm_sec <= 60,
        "watchdog-fire (fire:reset-ready by key)": wf is not None,
        "grace 45..90s от момента сброса": (
            (grace_from_reset is not None and 45 <= grace_from_reset <= 90)
            or (grace is not None and 45 <= grace <= 90)),
        "fire:confirmed by key": cf is not None,
        "flag removed after confirm": gone,
        "no send-error/capitulation/watchdog:reset-error": len(neg_bad) == 0,
        "no arm-gone before fire:confirmed": len(arm_gone_before_confirm) == 0,
    }
    ev("checks", json.dumps(checks, ensure_ascii=False))
    result = "PASS" if all(v for v in checks.values() if v is not None) else "FAIL"
finally:
    if headless is not None:
        headless.stop()

with open(REPORT, "w", encoding="utf-8") as fh:
    fh.write("# Scenario B1 (006 night-resilience, T-14) - /settimer %dm -> watchdog-fire -> grace ~60s -> доставка\n\n" % SETTIMER_MIN)
    fh.write("- Дата (UTC): %s\n" % time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    fh.write("- Модель/провайдер: wormsoft/zai/glm-5.3-flash / wormsoft (рабочая)\n")
    fh.write("- session-id: %s\n" % SID)
    fh.write("- session-file (ключ флага): %s\n" % (session_file or "?"))
    fh.write("- session-start: %s | %s\n" % (
        (start_ent[0] if start_ent else "?"),
        (start_ent[2] if start_ent else "")))
    fh.write("- Взвод: scripts/arm_cont_after_reset.py --repeat 1 (внешняя запись arms.json); arm-seen <=60s\n")
    fh.write("- Граница: /settimer 300 в live-B1 (watchdog-fire через ~5 мин), grace = fire:send-ok - fire:reset-ready\n")
    fh.write("- Ограничение измерения grace: реальный сброс окна на границе происходит только если "
             "state.lastResetAt старше 10-минутного дедупа checkAndReset; в противном случае "
             "fire планируется для старого lastResetAt и grace может быть ~0s (окружение, не дефект драйвера).\n")
    fh.write("\n## Timeline delta (со строки %d)\n\n```\n" % START_LINE)
    fh.write(sc.format_delta(START_LINE))
    fh.write("\n```\n\n## Evidence\n\n```\n")
    fh.write("\n".join(EL))
    fh.write("\n```\n\n## Вердикт: %s\n" % result)
print("B1_RESULT", result)
print("REPORT", REPORT)
sys.exit(0 if result == "PASS" else 1)
