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


@pytest.mark.asyncio
async def test_tracking_block_excludes_views_of_a_trashed_card(async_client, db_session):
    """A card the client had already opened can later be trashed — a routine
    board action — and the trashed card's views must not count towards `views`
    or `cards_viewed`, matching `cards_with_link` (computed from active
    projects only) and the module's trashed-excluded rule."""
    a = await _create(async_client, description="a")
    b = await _create(async_client, description="b")
    trashed = await _create(async_client, description="trashed")
    await _set(db_session, a, tracking_token="tok-a")
    await _set(db_session, b, tracking_token="tok-b")
    await _set(db_session, trashed, tracking_token="tok-trashed", status="deleted")
    await _view(db_session, a, "2026-08-10 09:00:00")
    await _view(db_session, b, "2026-08-12 09:00:00")
    await _view(db_session, trashed, "2026-08-13 09:00:00")
    await _view(db_session, trashed, "2026-08-14 09:00:00")

    body = (await async_client.get(f"{STATS}?date_from=2026-08-01&date_to=2026-08-31")).json()
    assert body["tracking"] == {"views": 2, "cards_viewed": 2, "cards_with_link": 2}


# ---------------------------------------------------------------------------
# Statistics view: throughput / previous / daily
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_throughput_counts_created_accepted_done_in_range(async_client, db_session):
    a = await _create(async_client)
    b = await _create(async_client)
    c = await _create(async_client)
    await _move_event(db_session, a, "project.created", "2026-03-02 10:00:00")
    await _move_event(db_session, b, "project.created", "2026-03-03 10:00:00")
    await _move_event(db_session, c, "project.created", "2026-02-20 10:00:00")  # before the range
    await _set(db_session, a, created_at="2026-03-02 10:00:00")
    await _set(db_session, b, created_at="2026-03-03 10:00:00")
    await _event(db_session, a, "quote.accepted", "2026-03-04 09:00:00")
    await _event(db_session, a, "stage.changed", "2026-03-06 10:00:00", changes=_stage("finish", "done"))
    await _event(db_session, b, "stage.changed", "2026-03-08 22:00:00", changes=_stage("finish", "done"))
    await _set(db_session, a, board_column="done")
    await _set(db_session, b, board_column="done")

    r = await async_client.get(STATS, params={"date_from": "2026-03-01", "date_to": "2026-03-10"})
    assert r.status_code == 200, r.text
    tp = r.json()["throughput"]
    assert (tp["created"], tp["accepted"], tp["done"]) == (2, 1, 2)
    assert tp["per_day"] == 0.2  # 2 created / 10 days
    # lead: a = 4 days, b = 5.5 days -> mean 4.75, median 4.75
    assert tp["lead_days"] == 4.75
    assert tp["lead_days_median"] == 4.75
    # production: only a has an acceptance -> 2 days 1h = 2.04
    assert tp["production_days"] == 2.04
    assert tp["active"] == 1  # c is still on the board


@pytest.mark.asyncio
async def test_done_moment_is_the_first_real_move_into_done(async_client, db_session):
    p = await _create(async_client)
    await _move_event(db_session, p, "project.created", "2026-03-01 10:00:00")
    # Creation-time placement into done (an imported, invoiced quote) is not a completion.
    await _event(db_session, p, "stage.changed", "2026-03-01 10:00:20", changes=_stage("devis", "done"))
    await _event(db_session, p, "stage.changed", "2026-03-05 10:00:00", changes=_stage("done", "finish"))
    await _event(db_session, p, "stage.changed", "2026-03-07 10:00:00", changes=_stage("finish", "done"))
    await _event(db_session, p, "stage.changed", "2026-03-09 10:00:00", changes=_stage("done", "finish"))
    await _event(db_session, p, "stage.changed", "2026-03-11 10:00:00", changes=_stage("finish", "done"))

    r = await async_client.get(STATS, params={"date_from": "2026-03-06", "date_to": "2026-03-08"})
    assert r.json()["throughput"]["done"] == 1
    r = await async_client.get(STATS, params={"date_from": "2026-03-10", "date_to": "2026-03-12"})
    assert r.json()["throughput"]["done"] == 0  # the re-open + re-close is not a second completion


@pytest.mark.asyncio
async def test_daily_rows_are_zero_filled_local_days(async_client, db_session):
    p = await _create(async_client)
    # 2026-03-02 23:30 UTC is 2026-03-03 in UTC+1
    await _move_event(db_session, p, "project.created", "2026-03-02 23:30:00")
    await _event(db_session, p, "quote.accepted", "2026-03-03 12:00:00")
    q = await _create(async_client)
    await _move_event(db_session, q, "project.created", "2026-02-20 10:00:00")
    await _event(db_session, q, "quote.declined", "2026-03-04 12:00:00")

    r = await async_client.get(
        STATS, params={"date_from": "2026-03-01", "date_to": "2026-03-04", "tz_offset_minutes": 60}
    )
    daily = r.json()["daily"]
    assert [d["day"] for d in daily] == ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04"]
    assert [(d["created"], d["accepted"], d["declined"], d["done"]) for d in daily] == [
        (0, 0, 0, 0),
        (0, 0, 0, 0),
        (1, 1, 0, 0),
        (0, 0, 1, 0),
    ]


@pytest.mark.asyncio
async def test_previous_block_is_the_preceding_window_of_equal_length(async_client, db_session):
    a = await _create(async_client)
    b = await _create(async_client)
    await _move_event(db_session, a, "project.created", "2026-03-02 10:00:00")  # previous window (Feb 27 - Mar 3)
    await _move_event(db_session, b, "project.created", "2026-03-05 10:00:00")  # current window (Mar 4 - Mar 8)
    await _event(db_session, a, "quote.declined", "2026-03-03 10:00:00")  # previous window

    r = await async_client.get(STATS, params={"date_from": "2026-03-04", "date_to": "2026-03-08"})
    body = r.json()
    assert body["throughput"]["created"] == 1
    assert body["previous"] == {"created": 1, "accepted": 0, "declined": 1, "done": 0, "lead_days": None}


@pytest.mark.asyncio
async def test_all_time_has_no_previous_and_spans_from_first_project(async_client, db_session):
    p = await _create(async_client)
    await _move_event(db_session, p, "project.created", "2026-03-02 10:00:00")

    r = await async_client.get(STATS)
    body = r.json()
    assert body["previous"] is None
    assert body["daily"][0]["day"] == "2026-03-02"
    assert body["daily"][0]["created"] == 1
    assert body["throughput"]["per_day"] is not None and body["throughput"]["per_day"] > 0


# ---------------------------------------------------------------------------
# Sections: sales / time / money / clients
# ---------------------------------------------------------------------------


async def _task(db_session, pid: int, **cols):
    keys = ", ".join(["project_id", *cols])
    vals = ", ".join([":pid", *[f":{k}" for k in cols]])
    await db_session.execute(text(f"INSERT INTO aito_tasks ({keys}) VALUES ({vals})"), {"pid": pid, **cols})
    await db_session.commit()


@pytest.mark.asyncio
async def test_quote_age_buckets_active_sent_quotes_as_of_today(async_client, db_session):
    from datetime import datetime, timedelta

    now = datetime.utcnow()
    a = await _create(async_client)
    b = await _create(async_client)
    c = await _create(async_client)
    d = await _create(async_client)
    await _set(
        db_session, a, quote_status="sent", quote_sent_at=(now - timedelta(days=1)).isoformat(" "), quote_total=100
    )
    await _set(
        db_session, b, quote_status="sent", quote_sent_at=(now - timedelta(days=9)).isoformat(" "), quote_total=200
    )
    await _set(
        db_session, c, quote_status="sent", quote_sent_at=(now - timedelta(days=40)).isoformat(" "), quote_total=300
    )
    await _set(
        db_session, d, quote_status="accepted", quote_sent_at=(now - timedelta(days=40)).isoformat(" "), quote_total=999
    )

    r = await async_client.get(STATS)
    rows = {row["bucket"]: row for row in r.json()["quote_age"]}
    assert list(rows) == ["0-3", "4-7", "8-14", "15+"]
    assert (rows["0-3"]["count"], rows["0-3"]["total"]) == (1, 100)
    assert (rows["4-7"]["count"], rows["4-7"]["total"]) == (0, 0)
    assert (rows["8-14"]["count"], rows["8-14"]["total"]) == (1, 200)
    assert (rows["15+"]["count"], rows["15+"]["total"]) == (1, 300)


@pytest.mark.asyncio
async def test_size_bands_cut_decisions_into_equal_count_bands(async_client, db_session):
    for i in range(8):
        p = await _create(async_client)
        await _move_event(db_session, p, "project.created", "2026-03-01 10:00:00")
        await _set(db_session, p, quote_total=(i + 1) * 1000)
        kind = "quote.accepted" if i % 2 == 0 else "quote.declined"
        await _event(db_session, p, kind, f"2026-03-0{2 + i % 3} 10:00:00")

    r = await async_client.get(STATS, params={"date_from": "2026-03-01", "date_to": "2026-03-10"})
    bands = r.json()["size_bands"]
    assert [(b["min"], b["max"]) for b in bands] == [(1000, 2000), (3000, 4000), (5000, 6000), (7000, 8000)]
    assert all(b["accepted"] == 1 and b["declined"] == 1 and b["rate"] == 0.5 for b in bands)


@pytest.mark.asyncio
async def test_size_bands_with_three_decisions_is_one_band(async_client, db_session):
    for i in range(3):
        p = await _create(async_client)
        await _move_event(db_session, p, "project.created", "2026-03-01 10:00:00")
        await _set(db_session, p, quote_total=(i + 1) * 10)
        await _event(db_session, p, "quote.accepted", "2026-03-03 10:00:00")
    r = await async_client.get(STATS, params={"date_from": "2026-03-01", "date_to": "2026-03-10"})
    bands = r.json()["size_bands"]
    assert len(bands) == 1 and (bands[0]["min"], bands[0]["max"], bands[0]["accepted"]) == (10, 30, 3)


@pytest.mark.asyncio
async def test_overdue_buckets_and_oldest_as_of_today(async_client, db_session):
    from datetime import date, timedelta

    today = date.today()
    a = await _create(async_client)
    b = await _create(async_client)
    c = await _create(async_client)
    await _set(
        db_session, a, quote_invoiced=1, invoice_balance=100, invoice_due_date=(today - timedelta(days=3)).isoformat()
    )
    await _set(
        db_session, b, quote_invoiced=1, invoice_balance=250, invoice_due_date=(today - timedelta(days=45)).isoformat()
    )
    await _set(
        db_session, c, quote_invoiced=1, invoice_balance=0, invoice_due_date=(today - timedelta(days=45)).isoformat()
    )

    r = await async_client.get(STATS)
    od = r.json()["overdue"]
    assert [(x["bucket"], x["count"], x["balance"]) for x in od["buckets"]] == [
        ("1-7", 1, 100),
        ("8-30", 0, 0),
        ("31+", 1, 250),
    ]
    assert od["oldest_days"] == 45


@pytest.mark.asyncio
async def test_stage_time_per_completed_project_newest_first(async_client, db_session):
    a = await _create(async_client, description="Long one")
    b = await _create(async_client, description="Quick")
    for pid, day in ((a, 1), (b, 5)):
        await _move_event(db_session, pid, "project.created", f"2026-03-0{day} 10:00:00")
        await _set(db_session, pid, created_at=f"2026-03-0{day} 10:00:00")
    await _event(db_session, a, "stage.changed", "2026-03-03 10:00:00", changes=_stage("devis", "print"))
    await _event(db_session, a, "stage.changed", "2026-03-06 10:00:00", changes=_stage("print", "done"))
    await _event(db_session, b, "stage.changed", "2026-03-07 10:00:00", changes=_stage("devis", "done"))
    await _event(db_session, b, "stage.changed", "2026-03-08 10:00:00", changes=_stage("done", "finish"))  # re-open

    r = await async_client.get(STATS, params={"date_from": "2026-03-01", "date_to": "2026-03-10"})
    rows = r.json()["stage_time"]
    assert [x["project_id"] for x in rows] == [b, a]
    long = next(x for x in rows if x["project_id"] == a)
    assert long["stages"]["devis"] == 2.0 and long["stages"]["print"] == 3.0 and long["stages"]["finish"] == 0.0
    assert long["description"] == "Long one"


@pytest.mark.asyncio
async def test_rework_counts_backward_moves_and_share_of_moved_cards(async_client, db_session):
    a = await _create(async_client)
    b = await _create(async_client)
    for pid in (a, b):
        await _move_event(db_session, pid, "project.created", "2026-03-01 10:00:00")
    await _event(db_session, a, "stage.changed", "2026-03-03 10:00:00", changes=_stage("devis", "print"))
    await _event(db_session, a, "stage.changed", "2026-03-04 10:00:00", changes=_stage("print", "model"))  # backward
    await _event(db_session, a, "stage.changed", "2026-03-05 10:00:00", changes=_stage("model", "print"))
    await _event(db_session, b, "stage.changed", "2026-03-03 10:00:00", changes=_stage("devis", "waiting"))

    r = await async_client.get(STATS, params={"date_from": "2026-03-01", "date_to": "2026-03-10"})
    assert r.json()["rework"] == {"moves": 1, "cards": 1, "share": 0.5}


@pytest.mark.asyncio
async def test_services_revenue_from_net_cost_over_cards_accepted_in_range(async_client, db_session):
    p = await _create(async_client)
    await _move_event(db_session, p, "project.created", "2026-03-01 10:00:00")
    await _event(db_session, p, "quote.accepted", "2026-03-03 10:00:00")
    await _task(db_session, p, position=0, scan_cost=1000, scan_discount_pct=10, impression_cost=500)
    await _task(db_session, p, position=1, impression_cost=300)
    q = await _create(async_client)  # not accepted -> ignored
    await _task(db_session, q, position=0, usinage_cost=9999)

    r = await async_client.get(STATS, params={"date_from": "2026-03-01", "date_to": "2026-03-10"})
    rows = {x["service"]: x for x in r.json()["services"]}
    assert list(rows) == ["scan", "modelisation", "impression", "usinage"]
    assert (rows["scan"]["tasks"], rows["scan"]["revenue"]) == (1, 900)
    assert (rows["impression"]["tasks"], rows["impression"]["revenue"]) == (2, 800)
    assert (rows["usinage"]["tasks"], rows["usinage"]["revenue"]) == (0, 0)


@pytest.mark.asyncio
async def test_clients_new_vs_returning_by_earlier_card(async_client, db_session):
    old = await _create(async_client, client_id="z1")
    await _move_event(db_session, old, "project.created", "2026-01-01 10:00:00")
    await _set(db_session, old, created_at="2026-01-01 10:00:00")
    again = await _create(async_client, client_id="z1")
    fresh = await _create(async_client, client_id="z2")
    for pid, total in ((again, 100), (fresh, 50)):
        await _move_event(db_session, pid, "project.created", "2026-03-02 10:00:00")
        await _set(db_session, pid, created_at="2026-03-02 10:00:00", quote_total=total)

    r = await async_client.get(STATS, params={"date_from": "2026-03-01", "date_to": "2026-03-10"})
    assert r.json()["clients"] == {"new": 1, "returning": 1, "new_total": 50, "returning_total": 100}


@pytest.mark.asyncio
async def test_arrivals_grid_is_local_weekday_by_hour(async_client, db_session):
    p = await _create(async_client)
    # 2026-03-02 is a Monday; 23:30 UTC is Tuesday 00:30 in UTC+1
    await _move_event(db_session, p, "project.created", "2026-03-02 23:30:00")
    r = await async_client.get(
        STATS, params={"date_from": "2026-03-01", "date_to": "2026-03-10", "tz_offset_minutes": 60}
    )
    grid = r.json()["arrivals"]
    assert len(grid) == 7 and all(len(row) == 24 for row in grid)
    assert grid[1][0] == 1 and sum(map(sum, grid)) == 1


@pytest.mark.asyncio
async def test_islands_sorted_by_count_with_pickup_last(async_client, db_session):
    rows = [("moorea", 1500), ("moorea", 1500), ("huahine", 2000), (None, None)]
    for island, price in rows:
        p = await _create(async_client)
        await _move_event(db_session, p, "project.created", "2026-03-02 10:00:00")
        await _set(db_session, p, shipping_island=island, shipping_price=price)
    r = await async_client.get(STATS, params={"date_from": "2026-03-01", "date_to": "2026-03-10"})
    assert r.json()["islands"] == [
        {"island": "moorea", "count": 2, "shipping_total": 3000},
        {"island": "huahine", "count": 1, "shipping_total": 2000},
        {"island": None, "count": 1, "shipping_total": 0},
    ]
