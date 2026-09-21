"""The 5-minute invoice poll: one org-wide "what changed in Books" call a tick.

Covers the two gaps the per-project pull leaves open — an invoice raised in
Books takes up to an hour to reach the card's cached figures, and one raised
WITHOUT converting the estimate never reaches them at all — plus the
watermark that makes the poll cost one call instead of a rescan.
"""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from backend.app.api.routes.settings import get_setting, set_setting
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.services import aito_invoice_poll
from backend.app.services.aito_invoice_poll import POLL_SINCE_SETTING, poll_invoices
from backend.app.services.zoho import ZohoRateLimited, ZohoUpstreamError, zoho_service


def _row(**fields) -> dict:
    base = {
        "id": "INV1",
        "number": "FA-26-4367",
        "reference_number": "AITO-1",
        "customer_id": "z1",
        "date": "2026-09-21",
        "due_date": "2026-09-21",
        "total": 7000.0,
        "balance": 0.0,
        "currency_code": "XPF",
        "status": "paid",
        "last_modified_time": "2026-09-21T09:18:07-1000",
    }
    base.update(fields)
    return base


async def _project(db, **fields) -> AitoProject:
    base = {
        "description": "x",
        "board_column": "finish",
        "position": 0,
        "status": "active",
        "client_id": "z1",
        "quote_id": "EST1",
        "quote_number": "DEV26-2637",
        "quote_sync_state": "idle",
        "quote_invoiced": False,
    }
    base.update(fields)
    row = AitoProject(**base)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def _fake_books(monkeypatch, rows, *, detail=None, calls=None):
    """Stub the two reads and the one write the poll can make.

    ``detail`` is the ``get_invoice`` payload keyed by invoice id; a row with
    no entry answers with an invoice that is already linked, which is the
    common case and the one that must NOT trigger a repair.
    """
    calls = calls if calls is not None else []

    async def list_invoices_modified_since(db, since):
        calls.append(("list", since))
        if isinstance(rows, Exception):
            raise rows
        return list(rows)

    async def get_invoice_raw(db, invoice_id):
        calls.append(("get", invoice_id))
        return (detail or {}).get(invoice_id, {"estimate_id": "EST1"})

    async def link_invoice_to_estimate(db, invoice_id, estimate_id):
        calls.append(("link", invoice_id, estimate_id))

    monkeypatch.setattr(zoho_service, "list_invoices_modified_since", list_invoices_modified_since)
    monkeypatch.setattr(zoho_service, "get_invoice_raw", get_invoice_raw)
    monkeypatch.setattr(zoho_service, "link_invoice_to_estimate", link_invoice_to_estimate)
    return calls


async def _events(db, project_id: int, kind: str) -> list[AitoEvent]:
    stmt = select(AitoEvent).where(AitoEvent.project_id == project_id, AitoEvent.kind == kind)
    return list((await db.execute(stmt)).scalars().all())


@pytest.mark.asyncio
async def test_the_listing_asks_books_for_one_newest_first_window(monkeypatch):
    calls: list = []

    async def request(db, method, path, *, params=None, json=None):
        calls.append((method, path, params))
        return {
            "invoices": [
                {
                    "invoice_id": "1",
                    "invoice_number": "FA-1",
                    "reference_number": "AITO-9",
                    "customer_id": "C1",
                    "status": "paid",
                    "balance": 0,
                    "due_date": "2026-09-21",
                    "total": 7000,
                    "currency_code": "XPF",
                    "last_modified_time": "2026-09-21T09:18:07-1000",
                }
            ],
            "page_context": {"has_more_page": False},
        }

    monkeypatch.setattr(zoho_service, "_request", request)

    rows = await zoho_service.list_invoices_modified_since(None, "2026-09-20T10:00:00+0000")

    assert calls == [
        (
            "GET",
            "/invoices",
            {
                "last_modified_time": "2026-09-20T10:00:00+0000",
                "sort_column": "last_modified_time",
                "sort_order": "D",
                "per_page": "200",
                "page": "1",
            },
        )
    ]
    # The three fields `_map_invoice` drops are what make a row attributable.
    assert rows[0]["reference_number"] == "AITO-9"
    assert rows[0]["customer_id"] == "C1"
    assert rows[0]["last_modified_time"] == "2026-09-21T09:18:07-1000"
    assert (rows[0]["id"], rows[0]["balance"], rows[0]["status"]) == ("1", 0.0, "paid")


@pytest.mark.asyncio
async def test_the_listing_paginates_but_not_forever(monkeypatch):
    """A watermark that has somehow gone stale must cost a bounded number of
    calls, not a walk through the org's entire invoice history."""
    pages: list = []

    async def request(db, method, path, *, params=None, json=None):
        pages.append(params["page"])
        return {"invoices": [{"invoice_id": params["page"]}], "page_context": {"has_more_page": True}}

    monkeypatch.setattr(zoho_service, "_request", request)

    rows = await zoho_service.list_invoices_modified_since(None, "2020-01-01T00:00:00+0000")

    assert len(rows) == len(pages) == 10
    assert pages == [str(n) for n in range(1, 11)]


@pytest.mark.asyncio
async def test_adopts_an_invoice_by_its_aito_reference(db_session, monkeypatch):
    project = await _project(db_session)
    pid = project.id
    _fake_books(monkeypatch, [_row(reference_number=f"AITO-{pid}")])

    assert await poll_invoices(db_session) == 1

    db_session.expire_all()
    row = await db_session.get(AitoProject, pid)
    assert (row.invoice_status, row.invoice_balance, row.invoice_due_date) == ("paid", 0.0, "2026-09-21")
    assert row.quote_invoiced is True
    assert row.quote_sync_state == "locked"
    assert isinstance(row.invoice_checked_at, datetime)
    assert len(await _events(db_session, pid, "invoice.detected")) == 1


@pytest.mark.asyncio
async def test_adopts_an_invoice_by_its_quote_number_reference(db_session, monkeypatch):
    project = await _project(db_session, quote_number="DEV26-2637")
    pid = project.id
    # Case and padding differ, as Books echoes them back.
    _fake_books(monkeypatch, [_row(reference_number="  dev26-2637 ")])

    assert await poll_invoices(db_session) == 1

    db_session.expire_all()
    assert (await db_session.get(AitoProject, pid)).quote_invoiced is True


@pytest.mark.asyncio
async def test_an_unrelated_reference_touches_nothing(db_session, monkeypatch):
    project = await _project(db_session)
    pid = project.id
    # A real one from the org: a sales-order reference on a non-Aito invoice.
    calls = _fake_books(monkeypatch, [_row(reference_number="SO-00195"), _row(id="INV2", reference_number="")])

    assert await poll_invoices(db_session) == 0

    db_session.expire_all()
    row = await db_session.get(AitoProject, pid)
    assert (row.quote_invoiced, row.invoice_status, row.invoice_checked_at) == (False, None, None)
    # No per-invoice detail read for a row that matched nothing.
    assert [c for c in calls if c[0] == "get"] == []


@pytest.mark.asyncio
async def test_an_ambiguous_quote_number_is_skipped(db_session, monkeypatch):
    """Fail closed, exactly like ``find_estimate_by_reference``: two cards
    carrying one quote number must never have one of them picked at random."""
    first = await _project(db_session, quote_number="DEV26-9999")
    second = await _project(db_session, quote_number="DEV26-9999", quote_id="EST2")
    ids = (first.id, second.id)
    _fake_books(monkeypatch, [_row(reference_number="DEV26-9999")])

    assert await poll_invoices(db_session) == 0

    db_session.expire_all()
    for pid in ids:
        assert (await db_session.get(AitoProject, pid)).quote_invoiced is False


@pytest.mark.asyncio
async def test_an_orphan_invoice_is_linked_back_to_its_estimate(db_session, monkeypatch):
    project = await _project(db_session, quote_id="EST1")
    pid = project.id
    calls = _fake_books(
        monkeypatch,
        [_row(reference_number=f"AITO-{pid}")],
        detail={"INV1": {"estimate_id": ""}},
    )

    assert await poll_invoices(db_session) == 1

    assert ("link", "INV1", "EST1") in calls
    db_session.expire_all()
    assert (await db_session.get(AitoProject, pid)).quote_invoiced is True


@pytest.mark.asyncio
async def test_an_already_linked_invoice_is_not_relinked(db_session, monkeypatch):
    project = await _project(db_session)
    pid = project.id
    calls = _fake_books(monkeypatch, [_row(reference_number=f"AITO-{pid}")], detail={"INV1": {"estimate_id": "EST1"}})

    await poll_invoices(db_session)

    assert [c for c in calls if c[0] == "link"] == []


@pytest.mark.asyncio
async def test_a_second_pass_refreshes_figures_without_a_second_event(db_session, monkeypatch):
    project = await _project(db_session)
    pid = project.id
    calls = _fake_books(monkeypatch, [_row(reference_number=f"AITO-{pid}", balance=7000.0, status="unpaid")])
    await poll_invoices(db_session)

    _fake_books(monkeypatch, [_row(reference_number=f"AITO-{pid}", balance=0.0, status="paid")], calls=calls)
    assert await poll_invoices(db_session) == 1

    db_session.expire_all()
    row = await db_session.get(AitoProject, pid)
    assert (row.invoice_status, row.invoice_balance) == ("paid", 0.0)
    assert len(await _events(db_session, pid, "invoice.detected")) == 1
    # The estimate link is settled on adoption; a refresh must not re-read it.
    assert len([c for c in calls if c[0] == "get"]) == 1


@pytest.mark.asyncio
async def test_an_unmanaged_project_gets_figures_but_keeps_its_state(db_session, monkeypatch):
    """'unmanaged' is a standing instruction never to touch the quote. The
    cached figures still belong on the card — the UNPAID chip reads them."""
    project = await _project(db_session, quote_sync_state="unmanaged")
    pid = project.id
    calls = _fake_books(monkeypatch, [_row(reference_number=f"AITO-{pid}")])

    assert await poll_invoices(db_session) == 1

    db_session.expire_all()
    row = await db_session.get(AitoProject, pid)
    assert row.quote_sync_state == "unmanaged"
    assert (row.invoice_status, row.invoice_balance) == ("paid", 0.0)
    assert [c for c in calls if c[0] == "link"] == []


@pytest.mark.asyncio
async def test_a_draft_invoice_raised_by_hand_is_adopted(db_session, monkeypatch):
    """Consistent with ``_is_locked``, which locks on ``invoice_ids`` whether
    or not the invoice Books raised is still a draft."""
    project = await _project(db_session)
    pid = project.id
    _fake_books(monkeypatch, [_row(reference_number=f"AITO-{pid}", status="draft", balance=7000.0)])

    assert await poll_invoices(db_session) == 1

    db_session.expire_all()
    row = await db_session.get(AitoProject, pid)
    assert (row.quote_invoiced, row.invoice_status) == (True, "draft")


@pytest.mark.asyncio
async def test_first_run_seeds_a_backfill_window(db_session, monkeypatch):
    calls = _fake_books(monkeypatch, [])

    await poll_invoices(db_session)

    since = calls[0][1]
    assert since.endswith("+0000")  # Books rejects the 'Z' spelling
    asked = datetime.strptime(since, "%Y-%m-%dT%H:%M:%S%z")
    days = (datetime.now(timezone.utc) - asked).days
    assert aito_invoice_poll.BACKFILL_DAYS - 1 <= days <= aito_invoice_poll.BACKFILL_DAYS


@pytest.mark.asyncio
async def test_the_watermark_advances_with_an_overlap(db_session, monkeypatch):
    project = await _project(db_session)
    pid = project.id
    newest = "2026-09-21T09:18:07-1000"
    calls = _fake_books(
        monkeypatch,
        [
            _row(reference_number=f"AITO-{pid}", last_modified_time=newest),
            _row(id="INV2", reference_number="", last_modified_time="2026-09-20T13:45:27-1000"),
        ],
    )

    await poll_invoices(db_session)

    stored = await get_setting(db_session, POLL_SINCE_SETTING)
    expected = datetime.strptime(newest, "%Y-%m-%dT%H:%M:%S%z").astimezone(timezone.utc) - timedelta(
        seconds=aito_invoice_poll.OVERLAP_SECONDS
    )
    assert stored == expected.strftime("%Y-%m-%dT%H:%M:%S%z")

    _fake_books(monkeypatch, [], calls=calls)
    await poll_invoices(db_session)
    assert calls[-1] == ("list", stored)


@pytest.mark.asyncio
async def test_an_empty_pass_leaves_the_watermark_alone(db_session, monkeypatch):
    await set_setting(db_session, POLL_SINCE_SETTING, "2026-09-01T00:00:00+0000")
    await db_session.commit()
    _fake_books(monkeypatch, [])

    await poll_invoices(db_session)

    assert await get_setting(db_session, POLL_SINCE_SETTING) == "2026-09-01T00:00:00+0000"


@pytest.mark.asyncio
async def test_a_rate_limit_propagates_and_spends_no_watermark(db_session, monkeypatch):
    await set_setting(db_session, POLL_SINCE_SETTING, "2026-09-01T00:00:00+0000")
    await db_session.commit()
    _fake_books(monkeypatch, ZohoRateLimited("429"))

    with pytest.raises(ZohoRateLimited):
        await poll_invoices(db_session)

    assert await get_setting(db_session, POLL_SINCE_SETTING) == "2026-09-01T00:00:00+0000"


@pytest.mark.asyncio
async def test_one_failed_invoice_does_not_cost_the_pass(db_session, monkeypatch):
    """A malformed row, or a failed link repair, skips its own invoice only —
    the same per-item recovery the hourly sweep makes per project."""
    first = await _project(db_session)
    second = await _project(db_session, quote_id="EST2")
    first_id, second_id = first.id, second.id

    async def get_invoice_raw(db, invoice_id):
        if invoice_id == "INV1":
            raise ZohoUpstreamError("books is grumpy")
        return {"estimate_id": "EST2"}

    _fake_books(
        monkeypatch,
        [
            _row(id="INV1", reference_number=f"AITO-{first_id}"),
            _row(id="INV2", reference_number=f"AITO-{second_id}"),
        ],
    )
    monkeypatch.setattr(zoho_service, "get_invoice_raw", get_invoice_raw)

    assert await poll_invoices(db_session) == 1

    db_session.expire_all()
    assert (await db_session.get(AitoProject, second_id)).quote_invoiced is True
    assert (await db_session.get(AitoProject, first_id)).quote_invoiced is False


@pytest.mark.asyncio
async def test_the_watermark_never_advances_past_a_failed_invoice(db_session, monkeypatch):
    """Otherwise the per-invoice recovery above is a lie: the failing row
    would fall out of the next window and never be retried."""
    first = await _project(db_session)
    second = await _project(db_session, quote_id="EST2")
    first_id, second_id = first.id, second.id
    failed_at = "2026-09-20T08:00:00-1000"

    async def get_invoice_raw(db, invoice_id):
        if invoice_id == "INV1":
            raise ZohoUpstreamError("books is grumpy")
        return {"estimate_id": "EST2"}

    _fake_books(
        monkeypatch,
        [
            _row(id="INV2", reference_number=f"AITO-{second_id}", last_modified_time="2026-09-21T09:18:07-1000"),
            _row(id="INV1", reference_number=f"AITO-{first_id}", last_modified_time=failed_at),
        ],
    )
    monkeypatch.setattr(zoho_service, "get_invoice_raw", get_invoice_raw)

    await poll_invoices(db_session)

    stored = await get_setting(db_session, POLL_SINCE_SETTING)
    expected = datetime.strptime(failed_at, "%Y-%m-%dT%H:%M:%S%z").astimezone(timezone.utc) - timedelta(
        seconds=aito_invoice_poll.OVERLAP_SECONDS
    )
    assert stored == expected.strftime("%Y-%m-%dT%H:%M:%S%z")


@pytest.mark.asyncio
async def test_an_invoice_for_another_customer_is_skipped(db_session, monkeypatch):
    """A stale AITO- reference — a card duplicated in Books, typically. Books
    resolved nothing here, so the customer is the only cross-check there is."""
    project = await _project(db_session, client_id="z1")
    pid = project.id
    _fake_books(monkeypatch, [_row(reference_number=f"AITO-{pid}", customer_id="SOMEONE-ELSE")])

    assert await poll_invoices(db_session) == 0

    db_session.expire_all()
    assert (await db_session.get(AitoProject, pid)).quote_invoiced is False


@pytest.mark.asyncio
async def test_a_trashed_project_is_not_adopted(db_session, monkeypatch):
    project = await _project(db_session, status="deleted")
    pid = project.id
    _fake_books(monkeypatch, [_row(reference_number=f"AITO-{pid}")])

    assert await poll_invoices(db_session) == 0

    db_session.expire_all()
    assert (await db_session.get(AitoProject, pid)).quote_invoiced is False


@pytest.mark.asyncio
async def test_a_malformed_balance_leaves_the_row_untouched(db_session, monkeypatch):
    project = await _project(db_session)
    pid = project.id
    _fake_books(monkeypatch, [_row(reference_number=f"AITO-{pid}", balance="not a number")])

    assert await poll_invoices(db_session) == 0

    db_session.expire_all()
    row = await db_session.get(AitoProject, pid)
    assert (row.quote_invoiced, row.invoice_status) == (False, None)
