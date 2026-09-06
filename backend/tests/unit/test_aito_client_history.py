"""GET /aito/clients/{client_id}/history — a client's past cards for the drawer's recall block."""

import pytest
from sqlalchemy import text

from backend.tests.unit.test_aito_contacted import _declared_permissions


def _url(client_id: str, limit: int | None = None) -> str:
    base = f"/api/v1/aito/clients/{client_id}/history"
    return base if limit is None else f"{base}?limit={limit}"


async def _create(client, **overrides):
    payload = {"description": "Job", "client_id": "zA", "client_name": "ACME", "client_phone": "+689 87 00 00 01"}
    payload.update(overrides)
    r = await client.post("/api/v1/aito/", json=payload)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _add_task(client, pid: int, **fields):
    # No default cost here: AitoTaskCreate has no required fields, and a
    # shared default would leak into whichever service a caller does NOT
    # override (payload.update only merges, it never clears a base key).
    payload = {"title": "Part"}
    payload.update(fields)
    r = await client.post(f"/api/v1/aito/{pid}/tasks", json=payload)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _set(db_session, pid: int, **cols):
    sets = ", ".join(f"{k} = :{k}" for k in cols)
    await db_session.execute(text(f"UPDATE aito_projects SET {sets} WHERE id = :pid"), {"pid": pid, **cols})
    await db_session.commit()


@pytest.mark.asyncio
async def test_cards_are_newest_first_with_id_tiebreak(async_client, db_session):
    older = await _create(async_client, description="older")
    newer = await _create(async_client, description="newer")
    same_a = await _create(async_client, description="same-a")
    same_b = await _create(async_client, description="same-b")
    await _set(db_session, older, created_at="2026-08-01 10:00:00")
    await _set(db_session, newer, created_at="2026-08-20 10:00:00")
    await _set(db_session, same_a, created_at="2026-08-10 10:00:00")
    await _set(db_session, same_b, created_at="2026-08-10 10:00:00")

    body = (await async_client.get(_url("zA"))).json()
    assert [c["id"] for c in body["cards"]] == [newer, same_b, same_a, older]


@pytest.mark.asyncio
async def test_limit_is_honoured_and_validated(async_client):
    for i in range(7):
        await _create(async_client, description=f"job {i}")
    assert len((await async_client.get(_url("zA"))).json()["cards"]) == 5
    assert len((await async_client.get(_url("zA", limit=2))).json()["cards"]) == 2
    assert (await async_client.get(_url("zA", limit=0))).status_code == 422
    assert (await async_client.get(_url("zA", limit=21))).status_code == 422


@pytest.mark.asyncio
async def test_trash_and_other_clients_are_excluded_done_is_included(async_client, db_session):
    mine = await _create(async_client, description="mine")
    done = await _create(async_client, description="done")
    trashed = await _create(async_client, description="trashed")
    other = await _create(async_client, description="other", client_id="zB")
    await _set(db_session, done, board_column="done")
    await _set(db_session, trashed, status="deleted")

    ids = [c["id"] for c in (await async_client.get(_url("zA"))).json()["cards"]]
    assert set(ids) == {mine, done}
    assert trashed not in ids and other not in ids
    by = {c["id"]: c for c in (await async_client.get(_url("zA"))).json()["cards"]}
    assert by[done]["column"] == "done"


@pytest.mark.asyncio
async def test_unknown_client_is_an_empty_200(async_client):
    r = await async_client.get(_url("nobody"))
    assert r.status_code == 200
    assert r.json() == {"cards": [], "latest_social": None}


@pytest.mark.asyncio
async def test_default_contact_returns_nothing_even_with_cards(async_client, db_session):
    status = (await async_client.get("/api/v1/zoho/status?probe=false")).json()
    default_id = status["default_contact_id"]
    await _create(async_client, description="walk-in", client_id=default_id)
    await _set(
        db_session,
        (await async_client.get("/api/v1/aito/")).json()[0]["id"],
        client_social_network="instagram",
        client_social_handle="walkin",
    )

    body = (await async_client.get(_url(default_id))).json()
    assert body == {"cards": [], "latest_social": None}


@pytest.mark.asyncio
async def test_total_and_task_order_match_the_board(async_client):
    pid = await _create(async_client, description="two tasks")
    t1 = await _add_task(async_client, pid, title="first", scan_cost=1000.0)
    t2 = await _add_task(async_client, pid, title="second", modelisation_cost=2500.0)

    card = (await async_client.get(_url("zA"))).json()["cards"][0]
    assert card["id"] == pid
    assert card["total"] == 3500.0
    assert [t["id"] for t in card["tasks"]] == [t1, t2]
    assert card["tasks"][0]["title"] == "first"
    assert card["tasks"][1]["modelisation_cost"] == 2500.0


@pytest.mark.asyncio
async def test_latest_social_comes_from_newest_card_with_a_pair_beyond_limit(async_client, db_session):
    with_pair = await _create(async_client, description="with pair")
    await _set(
        db_session,
        with_pair,
        created_at="2026-07-01 10:00:00",
        client_social_network="instagram",
        client_social_handle="moana.t",
    )
    older_pair = await _create(async_client, description="older pair")
    await _set(
        db_session,
        older_pair,
        created_at="2026-06-01 10:00:00",
        client_social_network="whatsapp",
        client_social_handle="old",
    )
    for i in range(5):
        pid = await _create(async_client, description=f"phone only {i}")
        await _set(db_session, pid, created_at=f"2026-08-0{i + 1} 10:00:00")

    body = (await async_client.get(_url("zA"))).json()
    assert len(body["cards"]) == 5
    assert with_pair not in [c["id"] for c in body["cards"]]
    assert body["latest_social"] == {"network": "instagram", "handle": "moana.t"}


@pytest.mark.asyncio
async def test_latest_social_ignores_trashed_cards_and_is_null_without_a_pair(async_client, db_session):
    plain = await _create(async_client, description="plain")
    trashed = await _create(async_client, description="trashed")
    await _set(db_session, trashed, status="deleted", client_social_network="tiktok", client_social_handle="gone")

    body = (await async_client.get(_url("zA"))).json()
    assert [c["id"] for c in body["cards"]] == [plain]
    assert body["latest_social"] is None


def test_history_is_gated_on_aito_read():
    assert _declared_permissions("get_client_history") == ["aito:read"]
