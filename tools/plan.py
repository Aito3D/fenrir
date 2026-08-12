#!/usr/bin/env python3
"""plan.py — deterministic controller for PLAN.md (refactor-loop skill).

PLAN.md is the single source of truth for loop state. This script parses,
mutates, and renders it so loop-control decisions (task selection, stuck
detection, dashboards) are mechanical instead of LLM-interpreted.

Usage:
  plan.py init                                   # create empty PLAN.md
  plan.py add --priority P1 --title "..." --files "a.py,b.py" \
              --evidence "..." [--round 1] [--iteration 0] \
              [--fingerprint HEX] [--source survey|audit-security|...]
  plan.py ingest --source audit-security --findings findings.json \
              [--round 1] [--iteration 0] [--triage P2,P3]
              # file auditor findings, deduped; findings whose mapped
              # priority is in --triage are filed into TRIAGE.md instead of
              # PLAN.md (default: empty, i.e. everything goes to PLAN.md).
              # The behavior-change gate outranks --triage: a finding with
              # behavior_change true is ALWAYS filed into PLAN.md as BLOCKED
              # ("needs user approval"), never diverted to TRIAGE.md,
              # regardless of its mapped priority — behavior_change is not
              # a severity signal, it says WHO is allowed to decide, and
              # only the user may.
  plan.py select [--max 3] [--iteration N]       # pick top OPEN tasks -> IN_PROGRESS
  plan.py set-status T-001 DONE [--reason "..."] [--iteration N]
  plan.py check-stuck --iteration N              # apply attempts>=3 / stale rules
  plan.py render [--iteration N] [--round R] [--coverage "63.4% -> 65.1%"] [--verdict PASS] [--max-iter 8]
  plan.py stats                                  # machine-readable counts (JSON)
  plan.py show T-001                             # one task's full record as JSON
                                                  # (every field, including evidence
                                                  # and reason — this is how the
                                                  # APPROVAL SWEEP reads a BLOCKED
                                                  # task's "user-visible change: ..."
                                                  # fragment, which no other command
                                                  # prints). Works against TRIAGE.md
                                                  # too: `plan.py --file TRIAGE.md
                                                  # show T-001`.
  plan.py has-open                               # exit 0 if OPEN tasks remain, 1 otherwise
  plan.py promote T-042 --iteration N            # move a TRIAGE.md entry into PLAN.md as OPEN
                                                  # (or BLOCKED, if it still needs approval);
                                                  # --iteration is REQUIRED (not defaulted — see
                                                  # the flag's own help) and resets the entry's
                                                  # staleness clock so check-stuck doesn't judge
                                                  # it by the iteration it was triaged at

All commands accept --file (default: ./PLAN.md), e.g. `plan.py --file
TRIAGE.md render --iteration N` to read the triage list. --file is a
TOP-LEVEL flag (defined before the subcommand in argparse), so it must be
given BEFORE the subcommand name — `plan.py render --file TRIAGE.md ...`
is a parse error, not a working alternate spelling. TRIAGE.md is always a
sibling of --file in the same directory (never separately configurable),
so both live wherever the orchestrator put PLAN.md.
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

HEADER = "# PLAN (schema v2)"
TRIAGE_HEADER = "# TRIAGE (schema v2)"
FIELDS = ["priority", "status", "attempts", "round",
          "first_seen_iteration", "last_touched_iteration",
          "title", "files", "evidence", "fingerprint", "source", "reason"]
INT_FIELDS = {"attempts", "round", "first_seen_iteration", "last_touched_iteration"}
STATUSES = {"OPEN", "IN_PROGRESS", "DONE", "BLOCKED", "WONTFIX-AUTO", "TRIAGED"}
PRIORITIES = ["P0", "P1", "P2", "P3"]
ICONS = {"DONE": "\u2705", "IN_PROGRESS": "\U0001f504", "OPEN": "\u2b1c",
         "BLOCKED": "\U0001f6ab", "WONTFIX-AUTO": "\u23ed\ufe0f",
         "TRIAGED": "\U0001f4e5"}
# TRIAGED must stay in STATUS_ORDER (not just STATUSES): render/stats/
# resume-info all index or iterate STATUS_ORDER unconditionally, so a task
# whose status isn't in it crashes render (ValueError) and stats (KeyError)
# instead of just failing to sort nicely. This is also what makes
# `plan.py --file TRIAGE.md render` work as a way for a human to read the
# triage list.
STATUS_ORDER = ["DONE", "IN_PROGRESS", "OPEN", "BLOCKED", "WONTFIX-AUTO", "TRIAGED"]
# every source `stats` reports a row for, whether or not it filed anything
SOURCES = ["audit-security", "audit-robustness", "audit-cleanliness",
           "audit-tests", "survey"]


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
        val = val.strip()
        if key in INT_FIELDS:
            # trailing "# note" annotations are only meaningful on counters;
            # stripping them from text fields truncates cited code excerpts
            val = re.split(r"\s+#", val, maxsplit=1)[0].strip()
            cur[key] = int(val) if val.lstrip("-").isdigit() else val
        else:
            cur[key] = val
    for t in tasks:
        t.setdefault("status", "OPEN")
        t.setdefault("priority", "P3")
        for f in INT_FIELDS:
            t.setdefault(f, 0)
        for f in ("title", "files", "evidence", "fingerprint", "source"):
            t.setdefault(f, "")
    return tasks


def header_for(path: Path) -> str:
    """Pick PLAN.md's or TRIAGE.md's header from the path being written.

    parse() is header-agnostic (it only matches "## T-nnn" and "key: value"
    lines), so this is cosmetic — but a human opening either file by hand
    should see which one they're looking at. Deriving it from the path
    name, rather than requiring every caller to pass the right one
    explicitly, is what keeps commands that don't know they might be
    touching TRIAGE.md (check-stuck, select, set-status all call plain
    write(p, tasks) and can be pointed at either file via --file) from
    flipping TRIAGE.md's header back to PLAN.md's the moment they touch it.
    """
    return TRIAGE_HEADER if path.name == "TRIAGE.md" else HEADER


def write(path: Path, tasks, header: str = None):
    if header is None:
        header = header_for(path)
    out = [header, ""]
    for t in tasks:
        out.append(f"## {t['id']}")
        for f in FIELDS:
            if f == "reason" and not t.get("reason"):
                continue
            # normalize at the point of write: PLAN.md is line-oriented and
            # parse() accepts any "key: value" line whose key is in FIELDS, so
            # an embedded newline anywhere (argv, a findings file) would inject
            # arbitrary fields into the task block. Normalizing here closes
            # every present and future caller at once.
            out.append(f"{f}: {normalize(t.get(f, ''))}")
        out.append("")
    path.write_text("\n".join(out) + "\n", encoding="utf-8")


def next_id(tasks, extra=()):
    mx = max((int(t["id"][2:]) for t in list(tasks) + list(extra)), default=0)
    return f"T-{mx + 1:03d}"


def archived_plans(path: Path):
    """Sibling PLAN.campaign<N>.md files left by `archive`, oldest name first."""
    return sorted(path.parent.glob("PLAN.campaign*.md"))


def archived_tasks(path: Path):
    """Tasks from every archived campaign beside `path`.

    Dedup and id allocation both have to see them: otherwise campaign 2
    re-files everything campaign 1 declined and restarts ids at T-001 while
    commit subjects still reference the campaign-1 ids.
    """
    tasks = []
    for arch in archived_plans(path):
        tasks.extend(parse(arch))
    return tasks


def triage_path(path: Path) -> Path:
    """TRIAGE.md is always a sibling of PLAN.md, never separately named."""
    return path.with_name("TRIAGE.md")


def reject_triage_alias(p: Path):
    """Refuse --file TRIAGE.md on commands that write both files.

    `with_name("TRIAGE.md")` makes triage_path(p) == p when --file already
    points at TRIAGE.md, so a later `write(p, ...)` and `write(triage_path(p),
    ...)` silently clobber each other instead of touching two files. Call
    this before any command writes to both p and triage_path(p).
    """
    if p.resolve() == triage_path(p).resolve():
        sys.exit(f"error: --file must not be TRIAGE.md itself (got {p}) — "
                 "TRIAGE.md is always the sibling of --file, so pointing "
                 "--file at it aliases the two files and silently loses data")


def triage_tasks(path: Path):
    """Tasks currently sitting in TRIAGE.md beside `path`, or [] if none yet.

    Callers that need id allocation or dedup to see triaged entries (they
    both must — see `cmd_ingest`) go through this, not a bare parse(), so a
    campaign that has never triaged anything doesn't require TRIAGE.md to
    exist.
    """
    tp = triage_path(path)
    return parse(tp) if tp.exists() else []


def find(tasks, tid):
    for t in tasks:
        if t["id"] == tid:
            return t
    sys.exit(f"error: task {tid} not found")


SEVERITY_TO_PRIORITY = {"critical": "P0", "high": "P1",
                        "medium": "P2", "low": "P3"}


def normalize(text):
    """Collapse to a single whitespace-normalized line (PLAN.md is line-based)."""
    return " ".join(str(text if text is not None else "").split())


def fingerprint_of(finding):
    """Stable dedup key for a finding: file + normalized title.

    Line numbers are deliberately excluded: they drift with every refactor,
    and including them would let the same issue be re-filed each round.

    `category` is excluded for the same reason and a stronger one: it is
    free text with no controlled vocabulary, so an auditor that says
    "dead-code" one round and "unused-code" the next would re-file the same
    issue and reset the convergence counter. Every auditor prompt states
    that `file` and `title` together identify the finding; this is that key.
    """
    key = "{}|{}".format(normalize(finding.get("file")),
                         normalize(finding.get("title")).lower())
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


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
    t = {"id": next_id(tasks, archived_tasks(p) + triage_tasks(p)),
         "priority": a.priority, "status": "OPEN",
         "attempts": 0, "round": a.round, "first_seen_iteration": a.iteration,
         "last_touched_iteration": a.iteration, "title": a.title,
         "files": a.files or "", "evidence": a.evidence or "",
         "fingerprint": a.fingerprint or "", "source": a.source or "survey"}
    tasks.append(t)
    write(p, tasks)
    print(t["id"])


def cmd_ingest(a):
    p = Path(a.file)
    reject_triage_alias(p)
    # ingest never creates PLAN.md: a fresh plan has zero fingerprints, so an
    # ingest run from the wrong directory would silently re-file everything
    # instead of deduping. parse() exits with "run 'plan.py init' first".
    tasks = parse(p)
    try:
        payload = json.loads(Path(a.findings).read_text(encoding="utf-8"))
    except OSError as e:
        sys.exit(f"error: cannot read {a.findings}: {e}")
    except UnicodeDecodeError as e:
        sys.exit(f"error: {a.findings} is not valid UTF-8: {e}")
    except json.JSONDecodeError as e:
        sys.exit(f"error: {a.findings} is not valid JSON: {e}")
    findings = payload.get("findings") if isinstance(payload, dict) else payload
    if not isinstance(findings, list):
        sys.exit("error: expected a list of findings, or an object with a "
                 "'findings' list")

    triage_priorities = {x.strip() for x in a.triage.split(",") if x.strip()}
    if triage_priorities - set(PRIORITIES):
        sys.exit("error: --triage must be a comma-separated subset of "
                 f"{PRIORITIES}, got {a.triage!r}")

    # validate the whole batch before touching PLAN.md, so a malformed
    # finding can never leave the plan half-written
    for f in findings:
        if not isinstance(f, dict):
            sys.exit("error: every finding must be a JSON object")
        if normalize(f.get("severity")).lower() not in SEVERITY_TO_PRIORITY:
            sys.exit("error: severity must be one of "
                     f"{sorted(SEVERITY_TO_PRIORITY)}, got {f.get('severity')!r}")
        if not normalize(f.get("title")):
            sys.exit("error: every finding needs a non-empty 'title'")
        if not normalize(f.get("file")):
            sys.exit("error: every finding needs a non-empty 'file' "
                     "(it becomes the task's 'files', which is what the "
                     "worker is handed)")
        if not normalize(f.get("evidence")):
            sys.exit("error: every finding needs non-empty 'evidence' "
                     "(a scanner rule id or a verbatim code excerpt)")

    # dedup spans archived campaigns AND the sibling TRIAGE.md too, so a
    # resurvey round does not re-file (or re-triage) something already
    # declined, WONTFIX-AUTO'd, held for approval, or sitting in triage —
    # this is what stops the panel from re-reporting its own triage lane
    # every round.
    prior = archived_tasks(p)
    triaged = triage_tasks(p)
    seen = {t["fingerprint"] for t in tasks + triaged + prior
           if t.get("fingerprint")}
    new_ids, suppressed, blocked_ids, triaged_ids = [], 0, [], []
    for f in findings:
        fp = fingerprint_of(f)
        if fp in seen:
            suppressed += 1
            continue
        seen.add(fp)
        where = normalize(f.get("file"))
        if f.get("line"):
            where = normalize(f"{where}:{f['line']}")
        fix = normalize(f.get("fix"))
        note = normalize(f.get("behavior_change_note"))
        evidence = " · ".join(part for part in
                              (where, normalize(f.get("evidence")),
                               f"fix: {fix}" if fix else "",
                               f"user-visible change: {note}" if note else "")
                              if part)
        priority = SEVERITY_TO_PRIORITY[normalize(f["severity"]).lower()]
        is_behavior_change = bool(f.get("behavior_change"))
        t = {"id": next_id(tasks, triaged + prior),
             "priority": priority, "status": "OPEN",
             "attempts": 0, "round": a.round,
             "first_seen_iteration": a.iteration,
             "last_touched_iteration": a.iteration,
             "title": normalize(f.get("title")),
             "files": normalize(f.get("file")),
             "evidence": evidence, "fingerprint": fp, "source": a.source}
        # The behavior-change gate outranks the triage filter. `behavior_change`
        # is not a severity signal — severity says how much a finding matters,
        # behavior_change says WHO is allowed to decide it. A low-severity
        # finding that would alter observable behavior is still a decision
        # only the user can make, so it is never diverted to TRIAGE.md
        # regardless of its mapped priority or what --triage was passed:
        # diverting it there would let a human `promote` it straight to OPEN
        # and hand it to the worker with no approval ever asked, defeating
        # SKILL.md's BEHAVIOR-CHANGE GATE.
        if is_behavior_change:
            t["status"] = "BLOCKED"
            t["reason"] = "needs user approval"
            blocked_ids.append(t["id"])
            tasks.append(t)
            new_ids.append(t["id"])
        elif priority in triage_priorities:
            t["status"] = "TRIAGED"
            triaged.append(t)
            triaged_ids.append(t["id"])
        else:
            tasks.append(t)
            new_ids.append(t["id"])

    write(p, tasks)
    if triaged_ids:
        # only rewrite TRIAGE.md when something actually changed — round-
        # tripping it through parse()/write() on every ingest, even a dry
        # one, silently drops any line a human added by hand whose key
        # isn't in FIELDS (e.g. an annotation comment).
        write(triage_path(p), triaged)
    # `blocked`/`blocked_ids` deliberately overlap `new`/`ids` (a blocked task
    # is still filed, just held) — blocked_ids is a SUBSET of ids.
    # `triaged`/`triaged_ids` are the opposite: they are DISJOINT from
    # `new`/`ids` — a triaged finding was never filed into PLAN.md at all, so
    # don't sum them together when reporting to the user.
    # blocked_ids is printed, not just counted, because the APPROVAL SWEEP in
    # SKILL.md has to ask the user about each of those tasks by id: `ids`
    # mixes blocked with workable and nothing else in this tool distinguishes
    # them, so a count alone left the sweep unexecutable. Feed each id to
    # `plan.py show <id>` to read its "user-visible change: ..." fragment.
    print(json.dumps({"source": a.source, "new": len(new_ids),
                      "suppressed": suppressed, "blocked": len(blocked_ids),
                      "ids": new_ids, "blocked_ids": blocked_ids,
                      "triaged": len(triaged_ids), "triaged_ids": triaged_ids},
                     indent=2))


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
                       "attempts": t["attempts"], "evidence": t["evidence"],
                       "source": t.get("source", "")}
                      for t in picked], indent=2))


def cmd_set_status(a):
    p = Path(a.file)
    tasks = parse(p)
    if a.status not in STATUSES:
        sys.exit(f"error: status must be one of {sorted(STATUSES)}")
    t = find(tasks, a.task_id)
    prior_status = t["status"]
    t["status"] = a.status
    if a.reason:
        t["reason"] = a.reason
    if a.iteration is not None:
        t["last_touched_iteration"] = a.iteration
        if a.status == "OPEN" and prior_status == "BLOCKED":
            # Re-entering the workable pool specifically FROM BLOCKED (the
            # user-approved-behavior-change path) is a fresh event: without
            # this, first_seen_iteration keeps whatever value it had while
            # stuck, so check-stuck's staleness rule could WONTFIX-AUTO the
            # task on its very first real attempt with a false "unresolved
            # since iteration N" reason. Deliberately narrower than "any
            # transition to OPEN" — an IN_PROGRESS -> OPEN reset (e.g. the
            # RESUME check's "reset it to OPEN before resuming" for a task
            # interrupted mid-work) is not a fresh event for a genuinely old
            # task, and must not get a clock reset it didn't earn.
            t["first_seen_iteration"] = a.iteration
    write(p, tasks)
    print(f"{a.task_id} -> {a.status}")


def cmd_check_stuck(a):
    p = Path(a.file)
    tasks = parse(p)
    changes = []
    for t in tasks:
        if t["status"] in ("DONE", "BLOCKED", "WONTFIX-AUTO", "TRIAGED"):
            continue
        if int(t["attempts"]) >= 3:
            t["status"] = "BLOCKED"
            t["reason"] = t.get("reason") or "3 attempts without success — revert its commits"
            changes.append(f"{t['id']} -> BLOCKED (attempts >= 3; REVERT its commits)")
        elif (int(t["attempts"]) >= 1
              and 0 < int(t["first_seen_iteration"]) <= a.iteration - 2):
            t["status"] = "WONTFIX-AUTO"
            t["reason"] = t.get("reason") or f"unresolved since iteration {t['first_seen_iteration']}"
            changes.append(f"{t['id']} -> WONTFIX-AUTO (stale since iter {t['first_seen_iteration']})")
    write(p, tasks)
    print("\n".join(changes) if changes else "no stuck tasks")


def cmd_render(a):
    p = Path(a.file)
    tasks = parse(p)
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
    # PLAN.md's own Done/total denominator excludes everything sitting in
    # TRIAGE.md by design (TRIAGE default is P2,P3) \u2014 surface it here too,
    # so the dashboard never silently hides most of a campaign's findings
    # and the orchestrator's own view after a compaction still shows it.
    # Skip this when `p` already IS TRIAGE.md (triage_path(p) == p in that
    # case): otherwise a `render --file TRIAGE.md` prints a footer counting
    # its own entries underneath themselves.
    if triage_path(p).resolve() != p.resolve():
        triaged_n = len(triage_tasks(p))
        if triaged_n:
            lines.append(f"Triaged: {triaged_n} \u2014 see TRIAGE.md")
    print("\n".join(lines))


def cmd_stats(a):
    p = Path(a.file)
    tasks = parse(p)
    counts = {s: sum(1 for t in tasks if t["status"] == s) for s in STATUS_ORDER}
    # seed every source the panel can report from, so an auditor that found
    # nothing all campaign reads as zero in FINAL_REPORT.md instead of vanishing
    by_source = {name: {s: 0 for s in STATUS_ORDER} for name in SOURCES}
    for t in tasks:
        bucket = by_source.setdefault(t.get("source") or "survey",
                                      {s: 0 for s in STATUS_ORDER})
        bucket[t["status"]] += 1
    triaged_total = len(triage_tasks(p))
    print(json.dumps({"total": len(tasks), **counts, "triaged": triaged_total,
                      "by_source": by_source}, indent=2))


def cmd_show(a):
    """Print one task's complete record as JSON.

    Every other read command is lossy in a way that matters to the APPROVAL
    SWEEP: `ingest` prints ids and counts, `render` prints id + status +
    reason, `select` returns evidence but skips BLOCKED by design, and
    `stats`/`resume-info` are counts. Nothing printed the `evidence` field of
    a BLOCKED task — which is where `ingest` folds the auditor's
    `behavior_change_note` as a `user-visible change: ...` fragment, the exact
    sentence SKILL.md tells the orchestrator to quote when asking the user to
    approve a behavior change. Since ALL PLAN.md/TRIAGE.md reads must go
    through this script, that sentence was unreachable without this command.

    Reads whatever --file points at, so it works on TRIAGE.md unchanged
    (`plan.py --file TRIAGE.md show T-001`); it only reads, so it never needs
    reject_triage_alias.
    """
    p = Path(a.file)
    tasks = parse(p)
    t = next((x for x in tasks if x["id"] == a.task_id), None)
    if t is None:
        sys.exit(f"error: task {a.task_id} not found in {p} "
                 f"(if it was triaged, look in TRIAGE.md: "
                 f"plan.py --file TRIAGE.md show {a.task_id})")
    out = {"id": t["id"]}
    for f in FIELDS:
        out[f] = t.get(f, "")
    print(json.dumps(out, indent=2))


def cmd_resume_info(a):
    tasks = parse(Path(a.file))
    counts = {s: sum(1 for t in tasks if t["status"] == s) for s in STATUS_ORDER}
    print(json.dumps({
        "total": len(tasks), **counts,
        "last_iteration": max((int(t["last_touched_iteration"]) for t in tasks), default=0),
        "max_round": max((int(t["round"]) for t in tasks), default=1),
        "in_progress_ids": [t["id"] for t in tasks if t["status"] == "IN_PROGRESS"],
        "open_ids": [t["id"] for t in tasks if t["status"] == "OPEN"],
    }, indent=2))


def cmd_archive(a):
    p = Path(a.file)
    tasks = parse(p)
    dest = p.with_name(f"PLAN.campaign{a.campaign}.md")
    if dest.exists():
        sys.exit(f"error: {dest} already exists")
    p.rename(dest)
    write(p, [])
    print(f"archived {len(tasks)} tasks to {dest.name}; fresh {p.name} created")


def cmd_promote(a):
    """Move one entry from TRIAGE.md into PLAN.md, normally as OPEN.

    For a human who reviewed the triage list and decided an item should
    actually be worked. The reverse never happens automatically — only
    `ingest --triage` files into TRIAGE.md in the first place.
    """
    p = Path(a.file)
    reject_triage_alias(p)
    tp = triage_path(p)
    if not tp.exists():
        sys.exit(f"error: {tp} not found — nothing has been triaged yet")
    triaged = parse(tp)
    idx = next((i for i, t in enumerate(triaged) if t["id"] == a.task_id), None)
    if idx is None:
        sys.exit(f"error: {a.task_id} not found in {tp}")
    tasks = parse(p)
    if any(x["id"] == a.task_id for x in tasks):
        sys.exit(f"error: {a.task_id} already exists in {p} — refusing to "
                 "create a duplicate; TRIAGE.md is stale, remove its copy by hand")
    t = triaged.pop(idx)
    # Belt and braces: `ingest` never lets a behavior_change finding reach
    # TRIAGE.md (the gate outranks triage routing there), but a hand-edited
    # TRIAGE.md that kept the reason string could still carry one. Promoting
    # straight to OPEN would hand the worker an unapproved behavior change,
    # so re-apply the gate here instead of trusting the file's provenance.
    if t.get("reason") == "needs user approval":
        t["status"] = "BLOCKED"
        outcome = "BLOCKED (needs user approval — behavior-change gate re-applied)"
    else:
        t["status"] = "OPEN"
        outcome = "OPEN"
    # The move itself is a fresh event: t's first_seen_iteration is still
    # stamped from whenever it was triaged, possibly many iterations ago.
    # Left alone, check-stuck's stale rule (first_seen_iteration <= iteration
    # - 2) could WONTFIX-AUTO it on its very first real attempt, with a
    # false "unresolved since iteration N" reason — it was never workable
    # during that window. Reset both counters to the promoting iteration.
    t["first_seen_iteration"] = a.iteration
    t["last_touched_iteration"] = a.iteration
    tasks.append(t)
    write(p, tasks)
    write(tp, triaged)
    print(f"{a.task_id} -> {p.name} ({outcome})")


def cmd_has_open(a):
    tasks = parse(Path(a.file))
    n = sum(1 for t in tasks if t["status"] == "OPEN")
    print(n)
    sys.exit(0 if n > 0 else 1)


def build_parser():
    """Build the full argument parser.

    Split out of main() so the CLI surface can be introspected without running
    a command: tests/test_skill_md_snippets.py feeds every documented
    `plan.py ...` snippet in SKILL.md through this exact parser, which is what
    catches a documented invocation that would not actually run (missing
    required flag, unknown flag, unknown subcommand, --file after the
    subcommand).
    """
    ap = argparse.ArgumentParser(description="PLAN.md controller for the refactor-loop skill")
    ap.add_argument("--file", default="PLAN.md")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init").set_defaults(fn=cmd_init)

    s = sub.add_parser("add")
    s.add_argument("--priority", required=True)
    s.add_argument("--title", required=True)
    s.add_argument("--files", default="")
    s.add_argument("--evidence", default="")
    s.add_argument("--fingerprint", default="")
    s.add_argument("--source", default="survey")
    s.add_argument("--round", type=int, default=1)
    s.add_argument("--iteration", type=int, default=0)
    s.set_defaults(fn=cmd_add)

    s = sub.add_parser("ingest")
    s.add_argument("--source", required=True)
    s.add_argument("--findings", required=True)
    s.add_argument("--round", type=int, default=1)
    s.add_argument("--iteration", type=int, default=0)
    s.add_argument("--triage", default="",
                   help="comma-separated priorities (e.g. P2,P3) to file "
                        "into TRIAGE.md instead of PLAN.md; default empty "
                        "files everything into PLAN.md")
    s.set_defaults(fn=cmd_ingest)

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

    s = sub.add_parser("show")
    s.add_argument("task_id")
    s.set_defaults(fn=cmd_show)

    sub.add_parser("resume-info").set_defaults(fn=cmd_resume_info)
    s = sub.add_parser("archive")
    s.add_argument("--campaign", type=int, required=True)
    s.set_defaults(fn=cmd_archive)
    sub.add_parser("has-open").set_defaults(fn=cmd_has_open)

    s = sub.add_parser("promote")
    s.add_argument("task_id")
    s.add_argument("--iteration", type=int, required=True,
                   help="iteration the promotion happens at; resets the "
                        "promoted task's first_seen_iteration and "
                        "last_touched_iteration so check-stuck's staleness "
                        "clock starts from the move, not from whenever it "
                        "was triaged. Required, not defaulted: 0 is the one "
                        "first_seen_iteration value check-stuck's staleness "
                        "rule treats as 'never stale' (0 < first_seen_...), "
                        "so a silent default would make every flagless "
                        "promote permanently un-retirable instead of fixing "
                        "the staleness bug it exists to close")
    s.set_defaults(fn=cmd_promote)

    return ap


def main():
    a = build_parser().parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
