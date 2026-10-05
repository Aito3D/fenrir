"""Legacy project files migration (phase 5, task 4).

Printing files only: a project's linked File Manager files (``LibraryFile.project_id``
or a folder linked with ``LibraryFolder.project_id``) that are printable move into
the project tree (Impression); everything else, legacy attachments and the cover
image included, stays where it is.
"""

import asyncio
import hashlib
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from backend.app.api.routes.library import get_library_files_dir, to_absolute_path, to_relative_path
from backend.app.core.auth import create_access_token, get_password_hash
from backend.app.core.config import settings
from backend.app.core.permissions import Permission
from backend.app.models.group import Group
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.models.settings import Settings
from backend.app.models.user import User
from backend.app.services import project_files, project_filing, project_storage

START = "/api/v1/projects/legacy-migration/start"
STATUS = "/api/v1/projects/legacy-migration/status"


@pytest.fixture(autouse=True)
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    monkeypatch.setattr(settings, "archive_dir", tmp_path / "archive")
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setattr(project_storage, "projects_root", lambda: projects)
    return projects


@pytest.fixture(autouse=True)
def idle_runner():
    project_filing.reset_legacy_migration_state()
    yield
    project_filing.reset_legacy_migration_state()


async def _project(db, name="Support caméra", **fields) -> Project:
    project = Project(name=name, **fields)
    db.add(project)
    await db.commit()
    return project


async def _folder(db, project_id: int | None, **fields) -> LibraryFolder:
    folder = LibraryFolder(name=f"F-{uuid.uuid4().hex[:6]}", project_id=project_id, **fields)
    db.add(folder)
    await db.commit()
    return folder


async def _managed(db, filename: str, data: bytes = b"bytes", **fields) -> LibraryFile:
    path = get_library_files_dir() / f"{uuid.uuid4().hex}{Path(filename).suffix}"
    path.write_bytes(data)
    row = LibraryFile(
        filename=filename,
        file_path=to_relative_path(path),
        file_type=Path(filename).suffix.lstrip(".") or "unknown",
        file_size=len(data),
        is_external=False,
        **fields,
    )
    db.add(row)
    await db.commit()
    return row


async def _external(db, tmp_path: Path, filename: str, data: bytes, **fields) -> LibraryFile:
    mount = tmp_path / f"mount-{uuid.uuid4().hex[:6]}"
    mount.mkdir()
    (mount / filename).write_bytes(data)
    folder = LibraryFolder(name="NAS", is_external=True, external_readonly=True, external_path=str(mount))
    db.add(folder)
    await db.flush()
    row = LibraryFile(
        folder_id=folder.id,
        filename=filename,
        file_path=str(mount / filename),
        file_type=Path(filename).suffix.lstrip("."),
        file_size=len(data),
        is_external=True,
        **fields,
    )
    db.add(row)
    await db.commit()
    return row


async def _fresh(db, model, row_id):
    return (
        await db.execute(select(model).where(model.id == row_id).execution_options(populate_existing=True))
    ).scalar_one()


async def _revisions(db, project_id: int) -> list[tuple[str, str, int, list[str]]]:
    rows = (
        await db.execute(
            select(ProjectItem.section, ProjectItem.name, ProjectRevision.number, ProjectRevision.id)
            .join(ProjectRevision, ProjectRevision.item_id == ProjectItem.id)
            .where(ProjectItem.project_id == project_id)
            .order_by(ProjectItem.name, ProjectRevision.number)
        )
    ).all()
    out = []
    for section, name, number, revision_id in rows:
        names = (
            (
                await db.execute(
                    select(LibraryFile.filename)
                    .where(LibraryFile.revision_id == revision_id)
                    .order_by(LibraryFile.filename)
                )
            )
            .scalars()
            .all()
        )
        out.append((section, name, number, list(names)))
    return out


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
    with pytest.raises(RuntimeError):
        await project_filing.migrate_project_legacy(db_session, await _fresh(db_session, Project, project_id))
    fresh = await _fresh(db_session, Project, project_id)
    assert fresh.legacy_migrated_at is None
    assert [r[1] for r in await _revisions(db_session, project_id)] == ["Clip"]
    assert project_id in await project_filing.legacy_candidates(db_session)

    monkeypatch.setattr(project_files, "add_revision_from_sources", real)
    outcome = await project_filing.migrate_project_legacy(db_session, fresh)
    assert (outcome.revisions_created, outcome.files_moved, outcome.files_copied) == (2, 2, 0)
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
    assert project_filing._sha256_file(path) == hashlib.sha256(b"abc").hexdigest()


# --- endpoints -------------------------------------------------------------------


async def _wait_idle(client: AsyncClient, headers=None) -> dict:
    for _ in range(200):
        body = (await client.get(STATUS, headers=headers)).json()
        if not body["running"]:
            return body
        await asyncio.sleep(0.02)
    raise AssertionError("migration never finished")


@pytest.mark.asyncio
@pytest.mark.integration
async def test_start_and_status(async_client: AsyncClient, db_session, tmp_path):
    project, files, _ = await _legacy_setup(db_session, tmp_path)
    other = await _project(db_session, "Other")
    await _managed(db_session, "Arm.gcode", project_id=other.id)
    project_id, other_id = project.id, other.id

    idle = (await async_client.get(STATUS)).json()
    assert idle == {"running": False, "total": 0, "done": 0, "current": None, "failures": [], "pending": 2}

    response = await async_client.post(START)
    assert response.status_code == 202, response.text
    assert response.json()["running"] is True

    body = await _wait_idle(async_client)
    assert body["total"] == 2 and body["done"] == 2 and body["current"] is None
    assert body["failures"] == [] and body["pending"] == 0
    for pid in (project_id, other_id):
        assert (await _fresh(db_session, Project, pid)).legacy_migrated_at is not None
    assert len(await _revisions(db_session, project_id)) == 3


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
    assert body["failures"] == [{"project_id": project_id, "code": code, "error": "disk on fire"}]
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
    for _ in range(200):
        if not project_filing.legacy_migration_status_running():
            break
        await asyncio.sleep(0.01)
    assert not project_filing.legacy_migration_status_running()


@pytest.fixture
async def users(db_session):
    db_session.add(Settings(key="auth_enabled", value="true"))
    specs = {
        "admin": [Permission.SETTINGS_UPDATE, Permission.PROJECTS_UPDATE],
        "no_settings": [Permission.PROJECTS_UPDATE, Permission.SETTINGS_READ],
        "no_projects": [Permission.SETTINGS_UPDATE],
    }
    out = {}
    for key, permissions in specs.items():
        group = Group(name=f"legacy-{key}", permissions=[p.value for p in permissions], is_system=False)
        db_session.add(group)
        await db_session.flush()
        user = User(username=f"legacy-{key}", password_hash=get_password_hash("password"), is_active=True)
        user.groups.append(group)
        db_session.add(user)
        await db_session.flush()
        out[key] = {"Authorization": f"Bearer {create_access_token(data={'sub': user.username})}"}
    await db_session.commit()
    return out


@pytest.mark.asyncio
@pytest.mark.integration
async def test_permissions(async_client: AsyncClient, users):
    for key in ("no_settings", "no_projects"):
        assert (await async_client.post(START, headers=users[key])).status_code == 403, key
        assert (await async_client.get(STATUS, headers=users[key])).status_code == 403, key
    assert (await async_client.get(STATUS, headers=users["admin"])).status_code == 200
    assert (await async_client.post(START, headers=users["admin"])).status_code == 202
    await _wait_idle(async_client, users["admin"])
