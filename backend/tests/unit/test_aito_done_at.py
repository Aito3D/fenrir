"""`done_at`: when a card last arrived in Done.

The archive used to sort on `updated_at`, which every sweep and edit bumps;
this column is the stamp the archive actually means. It follows
`board_column` through both of its writers — the Finish <-> Done drag
(`move_project`) and the rule engine (`_apply_rules`, which is how a
declined quote reaches Done and how re-opened work leaves it) — and is
backfilled once from the `stage.changed` event log.
"""

import json
from datetime import datetime

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import Base, run_migrations


async def _create(client, **overrides):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+33 6 12 34 56 78",
    }
    payload.update(overrides)
    return (await client.post("/api/v1/aito/", json=payload)).json()


async def _create_finished(client, **overrides):
    """A hand-made card accepted, told, and sitting unlocked in Finish."""
    created = await _create(client, **overrides)
    accepted = await client.post(f"/api/v1/aito/{created['id']}/quote-status", json={"status": "accepted"})
    project = accepted.json()["project"]
    await client.patch(f"/api/v1/aito/{project['id']}/contacted", json={"contacted": True})
    return project


async def _board_row(client, project_id: int) -> dict:
    return next(row for row in (await client.get("/api/v1/aito/")).json() if row["id"] == project_id)


@pytest.mark.asyncio
async def test_a_card_in_finish_has_no_done_stamp(async_client):
    p = await _create_finished(async_client)
    assert (await _board_row(async_client, p["id"]))["done_at"] is None


@pytest.mark.asyncio
async def test_archiving_stamps_done_at(async_client):
    p = await _create_finished(async_client)
    before = datetime.utcnow()

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "done", "position": 0})

    assert r.status_code == 200
    stamp = r.json()["done_at"]
    assert stamp is not None
    assert datetime.fromisoformat(stamp.replace("Z", "")) >= before.replace(microsecond=0)


@pytest.mark.asyncio
async def test_pulling_a_card_back_to_finish_clears_the_stamp(async_client):
    p = await _create_finished(async_client)
    await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "done", "position": 0})

    r = await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "finish", "position": 0})

    assert r.status_code == 200
    assert r.json()["column"] == "finish"
    assert r.json()["done_at"] is None


@pytest.mark.asyncio
async def test_reordering_inside_done_keeps_the_original_stamp(async_client):
    first = await _create_finished(async_client, description="First")
    second = await _create_finished(async_client, description="Second")
    stamped = (
        await async_client.patch(f"/api/v1/aito/{first['id']}/move", json={"column": "done", "position": 0})
    ).json()["done_at"]
    await async_client.patch(f"/api/v1/aito/{second['id']}/move", json={"column": "done", "position": 0})

    r = await async_client.patch(f"/api/v1/aito/{first['id']}/move", json={"column": "done", "position": 0})

    assert r.status_code == 200
    assert r.json()["done_at"] == stamped


@pytest.mark.asyncio
async def test_a_declined_quote_is_stamped_when_the_rules_park_it_in_done(async_client):
    created = await _create(async_client)

    r = await async_client.post(f"/api/v1/aito/{created['id']}/quote-status", json={"status": "declined"})

    project = r.json()["project"]
    assert project["column"] == "done"
    assert project["done_at"] is not None


@pytest.mark.asyncio
async def test_work_reappearing_on_a_finished_card_clears_the_stamp(async_client):
    """The rules evict a Done card the moment a step re-opens; the stamp goes
    with it, so a card that comes back to Done later is finished again, now."""
    p = await _create_finished(async_client)
    await async_client.patch(f"/api/v1/aito/{p['id']}/move", json={"column": "done", "position": 0})
    assert (await _board_row(async_client, p["id"]))["done_at"] is not None

    await async_client.post(f"/api/v1/aito/{p['id']}/tasks", json={"impression_cost": 2400.0})

    row = await _board_row(async_client, p["id"])
    assert row["column"] != "done"
    assert row["done_at"] is None


# --- migration -------------------------------------------------------------


async def _make_engine():
    from backend.app.models import (  # noqa: F401
        active_print_spoolman,
        aito_event,
        aito_project,
        aito_task,
        settings,
        user,
    )

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine


async def _make_pre_feature_engine():
    """A schema that ran every migration but never the `done_at` one, so
    `run_migrations`'s own ALTER genuinely adds the column and the backfill
    gate opens."""
    engine = await _make_engine()
    async with engine.begin() as conn:
        await conn.execute(text("ALTER TABLE aito_projects DROP COLUMN done_at"))
    return engine


async def _seed(conn, description: str, column: str, updated_at: str) -> int:
    await conn.execute(
        text(
            "INSERT INTO aito_projects (description, board_column, position, status, created_at, updated_at) "
            "VALUES (:d, :c, 0, 'active', '2026-01-01 00:00:00', :u)"
        ),
        {"d": description, "c": column, "u": updated_at},
    )
    return (await conn.execute(text("SELECT MAX(id) FROM aito_projects"))).scalar_one()


async def _stage_changed(conn, project_id: int, at: str, source: str, to: str) -> None:
    await conn.execute(
        text(
            "INSERT INTO aito_events (project_id, occurred_at, kind, actor_class, subject_type, subject_id, "
            "changes, created_at) VALUES (:p, :at, 'stage.changed', 'user', 'project', :p, :changes, :at)"
        ),
        {"p": project_id, "at": at, "changes": json.dumps([{"field": "column", "from": source, "to": to}])},
    )


async def _done_at(engine, project_id: int):
    async with engine.connect() as conn:
        return (
            await conn.execute(text("SELECT done_at FROM aito_projects WHERE id = :p"), {"p": project_id})
        ).scalar_one()


@pytest.mark.asyncio
async def test_backfill_takes_the_latest_move_into_done_from_the_event_log():
    engine = await _make_pre_feature_engine()
    try:
        async with engine.begin() as conn:
            pid = await _seed(conn, "Re-closed", "done", "2026-10-20 10:00:00")
            await _stage_changed(conn, pid, "2026-09-01 09:00:00", "finish", "done")
            await _stage_changed(conn, pid, "2026-09-05 09:00:00", "done", "print")
            await _stage_changed(conn, pid, "2026-09-09 09:00:00", "finish", "done")
        async with engine.begin() as conn:
            await run_migrations(conn)
        assert str(await _done_at(engine, pid)).startswith("2026-09-09 09:00:00")
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_backfill_falls_back_to_updated_at_without_an_event():
    """A card archived before the event log existed keeps the order the
    archive already showed it in."""
    engine = await _make_pre_feature_engine()
    try:
        async with engine.begin() as conn:
            pid = await _seed(conn, "Legacy", "done", "2026-03-03 03:03:03")
        async with engine.begin() as conn:
            await run_migrations(conn)
        assert str(await _done_at(engine, pid)).startswith("2026-03-03 03:03:03")
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_backfill_leaves_cards_outside_done_alone():
    engine = await _make_pre_feature_engine()
    try:
        async with engine.begin() as conn:
            pid = await _seed(conn, "Printing", "print", "2026-03-03 03:03:03")
            await _stage_changed(conn, pid, "2026-02-01 09:00:00", "finish", "done")
        async with engine.begin() as conn:
            await run_migrations(conn)
        assert await _done_at(engine, pid) is None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_backfill_does_not_rerun_once_the_column_exists():
    """The app writes the stamp itself from then on; a restart must not
    overwrite it with the event log's reading."""
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            pid = await _seed(conn, "Stamped", "done", "2026-10-20 10:00:00")
            await conn.execute(
                text("UPDATE aito_projects SET done_at = '2026-10-15 15:00:00' WHERE id = :p"), {"p": pid}
            )
            await _stage_changed(conn, pid, "2026-09-09 09:00:00", "finish", "done")
        async with engine.begin() as conn:
            await run_migrations(conn)
        assert str(await _done_at(engine, pid)).startswith("2026-10-15 15:00:00")
    finally:
        await engine.dispose()
