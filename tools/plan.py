#!/usr/bin/env python3
"""plan.py — deterministic controller for PLAN.md (refactor-loop skill).

PLAN.md is the single source of truth for loop state. This script parses,
mutates, and renders it so loop-control decisions (task selection, stuck
detection, dashboards) are mechanical instead of LLM-interpreted.

Usage:
  plan.py init                                   # create empty PLAN.md
  plan.py add --priority P1 --title "..." --files "a.py,b.py" \
              --evidence "..." [--round 1] [--iteration 0]
  plan.py select [--max 3] [--iteration N]       # pick top OPEN tasks -> IN_PROGRESS
  plan.py set-status T-001 DONE [--reason "..."] [--iteration N]
  plan.py check-stuck --iteration N              # apply attempts>=3 / stale rules
  plan.py render [--iteration N] [--round R] [--coverage "63.4% -> 65.1%"] [--verdict PASS] [--max-iter 8]
  plan.py stats                                  # machine-readable counts (JSON)
  plan.py has-open                               # exit 0 if OPEN tasks remain, 1 otherwise

All commands accept --file (default: ./PLAN.md).
"""
import argparse
import json
import re
import sys
from pathlib import Path

HEADER = "# PLAN (schema v1)"
FIELDS = ["priority", "status", "attempts", "round",
          "first_seen_iteration", "last_touched_iteration",
          "title", "files", "evidence", "reason"]
INT_FIELDS = {"attempts", "round", "first_seen_iteration", "last_touched_iteration"}
STATUSES = {"OPEN", "IN_PROGRESS", "DONE", "BLOCKED", "WONTFIX-AUTO"}
PRIORITIES = ["P0", "P1", "P2", "P3"]
ICONS = {"DONE": "\u2705", "IN_PROGRESS": "\U0001f504", "OPEN": "\u2b1c",
         "BLOCKED": "\U0001f6ab", "WONTFIX-AUTO": "\u23ed\ufe0f"}
STATUS_ORDER = ["DONE", "IN_PROGRESS", "OPEN", "BLOCKED", "WONTFIX-AUTO"]


def parse(path: Path):
    if not path.exists():
        sys.exit(f"error: {path} not found (run 'plan.py init' first)")
    tasks, cur = [], None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.rstrip()
        m = re.match(r"^## (T-\d+)\s*$", line)
        if m:
            cur = {"id": m.group(1)}
            tasks.append(cur)
            continue
        if cur is None or ":" not in line:
            continue
        key, val = line.split(":", 1)
        key = key.strip()
        if key not in FIELDS:
            continue
        val = re.split(r"\s+#", val.strip(), maxsplit=1)[0].strip()
        cur[key] = int(val) if key in INT_FIELDS and val.lstrip("-").isdigit() else val
    for t in tasks:
        t.setdefault("status", "OPEN")
        t.setdefault("priority", "P3")
        for f in INT_FIELDS:
            t.setdefault(f, 0)
        t.setdefault("title", "")
        t.setdefault("files", "")
        t.setdefault("evidence", "")
    return tasks


def write(path: Path, tasks):
    out = [HEADER, ""]
    for t in tasks:
        out.append(f"## {t['id']}")
        for f in FIELDS:
            if f == "reason" and not t.get("reason"):
                continue
            out.append(f"{f}: {t.get(f, '')}")
        out.append("")
    path.write_text("\n".join(out) + "\n", encoding="utf-8")


def next_id(tasks):
    mx = max((int(t["id"][2:]) for t in tasks), default=0)
    return f"T-{mx + 1:03d}"


def find(tasks, tid):
    for t in tasks:
        if t["id"] == tid:
            return t
    sys.exit(f"error: task {tid} not found")


def cmd_init(a):
    p = Path(a.file)
    if p.exists():
        sys.exit(f"error: {p} already exists")
    write(p, [])
    print(f"created {p}")


def cmd_add(a):
    p = Path(a.file)
    tasks = parse(p) if p.exists() else []
    if a.priority not in PRIORITIES:
        sys.exit(f"error: priority must be one of {PRIORITIES}")
    t = {"id": next_id(tasks), "priority": a.priority, "status": "OPEN",
         "attempts": 0, "round": a.round, "first_seen_iteration": a.iteration,
         "last_touched_iteration": a.iteration, "title": a.title,
         "files": a.files or "", "evidence": a.evidence or ""}
    tasks.append(t)
    write(p, tasks)
    print(t["id"])


def cmd_select(a):
    p = Path(a.file)
    tasks = parse(p)
    open_tasks = sorted([t for t in tasks if t["status"] == "OPEN"],
                        key=lambda t: (PRIORITIES.index(t["priority"])
                                       if t["priority"] in PRIORITIES else 99,
                                       int(t["id"][2:])))
    picked = open_tasks[: a.max]
    for t in picked:
        t["status"] = "IN_PROGRESS"
        t["attempts"] = int(t["attempts"]) + 1
        t["last_touched_iteration"] = a.iteration
    write(p, tasks)
    print(json.dumps([{"id": t["id"], "priority": t["priority"],
                       "title": t["title"], "files": t["files"],
                       "attempts": t["attempts"], "evidence": t["evidence"]}
                      for t in picked], indent=2))


def cmd_set_status(a):
    p = Path(a.file)
    tasks = parse(p)
    if a.status not in STATUSES:
        sys.exit(f"error: status must be one of {sorted(STATUSES)}")
    t = find(tasks, a.task_id)
    t["status"] = a.status
    if a.reason:
        t["reason"] = a.reason
    if a.iteration is not None:
        t["last_touched_iteration"] = a.iteration
    write(p, tasks)
    print(f"{a.task_id} -> {a.status}")


def cmd_check_stuck(a):
    p = Path(a.file)
    tasks = parse(p)
    changes = []
    for t in tasks:
        if t["status"] in ("DONE", "BLOCKED", "WONTFIX-AUTO"):
            continue
        if int(t["attempts"]) >= 3:
            t["status"] = "BLOCKED"
            t["reason"] = t.get("reason") or "3 attempts without success — revert its commits"
            changes.append(f"{t['id']} -> BLOCKED (attempts >= 3; REVERT its commits)")
        elif int(t["first_seen_iteration"]) <= a.iteration - 2 and int(t["first_seen_iteration"]) > 0:
            t["status"] = "WONTFIX-AUTO"
            t["reason"] = t.get("reason") or f"unresolved since iteration {t['first_seen_iteration']}"
            changes.append(f"{t['id']} -> WONTFIX-AUTO (stale since iter {t['first_seen_iteration']})")
    write(p, tasks)
    print("\n".join(changes) if changes else "no stuck tasks")


def cmd_render(a):
    tasks = parse(Path(a.file))
    lines = [f"\u2550\u2550\u2550 REFACTOR LOOP \u2014 Round {a.round} \u00b7 "
             f"Iteration {a.iteration}/{a.max_iter} \u2550\u2550\u2550"]
    ordered = sorted(tasks, key=lambda t: (STATUS_ORDER.index(t["status"]),
                                           PRIORITIES.index(t["priority"])
                                           if t["priority"] in PRIORITIES else 99,
                                           int(t["id"][2:])))
    for t in ordered:
        icon = ICONS.get(t["status"], "?")
        extra = ""
        if t["status"] == "IN_PROGRESS":
            extra = f" (attempt {t['attempts']}/3)"
        elif t["status"] == "BLOCKED" and t.get("reason"):
            extra = f": {t['reason']}"
        elif t["status"] == "WONTFIX-AUTO":
            extra = " (needs human)"
        lines.append(f"{icon} {t['id']} [{t['priority']}] {t['title']} \u2014 {t['status']}{extra}")
    done = sum(1 for t in tasks if t["status"] == "DONE")
    lines.append("\u2500" * 39)
    tail = [f"Done: {done}/{len(tasks)}"]
    if a.coverage:
        tail.append(f"Coverage: {a.coverage}")
    if a.verdict:
        tail.append(f"Last verdict: {a.verdict}")
    lines.append(" \u00b7 ".join(tail))
    print("\n".join(lines))


def cmd_stats(a):
    tasks = parse(Path(a.file))
    counts = {s: sum(1 for t in tasks if t["status"] == s) for s in STATUSES}
    print(json.dumps({"total": len(tasks), **counts}))


def cmd_resume_info(a):
    tasks = parse(Path(a.file))
    counts = {s: sum(1 for t in tasks if t["status"] == s) for s in STATUSES}
    print(json.dumps({
        "total": len(tasks), **counts,
        "last_iteration": max((int(t["last_touched_iteration"]) for t in tasks), default=0),
        "max_round": max((int(t["round"]) for t in tasks), default=1),
        "in_progress_ids": [t["id"] for t in tasks if t["status"] == "IN_PROGRESS"],
        "open_ids": [t["id"] for t in tasks if t["status"] == "OPEN"],
    }, indent=2))


def cmd_has_open(a):
    tasks = parse(Path(a.file))
    n = sum(1 for t in tasks if t["status"] == "OPEN")
    print(n)
    sys.exit(0 if n > 0 else 1)


def main():
    ap = argparse.ArgumentParser(description="PLAN.md controller for the refactor-loop skill")
    ap.add_argument("--file", default="PLAN.md")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init").set_defaults(fn=cmd_init)

    s = sub.add_parser("add")
    s.add_argument("--priority", required=True)
    s.add_argument("--title", required=True)
    s.add_argument("--files", default="")
    s.add_argument("--evidence", default="")
    s.add_argument("--round", type=int, default=1)
    s.add_argument("--iteration", type=int, default=0)
    s.set_defaults(fn=cmd_add)

    s = sub.add_parser("select")
    s.add_argument("--max", type=int, default=3)
    s.add_argument("--iteration", type=int, default=0)
    s.set_defaults(fn=cmd_select)

    s = sub.add_parser("set-status")
    s.add_argument("task_id")
    s.add_argument("status")
    s.add_argument("--reason", default="")
    s.add_argument("--iteration", type=int, default=None)
    s.set_defaults(fn=cmd_set_status)

    s = sub.add_parser("check-stuck")
    s.add_argument("--iteration", type=int, required=True)
    s.set_defaults(fn=cmd_check_stuck)

    s = sub.add_parser("render")
    s.add_argument("--iteration", type=int, default=1)
    s.add_argument("--round", type=int, default=1)
    s.add_argument("--max-iter", type=int, default=8)
    s.add_argument("--coverage", default="")
    s.add_argument("--verdict", default="")
    s.set_defaults(fn=cmd_render)

    sub.add_parser("stats").set_defaults(fn=cmd_stats)
    sub.add_parser("resume-info").set_defaults(fn=cmd_resume_info)
    sub.add_parser("has-open").set_defaults(fn=cmd_has_open)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
