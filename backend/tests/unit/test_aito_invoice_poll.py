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
from backend.app.services.zoho import ModifiedSinceRows, ZohoRateLimited, ZohoUpstreamError, zoho_service


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


@pytest.fixture(autouse=True)
def _forget_adopt_failures():
    """The consecutive-failure counts live in a module dict (T-013), so a
    file whose tests fail the same invoice id twice would carry the count
    into the next one. Empty it around every test."""
    aito_invoice_poll._reset_adopt_failures()
    yield
    aito_invoice_poll._reset_adopt_failures()


@pytest.mark.asyncio
async def test_the_listing_asks_books_for_one_oldest_first_window(monkeypatch):
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
                "sort_order": "A",
                "per_page": "200",
                "page": "1",
            },
        )
    ]
    # Books said there was nothing more: the whole window was read.
    assert rows.truncated is False
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
    # Stopped at the cap with Books still offering more: the poll must know.
    assert rows.truncated is True


@pytest.mark.asyncio
async def test_a_window_that_ends_exactly_on_the_cap_is_not_truncated(monkeypatch):
    async def request(db, method, path, *, params=None, json=None):
        last = params["page"] == "10"
        return {"invoices": [{"invoice_id": params["page"]}], "page_context": {"has_more_page": not last}}

    monkeypatch.setattr(zoho_service, "_request", request)

    rows = await zoho_service.list_invoices_modified_since(None, "2020-01-01T00:00:00+0000")

    assert len(rows) == 10
    assert rows.truncated is False


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


def _capped_books(monkeypatch, rows: list[dict], cap: int, calls: list) -> None:
    """A Books that honours ``since`` and caps a pass at ``cap`` rows, oldest
    first, flagging the pass truncated when rows remain — the listing's real
    contract, at a size a test can afford."""

    async def list_invoices_modified_since(db, since):
        calls.append(("list", since))
        floor = aito_invoice_poll._parse_books_time(since)
        window = sorted(
            (r for r in rows if aito_invoice_poll._parse_books_time(r["last_modified_time"]) >= floor),
            key=lambda r: aito_invoice_poll._parse_books_time(r["last_modified_time"]),
        )
        page = ModifiedSinceRows(window[:cap])
        page.truncated = len(window) > cap
        return page

    monkeypatch.setattr(zoho_service, "list_invoices_modified_since", list_invoices_modified_since)


@pytest.mark.asyncio
async def test_a_window_wider_than_the_cap_is_walked_across_passes_and_skips_nothing(db_session, monkeypatch):
    """T-054: a pass the page cap cuts short resumes at the last row it read.

    Twelve changes inside one minute, five a pass — a Books bulk update in
    miniature. A run of four equal timestamps straddles the first cut-off,
    and the whole window is narrower than the five-minute overlap, so a pass
    that rewound the usual overlap would re-read the same five rows forever.
    """
    base = datetime(2026, 9, 21, 9, 0, 0, tzinfo=timezone.utc)
    offsets = [0, 10, 20, 30, 30, 30, 30, 40, 50, 60, 70, 80]
    projects = [await _project(db_session) for _ in offsets]
    pids = [p.id for p in projects]
    stamps = [(base + timedelta(seconds=o)).strftime("%Y-%m-%dT%H:%M:%S%z") for o in offsets]
    rows = [
        _row(id=f"INV{i}", number=f"FA-{i}", reference_number=f"AITO-{pid}", last_modified_time=stamp)
        for i, (pid, stamp) in enumerate(zip(pids, stamps, strict=True))
    ]
    calls = _fake_books(monkeypatch, [])
    await set_setting(db_session, POLL_SINCE_SETTING, (base - timedelta(days=200)).strftime("%Y-%m-%dT%H:%M:%S%z"))
    await db_session.commit()
    _capped_books(monkeypatch, rows, 5, calls)

    assert await poll_invoices(db_session) == 5
    # The fifth row read (a tie) is the resume point, rewound one second so
    # its unread twins come back on the next pass.
    first_mark = await get_setting(db_session, POLL_SINCE_SETTING)
    assert first_mark == (base + timedelta(seconds=29)).strftime("%Y-%m-%dT%H:%M:%S%z")

    passes = 1
    while passes < 10:
        await poll_invoices(db_session)
        passes += 1
        if [c for c in calls if c[0] == "list"][-1][1] == await get_setting(db_session, POLL_SINCE_SETTING):
            break
    # Finite: the window was walked, not re-read in a loop.
    assert passes < 10

    db_session.expire_all()
    for pid in pids:
        assert (await db_session.get(AitoProject, pid)).quote_invoiced is True, pid
        # Re-reading the tie rows at the seam adopted nothing twice.
        assert len(await _events(db_session, pid, "invoice.detected")) == 1
    # Once caught up the watermark settles on where the last capped pass
    # left it: the overlap never reaches back into the walked window, which
    # would start the walk over.
    settled = await get_setting(db_session, POLL_SINCE_SETTING)
    assert settled == (base + timedelta(seconds=39)).strftime("%Y-%m-%dT%H:%M:%S%z")
    await poll_invoices(db_session)
    assert await get_setting(db_session, POLL_SINCE_SETTING) == settled


@pytest.mark.asyncio
async def test_a_truncated_pass_still_holds_the_watermark_at_a_failed_invoice(db_session, monkeypatch):
    """The failure hold wins over the resume point, exactly as it wins over
    the newest row on an untruncated pass."""
    await set_setting(db_session, POLL_SINCE_SETTING, "2026-09-01T00:00:00+0000")
    await db_session.commit()
    failing = await _project(db_session)
    fine = await _project(db_session)
    rows = ModifiedSinceRows(
        [
            _row(id="INV1", reference_number=f"AITO-{failing.id}", last_modified_time="2026-09-21T09:00:00+0000"),
            _row(id="INV2", reference_number=f"AITO-{fine.id}", last_modified_time="2026-09-21T09:30:00+0000"),
        ]
    )
    rows.truncated = True
    _fake_books(monkeypatch, [])

    async def list_invoices_modified_since(db, since):
        return rows

    monkeypatch.setattr(zoho_service, "list_invoices_modified_since", list_invoices_modified_since)
    real_adopt = aito_invoice_poll._adopt

    async def adopt(db, row, project):
        if row["id"] == "INV1":
            raise ZohoUpstreamError("Books hiccup")
        return await real_adopt(db, row, project)

    monkeypatch.setattr(aito_invoice_poll, "_adopt", adopt)
    await poll_invoices(db_session)

    assert await get_setting(db_session, POLL_SINCE_SETTING) == "2026-09-21T08:59:59+0000"


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


@pytest.mark.asyncio
async def test_a_poison_invoice_stops_holding_the_watermark_after_three_passes(db_session, monkeypatch, caplog):
    """The watermark rewind is a retry budget, not a promise (T-013). An
    invoice Books will never let this pass adopt writes nothing, so
    ``quote_invoiced`` stays False and it is attempted again on every tick
    with the window pinned at its timestamp — which then grows by
    OVERLAP_SECONDS a tick until the poll is re-listing months of the org.
    Three failures and it counts as seen instead."""
    first = await _project(db_session)
    second = await _project(db_session, quote_id="EST2")
    first_id, second_id = first.id, second.id
    failed_at = "2026-09-20T08:00:00-1000"
    newest = "2026-09-21T09:18:07-1000"

    async def get_invoice_raw(db, invoice_id):
        if invoice_id == "INV1":
            raise ZohoUpstreamError("books is grumpy")
        return {"estimate_id": "EST2"}

    def _arm():
        _fake_books(
            monkeypatch,
            [
                _row(id="INV2", reference_number=f"AITO-{second_id}", last_modified_time=newest),
                _row(id="INV1", reference_number=f"AITO-{first_id}", last_modified_time=failed_at),
            ],
        )
        monkeypatch.setattr(zoho_service, "get_invoice_raw", get_invoice_raw)

    def _expected(moment: str) -> str:
        parsed = datetime.strptime(moment, "%Y-%m-%dT%H:%M:%S%z").astimezone(timezone.utc)
        return (parsed - timedelta(seconds=aito_invoice_poll.OVERLAP_SECONDS)).strftime("%Y-%m-%dT%H:%M:%S%z")

    # Passes 1 and 2: the failing row still pins the window open.
    for _ in range(aito_invoice_poll.MAX_ADOPT_FAILURES - 1):
        _arm()
        await poll_invoices(db_session)
        assert await get_setting(db_session, POLL_SINCE_SETTING) == _expected(failed_at)

    # Pass 3 hits the cap: logged once at ERROR, and the window advances to
    # the newest row the pass actually saw.
    _arm()
    with caplog.at_level("ERROR", logger="backend.app.services.aito_invoice_poll"):
        await poll_invoices(db_session)
    assert await get_setting(db_session, POLL_SINCE_SETTING) == _expected(newest)
    errors = [r for r in caplog.records if r.levelname == "ERROR"]
    assert len(errors) == 1
    assert "FA-26-4367" in errors[0].getMessage() and "books is grumpy" in errors[0].getMessage()

    # Pass 4 says nothing more at ERROR and leaves the advanced window alone.
    caplog.clear()
    _arm()
    with caplog.at_level("ERROR", logger="backend.app.services.aito_invoice_poll"):
        await poll_invoices(db_session)
    assert [r for r in caplog.records if r.levelname == "ERROR"] == []
    assert await get_setting(db_session, POLL_SINCE_SETTING) == _expected(newest)

    # The failing card is still untouched — giving up on the rewind is not
    # giving up on correctness.
    db_session.expire_all()
    assert (await db_session.get(AitoProject, first_id)).quote_invoiced is False
    assert (await db_session.get(AitoProject, second_id)).quote_invoiced is True


@pytest.mark.asyncio
async def test_one_success_resets_the_failure_count(db_session, monkeypatch):
    """The budget is CONSECUTIVE failures: a row that comes good has earned
    its full rewind back, so a flapping Books does not exhaust it."""
    project = await _project(db_session)
    pid = project.id
    failed_at = "2026-09-20T08:00:00-1000"
    grumpy = True

    async def get_invoice_raw(db, invoice_id):
        if grumpy:
            raise ZohoUpstreamError("books is grumpy")
        return {"estimate_id": "EST1"}

    def _arm():
        _fake_books(
            monkeypatch,
            [_row(id="INV1", reference_number=f"AITO-{pid}", last_modified_time=failed_at)],
        )
        monkeypatch.setattr(zoho_service, "get_invoice_raw", get_invoice_raw)

    for _ in range(aito_invoice_poll.MAX_ADOPT_FAILURES - 1):
        _arm()
        await poll_invoices(db_session)
    assert aito_invoice_poll._adopt_failures["INV1"] == aito_invoice_poll.MAX_ADOPT_FAILURES - 1

    grumpy = False
    _arm()
    assert await poll_invoices(db_session) == 1
    assert "INV1" not in aito_invoice_poll._adopt_failures

    # And the budget really is full again: the next failure pins the
    # watermark rather than being the one that gives up. (A malformed figure
    # this time — the link repair is attempted on first adoption only, so the
    # now-invoiced card can no longer fail that way.)
    await set_setting(db_session, POLL_SINCE_SETTING, "2026-09-01T00:00:00+0000")
    await db_session.commit()
    _fake_books(
        monkeypatch,
        [_row(id="INV1", reference_number=f"AITO-{pid}", last_modified_time=failed_at, balance="not a number")],
    )
    await poll_invoices(db_session)
    assert aito_invoice_poll._adopt_failures["INV1"] == 1
    expected = datetime.strptime(failed_at, "%Y-%m-%dT%H:%M:%S%z").astimezone(timezone.utc) - timedelta(
        seconds=aito_invoice_poll.OVERLAP_SECONDS
    )
    assert await get_setting(db_session, POLL_SINCE_SETTING) == expected.strftime("%Y-%m-%dT%H:%M:%S%z")


@pytest.mark.asyncio
async def test_a_rate_limit_spends_no_failure_budget(db_session, monkeypatch):
    """A 429 is the org being throttled, not this invoice being broken: the
    row was never judged, so it must not lose a retry."""
    project = await _project(db_session)
    pid = project.id

    async def get_invoice_raw(db, invoice_id):
        raise ZohoRateLimited("429")

    _fake_books(monkeypatch, [_row(id="INV1", reference_number=f"AITO-{pid}")])
    monkeypatch.setattr(zoho_service, "get_invoice_raw", get_invoice_raw)

    with pytest.raises(ZohoRateLimited):
        await poll_invoices(db_session)

    assert aito_invoice_poll._adopt_failures == {}


@pytest.mark.asyncio
async def test_an_invoice_with_no_id_or_number_still_counts_without_crashing(db_session, monkeypatch):
    """The counter is keyed on the Books id, then the number; a row carrying
    neither lands in one shared bucket rather than blowing up the pass or
    growing an unbounded dict of empty-string keys."""
    project = await _project(db_session)
    pid = project.id
    _fake_books(
        monkeypatch,
        [_row(id="", number="", reference_number=f"AITO-{pid}", balance="not a number")],
    )

    assert await poll_invoices(db_session) == 0
    assert aito_invoice_poll._adopt_failures == {"__no_id__": 1}


@pytest.mark.asyncio
async def test_a_count_is_dropped_once_its_invoice_leaves_the_window(db_session, monkeypatch):
    """An invoice Books has not touched since cannot be retried anyway, so
    holding its count forever would only leak memory — and if Books does
    touch it again it comes back with a fresh timestamp and a fresh budget."""
    project = await _project(db_session)
    pid = project.id

    async def get_invoice_raw(db, invoice_id):
        raise ZohoUpstreamError("books is grumpy")

    _fake_books(monkeypatch, [_row(id="INV1", reference_number=f"AITO-{pid}")])
    monkeypatch.setattr(zoho_service, "get_invoice_raw", get_invoice_raw)
    await poll_invoices(db_session)
    assert aito_invoice_poll._adopt_failures == {"INV1": 1}

    _fake_books(monkeypatch, [])
    await poll_invoices(db_session)
    assert aito_invoice_poll._adopt_failures == {}
