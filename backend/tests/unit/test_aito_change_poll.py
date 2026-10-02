"""The three "what changed in Books?" polls behind the change pass."""

from datetime import datetime, timedelta, timezone

import httpx
import pytest

from backend.app.api.routes.settings import get_setting
from backend.app.services import aito_change_poll
from backend.app.services.aito_poll_watermark import format_books_time
from backend.app.services.zoho import zoho_service
from backend.tests.unit.test_aito_quote_sync import (  # noqa: F401 — fixtures register by name
    _configure_zoho,
    reset_zoho_service,
)

# Relative to the run, never a fixed calendar day: the first pass reads from
# "one day ago", and the watermark never moves to before where a pass started.
NOW = datetime.now(timezone.utc).replace(microsecond=0)


def stamp(minutes_ago: int = 0) -> str:
    return format_books_time(NOW - timedelta(minutes=minutes_ago))


LISTS = {
    "/estimates": ("estimates", "estimate_id"),
    "/customerpayments": ("customerpayments", "payment_id"),
    "/retainerinvoices": ("retainerinvoices", "retainerinvoice_id"),
}


def _books(rows: dict[str, list[tuple[str, str, str]]], seen: list | None = None, fail: dict | None = None):
    """rows maps a path suffix to (id, customer_id, last_modified_time) tuples.
    fail maps a suffix to the status code that listing answers with."""

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        for suffix, (key, id_field) in LISTS.items():
            if request.url.path.endswith(suffix):
                if seen is not None:
                    seen.append((suffix, request.url.params.get("last_modified_time")))
                if fail and suffix in fail:
                    return httpx.Response(fail[suffix], json={"code": 44, "message": "no"})
                body = [
                    {id_field: rid, "customer_id": cid, "last_modified_time": stamp}
                    for rid, cid, stamp in rows.get(suffix, [])
                ]
                return httpx.Response(200, json={key: body, "page_context": {"has_more_page": False}})
        return httpx.Response(404, json={"message": "no route"})

    return handler


@pytest.mark.asyncio
async def test_changed_rows_become_estimate_ids_and_customer_ids(db_session):
    await _configure_zoho(db_session)
    zoho_service.transport = httpx.MockTransport(
        _books(
            {
                "/estimates": [("E1", "C1", stamp(10))],
                "/customerpayments": [("P1", "C2", stamp(5))],
                "/retainerinvoices": [("R1", "C3", stamp(4))],
            }
        )
    )

    changes = await aito_change_poll.poll_changes(db_session)

    assert changes.estimate_ids == {"E1"}
    assert changes.customer_ids == {"C2", "C3"}
    assert changes.rate_limited is None


@pytest.mark.asyncio
async def test_each_poll_advances_its_own_watermark_and_resumes_from_it(db_session):
    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(_books({"/estimates": [("E1", "C1", stamp(10))]}, seen))

    await aito_change_poll.poll_changes(db_session)
    # The newest row, rewound by OVERLAP_SECONDS (2).
    expected = format_books_time(NOW - timedelta(minutes=10, seconds=2))
    assert await get_setting(db_session, "aito_estimate_poll_since") == expected
    # A poll that saw no row leaves no watermark behind.
    assert not await get_setting(db_session, "aito_payment_poll_since")

    await aito_change_poll.poll_changes(db_session)
    estimate_calls = [since for suffix, since in seen if suffix == "/estimates"]
    assert estimate_calls[1] == expected


@pytest.mark.asyncio
async def test_a_row_re_read_through_the_overlap_is_not_reported_twice(db_session):
    # Books' filter is inclusive and the watermark rewinds, so the newest row
    # comes back on every pass until something newer changes. Reporting it
    # each time would reconcile that card once a minute forever.
    await _configure_zoho(db_session)
    rows = {"/estimates": [("E1", "C1", stamp(10))]}
    zoho_service.transport = httpx.MockTransport(_books(rows))

    first = await aito_change_poll.poll_changes(db_session)
    second = await aito_change_poll.poll_changes(db_session)
    assert first.estimate_ids == {"E1"}
    assert second.estimate_ids == set()

    # Touched again in Books: a new timestamp is a new change.
    rows["/estimates"] = [("E1", "C1", stamp(1))]
    third = await aito_change_poll.poll_changes(db_session)
    assert third.estimate_ids == {"E1"}


@pytest.mark.asyncio
async def test_a_failed_poll_costs_only_that_poll_and_keeps_its_watermark(db_session):
    await _configure_zoho(db_session)
    zoho_service.transport = httpx.MockTransport(
        _books(
            {
                "/estimates": [("E1", "C1", stamp(10))],
                "/retainerinvoices": [("R1", "C3", stamp(4))],
            },
            fail={"/customerpayments": 500},
        )
    )

    changes = await aito_change_poll.poll_changes(db_session)

    assert changes.estimate_ids == {"E1"}
    assert changes.customer_ids == {"C3"}
    assert not await get_setting(db_session, "aito_payment_poll_since")


@pytest.mark.asyncio
async def test_a_rate_limit_keeps_the_changes_already_read(db_session):
    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        _books(
            {"/estimates": [("E1", "C1", stamp(10))]},
            seen,
            fail={"/customerpayments": 429},
        )
    )

    changes = await aito_change_poll.poll_changes(db_session)

    assert changes.estimate_ids == {"E1"}
    assert changes.rate_limited is not None and changes.rate_limited.code == 44
    # The org said stop: the third listing is not attempted.
    assert [suffix for suffix, _ in seen] == ["/estimates", "/customerpayments"]


@pytest.mark.asyncio
async def test_a_row_with_a_mangled_timestamp_or_no_id_does_not_break_the_pass(db_session):
    await _configure_zoho(db_session)
    zoho_service.transport = httpx.MockTransport(
        _books(
            {
                "/estimates": [("E1", "C1", "not a time"), ("", "C1", stamp(10))],
                "/customerpayments": [("P1", "", stamp(5))],
            }
        )
    )

    changes = await aito_change_poll.poll_changes(db_session)

    assert changes.estimate_ids == {"E1"}  # still reported; only its timestamp is ignored
    assert changes.customer_ids == set()  # a payment with no customer names no card


@pytest.mark.asyncio
async def test_a_pass_that_raises_part_way_reports_the_same_rows_again(db_session, monkeypatch):
    # A non-Zoho failure (say SQLite "database is locked") escapes the pass,
    # so the caller never enqueues what it read. Neither the memo nor the
    # watermark may move, or those rows would be skipped as already reported.
    await _configure_zoho(db_session)
    rows = {"/estimates": [("E1", "C1", stamp(10))]}
    zoho_service.transport = httpx.MockTransport(_books(rows))
    assert (await aito_change_poll.poll_changes(db_session)).estimate_ids == {"E1"}
    watermark = await get_setting(db_session, "aito_estimate_poll_since")
    seen_before = {name: dict(window) for name, window in aito_change_poll._seen.items()}

    rows["/estimates"] = [("E1", "C1", stamp(1)), ("E2", "C2", stamp(2))]

    async def locked(_db, _since):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(zoho_service, "list_customer_payments_modified_since", locked)
    with pytest.raises(RuntimeError):
        await aito_change_poll.poll_changes(db_session)

    assert aito_change_poll._seen == seen_before
    assert await get_setting(db_session, "aito_estimate_poll_since") == watermark

    monkeypatch.undo()
    again = await aito_change_poll.poll_changes(db_session)
    assert again.estimate_ids == {"E1", "E2"}


@pytest.mark.asyncio
async def test_a_watermark_write_that_raises_leaves_the_memo_alone(db_session, monkeypatch):
    await _configure_zoho(db_session)
    zoho_service.transport = httpx.MockTransport(
        _books(
            {
                "/estimates": [("E1", "C1", stamp(10))],
                "/customerpayments": [("P1", "C2", stamp(5))],
            }
        )
    )
    real_advance = aito_change_poll.advance_watermark

    async def advance_then_lock(db, setting, *args, **kwargs):
        if setting == "aito_payment_poll_since":
            raise RuntimeError("database is locked")
        await real_advance(db, setting, *args, **kwargs)

    monkeypatch.setattr(aito_change_poll, "advance_watermark", advance_then_lock)
    with pytest.raises(RuntimeError):
        await aito_change_poll.poll_changes(db_session)
    assert aito_change_poll._seen == {name: {} for name in aito_change_poll._seen}

    monkeypatch.undo()
    again = await aito_change_poll.poll_changes(db_session)
    assert again.estimate_ids == {"E1"}
    assert again.customer_ids == {"C2"}
