#!/usr/bin/env python3
"""scenario_monitor.py -- night poller for pi-billing-window scenario C1.

Every POLL_SECS (default 300) the script:
  - reads NEW lines from the arms log (~/.pi/agent/pi-billing-window-arms.log),
    filtered to events at/after --since (default: script start), keeping a
    byte offset so only never-seen lines are reported; if the log is rotated
    or truncated, it falls back to the last 200 lines.
  - reads the heartbeat file (--heartbeat, required): line count + age (= now
    - file mtime).
  - optionally reads a test session file (--session): size + last-modify age
    (heartbeat-activity of the session).

Appends one report row to the report file (default
.ai/sdd/specs/004-live-scenario-testing/reports/night-status.log):
  <time> | hb=<lines> hb_age=<s> | sess_age=<s> size=<k> | <new key events> | [ANOMALY]

Anomaly rule: heartbeat older than 30 min AND no send-error / send-error:stale
event inside that same 30-min window -> the row is flagged ANOMALY and an
anomaly counter is bumped (a dead worker stops sending errors, so stale
heartbeat + no recent error traffic = anomaly).

Runs until Ctrl+C or --max-hours (default 12) elapsed. On exit appends a
FINAL SUMMARY to the report: totals per fire:* type, last heartbeat time,
anomaly count, run duration. Offset state is persisted to <report>.offset so a
restart does not re-report already-seen lines.

All output ASCII. No external dependencies.

Usage:
  python scripts/scenario_monitor.py --heartbeat <path> [--poll-secs 300]
      [--max-hours 12] [--session <path>] [--since ISO] [--report <path>] [--log <path>]
  python scripts/scenario_monitor.py --heartbeat <path> --max-hours 0  # until Ctrl+C
"""

import argparse
import datetime as dt
import os
import re
import sys
import time
from collections import deque

LOG_FILE = os.path.join(
    os.path.expanduser("~"), ".pi", "agent", "pi-billing-window-arms.log"
)
DEFAULT_REPORT = os.path.abspath(
    os.path.join(
        ".ai", "sdd", "specs", "004-live-scenario-testing", "reports", "night-status.log"
    )
)
ANOMALY_AGE_S = 30 * 60  # heartbeat older than this plus no send-error -> ANOMALY
TAIL_LINES = 200

KEY_EVENTS = (
    "session-start",
    "arm-seen",
    "arm-gone",
    "fire:reset-ready",
    "fire:send-ok",
    "fire:confirmed",
    "send-error",
    "send-error:stale",
    "replacement:waiting",
    "replacement:adopted",
    "capitulation:after-N",
    "watchdog:reset-error",
)
SEND_ERROR_EVENTS = ("send-error", "send-error:stale")

LINE_RE = re.compile(r"^(\S+) \| ([^|]+) \| (.*)$", re.UNICODE)


def parse_ts(token):
    """Parse an ISO log timestamp like 2026-09-27T13:20:09.895Z -> epoch float."""
    text = token.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return dt.datetime.fromisoformat(text).timestamp()
    except ValueError:
        return None


class EventTracker:
    """Per-token totals since --since, per-poll deltas and a rolling 30-min
    window of send-error timestamps for the anomaly rule."""

    def __init__(self, since_ts):
        self.since_ts = since_ts
        self.totals = {}
        self.window = deque()  # epochs of recent send-error events
        self.partial = ""  # split last line carried between reads
        self.offset = 0  # byte position consumed in the log

    def reset_tail(self, text):
        """Rebuild state from a bounded tail (used at startup / after rotation)."""
        self.partial = ""
        self.totals = {}
        self.window.clear()
        for line in text.splitlines()[-TAIL_LINES:]:
            self.consume(line)

    def consume(self, line):
        m = LINE_RE.match(line)
        if not m:
            return
        ts = parse_ts(m.group(1))
        event = m.group(2).strip()
        if ts is None or event not in KEY_EVENTS:
            return
        # The rolling send-error window feeds the anomaly rule and is NOT gated
        # by --since: it reflects process health over the last 30 min.
        if event in SEND_ERROR_EVENTS:
            self.window.append(ts)
        # Totals (row deltas + final fire:* summary) are gated by --since.
        if ts < self.since_ts:
            return
        self.totals[event] = self.totals.get(event, 0) + 1

    def prune_window(self, now):
        cutoff = now - ANOMALY_AGE_S
        while self.window and self.window[0] < cutoff:
            self.window.popleft()

    def deltas(self, prev_totals):
        """Event counts seen since the previous snapshot (only new events)."""
        return {
            k: v - prev_totals.get(k, 0)
            for k, v in self.totals.items()
            if v > prev_totals.get(k, 0)
        }


def fmt_events(event_map):
    if not event_map:
        return "ev:-"
    return " ".join("%s=%d" % (k, v) for k, v in sorted(event_map.items()))


def read_new_log_lines(path, tracker):
    """Read new bytes after tracker.offset; on truncation/rotation reseed from
    the last 200 lines. Returns the parsed new-event tokens for delta reporting."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return []
    if size < tracker.offset:
        # Log shrank -> rotated/truncated: re-seed from the last 200 lines.
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                tracker.reset_tail(f.read())
        except OSError:
            pass
        tracker.offset = size
        return []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            f.seek(tracker.offset)
            data = f.read()
    except OSError:
        return []
    tracker.offset = os.path.getsize(path)
    tracker.partial += data
    # Split into complete lines, keeping any unterminated tail for next poll.
    lines = tracker.partial.splitlines(True)
    if lines and not lines[-1].endswith("\n"):
        tracker.partial = lines.pop()
    else:
        tracker.partial = ""
    new_tokens = []
    for raw in lines:
        raw = raw.rstrip("\n")
        m = LINE_RE.match(raw)
        if not m:
            continue
        ts = parse_ts(m.group(1))
        event = m.group(2).strip()
        if ts is None or event not in KEY_EVENTS or ts < tracker.since_ts:
            continue
        tracker.totals[event] = tracker.totals.get(event, 0) + 1
        if event in SEND_ERROR_EVENTS:
            tracker.window.append(ts)
        new_tokens.append(event)
    return new_tokens


def read_heartbeat(path, now):
    """(line_count, age_s_or_None); age None when file is missing/unreadable."""
    try:
        st = os.stat(path)
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            n = sum(1 for _ in f)
        return n, int(now - st.st_mtime)
    except OSError:
        return 0, None


def read_session(path, now):
    """(size_bytes_or_None, age_s_or_None)."""
    try:
        st = os.stat(path)
        return st.st_size, int(now - st.st_mtime)
    except OSError:
        return None, None


def main():
    ap = argparse.ArgumentParser(description="Night C1 poller for pi-billing-window.")
    ap.add_argument("--heartbeat", required=True, help="heartbeat file path")
    ap.add_argument("--poll-secs", type=int, default=300, help="poll interval (default 300)")
    ap.add_argument("--max-hours", type=float, default=12, help="max run hours (default 12)")
    ap.add_argument("--session", default=None, help="test session file (size/activity)")
    ap.add_argument("--since", default=None, help="ISO timestamp; default = script start")
    ap.add_argument("--log", default=LOG_FILE, help="arms log path (default %s)" % LOG_FILE)
    ap.add_argument("--report", default=DEFAULT_REPORT, help="report path")
    args = ap.parse_args()

    if args.poll_secs <= 0:
        print("ERROR: --poll-secs must be > 0")
        return 2

    if args.since:
        since_ts = parse_ts(args.since)
        if since_ts is None:
            print("ERROR: --since must be an ISO timestamp, got: %s" % args.since)
            return 2
    else:
        since_ts = time.time()

    report_path = os.path.abspath(args.report)
    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    offset_file = report_path + ".offset"

    tracker = EventTracker(since_ts)
    # Seed event state from the tail of the log (--since filter applies).
    try:
        with open(args.log, "r", encoding="utf-8", errors="replace") as f:
            tracker.reset_tail(f.read())
        tracker.offset = os.path.getsize(args.log)
    except OSError:
        pass

    start = time.time()
    prev_totals = {}
    anomalies_total = 0
    anomalies_last = None
    fire_totals = {}
    last_hb_ts = None
    last_hb_ctx = (0, None)
    row_count = 0

    def poll():
        nonlocal prev_totals, anomalies_total, anomalies_last, fire_totals
        nonlocal last_hb_ts, last_hb_ctx, row_count
        now = time.time()

        read_new_log_lines(args.log, tracker)
        deltas = tracker.deltas(prev_totals)
        prev_totals = dict(tracker.totals)

        hb_lines, hb_age = read_heartbeat(args.heartbeat, now)
        sess_size, sess_age = (
            read_session(args.session, now) if args.session else (None, None)
        )

        # Anomaly: heartbeat stale (>=30 min) AND no send-error in that window.
        tracker.prune_window(now)
        stale = hb_age is None or hb_age >= ANOMALY_AGE_S
        no_err = len(tracker.window) == 0
        anomaly = stale and no_err

        if hb_age is not None:
            last_hb_ts = now - hb_age
            last_hb_ctx = (hb_lines, hb_age)
        for k in tracker.totals:
            if k.startswith("fire:"):
                fire_totals[k] = tracker.totals[k]

        if anomaly:
            anomalies_total += 1
            anomalies_last = dt.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")

        ts_now = dt.datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
        sess_part = "-"
        if args.session:
            size_s = "?KB" if sess_size is None else "%.1fKB" % (sess_size / 1024.0)
            age_s = "?" if sess_age is None else "%ds" % sess_age
            sess_part = "sess_age=%s size=%s" % (age_s, size_s)
        hb_part = "hb=%d hb_age=%s" % (
            hb_lines,
            "missing" if hb_age is None else "%ds" % hb_age,
        )
        ev_part = fmt_events(deltas)
        flag = " ANOMALY(%d)" % anomalies_total if anomaly else ""
        row = "%s | %s | %s | %s%s" % (ts_now, hb_part, sess_part, ev_part, flag)
        with open(report_path, "a", encoding="utf-8") as f:
            f.write(row + "\n")
        with open(offset_file, "w", encoding="utf-8") as f:
            f.write(str(tracker.offset))

        row_count += 1
        print(row)

    interrupted = False
    try:
        while True:
            poll()
            elapsed = time.time() - start
            if args.max_hours and args.max_hours > 0 and elapsed >= args.max_hours * 3600:
                print("INFO: reached --max-hours %s, stopping" % args.max_hours)
                break
            time.sleep(args.poll_secs)
    except KeyboardInterrupt:
        interrupted = True
        print("INFO: interrupted, writing final summary")

    # --- Final summary (event-detected output), appended at report end. ---
    ended = time.time()
    hb_lines_f, hb_age_f = last_hb_ctx
    if last_hb_ts:
        hb_last = dt.datetime.fromtimestamp(last_hb_ts, tz=dt.timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
    else:
        hb_last = "never"
    fmt_utc = lambda ts: dt.datetime.fromtimestamp(ts, tz=dt.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )
    lines = [
        "",
        "=== FINAL SUMMARY ===",
        "run_start=%s run_end=%s duration_h=%.2f polls=%d interrupted=%s"
        % (fmt_utc(start), fmt_utc(ended), (ended - start) / 3600.0, row_count, interrupted),
        "hb_lines=%d hb_age_s=%s hb_last_seen=%s"
        % (hb_lines_f, "-" if hb_age_f is None else hb_age_f, hb_last),
        "anomalies=%d" % anomalies_total,
    ]
    if anomalies_last:
        lines.append("anomaly_last=%s" % anomalies_last)
    if fire_totals:
        lines.extend("total %s = %d" % (k, fire_totals[k]) for k in sorted(fire_totals))
    else:
        lines.append("total fire:* = none seen")
    lines.append("=== END SUMMARY ===")
    summary = "\n".join(lines) + "\n"
    with open(report_path, "a", encoding="utf-8") as f:
        f.write(summary)
    print(summary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
