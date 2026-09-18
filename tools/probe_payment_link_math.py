"""Golden probe (campaign 17): the payment-link money rules and the §5.4
"does this pair need action" predicate, as pure functions.

These decide HOW MANY FRANCS a client is asked for and WHEN a live link is
cancelled and re-minted, so every rounding edge, every boundary percentage
and every (row, wanted) combination is pinned here rather than sampled.

`required_amount` / `outstanding_amount` round UP for deposits and retainer
netting (never a franc short) and plain-round the full total; the matrices
below walk .5 cases, floats that are not exactly representable, negatives,
zero and None through both. `wanted_link` and `needs_action` are driven with
detached in-memory ORM objects — no session, no database, no clock: `today`
is passed in and `_now()` is never called.
"""

import json
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, ".")

from backend.app.models.aito_payment_link import AitoPaymentLink  # noqa: E402
from backend.app.models.aito_project import AitoProject  # noqa: E402
from backend.app.services.aito_payment_links import (  # noqa: E402
    Wanted,
    _fields_match,
    _in_backoff,
    expires_in_days,
    needs_action,
    outstanding_amount,
    required_amount,
    wanted_link,
)

TODAY = date(2026, 9, 16)
NOW = datetime(2026, 9, 16, 12, 0, 0)
out: dict = {}

# --- 1. required_amount: the gross figure ----------------------------------
TOTALS = [None, -1.0, 0.0, 0.4, 0.5, 0.6, 1.0, 1.5, 2.5, 99.5, 100.0, 100.004, 1000.0, 12500.0, 123456.789, 1e9]
PCTS = [-10, 0, 1, 30, 33, 50, 99, 100, 150]
out["01-required-amount"] = [
    {"quote_total": t, "pct": p, "required": required_amount(t, p)} for t in TOTALS for p in PCTS
]

# --- 2. outstanding_amount: netting the paid retainers off -----------------
RETAINERS = [None, 0.0, 0.01, 1.0, 1.5, 2499.99, 2500.0, 2500.01, 12500.0, 99999.0, -5.0]
out["02-outstanding-amount"] = [
    {"required": r, "retainer_paid_total": p, "outstanding": outstanding_amount(r, p)}
    for r in [0, 1, 2500, 12500]
    for p in RETAINERS
]


# --- 3. wanted_link: is a live link owed at all, and for how much? ---------
def project(**kw) -> AitoProject:
    """A detached project row with only the fields wanted_link reads."""
    p = AitoProject()
    p.id = kw.pop("id", 1)
    p.status = kw.pop("status", "active")
    p.quote_number = kw.pop("quote_number", "DEV-000123")
    p.quote_status = kw.pop("quote_status", "sent")
    p.quote_invoiced = kw.pop("quote_invoiced", False)
    p.quote_total = kw.pop("quote_total", 12500.0)
    p.quote_expiry_date = kw.pop("quote_expiry_date", None)
    p.retainer_paid_total = kw.pop("retainer_paid_total", None)
    for k, v in kw.items():
        setattr(p, k, v)
    return p


def wrow(w) -> dict | None:
    return None if w is None else {"reference": w.reference, "amount": w.amount, "expires_on": w.expires_on}


WANTED_CASES = [
    ("plain-active-sent", {}),
    ("status-trashed", {"status": "trashed"}),
    ("status-archived", {"status": "archived"}),
    ("status-empty", {"status": ""}),
    ("no-quote-number", {"quote_number": None}),
    ("blank-quote-number", {"quote_number": ""}),
    ("quote-declined", {"quote_status": "declined"}),
    ("quote-expired", {"quote_status": "expired"}),
    ("quote-accepted", {"quote_status": "accepted"}),
    ("quote-draft", {"quote_status": "draft"}),
    ("quote-status-none", {"quote_status": None}),
    ("invoiced", {"quote_invoiced": True}),
    ("total-none", {"quote_total": None}),
    ("total-zero", {"quote_total": 0.0}),
    ("total-negative", {"quote_total": -100.0}),
    ("total-fractional", {"quote_total": 12500.5}),
    ("retainer-partial", {"retainer_paid_total": 2500.0}),
    ("retainer-exact", {"retainer_paid_total": 12500.0}),
    ("retainer-over", {"retainer_paid_total": 99999.0}),
    ("retainer-fractional", {"retainer_paid_total": 12499.5}),
    ("expiry-explicit", {"quote_expiry_date": "2026-10-31"}),
    ("expiry-in-the-past", {"quote_expiry_date": "2026-01-01"}),
    ("expiry-today", {"quote_expiry_date": "2026-09-16"}),
    ("expiry-blank", {"quote_expiry_date": ""}),
    ("expiry-garbage", {"quote_expiry_date": "not-a-date"}),
]
rows = []
for name, kw in WANTED_CASES:
    for pct in (0, 30, 100):
        rows.append(
            {
                "case": name,
                "pct": pct,
                "wanted": wrow(wanted_link(project(**kw), pct=pct, validity_days=15, today=TODAY)),
            }
        )
out["03-wanted-link"] = rows

# validity_days feeds the fallback expiry only.
out["03b-wanted-link-validity-days"] = [
    {
        "validity_days": d,
        "wanted": wrow(wanted_link(project(), pct=0, validity_days=d, today=TODAY)),
    }
    for d in (0, 1, 7, 15, 30, 365, 400, -5)
]

# --- 4. expires_in_days: date -> Heimdall's 1..365 day count ---------------
out["04-expires-in-days"] = [
    {"expires_on": s, "days": expires_in_days(s, TODAY)}
    for s in [
        "2026-09-16",  # today -> 1
        "2026-09-17",
        "2026-09-15",  # yesterday -> clamped to 1
        "2026-01-01",
        "2027-09-16",  # 365
        "2027-09-17",  # 366 -> clamped
        "2030-01-01",
        "",
        "not-a-date",
        "2026-13-01",  # impossible month
        "2026-02-30",  # impossible day
        "2026-09-16T00:00:00",  # datetime, not a date
    ]
]


# --- 5. needs_action: the §5.4 table as a predicate ------------------------
def link(**kw) -> AitoPaymentLink:
    r = AitoPaymentLink()
    r.id = kw.pop("id", 1)
    r.project_id = kw.pop("project_id", 1)
    r.idempotency_key = kw.pop("idempotency_key", "aito:1:1")
    r.heimdall_id = kw.pop("heimdall_id", "hd-1")
    r.reference = kw.pop("reference", "DEV-000123")
    r.amount = kw.pop("amount", 12500)
    r.expires_on = kw.pop("expires_on", "2026-10-01")
    r.status = kw.pop("status", "pending")
    r.url = kw.pop("url", "https://secure.osb.pf/pay/abc")
    r.sync_failures = kw.pop("sync_failures", 0)
    r.checked_at = kw.pop("checked_at", None)
    for k, v in kw.items():
        setattr(r, k, v)
    return r


W = Wanted(reference="DEV-000123", amount=12500, expires_on="2026-10-01")
ROW_CASES = [
    ("none", None),
    ("reservation-null-id", link(heimdall_id=None)),
    ("reservation-null-id-paid", link(heimdall_id=None, status="paid")),
    ("pending-matching", link()),
    ("pending-amount-drift", link(amount=9000)),
    ("pending-expiry-drift", link(expires_on="2026-11-01")),
    ("pending-reference-drift", link(reference="DEV-000999")),
    ("paid", link(status="paid")),
    ("paid-amount-drift", link(status="paid", amount=1)),
    ("failed", link(status="failed")),
    ("cancelled", link(status="cancelled")),
    ("expired", link(status="expired")),
    ("unknown-status", link(status="refunded")),
]
WANTED_VARIANTS = [
    ("wanted-same", W),
    ("wanted-amount-differs", Wanted(reference=W.reference, amount=9000, expires_on=W.expires_on)),
    ("wanted-expiry-differs", Wanted(reference=W.reference, amount=W.amount, expires_on="2026-11-01")),
    ("wanted-reference-differs", Wanted(reference="DEV-000999", amount=W.amount, expires_on=W.expires_on)),
    ("wanted-none", None),
]
out["05-needs-action"] = [
    {
        "row": rname,
        "wanted": wname,
        "needs_action": needs_action(row, w, TODAY),
        "fields_match": None if (row is None or w is None) else _fields_match(row, w, TODAY),
    }
    for rname, row in ROW_CASES
    for wname, w in WANTED_VARIANTS
]

# --- 6. _in_backoff: how long a failing row is left alone ------------------
out["06-in-backoff"] = [
    {
        "sync_failures": f,
        "checked_at_minutes_ago": m,
        "in_backoff": _in_backoff(link(sync_failures=f, checked_at=NOW - timedelta(minutes=m)), NOW),
    }
    for f in (0, 1, 2, 3, 6, 7, 100)
    for m in (0, 1, 4, 5, 6, 10, 15, 25, 29, 30, 31, 60, 1440)
] + [
    {"sync_failures": f, "checked_at_minutes_ago": None, "in_backoff": _in_backoff(link(sync_failures=f), NOW)}
    for f in (0, 1, 5)
]

print(json.dumps(out, sort_keys=True, indent=1, default=str))
