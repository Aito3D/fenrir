"""Revenue campaign (RV1) golden probe: every /api/v1/revenue route, end to end through the app.

Run by pytest (PROBES.json) with the backend test conftest loaded as a plugin, so it gets the
suite's throwaway databases and ASGI client. The revenue rows live in a temp-file database that
`store.snapshot()` opens itself (same arrangement as backend/tests/integration/test_revenue_api.py,
whose `tokens` fixture is reused). Zoho is never reached: the sync loop and the sync batch are
stubbed, and httpx's real transports raise.

The clock is frozen at NOW in the route module, in dates.org_today and in sync._utcnow; every
seeded timestamp (item/day fetches, Aito card created/updated) is a literal, so bodies and ETags
are a pure function of this file. One exception: PUT /labor writes a Settings row whose
updated_at is the database's func.now() and feeds the data stamp, so it runs last and the ETags
of the steps after it are not recorded.

Each step (method, url, principal, request body, status, ETag, body) is appended to $PROBE_OUT.
Loop tooling, not app code. Not collected by the suite (it lives outside backend/tests).
"""

import json
import os
from datetime import datetime, timezone

import httpx
import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.api.routes import revenue as revenue_routes
from backend.app.core import database
from backend.app.core.database import Base, _set_sqlite_pragmas, load_all_models
from backend.app.services.revenue import dates, store, sync
from backend.app.services.revenue.series import RevenueLine
from backend.tests.integration.test_revenue_api import tokens  # noqa: F401  (fixture by name)

OUT = os.environ.get("PROBE_OUT", "/tmp/fenrir-revenue-probe/http.json")
URL = "/api/v1/revenue"
NOW = datetime(2026, 3, 11, 20, 0, tzinfo=timezone.utc)  # 10:00 on 2026-03-11 in Tahiti
SEEDED = datetime(2026, 3, 11, 19, 0, tzinfo=timezone.utc)


class Frozen(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz) if tz else NOW.replace(tzinfo=None)


@pytest.fixture(autouse=True)
def frozen_and_offline(monkeypatch):
    def refuse(*a, **k):
        raise RuntimeError("probe: network blocked")

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", refuse)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", refuse)
    monkeypatch.setattr(revenue_routes, "datetime", Frozen)
    monkeypatch.setattr(dates, "datetime", Frozen)
    monkeypatch.setattr(sync, "_utcnow", lambda: NOW)
    monkeypatch.setattr(sync, "ensure_revenue_sync_loop", lambda: None)
    calls = []

    async def fake_batch(*, full=False):
        calls.append(full)
        return {"fetched": 3, "pending": 2, "days": 10, "customers": 1}

    monkeypatch.setattr(sync, "run_revenue_sync_batch", fake_batch)
    return calls


ITEMS = [
    {"item_id": "pla", "name": "SUNLU PLA", "sku": "PLA-1", "brand": "SUNLU", "nature": "Filaments", "item_type": "inventory", "tax_percentage": 16, "purchase_rate": 1100},
    {"item_id": "x1", "name": "Bambu X1C", "sku": "X1C", "brand": "Bambu Lab", "item_type": "inventory", "tax_percentage": 16, "purchase_rate": 150000},
    {"item_id": "print", "name": "Impression 3D", "sku": "SRV", "brand": "Aito3D", "item_type": "service", "tax_percentage": 13},
    {"item_id": "kayak", "name": "Kayak", "sku": "K", "brand": "Ocean", "nature": "Boats", "item_type": "inventory", "tax_percentage": 16, "purchase_rate": 50000},
    {"item_id": "glue", "name": "Magigoo stick", "sku": "MG", "brand": "Magigoo", "nature": "3D Printer Adhesives", "item_type": "inventory", "dealer_price": 5},
    {"item_id": "mystery", "name": "Mystery box", "sku": "MB", "item_type": "inventory", "tax_percentage": 16},
]
SALES = [  # day, item, customer, qty, amount, unit_cost, tax
    ("2025-02-10", "pla", "c-pro", 5, 6000, 1100, 16),
    ("2025-03-03", "pla", "c-pro", 4, 4800, 1100, 16),
    ("2025-03-20", "print", "c-ind", 1, 3000, None, 13),
    ("2025-03-20", "mystery", "c-ind", 1, 900, None, 16),
    ("2025-06-01", "glue", "c-pass", 2, 1400, None, None),
    ("2025-12-30", "x1", "c-pro", 1, 180000, 150000, 16),
    ("2026-01-05", "pla", "c-ind", 2, 2400, 1100, 16),
    ("2026-01-05", "kayak", "c-pro", 1, 60000, 50000, 16),
    ("2026-02-14", "glue", "c-ind", 1, 700, None, None),
    ("2026-02-27", "print", "c-pass", 2, 6000, None, 13),
    ("2026-03-02", "pla", "c-pro", -1, -1200, 1100, 16),
    ("2026-03-03", "mystery", "c-new", 1, 50, None, 16),
    ("2026-03-10", "print", "c-pro", 1, 4500, None, 13),
    ("2026-03-11", "pla", "", 3, 3600, 1100, 16),
]
CUSTOMERS = {
    "c-pro": {"name": "Lycée", "company_name": "Lycée Gauguin", "sub_type": "business"},
    "c-ind": {"name": "Hina", "company_name": "", "sub_type": "individual"},
    "c-pass": {"name": "Client de passage", "company_name": "", "sub_type": "individual"},
    "c-new": None,  # Zoho answered 404
}


@pytest.fixture
async def revenue_db(tmp_path, monkeypatch):
    from backend.app.models.aito_project import AitoProject

    load_all_models()
    eng = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'revenue.db'}")
    event.listen(eng.sync_engine, "connect", _set_sqlite_pragmas)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(database, "engine", eng)
    async with async_sessionmaker(eng, expire_on_commit=False)() as db:
        await store.replace_items(db, ITEMS, SEEDED)
        by_day: dict[str, list[RevenueLine]] = {}
        for day, item, cust, qty, amount, cost, tax in SALES:
            name = next(i["name"] for i in ITEMS if i["item_id"] == item)
            by_day.setdefault(day, []).append(RevenueLine(day, item, cust, name, "", qty, amount, cost, tax))
        for day in sorted(by_day):
            await store.write_day(db, day, by_day[day], day < "2026-03-11", SEEDED, 2)
        await store.write_day(db, "2026-03-04", [], True, SEEDED, 1)  # an empty day under the legacy format
        for cid, facts in CUSTOMERS.items():
            await store.save_customer(db, cid, facts, SEEDED)
        await store.set_decision(db, "kayak", True, SEEDED)
        await store.set_target(db, "2026-01", 50000, SEEDED)
        await store.set_target(db, "2026-03", 20000, SEEDED)
        await store.add_annotation(db, "2026-02-27", "Salon", SEEDED)
        await store.save_month_check(db, "2026-01", 62400.4, 62399.6, SEEDED)
        await store.save_month_check(db, "2026-02", 9000, 6700, SEEDED)
        pays = [
            {"payment_id": "p1", "customer_id": "c-pro", "date": "2026-03-02", "amount": 5000, "unapplied": 0, "last_modified_time": "t1"},
            {"payment_id": "p2", "customer_id": "c-ind", "date": "2026-02-10", "amount": 1000, "unapplied": 0, "last_modified_time": "t1"},
            {"payment_id": "p3", "customer_id": "c-x", "date": "2025-08-01", "amount": 300, "unapplied": 0, "last_modified_time": "t1"},
        ]
        await store.save_payments(db, pays, "2025-03-01T10:00:00+0000", SEEDED)
        invoices = [
            {"invoice_id": "i1", "number": "INV-1", "customer_id": "c-pro", "customer_name": "Lycée Gauguin", "date": "2026-03-01", "due_date": "2026-03-20", "total": 2000, "balance": 2000},
            {"invoice_id": "i2", "number": "INV-2", "customer_id": "c-pro", "customer_name": "Lycée Gauguin", "date": "2025-12-01", "due_date": "2026-01-10", "total": 1500, "balance": 1500},
            {"invoice_id": "i3", "number": "INV-3", "customer_id": "c-ind", "customer_name": "Hina", "date": "2026-02-01", "due_date": "2026-02-25", "total": 800, "balance": 600},
            {"invoice_id": "i4", "number": "INV-4", "customer_id": "c-x", "customer_name": "Stranger", "date": "2026-03-05", "due_date": "2026-03-14", "total": 100, "balance": 100},
        ]
        await store.save_unpaid_invoices(db, invoices, True, SEEDED)
        await store.save_cash_synced(db, SEEDED)
        at = datetime(2026, 3, 1, 8, 0)
        db.add_all(
            [
                AitoProject(description="a", board_column="print", quote_status="accepted", quote_total=800, retainer_paid_total=200, created_at=at, updated_at=at),
                AitoProject(description="b", board_column="devis", quote_status="sent", quote_total=200, quote_sent_at=datetime(2026, 2, 1, 8), created_at=at, updated_at=at),
                AitoProject(description="c", board_column="print", status="deleted", quote_status="accepted", created_at=at, updated_at=at),
                AitoProject(description="d", board_column="finitions", quote_status="accepted", created_at=at, updated_at=at),
            ]
        )
        await db.commit()
    yield eng
    await eng.dispose()


MONTH = "granularity=month&from=2025-01-01&to=2026-03-31"
RANGE = "from=2026-01-01&to=2026-03-11"
READS = [
    "", f"?{MONTH}", "?granularity=day&from=2026-02-25&to=2026-03-11", "?granularity=week&from=2026-01-26&to=2026-03-15",
    "?granularity=year", "?preset=this-year", "?preset=last-12-months", "?preset=all", f"?{MONTH}&items=pla,print",
    f"?{MONTH}&brand=SUNLU&brand=Aito3D", f"?{MONTH}&kind=services", f"?{MONTH}&kind=goods", f"?{MONTH}&segment=pro", f"?{MONTH}&segment=passage",
    "?granularity=bogus", "?from=2026-13-01", "?kind=bogus", "?items=bad%20id",
    f"/items?{RANGE}", "/items?from=2026-03-01&to=2026-03-31&kind=goods", "/items?from=2026-03-11&to=2026-03-01",
    "/products", "/review", "/sync", "/yoy", "/daily", "/daily?from=2020-01-01", "/targets", "/annotations", "/checks",
    f"/customers?{RANGE}", f"/customers?{RANGE}&granularity=week", "/customers?from=2025-01-01&to=2026-03-11&granularity=year&segment=pro",
    "/customers?from=x&to=y", "/cash", "/pipeline",
    "/movers", "/movers?granularity=month&key=2026-02", "/movers?granularity=year&key=2025", "/movers?granularity=week&key=2026-W10",
    f"/movers?{RANGE}&cfrom=2025-01-01&cto=2025-03-11", "/movers?granularity=month&key=2019-01", f"/analysis?{RANGE}",
    "/analysis?from=2025-01-01&to=2026-03-11&brand=SUNLU", "/labor",
    # RV2: routes added after RV1.
    "/cohorts", "/funnel", f"/pvm?{RANGE}", f"/pvm?{RANGE}&brand=SUNLU&kind=goods", "/pvm?from=2026-03-11&to=2026-03-01",
    "/result", "/fixed-costs",
]
STRIPPED = ["", f"/items?{RANGE}", "/cash", f"/analysis?{RANGE}", f"/customers?{RANGE}", f"/movers?{RANGE}&cfrom=2025-01-01&cto=2025-03-11", "/labor", f"?{MONTH}&segment=pro", "/cohorts", "/result", "/fixed-costs"]
WRITES = [  # method, path, body, principal
    ("put", "/scope/glue", {"included": True}, "scope"),
    ("put", "/scope/mystery", {"included": False}, "scope"),
    ("put", "/scope/bad%20id", {"included": True}, "scope"),
    ("put", "/scope/glue", {"included": "yes"}, "scope"),
    ("get", "/review", None, "all"),
    ("delete", "/scope/glue", None, "scope"),
    ("delete", "/scope/glue", None, "scope"),
    ("put", "/targets/2026-04", {"amountHt": 7000}, "targets"),
    ("put", "/targets/2026-13", {"amountHt": 7000}, "targets"),
    ("put", "/targets/2026-04", {"amountHt": -1}, "targets"),
    ("delete", "/targets/2026-01", None, "targets"),
    ("get", "/targets", None, "all"),
    ("post", "/annotations", {"day": "2026-03-05", "label": "  Promo  "}, "notes"),
    ("post", "/annotations", {"day": "2026-03-05", "label": ""}, "notes"),
    ("post", "/annotations", {"day": "bad", "label": "x"}, "notes"),
    ("delete", "/annotations/1", None, "notes"),
    ("delete", "/annotations/99", None, "notes"),
    ("get", "/annotations", None, "all"),
    ("post", "/sync", None, "sync"),
    ("post", "/sync?full=true", None, "sync"),
    ("post", "/sync?full=1", None, "sync"),
    ("post", "/checks/2026-03/refetch", None, "sync"),
    ("post", "/checks/2026-13/refetch", None, "sync"),
    ("post", "/checks/2026-02/refetch", None, "sync"),
    ("get", "/checks", None, "all"),
    ("get", "/sync", None, "all"),
    ("put", "/scope/glue", {"included": True}, "read"),
    ("post", "/sync", None, "read"),
    # Labor last: its Settings row's updated_at is func.now() and moves the data stamp (see docstring).
    ("put", "/labor", {"providers": [{"name": " Alice ", "hourlyRate": 1500, "hoursPerDay": 8, "daysPerWeek": 5, "since": "2026-03-02"}]}, "labor"),
    ("put", "/labor", {"providers": [{"name": "Bob", "hourlyRate": 1000, "hoursPerDay": 4, "daysPerWeek": 5, "since": "bad"}]}, "labor"),
    ("put", "/labor", {"providers": []}, "read_margin"),
    ("get", "/labor", None, "all"),
    ("put", "/fixed-costs", {"costs": [{"label": " Rent ", "monthly": 900}, {"label": "Power", "monthly": 120.5}]}, "labor"),
    ("put", "/fixed-costs", {"costs": [{"label": "   ", "monthly": 1}]}, "labor"),
    ("put", "/fixed-costs", {"costs": [{"label": "x", "monthly": -1}]}, "labor"),
    ("put", "/fixed-costs", {"costs": []}, "read_margin"),
    ("get", "/fixed-costs", None, "all"),
    ("get", "/result", None, "all"),
    ("get", f"?{MONTH}", None, "all"),
]


@pytest.mark.asyncio
async def test_revenue_routes(async_client, revenue_db, tokens, frozen_and_offline):  # noqa: F811
    steps = []
    labor_done = False

    async def step(method, path, body, who, headers=None):
        nonlocal labor_done
        kw = {"headers": {**tokens[who], **(headers or {})}}
        if body is not None:
            kw["json"] = body
        r = await async_client.request(method.upper(), URL + path, **kw)
        try:
            shown = r.json()
        except ValueError:
            shown = r.text
        steps.append({
            "step": f"{method.upper()} {path or '/'}", "as": who, "request": body, "status": r.status_code,
            "etag": "<after labor write: not recorded>" if labor_done else r.headers.get("etag"),
            "body": shown,
        })
        if method == "put" and path == "/labor" and r.status_code == 200:
            labor_done = True
        return r

    for path in READS:
        await step("get", path, None, "all")
    for path in STRIPPED:
        await step("get", path, None, "read")
    for path in ("", "/cash", "/customers?" + RANGE):
        await step("get", path, None, "read_customers")
    first = await step("get", f"?{MONTH}", None, "all")
    await step("get", f"?{MONTH}", None, "all", {"If-None-Match": first.headers.get("etag", "")})
    await step("get", f"?{MONTH}", None, "read", {"If-None-Match": first.headers.get("etag", "")})
    await step("get", "", None, "none")
    for method, path, body, who in WRITES:
        await step(method, path, body, who)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(json.dumps({"steps": steps, "sync_batch_calls": frozen_and_offline}, indent=1, sort_keys=True, ensure_ascii=False, default=str) + "\n")
