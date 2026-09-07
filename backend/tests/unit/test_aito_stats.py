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


async def _event(db_session, pid: int, kind: str, at: str, changes=None, detail=None):
    await db_session.execute(
        text(
            "INSERT INTO aito_events (project_id, occurred_at, kind, actor_class, changes, detail) "
            "VALUES (:pid, :at, :kind, 'user', :changes, :detail)"
        ),
        {"pid": pid, "at": at, "kind": kind, "changes": changes, "detail": detail},
    )
    await db_session.commit()


async def _move_event(db_session, pid: int, kind: str, at: str):
    """Backdate an event `record()` stamped with the real 'now' — the import
    marker and the creation-move anchor are both about WHEN, so the tests need
    to place the real rows on the calendar rather than fabricate look-alikes."""
    await db_session.execute(
        text("UPDATE aito_events SET occurred_at = :at WHERE project_id = :pid AND kind = :kind"),
        {"pid": pid, "at": at, "kind": kind},
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
async def test_events_strictly_after_the_range_end_are_invisible_to_every_block(async_client, db_session):
    """Regression for the SQL-side upper bound: rows past `end` must change
    nothing, whether they are the row a bucket would have counted, the row
    `_stage_days` would have used to open/close a stay, or the project's own
    `project.created` (the `born` anchor `_is_creation_time` compares against).
    Baseline body is captured first so this also pins that adding
    strictly-later history is a no-op, not just that specific fields survive.
    """
    a = await _create(async_client, description="a")
    b = await _create(async_client, description="b")
    await _set(db_session, a, created_at="2026-08-01 00:00:00", quote_total=1000.0)
    await _set(db_session, b, created_at="2026-08-01 00:00:00", quote_total=500.0)
    await _event(db_session, a, "stage.changed", "2026-08-05 00:00:00", _stage("devis", "waiting"))
    await _event(db_session, a, "quote.sent", "2026-08-06 09:00:00")
    await _event(db_session, a, "quote.accepted", "2026-08-10 09:00:00")

    params = {"date_from": "2026-08-01", "date_to": "2026-08-31"}
    baseline = (await async_client.get(STATS, params=params)).json()

    # Noise strictly after `end` (2026-09-01 00:00:00 UTC is the first instant
    # excluded by `date_to=2026-08-31`): a fresh `project.created` for `b`
    # (the `born` anchor), a `stage.changed` on `b` that would otherwise open
    # a stay, and a second `stage.changed` on `a` that would otherwise close
    # `waiting` and open `scan`. Plus late sent/accepted/declined so every
    # `_first_moments` caller is exercised.
    await _move_event(db_session, b, "project.created", "2026-09-05 00:00:00")
    await _event(db_session, b, "stage.changed", "2026-09-05 00:00:05", _stage("devis", "waiting"))
    await _event(db_session, a, "stage.changed", "2026-09-06 00:00:00", _stage("waiting", "scan"))
    await _event(db_session, a, "quote.sent", "2026-09-07 09:00:00")
    await _event(db_session, b, "quote.accepted", "2026-09-08 09:00:00")
    await _event(db_session, b, "quote.declined", "2026-09-09 09:00:00")

    after = (await async_client.get(STATS, params=params)).json()
    assert after == baseline


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
async def test_zoho_side_acceptance_without_an_event_counts_from_quote_accepted_at(async_client, db_session):
    """reconcile_quote_status adopts a Books decision and records only
    `poll.reconciled` — but adopt_quote_status DOES stamp quote_accepted_at, so
    that column is the acceptance moment when no `quote.accepted` event exists."""
    silent = await _create(async_client, description="silent")
    both = await _create(async_client, description="both")
    await _set(db_session, silent, quote_total=800.0, quote_invoiced=1, quote_accepted_at="2026-08-14 09:00:00")
    await _set(db_session, both, quote_total=200.0, quote_accepted_at="2026-08-20 09:00:00")
    # Later stamp than the event: the earlier of the two wins, so `both` is
    # counted at 2026-07-02 — outside the window below.
    await _event(db_session, both, "quote.accepted", "2026-07-02 09:00:00")

    body = (await async_client.get(STATS, params={"date_from": "2026-08-01", "date_to": "2026-08-31"})).json()
    assert body["conversion"]["accepted"] == {"count": 1, "total": 800.0}
    assert body["invoicing"]["invoiced_total"] == 800.0 and body["invoicing"]["invoiced_count"] == 1

    july = (await async_client.get(STATS, params={"date_from": "2026-07-01", "date_to": "2026-07-31"})).json()
    assert july["conversion"]["accepted"] == {"count": 1, "total": 200.0}


@pytest.mark.asyncio
async def test_imported_decision_events_are_not_counted_in_the_import_period(async_client, db_session):
    """A quote imported already-decided records `quote.accepted` at the import
    moment for an acceptance that happened at some unknown past moment."""
    pid = await _create(async_client, quote_id="zq1", quote_number="Q-1", quote_status="accepted")
    await _set(db_session, pid, quote_total=5000.0, quote_invoiced=1)
    # create_project stamped the decision with detail {"cause": "import"} at the
    # import moment; put that real row inside the window under test.
    await _move_event(db_session, pid, "quote.accepted", "2026-08-10 09:00:00")

    body = (await async_client.get(STATS, params={"date_from": "2026-08-01", "date_to": "2026-08-31"})).json()
    assert body["conversion"]["accepted"] == {"count": 0, "total": 0.0}
    assert body["invoicing"]["invoiced_total"] == 0.0 and body["invoicing"]["invoiced_count"] == 0
    # No decision counted at all, so the rate has no denominator.
    assert body["conversion"]["acceptance_rate"] is None


@pytest.mark.asyncio
async def test_a_decision_recorded_at_creation_is_an_import_even_without_the_cause(async_client, db_session):
    """Cards imported before `detail.cause = "import"` existed carry an unmarked
    decision stamped at the import moment. The same 60 s creation window the
    stage-days rule uses catches them, so no backfill migration is needed."""
    at_creation = await _create(async_client, description="legacy import")
    later = await _create(async_client, description="decided later")
    await _set(db_session, at_creation, quote_total=5000.0, quote_invoiced=1)
    await _set(db_session, later, quote_total=600.0)
    await _move_event(db_session, at_creation, "project.created", "2026-08-10 12:00:00")
    await _move_event(db_session, later, "project.created", "2026-08-10 12:00:00")
    await _event(db_session, at_creation, "quote.accepted", "2026-08-10 12:00:05")
    await _event(db_session, later, "quote.accepted", "2026-08-12 12:00:05")

    body = (await async_client.get(STATS, params={"date_from": "2026-08-01", "date_to": "2026-08-31"})).json()
    assert body["conversion"]["accepted"] == {"count": 1, "total": 600.0}
    assert body["invoicing"]["invoiced_total"] == 0.0 and body["invoicing"]["invoiced_count"] == 0


@pytest.mark.asyncio
async def test_creation_time_stage_move_is_not_a_stay(async_client, db_session):
    """An imported card's created_at is backdated to the quote's date, so the
    board rules' move at creation would otherwise close a weeks-long fake stay."""
    pid = await _create(async_client, description="imported")
    await _set(db_session, pid, created_at="2026-08-01 00:00:00")
    await _move_event(db_session, pid, "project.created", "2026-08-20 12:00:00")
    await _event(db_session, pid, "stage.changed", "2026-08-20 12:00:05", _stage("devis", "print"))
    await _event(db_session, pid, "stage.changed", "2026-08-22 12:00:05", _stage("print", "finish"))

    body = (await async_client.get(STATS, params={"date_from": "2026-08-01", "date_to": "2026-08-31"})).json()
    days = {row["column"]: row for row in body["stage_days"]}
    assert days["devis"] == {"column": "devis", "median_days": None, "sample": 0}
    # The skipped move still opened the `print` stay, which the move 2 days later closes.
    assert days["print"] == {"column": "print", "median_days": 2.0, "sample": 1}


@pytest.mark.asyncio
async def test_a_move_out_of_done_is_no_stay_but_still_resets_the_clock(async_client, db_session):
    """Done -> Finish (a re-open) produces no stay: `done` has no stage-days
    entry. It must still start the next stay, or Finish would be measured from
    the card's creation."""
    pid = await _create(async_client, description="reopened")
    await _set(db_session, pid, created_at="2026-08-01 00:00:00")
    await _event(db_session, pid, "stage.changed", "2026-08-05 00:00:00", _stage("done", "finish"))
    await _event(db_session, pid, "stage.changed", "2026-08-08 00:00:00", _stage("finish", "print"))

    body = (await async_client.get(STATS, params={"date_from": "2026-08-01", "date_to": "2026-08-31"})).json()
    days = {row["column"]: row for row in body["stage_days"]}
    assert [row["column"] for row in body["stage_days"]] == ["devis", "waiting", "scan", "model", "print", "finish"]
    assert days["finish"] == {"column": "finish", "median_days": 3.0, "sample": 1}  # not 7 from created_at
    assert days["devis"] == {"column": "devis", "median_days": None, "sample": 0}


@pytest.mark.asyncio
async def test_range_is_local_calendar_days_via_tz_offset(async_client, db_session):
    """UTC-10 (tz_offset_minutes=-600): the local day 2026-08-31 runs from
    2026-08-31 10:00 UTC to 2026-09-01 09:59:59 UTC."""
    early = await _create(async_client, description="early")
    late = await _create(async_client, description="late")
    await _set(db_session, early, quote_total=100.0)
    await _set(db_session, late, quote_total=250.0)
    await _event(db_session, early, "quote.sent", "2026-08-31 09:30:00")  # 30 Aug locally
    await _event(db_session, late, "quote.sent", "2026-08-31 23:30:00")  # 31 Aug locally

    params = {"date_from": "2026-08-31", "date_to": "2026-08-31", "tz_offset_minutes": -600}
    body = (await async_client.get(STATS, params=params)).json()
    assert body["conversion"]["sent"] == {"count": 1, "total": 250.0}

    # Same window in UTC keeps the early one and drops the late one's neighbour-day nothing.
    utc = (await async_client.get(STATS, params={"date_from": "2026-08-31", "date_to": "2026-08-31"})).json()
    assert utc["conversion"]["sent"] == {"count": 2, "total": 350.0}


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


async def _view(db_session, pid: int, at: str):
    await db_session.execute(
        text("INSERT INTO aito_tracking_views (project_id, viewed_at) VALUES (:pid, :at)"), {"pid": pid, "at": at}
    )
    await db_session.commit()


@pytest.mark.asyncio
async def test_tracking_block_counts_views_in_range_distinct_cards_and_cards_with_a_link(async_client, db_session):
    a = await _create(async_client, description="a")
    b = await _create(async_client, description="b")
    gone = await _create(async_client, description="gone")
    await _set(db_session, a, tracking_token="tok-a")
    await _set(db_session, b, tracking_token="tok-b")
    await _set(db_session, gone, tracking_token="tok-gone", status="deleted")
    await _view(db_session, a, "2026-08-10 09:00:00")
    await _view(db_session, a, "2026-08-11 09:00:00")
    await _view(db_session, b, "2026-08-12 09:00:00")
    await _view(db_session, b, "2026-09-01 09:00:00")  # outside the window

    body = (await async_client.get(f"{STATS}?date_from=2026-08-01&date_to=2026-08-31")).json()
    assert body["tracking"] == {"views": 3, "cards_viewed": 2, "cards_with_link": 2}
    empty = (await async_client.get(f"{STATS}?date_from=2026-07-01&date_to=2026-07-31")).json()
    assert empty["tracking"] == {"views": 0, "cards_viewed": 0, "cards_with_link": 2}
