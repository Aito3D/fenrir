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
