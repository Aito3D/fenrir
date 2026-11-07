"""T-584: the content-version bump is computed by the database, not from the value this session loaded."""

from sqlalchemy import select, update

from backend.app.models.aito_project import AitoProject


async def test_a_stale_writer_bumps_the_live_version_and_can_read_it_back(db_session):
    project = AitoProject(description="d", board_column="devis", position=0, client_id="z1", client_name="ACME")
    db_session.add(project)
    await db_session.commit()
    assert project.version == 0

    # Another writer commits a content change while this session still holds version 0.
    await db_session.execute(update(AitoProject).where(AitoProject.id == project.id).values(version=5))

    project.client_name = "ACME 2"
    await db_session.flush()

    # Re-read just the column (the SQL bump leaves it expired), built from the live row, not 0 + 1.
    await db_session.refresh(project, ["version"])
    assert project.version == 6
    assert (await db_session.execute(select(AitoProject.version))).scalar_one() == 6


async def test_a_non_content_write_leaves_the_version_alone(db_session):
    project = AitoProject(description="d", board_column="devis", position=0, client_id="z1", client_name="ACME")
    db_session.add(project)
    await db_session.commit()
    project.position = 3
    await db_session.flush()
    assert project.version == 0
