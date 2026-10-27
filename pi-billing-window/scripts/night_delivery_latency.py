#!/usr/bin/env python3
"""Aggregate one night's armslog + session JSONL into delivery latency facts.
No raw JSONL output; safe bounded scan for the 25->26 Oct night.
"""
from __future__ import annotations
import datetime as dt
import json
import pathlib
import re
from collections import Counter

ARMS = pathlib.Path(r"C:\Users\r.edokov\.pi\agent\pi-billing-window-arms.log")
SESSIONS = pathlib.Path(r"C:\Users\r.edokov\.pi\agent\sessions\--c--MyProjects-APKScenTest--")
LO = dt.datetime(2026, 10, 25, 17, 30, tzinfo=dt.timezone.utc)
HI = dt.datetime(2026, 10, 26, 5, 30, tzinfo=dt.timezone.utc)

def t_of(s: str) -> dt.datetime | None:
    try: return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception: return None

def iso(t): return t.isoformat(timespec="seconds") if t else "?"

events=[]
for line in ARMS.read_text(encoding="utf-8", errors="replace").splitlines():
    parts=line.split(" | ", 2)
    if len(parts)<2: continue
    t=t_of(parts[0])
    if t and LO<=t<=HI: events.append((t,parts[1],parts[2] if len(parts)>2 else ""))
by=Counter(e for _,e,_ in events)
resets=[t for t,e,_ in events if e=="fire:reset-ready"]
sends=[t for t,e,_ in events if e=="fire:send-ok"]
confirmed=[t for t,e,_ in events if e=="fire:confirmed"]
# Pair each send/confirmed with latest reset-ready, preserving sequence.
def latest_before(xs, t):
    vals=[x for x in xs if x<=t]
    return vals[-1] if vals else None
print("window: 2026-10-25 21:01—2026-10-26 08:00 MSK")
print("armslog events:", len(events), dict(by))
print("reset-ready -> send-ok:")
for s in sends:
    r=latest_before(resets,s)
    c=next((x for x in confirmed if r and r<=x and x>=s),None)
    print(f"  reset={iso(r)} send={iso(s)} delay_send={(s-r).total_seconds()/60:.2f}m confirmed={iso(c)} delay_confirm={(c-s).total_seconds()/60:.2f}m" if r else f"  send={iso(s)} reset=?")
print("reset-ready without send-ok:", sum(1 for r in resets if not any(r<=s<r+dt.timedelta(hours=2) for s in sends)))
print("stale:", by.get("fire:stale",0), "epoch-mismatch:", by.get("fire:epoch-mismatch",0), "switch-needed:", by.get("fire:switch-needed",0), "owner-busy:", by.get("block:owner-busy",0))
print("retry-like:", sum(v for k,v in by.items() if any(x in k for x in ("reverify","retry","switch-needed"))))
print(">5m reset->send:", sum(1 for s in sends if (r:=latest_before(resets,s)) and (s-r)>dt.timedelta(minutes=5)))
# JSONL aggregate: only timestamps/types/models; do not print raw records.
files=[]
for p in SESSIONS.glob("*.jsonl"):
    m=re.match(r"(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d+Z)_",p.name)
    if m:
        raw=m.group(1)
        # filename timestamp: YYYY-MM-DDTHH-MM-SS-mmmZ
        date_part, clock_part = raw[:-1].split("T")
        hh, mm, ss, ms = clock_part.split("-")
        t=dt.datetime.fromisoformat(f"{date_part}T{hh}:{mm}:{ss}.{ms}+00:00")
        if LO<=t<=HI: files.append(p)
print("session JSONL files in night:", len(files))
print("JSONL scan limited to model/provider fields; detailed timing source is armslog")
