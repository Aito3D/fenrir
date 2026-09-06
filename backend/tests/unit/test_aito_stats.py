"""GET /aito/stats — the pipeline widget's four blocks, computed server-side."""

import pytest
from sqlalchemy import text

from backend.tests.unit.test_aito_contacted import _declared_permissions

STATS = "/api/v1/aito/stats"


async def _create(client, **overrides):
    payload = {"description": "Job", "client_id": "z1", "client_name": "ACME", "client_phone": "+689 87 00 00 01"}
    payload.update(overrides)
    r = await client.post("/api/v1/aito/", json=payload)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _event(db_session, pid: int, kind: str, at: str, changes=None):
    await db_session.execute(
        text(
            "INSERT INTO aito_events (project_id, occurred_at, kind, actor_class, changes) "
            "VALUES (:pid, :at, :kind, 'user', :changes)"
        ),
        {"pid": pid, "at": at, "kind": kind, "changes": changes},
    )
    await db_session.commit()


async def _set(db_session, pid: int, **cols):
    sets = ", ".join(f"{k} = :{k}" for k in cols)
    await db_session.execute(text(f"UPDATE aito_projects SET {sets} WHERE id = :pid"), {"pid": pid, **cols})
    await db_session.commit()


def _stage(kind_from: str, to: str) -> str:
    import json

    return json.dumps([{"field": "column", "from": kind_from, "to": to}])


@pytest.mark.asyncio
async def test_board_counts_and_totals_per_column_with_all_seven_present(async_client, db_session):
    a = await _create(async_client, description="a")
    b = await _create(async_client, description="b")
    c = await _create(async_client, description="c")
    await _set(db_session, a, quote_total=100.0)
    await _set(db_session, b, quote_total=None, board_column="print")
    await _set(db_session, c, quote_total=50.0, status="deleted")

    body = (await async_client.get(STATS)).json()
    assert [row["column"] for row in body["board"]] == ["devis", "waiting", "scan", "model", "print", "finish", "done"]
    by = {row["column"]: row for row in body["board"]}
    assert by["devis"] == {"column": "devis", "count": 1, "total": 100.0}
    assert by["print"] == {"column": "print", "count": 1, "total": 0.0}
    assert by["done"]["count"] == 0


@pytest.mark.asyncio
async def test_conversion_counts_first_events_in_range_only(async_client, db_session):
    a = await _create(async_client, description="a")
    b = await _create(async_client, description="b")
    gone = await _create(async_client, description="gone")
    await _set(db_session, a, quote_total=1000.0)
    await _set(db_session, b, quote_total=500.0)
    await _set(db_session, gone, quote_total=9999.0, status="deleted")
    await _event(db_session, a, "quote.sent", "2026-08-10 09:00:00")
    await _event(db_session, a, "quote.sent", "2026-08-20 09:00:00")  # re-send: not a second 'sent'
    await _event(db_session, a, "quote.accepted", "2026-08-12 09:00:00")
    await _event(db_session, a, "quote.unaccepted", "2026-08-13 09:00:00")  # still counts once, at the first acceptance
    await _event(db_session, b, "quote.emailed", "2026-08-31 23:30:00")  # inclusive end day
    await _event(db_session, b, "quote.declined", "2026-09-01 00:00:00")  # outside
    await _event(db_session, gone, "quote.sent", "2026-08-15 09:00:00")

    body = (await async_client.get(STATS, params={"date_from": "2026-08-01", "date_to": "2026-08-31"})).json()
    c = body["conversion"]
    assert c["sent"] == {"count": 2, "total": 1500.0}
    assert c["accepted"] == {"count": 1, "total": 1000.0}
    assert c["declined"] == {"count": 0, "total": 0.0}
    assert c["acceptance_rate"] == 1.0

    empty = (await async_client.get(STATS, params={"date_from": "2020-01-01", "date_to": "2020-01-31"})).json()
    assert empty["conversion"]["acceptance_rate"] is None


@pytest.mark.asyncio
async def test_stage_days_median_from_stays_closed_in_range(async_client, db_session):
    a = await _create(async_client, description="a")
    b = await _create(async_client, description="b")
    await _set(db_session, a, created_at="2026-08-01 00:00:00")
    await _set(db_session, b, created_at="2026-08-01 00:00:00")
    # a: devis 2 d, waiting 4 d ; b: devis 6 d, then a scan stay closing outside the range
    await _event(db_session, a, "stage.changed", "2026-08-03 00:00:00", _stage("devis", "waiting"))
    await _event(db_session, a, "stage.changed", "2026-08-07 00:00:00", _stage("waiting", "scan"))
    await _event(db_session, b, "stage.changed", "2026-08-07 00:00:00", _stage("devis", "scan"))
    await _event(db_session, b, "stage.changed", "2026-09-10 00:00:00", _stage("scan", "model"))

    body = (await async_client.get(STATS, params={"date_from": "2026-08-01", "date_to": "2026-08-31"})).json()
    days = {row["column"]: row for row in body["stage_days"]}
    assert [row["column"] for row in body["stage_days"]] == ["devis", "waiting", "scan", "model", "print", "finish"]
    assert days["devis"] == {"column": "devis", "median_days": 4.0, "sample": 2}  # (2 + 6) / 2
    assert days["waiting"] == {"column": "waiting", "median_days": 4.0, "sample": 1}
    assert days["scan"] == {"column": "scan", "median_days": None, "sample": 0}


@pytest.mark.asyncio
async def test_invoicing_period_total_and_snapshot_outstanding(async_client, db_session):
    a = await _create(async_client, description="a")
    b = await _create(async_client, description="b")
    c = await _create(async_client, description="c")
    await _set(db_session, a, quote_total=1000.0, quote_invoiced=1, invoice_balance=400.0)
    await _set(db_session, b, quote_total=700.0, quote_invoiced=1, invoice_balance=0.0)
    await _set(db_session, c, quote_total=300.0, quote_invoiced=1, invoice_balance=300.0)
    await _event(db_session, a, "quote.accepted", "2026-08-10 09:00:00")
    await _event(db_session, b, "quote.accepted", "2026-08-11 09:00:00")
    await _event(db_session, c, "quote.accepted", "2026-07-01 09:00:00")  # outside the period

    body = (await async_client.get(STATS, params={"date_from": "2026-08-01", "date_to": "2026-08-31"})).json()
    inv = body["invoicing"]
    assert inv["invoiced_total"] == 1700.0 and inv["invoiced_count"] == 2
    assert inv["outstanding_balance"] == 700.0 and inv["outstanding_count"] == 2


@pytest.mark.asyncio
async def test_inverted_range_is_422_and_absent_dates_are_allowed(async_client):
    assert (
        await async_client.get(STATS, params={"date_from": "2026-09-02", "date_to": "2026-09-01"})
    ).status_code == 422
    r = await async_client.get(STATS)
    assert r.status_code == 200
    assert r.json()["date_from"] is None and r.json()["date_to"] is None


def test_stats_route_is_gated_on_aito_read():
    assert _declared_permissions("get_aito_stats") == ["aito:read"]
