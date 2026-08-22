"""The Finish column's "client has been told to come and collect" mark.

Three separate promises are pinned here, and they fail in different ways:

1. The mark itself — its own route, idempotent, and (like `flag`) invisible to
   Zoho, which has no field for it.
2. The GATE — a project cannot reach Done until the client has been told. This
   is the reason the mark exists at all, and the reason it lives on the server:
   the board card and the detail panel both offer the Finish -> Done
   transition, and a check that lived only in the buttons would be bypassed by
   a drag.
3. The AUTO-CLEAR — work reappearing on a finished project (a task added, a
   step re-opened) sends the card back to a production column AND retracts the
   contact, because what the client was told is no longer true. `_apply_rules`
   is the single place the rules relocate a card, so it is the single place
   this can be enforced.
"""

import pytest
from sqlalchemy import select, update

from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject


async def _create(client, **overrides):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+33 6 12 34 56 78",
    }
    payload.update(overrides)
    return await client.post("/api/v1/aito/", json=payload)


async def _create_accepted(client, **overrides):
    """A hand-made card accepted through the dedicated route, which lands it —
    with no tasks — unlocked in `finish`. Same helper shape as
    test_aito_routes.py's."""
    created = (await _create(client, **overrides)).json()
    accepted = await client.post(f"/api/v1/aito/{created['id']}/quote-status", json={"status": "accepted"})
    return accepted.json()["project"]


async def _kinds(db_session, project_id: int) -> list[str]:
    rows = (
        (
            await db_session.execute(
                select(AitoEvent.kind).where(AitoEvent.project_id == project_id).order_by(AitoEvent.id)
            )
        )
        .scalars()
        .all()
    )
    return list(rows)


async def _last_cleared(db_session, project_id: int) -> AitoEvent | None:
    """The most recent "contact taken back" row, whoever took it back."""
    return (
        (
            await db_session.execute(
                select(AitoEvent)
                .where(AitoEvent.project_id == project_id, AitoEvent.kind == "project.contacted.cleared")
                .order_by(AitoEvent.id.desc())
            )
        )
        .scalars()
        .first()
    )


@pytest.mark.asyncio
async def test_a_finished_card_starts_with_no_contact_recorded(async_client):
    """The mark is opt-in. Nobody has phoned anyone yet."""
    p = await _create_accepted(async_client)

    assert p["column"] == "finish"
    assert p["client_contacted_at"] is None


@pytest.mark.asyncio
async def test_marking_contacted_stamps_the_time(async_client):
    p = await _create_accepted(async_client)

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    assert r.status_code == 200
    assert r.json()["client_contacted_at"] is not None


@pytest.mark.asyncio
async def test_the_contact_can_be_taken_back(async_client):
    """Marked by hand, cleared by hand — the same symmetry the board flags
    have. Someone who ticks the wrong card must be able to undo it, and the
    card returning to "to be contacted" is what re-closes the Done gate."""
    p = await _create_accepted(async_client)
    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": False})

    assert r.status_code == 200
    assert r.json()["client_contacted_at"] is None


@pytest.mark.asyncio
async def test_re_marking_an_already_contacted_client_does_not_restamp_the_time(async_client):
    """Idempotency that matters for more than timeline noise: the card shows
    how long the client has been waiting on that call, so a second tap must
    not silently reset that clock back to zero."""
    p = await _create_accepted(async_client)
    first = (await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})).json()[
        "client_contacted_at"
    ]

    again = await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    assert again.status_code == 200
    assert again.json()["client_contacted_at"] == first


@pytest.mark.asyncio
async def test_marking_contacted_is_refused_while_the_work_is_unfinished(async_client):
    """ "Come and collect it" is not a statement anyone can make about a job
    still on a printer — and allowing it early would pre-open the Done gate on
    work that is not finished."""
    p = await _create_accepted(async_client)
    await async_client.post(f"/api/v1/aito/{p['id']}/tasks", json={"impression_cost": 2400.0})

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    assert r.status_code == 409


@pytest.mark.asyncio
async def test_finishing_a_project_is_refused_until_the_client_is_told(async_client):
    """The whole point of the mark. Archiving a job the client has never been
    told about is how a finished print sits on a shelf for a month."""
    p = await _create_accepted(async_client)

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "done", "position": 0})

    assert r.status_code == 409
    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p["id"]]["column"] == "finish", "the refused move must leave the card where it was"


@pytest.mark.asyncio
async def test_finishing_a_project_is_allowed_once_the_client_is_told(async_client):
    p = await _create_accepted(async_client)
    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "done", "position": 0})

    assert r.status_code == 200
    assert r.json()["column"] == "done"


@pytest.mark.asyncio
async def test_a_legacy_archived_card_can_still_be_pulled_back_out_of_done(async_client):
    """The gate is one-directional. Every project archived before this feature
    existed has no contact recorded and never will — gating Done -> Finish on
    it too would strand all of them in the archive."""
    p = await _create_accepted(async_client)
    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})
    await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "done", "position": 0})
    # Forget the contact, exactly as a pre-feature row reads.
    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": False})

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "finish", "position": 0})

    assert r.status_code == 200
    assert r.json()["column"] == "finish"


@pytest.mark.asyncio
async def test_adding_a_task_to_a_finished_project_retracts_the_contact(async_client):
    """New work means what the client was told is no longer true, so they have
    to be told again before the job can be closed a second time."""
    p = await _create_accepted(async_client)
    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    await async_client.post(f"/api/v1/aito/{p['id']}/tasks", json={"impression_cost": 2400.0})

    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p["id"]]["column"] == "print"
    assert board[p["id"]]["client_contacted_at"] is None


@pytest.mark.asyncio
async def test_unticking_a_step_on_a_finished_project_retracts_the_contact(async_client):
    """The other way work reappears. Same rule, different door."""
    p = await _create_accepted(async_client)
    t = (await async_client.post(f"/api/v1/aito/{p['id']}/tasks", json={"scan_cost": 1200.0})).json()
    await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_done": True})
    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_done": False})

    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p["id"]]["column"] == "scan"
    assert board[p["id"]]["client_contacted_at"] is None


@pytest.mark.asyncio
async def test_archiving_a_project_keeps_the_contact(async_client):
    """Finish <-> Done is the one move that changes nothing about the work, so
    it must not retract anything. If it did, a card dragged to Done and back
    would demand a second phone call for no reason."""
    p = await _create_accepted(async_client)
    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "done", "position": 0})

    assert r.json()["client_contacted_at"] is not None


@pytest.mark.asyncio
async def test_telling_the_client_is_recorded_in_the_history(async_client, db_session):
    p = await _create_accepted(async_client)

    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    assert "project.contacted.set" in await _kinds(db_session, p["id"])


@pytest.mark.asyncio
async def test_taking_the_contact_back_by_hand_is_recorded_without_a_cause(async_client, db_session):
    """A person changing their mind and the board retracting it are different
    facts, and the timeline has to be able to tell them apart — see the
    rule-caused test below, which asserts the other half."""
    p = await _create_accepted(async_client)
    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": False})

    row = await _last_cleared(db_session, p["id"])
    assert row is not None
    assert (row.detail or {}).get("cause") is None


@pytest.mark.asyncio
async def test_a_contact_retracted_by_the_board_says_so(async_client, db_session):
    """The other half. Nobody phoned anyone to undo this — new work did it —
    and the timeline must not read as though a person changed their mind."""
    p = await _create_accepted(async_client)
    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    await async_client.post(f"/api/v1/aito/{p['id']}/tasks", json={"impression_cost": 2400.0})

    row = await _last_cleared(db_session, p["id"])
    assert row is not None
    assert (row.detail or {}).get("cause") == "rule"


@pytest.mark.asyncio
async def test_a_double_tap_records_only_one_event(async_client, db_session):
    p = await _create_accepted(async_client)

    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})
    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    kinds = await _kinds(db_session, p["id"])
    assert kinds.count("project.contacted.set") == 1


@pytest.mark.asyncio
async def test_telling_the_client_never_queues_a_zoho_push(async_client, db_session):
    """Zoho has no field for this. Queueing an estimate push here would carry
    nothing and — the harm that matters — churn `quote_sync_state` on a
    'locked' quote, where writes are already known to be unsafe. Same promise
    `set_project_flag` makes and pins.

    'locked' specifically, and not the state a fresh card happens to be in: a
    just-created project is already 'pending', so asserting the state "did not
    change" on one of those would pass even if this route DID queue a push.
    An earlier version of this test did exactly that and caught nothing.
    """
    p = await _create_accepted(async_client)
    async with db_session.begin_nested():
        await db_session.execute(update(AitoProject).where(AitoProject.id == p["id"]).values(quote_sync_state="locked"))
    await db_session.commit()

    await async_client.patch(f"/api/v1/aito/{p['id']}/contacted", json={"contacted": True})

    db_session.expire_all()
    after = (
        await db_session.execute(select(AitoProject.quote_sync_state).where(AitoProject.id == p["id"]))
    ).scalar_one()
    assert after == "locked", "a purely local mark queued a Zoho push on a locked quote"


def _declared_permissions(route_name: str) -> list[str]:
    """The permission strings a route's auth dependency was built with.

    Read out of the `require_permission_if_auth_enabled` closure rather than
    asserted through an HTTP call, deliberately: `async_client` runs with auth
    DISABLED, so the checker returns None before looking at anything, and
    overriding the dependency to inject a user replaces the very check under
    test. Both roads lead to a 200 whatever the route declares. The closure is
    the only place the declaration is actually observable.
    """
    from backend.app.main import app

    route = next(r for r in app.routes if getattr(r, "name", "") == route_name)
    checker = next(d.call for d in route.dependant.dependencies if d.name == "current_user")
    cells = dict(zip(checker.__code__.co_freevars, checker.__closure__ or (), strict=True))
    return list(cells["perm_strings"].cell_contents)


def test_marking_contacted_is_gated_on_permission_to_edit_the_card():
    """Reuses AITO_UPDATE rather than introducing a permission of its own — a
    new one would need adding to the API-key classification lists and the role
    defaults, and "may edit an Aito card" is the right authority here.

    Pinned because this route is hand-written rather than reached through
    `update_project`, so it is exactly the kind that ships ungated. Compared
    against the flag route, which made the same call for the same reasons: if
    one ever moves, this says so.
    """
    assert _declared_permissions("set_project_contacted") == ["aito:update"]
    assert _declared_permissions("set_project_contacted") == _declared_permissions("set_project_flag")
