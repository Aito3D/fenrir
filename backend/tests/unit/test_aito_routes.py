"""Aito board routes: required client, move reindexing, soft delete, one-shot import."""

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import event, select

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.schemas.aito import AitoProjectImportItem
from backend.app.services.aito_board_rules import SERVICES, summarise
from backend.app.services.zoho import ZohoUpstreamError, zoho_service


async def _create(client, **overrides):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+33 6 12 34 56 78",
    }
    payload.update(overrides)
    return await client.post("/api/v1/aito/", json=payload)


def _seconds_since(created_at: str) -> float:
    """How stale a response's created_at is. The column is naive UTC (its
    server_default is func.now(), i.e. SQLite CURRENT_TIMESTAMP), so `now` is
    made naive to match. `datetime.now(timezone.utc)` rather than the
    deprecated `utcnow()`, and no `datetime.UTC` — this project targets 3.10."""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    return abs((now - datetime.fromisoformat(created_at)).total_seconds())


_GOLDEN = Path(__file__).parent.parent / "fixtures" / "aito_board_payload.json"


async def _seed_golden_board(client):
    """Five projects covering every shape the board payload can take: no
    tasks, a zero-cost service, an accepted project with mixed done flags, a
    project in a non-default column, and an accepted project pinned in place
    by a single unticked zero-cost step (the "0 is pending" half of the
    None-vs-0 rule)."""
    await client.post(
        "/api/v1/aito/",
        json={
            "description": "no tasks",
            "client_id": "C1",
            "client_name": "One",
            "client_phone": "+689 87 00 00 01",
            "tasks": [],
        },
    )
    await client.post(
        "/api/v1/aito/",
        json={
            "description": "zero cost",
            "client_id": "C2",
            "client_name": "Two",
            "client_phone": "+689 87 00 00 02",
            "tasks": [{"title": "free scan", "scan_cost": 0}],
        },
    )
    mixed = await client.post(
        "/api/v1/aito/",
        json={
            "description": "mixed",
            "client_id": "C3",
            "client_name": "Three",
            "client_phone": "+689 87 00 00 03",
        },
    )
    # Accepted because ticked steps now require it — a mixed-done-flags card
    # cannot exist in any other status. quote_status="accepted" needs a
    # quote_id at creation time now, so acceptance goes through the dedicated
    # route and the (pre-ticked) tasks are added afterwards.
    await client.post(f"/api/v1/aito/{mixed.json()['id']}/quote-status", json={"status": "accepted"})
    await client.post(
        f"/api/v1/aito/{mixed.json()['id']}/tasks",
        json={"title": "a", "scan_cost": 5000, "scan_done": True, "impression_cost": 2400},
    )
    await client.post(
        f"/api/v1/aito/{mixed.json()['id']}/tasks",
        json={"title": "b", "usinage_cost": 1000},
    )
    accepted = await client.post(
        "/api/v1/aito/",
        json={
            "description": "accepted",
            "client_id": "C4",
            "client_name": "Four",
            "client_phone": "+689 87 00 00 04",
        },
    )
    # Accepted for the same reason as "mixed": a pre-ticked step needs the
    # quote already accepted before it exists.
    await client.post(f"/api/v1/aito/{accepted.json()['id']}/quote-status", json={"status": "accepted"})
    await client.post(
        f"/api/v1/aito/{accepted.json()['id']}/tasks",
        json={"title": "c", "modelisation_cost": 3000, "modelisation_done": True},
    )
    zero_pending = await client.post(
        "/api/v1/aito/",
        json={
            "description": "accepted zero pending",
            "client_id": "C5",
            "client_name": "Five",
            "client_phone": "+689 87 00 00 05",
            "tasks": [{"title": "d", "scan_cost": 0}],
        },
    )
    await client.post(f"/api/v1/aito/{zero_pending.json()['id']}/quote-status", json={"status": "accepted"})


def _stable(payload: list[dict]) -> list[dict]:
    """Drop the fields that legitimately differ between runs."""
    return [
        {k: v for k, v in row.items() if k not in ("created_at", "updated_at", "quote_accepted_at")} for row in payload
    ]


@pytest.mark.asyncio
async def test_board_payload_matches_the_golden_fixture(async_client, db_session):
    """The load-bearing test for the summarise() swap: the board's JSON must be
    byte-identical to what the SQL aggregate produced. Regenerate deliberately
    with REGENERATE_GOLDEN=1 and read the diff before committing it."""
    await _seed_golden_board(async_client)
    actual = _stable((await async_client.get("/api/v1/aito/")).json())

    if os.environ.get("REGENERATE_GOLDEN") == "1":
        _GOLDEN.parent.mkdir(parents=True, exist_ok=True)
        _GOLDEN.write_text(json.dumps(actual, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    expected = json.loads(_GOLDEN.read_text(encoding="utf-8"))
    assert actual == expected


@pytest.mark.asyncio
async def test_create_wakes_the_quote_sync_worker(async_client):
    """A new own-quote project must not sit out the 300s poll before its
    estimate exists: creation wakes the outbox worker. An import already has
    its quote, so it must NOT wake — nothing is owed to Books yet, and the
    worker's wake drain would find nothing."""
    from backend.app.services import aito_quote_sync

    aito_quote_sync._wake.clear()
    assert (await _create(async_client)).status_code == 201
    assert aito_quote_sync._wake.is_set()

    aito_quote_sync._wake.clear()
    r = await _create(async_client, quote_id="E77", quote_number="DEV26-1")
    assert r.status_code == 201
    assert not aito_quote_sync._wake.is_set()


@pytest.mark.asyncio
async def test_every_edit_that_touches_the_quote_wakes_the_worker(async_client):
    """An edit changes what the quote must say, so it must reach Books on the
    edit window rather than sitting out the full 300s poll.

    Each case below is an independent write path — they do not share a
    `_mark_pending` call site — so one shared assertion would not catch a path
    that forgot to wake.
    """
    from backend.app.services import aito_quote_sync

    project_id = (await _create(async_client)).json()["id"]
    task_id = (await async_client.post(f"/api/v1/aito/{project_id}/tasks", json={"scan_cost": 1000})).json()["id"]

    async def wakes(call):
        aito_quote_sync._wake.clear()
        aito_quote_sync._debounce_deadline = None
        response = await call()
        assert response.status_code < 300, response.text
        return aito_quote_sync._wake.is_set()

    assert await wakes(lambda: async_client.patch(f"/api/v1/aito/{project_id}", json={"description": "Autre"}))
    assert await wakes(lambda: async_client.post(f"/api/v1/aito/{project_id}/tasks", json={"scan_cost": 2000}))
    assert await wakes(lambda: async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"scan_cost": 3000}))
    assert await wakes(lambda: async_client.delete(f"/api/v1/aito/tasks/{task_id}"))


@pytest.mark.asyncio
async def test_trashing_and_restoring_wake_the_worker_too(async_client):
    """Both change what Books must say about the quote's status, and both go
    through their own `_mark_pending_if_ours` call site rather than sharing
    one with the edit paths above."""
    from backend.app.services import aito_quote_sync

    project_id = (await _create(async_client)).json()["id"]

    aito_quote_sync._wake.clear()
    aito_quote_sync._debounce_deadline = None
    assert (await async_client.delete(f"/api/v1/aito/{project_id}")).status_code == 204
    assert aito_quote_sync._wake.is_set()

    aito_quote_sync._wake.clear()
    aito_quote_sync._debounce_deadline = None
    assert (await async_client.post(f"/api/v1/aito/{project_id}/restore")).status_code == 200
    assert aito_quote_sync._wake.is_set()


@pytest.mark.asyncio
async def test_impression_discount_round_trips_through_task_responses(async_client):
    """Regression: _task_to_response used to drop impression_discount_pct, so
    every response reported null. The frontend keeps each mutation's response
    as its diff baseline, so the stored 10% became invisible after any save —
    and clearing it then diffed as "no change", leaving the discount live on
    the customer's quote while the UI showed none."""
    project_id = (await _create(async_client)).json()["id"]

    created = await async_client.post(
        f"/api/v1/aito/{project_id}/tasks",
        json={"impression_cost": 1000, "impression_discount_pct": 10},
    )
    assert created.status_code == 201
    assert created.json()["impression_discount_pct"] == 10
    task_id = created.json()["id"]

    listed = await async_client.get(f"/api/v1/aito/{project_id}/tasks")
    assert [t["impression_discount_pct"] for t in listed.json() if t["id"] == task_id] == [10]

    cleared = await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"impression_discount_pct": None})
    assert cleared.status_code == 200
    assert cleared.json()["impression_discount_pct"] is None


@pytest.mark.asyncio
async def test_create_requires_client(async_client):
    r = await _create(async_client, client_id=None, client_name=None)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_and_list(async_client):
    r = await _create(async_client)
    assert r.status_code == 201
    body = r.json()
    assert body["column"] == "devis" and body["position"] == 0
    assert body["client_name"] == "ACME"

    r2 = await async_client.get("/api/v1/aito/")
    assert [p["id"] for p in r2.json()] == [body["id"]]


@pytest.mark.asyncio
async def test_board_lists_flagged_cards_first_within_their_column(async_client):
    """Display ordering only. Manual drag order still holds inside the flagged
    group and inside the normal group — stored `position` values are never
    rewritten, which is what keeps a flag from destroying the operator's
    ordering irreversibly.

    Urgent and sav share the top rank as peers — an SAV card and an urgent
    card rank equally and fall back to position — while pause ranks below
    unflagged instead. This test covers only the top tier."""
    first = (await _create(async_client, description="first")).json()
    second = (await _create(async_client, description="second")).json()
    third = (await _create(async_client, description="third")).json()

    # All three land in devis. Creation prepends (each new card takes
    # position 0 and shifts the rest down), so of the two flagged here,
    # `second` holds the lower stored position — it must flag "urgent" for
    # the flagged group to read position-ascending as ["urgent", "sav"].
    # One of each flag, so neither can be seen to outrank the other.
    await async_client.patch(f"/api/v1/aito/{second['id']}/flag", json={"flag": "urgent"})
    await async_client.patch(f"/api/v1/aito/{first['id']}/flag", json={"flag": "sav"})

    board = (await async_client.get("/api/v1/aito/")).json()
    devis = [p for p in board if p["column"] == "devis"]

    assert [p["flag"] for p in devis] == ["urgent", "sav", None]
    # Within the flagged group, the stored position order is intact.
    flagged_positions = [p["position"] for p in devis if p["flag"]]
    assert flagged_positions == sorted(flagged_positions)
    assert devis[-1]["id"] == third["id"]


@pytest.mark.asyncio
async def test_move_reindexes_within_a_column(async_client):
    """Reordering is always allowed, whatever a card's lock: it changes
    priority, not state."""
    a = (await _create(async_client, description="a")).json()
    b = (await _create(async_client, description="b")).json()  # devis order: b(0), a(1)

    r = await async_client.patch(f"/api/v1/aito/{a['id']}/move", json={"column": "devis", "position": 0})
    assert r.status_code == 200

    board = {p["id"]: p for p in (await async_client.get("/api/v1/aito/")).json()}
    assert board[a["id"]]["position"] == 0
    assert board[b["id"]]["position"] == 1


def _devis_order(board: list[dict]) -> list[str]:
    return [p["description"] for p in board if p["column"] == "devis"]


@pytest.mark.asyncio
async def test_move_lands_where_it_was_dropped_when_the_column_holds_a_flagged_card(async_client):
    """`position` indexes the DISPLAYED order, which is flagged-first.

    A column reading [b, a, c, d] on screen (b flagged, stored positions
    a=0, b=1, c=2, d=3) must accept a drop of `d` at display index 1 and put
    it there. Renumbering in stored order instead would insert `d` between a
    and b, and the next fetch would show [b, a, d, c] — the card visibly
    snapping back one slot, with the dropped slot unreachable by any repeat
    of the same drag.
    """
    # Creation prepends, so create back-to-front to get a=0, b=1, c=2, d=3.
    for description in ("d", "c", "b", "a"):
        await _create(async_client, description=description)
    ids = {p["description"]: p["id"] for p in (await async_client.get("/api/v1/aito/")).json()}

    await async_client.patch(f"/api/v1/aito/{ids['b']}/flag", json={"flag": "urgent"})
    assert _devis_order((await async_client.get("/api/v1/aito/")).json()) == ["b", "a", "c", "d"]

    r = await async_client.patch(f"/api/v1/aito/{ids['d']}/move", json={"column": "devis", "position": 1})
    assert r.status_code == 200

    assert _devis_order((await async_client.get("/api/v1/aito/")).json()) == ["b", "d", "a", "c"]


@pytest.mark.asyncio
async def test_move_cannot_drag_a_flagged_card_below_a_normal_one(async_client):
    """The one ordering constraint the flag deliberately imposes.

    Being flagged is a display-only sort, so a flagged card always redisplays
    above the unflagged ones however far down it is dropped. Pinned here so a
    later change cannot quietly turn it into stored-position grouping.
    """
    for description in ("c", "b", "a"):
        await _create(async_client, description=description)
    ids = {p["description"]: p["id"] for p in (await async_client.get("/api/v1/aito/")).json()}

    await async_client.patch(f"/api/v1/aito/{ids['b']}/flag", json={"flag": "urgent"})
    assert _devis_order((await async_client.get("/api/v1/aito/")).json()) == ["b", "a", "c"]

    r = await async_client.patch(f"/api/v1/aito/{ids['b']}/move", json={"column": "devis", "position": 2})
    assert r.status_code == 200

    board = (await async_client.get("/api/v1/aito/")).json()
    assert _devis_order(board) == ["b", "a", "c"]
    # The drop was still honoured in the stored order it was given.
    stored = {p["description"]: p["position"] for p in board if p["column"] == "devis"}
    assert stored == {"a": 0, "c": 1, "b": 2}


@pytest.mark.asyncio
async def test_board_sinks_paused_cards_below_unflagged_ones(async_client):
    """Urgent and SAV mean "look at this"; pause means the opposite. So the
    board is three tiers, not two: attention flags, then unflagged, then
    paused — with stored `position` still breaking ties inside each tier and
    never being rewritten."""
    a = (await _create(async_client, description="a")).json()
    # b and c are never referenced by id — do NOT assign them. Ruff's F rules
    # are enabled and F841 would reject an unused local.
    await _create(async_client, description="b")
    await _create(async_client, description="c")
    d = (await _create(async_client, description="d")).json()
    # Stored devis order is now d(0), c(1), b(2), a(3).

    await async_client.patch(f"/api/v1/aito/{d['id']}/flag", json={"flag": "pause"})
    await async_client.patch(f"/api/v1/aito/{a['id']}/flag", json={"flag": "urgent"})

    board = (await async_client.get("/api/v1/aito/")).json()

    # `a` rose from last to first, `d` sank from first to last, and the two
    # unflagged cards kept their stored order between them.
    assert _devis_order(board) == ["a", "c", "b", "d"]
    assert [p["flag"] for p in board if p["column"] == "devis"] == ["urgent", None, None, "pause"]


@pytest.mark.asyncio
async def test_move_to_another_column_is_409_when_locked(async_client):
    a = (await _create(async_client)).json()
    r = await async_client.patch(f"/api/v1/aito/{a['id']}/move", json={"column": "print", "position": 0})
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_finish_to_done_is_allowed_when_unlocked(async_client):
    p = await _create_accepted(async_client)
    t = (await _add_task(async_client, p["id"], scan_cost=1200.0)).json()
    await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_done": True})

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "done", "position": 0})
    assert r.status_code == 200
    assert r.json()["column"] == "done"

    back = await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "finish", "position": 0})
    assert back.status_code == 200
    assert back.json()["column"] == "finish"


@pytest.mark.asyncio
async def test_move_renumbers_the_column_left_behind(async_client):
    """Two unlocked cards in finish; moving one to done must renumber the
    card left behind, not just append the mover to its new column."""
    p1 = await _create_accepted(async_client, description="p1")  # finish, position 0
    p2 = await _create_accepted(async_client, description="p2")  # finish, position 1

    r = await async_client.patch(f"/api/v1/aito/{p1['id']}/move", json={"column": "done", "position": 0})
    assert r.status_code == 200

    board = {p["id"]: p for p in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p1["id"]]["column"] == "done" and board[p1["id"]]["position"] == 0
    assert board[p2["id"]]["column"] == "finish" and board[p2["id"]]["position"] == 0


@pytest.mark.asyncio
async def test_an_unlocked_card_still_cannot_move_to_a_work_column(async_client):
    p = await _create_accepted(async_client)
    t = (await _add_task(async_client, p["id"], scan_cost=1200.0)).json()
    await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_done": True})

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "scan", "position": 0})
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_move_rejects_a_column_that_no_longer_exists(async_client):
    a = (await _create(async_client)).json()
    r = await async_client.patch(f"/api/v1/aito/{a['id']}/move", json={"column": "pickup", "position": 0})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_move_rejects_bad_column(async_client):
    a = (await _create(async_client)).json()
    r = await async_client.patch(f"/api/v1/aito/{a['id']}/move", json={"column": "nope", "position": 0})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_soft_delete_hides_but_keeps_row(async_client, db_session):
    a = (await _create(async_client)).json()
    r = await async_client.delete(f"/api/v1/aito/{a['id']}")
    assert r.status_code == 204
    assert (await async_client.get("/api/v1/aito/")).json() == []
    row = (await db_session.execute(select(AitoProject).where(AitoProject.id == a["id"]))).scalar_one()
    assert row.status == "deleted"


@pytest.mark.asyncio
async def test_import_only_on_empty_board(async_client):
    payload = {"projects": [{"description": "legacy", "column": "print", "position": 0}]}
    r = await async_client.post("/api/v1/aito/import", json=payload)
    assert r.status_code == 201
    assert (await async_client.get("/api/v1/aito/")).json()[0]["client_id"] is None
    # second fire must 409 — board is no longer empty (soft-deleted rows count)
    assert (await async_client.post("/api/v1/aito/import", json=payload)).status_code == 409


@pytest.mark.asyncio
async def test_import_accepts_a_thousand_projects(async_client):
    """1000 mirrors library.py's BulkFileOperation.file_ids cap (T-037/T-049)
    — a payload sitting exactly on it must still be accepted, not just one
    under."""
    payload = {"projects": [{"description": f"legacy {i}", "column": "print", "position": i} for i in range(1000)]}
    r = await async_client.post("/api/v1/aito/import", json=payload)
    assert r.status_code == 201
    assert len(r.json()) == 1000


@pytest.mark.asyncio
async def test_import_rejects_more_than_a_thousand_projects(async_client):
    payload = {"projects": [{"description": f"legacy {i}", "column": "print", "position": i} for i in range(1001)]}
    r = await async_client.post("/api/v1/aito/import", json=payload)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_import_accepts_a_project_description_at_the_cap(async_client):
    """10_000 matches every other description cap in the module (T-011) —
    AitoProjectImportItem.description was the one left uncapped."""
    capped = "D" * 10_000
    payload = {"projects": [{"description": capped, "column": "print", "position": 0}]}
    r = await async_client.post("/api/v1/aito/import", json=payload)
    assert r.status_code == 201
    assert (await async_client.get("/api/v1/aito/")).json()[0]["description"] == capped


@pytest.mark.asyncio
async def test_import_rejects_an_over_cap_project_description(async_client):
    payload = {"projects": [{"description": "D" * 10_001, "column": "print", "position": 0}]}
    r = await async_client.post("/api/v1/aito/import", json=payload)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_trash_lists_deleted_newest_first(async_client):
    a = (await _create(async_client, description="a")).json()
    b = (await _create(async_client, description="b")).json()
    assert (await async_client.get("/api/v1/aito/trash")).json() == []
    await async_client.delete(f"/api/v1/aito/{a['id']}")
    await async_client.delete(f"/api/v1/aito/{b['id']}")
    trash = (await async_client.get("/api/v1/aito/trash")).json()
    assert [p["id"] for p in trash] == sorted([a["id"], b["id"]], reverse=True)
    assert all(p["status"] == "deleted" for p in trash)


@pytest.mark.asyncio
async def test_restore_appends_to_end_of_column(async_client):
    a = (await _create(async_client, description="a")).json()
    b = (await _create(async_client, description="b")).json()  # devis: b(0), a(1)
    await async_client.delete(f"/api/v1/aito/{a['id']}")
    r = await async_client.post(f"/api/v1/aito/{a['id']}/restore")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "active"
    assert body["column"] == "devis"
    assert body["position"] == 1  # appended after b
    board = (await async_client.get("/api/v1/aito/")).json()
    assert {p["id"] for p in board} == {a["id"], b["id"]}


@pytest.mark.asyncio
async def test_restore_active_or_missing_404s(async_client):
    a = (await _create(async_client, description="a")).json()
    assert (await async_client.post(f"/api/v1/aito/{a['id']}/restore")).status_code == 404
    assert (await async_client.post("/api/v1/aito/999999/restore")).status_code == 404


@pytest.mark.asyncio
async def test_update_description_leaves_client_untouched(async_client):
    a = (await _create(async_client)).json()
    r = await async_client.patch(f"/api/v1/aito/{a['id']}", json={"description": "Nouveau support"})
    assert r.status_code == 200
    body = r.json()
    assert body["description"] == "Nouveau support"
    assert body["client_name"] == "ACME"
    assert body["client_phone"] == "+33 6 12 34 56 78"


@pytest.mark.asyncio
async def test_update_replaces_the_whole_client_snapshot(async_client):
    a = (await _create(async_client)).json()
    r = await async_client.patch(
        f"/api/v1/aito/{a['id']}",
        json={"client_id": "z9", "client_name": "Globex", "client_phone": None},
    )
    assert r.status_code == 200
    body = r.json()
    assert (body["client_id"], body["client_name"], body["client_phone"]) == ("z9", "Globex", None)
    assert body["description"] == "Support GoPro"


@pytest.mark.asyncio
async def test_update_rejects_client_id_without_a_name(async_client):
    """A client_id whose merged client_name would be absent is rejected, even
    though client_id alone is fine when the stored name already satisfies it."""
    a = (await _create(async_client)).json()
    r = await async_client.patch(f"/api/v1/aito/{a['id']}", json={"client_id": "z9", "client_name": None})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_update_rejects_nulling_the_client_name_alone(async_client):
    """A lone client_name:null would leave client_id pointing at a nameless contact."""
    a = (await _create(async_client)).json()
    r = await async_client.patch(f"/api/v1/aito/{a['id']}", json={"client_name": None})
    assert r.status_code == 422
    unchanged = (await async_client.get("/api/v1/aito/")).json()[0]
    assert unchanged["client_name"] == "ACME" and unchanged["client_id"] == "z1"


@pytest.mark.asyncio
async def test_update_allows_clearing_the_whole_client_snapshot(async_client):
    """Clearing id and name together is consistent, so it is allowed."""
    a = (await _create(async_client)).json()
    r = await async_client.patch(
        f"/api/v1/aito/{a['id']}", json={"client_id": None, "client_name": None, "client_phone": None}
    )
    assert r.status_code == 200
    body = r.json()
    assert (body["client_id"], body["client_name"], body["client_phone"]) == (None, None, None)


@pytest.mark.asyncio
async def test_update_allows_renaming_the_client_without_resending_the_id(async_client):
    """The stored client_id satisfies the invariant, so a name-only edit is fine."""
    a = (await _create(async_client)).json()
    r = await async_client.patch(f"/api/v1/aito/{a['id']}", json={"client_name": "ACME SARL"})
    assert r.status_code == 200
    assert r.json()["client_name"] == "ACME SARL" and r.json()["client_id"] == "z1"


@pytest.mark.asyncio
async def test_update_rejects_blank_description(async_client):
    a = (await _create(async_client)).json()
    assert (await async_client.patch(f"/api/v1/aito/{a['id']}", json={"description": ""})).status_code == 422
    assert (await async_client.patch(f"/api/v1/aito/{a['id']}", json={"description": "   "})).status_code == 422


@pytest.mark.asyncio
async def test_update_never_touches_column_or_position(async_client):
    # quote_status="accepted" with no tasks lands the card in 'finish' unlocked,
    # so the Finish -> Done move below is legal under the cross-column guard.
    a = await _create_accepted(async_client)
    await async_client.patch(f"/api/v1/aito/{a['id']}/move", json={"column": "done", "position": 0})
    r = await async_client.patch(
        f"/api/v1/aito/{a['id']}", json={"description": "moved then edited", "column": "devis", "position": 7}
    )
    assert r.status_code == 200
    assert r.json()["column"] == "done" and r.json()["position"] == 0


@pytest.mark.asyncio
async def test_update_404s_on_deleted_or_missing(async_client):
    a = (await _create(async_client)).json()
    await async_client.delete(f"/api/v1/aito/{a['id']}")
    assert (await async_client.patch(f"/api/v1/aito/{a['id']}", json={"description": "x"})).status_code == 404
    assert (await async_client.patch("/api/v1/aito/99999", json={"description": "x"})).status_code == 404


@pytest.mark.asyncio
async def test_create_project_persists_client_email(async_client):
    r = await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "Support de caméra",
            "client_id": "z1",
            "client_name": "ACME SARL",
            "client_phone": "+689-87123456",
            "client_email": "hi@acme.pf",
        },
    )
    assert r.status_code == 201
    assert r.json()["client_email"] == "hi@acme.pf"
    listed = (await async_client.get("/api/v1/aito/")).json()
    assert listed[0]["client_email"] == "hi@acme.pf"


@pytest.mark.asyncio
async def test_update_project_writes_and_clears_client_email(async_client):
    project_id = (await _create(async_client)).json()["id"]

    r = await async_client.patch(f"/api/v1/aito/{project_id}", json={"client_email": "hi@acme.pf"})
    assert r.status_code == 200
    assert r.json()["client_email"] == "hi@acme.pf"

    # Explicit null clears it; an omitted key leaves it alone (existing semantics).
    r = await async_client.patch(f"/api/v1/aito/{project_id}", json={"client_email": None})
    assert r.json()["client_email"] is None

    r = await async_client.patch(f"/api/v1/aito/{project_id}", json={"description": "Autre pièce"})
    assert r.json()["client_email"] is None


@pytest.mark.asyncio
async def test_create_project_persists_client_is_company(async_client):
    r = await _create(async_client, client_is_company=True)
    assert r.status_code == 201
    assert r.json()["client_is_company"] is True
    listed = (await async_client.get("/api/v1/aito/")).json()
    assert listed[0]["client_is_company"] is True


@pytest.mark.asyncio
async def test_create_project_defaults_client_is_company_to_null(async_client):
    """Legacy rows and callers that omit the flag are indistinguishable from
    'not a company' at render time, but stay distinguishable in the data."""
    r = await _create(async_client)
    assert r.json()["client_is_company"] is None


@pytest.mark.asyncio
async def test_update_project_writes_and_clears_client_is_company(async_client):
    project_id = (await _create(async_client)).json()["id"]

    r = await async_client.patch(f"/api/v1/aito/{project_id}", json={"client_is_company": True})
    assert r.json()["client_is_company"] is True

    r = await async_client.patch(f"/api/v1/aito/{project_id}", json={"client_is_company": None})
    assert r.json()["client_is_company"] is None

    r = await async_client.patch(f"/api/v1/aito/{project_id}", json={"description": "Autre pièce"})
    assert r.json()["client_is_company"] is None


def _task(**overrides):
    payload = {"title": "Boîtier", "scan_cost": 4000.0}
    payload.update(overrides)
    return payload


@pytest.mark.asyncio
async def test_create_project_with_tasks_creates_them_in_order(async_client):
    r = await _create(
        async_client,
        tasks=[_task(title="Un"), _task(title="Deux", scan_cost=None, usinage_cost=12000.0)],
    )
    assert r.status_code == 201
    project_id = r.json()["id"]

    tasks = (await async_client.get(f"/api/v1/aito/{project_id}/tasks")).json()
    assert [t["title"] for t in tasks] == ["Un", "Deux"]
    assert [t["position"] for t in tasks] == [0, 1]
    assert tasks[1]["scan_cost"] is None
    assert tasks[1]["usinage_cost"] == 12000.0


@pytest.mark.asyncio
async def test_create_project_without_tasks_is_still_valid(async_client):
    r = await _create(async_client)
    assert r.status_code == 201
    assert (await async_client.get(f"/api/v1/aito/{r.json()['id']}/tasks")).json() == []


@pytest.mark.asyncio
async def test_project_list_does_not_include_tasks(async_client):
    """GET /aito/ drives the whole board and is refetched on every WebSocket
    invalidation; loading every task of every card would bloat it. The card's
    summary is served instead by three aggregate fields from one grouped query
    — see test_project_list_summarises_tasks."""
    await _create(async_client, tasks=[_task()])
    body = (await async_client.get("/api/v1/aito/")).json()
    assert "tasks" not in body[0]


@pytest.mark.asyncio
async def test_create_project_rejects_a_negative_cost(async_client):
    r = await _create(async_client, tasks=[_task(scan_cost=-1)])
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_project_accepts_client_fields_and_description_at_the_cap(async_client):
    """The caps mirror ZohoContactCreate's (name/email/phone) plus a generous
    10_000 for description — a payload sitting exactly on those caps must
    still be accepted, not just one under."""
    capped_name = "N" * 200
    capped_email = ("a" * 188) + "@example.com"  # exactly 200 chars, still a valid shape
    capped_description = "D" * 10_000
    r = await _create(
        async_client,
        description=capped_description,
        client_name=capped_name,
        client_email=capped_email,
    )
    assert r.status_code == 201
    body = r.json()
    assert body["client_name"] == capped_name
    assert body["client_email"] == capped_email
    assert body["description"] == capped_description


@pytest.mark.asyncio
async def test_create_project_rejects_an_over_cap_description(async_client):
    r = await _create(async_client, description="D" * 10_001)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_project_accepts_three_hundred_tasks(async_client):
    """300 (T-053, raised from T-037/T-049's original 50) is the cap that
    tolerates the Zoho quote-import preview's one-task-per-header-group
    payload, not just the create drawer's. A payload sitting exactly on it
    must still be accepted, not just one under."""
    tasks = [_task(title=f"Tâche {i}") for i in range(300)]
    r = await _create(async_client, tasks=tasks)
    assert r.status_code == 201
    fetched = (await async_client.get(f"/api/v1/aito/{r.json()['id']}/tasks")).json()
    assert len(fetched) == 300


@pytest.mark.asyncio
async def test_create_project_rejects_more_than_three_hundred_tasks(async_client):
    tasks = [_task(title=f"Tâche {i}") for i in range(301)]
    r = await _create(async_client, tasks=tasks)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_project_rejects_a_malformed_client_email(async_client):
    r = await _create(async_client, client_email="not-an-email")
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_project_accepts_zoho_sourced_phone_shapes(async_client):
    """The quote-import flow passes a Zoho contact's mobile/phone straight
    through with no reformatting (services/aito_quote_import.py's
    _client_snapshot) — unlike the manual create form, which always sends the
    canonical +CC-NNNN... shape via clientDraft.ts's formatPhone. Both a
    space-separated number and a bare local number are things Zoho itself was
    happy to store, so both must still validate here."""
    r = await _create(async_client, client_id="zc1", client_phone="+689 87 00 00 02")
    assert r.status_code == 201

    r = await _create(async_client, client_id="zc2", client_phone="0687654321")
    assert r.status_code == 201


@pytest.mark.asyncio
async def test_create_project_rejects_a_phone_with_too_few_digits(async_client):
    r = await _create(async_client, client_phone="12345")
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_project_rejects_a_phone_with_disallowed_characters(async_client):
    r = await _create(async_client, client_phone="not a phone")
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_add_task_appends_at_the_end(async_client):
    project_id = (await _create(async_client, tasks=[_task(title="Un")])).json()["id"]
    r = await async_client.post(f"/api/v1/aito/{project_id}/tasks", json=_task(title="Deux"))
    assert r.status_code == 201
    assert r.json()["position"] == 1


@pytest.mark.asyncio
async def test_patch_task_writes_clears_and_leaves_alone(async_client):
    project_id = (await _create(async_client, tasks=[_task(scan_cost=4000.0)])).json()["id"]
    task_id = (await async_client.get(f"/api/v1/aito/{project_id}/tasks")).json()[0]["id"]

    r = await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"usinage_cost": 12000.0})
    assert r.json()["usinage_cost"] == 12000.0
    assert r.json()["scan_cost"] == 4000.0  # untouched sibling

    r = await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"scan_cost": None})
    assert r.json()["scan_cost"] is None  # explicit null disables the service
    assert r.json()["usinage_cost"] == 12000.0

    r = await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"title": "Autre"})
    assert r.json()["usinage_cost"] == 12000.0  # omitted key left alone


@pytest.mark.asyncio
async def test_delete_task_removes_only_that_task(async_client):
    project_id = (await _create(async_client, tasks=[_task(title="Un"), _task(title="Deux")])).json()["id"]
    tasks = (await async_client.get(f"/api/v1/aito/{project_id}/tasks")).json()

    assert (await async_client.delete(f"/api/v1/aito/tasks/{tasks[0]['id']}")).status_code == 204
    remaining = (await async_client.get(f"/api/v1/aito/{project_id}/tasks")).json()
    assert [t["title"] for t in remaining] == ["Deux"]


_TASK_DESCRIPTION_FIELDS = [
    "scan_description",
    "modelisation_description",
    "impression_description",
    "usinage_description",
]


@pytest.mark.parametrize("field", _TASK_DESCRIPTION_FIELDS)
@pytest.mark.asyncio
async def test_create_task_accepts_a_description_at_the_cap(async_client, field):
    """Same 10_000 cap as the project description (T-011) — a value sitting
    exactly on it must still be accepted, not just one under."""
    project_id = (await _create(async_client)).json()["id"]
    capped = "D" * 10_000
    r = await async_client.post(f"/api/v1/aito/{project_id}/tasks", json=_task(**{field: capped}))
    assert r.status_code == 201
    assert r.json()[field] == capped


@pytest.mark.parametrize("field", _TASK_DESCRIPTION_FIELDS)
@pytest.mark.asyncio
async def test_create_task_rejects_an_over_cap_description(async_client, field):
    project_id = (await _create(async_client)).json()["id"]
    r = await async_client.post(f"/api/v1/aito/{project_id}/tasks", json=_task(**{field: "D" * 10_001}))
    assert r.status_code == 422


@pytest.mark.parametrize("field", _TASK_DESCRIPTION_FIELDS)
@pytest.mark.asyncio
async def test_patch_task_rejects_an_over_cap_description(async_client, field):
    project_id = (await _create(async_client, tasks=[_task()])).json()["id"]
    task_id = (await async_client.get(f"/api/v1/aito/{project_id}/tasks")).json()[0]["id"]
    r = await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={field: "D" * 10_001})
    assert r.status_code == 422


@pytest.mark.parametrize("field", _TASK_DESCRIPTION_FIELDS)
@pytest.mark.asyncio
async def test_reading_a_task_already_over_the_cap_still_succeeds(async_client, db_session, field):
    """The 10_000 cap (T-011) is declared on AitoTaskCreate/AitoTaskUpdate only, never on
    AitoTaskBase/AitoTaskResponse. A row already stored above the cap (there is no migration
    to trim existing data) must still read back in full through GET, and an unrelated PATCH
    of the same task must still succeed — response construction must not re-validate a bound
    that only ever applied to the write path."""
    project_id = (await _create(async_client)).json()["id"]
    over_cap = "D" * 10_001
    db_session.add(AitoTask(project_id=project_id, position=0, **{field: over_cap}))
    await db_session.commit()

    r = await async_client.get(f"/api/v1/aito/{project_id}/tasks")
    assert r.status_code == 200
    assert r.json()[0][field] == over_cap

    task_id = r.json()[0]["id"]
    r = await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"scan_cost": 42})
    assert r.status_code == 200
    assert r.json()[field] == over_cap


@pytest.mark.asyncio
async def test_task_endpoints_404_on_unknown_ids(async_client):
    assert (await async_client.patch("/api/v1/aito/tasks/9999", json={"title": "x"})).status_code == 404
    assert (await async_client.delete("/api/v1/aito/tasks/9999")).status_code == 404
    assert (await async_client.post("/api/v1/aito/9999/tasks", json=_task())).status_code == 404


@pytest.mark.asyncio
async def test_soft_deleting_a_project_keeps_its_tasks(async_client):
    project_id = (await _create(async_client, tasks=[_task()])).json()["id"]
    await async_client.delete(f"/api/v1/aito/{project_id}")
    await async_client.post(f"/api/v1/aito/{project_id}/restore")
    assert len((await async_client.get(f"/api/v1/aito/{project_id}/tasks")).json()) == 1


@pytest.mark.asyncio
async def test_project_list_summarises_tasks(async_client):
    r = await _create(
        async_client,
        tasks=[
            _task(title="Un", scan_cost=4000.0),
            _task(title="Deux", scan_cost=None, usinage_cost=12000.0),
        ],
    )
    project_id = r.json()["id"]

    body = (await async_client.get("/api/v1/aito/")).json()
    card = next(p for p in body if p["id"] == project_id)
    assert card["task_count"] == 2
    assert card["tasks_total"] == 16000.0
    assert card["task_services"] == ["scan", "usinage"]


@pytest.mark.asyncio
async def test_project_without_tasks_summarises_to_zero(async_client):
    r = await _create(async_client)
    body = (await async_client.get("/api/v1/aito/")).json()
    card = next(p for p in body if p["id"] == r.json()["id"])
    assert card["task_count"] == 0
    assert card["tasks_total"] == 0.0
    assert card["task_services"] == []


@pytest.mark.asyncio
async def test_a_free_service_still_counts_as_enabled(async_client):
    """0 is a price, NULL is a disabled service. A service quoted at zero must
    still appear in task_services — an aggregate testing `> 0` instead of
    IS NOT NULL would silently drop it, and the total would look identical."""
    r = await _create(async_client, tasks=[_task(scan_cost=0.0)])
    body = (await async_client.get("/api/v1/aito/")).json()
    card = next(p for p in body if p["id"] == r.json()["id"])
    assert card["task_services"] == ["scan"]
    assert card["tasks_total"] == 0.0
    assert card["task_count"] == 1


@pytest.mark.asyncio
async def test_task_services_use_canonical_order_not_insertion_order(async_client):
    r = await _create(
        async_client,
        tasks=[
            _task(title="Un", scan_cost=None, usinage_cost=100.0),
            _task(title="Deux", scan_cost=None, modelisation_cost=200.0),
            _task(title="Trois", scan_cost=1.0),
        ],
    )
    body = (await async_client.get("/api/v1/aito/")).json()
    card = next(p for p in body if p["id"] == r.json()["id"])
    assert card["task_services"] == ["scan", "modelisation", "usinage"]


@pytest.mark.asyncio
async def test_tasks_total_sums_exactly_the_four_cost_columns(async_client):
    """Pins the arithmetic. This mirrors `taskTotal` in
    frontend/src/utils/taskDraft.ts; the two are in different languages and
    cannot share code, so a change to one must be made in the other."""
    r = await _create(
        async_client,
        tasks=[
            _task(
                scan_cost=1.0,
                modelisation_cost=20.0,
                usinage_cost=300.0,
                impression_cost=4000.0,
            )
        ],
    )
    body = (await async_client.get("/api/v1/aito/")).json()
    card = next(p for p in body if p["id"] == r.json()["id"])
    assert card["tasks_total"] == 4321.0


@pytest.mark.asyncio
async def test_patch_response_carries_the_task_summary(async_client):
    """The detail panel writes the PATCH response straight into the board cache
    (setQueryData replaces the row), so a response missing the aggregate would
    blank the card's badges until the next fetch."""
    r = await _create(async_client, tasks=[_task(scan_cost=4000.0)])
    project_id = r.json()["id"]
    patched = await async_client.patch(f"/api/v1/aito/{project_id}", json={"description": "Nouveau"})
    assert patched.status_code == 200
    assert patched.json()["task_count"] == 1
    assert patched.json()["tasks_total"] == 4000.0
    assert patched.json()["task_services"] == ["scan"]


@pytest.mark.asyncio
async def test_create_response_carries_the_task_summary(async_client):
    r = await _create(async_client, tasks=[_task(title="Un"), _task(title="Deux")])
    assert r.status_code == 201
    assert r.json()["task_count"] == 2


@pytest.mark.asyncio
async def test_move_and_restore_responses_carry_the_task_summary(async_client):
    r = await _create(async_client, tasks=[_task(scan_cost=4000.0)])
    project_id = r.json()["id"]

    # An unaccepted quote is locked into 'devis', so only a within-column
    # reorder is legal here — that's all this test needs to exercise the
    # move response's task summary anyway.
    moved = await async_client.patch(f"/api/v1/aito/{project_id}/move", json={"column": "devis", "position": 0})
    assert moved.json()["task_count"] == 1

    await async_client.delete(f"/api/v1/aito/{project_id}")
    restored = await async_client.post(f"/api/v1/aito/{project_id}/restore")
    assert restored.json()["task_count"] == 1


@pytest.mark.asyncio
async def test_tasks_by_project_handles_many_projects_and_an_empty_list(db_session):
    from backend.app.api.routes.aito import _tasks_by_project

    assert await _tasks_by_project(db_session, []) == {}

    db_session.add(AitoProject(description="p1", board_column="devis", position=0))
    db_session.add(AitoProject(description="p2", board_column="devis", position=1))
    await db_session.flush()
    db_session.add(AitoTask(project_id=1, position=0, scan_cost=100.0))
    db_session.add(AitoTask(project_id=1, position=1, usinage_cost=50.0))
    await db_session.commit()

    grouped = await _tasks_by_project(db_session, [1, 2, 3])
    assert len(grouped[1]) == 2
    assert 2 not in grouped  # a project with no tasks is absent
    assert 3 not in grouped  # a nonexistent id is absent
    assert summarise(grouped[1]).total == 150.0


@pytest.mark.asyncio
async def test_create_project_stores_quote_link(async_client):
    r = await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "Tapis souple X4 bloc",
            "client_id": "z1",
            "client_name": "ACME",
            "quote_id": "664070000095",
            "quote_number": "DEV26-2461",
            "quote_date": "2026-07-28",
            "quote_total": 18000.0,
            "quote_url": "https://books.zoho.eu/app/999#/estimates/664070000095",
        },
    )
    assert r.status_code == 201
    body = r.json()
    assert body["quote_id"] == "664070000095"
    assert body["quote_number"] == "DEV26-2461"
    assert body["quote_date"] == "2026-07-28"
    assert body["quote_total"] == 18000.0
    assert body["quote_url"].endswith("#/estimates/664070000095")

    listed = (await async_client.get("/api/v1/aito/")).json()
    assert listed[0]["quote_number"] == "DEV26-2461"


@pytest.mark.asyncio
async def test_create_project_accepts_an_https_quote_url(async_client):
    r = await _create(async_client, quote_url="https://books.zoho.eu/app/999#/estimates/664070000095")
    assert r.status_code == 201
    assert r.json()["quote_url"] == "https://books.zoho.eu/app/999#/estimates/664070000095"


@pytest.mark.asyncio
async def test_create_project_rejects_a_javascript_quote_url(async_client):
    # quote_url is rendered as a trustworthy-looking anchor labelled with the
    # quote number, so anything other than https (including a javascript:
    # scheme, a bare http:, or a relative value) must be rejected outright.
    r = await _create(async_client, quote_url="javascript:alert(1)")
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_project_without_quote_leaves_quote_fields_null(async_client):
    r = await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "Manual card",
            "client_id": "z1",
            "client_name": "ACME",
            "client_phone": "+689 87 00 00 06",
        },
    )
    assert r.status_code == 201
    body = r.json()
    assert body["quote_id"] is None
    assert body["quote_number"] is None
    assert body["quote_date"] is None
    assert body["quote_total"] is None
    assert body["quote_url"] is None


@pytest.mark.asyncio
async def test_create_stores_the_quote_salesperson_and_status(async_client):
    # quote_id required alongside a decided status: this is a hand-made card
    # in every other respect, but the schema's _decided_status_needs_a_quote_id
    # validator treats a bare "accepted" as import-only. See test_aito_routes.py's
    # sibling tests for the pure hand-made-card acceptance path via /quote-status.
    r = await _create(async_client, quote_id="EST-42", quote_salesperson="Marie VENDEUSE", quote_status="accepted")
    assert r.status_code == 201
    assert r.json()["quote_salesperson"] == "Marie VENDEUSE"
    assert r.json()["quote_status"] == "accepted"


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["accepted", "declined"])
async def test_create_with_a_decided_status_and_no_quote_id_is_422(async_client, status):
    """T-009: a client holding only aito:create must not be able to drive an
    irreversible quote decision through the create body — that used to write
    quote_status straight onto the row, land the card directly on a work
    column (or Done, for a decline) and leave no actor on the timeline. The
    only legitimate way to reach 'accepted'/'declined' with no quote_id is
    the dedicated /quote-status route."""
    r = await _create(async_client, quote_status=status)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_degrades_an_unknown_quote_status_to_none(async_client):
    """T-020: T-009 restricted quote_status to the Zoho vocabulary, but that
    closed the vocabulary too, beyond what was approved — the schema now
    degrades a status outside the six known values to None instead of
    422ing the whole request. This corrects the previous version of this
    test (from T-009), which asserted the 422 that T-020 removes; see
    aito_quote_import.py's `estimate.get("status") or ""`, which can hand
    POST /aito/ a blank status, and a real Books org can carry a status
    (e.g. 'invoiced') this app has never catalogued — neither should fail
    an otherwise-valid import."""
    r = await _create(async_client, quote_id="EST-1", quote_status="bogus")
    assert r.status_code == 201
    assert r.json()["quote_status"] is None


@pytest.mark.asyncio
async def test_create_degrades_a_blank_quote_status_to_none(async_client):
    """T-020: the reachable half of the same defect — build_preview emits
    `""` (never omits the key) when a Books estimate carries no status, and
    that must degrade exactly like an unknown status, not 422."""
    r = await _create(async_client, quote_id="EST-1", quote_status="")
    assert r.status_code == 201
    assert r.json()["quote_status"] is None


@pytest.mark.asyncio
async def test_create_degrades_an_unknown_status_at_exactly_thirty_chars(async_client):
    """T-022: pins the degrade path's upper boundary. Pre-T-009 this field
    carried `max_length=30`; a 30-char unknown status is still short enough
    to be degraded to None like any other unrecognised value, matching
    test_create_degrades_an_unknown_quote_status_to_none above."""
    r = await _create(async_client, quote_id="EST-1", quote_status="x" * 30)
    assert r.status_code == 201
    assert r.json()["quote_status"] is None


@pytest.mark.asyncio
async def test_create_with_an_over_length_quote_status_is_422(async_client):
    """T-022: restores BASE parity. At BASE, `quote_status` carried
    `max_length=30`, so anything longer 422'd; that cap was dropped when the
    field became a `Literal` (T-009), and was unobservable at the time
    because the Literal already rejected any such value. T-020 then added a
    before-validator that degrades unrecognised strings to None — without a
    length bound, that degrade path silently swallowed a >30-char status
    into a 201 instead of the 422 it produced at BASE. This pins that the
    31-char case still 422s, unlike the 30-char case above."""
    r = await _create(async_client, quote_id="EST-1", quote_status="x" * 31)
    assert r.status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["draft", "sent", "viewed", "expired"])
async def test_create_with_a_non_decided_status_and_no_quote_id_still_works(async_client, status):
    """T-009's gate only applies to DECIDED statuses ('accepted'/'declined').
    A card that has merely gone out, been opened or expired is not a
    decision, and the create endpoint has always been able to seed those
    directly (see test_accepting_derives_the_first_stage_with_work and
    friends, which rely on exactly this)."""
    r = await _create(async_client, quote_status=status)
    assert r.status_code == 201
    assert r.json()["quote_status"] == status


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["accepted", "declined"])
async def test_importing_a_decided_quote_still_works_and_records_an_actor(async_client, status):
    """T-009: the genuine import path — a decided status arriving WITH a
    quote_id, because Books already decided it — must keep working, and must
    now leave a quote.{status} event with an actor, matching what the
    dedicated /quote-status route has always recorded for a hand-made card.

    Granted aito:update alongside aito:create (T-036): the default Operators
    group bundles all four aito permissions, and this pins that the common
    case — a real operator, not a narrowly-scoped one — is unaffected by the
    new gate below."""
    from backend.app.main import app
    from backend.app.models.group import Group
    from backend.app.models.user import User

    route = next(r for r in app.routes if getattr(r, "name", "") == "create_project")
    dep = next(d.call for d in route.dependant.dependencies if d.name == "current_user")
    app.dependency_overrides[dep] = lambda: User(
        id=1, username="paul", groups=[Group(name="t", permissions=["aito:create", "aito:update"])]
    )
    try:
        r = await _create(async_client, quote_id="EST-9", quote_status=status)
        assert r.status_code == 201
        assert r.json()["quote_status"] == status
        project_id = r.json()["id"]

        events = (await async_client.get(f"/api/v1/aito/{project_id}/events?depth=detail")).json()["events"]
        matches = [e for e in events if e["kind"] == f"quote.{status}"]
        assert len(matches) == 1
        assert matches[0]["actor_name"] == "paul"
    finally:
        app.dependency_overrides.pop(dep, None)


async def _create_as(async_client, permissions, **overrides):
    """Create a project as a user whose ONLY permissions are `permissions`
    (via a throwaway in-memory group, never persisted). Mirrors the
    dependency-override technique `test_importing_a_decided_quote_still_works
    _and_records_an_actor` above uses to attach a real permission set to
    `current_user`, since `async_client`'s default (auth disabled) makes
    `current_user` None and would skip the permission check entirely."""
    from backend.app.main import app
    from backend.app.models.group import Group
    from backend.app.models.user import User

    route = next(r for r in app.routes if getattr(r, "name", "") == "create_project")
    dep = next(d.call for d in route.dependant.dependencies if d.name == "current_user")
    app.dependency_overrides[dep] = lambda: User(
        id=1, username="paul", groups=[Group(name="t", permissions=list(permissions))]
    )
    try:
        return await _create(async_client, **overrides)
    finally:
        app.dependency_overrides.pop(dep, None)


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["accepted", "declined"])
async def test_create_with_a_decided_status_and_only_aito_create_is_403(async_client, status):
    """T-036: aito:create alone must not be able to stamp a decided status on
    an imported quote — that used to sail through unaudited, skip
    /quote-status's actor recording and 409 terminal-transition guards, and
    let the sync worker push the acceptance straight onto the live Zoho
    estimate. A caller must also hold aito:update."""
    r = await _create_as(async_client, ["aito:create"], quote_id="EST-9", quote_status=status)
    assert r.status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["accepted", "declined"])
async def test_create_with_a_decided_status_and_aito_update_succeeds(async_client, status):
    """T-036: the default Operators group (and any custom group granting
    both) is unaffected — a caller holding aito:update alongside aito:create
    can still import an already-decided quote."""
    r = await _create_as(async_client, ["aito:create", "aito:update"], quote_id="EST-9", quote_status=status)
    assert r.status_code == 201
    assert r.json()["quote_status"] == status


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["draft", "sent", "viewed", "expired", None])
async def test_create_with_an_undecided_status_and_only_aito_create_still_works(async_client, status):
    """T-036: the new gate only fires for 'accepted'/'declined' — every other
    status (and the absence of one) is unaffected for an aito:create-only
    caller, exactly as before this task."""
    overrides = {} if status is None else {"quote_status": status}
    r = await _create_as(async_client, ["aito:create"], **overrides)
    assert r.status_code == 201
    assert r.json()["quote_status"] == status


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["accepted", "declined"])
async def test_create_with_a_decided_status_is_unaffected_when_auth_is_disabled(async_client, status):
    """T-036: RequirePermissionIfAuthEnabled returns None (not a User) when
    auth is off, and the new gate only applies when there IS a current_user
    — an auth-disabled instance must keep working exactly as it did before
    this task, same as test_create_stores_the_quote_salesperson_and_status."""
    r = await _create(async_client, quote_id="EST-9", quote_status=status)
    assert r.status_code == 201
    assert r.json()["quote_status"] == status


@pytest.mark.asyncio
async def test_create_records_no_creator_when_auth_is_disabled(async_client):
    # The permission dependency returns None when auth is off — and also for
    # API-key requests, which deliberately carry no user identity. A project
    # created either way has no creator to record, and that is not an error.
    r = await _create(async_client)
    assert r.status_code == 201
    assert r.json()["created_by"] is None


@pytest.fixture
async def idle_project(async_client, db_session):
    """A project with one task, forced to 'idle' so a test observes the
    *transition* an endpoint makes rather than the value a fresh create
    already leaves behind.

    Also given a quote_id, so this simulates a project that has genuinely
    completed a push (idle + quote_id set) rather than a legacy
    localStorage-migrated card, which now carries the explicit
    `quote_sync_state = 'unmanaged'` marker instead of 'idle' (see
    `_mark_pending_if_ours`). The quote_id isn't load-bearing for the guard
    any more — only the 'unmanaged' state is — but it's kept here so this
    fixture still reads as "a real, previously-synced project", not a
    freshly-created one.
    """
    created = (await _create(async_client, tasks=[_task()])).json()
    task_id = (await async_client.get(f"/api/v1/aito/{created['id']}/tasks")).json()[0]["id"]
    project = (await db_session.execute(select(AitoProject).where(AitoProject.id == created["id"]))).scalar_one()
    project.quote_id = "E-EXISTING"
    project.quote_sync_state = "idle"
    project.quote_sync_failures = 3
    await db_session.commit()
    return {"id": created["id"], "task_id": task_id}


@pytest.mark.asyncio
async def test_creating_a_project_marks_it_pending(async_client):
    r = await _create(async_client, tasks=[_task()])
    assert r.status_code == 201
    assert r.json()["quote_sync_state"] == "pending"


@pytest.mark.asyncio
async def test_editing_a_project_marks_it_pending_and_clears_failures(async_client, idle_project, db_session):
    r = await async_client.patch(f"/api/v1/aito/{idle_project['id']}", json={"description": "Nouveau"})
    assert r.status_code == 200
    assert r.json()["quote_sync_state"] == "pending"
    row = (await db_session.execute(select(AitoProject).where(AitoProject.id == idle_project["id"]))).scalar_one()
    assert row.quote_sync_failures == 0


@pytest.mark.asyncio
async def test_adding_a_task_marks_its_project_pending(async_client, idle_project):
    r = await async_client.post(f"/api/v1/aito/{idle_project['id']}/tasks", json=_task(title="Deux"))
    assert r.status_code == 201
    board = (await async_client.get("/api/v1/aito/")).json()
    row = next(p for p in board if p["id"] == idle_project["id"])
    assert row["quote_sync_state"] == "pending"


@pytest.mark.asyncio
async def test_editing_a_task_marks_its_project_pending(async_client, idle_project):
    r = await async_client.patch(f"/api/v1/aito/tasks/{idle_project['task_id']}", json={"scan_cost": 99})
    assert r.status_code == 200
    board = (await async_client.get("/api/v1/aito/")).json()
    row = next(p for p in board if p["id"] == idle_project["id"])
    assert row["quote_sync_state"] == "pending"


@pytest.mark.asyncio
async def test_deleting_a_task_marks_its_project_pending(async_client, idle_project):
    r = await async_client.delete(f"/api/v1/aito/tasks/{idle_project['task_id']}")
    assert r.status_code == 204
    board = (await async_client.get("/api/v1/aito/")).json()
    row = next(p for p in board if p["id"] == idle_project["id"])
    assert row["quote_sync_state"] == "pending"


@pytest.mark.asyncio
async def test_deleting_a_project_marks_it_pending(async_client, idle_project, db_session):
    r = await async_client.delete(f"/api/v1/aito/{idle_project['id']}")
    assert r.status_code == 204
    row = (await db_session.execute(select(AitoProject).where(AitoProject.id == idle_project["id"]))).scalar_one()
    assert row.quote_sync_state == "pending"


@pytest.mark.asyncio
async def test_restoring_a_project_marks_it_pending(async_client, idle_project):
    await async_client.delete(f"/api/v1/aito/{idle_project['id']}")
    r = await async_client.post(f"/api/v1/aito/{idle_project['id']}/restore")
    assert r.status_code == 200
    assert r.json()["quote_sync_state"] == "pending"


@pytest.mark.asyncio
async def test_moving_a_project_does_not_mark_it_pending(async_client, db_session):
    """Which column a card sits in is production state, invisible to the quote.

    Uses a real cross-column move (Finish -> Done), not a same-column reorder:
    a same-column move never enters the branch that could regress and start
    marking the project pending on move."""
    p = await _create_accepted(async_client)  # lands unlocked in 'finish', no tasks
    project = (await db_session.execute(select(AitoProject).where(AitoProject.id == p["id"]))).scalar_one()
    project.quote_sync_state = "idle"
    project.quote_sync_failures = 3
    await db_session.commit()

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "done", "position": 0})
    assert r.status_code == 200
    assert r.json()["quote_sync_state"] == "idle"


@pytest.mark.asyncio
async def test_importing_legacy_projects_does_not_mark_them_pending(async_client):
    """Legacy cards get the explicit 'unmanaged' ownership marker (Critical 1
    fix), not 'idle' — 'idle' is also the state an ordinary project of ours
    can sit in, so it cannot double as "never touch this"."""
    payload = {"projects": [{"description": "legacy", "column": "print", "position": 0}]}
    r = await async_client.post("/api/v1/aito/import", json=payload)
    assert r.status_code == 201
    assert r.json()[0]["quote_sync_state"] == "unmanaged"


@pytest.mark.asyncio
async def test_importing_legacy_projects_derives_column_from_the_rules(async_client):
    """Important 5: import_legacy_projects used to write board_column straight
    from item.column with quote_status left NULL, so a card could land in
    `print` while the rules say `devis` — the same self-contradictory row
    Critical 2 fixes for the sync worker. An imported card must land wherever
    the rules put it, not wherever the legacy payload claims it was: with no
    quote_status and no tasks, that is always `devis`, locked on `quote`."""
    payload = {"projects": [{"description": "legacy", "column": "print", "position": 0}]}
    r = await async_client.post("/api/v1/aito/import", json=payload)
    assert r.status_code == 201
    body = r.json()[0]
    assert body["column"] == "devis"
    assert body["move_lock"] == "quote"


def test_import_item_schema_has_no_tasks_field():
    """import_legacy_projects passes TaskSummary() unconditionally, which is
    only correct because AitoProjectImportItem cannot carry tasks — imported
    projects are task-free by construction. If someone adds a `tasks` field
    to let legacy imports carry tasks, _to_response(p, TaskSummary()) would
    silently report task_count=0, tasks_total=0.0, task_services=[] for cards
    that do have tasks, and since the frontend writes that straight into the
    board cache, badges would blank without any error. This test is the trip
    wire: it must fail the day that field is added, pointing here so the
    import loop gets updated to build a real TaskSummary."""
    assert "tasks" not in AitoProjectImportItem.model_fields


def test_import_item_schema_has_no_shipping_fields():
    """Same trip wire as above, for shipping: import_legacy_projects passes
    _to_response(p, TaskSummary(), {}) — an explicit EMPTY map, not a resolved
    catalogue read — resting entirely on the claim that AitoProjectImportItem
    cannot carry a shipment. If someone adds a `shipping_island` (or any other
    `shipping_*`) field to let legacy imports carry one, that explicit {} would
    silently report shipping_service_name=None for a card that does have a
    shipment, and since the frontend writes that straight into the board
    cache, the name would blank without any error. This test is the trip
    wire: it must fail the day such a field is added, pointing here so the
    import loop gets updated to resolve a real shipping_names map."""
    assert not any(name.startswith("shipping_") for name in AitoProjectImportItem.model_fields)


@pytest.mark.asyncio
async def test_create_records_the_authenticated_creator(async_client):
    # There is no authenticated-client fixture in this suite, so the route's
    # own User dependency is overridden directly. Locating it by parameter
    # name is stable: `create_project` names it `current_user`.
    from backend.app.main import app
    from backend.app.models.user import User

    route = next(r for r in app.routes if getattr(r, "name", "") == "create_project")
    dep = next(d.call for d in route.dependant.dependencies if d.name == "current_user")
    app.dependency_overrides[dep] = lambda: User(id=1, username="paul")
    try:
        r = await _create(async_client, description="Made by Paul")
        assert r.status_code == 201
        assert r.json()["created_by"] == "paul"
    finally:
        app.dependency_overrides.pop(dep, None)


async def _add_task(client, project_id, **fields):
    return await client.post(f"/api/v1/aito/{project_id}/tasks", json=fields)


async def _create_accepted(client, **overrides):
    """Create a hand-made card, then accept it through the dedicated
    /quote-status route — the schema's _decided_status_needs_a_quote_id
    validator now rejects quote_status="accepted" at creation for a card
    with no quote_id, so tests that need an already-accepted card (to drive
    the board rules, not to test import) build one this way instead. Returns
    the accepted project's JSON, same shape as `(await _create(...)).json()`."""
    created = (await _create(client, **overrides)).json()
    accepted = await client.post(f"/api/v1/aito/{created['id']}/quote-status", json={"status": "accepted"})
    return accepted.json()["project"]


@pytest.mark.asyncio
async def test_a_new_card_is_locked_in_devis_by_its_quote(async_client):
    p = (await _create(async_client)).json()
    assert p["column"] == "devis"
    assert p["move_lock"] == "quote"


@pytest.mark.asyncio
async def test_accepting_derives_the_first_stage_with_work(async_client):
    p = (await _create(async_client, quote_status="draft")).json()
    await _add_task(async_client, p["id"], modelisation_cost=900.0, impression_cost=2400.0)
    await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "accepted"})

    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p["id"]]["column"] == "model"
    assert board[p["id"]]["move_lock"] == "steps"


@pytest.mark.asyncio
async def test_ticking_the_last_step_of_a_stage_advances_the_card(async_client):
    p = await _create_accepted(async_client)
    t = (await _add_task(async_client, p["id"], scan_cost=1200.0, impression_cost=2400.0)).json()

    r = await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_done": True})
    assert r.status_code == 200

    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p["id"]]["column"] == "print"


@pytest.mark.asyncio
async def test_all_steps_ticked_lands_on_finish_and_unlocks(async_client):
    p = await _create_accepted(async_client)
    t = (await _add_task(async_client, p["id"], scan_cost=1200.0)).json()
    await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_done": True})

    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p["id"]]["column"] == "finish"
    assert board[p["id"]]["move_lock"] is None


@pytest.mark.asyncio
async def test_a_zero_cost_step_still_holds_the_card(async_client):
    """0 is quoted-free, not absent."""
    p = await _create_accepted(async_client)
    await _add_task(async_client, p["id"], scan_cost=0.0)

    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p["id"]]["column"] == "scan"


@pytest.mark.asyncio
async def test_deleting_the_last_blocking_task_advances_the_card(async_client):
    p = await _create_accepted(async_client)
    t = (await _add_task(async_client, p["id"], scan_cost=1200.0)).json()
    await async_client.delete(f"/api/v1/aito/tasks/{t['id']}")

    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p["id"]]["column"] == "finish"


@pytest.mark.asyncio
async def test_an_advancing_card_lands_at_the_end_of_its_new_column(async_client):
    """Work arriving at a stage joins the back of that stage's queue."""
    sitting = await _create_accepted(async_client, description="already printing")
    await _add_task(async_client, sitting["id"], impression_cost=1.0)

    arriving = await _create_accepted(async_client, description="arriving")
    t = (await _add_task(async_client, arriving["id"], scan_cost=1.0, impression_cost=1.0)).json()
    await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_done": True})

    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[sitting["id"]]["column"] == "print" and board[sitting["id"]]["position"] == 0
    assert board[arriving["id"]]["column"] == "print" and board[arriving["id"]]["position"] == 1


@pytest.mark.asyncio
async def test_clearing_a_cost_also_clears_its_done_flag(async_client):
    """Otherwise re-enabling the service later would bring it back pre-ticked."""
    p = await _create_accepted(async_client)
    t = (await _add_task(async_client, p["id"], scan_cost=1200.0, scan_done=True)).json()

    r = await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_cost": None})
    assert r.status_code == 200
    assert r.json()["scan_done"] is False


@pytest.mark.asyncio
async def test_ticking_a_step_that_does_not_exist_is_422(async_client):
    p = await _create_accepted(async_client)
    t = (await _add_task(async_client, p["id"], scan_cost=1200.0)).json()

    r = await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"usinage_done": True})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_enabling_a_service_and_ticking_it_in_one_patch_is_allowed(async_client):
    """The check runs against the MERGED row, not the stored one."""
    p = await _create_accepted(async_client)
    t = (await _add_task(async_client, p["id"], scan_cost=1200.0)).json()

    r = await async_client.patch(
        f"/api/v1/aito/tasks/{t['id']}",
        json={"usinage_cost": 500.0, "usinage_done": True},
    )
    assert r.status_code == 200
    assert r.json()["usinage_done"] is True


@pytest.mark.asyncio
async def test_ticking_a_step_without_an_accepted_quote_is_422(async_client):
    """Acceptance is the gate that authorises the work. evaluate() already
    refuses to move such a card, so the tick is not merely premature — it is
    meaningless."""
    p = (await _create(async_client, quote_status="sent")).json()
    t = (await _add_task(async_client, p["id"], scan_cost=1200.0)).json()

    r = await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_done": True})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_ticking_a_step_with_no_quote_at_all_is_422(async_client):
    p = (await _create(async_client)).json()  # quote_status NULL
    t = (await _add_task(async_client, p["id"], scan_cost=1200.0)).json()

    r = await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_done": True})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_unticking_survives_the_quote_leaving_accepted(async_client):
    """A tick stranded by a status flip must always be undoable — otherwise a
    mis-declined project keeps work marked done with no way back."""
    p = await _create_accepted(async_client)
    t = (await _add_task(async_client, p["id"], scan_cost=1200.0, scan_done=True)).json()
    await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "declined"})

    r = await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_done": False})
    assert r.status_code == 200
    assert r.json()["scan_done"] is False


@pytest.mark.asyncio
async def test_adding_a_pre_ticked_task_needs_an_accepted_quote(async_client):
    p = (await _create(async_client, quote_status="draft")).json()
    r = await _add_task(async_client, p["id"], scan_cost=1200.0, scan_done=True)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_creating_with_pre_ticked_tasks_needs_an_accepted_quote(async_client):
    r = await _create(async_client, tasks=[{"title": "a", "scan_cost": 1200.0, "scan_done": True}])
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_update_rejection_names_the_service_and_the_gate(async_client):
    """Pins _reject_ticks_without_acceptance's wording, not just its status
    code, so a message rewrite (or a swap for the wrong 422, e.g. the "no
    cost" guard) is caught here rather than passing silently."""
    p = (await _create(async_client, quote_status="sent")).json()
    t = (await _add_task(async_client, p["id"], scan_cost=1200.0)).json()

    r = await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_done": True})
    assert r.status_code == 422
    assert r.json()["detail"] == "scan cannot be marked done until the quote is accepted"


@pytest.mark.asyncio
async def test_add_task_rejection_names_the_service_and_the_gate(async_client):
    p = (await _create(async_client, quote_status="draft")).json()

    r = await _add_task(async_client, p["id"], scan_cost=1200.0, scan_done=True)
    assert r.status_code == 422
    assert r.json()["detail"] == "scan cannot be marked done until the quote is accepted"


@pytest.mark.asyncio
@pytest.mark.parametrize("service", SERVICES)
@pytest.mark.parametrize("quote_status", [None, "draft", "sent"])
async def test_every_service_is_gated_on_update_regardless_of_status(async_client, service, quote_status):
    """Sweeps all four services against every non-accepted status the create
    endpoint can seed directly, to pin that the guard treats them uniformly
    rather than special-casing one service or one unaccepted status."""
    overrides = {} if quote_status is None else {"quote_status": quote_status}
    p = (await _create(async_client, **overrides)).json()
    t = (await _add_task(async_client, p["id"], **{f"{service}_cost": 1200.0})).json()

    r = await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={f"{service}_done": True})
    assert r.status_code == 422
    assert r.json()["detail"] == f"{service} cannot be marked done until the quote is accepted"


@pytest.mark.asyncio
@pytest.mark.parametrize("service", SERVICES)
async def test_every_service_is_gated_on_add_task(async_client, service):
    p = (await _create(async_client, quote_status="draft")).json()

    r = await _add_task(async_client, p["id"], **{f"{service}_cost": 1200.0, f"{service}_done": True})
    assert r.status_code == 422
    assert r.json()["detail"] == f"{service} cannot be marked done until the quote is accepted"


async def _add_task_as(client, project_id, permissions, **fields):
    """Add a task as a user whose ONLY permissions are `permissions` (via a
    throwaway in-memory group, never persisted). Mirrors _create_as's
    dependency-override technique (see test_create_with_a_decided_status_and
    _only_aito_create_is_403 and friends), applied to add_task's
    `current_user` dependency instead of create_project's."""
    from backend.app.main import app
    from backend.app.models.group import Group
    from backend.app.models.user import User

    route = next(r for r in app.routes if getattr(r, "name", "") == "add_task")
    dep = next(d.call for d in route.dependant.dependencies if d.name == "current_user")
    app.dependency_overrides[dep] = lambda: User(
        id=1, username="paul", groups=[Group(name="t", permissions=list(permissions))]
    )
    try:
        return await _add_task(client, project_id, **fields)
    finally:
        app.dependency_overrides.pop(dep, None)


@pytest.mark.asyncio
async def test_add_task_with_a_ticked_step_and_only_aito_create_is_403(async_client):
    """T-001: aito:create alone must not be able to stamp a ticked step onto
    an EXISTING accepted project — that used to sail through unaudited (the
    quote-acceptance gate above only checks the quote's status, not the
    caller's permissions) and let the sync worker push the priced line
    straight onto the live Zoho estimate via _update_quote's full
    line_items rebuild. A caller must also hold aito:update, mirroring
    create_project's T-036 gate on quote_status."""
    p = await _create_accepted(async_client)
    r = await _add_task_as(async_client, p["id"], ["aito:create"], scan_cost=1200.0, scan_done=True)
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_add_task_with_a_ticked_step_and_only_aito_create_on_a_non_accepted_project_is_422(async_client):
    """T-001 remediation: the aito:update gate above only applies to an
    ALREADY-ACCEPTED project (see test_add_task_with_a_ticked_step_and_only_
    aito_create_is_403). Against a non-accepted project, _reject_ticks_
    without_acceptance still runs FIRST, so an aito:create-only caller gets
    the pre-existing 422 quote-acceptance error, not the new 403 — the 403
    check never even evaluates the caller's permissions here. This pins the
    ordering: moving the 403 check before the 422 check would flip this
    response and is the regression this test exists to catch."""
    p = (await _create(async_client, quote_status="draft")).json()
    r = await _add_task_as(async_client, p["id"], ["aito:create"], scan_cost=1200.0, scan_done=True)
    assert r.status_code == 422
    assert r.json()["detail"] == "scan cannot be marked done until the quote is accepted"


@pytest.mark.asyncio
async def test_add_task_with_no_ticked_steps_and_only_aito_create_still_works(async_client):
    """T-001: the new gate only fires when a *_done flag is truthy on the
    payload — the common case, adding an unticked task, is unaffected for an
    aito:create-only caller."""
    p = await _create_accepted(async_client)
    r = await _add_task_as(async_client, p["id"], ["aito:create"], scan_cost=1200.0)
    assert r.status_code == 201
    assert r.json()["scan_done"] is False


@pytest.mark.asyncio
async def test_add_task_with_a_ticked_step_and_aito_update_succeeds(async_client):
    """T-001: the default Operators group (and any custom group granting
    both) is unaffected — a caller holding aito:update alongside aito:create
    can still add a pre-ticked task to an accepted project."""
    p = await _create_accepted(async_client)
    r = await _add_task_as(async_client, p["id"], ["aito:create", "aito:update"], scan_cost=1200.0, scan_done=True)
    assert r.status_code == 201
    assert r.json()["scan_done"] is True


@pytest.mark.asyncio
async def test_add_task_with_a_ticked_step_is_unaffected_when_auth_is_disabled(async_client):
    """T-001: RequirePermissionIfAuthEnabled returns None (not a User) when
    auth is off, and the new gate only applies when there IS a current_user
    — an auth-disabled instance must keep working exactly as it did before
    this task, same as test_add_task_rejection_names_the_service_and_the_gate
    relying on the unauthenticated `async_client` fixture."""
    p = await _create_accepted(async_client)
    r = await _add_task(async_client, p["id"], scan_cost=1200.0, scan_done=True)
    assert r.status_code == 201
    assert r.json()["scan_done"] is True


@pytest.mark.asyncio
async def test_ticking_a_new_step_after_a_decline_is_still_422(async_client):
    """Complements test_unticking_survives_the_quote_leaving_accepted: a
    decline unblocks undoing an existing tick, but must not reopen the gate
    for ticking a step that was never done."""
    p = (await _create(async_client, quote_status="draft")).json()
    t = (await _add_task(async_client, p["id"], scan_cost=1200.0)).json()
    await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "declined"})

    r = await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_done": True})
    assert r.status_code == 422
    assert r.json()["detail"] == "scan cannot be marked done until the quote is accepted"


@pytest.mark.asyncio
@pytest.mark.parametrize("service", SERVICES)
async def test_every_service_may_be_ticked_once_the_quote_is_accepted(async_client, service):
    """The guard's positive invariant: acceptance is sufficient, for every
    service, not just the ones exercised by the column-movement tests above."""
    p = await _create_accepted(async_client)
    t = (await _add_task(async_client, p["id"], **{f"{service}_cost": 1200.0})).json()

    r = await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={f"{service}_done": True})
    assert r.status_code == 200
    assert r.json()[f"{service}_done"] is True


@pytest.mark.asyncio
async def test_importing_an_accepted_quote_may_carry_ticked_steps(async_client):
    """An import that legitimately arrives already-accepted is not blocked."""
    r = await _create(
        async_client,
        quote_id="EST-9",
        quote_status="accepted",
        tasks=[{"title": "a", "scan_cost": 1200.0, "scan_done": True}],
    )
    assert r.status_code == 201


@pytest.mark.asyncio
async def test_unticking_a_step_pulls_the_card_back(async_client):
    p = await _create_accepted(async_client)
    t = (await _add_task(async_client, p["id"], scan_cost=1200.0)).json()
    await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_done": True})

    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p["id"]]["column"] == "finish"

    await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_done": False})
    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p["id"]]["column"] == "scan"


@pytest.mark.asyncio
async def test_declining_sends_the_card_to_done(async_client):
    p = (await _create(async_client, quote_status="draft")).json()
    await _add_task(async_client, p["id"], impression_cost=2400.0)

    r = await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "declined"})
    assert r.status_code == 200
    assert r.json()["project"]["column"] == "done"
    assert r.json()["project"]["quote_status"] == "declined"
    assert r.json()["project"]["move_lock"] == "declined"


@pytest.mark.asyncio
async def test_accepting_a_declined_quote_reopens_it(async_client):
    """declined -> accepted is the deliberate reopen path (Task 3's hybrid
    guard is asymmetric on purpose: QuoteStatusActions.tsx offers Accept on a
    declined card, so "latest go-ahead wins" here is not a conflict, unlike
    accepted -> anything or declined -> sent — see
    test_aito_quote_status_conflicts.py::test_reaccepting_a_declined_quote_reopens_it)."""
    p = (await _create(async_client, quote_status="draft")).json()
    await _add_task(async_client, p["id"], impression_cost=2400.0)
    await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "declined"})

    r = await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "accepted"})
    assert r.json()["project"]["column"] == "print"


@pytest.mark.asyncio
async def test_marking_sent_parks_the_card_in_waiting(async_client):
    """Locked there whatever the tasks say: the work is not authorised yet."""
    p = (await _create(async_client)).json()
    await _add_task(async_client, p["id"], impression_cost=2400.0)

    r = await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "sent"})
    assert r.status_code == 200
    assert r.json()["project"]["column"] == "waiting"
    assert r.json()["project"]["move_lock"] == "waiting"


@pytest.mark.asyncio
async def test_accepting_from_waiting_lands_on_the_right_stage(async_client):
    """Rewritten for Task 3's hybrid guard, which makes "accepted" terminal:
    the original test seeded the project already-accepted, ticked a step (only
    legal once accepted — see `_reject_ticks_without_acceptance`), THEN sent
    it back out and re-accepted it, asserting the earlier tick survived the
    round trip. That accepted -> sent leg is exactly the conflict the guard
    409s on now (old double-apply behavior), so the round trip itself is gone.

    What remains reachable, and is what this test now checks: draft -> sent
    parks the card in waiting with no ticks possible yet; accepting from
    there derives the stage from the tasks' (untouched) pending set, landing
    on the first stage with outstanding work; and a tick made afterwards
    (now legal, since the project is accepted) still advances the column via
    the task PATCH route alone, with no further quote-status call needed.
    """
    p = (await _create(async_client, quote_status="draft")).json()
    t = (await _add_task(async_client, p["id"], scan_cost=1.0, impression_cost=1.0)).json()

    await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "sent"})
    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p["id"]]["column"] == "waiting"

    r = await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "accepted"})
    assert r.json()["project"]["column"] == "scan"

    await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_done": True})
    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p["id"]]["column"] == "print"


@pytest.mark.asyncio
async def test_quote_status_rejects_an_unknown_status(async_client):
    p = (await _create(async_client)).json()
    r = await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "viewed"})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_a_card_with_no_quote_never_calls_zoho(async_client, monkeypatch):
    from backend.app.services import zoho as zoho_module

    calls = []

    async def _spy(self, db, estimate_id, status):
        calls.append((estimate_id, status))

    monkeypatch.setattr(zoho_module.ZohoService, "set_estimate_status", _spy)

    p = (await _create(async_client)).json()  # no quote_id
    r = await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "accepted"})
    assert r.status_code == 200
    assert r.json()["zoho_synced"] is False
    assert calls == []


@pytest.mark.asyncio
async def test_a_linked_quote_is_pushed_to_zoho(async_client, monkeypatch):
    from backend.app.services import zoho as zoho_module

    calls = []

    async def _spy(self, db, estimate_id, status):
        calls.append((estimate_id, status))

    async def _sent(self, db, estimate_id):
        return {"status": "sent"}

    monkeypatch.setattr(zoho_module.ZohoService, "set_estimate_status", _spy)
    monkeypatch.setattr(zoho_module.ZohoService, "get_estimate", _sent)

    p = (await _create(async_client, quote_id="EST-9", quote_number="QT-9")).json()
    r = await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "accepted"})
    assert r.json()["zoho_synced"] is True
    assert calls == [("EST-9", "accepted")]


@pytest.mark.asyncio
async def test_a_draft_quote_is_marked_sent_before_accepted(async_client, monkeypatch):
    """Books enforces draft -> sent -> accepted and rejects the shortcut with a
    400 whose message is localised, so the status is READ, never parsed."""
    from backend.app.services import zoho as zoho_module

    calls = []

    async def _spy(self, db, estimate_id, status):
        calls.append((estimate_id, status))

    async def _draft(self, db, estimate_id):
        return {"status": "draft"}

    monkeypatch.setattr(zoho_module.ZohoService, "set_estimate_status", _spy)
    monkeypatch.setattr(zoho_module.ZohoService, "get_estimate", _draft)

    p = (await _create(async_client, quote_id="EST-9", quote_status="draft")).json()
    r = await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "accepted"})
    assert r.json()["zoho_synced"] is True
    assert calls == [("EST-9", "sent"), ("EST-9", "accepted")]


@pytest.mark.asyncio
async def test_an_already_sent_quote_is_accepted_in_one_call(async_client, monkeypatch):
    from backend.app.services import zoho as zoho_module

    calls = []

    async def _spy(self, db, estimate_id, status):
        calls.append((estimate_id, status))

    async def _sent(self, db, estimate_id):
        return {"status": "sent"}

    monkeypatch.setattr(zoho_module.ZohoService, "set_estimate_status", _spy)
    monkeypatch.setattr(zoho_module.ZohoService, "get_estimate", _sent)

    p = (await _create(async_client, quote_id="EST-9", quote_status="sent")).json()
    r = await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "accepted"})
    assert r.json()["zoho_synced"] is True
    assert calls == [("EST-9", "accepted")]


@pytest.mark.asyncio
async def test_marking_sent_never_reads_the_estimate(async_client, monkeypatch):
    """`sent` is not one of the statuses Books gates, so it costs no extra read."""
    from backend.app.services import zoho as zoho_module

    calls = []
    reads = []

    async def _spy(self, db, estimate_id, status):
        calls.append((estimate_id, status))

    async def _read(self, db, estimate_id):
        reads.append(estimate_id)
        return {"status": "draft"}

    monkeypatch.setattr(zoho_module.ZohoService, "set_estimate_status", _spy)
    monkeypatch.setattr(zoho_module.ZohoService, "get_estimate", _read)

    p = (await _create(async_client, quote_id="EST-9", quote_status="draft")).json()
    await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "sent"})
    assert calls == [("EST-9", "sent")]
    assert reads == []


@pytest.mark.asyncio
async def test_an_unreadable_estimate_status_does_not_block_the_push(async_client, monkeypatch):
    """An estimate whose status Books omits is not evidence of a draft. Fail
    OPEN: attempt the target, exactly as before this guard existed."""
    from backend.app.services import zoho as zoho_module

    calls = []

    async def _spy(self, db, estimate_id, status):
        calls.append((estimate_id, status))

    async def _empty(self, db, estimate_id):
        return {}

    monkeypatch.setattr(zoho_module.ZohoService, "set_estimate_status", _spy)
    monkeypatch.setattr(zoho_module.ZohoService, "get_estimate", _empty)

    p = (await _create(async_client, quote_id="EST-9")).json()
    await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "accepted"})
    assert calls == [("EST-9", "accepted")]


@pytest.mark.asyncio
async def test_a_zoho_failure_still_writes_locally(async_client, monkeypatch):
    """The board must be right with Zoho down. Never a non-200."""
    from backend.app.services import zoho as zoho_module

    async def _boom(self, db, estimate_id, status):
        raise RuntimeError("Zoho is down")

    async def _sent(self, db, estimate_id):
        return {"status": "sent"}

    monkeypatch.setattr(zoho_module.ZohoService, "set_estimate_status", _boom)
    monkeypatch.setattr(zoho_module.ZohoService, "get_estimate", _sent)

    p = (await _create(async_client, quote_id="EST-9")).json()
    await _add_task(async_client, p["id"], impression_cost=1.0)

    r = await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "accepted"})
    assert r.status_code == 200
    assert r.json()["zoho_synced"] is False
    assert r.json()["project"]["quote_status"] == "accepted"
    assert r.json()["project"]["column"] == "print"


@pytest.mark.asyncio
async def test_importing_ten_projects_runs_no_task_queries(async_client, db_session):
    """import_legacy_projects used to call _apply_rules in a loop, so it ran one
    task SELECT per project — for rows that cannot exist, since imported
    projects are task-free by construction."""
    task_selects = 0
    project_selects = 0

    def count_task_selects(conn, cursor, statement, parameters, context, executemany):
        nonlocal task_selects, project_selects
        normalised = " ".join(statement.split()).lower()
        if normalised.startswith("select") and "from aito_tasks" in normalised:
            task_selects += 1
        if normalised.startswith("select") and "from aito_projects" in normalised:
            project_selects += 1

    # db_session.get_bind() already resolves to the underlying sync Engine
    # (identical to test_engine.sync_engine) rather than a Connection or
    # AsyncEngine, because get_bind() on an AsyncSession unwraps straight to
    # the sync engine. The async_client fixture's own sessions are bound to
    # that same test_engine, so listening here also sees the requests made
    # through the HTTP client below.
    engine = db_session.get_bind()
    event.listen(engine, "before_cursor_execute", count_task_selects)
    try:
        response = await async_client.post(
            "/api/v1/aito/import",
            json={"projects": [{"description": f"legacy {i}", "column": "devis", "position": i} for i in range(10)]},
        )
        assert response.status_code == 201
    finally:
        event.remove(engine, "before_cursor_execute", count_task_selects)

    assert task_selects == 0, f"expected no aito_tasks SELECT, saw {task_selects}"
    # Positive control: proves the listener actually observes the request's
    # traffic. Without this, a conftest change that gave the HTTP client its
    # own engine would silence the listener entirely and task_selects == 0
    # would pass vacuously forever, hiding a real N+1 regression.
    assert project_selects > 0, "expected the listener to observe aito_projects SELECTs, saw none"


@pytest.mark.asyncio
async def test_an_imported_card_is_as_old_as_its_quote(async_client):
    """Noon, not midnight: the frontend reads timestamps as UTC, so midnight
    would render as the previous day everywhere west of Greenwich."""
    r = await _create(async_client, quote_id="EST-9", quote_date="2026-07-15")
    assert r.status_code == 201
    assert r.json()["created_at"].startswith("2026-07-15T12:00:00")


@pytest.mark.asyncio
async def test_a_hand_made_card_keeps_its_real_creation_time(async_client):
    r = await _create(async_client, quote_date="2026-07-15")  # no quote_id: not an import
    assert not r.json()["created_at"].startswith("2026-07-15T12:00:00")


@pytest.mark.asyncio
async def test_an_unparseable_quote_date_falls_back_to_now(async_client):
    """quote_date is a client-supplied string, not a trusted value."""
    r = await _create(async_client, quote_id="EST-9", quote_date="15/07/2026")
    assert r.status_code == 201
    assert not r.json()["created_at"].startswith("2026-07-15")
    assert _seconds_since(r.json()["created_at"]) < 300


@pytest.mark.asyncio
async def test_an_import_with_no_quote_date_falls_back_to_now(async_client):
    r = await _create(async_client, quote_id="EST-9")
    assert r.status_code == 201
    assert _seconds_since(r.json()["created_at"]) < 300


@pytest.mark.asyncio
async def test_a_quote_may_back_only_one_active_project(async_client):
    first = await _create(async_client, quote_id="EST-9", quote_number="QT-9")
    assert first.status_code == 201

    second = await _create(async_client, quote_id="EST-9", quote_number="QT-9")
    assert second.status_code == 409


@pytest.mark.asyncio
async def test_trashing_a_project_frees_its_quote_for_re_import(async_client):
    """An established workflow, not an accident — the live board has five
    quotes with one active project and one or more trashed ones."""
    first = (await _create(async_client, quote_id="EST-9")).json()
    await async_client.delete(f"/api/v1/aito/{first['id']}")

    second = await _create(async_client, quote_id="EST-9")
    assert second.status_code == 201


@pytest.mark.asyncio
async def test_restoring_cannot_produce_a_second_project_for_one_quote(async_client):
    """Otherwise restore would break the very rule this task adds — and, once
    the partial unique index exists, would surface as a 500 rather than a 409."""
    first = (await _create(async_client, quote_id="EST-9")).json()
    await async_client.delete(f"/api/v1/aito/{first['id']}")
    await _create(async_client, quote_id="EST-9")  # the quote's new active project

    r = await async_client.post(f"/api/v1/aito/{first['id']}/restore")
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_restoring_is_fine_when_the_quote_is_free(async_client):
    first = (await _create(async_client, quote_id="EST-9")).json()
    await async_client.delete(f"/api/v1/aito/{first['id']}")

    r = await async_client.post(f"/api/v1/aito/{first['id']}/restore")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_hand_made_cards_are_never_duplicates_of_each_other(async_client):
    """quote_id NULL is the normal case for a hand-made card and must not
    collide with every other hand-made card."""
    assert (await _create(async_client)).status_code == 201
    assert (await _create(async_client)).status_code == 201


@pytest.mark.asyncio
async def test_changing_the_board_status_clears_a_recorded_block(async_client, db_session):
    """set_quote_status owns our side, so it owns invalidating the record.

    This is the invariant that lets `quote_status_remote` alone identify a
    blocked attempt: our side cannot drift away from the recorded attempt
    without the record being cleared, so the reconciler never has to store
    (and re-parse) the pair.

    Seeded as "sent" rather than "accepted": Task 3's hybrid guard makes
    "accepted" terminal, and accepted -> declined is exactly the conflict
    that guard exists to 409 on. "sent" is not terminal, so sent -> declined
    is an ordinary progression that still exercises the block-clearing path.
    """
    created = (await _create(async_client, quote_status="sent")).json()
    project = (await db_session.execute(select(AitoProject).where(AitoProject.id == created["id"]))).scalar_one()
    project.quote_status_block = "rejected"
    project.quote_status_remote = "draft"
    await db_session.commit()

    r = await async_client.post(f"/api/v1/aito/{created['id']}/quote-status", json={"status": "declined"})
    assert r.status_code == 200
    assert r.json()["project"]["quote_status_block"] is None
    assert r.json()["project"]["quote_status_remote"] is None

    row = (await db_session.execute(select(AitoProject).where(AitoProject.id == created["id"]))).scalar_one()
    await db_session.refresh(row)
    assert row.quote_status_block is None
    assert row.quote_status_remote is None


@pytest.mark.asyncio
async def test_quote_pdf_streams_the_document(async_client, db_session, monkeypatch):
    project = AitoProject(description="Trophy", board_column="devis", quote_id="EST-7")
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    async def fake_pdf(db, estimate_id):
        assert estimate_id == "EST-7"
        return b"%PDF-1.4 body"

    monkeypatch.setattr(zoho_service, "get_estimate_pdf", fake_pdf)

    response = await async_client.get(f"/api/v1/aito/{project.id}/quote.pdf")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.content == b"%PDF-1.4 body"
    assert "inline" in response.headers["content-disposition"]


@pytest.mark.asyncio
async def test_quote_pdf_404s_without_a_quote(async_client, db_session):
    """A hand-made card has no estimate to print, and must say so rather than
    ask Zoho for the PDF of ``None``."""
    project = AitoProject(description="Hand-made", board_column="devis")
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    response = await async_client.get(f"/api/v1/aito/{project.id}/quote.pdf")
    assert response.status_code == 404
    # Assert the BODY, not just the status: FastAPI answers an unmatched path
    # with 404 too, so a bare status assertion passes even when the route does
    # not exist and proves nothing about this branch.
    assert response.json()["detail"] == "This project has no Zoho quote"


@pytest.mark.asyncio
async def test_quote_pdf_maps_zoho_failure_to_502(async_client, db_session, monkeypatch):
    project = AitoProject(description="Trophy", board_column="devis", quote_id="EST-7")
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    async def boom(db, estimate_id):
        raise ZohoUpstreamError("Zoho Books unreachable: ConnectError")

    monkeypatch.setattr(zoho_service, "get_estimate_pdf", boom)

    response = await async_client.get(f"/api/v1/aito/{project.id}/quote.pdf")
    assert response.status_code == 502


@pytest.mark.asyncio
async def test_board_ships_a_step_row_per_task(async_client, db_session):
    """The card draws one pill row per entry, so the shape matters as much as
    the counters: canonical order regardless of the order the costs were
    given, a free (0) step present, and a done flag on an unpriced service
    absent from both lists."""
    created = (
        await async_client.post(
            "/api/v1/aito/",
            json={
                "description": "steps per task",
                "client_id": "S1",
                "client_name": "Steps",
                "client_phone": "+689 87 00 00 07",
            },
        )
    ).json()
    # A tick requires acceptance (see _reject_ticks_without_acceptance), and
    # quote_status="accepted" needs a quote_id at creation time — go through
    # the dedicated route instead, then add the (pre-ticked) tasks.
    await async_client.post(f"/api/v1/aito/{created['id']}/quote-status", json={"status": "accepted"})
    await async_client.post(
        f"/api/v1/aito/{created['id']}/tasks",
        json={"title": "t1", "impression_cost": 2000, "scan_cost": 1000, "scan_done": True},
    )
    await async_client.post(
        f"/api/v1/aito/{created['id']}/tasks",
        json={"title": "t2", "usinage_cost": 0, "modelisation_done": True},
    )

    board = (await async_client.get("/api/v1/aito/")).json()
    card = next(p for p in board if p["description"] == "steps per task")
    assert card["task_steps"] == [
        {"services": ["scan", "impression"], "done": ["scan"], "title": "t1"},
        {"services": ["usinage"], "done": [], "title": "t2"},
    ]


@pytest.mark.asyncio
async def test_task_steps_carry_titles(async_client):
    """A task's own name rides along on its step row, so a per-task card row
    can say WHICH task is stuck rather than showing an anonymous pill grid.
    An untitled task still needs a row — it normalises to "" and the frontend
    supplies the fallback name, it does not vanish from the list."""
    await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "titled steps",
            "client_id": "T1",
            "client_name": "Titles",
            "client_phone": "+689 87 00 00 08",
            "tasks": [
                {"title": "Support principal", "scan_cost": 10},
                {"scan_cost": 20},
            ],
        },
    )

    body = (await async_client.get("/api/v1/aito/")).json()
    card = next(p for p in body if p["description"] == "titled steps")
    steps = card["task_steps"]
    assert steps[0]["title"] == "Support principal"
    assert steps[1]["title"] == ""


@pytest.mark.asyncio
async def test_create_requires_phone_or_email(async_client):
    r = await _create(async_client, client_phone=None, client_email=None)
    assert r.status_code == 400
    assert "phone, an email or a social handle" in r.json()["detail"]


@pytest.mark.asyncio
async def test_create_email_only_is_reachable(async_client):
    r = await _create(async_client, client_phone=None, client_email="a@b.pf")
    assert r.status_code == 201


@pytest.mark.asyncio
async def test_import_shape_bypasses_reachability(async_client):
    # A quote-import create carries quote_id; Zoho contacts may lack both
    # channels and importing an existing quote must never be blocked.
    r = await _create(
        async_client, client_phone=None, client_email=None, quote_id="q-1", quote_number="EST-1", quote_status="draft"
    )
    assert r.status_code == 201


@pytest.mark.asyncio
async def test_accepting_stamps_quote_accepted_at(async_client):
    created = await _create(async_client)
    assert created.json()["quote_accepted_at"] is None

    r = await async_client.post(f"/api/v1/aito/{created.json()['id']}/quote-status", json={"status": "accepted"})

    stamped = r.json()["project"]["quote_accepted_at"]
    assert stamped is not None
    assert _seconds_since(stamped) < 60


@pytest.mark.asyncio
async def test_declining_an_accepted_quote_is_a_conflict_that_preserves_the_stamp(async_client):
    """accepted -> declined is exactly the conflict Task 3's hybrid guard
    409s on (see test_aito_quote_status_conflicts.py::test_conflicting_decision_is_409),
    so the decline never applies; this test now checks the corollary — a
    rejected attempt must not perturb quote_accepted_at either. Previously
    this asserted the decline succeeded and the stamp survived it; that
    success path is the old double-apply behavior the guard removes."""
    created = await _create(async_client)
    pid = created.json()["id"]
    accepted = await async_client.post(f"/api/v1/aito/{pid}/quote-status", json={"status": "accepted"})
    first = accepted.json()["project"]["quote_accepted_at"]

    declined = await async_client.post(f"/api/v1/aito/{pid}/quote-status", json={"status": "declined"})
    assert declined.status_code == 409

    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[pid]["quote_status"] == "accepted"
    assert board[pid]["quote_accepted_at"] == first


@pytest.mark.asyncio
async def test_new_projects_have_no_flag(async_client):
    """The flag is opt-in. A card nobody has touched must never glow."""
    created = await _create(async_client)
    assert created.status_code == 201
    assert created.json()["flag"] is None

    listed = await async_client.get("/api/v1/aito/")
    assert [p["flag"] for p in listed.json()] == [None]


@pytest.mark.asyncio
async def test_flag_toggles_and_never_queues_a_zoho_push(async_client, db_session):
    """The whole reason this has its own route. update_project ends with an
    unconditional _mark_pending_if_ours, so routing `flag` through it would
    queue a quote push for a field the quote does not have — and churn the
    sync state on locked quotes, where writes are already known to be unsafe."""
    project_id = (await _create(async_client)).json()["id"]

    before = (await db_session.execute(select(AitoProject).where(AitoProject.id == project_id))).scalar_one()
    sync_state_before = before.quote_sync_state
    failures_before = before.quote_sync_failures

    flagged = await async_client.patch(f"/api/v1/aito/{project_id}/flag", json={"flag": "urgent"})
    assert flagged.status_code == 200
    assert flagged.json()["flag"] == "urgent"

    db_session.expire_all()
    after = (await db_session.execute(select(AitoProject).where(AitoProject.id == project_id))).scalar_one()
    assert after.quote_sync_state == sync_state_before
    assert after.quote_sync_failures == failures_before

    # Switching flags is still a purely local write, not just clearing one.
    switched = await async_client.patch(f"/api/v1/aito/{project_id}/flag", json={"flag": "sav"})
    assert switched.status_code == 200
    assert switched.json()["flag"] == "sav"

    db_session.expire_all()
    after_switch = (await db_session.execute(select(AitoProject).where(AitoProject.id == project_id))).scalar_one()
    assert after_switch.quote_sync_state == sync_state_before
    assert after_switch.quote_sync_failures == failures_before

    # pause is the third flag value and gets the same guarantee.
    paused = await async_client.patch(f"/api/v1/aito/{project_id}/flag", json={"flag": "pause"})
    assert paused.status_code == 200
    assert paused.json()["flag"] == "pause"

    db_session.expire_all()
    after_pause = (await db_session.execute(select(AitoProject).where(AitoProject.id == project_id))).scalar_one()
    assert after_pause.quote_sync_state == sync_state_before
    assert after_pause.quote_sync_failures == failures_before

    cleared = await async_client.patch(f"/api/v1/aito/{project_id}/flag", json={"flag": None})
    assert cleared.status_code == 200
    assert cleared.json()["flag"] is None


@pytest.mark.asyncio
async def test_flag_records_one_story_event_per_real_change(async_client):
    """Double-taps must not spam the timeline: an unchanged value records
    nothing, so the history reads as decisions rather than as button presses."""
    project_id = (await _create(async_client)).json()["id"]

    await async_client.patch(f"/api/v1/aito/{project_id}/flag", json={"flag": "urgent"})
    await async_client.patch(f"/api/v1/aito/{project_id}/flag", json={"flag": "urgent"})  # no-op
    await async_client.patch(f"/api/v1/aito/{project_id}/flag", json={"flag": None})

    events = (await async_client.get(f"/api/v1/aito/{project_id}/events?depth=story")).json()["events"]
    kinds = [e["kind"] for e in events]
    assert kinds.count("project.urgent.set") == 1
    assert kinds.count("project.urgent.cleared") == 1


@pytest.mark.asyncio
async def test_switching_flags_records_the_clear_and_the_set(async_client):
    """Two things changed, so the timeline says two things. No new renderer is
    needed: both kinds already map to their own label."""
    project_id = (await _create(async_client)).json()["id"]

    await async_client.patch(f"/api/v1/aito/{project_id}/flag", json={"flag": "urgent"})
    await async_client.patch(f"/api/v1/aito/{project_id}/flag", json={"flag": "sav"})

    events = (await async_client.get(f"/api/v1/aito/{project_id}/events?depth=story")).json()["events"]
    kinds = [e["kind"] for e in events]
    assert kinds.count("project.urgent.cleared") == 1
    assert kinds.count("project.sav.set") == 1
    assert kinds.count("project.urgent.set") == 1


@pytest.mark.asyncio
async def test_pause_flag_sets_and_clears_with_one_event_each(async_client):
    """Pause is a first-class flag value: it round-trips through the same
    route and writes the same one-event-per-real-change timeline as the
    other two, including the no-op on a repeat."""
    project_id = (await _create(async_client)).json()["id"]

    r = await async_client.patch(f"/api/v1/aito/{project_id}/flag", json={"flag": "pause"})
    assert r.status_code == 200
    assert r.json()["flag"] == "pause"

    await async_client.patch(f"/api/v1/aito/{project_id}/flag", json={"flag": "pause"})  # no-op

    r = await async_client.patch(f"/api/v1/aito/{project_id}/flag", json={"flag": None})
    assert r.status_code == 200
    assert r.json()["flag"] is None

    events = (await async_client.get(f"/api/v1/aito/{project_id}/events?depth=story")).json()["events"]
    kinds = [e["kind"] for e in events]
    assert kinds.count("project.pause.set") == 1
    assert kinds.count("project.pause.cleared") == 1


@pytest.mark.asyncio
async def test_switching_urgent_to_pause_records_the_clear_and_the_set(async_client):
    """Two things changed, so the timeline says two things — and no new
    renderer is needed, because both kinds map to their own label."""
    project_id = (await _create(async_client)).json()["id"]

    await async_client.patch(f"/api/v1/aito/{project_id}/flag", json={"flag": "urgent"})
    await async_client.patch(f"/api/v1/aito/{project_id}/flag", json={"flag": "pause"})

    events = (await async_client.get(f"/api/v1/aito/{project_id}/events?depth=story")).json()["events"]
    kinds = [e["kind"] for e in events]
    assert kinds.count("project.urgent.set") == 1
    assert kinds.count("project.urgent.cleared") == 1
    assert kinds.count("project.pause.set") == 1


@pytest.mark.asyncio
async def test_flag_rejects_an_unknown_value(async_client):
    project_id = (await _create(async_client)).json()["id"]

    r = await async_client.patch(f"/api/v1/aito/{project_id}/flag", json={"flag": "later"})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_flag_404s_on_a_trashed_project(async_client):
    project_id = (await _create(async_client)).json()["id"]
    await async_client.delete(f"/api/v1/aito/{project_id}")

    r = await async_client.patch(f"/api/v1/aito/{project_id}/flag", json={"flag": "urgent"})
    assert r.status_code == 404


def test_social_pair_rejects_a_handle_without_a_network():
    from pydantic import ValidationError

    from backend.app.schemas.aito import AitoProjectCreate

    with pytest.raises(ValidationError, match="client_social_network is required"):
        AitoProjectCreate(
            description="a job",
            client_id="c1",
            client_name="Client",
            client_social_handle="aito.3d",
        )


def test_social_pair_rejects_an_unknown_network():
    from pydantic import ValidationError

    from backend.app.schemas.aito import AitoProjectCreate

    with pytest.raises(ValidationError, match="client_social_network must be one of"):
        AitoProjectCreate(
            description="a job",
            client_id="c1",
            client_name="Client",
            client_social_network="myspace",
            client_social_handle="aito.3d",
        )


def test_social_blank_handle_clears_the_network():
    from backend.app.schemas.aito import AitoProjectCreate

    payload = AitoProjectCreate(
        description="a job",
        client_id="c1",
        client_name="Client",
        client_social_network="instagram",
        client_social_handle="   ",
    )
    assert payload.client_social_network is None
    assert payload.client_social_handle is None


def test_social_handle_is_trimmed():
    from backend.app.schemas.aito import AitoProjectCreate

    payload = AitoProjectCreate(
        description="a job",
        client_id="c1",
        client_name="Client",
        client_social_network="messenger",
        client_social_handle="  aito.3d  ",
    )
    assert payload.client_social_handle == "aito.3d"


def test_update_without_social_keys_leaves_them_unset():
    """The pairing validator must not mark the fields as set, or an ordinary
    description edit would clear a stored handle through the route's
    `model_dump(exclude_unset=True)`."""
    from backend.app.schemas.aito import AitoProjectUpdate

    payload = AitoProjectUpdate(description="just the text")
    dumped = payload.model_dump(exclude_unset=True)
    assert "client_social_network" not in dumped
    assert "client_social_handle" not in dumped


def test_update_clearing_the_handle_sets_both_keys():
    """Clearing IS a mention, so both keys must be written as NULL."""
    from backend.app.schemas.aito import AitoProjectUpdate

    payload = AitoProjectUpdate(client_social_handle="")
    dumped = payload.model_dump(exclude_unset=True)
    assert dumped["client_social_network"] is None
    assert dumped["client_social_handle"] is None


def test_update_network_alone_is_rejected():
    """A body carrying only `client_social_network` is a network-without-handle
    per the design doc's pairing invariant — without this check,
    `update_project`'s `model_dump(exclude_unset=True)` would write the new
    network and NULL any stored handle to match, since the handle key was
    never mentioned."""
    from pydantic import ValidationError

    from backend.app.schemas.aito import AitoProjectUpdate

    with pytest.raises(ValidationError, match="client_social_handle is required"):
        AitoProjectUpdate(client_social_network="tiktok")


def test_update_network_explicitly_cleared_alone_is_fine():
    """Unlike a non-null network, `{"client_social_network": null}` alone
    asserts nothing that needs a handle to go with it."""
    from backend.app.schemas.aito import AitoProjectUpdate

    payload = AitoProjectUpdate(client_social_network=None)
    dumped = payload.model_dump(exclude_unset=True)
    assert dumped["client_social_network"] is None
    assert "client_social_handle" not in dumped


@pytest.mark.asyncio
async def test_create_accepts_a_social_handle_as_the_only_channel(async_client):
    r = await _create(
        async_client,
        client_phone=None,
        client_social_network="instagram",
        client_social_handle="moana.raiatea",
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["client_social_network"] == "instagram"
    assert body["client_social_handle"] == "moana.raiatea"
    assert body["client_phone"] is None
    assert body["client_email"] is None


@pytest.mark.asyncio
async def test_create_still_rejects_a_client_with_no_channel_at_all(async_client):
    r = await _create(async_client, client_phone=None, client_email=None)
    assert r.status_code == 400
    assert "social" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_create_rejects_a_handle_without_a_network(async_client):
    r = await _create(async_client, client_social_handle="moana.raiatea")
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_patch_round_trips_and_clears_the_social_pair(async_client):
    created = await _create(async_client)
    project_id = created.json()["id"]

    set_response = await async_client.patch(
        f"/api/v1/aito/{project_id}", json={"client_social_network": "tiktok", "client_social_handle": "moana.3d"}
    )
    assert set_response.status_code == 200, set_response.text
    assert set_response.json()["client_social_handle"] == "moana.3d"
    assert set_response.json()["client_social_network"] == "tiktok"

    cleared = await async_client.patch(
        f"/api/v1/aito/{project_id}", json={"client_social_network": None, "client_social_handle": ""}
    )
    assert cleared.status_code == 200
    assert cleared.json()["client_social_network"] is None
    assert cleared.json()["client_social_handle"] is None


@pytest.mark.asyncio
async def test_patch_without_social_keys_leaves_the_handle_alone(async_client):
    """The regression the pairing validator's early return exists to prevent."""
    created = await _create(async_client, client_social_network="messenger", client_social_handle="moana.fb")
    project_id = created.json()["id"]

    patched = await async_client.patch(f"/api/v1/aito/{project_id}", json={"description": "edited"})
    assert patched.status_code == 200
    assert patched.json()["client_social_handle"] == "moana.fb"
    assert patched.json()["client_social_network"] == "messenger"


@pytest.mark.asyncio
async def test_patch_network_alone_422s_instead_of_nulling_the_stored_handle(async_client):
    """A PATCH body carrying only `client_social_network` must not silently
    clear a stored handle it never mentioned."""
    created = await _create(async_client, client_social_network="messenger", client_social_handle="moana.fb")
    project_id = created.json()["id"]

    r = await async_client.patch(f"/api/v1/aito/{project_id}", json={"client_social_network": "tiktok"})
    assert r.status_code == 422

    board = (await async_client.get("/api/v1/aito/")).json()
    unchanged = next(p for p in board if p["id"] == project_id)
    assert unchanged["client_social_handle"] == "moana.fb"
    assert unchanged["client_social_network"] == "messenger"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "quote_id",
    ["../../../crm/v2/Leads", "12345/../../x", "EST 9", "EST/9", "EST.9"],
)
async def test_a_quote_id_with_path_characters_is_rejected(async_client, quote_id):
    """quote_id is interpolated into the Books URL path. zoho._seg escapes it
    as well, but a request carrying one of these is nonsense whatever the
    intent — reject it at the boundary rather than forwarding it upstream."""
    r = await _create(async_client, quote_id=quote_id, quote_number="QT-9")
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_ordinary_estimate_ids_still_pass(async_client):
    """The charset has to stay wide enough for both shapes Books hands out."""
    for quote_id in ("EST-9", "460000000012345", "est_9"):
        r = await _create(async_client, quote_id=quote_id, quote_number=f"QT-{quote_id}")
        assert r.status_code == 201, r.text
        assert r.json()["quote_id"] == quote_id
