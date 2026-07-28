"""Aito board routes: required client, move reindexing, soft delete, one-shot import."""

import pytest
from sqlalchemy import select

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
async def test_move_reindexes_both_columns(async_client):
    a = (await _create(async_client, description="a")).json()
    b = (await _create(async_client, description="b")).json()  # devis order: b(0), a(1)
    r = await async_client.patch(f"/api/v1/aito/{a['id']}/move", json={"column": "print", "position": 0})
    assert r.status_code == 200
    board = (await async_client.get("/api/v1/aito/")).json()
    by_id = {p["id"]: p for p in board}
    assert by_id[a["id"]]["column"] == "print" and by_id[a["id"]]["position"] == 0
    assert by_id[b["id"]]["column"] == "devis" and by_id[b["id"]]["position"] == 0


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
    a = (await _create(async_client)).json()
    await async_client.patch(f"/api/v1/aito/{a['id']}/move", json={"column": "print", "position": 0})
    r = await async_client.patch(
        f"/api/v1/aito/{a['id']}", json={"description": "moved then edited", "column": "devis", "position": 7}
    )
    assert r.status_code == 200
    assert r.json()["column"] == "print" and r.json()["position"] == 0


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
    invalidation; loading every task of every card would bloat it."""
    await _create(async_client, tasks=[_task()])
    body = (await async_client.get("/api/v1/aito/")).json()
    assert "tasks" not in body[0]


@pytest.mark.asyncio
async def test_create_project_rejects_a_negative_cost(async_client):
    r = await _create(async_client, tasks=[_task(scan_cost=-1)])
    assert r.status_code == 422
