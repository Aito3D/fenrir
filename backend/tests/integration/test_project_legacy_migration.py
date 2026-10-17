"""Legacy project files migration (phase 5, task 4).

Printing files only: a project's linked File Manager files (``LibraryFile.project_id``
or a folder linked with ``LibraryFolder.project_id``) that are printable move into
the project tree (Impression); everything else, legacy attachments and the cover
image included, stays where it is.
"""

import asyncio
import hashlib
import json
import time
import uuid
from datetime import datetime, timezone
from functools import partial
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from backend.app.api.routes.library import to_absolute_path
from backend.app.core.config import settings
from backend.app.core.permissions import Permission
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.project import Project
from backend.app.services import project_files, project_filing
from backend.tests.project_fixtures import (
    make_external_file as _external,
    make_managed_library_file as _managed,
    make_project,
    make_users,
    projects_root_fixture,
    revisions_of as _revisions,
    wal_engine_fixture,  # noqa: F401  # the ``wal_engine`` fixture
)

START = "/api/v1/projects/legacy-migration/start"
STATUS = "/api/v1/projects/legacy-migration/status"


@pytest.fixture
async def test_engine(test_engine, wal_engine):
    """A WAL file database instead of the shared ``:memory:`` engine.

    The endpoint tests run the migration in a background task while the test
    polls the status endpoint. Behind ``conftest.test_engine``'s StaticPool every
    session shares ONE sqlite3 connection, so a poll's session closing (the auth
    check, ``get_db``) rolled back the runner's flushed-but-uncommitted revision
    INSERT; the runner's next flush + commit then kept the file rows pointing at
    the vanished revision id, which SQLite reused for the next item's revision
    ("Bracket.3mf" inside "Lid" R1). Production gives each session its own
    connection to a WAL file, as this does. The parent fixture is requested only
    for its model registration."""
    yield wal_engine


root = projects_root_fixture(autouse=True, subdir="projects", library=True)


@pytest.fixture(autouse=True)
def idle_runner():
    project_filing.reset_legacy_migration_state()
    yield
    project_filing.reset_legacy_migration_state()


_project = partial(make_project, commit=True)


async def _folder(db, project_id: int | None, **fields) -> LibraryFolder:
    folder = LibraryFolder(name=f"F-{uuid.uuid4().hex[:6]}", project_id=project_id, **fields)
    db.add(folder)
    await db.commit()
    return folder


async def _fresh(db, model, row_id):
    return (
        await db.execute(select(model).where(model.id == row_id).execution_options(populate_existing=True))
    ).scalar_one()


async def _legacy_setup(db, tmp_path):
    """2 linked managed .3mf (folder link + direct link), 1 external .gcode, 1 linked .stl,
    legacy attachments and a cover image."""
    project = await _project(db, cover_image_filename="cover.png")
    attachments_dir = settings.archive_dir / "projects" / str(project.id) / "attachments"
    attachments_dir.mkdir(parents=True)
    (attachments_dir / "notice.pdf").write_bytes(b"%PDF")
    (attachments_dir / "cover.png").write_bytes(b"PNG")
    project.attachments = [{"filename": "notice.pdf", "original_name": "notice.pdf", "size": 4}]
    await db.commit()
    folder = await _folder(db, project.id)
    bracket = await _managed(db, "Bracket.3mf", b"bracket", folder_id=folder.id)
    lid = await _managed(db, "Lid.3mf", b"lid", project_id=project.id)
    mesh = await _managed(db, "Bracket.stl", b"mesh", folder_id=folder.id)
    clip = await _external(db, tmp_path, "Clip.gcode", b"G1 X0", project_id=project.id)
    return project, {"bracket": bracket, "lid": lid, "mesh": mesh, "clip": clip}, attachments_dir


# --- service ---------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.integration
async def test_candidates(db_session, tmp_path):
    direct = await _project(db_session, "Direct")
    linked = await _project(db_session, "Linked")
    only_mesh = await _project(db_session, "Only mesh")
    done = await _project(db_session, "Done", legacy_migrated_at=datetime(2026, 1, 1))
    empty = await _project(db_session, "Empty")
    trashed_only = await _project(db_session, "Trashed only")
    await _managed(db_session, "A.3mf", project_id=direct.id)
    folder = await _folder(db_session, linked.id)
    await _managed(db_session, "B.gcode", folder_id=folder.id)
    await _managed(db_session, "C.stl", project_id=only_mesh.id)
    await _managed(db_session, "Notice.pdf", project_id=only_mesh.id)
    await _managed(db_session, "D.3mf", project_id=done.id)
    await _managed(db_session, "E.3mf", project_id=trashed_only.id, deleted_at=datetime.now(timezone.utc))

    assert await project_filing.legacy_candidates(db_session) == sorted([direct.id, linked.id])
    assert empty.id not in await project_filing.legacy_candidates(db_session)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_migrate_project(db_session, tmp_path):
    project, files, attachments_dir = await _legacy_setup(db_session, tmp_path)
    project_id = project.id
    ids = {key: row.id for key, row in files.items()}
    clip_path = files["clip"].file_path
    mesh_path = files["mesh"].file_path
    mesh_folder = files["mesh"].folder_id
    attachments_before = json.loads(json.dumps(project.attachments))

    outcome = await project_filing.migrate_project_legacy(db_session, project)
    assert (outcome.revisions_created, outcome.files_moved, outcome.files_copied) == (3, 2, 1)

    assert await _revisions(db_session, project_id) == [
        ("impression", "Bracket", 1, ["Bracket.3mf"]),
        ("impression", "Clip", 1, ["Clip.gcode"]),
        ("impression", "Lid", 1, ["Lid.3mf"]),
    ]
    # Managed rows moved (same id), the .stl stays in the File Manager.
    for key in ("bracket", "lid"):
        row = await _fresh(db_session, LibraryFile, ids[key])
        assert row.revision_id is not None and row.project_id == project_id
        assert to_absolute_path(row.file_path).is_file()
    mesh = await _fresh(db_session, LibraryFile, ids["mesh"])
    assert (mesh.revision_id, mesh.file_path, mesh.folder_id) == (None, mesh_path, mesh_folder)
    # External original untouched; its copy is a new managed row.
    clip = await _fresh(db_session, LibraryFile, ids["clip"])
    assert (clip.revision_id, clip.file_path, clip.is_external) == (None, clip_path, True)
    assert Path(clip_path).read_bytes() == b"G1 X0"
    # Attachments and cover untouched.
    fresh = await _fresh(db_session, Project, project_id)
    assert fresh.attachments == attachments_before
    assert fresh.cover_image_filename == "cover.png"
    assert (attachments_dir / "notice.pdf").read_bytes() == b"%PDF"
    assert (attachments_dir / "cover.png").read_bytes() == b"PNG"
    # Marker set; no longer a candidate.
    assert fresh.legacy_migrated_at is not None
    assert project_id not in await project_filing.legacy_candidates(db_session)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_failure_mid_project_then_rerun_completes_without_duplicates(db_session, tmp_path, monkeypatch):
    project = await _project(db_session)
    project_id = project.id
    # The external file sorts first, so it is copied before the failure hits.
    clip = await _external(db_session, tmp_path, "Clip.gcode", b"G1 X0", project_id=project_id)
    await _managed(db_session, "Bracket.3mf", b"bracket", project_id=project_id)
    await _managed(db_session, "Lid.3mf", b"lid", project_id=project_id)
    clip_id = clip.id

    real = project_files.add_revision_from_sources
    calls = {"n": 0}

    async def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("disk on fire")
        return await real(*args, **kwargs)

    monkeypatch.setattr(project_files, "add_revision_from_sources", flaky)
    # T-285 (user-approved): the failing group (Bracket) is skipped as ``error`` and the
    # run goes on (Lid moves), then fails as retryable so the marker is not set.
    with pytest.raises(project_filing.LegacyMigrationError) as exc:
        await project_filing.migrate_project_legacy(db_session, await _fresh(db_session, Project, project_id))
    assert str(exc.value) == (
        "1 file(s) could not be moved (error: unexpected error while moving the file); run it again"
    )
    fresh = await _fresh(db_session, Project, project_id)
    assert fresh.legacy_migrated_at is None
    assert [r[1] for r in await _revisions(db_session, project_id)] == ["Clip", "Lid"]
    assert project_id in await project_filing.legacy_candidates(db_session)

    monkeypatch.setattr(project_files, "add_revision_from_sources", real)
    outcome = await project_filing.migrate_project_legacy(db_session, fresh)
    assert (outcome.revisions_created, outcome.files_moved, outcome.files_copied) == (1, 1, 0)
    assert await _revisions(db_session, project_id) == [
        ("impression", "Bracket", 1, ["Bracket.3mf"]),
        ("impression", "Clip", 1, ["Clip.gcode"]),
        ("impression", "Lid", 1, ["Lid.3mf"]),
    ]
    copies = (
        await db_session.execute(
            select(func.count())
            .select_from(LibraryFile)
            .where(LibraryFile.project_id == project_id, LibraryFile.revision_id.is_not(None))
        )
    ).scalar()
    assert copies == 3
    assert (await _fresh(db_session, Project, project_id)).legacy_migrated_at is not None
    assert (await _fresh(db_session, LibraryFile, clip_id)).revision_id is None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_unexpected_group_failure_still_records_the_other_groups_events(db_session, monkeypatch):
    """T-285 (user-approved): a group failing with an unexpected error no longer aborts the
    run, so the linked order gets ``project.revision_added`` for the groups that went through."""
    from sqlalchemy.exc import OperationalError

    from backend.app.models.aito_event import AitoEvent
    from backend.app.models.aito_project import AitoProject
    from backend.app.models.aito_task import AitoTask

    project = await _project(db_session)
    project_id = project.id
    order = AitoProject(description="Commande", board_column="devis", status="active", client_id="C1")
    db_session.add(order)
    await db_session.commit()
    order_id = order.id
    db_session.add(AitoTask(project_id=order_id, title="Support", linked_project_id=project_id))
    await db_session.commit()
    await _managed(db_session, "Bracket.3mf", b"bracket", project_id=project_id)
    await _managed(db_session, "Lid.3mf", b"lid", project_id=project_id)
    real = project_files.add_revision_from_sources

    async def locked(db, project, item, sources, **kwargs):
        if item.name == "Bracket":
            raise OperationalError("COMMIT", {}, Exception("database is locked"))
        return await real(db, project, item, sources, **kwargs)

    monkeypatch.setattr(project_files, "add_revision_from_sources", locked)
    with pytest.raises(project_filing.LegacyMigrationError):
        await project_filing.migrate_project_legacy(db_session, await _fresh(db_session, Project, project_id))

    assert [r[1] for r in await _revisions(db_session, project_id)] == ["Lid"]
    events = (
        (
            await db_session.execute(
                select(AitoEvent).where(AitoEvent.project_id == order_id, AitoEvent.kind == "project.revision_added")
            )
        )
        .scalars()
        .all()
    )
    assert [e.subject_label for e in events] == ["Lid R1"]
    assert (await _fresh(db_session, Project, project_id)).legacy_migrated_at is None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_rerun_dedupes_external_copies_on_hash_and_name(db_session, tmp_path, monkeypatch, caplog):
    """Two distinct external files with identical bytes but different names are
    both migrated: the re-run skips only the one whose copy (same SHA-256 AND
    same name) the project already holds, and logs that skip."""
    project = await _project(db_session)
    project_id = project.id
    first = await _external(db_session, tmp_path, "Arm.gcode", b"G1 X0", project_id=project_id)
    twin = await _external(db_session, tmp_path, "Leg.gcode", b"G1 X0", project_id=project_id)
    first_id, twin_id = first.id, twin.id

    real = project_files.add_revision_from_sources
    calls = {"n": 0}

    async def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:  # Arm is copied, the run dies before Leg
            raise RuntimeError("disk on fire")
        return await real(*args, **kwargs)

    monkeypatch.setattr(project_files, "add_revision_from_sources", flaky)
    with pytest.raises(project_filing.LegacyMigrationError):  # T-285: Leg skipped as ``error``
        await project_filing.migrate_project_legacy(db_session, await _fresh(db_session, Project, project_id))
    assert [r[1] for r in await _revisions(db_session, project_id)] == ["Arm"]

    monkeypatch.setattr(project_files, "add_revision_from_sources", real)
    with caplog.at_level("INFO", logger="backend.app.services.project_filing"):
        outcome = await project_filing.migrate_project_legacy(db_session, await _fresh(db_session, Project, project_id))
    assert (outcome.revisions_created, outcome.files_moved, outcome.files_copied) == (1, 0, 1)
    assert await _revisions(db_session, project_id) == [
        ("impression", "Arm", 1, ["Arm.gcode"]),
        ("impression", "Leg", 1, ["Leg.gcode"]),
    ]
    skips = [r.getMessage() for r in caplog.records if "already copied" in r.getMessage()]
    assert skips == [
        f"Legacy migration of project {project_id}: external file {first_id} ('Arm.gcode') already copied, skipping"
    ]
    for row_id in (first_id, twin_id):  # originals untouched
        assert (await _fresh(db_session, LibraryFile, row_id)).revision_id is None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_incomplete_group_leaves_no_marker(db_session, monkeypatch):
    """A group skipped for a transient reason (copy error) keeps the project a candidate."""
    project = await _project(db_session)
    await _managed(db_session, "Bracket.3mf", project_id=project.id)

    def broken(*_args, **_kwargs):
        raise OSError("read error")

    monkeypatch.setattr(project_files, "_copy_hashing", broken)
    with pytest.raises(project_filing.LegacyMigrationError):
        await project_filing.migrate_project_legacy(db_session, project)
    assert (await _fresh(db_session, Project, project.id)).legacy_migrated_at is None


def test_external_marker_is_content_hash(tmp_path):
    path = tmp_path / "x.gcode"
    path.write_bytes(b"abc")
    assert project_filing.calculate_file_hash(path) == hashlib.sha256(b"abc").hexdigest()


def _sql(statement) -> str:
    from sqlalchemy.dialects import sqlite

    return str(statement.compile(dialect=sqlite.dialect(), compile_kwargs={"literal_binds": True}))


_LEGACY_FROM = "FROM library_files LEFT OUTER JOIN library_folders ON library_files.folder_id = library_folders.id"
_LEGACY_WHERE = "WHERE library_files.revision_id IS NULL AND library_files.deleted_at IS NULL"
_LEGACY_OWNER = "coalesce(library_files.project_id, library_folders.project_id)"


def test_legacy_files_query_sql_is_pinned():
    columns = ", ".join(f"library_files.{c.name}" for c in LibraryFile.__table__.columns)
    assert _sql(project_filing._legacy_files_query()) == f"SELECT {columns} \n{_LEGACY_FROM} \n{_LEGACY_WHERE}"


def test_legacy_candidates_query_sql_is_pinned():
    assert _sql(project_filing._legacy_candidates_query()) == (
        f"SELECT {_LEGACY_OWNER} AS coalesce_1, library_files.filename \n"
        f"{_LEGACY_FROM} JOIN projects ON projects.id = {_LEGACY_OWNER} \n"
        f"{_LEGACY_WHERE} AND projects.legacy_migrated_at IS NULL"
    )


# --- endpoints -------------------------------------------------------------------


RUNNER_TASK_NAME = "projects-legacy-migration"  # the name start_legacy_migration spawns it under
IDLE_TIMEOUT = 30.0


async def _wait_idle(client: AsyncClient, headers=None) -> dict:
    """Await the background runner task itself (not a wall-clock poll, which races
    the runner's file work under xdist load), then confirm idleness over HTTP."""
    runners = [t for t in asyncio.all_tasks() if t.get_name() == RUNNER_TASK_NAME and not t.done()]
    if runners:
        try:
            await asyncio.wait_for(asyncio.shield(asyncio.gather(*runners, return_exceptions=True)), IDLE_TIMEOUT)
        except TimeoutError:
            raise AssertionError("migration never finished") from None
    deadline = time.monotonic() + IDLE_TIMEOUT
    while True:
        body = (await client.get(STATUS, headers=headers)).json()
        if not body["running"]:
            return body
        if time.monotonic() >= deadline:
            raise AssertionError("migration never finished")
        await asyncio.sleep(0.02)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_start_and_status(async_client: AsyncClient, db_session, tmp_path):
    project, files, _ = await _legacy_setup(db_session, tmp_path)
    other = await _project(db_session, "Other")
    await _managed(db_session, "Arm.gcode", project_id=other.id)
    project_id, other_id = project.id, other.id

    idle = (await async_client.get(STATUS)).json()
    assert idle == {
        "running": False,
        "total": 0,
        "done": 0,
        "current": None,
        "failures": [],
        "pending": 2,
        "last_run": None,
    }

    response = await async_client.post(START)
    assert response.status_code == 202, response.text
    assert response.json()["running"] is True

    body = await _wait_idle(async_client)
    assert body["total"] == 2 and body["done"] == 2 and body["current"] is None
    assert body["failures"] == [] and body["pending"] == 0
    for pid in (project_id, other_id):
        assert (await _fresh(db_session, Project, pid)).legacy_migrated_at is not None
    assert len(await _revisions(db_session, project_id)) == 3
    # Bracket + Lid moved, Clip copied (project 1); Arm moved (project 2).
    last_run = body["last_run"]
    assert {k: last_run[k] for k in ("projects", "files_moved", "files_copied")} == {
        "projects": 2,
        "files_moved": 3,
        "files_copied": 1,
    }
    assert datetime.fromisoformat(last_run["finished_at"]) <= datetime.now(timezone.utc).replace(tzinfo=None)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_start_records_failures(async_client: AsyncClient, db_session, monkeypatch):
    project = await _project(db_session)
    await _managed(db_session, "Bracket.3mf", project_id=project.id)
    project_id, code = project.id, project.code

    async def boom(*_args, **_kwargs):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(project_files, "add_revision_from_sources", boom)
    assert (await async_client.post(START)).status_code == 202
    body = await _wait_idle(async_client)
    assert body["done"] == 1 and body["pending"] == 1
    # T-285 (user-approved): the group is skipped as ``error`` and the project fails as retryable.
    assert body["failures"] == [
        {
            "project_id": project_id,
            "code": code,
            "error": "1 file(s) could not be moved (error: unexpected error while moving the file); run it again",
        }
    ]
    assert {k: body["last_run"][k] for k in ("projects", "files_moved", "files_copied")} == {
        "projects": 0,
        "files_moved": 0,
        "files_copied": 0,
    }
    assert (await _fresh(db_session, Project, project_id)).legacy_migrated_at is None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_start_conflicts_while_running(async_client: AsyncClient, monkeypatch):
    gate = asyncio.Event()

    async def slow(_db):
        await gate.wait()
        return []

    monkeypatch.setattr(project_filing, "legacy_candidates", slow)
    assert (await async_client.post(START)).status_code == 202
    assert (await async_client.post(START)).status_code == 409
    assert (await async_client.get(STATUS)).json()["running"] is True
    gate.set()
    # Poll the production status route until the runner reports it has finished.
    for _ in range(200):
        if (await async_client.get(STATUS)).json()["running"] is False:
            break
        await asyncio.sleep(0.01)
    assert (await async_client.get(STATUS)).json()["running"] is False


@pytest.fixture
async def users(db_session):
    specs = {
        "admin": [Permission.SETTINGS_UPDATE, Permission.PROJECTS_UPDATE],
        "no_settings": [Permission.PROJECTS_UPDATE, Permission.SETTINGS_READ],
        "no_projects": [Permission.SETTINGS_UPDATE],
    }
    return {key: headers for key, (_, headers) in (await make_users(db_session, "legacy-", specs)).items()}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_permissions(async_client: AsyncClient, users):
    for key in ("no_settings", "no_projects"):
        assert (await async_client.post(START, headers=users[key])).status_code == 403, key
        assert (await async_client.get(STATUS, headers=users[key])).status_code == 403, key
    assert (await async_client.get(STATUS, headers=users["admin"])).status_code == 200
    assert (await async_client.post(START, headers=users["admin"])).status_code == 202
    await _wait_idle(async_client, users["admin"])


# --- T-010: legacy migration failure branches ------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.integration
async def test_an_external_file_gone_from_disk_is_left_and_logged(db_session, tmp_path, caplog):
    """The project already holds a copy (so hashes are compared); a second external file whose
    bytes vanished is not hashed, the move leaves it as ``source_missing``, and that skip is
    not retryable: the marker is set."""
    project = await _project(db_session)
    project_id = project.id
    arm = await _external(db_session, tmp_path, "Arm.gcode", b"G1 X0", project_id=project_id)
    arm_id = arm.id
    await project_filing.migrate_project_legacy(db_session, await _fresh(db_session, Project, project_id))
    fresh = await _fresh(db_session, Project, project_id)
    fresh.legacy_migrated_at = None  # a later run, e.g. after a new file got linked
    await db_session.commit()
    leg = await _external(db_session, tmp_path, "Leg.gcode", b"G1 Y0", project_id=project_id)
    leg_id, leg_path = leg.id, leg.file_path
    Path(leg_path).unlink()

    with caplog.at_level("INFO", logger="backend.app.services.project_filing"):
        outcome = await project_filing.migrate_project_legacy(db_session, await _fresh(db_session, Project, project_id))

    assert (outcome.revisions_created, outcome.files_moved, outcome.files_copied) == (0, 0, 0)
    assert await _revisions(db_session, project_id) == [("impression", "Arm", 1, ["Arm.gcode"])]
    messages = [r.getMessage() for r in caplog.records]
    assert (
        f"Legacy migration of project {project_id}: external file {arm_id} ('Arm.gcode') already copied, skipping"
        in messages
    )
    assert f"Legacy migration of project {project_id} left file {leg_id}: source_missing" in messages
    leg_row = await _fresh(db_session, LibraryFile, leg_id)
    assert (leg_row.revision_id, leg_row.file_path) == (None, leg_path)
    assert (await _fresh(db_session, Project, project_id)).legacy_migrated_at is not None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_read_error_while_hashing_defers_to_the_move(db_session, tmp_path, monkeypatch):
    """Hashing an external file fails with an OSError: no dedupe, the move tries it and
    reports the same read error as ``copy_failed``, so the project stays a candidate."""
    project = await _project(db_session)
    project_id = project.id
    arm = await _external(db_session, tmp_path, "Arm.gcode", b"G1 X0", project_id=project_id)
    await project_filing.migrate_project_legacy(db_session, await _fresh(db_session, Project, project_id))
    fresh = await _fresh(db_session, Project, project_id)
    fresh.legacy_migrated_at = None
    await db_session.commit()
    arm_id, arm_path = arm.id, arm.file_path

    def unreadable(*_args, **_kwargs):
        raise OSError("I/O error")

    monkeypatch.setattr(project_filing, "calculate_file_hash", unreadable)
    monkeypatch.setattr(project_files, "_copy_hashing", unreadable)
    with pytest.raises(project_filing.LegacyMigrationError) as exc:
        await project_filing.migrate_project_legacy(db_session, await _fresh(db_session, Project, project_id))

    assert str(exc.value) == "1 file(s) could not be moved (copy_failed: I/O error); run it again"
    assert await _revisions(db_session, project_id) == [("impression", "Arm", 1, ["Arm.gcode"])]
    arm_row = await _fresh(db_session, LibraryFile, arm_id)
    assert (arm_row.revision_id, arm_row.file_path) == (None, arm_path)
    assert Path(arm_path).read_bytes() == b"G1 X0"
    assert (await _fresh(db_session, Project, project_id)).legacy_migrated_at is None
    assert project_id in await project_filing.legacy_candidates(db_session)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_project_deleted_during_its_migration_is_an_error(db_session, monkeypatch):
    from sqlalchemy import delete

    project = await _project(db_session)
    project_id = project.id

    async def deleted_meanwhile(db, pid):
        await db.execute(delete(Project).where(Project.id == pid))
        await db.commit()
        return []

    monkeypatch.setattr(project_filing, "_legacy_files", deleted_meanwhile)
    with pytest.raises(project_filing.LegacyMigrationError) as exc:
        await project_filing.migrate_project_legacy(db_session, project)
    assert str(exc.value) == "project deleted meanwhile"
    assert (await db_session.execute(select(Project.id).where(Project.id == project_id))).first() is None


# The runner, driven directly (async_client patches database.async_session to the test engine).


def _runner_totals(state: dict) -> dict:
    return {k: state["last_run"][k] for k in ("projects", "files_moved", "files_copied")}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_runner_passes_over_a_project_migrated_or_deleted_meanwhile(
    async_client: AsyncClient, db_session, monkeypatch
):
    done = await _project(db_session, "Done", legacy_migrated_at=datetime(2026, 1, 1))
    lid = await _managed(db_session, "Lid.3mf", b"lid", project_id=done.id)
    done_id, lid_id, lid_path = done.id, lid.id, lid.file_path

    async def stale(_db):
        return [done_id, 987654]  # listed, then migrated / deleted before the runner got there

    async def must_not_run(*_args, **_kwargs):
        raise AssertionError("a project migrated or gone meanwhile must not be migrated")

    monkeypatch.setattr(project_filing, "legacy_candidates", stale)
    monkeypatch.setattr(project_filing, "migrate_project_legacy", must_not_run)
    project_filing._legacy_state["running"] = True
    await project_filing._run_legacy_migration()

    state = project_filing._legacy_state
    assert (state["running"], state["total"], state["done"], state["current"]) == (False, 2, 2, None)
    assert state["failures"] == []
    assert _runner_totals(state) == {"projects": 0, "files_moved": 0, "files_copied": 0}
    lid_row = await _fresh(db_session, LibraryFile, lid_id)
    assert (lid_row.revision_id, lid_row.file_path) == (None, lid_path)


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize(
    "make_error",
    [
        lambda text: project_files.ProjectFilesError(409, text),
        lambda text: RuntimeError(text),
        lambda text: OSError(text),
    ],
    ids=["project-files-error", "runtime-error", "os-error"],
)
async def test_runner_records_the_error_text_capped_at_500(
    async_client: AsyncClient, db_session, monkeypatch, make_error
):
    """The recorded ``error`` is the exception's text (a ProjectFilesError's detail), cut at 500 characters."""
    project = await _project(db_session)
    project_id, code = project.id, project.code
    text = "é" * 499 + "xyz"

    async def candidates(_db):
        return [project_id]

    async def boom(_db, _project):
        raise make_error(text)

    monkeypatch.setattr(project_filing, "legacy_candidates", candidates)
    monkeypatch.setattr(project_filing, "migrate_project_legacy", boom)
    project_filing._legacy_state["running"] = True
    await project_filing._run_legacy_migration()

    assert project_filing._legacy_state["failures"] == [
        {"project_id": project_id, "code": code, "error": "é" * 499 + "x"}
    ]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_runner_records_the_failure_when_its_rollback_fails_too(
    async_client: AsyncClient, db_session, monkeypatch, caplog
):
    project = await _project(db_session)
    project_id, code = project.id, project.code

    async def candidates(_db):
        return [project_id]

    async def boom(db, _project):
        async def broken_rollback():
            raise RuntimeError("connection lost")

        db.rollback = broken_rollback
        raise project_files.ProjectFilesError(409, "This item was changed meanwhile; drop the files again")

    monkeypatch.setattr(project_filing, "legacy_candidates", candidates)
    monkeypatch.setattr(project_filing, "migrate_project_legacy", boom)
    project_filing._legacy_state["running"] = True
    with caplog.at_level("DEBUG", logger="backend.app.services.project_filing"):
        await project_filing._run_legacy_migration()

    state = project_filing._legacy_state
    assert state["failures"] == [
        {"project_id": project_id, "code": code, "error": "This item was changed meanwhile; drop the files again"}
    ]
    assert (state["running"], state["done"], state["current"]) == (False, 1, None)
    messages = [(r.levelname, r.getMessage()) for r in caplog.records]
    assert ("WARNING", f"Legacy migration of project {project_id} failed") in messages
    assert ("DEBUG", "Rollback after a failed legacy migration failed too") in messages
    [quiet] = [r for r in caplog.records if r.getMessage() == "Rollback after a failed legacy migration failed too"]
    assert (quiet.name, quiet.funcName) == ("backend.app.services.project_filing", "_run_legacy_migration")
    assert str(quiet.exc_info[1]) == "connection lost"
    assert (await _fresh(db_session, Project, project_id)).legacy_migrated_at is None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_runner_stops_cleanly_when_listing_candidates_fails(async_client: AsyncClient, monkeypatch, caplog):
    async def broken(_db):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(project_filing, "legacy_candidates", broken)
    project_filing._legacy_state["running"] = True
    with caplog.at_level("ERROR", logger="backend.app.services.project_filing"):
        await project_filing._run_legacy_migration()

    state = project_filing._legacy_state
    assert (state["running"], state["total"], state["done"], state["current"]) == (False, 0, 0, None)
    assert state["failures"] == []
    assert _runner_totals(state) == {"projects": 0, "files_moved": 0, "files_copied": 0}
    assert state["last_run"]["finished_at"] is not None
    filing = [(r.levelname, r.getMessage()) for r in caplog.records if r.name == project_filing.logger.name]
    assert filing == [("ERROR", "Legacy project migration stopped")]
