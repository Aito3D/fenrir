#!/usr/bin/env python3
"""Sum coverage over the campaign SCOPE from a full coverage.py JSON report.

Reads a coverage json report and a list of scope path prefixes/globs, prints the
scoped statement + branch totals. Keeps the gate honest: the report measures the
whole tree, this filters it, so scope cannot be widened to inflate the number.
"""
import fnmatch
import json
import sys

report, *patterns = sys.argv[1:]
data = json.load(open(report))
files = data["files"]

sel = {
    path: m
    for path, m in files.items()
    if any(fnmatch.fnmatch(path, p) for p in patterns)
}
if not sel:
    print("SCOPE MATCHED NO FILES — scope list is stale", file=sys.stderr)
    sys.exit(2)

cov = sum(s["summary"]["covered_lines"] for s in sel.values())
tot = sum(s["summary"]["num_statements"] for s in sel.values())
bcov = sum(s["summary"].get("covered_branches", 0) for s in sel.values())
btot = sum(s["summary"].get("num_branches", 0) for s in sel.values())

for path in sorted(sel):
    s = sel[path]["summary"]
    print(f"  {s['percent_covered']:6.2f}%  {path}")
print(f"\nSCOPED statements: {cov}/{tot} = {100*cov/tot:.2f}%")
print(f"SCOPED branches:   {bcov}/{btot} = {100*bcov/btot:.2f}%" if btot else "SCOPED branches: n/a")
