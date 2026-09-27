#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""scenario_common.py -- delta observer over pi-billing-window-arms.log.

Every scenario computes a delta by recording the line-count of arms.log at
its start, then reading only the lines appended since then. Fire events do
not carry keys in the log, so attribution to a session is done by cross
checking arms.json transitions for the scenario's own key.
"""
import json
import os
import re
import time

ARM_LOG = os.path.join(os.path.expanduser("~"), ".pi", "agent",
                       "pi-billing-window-arms.log")
ARMS_JSON = os.path.join(os.path.expanduser("~"), ".pi", "agent",
                         "pi-billing-window-arms.json")
STATE_JSON = os.path.join(os.path.expanduser("~"), ".pi", "agent",
                          "pi-billing-window.json")

_ISO_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) \| ([^ ]+) \| (.*)$")


def log_line_count():
    try:
        with open(ARM_LOG, "rb") as fh:
            n = 0
            buf = fh.read(1 << 20)
            while buf:
                n += buf.count(b"\n")
                buf = fh.read(1 << 20)
            return n
    except FileNotFoundError:
        return 0


def read_delta(start_line: int):
    """Parse arms.log lines AFTER start_line into [(iso, event, detail), ...]."""
    try:
        with open(ARM_LOG, "r", encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
    except FileNotFoundError:
        return []
    out = []
    for ln in lines[start_line:]:
        ln = ln.strip()
        if not ln:
            continue
        m = _ISO_RE.match(ln)
        if m:
            out.append((m.group(1), m.group(2), m.group(3)))
        else:
            out.append(("?", "?", ln))
    return out


def wait_event(event: str, start_line: int, timeout: float,
               detail_sub: str = "", key_basename: str = ""):
    """Wait until a delta line matches event (and optional detail subtitle /
    key basename in the detail). Returns the matching line or None."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        for entry in read_delta(start_line):
            last = entry
            if entry[1] != event:
                continue
            if detail_sub and detail_sub not in entry[2]:
                continue
            if key_basename and key_basename not in entry[2]:
                continue
            return entry
        time.sleep(2.0)
    return last  # None means nothing seen at all


def count_delta(pattern_parts: tuple, start_line: int):
    """Count delta events whose event name is in pattern_parts."""
    events = [e for (_i, e, _d) in read_delta(start_line) if e in pattern_parts]
    return len(events)


def arms_snapshot():
    try:
        with open(ARMS_JSON, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def state_snapshot():
    try:
        with open(STATE_JSON, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def format_delta(start_line: int):
    return "\n".join(
        f"{i} | {e} | {d}" for (i, e, d) in read_delta(start_line)
    )
