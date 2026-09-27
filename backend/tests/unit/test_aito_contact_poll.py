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
from backend.app.services.zoho import ZohoRateLimited, ZohoUpstreamError, zoho_service


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
                "sort_order": "D",
                "per_page": "200",
                "page": "1",
            },
        )
    ]
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
