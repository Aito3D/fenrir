#!/usr/bin/env python3
"""snapshot.py — golden behavioral snapshots for the refactor-loop skill.

Direct evidence of "zero functionality change": record the app's observable
behavior once at baseline, then replay and byte-diff it after every iteration.

Probes live in PROBES.json — a list of objects:
  {
    "id": "cli-help",                      # unique name
    "cmd": "python app.py --help",         # shell command to run (cwd = repo root)
    "timeout": 30,                         # seconds (optional, default 30)
    "scrub": ["\\\\d{4}-\\\\d{2}-\\\\d{2}[T ][0-9:.]+", "0x[0-9a-f]+"],
                                           # regexes replaced with <SCRUBBED>
                                           # before storing/comparing (optional)
    "files": ["dist/output.txt"]           # files hashed after the cmd (optional)
  }

Usage:
  snapshot.py init              # write a PROBES.json template (edit it!)
  snapshot.py record            # run all probes, store golden outputs in snapshots/
  snapshot.py verify            # re-run, diff against golden; exit 0 = identical
  snapshot.py verify --probe cli-help   # verify a single probe

Exit codes: 0 = all match, 1 = at least one mismatch, 2 = setup problem.
"""
import argparse
import difflib
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

PROBES_FILE = "PROBES.json"
SNAP_DIR = Path("snapshots")

TEMPLATE = [
    {"id": "example-cli", "cmd": "echo replace-me --help", "timeout": 30,
     "scrub": [r"\d{4}-\d{2}-\d{2}[T ][0-9:.]+"], "files": []},
]


def load_probes():
    p = Path(PROBES_FILE)
    if not p.exists():
        sys.exit(f"error: {PROBES_FILE} not found (run 'snapshot.py init' and edit it)")
    try:
        probes = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        sys.exit(f"error: {PROBES_FILE} is not valid JSON: {e}")
    ids = [pr.get("id") for pr in probes]
    if len(ids) != len(set(ids)) or not all(ids):
        sys.exit("error: every probe needs a unique non-empty 'id'")
    return probes


def scrub(text, patterns):
    for pat in patterns or []:
        text = re.sub(pat, "<SCRUBBED>", text)
    return text


def run_probe(pr):
    """Run one probe; return normalized capture text."""
    try:
        r = subprocess.run(pr["cmd"], shell=True, capture_output=True,
                           text=True, timeout=pr.get("timeout", 30))
        parts = [f"### exit: {r.returncode}",
                 "### stdout:", scrub(r.stdout, pr.get("scrub")),
                 "### stderr:", scrub(r.stderr, pr.get("scrub"))]
    except subprocess.TimeoutExpired:
        parts = ["### exit: TIMEOUT", "### stdout:", "", "### stderr:", ""]
    for f in pr.get("files", []):
        fp = Path(f)
        digest = (hashlib.sha256(fp.read_bytes()).hexdigest()
                  if fp.exists() else "<MISSING>")
        parts.append(f"### file {f}: {digest}")
    return "\n".join(parts) + "\n"


def cmd_init(_):
    p = Path(PROBES_FILE)
    if p.exists():
        sys.exit(f"error: {PROBES_FILE} already exists")
    p.write_text(json.dumps(TEMPLATE, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {PROBES_FILE} — EDIT IT with real probes (API calls, CLI runs, "
          "build outputs) before running 'record'")


def cmd_record(_):
    probes = load_probes()
    SNAP_DIR.mkdir(exist_ok=True)
    for pr in probes:
        out = run_probe(pr)
        (SNAP_DIR / f"{pr['id']}.golden").write_text(out, encoding="utf-8")
        print(f"recorded {pr['id']} ({len(out)} bytes)")
    print(f"\n{len(probes)} golden snapshot(s) stored in {SNAP_DIR}/ — commit them.")


def cmd_verify(a):
    probes = load_probes()
    if a.probe:
        probes = [pr for pr in probes if pr["id"] == a.probe] or sys.exit(
            f"error: no probe named {a.probe}")
    failures = 0
    for pr in probes:
        golden_path = SNAP_DIR / f"{pr['id']}.golden"
        if not golden_path.exists():
            print(f"MISSING GOLDEN: {pr['id']} (run 'record' at baseline first)")
            failures += 1
            continue
        golden = golden_path.read_text(encoding="utf-8")
        current = run_probe(pr)
        if current == golden:
            print(f"MATCH: {pr['id']}")
        else:
            failures += 1
            print(f"MISMATCH: {pr['id']} — behavior changed!")
            diff = difflib.unified_diff(golden.splitlines(), current.splitlines(),
                                        "golden", "current", lineterm="", n=2)
            shown = list(diff)[:40]
            print("\n".join("  " + l for l in shown))
            if len(shown) == 40:
                print("  ... (diff truncated)")
    print(f"\n{len(probes) - failures}/{len(probes)} probes match")
    sys.exit(1 if failures else 0)


def main():
    ap = argparse.ArgumentParser(description="Golden behavioral snapshots")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init").set_defaults(fn=cmd_init)
    sub.add_parser("record").set_defaults(fn=cmd_record)
    s = sub.add_parser("verify")
    s.add_argument("--probe", default=None)
    s.set_defaults(fn=cmd_verify)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
