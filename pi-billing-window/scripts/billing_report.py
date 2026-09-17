#!/usr/bin/env python3
"""billing_report.py -- MD report from pi-billing-window history CSV.

Reads ~/.pi/agent/pi-billing-window-history.csv (UTF-8 with BOM) written by
the pi-billing-window extension and renders a Markdown report:

  - total burn across ALL projects (the wormsoft limit is account-wide),
  - per-model breakdown (the `model` column; legacy rows -> `(no model)`),
  - one section per project (grouped by the `project` column),
  - per-window rows (a window = rows between reset_count increments),
  - peak minutes (60s buckets of token burn).

Usage:
  python scripts/billing_report.py
  python scripts/billing_report.py --project Komus --days 7 --out report.md

Source is ASCII-only on purpose; project data may contain Cyrillic (CSV is
utf-8-sig), which is handled at runtime, not in this source file.
"""

import argparse
import csv
import io
import os
import sys
from collections import defaultdict

DEFAULT_FILE = os.path.join(
    os.path.expanduser("~"), ".pi", "agent", "pi-billing-window-history.csv"
)
DAY_MS = 24 * 60 * 60 * 1000
MIN_MS = 60 * 1000


def norm_project(p):
    """Normalize a project path for grouping: forward slashes, strip trailing sep."""
    p = (p or "").replace("\\", "/").strip()
    return p.rstrip("/") if p else "(global)"


def project_name(p):
    """Human label: last path segment of the normalized project path."""
    if p == "(global)":
        return p
    return p.rstrip("/").rsplit("/", 1)[-1] or p


def norm_key(p):
    """Grouping key: normalized path, lowercased (Windows paths are CI)."""
    return norm_project(p).lower()


def match_project(norm, needle):
    """Case-insensitive tail match: 'komus' matches 'c:/myprojects/komus'."""
    n = needle.replace("\\", "/").strip("/").lower()
    if not n:
        return True
    return norm.lower().rstrip("/").endswith(n)


def load_rows(path, days):
    if not os.path.exists(path):
        print("History file not found: %s" % path, file=sys.stderr)
        print("Run the extension first (any wormsoft call creates it).", file=sys.stderr)
        return None
    cutoff = 0
    if days and days > 0:
        import time

        cutoff = (time.time() * 1000.0) - days * DAY_MS
    rows = []
    with io.open(path, "r", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            try:
                epoch = int(r["epoch_ms"])
            except (ValueError, TypeError, KeyError):
                continue
            if epoch < cutoff:
                continue
            rows.append(
                {
                    "epoch": epoch,
                    "ts": r.get("ts_iso", ""),
                    "kind": r.get("kind", ""),
                    "project": norm_project(r.get("project", "")),
                    "pkey": norm_key(r.get("project", "")),
                    "session": r.get("session", ""),
                    "calls": _int(r.get("calls_in_window")),
                    "reset": _int(r.get("reset_count")),
                    "input": _int(r.get("input")),
                    "output": _int(r.get("output")),
                    "cache_read": _int(r.get("cache_read")),
                    "cache_write": _int(r.get("cache_write")),
                    "model": (r.get("model") or "").strip(),
                }
            )
    rows.sort(key=lambda x: x["epoch"])
    return rows


def _int(v):
    try:
        return int(v)
    except (ValueError, TypeError):
        return 0


def tokens(r):
    return r["input"] + r["output"] + r["cache_read"] + r["cache_write"]


def fmt_k(n):
    if n >= 1_000_000:
        return "%.1fM" % (n / 1_000_000.0)
    if n >= 1_000:
        return "%.0fk" % (n / 1000.0)
    return str(n)


def split_windows(rows):
    """Group rows into windows: a reset_count increase starts a new window.

    Note: reset_count is global (shared across processes), so this split is
    exact as long as all agents write to the same history file.
    """
    windows = []
    cur = None
    last_reset = None
    for r in rows:
        rst = r["reset"] or 0  # empty reset_count cell -> 0 (None-safe)
        if last_reset is None or rst > last_reset:
            if cur:
                windows.append(cur)
            cur = {"start": r, "rows": [r], "reset": rst}
        else:
            if cur is None:
                cur = {"start": r, "rows": [], "reset": rst}
            cur["rows"].append(r)
        last_reset = rst
    if cur:
        windows.append(cur)
    return windows


def window_stats(w):
    calls = [r for r in w["rows"] if r["kind"] == "call"]
    tok = sum(tokens(r) for r in calls)
    inp = sum(r["input"] for r in calls)
    out = sum(r["output"] for r in calls)
    cr = sum(r["cache_read"] for r in calls)
    cw = sum(r["cache_write"] for r in calls)
    start = w["start"]["epoch"]
    end = calls[-1]["epoch"] if calls else w["start"]["epoch"]
    life_min = max(0, (end - start) / MIN_MS)
    # peak minutes
    per_min = defaultdict(int)
    for r in calls:
        per_min[r["epoch"] // MIN_MS] += tokens(r)
    peak = sorted(per_min.items(), key=lambda kv: -kv[1])[:3]
    return {
        "calls": len(calls),
        "tok": tok,
        "inp": inp,
        "out": out,
        "cr": cr,
        "cw": cw,
        "life_min": life_min,
        "peak": peak,
        "start_ts": w["start"]["ts"],
        "last_ts": w["rows"][-1]["ts"] if w["rows"] else w["start"]["ts"],
    }


def render_per_model(rows):
    """MD table: model x calls x input/output/cacheR/cacheW x total (kind=call only).

    Aggregates in a single pass over the (already filtered) rows; empty or
    missing model (legacy rows, resets without a model) -> one `(no model)`
    group. Sorted by total tokens, descending.
    """
    agg = {}  # model -> [calls, input, output, cache_read, cache_write, total]
    for r in rows:
        if r["kind"] != "call":
            continue
        m = r["model"] or "(no model)"
        a = agg.setdefault(m, [0, 0, 0, 0, 0, 0])
        a[0] += 1
        a[1] += r["input"]
        a[2] += r["output"]
        a[3] += r["cache_read"]
        a[4] += r["cache_write"]
        a[5] += tokens(r)
    if not agg:
        return ""  # no call rows -> no "## By model" section at all
    out = ["## By model", ""]
    out.append("| model | calls | input | output | cacheR | cacheW | total |")
    out.append("|---|---:|---:|---:|---:|---:|---:|")
    for m in sorted(agg.keys(), key=lambda k: -agg[k][5]):
        a = agg[m]
        out.append(
            "| %s | %d | %s | %s | %s | %s | %s |"
            % (m, a[0], fmt_k(a[1]), fmt_k(a[2]), fmt_k(a[3]), fmt_k(a[4]), fmt_k(a[5]))
        )
    out.append("")
    return "\n".join(out)


def render(rows, title):
    out = []
    out.append("# Wormsoft billing report: %s" % title)
    out.append("")
    if not rows:
        out.append("_No rows matched._")
        return "\n".join(out)

    # ---- total ----
    all_calls = [r for r in rows if r["kind"] == "call"]
    windows = split_windows(rows)
    out.append("## Total (all projects)")
    out.append("")
    out.append(
        "- Rows: %d | Windows: %d | Calls: %d | Tokens burned: %s"
        % (len(rows), len(windows), len(all_calls), fmt_k(sum(tokens(r) for r in all_calls)))
    )
    if all_calls:
        span = (all_calls[-1]["epoch"] - all_calls[0]["epoch"]) / MIN_MS
        out.append(
            "- Span: %s .. %s (%.0f min) | Avg burn: %s tok/min active"
            % (
                all_calls[0]["ts"],
                all_calls[-1]["ts"],
                span,
                fmt_k(int(sum(tokens(r) for r in all_calls) / max(1.0, span))),
            )
        )
    out.append("")

    # ---- by model (call rows only; empty model -> `(no model)`) ----
    if all_calls:
        out.append(render_per_model(rows))

    # ---- per project (key = lowercased path: Windows paths are case-insensitive;
    # display label = the first casing encountered) ----
    by_project = defaultdict(list)
    for r in rows:
        by_project[r["pkey"]].append(r)
    for pkey in sorted(by_project.keys()):
        prows = by_project[pkey]
        display = prows[0]["project"]
        pcalls = [r for r in prows if r["kind"] == "call"]
        out.append("## %s" % project_name(display))
        out.append("")
        out.append("_%s_" % display)
        out.append("")
        out.append(
            "Calls: %d | Tokens: %s (in %s / out %s / cacheR %s / cacheW %s)"
            % (
                len(pcalls),
                fmt_k(sum(tokens(r) for r in pcalls)),
                fmt_k(sum(r["input"] for r in pcalls)),
                fmt_k(sum(r["output"] for r in pcalls)),
                fmt_k(sum(r["cache_read"] for r in pcalls)),
                fmt_k(sum(r["cache_write"] for r in pcalls)),
            )
        )
        out.append("")
        if pcalls:
            out.append("| window | start | calls | tokens | life, min | peak minutes (tok) |")
            out.append("|---|---|---:|---:|---:|---|")
            pw = split_windows(prows)
            for i, w in enumerate(pw, 1):
                st = window_stats(w)
                peak_s = ", ".join(
                    "%s (%s)" % (
                        time_hhmm(k * MIN_MS),
                        fmt_k(v),
                    )
                    for k, v in st["peak"]
                )
                out.append(
                    "| #%d | %s | %d | %s | %.0f | %s |"
                    % (i, st["start_ts"], st["calls"], fmt_k(st["tok"]), st["life_min"], peak_s or "-")
                )
        out.append("")
    return "\n".join(out)


def time_hhmm(epoch_ms):
    import datetime

    return datetime.datetime.fromtimestamp(epoch_ms / 1000.0).strftime("%H:%M")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--file", default=DEFAULT_FILE, help="history CSV path")
    ap.add_argument("--project", default="", help="filter by project path tail (case-insensitive)")
    ap.add_argument("--days", type=int, default=30, help="only rows newer than N days (0 = all)")
    ap.add_argument("--out", default="", help="write MD report to this file instead of stdout")
    args = ap.parse_args()

    rows = load_rows(args.file, args.days)
    if rows is None:
        return 1
    if args.project:
        rows = [r for r in rows if match_project(r["pkey"], args.project)]

    md = render(rows, args.project or "all projects")

    if args.out:
        with io.open(args.out, "w", encoding="utf-8") as f:
            f.write(md + "\n")
        print("Report written: %s" % args.out)
    else:
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except AttributeError:
            pass
        print(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
