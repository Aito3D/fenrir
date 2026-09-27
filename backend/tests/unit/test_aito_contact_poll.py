"""The contact poll: cards follow a contact renamed directly in Zoho Books.

A card stores the client's name as a snapshot taken when the contact was
attached. The panel's client editor keeps that snapshot fresh for edits made
HERE; an edit made in Books itself never reached the board, so the card
showed the old name and the picker (which searches Books live) could no
longer find it. This pass asks Books once a tick which customer contacts
changed and re-snapshots the name on every active card of each one.
"""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from backend.app.api.routes.settings import get_setting, set_setting
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.services import aito_contact_poll
from backend.app.services.aito_contact_poll import POLL_SINCE_SETTING, poll_contacts
from backend.app.services.zoho import ModifiedSinceRows, ZohoRateLimited, ZohoUpstreamError, zoho_service


def _row(**fields) -> dict:
    base = {
        "id": "z1",
        "name": "Damien Ritter",
        "company_name": "",
        "customer_sub_type": "individual",
        "phone": "",
        "mobile": "",
        "email": "",
        "first_name": "Damien",
        "last_name": "Ritter",
        "last_modified_time": "2026-09-23T08:34:29-1000",
    }
    base.update(fields)
    return base


async def _project(db, **fields) -> AitoProject:
    base = {
        "description": "x",
        "board_column": "todo",
        "position": 0,
        "status": "active",
        "client_id": "z1",
        "client_name": "Dam DH",
        "quote_sync_state": "idle",
    }
    base.update(fields)
    row = AitoProject(**base)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


def _fake_books(monkeypatch, rows, *, calls=None):
    calls = calls if calls is not None else []

    async def list_contacts_modified_since(db, since):
        calls.append(("list", since))
        if isinstance(rows, Exception):
            raise rows
        return list(rows)

    monkeypatch.setattr(zoho_service, "list_contacts_modified_since", list_contacts_modified_since)
    return calls


async def _events(db, project_id: int, kind: str) -> list[AitoEvent]:
    stmt = select(AitoEvent).where(AitoEvent.project_id == project_id, AitoEvent.kind == kind)
    return list((await db.execute(stmt)).scalars().all())


@pytest.mark.asyncio
async def test_the_listing_asks_books_for_customers_changed_since_the_watermark(monkeypatch):
    calls: list = []

    async def request(db, method, path, *, params=None, json=None):
        calls.append((method, path, params))
        return {
            "contacts": [
                {
                    "contact_id": "C1",
                    "contact_name": "Damien Ritter",
                    "contact_type": "customer",
                    "customer_sub_type": "individual",
                    "first_name": "Damien",
                    "last_name": "Ritter",
                    "last_modified_time": "2026-09-23T08:34:29-1000",
                },
                # A vendor sharing the window is not a client and is dropped,
                # exactly as the picker's search drops vendors.
                {
                    "contact_id": "V1",
                    "contact_name": "Some Supplier",
                    "contact_type": "vendor",
                    "last_modified_time": "2026-09-23T08:35:00-1000",
                },
            ],
            "page_context": {"has_more_page": False},
        }

    monkeypatch.setattr(zoho_service, "_request", request)

    rows = await zoho_service.list_contacts_modified_since(None, "2026-09-20T10:00:00+0000")

    assert calls == [
        (
            "GET",
            "/contacts",
            {
                "last_modified_time": "2026-09-20T10:00:00+0000",
                "sort_column": "last_modified_time",
                "sort_order": "A",
                "per_page": "200",
                "page": "1",
            },
        )
    ]
    assert rows.truncated is False
    assert [r["id"] for r in rows] == ["C1"]
    assert rows[0]["name"] == "Damien Ritter"
    assert rows[0]["last_modified_time"] == "2026-09-23T08:34:29-1000"


@pytest.mark.asyncio
async def test_the_listing_paginates_but_not_forever(monkeypatch):
    pages: list[str] = []

    async def request(db, method, path, *, params=None, json=None):
        pages.append(params["page"])
        return {
            "contacts": [{"contact_id": params["page"], "contact_name": "x", "contact_type": "customer"}],
            "page_context": {"has_more_page": True},
        }

    monkeypatch.setattr(zoho_service, "_request", request)

    rows = await zoho_service.list_contacts_modified_since(None, "2026-09-20T10:00:00+0000")

    assert len(rows) == len(pages) == aito_contact_poll_pages()
    # Stopped at the cap with Books still offering more: the poll must know.
    assert rows.truncated is True


@pytest.mark.asyncio
async def test_a_window_that_ends_exactly_on_the_cap_is_not_truncated(monkeypatch):
    async def request(db, method, path, *, params=None, json=None):
        last = params["page"] == str(aito_contact_poll_pages())
        return {
            "contacts": [{"contact_id": params["page"], "contact_name": "x", "contact_type": "customer"}],
            "page_context": {"has_more_page": not last},
        }

    monkeypatch.setattr(zoho_service, "_request", request)

    rows = await zoho_service.list_contacts_modified_since(None, "2026-09-20T10:00:00+0000")

    assert len(rows) == aito_contact_poll_pages()
    assert rows.truncated is False


def aito_contact_poll_pages() -> int:
    from backend.app.services.zoho import _MAX_CONTACT_PAGES

    return _MAX_CONTACT_PAGES


@pytest.mark.asyncio
async def test_a_contact_renamed_in_books_renames_every_active_card_on_it(db_session, monkeypatch):
    first = await _project(db_session)
    sibling = await _project(db_session, description="y", position=1)
    other_client = await _project(db_session, client_id="z2", client_name="Someone ELSE")
    trashed = await _project(db_session, status="trashed")
    _fake_books(monkeypatch, [_row()])

    assert await poll_contacts(db_session) == 2

    for row in (first, sibling, other_client, trashed):
        await db_session.refresh(row)
    assert first.client_name == "Damien Ritter"
    assert sibling.client_name == "Damien Ritter"
    assert other_client.client_name == "Someone ELSE"
    assert trashed.client_name == "Dam DH"

    events = await _events(db_session, first.id, "project.updated")
    assert len(events) == 1
    assert events[0].actor_class == "system"
    assert events[0].changes == [{"field": "client_name", "from": "Dam DH", "to": "Damien Ritter"}]
    assert len(await _events(db_session, sibling.id, "project.updated")) == 1
    assert await _events(db_session, other_client.id, "project.updated") == []


@pytest.mark.asyncio
async def test_an_unchanged_name_writes_nothing(db_session, monkeypatch):
    project = await _project(db_session, client_name="Damien Ritter")
    _fake_books(monkeypatch, [_row()])

    assert await poll_contacts(db_session) == 0

    assert await _events(db_session, project.id, "project.updated") == []


@pytest.mark.asyncio
async def test_a_blank_books_name_never_blanks_the_card(db_session, monkeypatch):
    project = await _project(db_session)
    _fake_books(monkeypatch, [_row(name="")])

    assert await poll_contacts(db_session) == 0

    await db_session.refresh(project)
    assert project.client_name == "Dam DH"


@pytest.mark.asyncio
async def test_the_walk_in_contact_is_never_fanned_out(db_session, monkeypatch):
    await set_setting(db_session, "zoho_default_contact_id", "WALKIN")
    await db_session.commit()
    project = await _project(db_session, client_id="WALKIN", client_name="Jane PASSER-BY")
    _fake_books(monkeypatch, [_row(id="WALKIN", name="Client de passage")])

    assert await poll_contacts(db_session) == 0

    await db_session.refresh(project)
    assert project.client_name == "Jane PASSER-BY"


@pytest.mark.asyncio
async def test_the_board_is_told_about_each_renamed_card(db_session, monkeypatch):
    project = await _project(db_session)
    _fake_books(monkeypatch, [_row()])
    sent: list[dict] = []

    async def broadcast_aito(message):
        sent.append(message)

    monkeypatch.setattr(aito_contact_poll.ws_manager, "broadcast_aito", broadcast_aito)

    await poll_contacts(db_session)

    assert sent == [{"type": "aito_changed", "action": "contact-poll", "project_id": project.id, "actor": None}]


@pytest.mark.asyncio
async def test_first_pass_opens_the_backfill_window(db_session, monkeypatch):
    calls = _fake_books(monkeypatch, [])
    before = datetime.now(timezone.utc)

    await poll_contacts(db_session)

    (_, since), *_ = calls
    moment = datetime.strptime(since, "%Y-%m-%dT%H:%M:%S%z")
    expected = before - timedelta(days=aito_contact_poll.BACKFILL_DAYS)
    assert abs((moment - expected).total_seconds()) < 5


@pytest.mark.asyncio
async def test_the_watermark_follows_the_newest_row_minus_the_overlap(db_session, monkeypatch):
    _fake_books(
        monkeypatch,
        [
            _row(id="a", last_modified_time="2026-09-23T08:34:29-1000"),
            _row(id="b", last_modified_time="2026-09-23T10:00:00-1000"),
        ],
    )

    await poll_contacts(db_session)

    stored = await get_setting(db_session, POLL_SINCE_SETTING)
    newest = datetime.strptime("2026-09-23T10:00:00-1000", "%Y-%m-%dT%H:%M:%S%z")
    assert datetime.strptime(stored, "%Y-%m-%dT%H:%M:%S%z") == newest - timedelta(
        seconds=aito_contact_poll.OVERLAP_SECONDS
    )


@pytest.mark.asyncio
async def test_a_stored_watermark_is_what_the_next_pass_asks_for(db_session, monkeypatch):
    await set_setting(db_session, POLL_SINCE_SETTING, "2026-09-22T00:00:00+0000")
    await db_session.commit()
    calls = _fake_books(monkeypatch, [])

    await poll_contacts(db_session)

    assert calls == [("list", "2026-09-22T00:00:00+0000")]


@pytest.mark.asyncio
async def test_a_rate_limit_propagates_and_leaves_the_watermark_alone(db_session, monkeypatch):
    await set_setting(db_session, POLL_SINCE_SETTING, "2026-09-22T00:00:00+0000")
    await db_session.commit()
    _fake_books(monkeypatch, ZohoRateLimited("slow down", retry_after=30))

    with pytest.raises(ZohoRateLimited):
        await poll_contacts(db_session)

    assert await get_setting(db_session, POLL_SINCE_SETTING) == "2026-09-22T00:00:00+0000"


@pytest.mark.asyncio
async def test_an_outage_leaves_the_watermark_alone(db_session, monkeypatch):
    await set_setting(db_session, POLL_SINCE_SETTING, "2026-09-22T00:00:00+0000")
    await db_session.commit()
    _fake_books(monkeypatch, ZohoUpstreamError("Books unreachable"))

    with pytest.raises(ZohoUpstreamError):
        await poll_contacts(db_session)

    assert await get_setting(db_session, POLL_SINCE_SETTING) == "2026-09-22T00:00:00+0000"


@pytest.mark.asyncio
async def test_a_row_that_fails_holds_the_watermark_so_it_is_retried(db_session, monkeypatch):
    await _project(db_session)
    _fake_books(
        monkeypatch,
        [
            _row(id="z1", last_modified_time="2026-09-23T08:00:00-1000"),
            _row(id="z9", last_modified_time="2026-09-23T10:00:00-1000"),
        ],
    )
    real_commit = db_session.commit
    failed = False

    async def flaky_commit():
        nonlocal failed
        if not failed:
            failed = True
            raise __import__("sqlalchemy").exc.OperationalError("commit", {}, Exception("database is locked"))
        await real_commit()

    monkeypatch.setattr(db_session, "commit", flaky_commit)

    assert await poll_contacts(db_session) == 0

    stored = await get_setting(db_session, POLL_SINCE_SETTING)
    held = datetime.strptime("2026-09-23T08:00:00-1000", "%Y-%m-%dT%H:%M:%S%z")
    assert datetime.strptime(stored, "%Y-%m-%dT%H:%M:%S%z") == held - timedelta(
        seconds=aito_contact_poll.OVERLAP_SECONDS
    )


def _capped_books(monkeypatch, rows: list[dict], cap: int, calls: list) -> None:
    """A Books that honours ``since`` and caps a pass at ``cap`` rows, oldest
    first, flagging the pass truncated when rows remain."""

    async def list_contacts_modified_since(db, since):
        calls.append(("list", since))
        floor = aito_contact_poll._parse_books_time(since)
        window = sorted(
            (r for r in rows if aito_contact_poll._parse_books_time(r["last_modified_time"]) >= floor),
            key=lambda r: aito_contact_poll._parse_books_time(r["last_modified_time"]),
        )
        page = ModifiedSinceRows(window[:cap])
        page.truncated = len(window) > cap
        return page

    monkeypatch.setattr(zoho_service, "list_contacts_modified_since", list_contacts_modified_since)


@pytest.mark.asyncio
async def test_a_rename_batch_wider_than_the_cap_is_walked_across_passes_and_skips_nothing(db_session, monkeypatch):
    """T-055: a pass the page cap cuts short resumes at the last row it read.

    Twelve contacts renamed inside one minute, five a pass — a Books bulk
    edit in miniature. A run of four equal timestamps straddles the first
    cut-off, and the whole batch is narrower than the five-minute overlap,
    so a pass that rewound the usual overlap would re-read the same five
    rows forever.
    """
    base = datetime(2026, 9, 23, 9, 0, 0, tzinfo=timezone.utc)
    offsets = [0, 10, 20, 30, 30, 30, 30, 40, 50, 60, 70, 80]
    pids = []
    for i in range(len(offsets)):
        pids.append((await _project(db_session, client_id=f"c{i}", client_name=f"Old {i}")).id)
    stamps = [(base + timedelta(seconds=o)).strftime("%Y-%m-%dT%H:%M:%S%z") for o in offsets]
    rows = [_row(id=f"c{i}", name=f"New {i}", last_modified_time=stamp) for i, stamp in enumerate(stamps)]
    await set_setting(db_session, POLL_SINCE_SETTING, (base - timedelta(days=200)).strftime("%Y-%m-%dT%H:%M:%S%z"))
    await db_session.commit()
    calls: list = []
    _capped_books(monkeypatch, rows, 5, calls)

    assert await poll_contacts(db_session) == 5
    # The fifth row read (a tie) is the resume point, rewound one second so
    # its unread twins come back on the next pass.
    assert await get_setting(db_session, POLL_SINCE_SETTING) == (base + timedelta(seconds=29)).strftime(
        "%Y-%m-%dT%H:%M:%S%z"
    )

    passes = 1
    while passes < 10:
        await poll_contacts(db_session)
        passes += 1
        if calls[-1][1] == await get_setting(db_session, POLL_SINCE_SETTING):
            break
    # Finite: the batch was walked, not re-read in a loop.
    assert passes < 10

    db_session.expire_all()
    for i, pid in enumerate(pids):
        assert (await db_session.get(AitoProject, pid)).client_name == f"New {i}"
        # Re-reading the tie rows at the seam renamed nothing twice.
        assert len(await _events(db_session, pid, "project.updated")) == 1
    # Caught up, the watermark settles where the last capped pass left it:
    # the overlap never reaches back into the walked batch.
    settled = await get_setting(db_session, POLL_SINCE_SETTING)
    assert settled == (base + timedelta(seconds=39)).strftime("%Y-%m-%dT%H:%M:%S%z")
    await poll_contacts(db_session)
    assert await get_setting(db_session, POLL_SINCE_SETTING) == settled


@pytest.mark.asyncio
async def test_a_poison_contact_holds_the_watermark_open_forever_across_many_passes(db_session, monkeypatch, caplog):
    """CHARACTERIZATION ONLY (T-049) — this pins today's behaviour, it does
    not assert a requirement.

    Unlike its sibling `aito_invoice_poll.poll_invoices` (which caps
    consecutive per-row failures at `MAX_ADOPT_FAILURES = 3`, then lets the
    poison row go and advances the watermark past it — see
    `test_a_poison_invoice_stops_holding_the_watermark_after_three_passes`),
    `poll_contacts` has NO analogous cap. A contact that fails adoption on
    *every* pass holds `POLL_SINCE_SETTING` pinned at its own timestamp
    forever: the `since` sent to Books never advances past it, the poison
    contact is retried every single tick with no backoff or give-up, and the
    log says the same thing at the same WARNING level on every pass — there
    is no once-at-ERROR-then-quiet escalation like the invoice poll's. Over
    real time this means the rescan window Books is asked to replay from
    only grows, forever, exactly the risk the invoice poll's docstring
    describes as the reason it added a cap. Whether `poll_contacts` also
    needs one is a decision for a human, not this test — it only makes the
    current behaviour a checked fact instead of an assumption."""
    good = await _project(db_session, client_id="zgood", client_name="Old Name")
    real_rename = aito_contact_poll._rename_cards
    poison_attempts: list[str] = []

    async def flaky_rename(db, contact_id, name):
        if contact_id == "zpoison":
            poison_attempts.append(contact_id)
            raise SQLAlchemyError("books forgot how to spell this contact")
        return await real_rename(db, contact_id, name)

    monkeypatch.setattr(aito_contact_poll, "_rename_cards", flaky_rename)

    poison_time = "2026-09-23T08:00:00-1000"
    held = datetime.strptime(poison_time, "%Y-%m-%dT%H:%M:%S%z") - timedelta(seconds=aito_contact_poll.OVERLAP_SECONDS)
    held_str = held.strftime("%Y-%m-%dT%H:%M:%S%z")
    # Seed the watermark at the value the poison row is about to keep
    # re-producing, so every pass (including the first) asks Books for the
    # exact same window — the clearest way to show it never moves.
    await set_setting(db_session, POLL_SINCE_SETTING, held_str)
    await db_session.commit()

    since_calls: list[datetime] = []
    for i in range(5):
        calls = _fake_books(
            monkeypatch,
            [
                _row(id="zpoison", name="Poison Co", last_modified_time=poison_time),
                _row(id="zgood", name="New Name", last_modified_time=f"2026-09-2{4 + i}T10:00:00-1000"),
            ],
        )
        caplog.clear()
        with caplog.at_level("WARNING", logger="backend.app.services.aito_contact_poll"):
            await poll_contacts(db_session)
        since_calls.append(datetime.strptime(calls[0][1], "%Y-%m-%dT%H:%M:%S%z"))
        stored = await get_setting(db_session, POLL_SINCE_SETTING)
        # Persisted in whatever offset `_format_books_time` chooses (UTC), so
        # compare the moment, not the string — the watermark is pinned to
        # the SAME instant every pass either way.
        assert datetime.strptime(stored, "%Y-%m-%dT%H:%M:%S%z") == held
        warnings = [r for r in caplog.records if r.levelname == "WARNING"]
        assert len(warnings) == 1
        assert "zpoison" in warnings[0].getMessage()
        assert len(poison_attempts) == i + 1

    # The good contact still renamed (on the pass its name actually
    # changed) — the poison row blocks nobody else's card, only the window.
    await db_session.refresh(good)
    assert good.client_name == "New Name"
    # Every pass asked Books for the identical "since": the poison row never
    # lets the watermark advance, across 5 consecutive ticks.
    assert since_calls == [held] * 5
