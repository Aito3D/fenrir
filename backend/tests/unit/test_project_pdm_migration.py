"""Startup data migration for projects as a PDM (spec §7 step 1)."""

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import Base, run_migrations
from backend.app.services.project_tags import split_tag_string, tag_mirror


def test_split_tag_string_trims_dedupes_and_drops_empties():
    assert split_tag_string("drone,, Drone , pièce auto,") == ["drone", "pièce auto"]
    assert split_tag_string(None) == []
    assert split_tag_string("x" * 80) == ["x" * 64]


def test_tag_mirror_sorts_case_insensitively():
    assert tag_mirror(["pièce auto", "Drone"]) == "Drone, pièce auto"
    assert tag_mirror([]) is None


async def _engine(tmp_path):
    # run_migrations ALTERs tables that only some model modules define, so import them all.
    import importlib
    import pkgutil

    import backend.app.models as models_pkg

    for mod in pkgutil.iter_modules(models_pkg.__path__):
        importlib.import_module(f"backend.app.models.{mod.name}")

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'm.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine


async def _legacy_project(conn, name, created_at, tags=None):
    # Raw SQL on purpose: the ORM listener would assign a code, and these rows
    # stand for projects written before phase 1.
    await conn.execute(
        text(
            "INSERT INTO projects (name, status, priority, is_template, created_at, updated_at, tags) "
            "VALUES (:n, 'active', 'normal', 0, :c, :c, :t)"
        ),
        {"n": name, "c": created_at, "t": tags},
    )


@pytest.mark.asyncio
async def test_codes_follow_created_at_order_and_counter_is_parked(tmp_path):
    engine = await _engine(tmp_path)
    async with engine.begin() as conn:
        await _legacy_project(conn, "Newer", "2025-03-01 10:00:00")
        await _legacy_project(conn, "Older", "2024-01-01 10:00:00")
        await run_migrations(conn)
        rows = dict((await conn.execute(text("SELECT name, code FROM projects"))).all())
        counter = (await conn.execute(text("SELECT value FROM settings WHERE key = 'project_code_counter'"))).scalar()
    assert rows == {"Older": "P-0001", "Newer": "P-0002"}
    assert counter == "2"
    await engine.dispose()


@pytest.mark.asyncio
async def test_migration_is_idempotent(tmp_path):
    engine = await _engine(tmp_path)
    async with engine.begin() as conn:
        await _legacy_project(conn, "Solo", "2024-01-01 10:00:00", tags="drone")
        await run_migrations(conn)
        await run_migrations(conn)
        codes = (await conn.execute(text("SELECT code FROM projects"))).scalars().all()
        links = (await conn.execute(text("SELECT COUNT(*) FROM project_tags"))).scalar()
        counter = (await conn.execute(text("SELECT value FROM settings WHERE key = 'project_code_counter'"))).scalar()
    assert codes == ["P-0001"]
    assert links == 1
    assert counter == "1"
    await engine.dispose()


@pytest.mark.asyncio
async def test_tag_conversion_dedupes_and_reuses_catalogue(tmp_path):
    engine = await _engine(tmp_path)
    async with engine.begin() as conn:
        await conn.execute(text("INSERT INTO library_tags (name, name_key) VALUES ('Drone', 'drone')"))
        await _legacy_project(conn, "P", "2024-01-01 10:00:00", tags="drone,, Drone , pièce auto,")
        await run_migrations(conn)
        tags = (await conn.execute(text("SELECT name_key FROM library_tags ORDER BY name_key"))).scalars().all()
        linked = (
            (
                await conn.execute(
                    text(
                        "SELECT t.name FROM project_tags pt JOIN library_tags t ON t.id = pt.tag_id ORDER BY t.name_key"
                    )
                )
            )
            .scalars()
            .all()
        )
        mirror = (await conn.execute(text("SELECT tags FROM projects"))).scalar()
    assert tags == ["drone", "pièce auto"]
    assert linked == ["Drone", "pièce auto"]
    assert mirror == "Drone, pièce auto"
    await engine.dispose()


@pytest.mark.asyncio
async def test_existing_codes_are_kept_and_counter_moves_past_them(tmp_path):
    engine = await _engine(tmp_path)
    async with engine.begin() as conn:
        await _legacy_project(conn, "Coded", "2024-01-01 10:00:00")
        await conn.execute(text("UPDATE projects SET code = 'P-0050' WHERE name = 'Coded'"))
        await _legacy_project(conn, "Uncoded", "2023-01-01 10:00:00")
        await run_migrations(conn)
        rows = dict((await conn.execute(text("SELECT name, code FROM projects"))).all())
    assert rows == {"Coded": "P-0050", "Uncoded": "P-0051"}
    await engine.dispose()


@pytest.mark.asyncio
async def test_revision_pipeline_columns_are_added(tmp_path):
    engine = await _engine(tmp_path)
    async with engine.begin() as conn:
        # create_all already made them: drop to stand for a phase-5 database.
        await conn.execute(text("ALTER TABLE project_revisions DROP COLUMN pipeline_id"))
        await conn.execute(text("ALTER TABLE project_revisions DROP COLUMN pipeline_name"))
        await run_migrations(conn)
        await run_migrations(conn)  # idempotent
        cols = {row[1] for row in (await conn.execute(text("PRAGMA table_info(project_revisions)"))).all()}
    assert {"pipeline_id", "pipeline_name"} <= cols
    await engine.dispose()
