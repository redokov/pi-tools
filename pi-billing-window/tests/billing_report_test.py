#!/usr/bin/env python3
"""tests/billing_report_test.py -- tests for scripts/billing_report.py.

Covers the per-model section of the 001-model-in-history feature:
new 13-column CSV (with `model`), legacy 12-column CSV, mixed file
(migrated header + old short rows), row filters, and regression of the
existing report sections.

Run from the repo root (or anywhere -- paths are file-relative):
  python tests/billing_report_test.py

Plain python + assert, no frameworks, non-zero exit on failure -- same
convention as the TS tests in tests/*.test.mts. Source is ASCII-only.
"""

import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import billing_report  # noqa: E402

HEADER13 = (
    "ts_iso,epoch_ms,kind,project,session,calls_in_window,reset_count,"
    "input,output,cache_read,cache_write,note,model"
)
HEADER12 = HEADER13[: -len(",model")]

PASS = 0
FAIL = 0


def check(cond, name):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("PASS %s" % name)
    else:
        FAIL += 1
        print("FAIL %s" % name)


def cells_call(epoch, project, model, inp, out, cr, cw):
    """13 cells of a call row (new format)."""
    return [
        "t%d" % epoch, str(epoch), "call", project, "s1", "1", "0",
        str(inp), str(out), str(cr), str(cw), "", model,
    ]


def cells_call_legacy(epoch, project, inp, out, cr, cw):
    """12 cells of a call row (legacy format, no model column)."""
    c = cells_call(epoch, project, "", inp, out, cr, cw)
    return c[:12]


def cells_reset(epoch, project):
    c = cells_call(epoch, project, "", 0, 0, 0, 0)
    c[2] = "window_reset"
    return c


def write_csv(path, header, rows):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        f.write(header + "\n")
        for r in rows:
            f.write(",".join(r) + "\n")


def render_csv(path, days=0, project=""):
    rows = billing_report.load_rows(path, days)
    if rows is None:
        return None, None
    if project:
        rows = [r for r in rows if billing_report.match_project(r["pkey"], project)]
    return billing_report.render(rows, project or "test"), rows


def row_dict(epoch, kind="call", reset=None, model=""):
    """Minimal in-memory row (same keys as load_rows builds)."""
    return {
        "epoch": epoch,
        "ts": "t%d" % epoch,
        "kind": kind,
        "project": "c:/a/p",
        "pkey": "c:/a/p",
        "session": "s1",
        "calls": 0,
        "reset": reset,
        "input": 0,
        "output": 0,
        "cache_read": 0,
        "cache_write": 0,
        "model": model,
    }


def main():
    now_ms = int(time.time() * 1000)
    tmpdir = tempfile.mkdtemp(prefix="billing_report_test_")
    try:
        # ---- 1. new CSV: 2 models x 2 call rows + reset row ----
        p = os.path.join(tmpdir, "new.csv")
        write_csv(
            p,
            HEADER13,
            [
                cells_call(now_ms - 1000, "c:/a/proj1", "zai/glm-5.3", 100, 50, 10, 5),
                cells_call(now_ms - 2000, "c:/a/proj1", "zai/glm-5.3", 20, 10, 1, 0),
                cells_call(now_ms - 3000, "c:/a/proj1", "openai/gpt-5", 7, 3, 0, 0),
                cells_call(now_ms - 4000, "c:/a/proj1", "openai/gpt-5", 3, 1, 0, 0),
                cells_reset(now_ms - 500, "c:/a/proj1"),
            ],
        )
        md, _ = render_csv(p)
        check(md is not None, "new csv: load_rows + render do not fail")
        check("## By model" in md, "new csv: report has '## By model' section")
        # glm: calls 2, in 120, out 60, cacheR 11, cacheW 5, total 196
        check("| zai/glm-5.3 | 2 | 120 | 60 | 11 | 5 | 196 |" in md, "new csv: glm row with exact sums")
        # gpt: calls 2, in 10, out 4, total 14
        check("| openai/gpt-5 | 2 | 10 | 4 | 0 | 0 | 14 |" in md, "new csv: gpt row with exact sums")
        # glm (196) sorted before gpt (14); -1 (missing) sorts last on purpose
        a, b = md.find("zai/glm-5.3 |"), md.find("openai/gpt-5 |")
        check(-1 < a and -1 < b and a < b, "new csv: rows sorted by total desc")
        # reset row must not add a row to the model table
        check(md.count("\n| window_reset") == 0, "new csv: reset row not in per-model table")

        # ---- 2. legacy CSV: 12 columns, no model ----
        p = os.path.join(tmpdir, "legacy.csv")
        write_csv(
            p,
            HEADER12,
            [
                cells_call_legacy(now_ms - 1000, "c:/a/proj1", 100, 50, 10, 5),
                cells_call_legacy(now_ms - 2000, "c:/a/proj1", 20, 10, 1, 0),
                cells_reset(now_ms - 500, "c:/a/proj1")[:12],
            ],
        )
        md, rows = render_csv(p)
        check(md is not None, "legacy csv: load_rows + render do not fail")
        check("## By model" in md, "legacy csv: report has '## By model' section")
        check("| (no model) | 2 | 120 | 60 | 11 | 5 | 196 |" in md, "legacy csv: single (no model) row with sums")
        check(all(r["model"] == "" for r in rows), "legacy csv: model parsed as empty string")

        # ---- 3. mixed CSV: 13-col header + legacy 12-cell rows + new 13-cell rows ----
        p = os.path.join(tmpdir, "mixed.csv")
        write_csv(
            p,
            HEADER13,
            [
                cells_call_legacy(now_ms - 5000, "c:/a/proj1", 200, 100, 0, 0),
                cells_call(now_ms - 1000, "c:/a/proj1", "zai/glm-5.3", 100, 50, 10, 5),
                cells_call(now_ms - 2000, "c:/a/proj1", "zai/glm-5.3", 20, 10, 1, 0),
            ],
        )
        md, _ = render_csv(p)
        check(md is not None, "mixed csv: load_rows + render do not fail")
        check("| zai/glm-5.3 | 2 | 120 | 60 | 11 | 5 | 196 |" in md, "mixed csv: model row aggregated")
        check("| (no model) | 1 | 200 | 100 | 0 | 0 | 300 |" in md, "mixed csv: legacy rows -> (no model)")
        check(-1 < md.find("| (no model)") < md.find("| zai/glm-5.3"), "mixed csv: sort by total desc")

        # ---- 4. filters: --days and --project apply before per-model grouping ----
        p = os.path.join(tmpdir, "filter.csv")
        write_csv(
            p,
            HEADER13,
            [
                cells_call(now_ms - 40 * 24 * 3600 * 1000, "c:/a/old", "zai/glm-5.3", 999, 0, 0, 0),
                cells_call(now_ms - 1000, "c:/a/proj1", "zai/glm-5.3", 100, 50, 10, 5),
                cells_call(now_ms - 2000, "c:/a/proj2", "openai/gpt-5", 7, 3, 0, 0),
            ],
        )
        md, _ = render_csv(p, days=1)
        check(md is not None, "filter days: report renders")
        check("openai/gpt-5" in md and "999" not in md, "filter days: old row excluded from per-model")
        md, _ = render_csv(p, days=0, project="proj2")
        check(md is not None, "filter project: report renders")
        check("openai/gpt-5" in md, "filter project: matching project model present")
        check("zai/glm-5.3" not in md, "filter project: other project model excluded")

        # ---- 5. regression: existing sections survive ----
        p = os.path.join(tmpdir, "regress.csv")
        write_csv(
            p,
            HEADER13,
            [
                cells_call(now_ms - 1000, "c:/a/proj1", "zai/glm-5.3", 100, 50, 10, 5),
                cells_call(now_ms - 2000, "c:/a/proj1", "openai/gpt-5", 20, 10, 1, 0),
            ],
        )
        md, _ = render_csv(p)
        check("## Total (all projects)" in md, "regression: total section present")
        check("Calls: 2 | Tokens: 196" in md, "regression: total counts correct")
        check("## proj1" in md, "regression: per-project section present")
        check("Calls: 2 | Tokens: 196 (in 120 / out 60 / cacheR 11 / cacheW 5)" in md,
              "regression: per-project sums correct")
        # no call rows -> no per-model section
        p = os.path.join(tmpdir, "no_calls.csv")
        write_csv(p, HEADER13, [cells_reset(now_ms - 1000, "c:/a/proj1")])
        md, _ = render_csv(p)
        check("## By model" not in md, "no call rows: per-model section omitted")

        # ---- 6. whitespace-only model -> (no model) ----
        p = os.path.join(tmpdir, "space.csv")
        r = cells_call(now_ms - 1000, "c:/a/proj1", "  ", 30, 10, 0, 0)
        write_csv(p, HEADER13, [r])
        md, _ = render_csv(p)
        check("| (no model) | 1 | 30 | 10 | 0 | 0 | 40 |" in md, "whitespace model -> (no model)")

        # ---- 7. empty per-model + None reset_count (review fixes) ----
        # (a) render_per_model with zero call rows -> empty string, no section
        reset_rows = [row_dict(now_ms - i, kind="window_reset", reset=i) for i in (1, 2)]
        pm = billing_report.render_per_model(reset_rows)
        check(pm == "", "render_per_model: empty string when no call rows")
        check("## By model" not in pm, "render_per_model: no '## By model' header when empty")
        # CSV-level: only window_reset rows -> render omits the section
        p = os.path.join(tmpdir, "resets_only.csv")
        write_csv(
            p,
            HEADER13,
            [
                cells_reset(now_ms - 1000, "c:/a/proj1"),
                cells_reset(now_ms - 2000, "c:/a/proj1"),
            ],
        )
        md, _ = render_csv(p)
        check("## By model" not in md, "resets-only csv: '## By model' absent from report")
        check("## Total (all projects)" in md, "resets-only csv: total section still present")

        # (b) split_windows: None reset_count mid-stream must not raise TypeError
        mixed = [
            row_dict(now_ms - 3000, kind="call", reset=1, model="zai/glm-5.3"),
            row_dict(now_ms - 2000, kind="call", reset=None),  # empty reset_count cell
            row_dict(now_ms - 1000, kind="call", reset=1),
        ]
        ws = billing_report.split_windows(mixed)
        # None is normalized to 0: row2 (0) joins window 1, row3 (1 > 0) opens window 2
        check(len(ws) == 2, "split_windows: None reset mid-stream handled without TypeError")
        check(sum(len(w["rows"]) for w in ws) == 3, "split_windows: all rows kept")
        # None first, then a real increment -> 2 windows, no TypeError
        mixed2 = [
            row_dict(now_ms - 3000, kind="call", reset=None),
            row_dict(now_ms - 2000, kind="call", reset=5),
            row_dict(now_ms - 1000, kind="call", reset=5),
        ]
        ws2 = billing_report.split_windows(mixed2)
        check(len(ws2) == 2, "split_windows: reset increment after None row splits windows")

    finally:
        import shutil

        shutil.rmtree(tmpdir, ignore_errors=True)

    print("")
    print("passed: %d, failed: %d" % (PASS, FAIL))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
