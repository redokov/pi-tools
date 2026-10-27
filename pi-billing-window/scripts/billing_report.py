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
import datetime as dt
import io
import json
import os
import sys
from collections import Counter, defaultdict

DEFAULT_FILE = os.path.join(
    os.path.expanduser("~"), ".pi", "agent", "pi-billing-window-history.csv"
)
DAY_MS = 24 * 60 * 60 * 1000
MIN_MS = 60 * 1000
# Wormsoft live price is deployment-specific; never silently invent a rate.
# Override with --price-input/--price-output/--price-cache-read (credits per token).
DEFAULT_NIGHT_DIR = os.path.join(
    os.path.expanduser("~"), ".pi", "agent", "pi-billing-window-nights"
)


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


def parse_iso_epoch(value):
    """Parse ISO timestamp with optional timezone; return epoch ms or None."""
    try:
        text = (value or "").replace("Z", "+00:00")
        parsed = dt.datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return int(parsed.timestamp() * 1000)
    except (ValueError, TypeError, OverflowError):
        return None


def load_night_ledger(path, night_date=""):
    """Read the extension ledger; return (rows, exists)."""
    if not path or not os.path.exists(path):
        return [], False
    rows = []
    with io.open(path, "r", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            try:
                reset_at = int(r.get("reset_at", ""))
            except (TypeError, ValueError):
                continue
            if night_date and r.get("night_date") != night_date:
                continue
            rows.append({
                "reset_at": reset_at,
                "night_date": r.get("night_date", ""),
                "calls": _int(r.get("calls_in_window")),
                "input": _int(r.get("input")),
                "output": _int(r.get("output")),
                "cache_read": _int(r.get("cache_read")),
                "reset_count": _int(r.get("reset_count")),
                "arm_phase": r.get("arm_phase", ""),
                "verdict": r.get("verdict", ""),
            })
    rows.sort(key=lambda r: r["reset_at"])
    return rows, True


def night_window_from_rows(rows, night_date, from_ms, to_ms):
    """Build reset windows from history; returns reset rows and token stats."""
    resets = [r for r in rows if r["kind"] == "window_reset" and from_ms <= r["epoch"] < to_ms]
    resets.sort(key=lambda r: r["epoch"])
    windows = []
    for i, reset in enumerate(resets):
        lower = from_ms if i == 0 else resets[i - 1]["epoch"]
        calls = [r for r in rows if r["kind"] == "call" and lower <= r["epoch"] < reset["epoch"]]
        windows.append({
            "reset_at": reset["epoch"],
            "calls": len(calls),
            "input": sum(r["input"] for r in calls),
            "output": sum(r["output"] for r in calls),
            "cache_read": sum(r["cache_read"] for r in calls),
            "arm_phase": "unknown",
            "verdict": "used" if calls else "idle",
        })
    return windows


def rows_for_night(rows, night_date, from_local="21:01", to_local="08:00"):
    """Select the configured local night interval, including midnight wrap."""
    try:
        day = dt.date.fromisoformat(night_date)
        start_h, start_m = (int(x) for x in from_local.split(":", 1))
        end_h, end_m = (int(x) for x in to_local.split(":", 1))
        start = dt.datetime.combine(day, dt.time(start_h, start_m))
        end_day = day + dt.timedelta(days=1) if (start_h, start_m) > (end_h, end_m) else day
        end = dt.datetime.combine(end_day, dt.time(end_h, end_m))
    except (TypeError, ValueError):
        return []
    result = []
    for r in rows:
        try:
            stamp = dt.datetime.fromisoformat((r.get("ts", "")).replace("Z", "+00:00"))
            if stamp.tzinfo is not None:
                # Interpret configured local HH:MM in the row's own local zone.
                zone = stamp.tzinfo
                start_cmp = start.replace(tzinfo=zone)
                end_cmp = end.replace(tzinfo=zone)
                if start_cmp <= stamp < end_cmp:
                    result.append(r)
            elif start <= stamp < end:
                result.append(r)
        except (TypeError, ValueError):
            continue
    return result


def credit_cost(row, price):
    """Calculate credits only when a live/explicit price is supplied."""
    if price is None:
        return None
    return (
        row.get("input", 0) * price[0]
        + row.get("output", 0) * price[1]
        + row.get("cache_read", 0) * price[2]
    )


def load_armslog(path, from_ms=None, to_ms=None):
    """Aggregate armslog events in an explicit epoch range; no raw lines."""
    result = {"events": Counter(), "delays_min": [], "confirmed_sec": []}
    if not path or not os.path.exists(path):
        return result
    reset_ready, sends, confirmed = [], [], []
    with io.open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            parts = line.rstrip("\\n").split(" | ", 2)
            if len(parts) < 2:
                continue
            stamp = parse_iso_epoch(parts[0])
            if stamp is None or (from_ms is not None and stamp < from_ms) or (to_ms is not None and stamp >= to_ms):
                continue
            event = parts[1]
            result["events"][event] += 1
            if event == "fire:reset-ready": reset_ready.append(stamp)
            elif event == "fire:send-ok": sends.append(stamp)
            elif event == "fire:confirmed": confirmed.append(stamp)
    for send in sends:
        prior = [r for r in reset_ready if r <= send]
        if prior:
            result["delays_min"].append((send - prior[-1]) / 60000.0)
    for ok in confirmed:
        prior = [s for s in sends if s <= ok]
        if prior:
            result["confirmed_sec"].append((ok - prior[-1]) / 1000.0)
    return result


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


def render_night_report(rows, ledger_rows, ledger_exists, night_date, title, price=None, extension_version="unknown", arms_stats=None):
    """Render a truthful per-night report, with history fallback and ledger status."""
    if ledger_rows:
        windows = ledger_rows
        source = "ledger.csv"
        incomplete = False
    else:
        # Caller supplies history-derived rows when ledger is absent.
        windows = night_window_from_rows(rows, night_date, 0, 2**63 - 1)
        source = "history.csv + armslog"
        incomplete = bool(windows) and not ledger_exists
    used = sum(1 for w in windows if w.get("verdict") == "used")
    idle = len(windows) - used
    total = {k: sum(w.get(k, 0) for w in windows) for k in ("calls", "input", "output", "cache_read")}
    history_resets = sum(1 for r in rows if r["kind"] == "window_reset")
    out = ["# Wormsoft night billing report: %s" % title, ""]
    out.append("- Extension version: %s" % extension_version)
    out.append("- Night date: %s" % night_date)
    out.append("- Source: %s" % source)
    out.append("- Ledger/history reset rows: %d / %d (difference: %d)" % (
        len(ledger_rows), history_resets, history_resets - len(ledger_rows)))
    if incomplete:
        out.append("- **LEDGER INCOMPLETE: data restored from history.csv and armslog**")
    out.append("- Windows: %d | used: %d | idle: %d" % (len(windows), used, idle))
    out.append("- Calls: %d | input: %s | output: %s | cache_read: %s" % (
        total["calls"], fmt_k(total["input"]), fmt_k(total["output"]), fmt_k(total["cache_read"])))
    if price is None:
        out.append("- Credits: unavailable (live Wormsoft price was not supplied; no estimate shown)")
    else:
        out.append("- Credits (explicit price input/output/cache_read): %.6f" % sum(credit_cost(w, price) or 0 for w in windows))
    if arms_stats is not None:
        ev = arms_stats["events"]
        delays = arms_stats["delays_min"]
        confirms = arms_stats["confirmed_sec"]
        out.append("- Auto-continuation: reset-ready %d | send-ok %d | confirmed %d | >5m %d" % (
            ev.get("fire:reset-ready", 0), ev.get("fire:send-ok", 0), ev.get("fire:confirmed", 0),
            sum(1 for x in delays if x > 5)))
        out.append("- Delays reset-ready→send-ok (min): %s" % (
            ", ".join("%.2f" % x for x in delays) if delays else "none"))
        out.append("- Confirmed latency (sec): %s | stale %d | switch-needed %d | epoch-mismatch %d" % (
            ", ".join("%.2f" % x for x in confirms) if confirms else "none",
            ev.get("fire:stale", 0), ev.get("fire:switch-needed", 0), ev.get("fire:epoch-mismatch", 0)))
    out.extend(["", "| # | reset | calls | input | output | cache_read | credits | arm | verdict |", "|---:|---|---:|---:|---:|---:|---:|---|---|"])
    for i, w in enumerate(windows, 1):
        cost = credit_cost(w, price)
        out.append("| %d | %s | %d | %d | %d | %d | %s | %s | %s |" % (
            i, time_hhmm(w.get("reset_at", 0)), w.get("calls", 0), w.get("input", 0),
            w.get("output", 0), w.get("cache_read", 0),
            "n/a" if cost is None else "%.6f" % cost,
            w.get("arm_phase", "unknown"), w.get("verdict", "unknown")))
    out.append("")
    return "\n".join(out)


def time_hhmm(epoch_ms):
    return dt.datetime.fromtimestamp(epoch_ms / 1000.0).strftime("%H:%M")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--file", default=DEFAULT_FILE, help="history CSV path")
    ap.add_argument("--project", default="", help="filter by project path tail (case-insensitive)")
    ap.add_argument("--days", type=int, default=30, help="only rows newer than N days (0 = all)")
    ap.add_argument("--out", default="", help="write MD report to this file instead of stdout")
    ap.add_argument("--night-date", default="", help="render one night from ledger/history fallback")
    ap.add_argument("--from-local", default="21:01", help="night local start, HH:MM")
    ap.add_argument("--to-local", default="08:00", help="night local end, HH:MM")
    ap.add_argument("--night-dir", default=DEFAULT_NIGHT_DIR, help="directory containing ledger.csv")
    ap.add_argument("--armslog", default=os.path.join(os.path.expanduser("~"), ".pi", "agent", "pi-billing-window-arms.log"), help="armslog path for night latency aggregates")
    ap.add_argument("--price-input", type=float, default=None, help="explicit credits per input token")
    ap.add_argument("--price-output", type=float, default=None, help="explicit credits per output token")
    ap.add_argument("--price-cache-read", type=float, default=None, help="explicit credits per cache_read token")
    ap.add_argument("--extension-version", default="unknown", help="extension version stamp")
    args = ap.parse_args()

    rows = load_rows(args.file, args.days)
    if rows is None:
        return 1
    if args.project:
        rows = [r for r in rows if match_project(r["pkey"], args.project)]

    if args.night_date:
        ledger_path = os.path.join(args.night_dir, "ledger.csv")
        ledger_rows, ledger_exists = load_night_ledger(ledger_path, args.night_date)
        selected = rows_for_night(rows, args.night_date, args.from_local, args.to_local)
        if not selected:
            selected = [r for r in rows if r["kind"] in ("call", "window_reset")]
        price_values = (args.price_input, args.price_output, args.price_cache_read)
        price = price_values if all(v is not None for v in price_values) else None
        if selected:
            from_ms = min(r["epoch"] for r in selected)
            to_ms = max(r["epoch"] for r in selected) + 1
            arms_stats = load_armslog(args.armslog, from_ms, to_ms)
        else:
            arms_stats = load_armslog(args.armslog)
        md = render_night_report(
            selected,
            ledger_rows,
            ledger_exists,
            args.night_date,
            args.night_date,
            price,
            args.extension_version,
            arms_stats,
        )
    else:
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
