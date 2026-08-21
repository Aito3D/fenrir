"""Golden probe: Aito quote-status adoption and Zoho comment interpretation.

Two pure decision surfaces campaign-4's probes never pinned:

* ``adopt_quote_status`` — the single write-path for a quote status, including
  the acceptance-stamp rule and the refuse-unknown-value guard. The probe
  reports WHETHER the stamp moved, never the clock value, so it stays
  deterministic while still failing if the stamping rule changes.
* ``aito_zoho_comments`` — ``map_comment``'s pattern table (which Books comment
  becomes which event kind, and whether it is attributed to the client or to
  us), ``_comment_timestamp``'s local->UTC conversion and format fallbacks, and
  ``should_pull_comments``'s call-budget rule.

Invoked by PROBES.json as `./venv/bin/python3 tools/probe_aito_status.py`.
"""

import json
import os
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.getcwd())

from backend.app.models.aito_project import AitoProject  # noqa: E402
from backend.app.schemas.aito import QUOTE_STATUS_VALUES  # noqa: E402
from backend.app.services import aito_zoho_comments as zc  # noqa: E402
from backend.app.services.aito_quote_status import adopt_quote_status  # noqa: E402

STATUSES = sorted(QUOTE_STATUS_VALUES) + [None, "invoiced", "", "ACCEPTED"]
STAMP = datetime(2020, 1, 1, 0, 0, 0)
NOW = datetime(2026, 8, 19, 12, 0, 0)

COMMENTS = [
    {"description": ""},
    {"description": "   "},
    {"description": "The estimate has been viewed by the customer."},
    {"description": "Estimate accepted by customer"},
    {"description": "Estimate declined by the customer."},
    {"description": "This estimate has expired."},
    {"description": "Estimate sent to the customer via email"},
    {"description": "some free-form note from the accountant"},
    {},
]

TIMESTAMPS = [
    {"date": "2026-08-19", "time": "14:30"},
    {"date": "2026-08-19", "time": "02:30 PM"},
    {"date": "2026-08-19", "time": ""},
    {"date": "2026-08-19"},
    {"date": "", "time": ""},          # unparseable -> falls back to now (reported as marker)
    {"date": "19/08/2026", "time": "14:30"},
]
OFFSETS = [zc.DEFAULT_COMMENT_UTC_OFFSET_HOURS, 0, 2, -5.5]


def adoption_matrix():
    rows = []
    for start in STATUSES:
        for new in STATUSES:
            p = AitoProject(id=1)
            p.quote_status = start
            p.quote_accepted_at = STAMP
            adopt_quote_status(p, new)
            rows.append({
                "from": start,
                "to": new,
                "status_after": p.quote_status,
                # bool, not the clock: deterministic, still fails if the rule moves
                "stamp_moved": p.quote_accepted_at != STAMP,
                "stamp_cleared": p.quote_accepted_at is None,
            })
    return rows


def timestamp_matrix():
    rows = []
    for c in TIMESTAMPS:
        for off in OFFSETS:
            got = zc._comment_timestamp(c, off)
            # An unparseable stamp returns utcnow(); pin the FALLBACK, not the clock.
            parseable = abs((got - datetime.utcnow()).total_seconds()) > 60
            rows.append({
                "comment": c,
                "offset": off,
                "value": got.isoformat() if parseable else "<UTCNOW-FALLBACK>",
            })
    return rows


def pull_matrix():
    rows = []
    for remote in (None, "", "2026-08-19T00:00:00", "watermark-A"):
        for watermark in (None, "watermark-A"):
            for checked_delta in (None, timedelta(0), zc.COMMENT_REFRESH_INTERVAL,
                                  zc.COMMENT_REFRESH_INTERVAL + timedelta(seconds=1)):
                p = AitoProject(id=1)
                p.zoho_comments_watermark = watermark
                p.zoho_comments_checked_at = None if checked_delta is None else NOW - checked_delta
                rows.append({
                    "remote": remote,
                    "watermark": watermark,
                    "checked_ago_s": None if checked_delta is None else checked_delta.total_seconds(),
                    "pull": zc.should_pull_comments(p, {"last_modified_time": remote}, NOW),
                })
    return rows


def main():
    out = {
        "quote_status_values": sorted(QUOTE_STATUS_VALUES),
        "adoption": adoption_matrix(),
        "comment_constants": {
            "ECHO_WINDOW_s": zc.ECHO_WINDOW.total_seconds(),
            "COMMENT_REFRESH_INTERVAL_s": zc.COMMENT_REFRESH_INTERVAL.total_seconds(),
            "DEFAULT_COMMENT_UTC_OFFSET_HOURS": zc.DEFAULT_COMMENT_UTC_OFFSET_HOURS,
            "COMMENT_UTC_OFFSET_SETTING_KEY": zc.COMMENT_UTC_OFFSET_SETTING_KEY,
        },
        "map_comment": [{"in": c, "out": zc.map_comment(c)} for c in COMMENTS],
        "comment_timestamp": timestamp_matrix(),
        "should_pull": pull_matrix(),
    }
    print(json.dumps(out, sort_keys=True, indent=1, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
