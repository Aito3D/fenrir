"""Project codes: P-0001…, from a counter, never reused (spec §1.1)."""

import pytest
from sqlalchemy import delete, select

from backend.app.models.project import Project
from backend.app.models.settings import Settings
from backend.app.services.project_codes import CODE_COUNTER_KEY, format_project_code, parse_project_code


def test_format_and_parse_round_trip():
    assert format_project_code(1) == "P-0001"
    assert format_project_code(12345) == "P-12345"
    assert parse_project_code("P-0042") == 42
    assert parse_project_code("p-0042") == 42
    assert parse_project_code("X-1") is None
    assert parse_project_code(None) is None


@pytest.mark.asyncio
async def test_new_projects_get_sequential_codes(db_session):
    a = Project(name="Alpha")
    b = Project(name="Bêta")
    db_session.add_all([a, b])
    await db_session.commit()
    assert {a.code, b.code} == {"P-0001", "P-0002"}
    assert b.storage_dir == f"{b.code}_beta"


@pytest.mark.asyncio
async def test_code_never_reused_after_delete(db_session):
    first = Project(name="One")
    second = Project(name="Two")
    db_session.add(first)
    await db_session.commit()
    db_session.add(second)
    await db_session.commit()
    await db_session.execute(delete(Project).where(Project.id == second.id))
    await db_session.commit()
    third = Project(name="Three")
    db_session.add(third)
    await db_session.commit()
    assert third.code == "P-0003"


@pytest.mark.asyncio
async def test_counter_skips_past_existing_higher_code(db_session):
    db_session.add(Project(name="Imported", code="P-0100"))
    await db_session.commit()
    fresh = Project(name="Fresh")
    db_session.add(fresh)
    await db_session.commit()
    assert fresh.code == "P-0101"
    counter = (await db_session.execute(select(Settings).where(Settings.key == CODE_COUNTER_KEY))).scalar_one()
    assert counter.value == "101"


@pytest.mark.asyncio
async def test_explicit_code_is_kept(db_session):
    project = Project(name="Kept", code="P-0007")
    db_session.add(project)
    await db_session.commit()
    assert project.code == "P-0007"
