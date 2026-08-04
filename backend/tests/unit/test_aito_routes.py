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
from backend.app.services.aito_board_rules import summarise
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
    await client.post(
        "/api/v1/aito/",
        json={
            "description": "mixed",
            "client_id": "C3",
            "client_name": "Three",
            "client_phone": "+689 87 00 00 03",
            # Accepted because ticked steps now require it — a mixed-done-flags
            # card cannot exist in any other status.
            "quote_status": "accepted",
            "tasks": [
                {"title": "a", "scan_cost": 5000, "scan_done": True, "impression_cost": 2400},
                {"title": "b", "usinage_cost": 1000},
            ],
        },
    )
    accepted = await client.post(
        "/api/v1/aito/",
        json={
            "description": "accepted",
            "client_id": "C4",
            "client_name": "Four",
            "client_phone": "+689 87 00 00 04",
            # Accepted for the same reason as "mixed": a pre-ticked step at
            # creation now requires it.
            "quote_status": "accepted",
            "tasks": [{"title": "c", "modelisation_cost": 3000, "modelisation_done": True}],
        },
    )
    await client.post(f"/api/v1/aito/{accepted.json()['id']}/quote-status", json={"status": "accepted"})
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


@pytest.mark.asyncio
async def test_move_to_another_column_is_409_when_locked(async_client):
    a = (await _create(async_client)).json()
    r = await async_client.patch(f"/api/v1/aito/{a['id']}/move", json={"column": "print", "position": 0})
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_finish_to_done_is_allowed_when_unlocked(async_client):
    p = (await _create(async_client, quote_status="accepted")).json()
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
    p1 = (await _create(async_client, description="p1", quote_status="accepted")).json()  # finish, position 0
    p2 = (await _create(async_client, description="p2", quote_status="accepted")).json()  # finish, position 1

    r = await async_client.patch(f"/api/v1/aito/{p1['id']}/move", json={"column": "done", "position": 0})
    assert r.status_code == 200

    board = {p["id"]: p for p in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p1["id"]]["column"] == "done" and board[p1["id"]]["position"] == 0
    assert board[p2["id"]]["column"] == "finish" and board[p2["id"]]["position"] == 0


@pytest.mark.asyncio
async def test_an_unlocked_card_still_cannot_move_to_a_work_column(async_client):
    p = (await _create(async_client, quote_status="accepted")).json()
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
    a = (await _create(async_client, quote_status="accepted")).json()
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
    r = await _create(async_client, quote_salesperson="Marie VENDEUSE", quote_status="accepted")
    assert r.status_code == 201
    assert r.json()["quote_salesperson"] == "Marie VENDEUSE"
    assert r.json()["quote_status"] == "accepted"


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
    p = (await _create(async_client, quote_status="accepted")).json()  # lands unlocked in 'finish', no tasks
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
    p = (await _create(async_client, quote_status="accepted")).json()
    t = (await _add_task(async_client, p["id"], scan_cost=1200.0, impression_cost=2400.0)).json()

    r = await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_done": True})
    assert r.status_code == 200

    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p["id"]]["column"] == "print"


@pytest.mark.asyncio
async def test_all_steps_ticked_lands_on_finish_and_unlocks(async_client):
    p = (await _create(async_client, quote_status="accepted")).json()
    t = (await _add_task(async_client, p["id"], scan_cost=1200.0)).json()
    await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_done": True})

    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p["id"]]["column"] == "finish"
    assert board[p["id"]]["move_lock"] is None


@pytest.mark.asyncio
async def test_a_zero_cost_step_still_holds_the_card(async_client):
    """0 is quoted-free, not absent."""
    p = (await _create(async_client, quote_status="accepted")).json()
    await _add_task(async_client, p["id"], scan_cost=0.0)

    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p["id"]]["column"] == "scan"


@pytest.mark.asyncio
async def test_deleting_the_last_blocking_task_advances_the_card(async_client):
    p = (await _create(async_client, quote_status="accepted")).json()
    t = (await _add_task(async_client, p["id"], scan_cost=1200.0)).json()
    await async_client.delete(f"/api/v1/aito/tasks/{t['id']}")

    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p["id"]]["column"] == "finish"


@pytest.mark.asyncio
async def test_an_advancing_card_lands_at_the_end_of_its_new_column(async_client):
    """Work arriving at a stage joins the back of that stage's queue."""
    sitting = (await _create(async_client, description="already printing", quote_status="accepted")).json()
    await _add_task(async_client, sitting["id"], impression_cost=1.0)

    arriving = (await _create(async_client, description="arriving", quote_status="accepted")).json()
    t = (await _add_task(async_client, arriving["id"], scan_cost=1.0, impression_cost=1.0)).json()
    await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_done": True})

    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[sitting["id"]]["column"] == "print" and board[sitting["id"]]["position"] == 0
    assert board[arriving["id"]]["column"] == "print" and board[arriving["id"]]["position"] == 1


@pytest.mark.asyncio
async def test_clearing_a_cost_also_clears_its_done_flag(async_client):
    """Otherwise re-enabling the service later would bring it back pre-ticked."""
    p = (await _create(async_client, quote_status="accepted")).json()
    t = (await _add_task(async_client, p["id"], scan_cost=1200.0, scan_done=True)).json()

    r = await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_cost": None})
    assert r.status_code == 200
    assert r.json()["scan_done"] is False


@pytest.mark.asyncio
async def test_ticking_a_step_that_does_not_exist_is_422(async_client):
    p = (await _create(async_client, quote_status="accepted")).json()
    t = (await _add_task(async_client, p["id"], scan_cost=1200.0)).json()

    r = await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"usinage_done": True})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_enabling_a_service_and_ticking_it_in_one_patch_is_allowed(async_client):
    """The check runs against the MERGED row, not the stored one."""
    p = (await _create(async_client, quote_status="accepted")).json()
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
    p = (await _create(async_client, quote_status="accepted")).json()
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
    p = (await _create(async_client, quote_status="accepted")).json()
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
    p = (await _create(async_client, quote_status="accepted")).json()
    t = (await _add_task(async_client, p["id"], scan_cost=1.0, impression_cost=1.0)).json()
    await async_client.patch(f"/api/v1/aito/tasks/{t['id']}", json={"scan_done": True})

    # Out with the client: the ticks stand, the card parks in waiting.
    await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "sent"})
    board = {row["id"]: row for row in (await async_client.get("/api/v1/aito/")).json()}
    assert board[p["id"]]["column"] == "waiting"

    r = await async_client.post(f"/api/v1/aito/{p['id']}/quote-status", json={"status": "accepted"})
    assert r.json()["project"]["column"] == "print"


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
    """
    created = (await _create(async_client, quote_status="accepted")).json()
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
    await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "steps per task",
            "client_id": "S1",
            "client_name": "Steps",
            "client_phone": "+689 87 00 00 07",
            "quote_status": "accepted",
            "tasks": [
                {"title": "t1", "impression_cost": 2000, "scan_cost": 1000, "scan_done": True},
                {"title": "t2", "usinage_cost": 0, "modelisation_done": True},
            ],
        },
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
    assert "phone or an email" in r.json()["detail"]


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
async def test_declining_preserves_the_acceptance_stamp(async_client):
    created = await _create(async_client)
    pid = created.json()["id"]
    accepted = await async_client.post(f"/api/v1/aito/{pid}/quote-status", json={"status": "accepted"})
    first = accepted.json()["project"]["quote_accepted_at"]

    declined = (await async_client.post(f"/api/v1/aito/{pid}/quote-status", json={"status": "declined"})).json()[
        "project"
    ]

    assert declined["quote_status"] == "declined"
    assert declined["quote_accepted_at"] == first
