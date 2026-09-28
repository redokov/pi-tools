#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""006-e1-subagent-stale.py -- E1 (spec 006, T-12 / design D-609).

Вопрос гипотезы (Q-002): инвалидирует ли in-process субагент piApi родителя
БЕЗ события замены (session-start/replacement:adopted) родительского ключа?

Шаги (design.md 5.5):
  1) RpcSession(parent, рабочая модель) -> session-start родителя (key/pid/ep).
  2) Внешний взвод родителя (arm_cont_after_reset.py --repeat 1) -> arm-seen.
     lastResetAtAtArm переписывается = текущий lastResetAt (иначе немедленный
     fire «пропущенного сброса» до субагента).
  3) Prompt родителю: запустить вложенного агента (Agent tool, узкая задача) ->
     ждать в armslog session-start с ЧУЖИМ key (деталь owner-shift, D-607) ->
     ждать завершения дочерней сессии (session-shutdown чужого key или пауза).
  4) Форс-сброс окна: /settimer 0 ИЗ ДРУГОЙ RPC-сессии (drv) -> наблюдать
     fire-строки РОДИТЕЛЬСКОГО ключа.
  5) ASSERT-ы по журналу (armslog -- единственный источник доказательства):
     (i) owner-shift залогирован;
     (ii) за период [child session-start, fire] НЕТ session-start /
         replacement:adopted для РОДИТЕЛЬСКОГО ключа;
     (iii) ctx=stale src=probe присутствует на fire-пути родителя;
     (iv) вердикт: YES / NO / UNKNOWN.
       YES   -- (ii) и (iii): инвалидация без события замены (гипотеза верна);
       NO    -- доставка прошла (send-ok) БЕЗ src=probe и без родительского
                session-start в периоде (ctx родителя пережил субагента);
       UNKNOWN -- всё остальное (fire не был запланирован/доставлен и т.п.).

Запуск:  python 006-e1-subagent-stale.py
Отчёт:   006-e1-report.md (рядом), сырые RPC-логи e1-*-rpc-raw.log.
"""
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
R004 = os.path.abspath(os.path.join(HERE, "..", "..", "004-live-scenario-testing", "reports"))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", ".."))  # reports→006→specs→sdd→.ai→repo
sys.path.insert(0, R004)
from rpc_harness import RpcSession  # noqa: E402
import scenario_common as sc  # noqa: E402

SID = "e1-parent"
SDIR = os.path.join(R004, "sessions")
RLOG = os.path.join(HERE, "e1-parent-rpc-raw.log")
RLOG_DRV = os.path.join(HERE, "e1-drv-rpc-raw.log")
REPORT = os.path.join(HERE, "006-e1-report.md")
ARMS_JSON = os.path.join(os.path.expanduser("~"), ".pi", "agent",
                         "pi-billing-window-arms.json")
ARM_SCRIPT = os.path.join(REPO, "scripts", "arm_cont_after_reset.py")

SUBAGENT_PROMPT = (
    "Запусти вложенного агента: инструмент Agent, subagent_type=general-purpose, "
    "promt (описание задачи) = «Ответь ровно одним словом DONE и ничего больше "
    "не делай». Ничего другого не делай, результат не анализируй."
)

EL = []


def ev(label, *vals):
    t = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    EL.append(f"[{t}] {label}: " + " | ".join(str(v) for v in vals))
    print(f"[{t}] {label}: " + " | ".join(str(v) for v in vals), flush=True)


def run_arm(argv):
    p = subprocess.run([sys.executable, "-u", ARM_SCRIPT] + argv,
                       capture_output=True, text=True, timeout=60)
    return (p.returncode, p.stdout, p.stderr)


def rewrite_last_reset_at_arms(session_file, cur_reset):
    """Атомарно переписать lastResetAtAtArm=cur_reset (см. B1/B2 фикс гонки)."""
    with open(ARMS_JSON, encoding="utf-8") as fh:
        arms_map = json.load(fh)
    norm = os.path.normcase(os.path.abspath(session_file))
    tgt = next((k for k in arms_map
                if os.path.normcase(os.path.abspath(k)) == norm), None)
    if tgt is None:
        return False
    arms_map[tgt]["lastResetAtAtArm"] = cur_reset
    tmp = ARMS_JSON + ".tmp-e1"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(arms_map, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, ARMS_JSON)
    return True


def main():
    start_line = sc.log_line_count()
    parent = None
    drv = None
    session_file = None
    key_base = None
    child_key_base = None
    try:
        # --- 1. родитель ---
        parent = RpcSession(SID, SDIR, RLOG)
        time.sleep(12)
        ent = sc.wait_event("session-start", start_line, 30, key_basename=SID)
        if ent is None or "owner-shift" in (ent[2] or ""):
            ev("FATAL", "нет session-start родителя")
            return "UNKNOWN"
        key_base = re.search(r"key=([^ ]+)", ent[2]).group(1)
        session_file = os.path.join(SDIR, key_base)
        ev("parent_session_start", ent[0], ent[2])
        ev("parent_key", key_base)

        # лёгкий промпт, чтобы сессия была живой
        payload = {"type": "prompt", "message":
                   "Ответь ровно READY и жди дальнейших инструкций."}
        parent.proc.stdin.write(json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n")
        parent.proc.stdin.flush()
        ev("parent_ready_prompt", "sent")

        # --- 2. взвод ---
        rc, out, err = run_arm([session_file, "--repeat", "1"])
        ev("arm_rc", rc, (out or "").strip()[:150], (err or "").strip()[:150])
        if rc != 0:
            rc, out, err = run_arm([session_file, "--repeat", "1"])
            ev("arm_rc_retry", rc, (out or err or "").strip()[:150])
        st = sc.state_snapshot() or {}
        cur_reset = int(st.get("lastResetAt") or 0)
        if cur_reset > 0 and rewrite_last_reset_at_arms(session_file, cur_reset):
            ev("lastResetAtAtArm_rewritten", cur_reset)
        arm_seen = sc.wait_event("arm-seen", start_line, 90, key_basename=key_base)
        ev("arm_seen", arm_seen[0] if arm_seen else "MISSING")
        t_sub = time.time()

        # --- 3. субагент ---
        parent.proc.stdin.write(json.dumps(
            {"type": "prompt", "message": SUBAGENT_PROMPT},
            ensure_ascii=False).encode("utf-8") + b"\n")
        parent.proc.stdin.flush()
        ev("subagent_prompt_sent", "fire-and-forget")
        # ждём ЧУЖОЙ session-start (owner-shift). ВАЖНО: owner-shift содержит
        # родительский ключ как источник (owner-shift: K_parent->K_child),
        # поэтому фильтр «key_base not in detail» здесь НЕ применим —
        # дочерний ключ извлекаем из части после «->».
        deadline = time.time() + 300
        child_ent = None
        while time.time() < deadline:
            for d in sc.read_delta(start_line):
                if d[1] == "session-start" and "owner-shift" in (d[2] or ""):
                    m = re.search(r"owner-shift(?:\(blocked\))?:\s*\S+->(\S+)", d[2])
                    cand = m.group(1) if m else None
                    if cand and key_base not in cand:
                        child_key_base = cand
                        child_ent = d
                        break
            if child_ent:
                break
            time.sleep(2)
        ev("child_session_start", child_ent[0] if child_ent else "MISSING",
           child_ent[2][:200] if child_ent else "")
        if not child_ent:
            ev("FATAL", "дочерняя session-start не найдена за 300с")
            return "UNKNOWN"
        child_start_idx = child_ent[0]
        # ждём завершения дочерней сессии (session-shutdown чужого key) или 120с
        shutdown = sc.wait_event("session-shutdown", start_line, 180,
                                 key_basename=child_key_base)
        ev("child_shutdown", shutdown[0] if shutdown else
           f"NOT_SEEN_180s (продолжаем после {round(time.time()-t_sub)}s)")
        time.sleep(3)

        # --- 4. форс-сброс окна из ДРУГОЙ сессии ---
        drv = RpcSession(SID + "-drv", SDIR, RLOG_DRV)
        time.sleep(12)
        rd = drv.send_cmd("/settimer 0", timeout=60)
        ev("drv_settimer0", json.dumps(rd, ensure_ascii=False)[:120])
        st2 = sc.state_snapshot() or {}
        ev("lastResetAt_after_drv", st2.get("lastResetAt"))

        # --- 5. наблюдение fire-пути родителя ---
        fire_lines = []
        deadline = time.time() + 240
        while time.time() < deadline:
            for d in sc.read_delta(start_line):
                if d[0] <= child_start_idx:
                    continue
                if key_base in (d[2] or "") and (
                        d[1].startswith("fire:") or d[1].startswith("send-error")
                        or d[1] == "replacement:adopted" or d[1] == "replacement:waiting"):
                    fire_lines.append(d)
            if any(d[1] in ("fire:confirmed", "send-error:stale", "replacement:waiting")
                   for d in fire_lines):
                time.sleep(10)  # добираем хвост цепочки
                for d in sc.read_delta(start_line):
                    if d[0] > child_start_idx and key_base in (d[2] or ""):
                        fire_lines.append(d)
                break
            time.sleep(3)
        # дедуп preserving order
        seen = set()
        fire_lines = [d for d in fire_lines
                      if (d[0], d[1]) not in seen and not seen.add((d[0], d[1]))]
        for d in fire_lines:
            ev("fire_path", d[0], d[1], (d[2] or "")[:170])
        if not fire_lines:
            ev("FATAL", "fire-путь родителя не наблюдался за 240с")
            return "UNKNOWN"

        # --- 6. ASSERT-ы ---
        # (ii) родительский session-start / replacement:adopted в периоде?
        parent_readopt = [d for d in fire_lines
                          if d[1] in ("session-start", "replacement:adopted")
                          or d[1].startswith("session-start")]
        parent_readopt = [d for d in fire_lines if d[1] == "replacement:adopted"]
        # session-start родителя после child_start_idx (событие замены):
        sstart_parent = [d for d in sc.read_delta(start_line)
                         if d[0] > child_start_idx and d[1] == "session-start"
                         and key_base in (d[2] or "")]
        src_probe = [d for d in fire_lines if "src=probe" in (d[2] or "")]
        src_drain = [d for d in fire_lines if "src=drain" in (d[2] or "")]
        send_ok = [d for d in fire_lines if d[1] == "fire:send-ok"]
        confirmed = [d for d in fire_lines if d[1] == "fire:confirmed"]

        ev("assert_owner_shift_logged", bool(child_ent))
        ev("assert_no_parent_session_start_in_period", len(sstart_parent) == 0,
           [d[0] for d in sstart_parent])
        ev("assert_replacement_adopted_in_period", len(parent_readopt) > 0,
           [d[0] for d in parent_readopt])
        ev("assert_src_probe_present", len(src_probe) > 0)
        ev("assert_src_drain_present", len(src_drain) > 0)
        ev("assert_send_ok", len(send_ok) > 0)
        ev("assert_confirmed", len(confirmed) > 0)

        no_replace_event = (len(sstart_parent) == 0)
        if no_replace_event and len(src_probe) > 0:
            verdict = "YES"
        elif no_replace_event and len(send_ok) > 0 and len(src_probe) == 0 \
                and len(src_drain) == 0:
            verdict = "NO"
        else:
            verdict = "UNKNOWN"
        ev("VERDICT_E1", verdict)
        return verdict
    finally:
        if drv is not None:
            drv.stop()
        if parent is not None:
            try:
                parent.stop()
            except Exception:
                pass
        with open(REPORT, "w", encoding="utf-8") as fh:
            fh.write("# E1-отчёт: in-process субагент инвалидирует piApi родителя? (spec 006, T-12)\n\n")
            fh.write(f"- Дата: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n")
            fh.write("- Драйвер: reports/006-e1-subagent-stale.py; сырые логи: e1-parent-rpc-raw.log, e1-drv-rpc-raw.log\n")
            fh.write("- Родительский ключ: " + str(key_base) + "\n")
            fh.write("- Дочерний ключ: " + str(child_key_base) + "\n\n")
            fh.write("## Хроника\n```\n" + "\n".join(EL) + "\n```\n\n")
            fh.write("## Вердикт\nСм. VERDICT_E1 в хронике (YES/NO/UNKNOWN).\n")


if __name__ == "__main__":
    v = main()
    ev("EXIT", v)
    sys.exit(0 if v in ("YES", "NO") else 1)
