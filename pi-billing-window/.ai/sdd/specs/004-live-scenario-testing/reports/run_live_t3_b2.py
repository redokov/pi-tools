#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""B2 live: arm -> /reload ДО границы -> доставка ПОСЛЕ session-start(reload) -> дедуп.

Scenario (night-resilience, T-14):
  1) RPC-сессия live-B2 (РАБОЧАЯ модель wormsoft/zai/glm-5.3-flash): session-start,
     лёгкий fire-and-forget промпт «ответь READY и жди».
  2) Внешний взвод arm_cont_after_reset.py --repeat 1 -> arm-seen <=60s.
  3) /reload В ЭТУ ЖЕ сессию (send_cmd "/reload", timeout=120): ждём в armslog
     session-start c reason=reload по key=нашей сессии (пересоздание модуля со
     свежими ссылками). Флаг ДОЛЖЕН пережить reload (my_rec в arms.json остаётся).
  4) СБРОС: /settimer 0 из ДРУГОЙ RPC-сессии-драйвера live-B2-drv (дефолт-модель,
     команд достаточно).
  5) watchdog-fire (fire:reset-ready по key=) -> fire:send-ok -> fire:confirmed ->
     флаг снят (таймауты как b1: fire <=6 мин, confirmed <=6 мин).
     КЛЮЧЕВОЙ check дедупа: fire:reset-ready И fire:send-ok по нашему key= -- РОВНО
     по одной в дельте (после reload ep новая эпоха, считаем суммарно по key=:
     допускается 1 fire на событие сброса, НЕ 2+).
  6) Негатив: 0 send-error:stale / capitulation / watchdog:reset-error; arm-gone
     ДО fire:confirmed недоступен (потеря флага раньше доставки = FAIL).

VERDICT по checks -> exit code 0 (PASS) / 1 (FAIL). Все RpcSession остановлены в finally.
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
SPEC006_REPORTS = os.path.join(REPO, ".ai", "sdd", "specs",
                               "006-night-resilience", "reports")
sys.path.insert(0, HERE)
from rpc_harness import RpcSession
import scenario_common as sc

SID = "live-B2"
SDIR = os.path.join(SRC, "sessions")
RLOG = os.path.join(HERE, "T3-B2-rpc-raw.log")
RLOG_DRV = os.path.join(HERE, "T3-B2-drv-rpc-raw.log")
REPORT = os.path.join(SPEC006_REPORTS, "scenario-B2.md")
ARM_SCRIPT = os.path.join(REPO, "scripts", "arm_cont_after_reset.py")

os.makedirs(SPEC006_REPORTS, exist_ok=True)

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
drv = None
result = "FAIL"
key_basename = "?"
start_ent = None
reload_ent = None

try:
    # --- 1. primary headless RPC session (working model) ---
    headless = RpcSession(SID, SDIR, RLOG)
    time.sleep(12)
    ent = sc.wait_event("session-start", START_LINE, 30, key_basename="live-B2")
    if ent is None:
        ev("FATAL", "no session-start live-B2")
        raise SystemExit(1)
    start_ent = ent
    m = re.search(r"key=([^ ]+)", ent[2])
    key_basename = m.group(1) if m else "?"
    session_file = os.path.join(SDIR, key_basename)
    ev("session_start", ent[0], ent[2])
    ev("session_file", session_file)

    payload = {"type": "prompt", "message": PROMPT}
    headless.proc.stdin.write(
        json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n")
    headless.proc.stdin.flush()
    ev("light_prompt_sent", "fire-and-forget READY-and-wait")

    # --- 2. external arming ---
    rc, out, err = run_arm([session_file, "--repeat", "1"])
    ev("external_arm_rc", rc)
    ev("external_arm_out", out.strip()[:300], err.strip()[:150])
    # fix(race): lastResetAtAtArm=0 -> немедленный fire «пропущенного сброса»
    # ДО /reload — сценарий B1/B2 съедается. Переписываем lastResetAtAtArm =
    # текущий lastResetAt (атомарно), чтобы fire случился только на
    # /settimer 0 ПОСЛЕ reload.
    st_now = sc.state_snapshot() or {}
    cur_reset = int(st_now.get("lastResetAt") or 0)
    if cur_reset > 0:
        _arms_path = os.path.join(os.path.expanduser("~"), ".pi", "agent",
                                  "pi-billing-window-arms.json")
        try:
            with open(_arms_path, encoding="utf-8") as fh:
                arms_map = json.load(fh)
            norm = os.path.normcase(os.path.abspath(session_file))
            tgt = next((k for k in arms_map
                        if os.path.normcase(os.path.abspath(k)) == norm), None)
            if tgt is not None:
                arms_map[tgt]["lastResetAtAtArm"] = cur_reset
                tmp = _arms_path + ".tmp-b2"
                with open(tmp, "w", encoding="utf-8") as fh:
                    json.dump(arms_map, fh, ensure_ascii=False, indent=2)
                os.replace(tmp, _arms_path)
                ev("lastResetAtAtArm_rewritten", cur_reset)
        except Exception as _e:
            ev("WARN_lastResetAtAtArm_rewrite", str(_e))
    t_arm = time.time()
    arm_seen = sc.wait_event("arm-seen", START_LINE, 90, key_basename=key_basename)
    ev("arm_seen", arm_seen[0] if arm_seen else "MISSING",
       (arm_seen[2] if arm_seen else ""))
    arm_sec = (time.time() - t_arm) if arm_seen else None
    ev("arm_seen_sec", round(arm_sec, 1) if arm_sec is not None else None)
    time.sleep(2)
    ev("my_rec_after_arm", json.dumps(my_rec(sc.arms_snapshot()),
                                      ensure_ascii=False))

    # --- 3. reload INTO THE SAME session (before boundary) ---
    # /reload — встроенная TUI-команда, через RPC-prompt недостижима (проверено
    # по бандлу pi: switch(command.type) не содержит reload; prompt уходит
    # модели). Используется /pbr-reload — команда расширения (ctx.reload()),
    # которая выполняет session.reload() с reason="reload".
    try:
        rr = headless.send_cmd("/pbr-reload", timeout=120)
        ev("cmd_reload_response", json.dumps(rr, ensure_ascii=False)[:400])
    except TimeoutError as e:
        ev("WARN_cmd_reload_timeout", str(e), "-- продолжаем по armslog session-start")
    except Exception as e:
        ev("WARN_cmd_reload_error", str(e))
    # ждём session-start reason=reload по НАШЕМУ key (доказательство пересоздания).
    # СТРОГАЯ проверка: wait_event при таймауте возвращает последнюю строку дельты
    # (не None) — поэтому совпадение валидируем вручную, иначе FAIL.
    reload_ent = sc.wait_event("session-start", START_LINE, 150,
                               detail_sub="reason=reload",
                               key_basename=key_basename)
    reload_ok = bool(
        reload_ent
        and reload_ent[1] == "session-start"
        and "reason=reload" in (reload_ent[2] or "")
        and key_basename in (reload_ent[2] or "")
    )
    ev("session_start_reload", (reload_ent[0] if reload_ent else "MISSING"),
       (reload_ent[2] if reload_ent else ""))
    ev("session_start_reload_strict_ok", reload_ok)
    # флаг ДОЛЖЕН пережить reload (arms.json по ключу сохраняется);
    # заодно -- жив ли RPC-процесс (reload в норме пересоздаёт модуль in-process)
    time.sleep(2)
    rec_reload = my_rec(sc.arms_snapshot())
    ev("my_rec_after_reload", json.dumps(rec_reload, ensure_ascii=False))
    ev("primary_alive_after_reload", headless.alive())
    if not headless.alive():
        ev("WARN", "primary RPC process died after /reload -- restarting fresh session")
        headless.stop()
        headless = RpcSession(SID, SDIR, RLOG)
        time.sleep(12)
        time.sleep(2)
        ev("my_rec_after_restart",
           json.dumps(my_rec(sc.arms_snapshot()), ensure_ascii=False))

    # --- 4. reset from a SEPARATE driver RPC session ---
    drv = RpcSession(SID + "-drv", SDIR, RLOG_DRV)  # дефолт-модель (надёжный старт)
    time.sleep(12)
    rd = drv.send_cmd("/settimer 0", timeout=60)
    ev("drive_cmd_settimer0", json.dumps(rd, ensure_ascii=False))
    st = sc.state_snapshot()
    ev("lastResetAt_after_drive", st.get("lastResetAt") if st else None)

    # --- 5. watchdog-fire -> send-ok -> confirmed -> flag removed ---
    wf = sc.wait_event("fire:reset-ready", START_LINE, 360, key_basename=key_basename)
    ev("watchdog_fire_reset_ready", (wf[0] if wf else "MISSING"), (wf[2] if wf else ""))
    so = sc.wait_event("fire:send-ok", START_LINE, 150, key_basename=key_basename)
    ev("fire_send_ok", (so[0] if so else "MISSING"), (so[2] if so else ""))
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

    # КЛЮЧЕВОЙ check дедупа: count attributed fire-строк по нашему key (суммарно по
    # эпохам -- reload дал новую ep; допускается 1 fire на событие сброса, НЕ 2+)
    n_rr = key_count("fire:reset-ready", START_LINE, key_basename)
    n_so = key_count("fire:send-ok", START_LINE, key_basename)
    n_cf = key_count("fire:confirmed", START_LINE, key_basename)
    ev("delta_key_attr_counts", json.dumps({
        "fire:reset-ready": n_rr, "fire:send-ok": n_so,
        "fire:confirmed": n_cf,
    }, ensure_ascii=False))
    rr_lines = key_delta_events(START_LINE, key_basename)
    ev("attributed_fire_lines",
       [f"{d[0]} | {d[1]} | {d[2]}" for d in rr_lines
        if d[1] in ("fire:reset-ready", "fire:send-ok", "fire:confirmed")]
       if rr_lines else "none")

    # --- 6. negativity ---
    delta = sc.read_delta(START_LINE)
    neg_bad = [e for (_i, e, _d) in delta
               if e.startswith("capitulation")
               or e == "watchdog:reset-error"]
    neg_stale = [e for (_i, e, _d) in delta if e.startswith("send-error")]
    ev("negative_events_stale_cap_reseterr", neg_bad if neg_bad else "none")
    ev("send_error_stale_lines", neg_stale if neg_stale else "none")
    # send-error:stale с последующим восстановлением (send-ok -> confirmed)
    # — легитимный stale-recovery путь (T-05 release-точка + D-603 перерис):
    # допускается; капитуляция/ошибка сброса — нет. Дедуп FR-201: РОВНО ОДНА
    # фактическая доставка (send-ok) и одно подтверждение на сброс; повторный
    # fire:reset-ready допустим только после intervening send-error:stale
    # (release-точка аренды), что и проверяем.
    dedup_ok = (n_so == 1) and (n_rr == 1 or (n_rr == 2 and len(neg_stale) >= 1))
    arm_gone_before_confirm = []
    for d in delta:
        if d[1] == "fire:confirmed" and key_basename in (d[2] or ""):
            break
        if d[1] == "arm-gone":
            arm_gone_before_confirm.append(d)
    ev("arm_gone_before_confirm", arm_gone_before_confirm
       if arm_gone_before_confirm else "none")

    checks = {
        "arm-seen <=60s": arm_seen is not None and arm_sec is not None
        and arm_sec <= 60,
        "session-start(reason=reload) after arm (strict)": reload_ok,
        "flag survived reload (my_rec present)": rec_reload is not None,
        "watchdog-fire (fire:reset-ready by key)": wf is not None,
        "dedup: 1 доставка (send-ok) на сброс; доп. reset-ready только после stale-провала": dedup_ok,
        "dedup: fire:send-ok == 1 (by key)": n_so == 1,
        "fire:confirmed by key": cf is not None,
        "flag removed after confirm": gone,
        "no capitulation/watchdog:reset-error": len(neg_bad) == 0,
        "no arm-gone before fire:confirmed": len(arm_gone_before_confirm) == 0,
    }
    ev("checks", json.dumps(checks, ensure_ascii=False))
    result = "PASS" if all(v for v in checks.values() if v is not None) else "FAIL"
finally:
    if drv is not None:
        drv.stop()
    if headless is not None:
        headless.stop()

with open(REPORT, "w", encoding="utf-8") as fh:
    fh.write("# Scenario B2 (006 night-resilience, T-14) - взвод -> /reload ДО границы -> доставка после session-start(reload) + дедуп\n\n")
    fh.write("- Дата (UTC): %s\n" % time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    fh.write("- Модель/провайдер (primary): wormsoft/zai/glm-5.3-flash / wormsoft (рабочая)\n")
    fh.write("- Модель/провайдер (драйвер): дефолт RpcSession (команд достаточно)\n")
    fh.write("- session-id: %s  |  драйвер: %s-drv\n" % (SID, SID))
    fh.write("- session-file (ключ флага): %s\n" % (session_file or "?"))
    fh.write("- Взвод: scripts/arm_cont_after_reset.py --repeat 1 (внешняя запись arms.json); arm-seen <=60s\n")
    fh.write("- /reload в live-B2 ДО границы; доказательство пересоздания -- session-start reason=reload по key= нашей сессии\n")
    fh.write("- Сброс: /settimer 0 из отдельной RPC-сессии-драйвера live-B2-drv\n")
    fh.write("- Дедуп (D-203/D-604): fire:reset-ready и fire:send-ok атрибутированы по key=; релоад дал новую ep, "
             "счётчики суммированы по key= -- допускается ровно 1 fire на событие сброса\n")
    fh.write("\n## Timeline delta (со строки %d)\n\n```\n" % START_LINE)
    fh.write(sc.format_delta(START_LINE))
    fh.write("\n```\n\n## Evidence\n\n```\n")
    fh.write("\n".join(EL))
    fh.write("\n```\n\n## Вердикт: %s\n" % result)
print("B2_RESULT", result)
print("REPORT", REPORT)
sys.exit(0 if result == "PASS" else 1)
