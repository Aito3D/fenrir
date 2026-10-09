"""Auto-filing by project code (phase 5, task 3): uploads and slicer sends whose
filename starts with ``P-0042_`` land in that project's Impression section."""

import io
import uuid
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.api.routes.library import get_library_files_dir, to_relative_path
from backend.app.core.config import settings
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.pending_upload import PendingUpload
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.services import project_files, project_filing, project_storage
from backend.app.services.project_filing import auto_file_by_code, project_code_from_filename


@pytest.fixture(autouse=True)
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    (tmp_path / "archive").mkdir()
    monkeypatch.setattr(settings, "archive_dir", tmp_path / "archive")
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setattr(project_storage, "projects_root", lambda: projects)
    return projects


def _3mf(marker: str = "x") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("[Content_Types].xml", "<types/>")
        zf.writestr("marker.txt", marker)
    return buf.getvalue()


async def _project(client, name="Support caméra") -> dict:
    response = await client.post("/api/v1/projects/", json={"name": name})
    assert response.status_code in (200, 201), response.text
    return response.json()


async def _managed(db, filename: str, data: bytes) -> LibraryFile:
    path = get_library_files_dir() / f"{uuid.uuid4().hex}{Path(filename).suffix}"
    path.write_bytes(data)
    row = LibraryFile(
        filename=filename,
        file_path=to_relative_path(path),
        file_type="3mf",
        file_size=len(data),
        is_external=False,
    )
    db.add(row)
    await db.commit()
    return row


async def _project_with_support_item(client, db) -> tuple[dict, int]:
    """A project with Impression > "support" at R1 (made through the import route)."""
    project = await _project(client)
    file = await _managed(db, "support.3mf", _3mf("r1"))
    response = await client.post(f"/api/v1/projects/{project['id']}/import-library-files", json={"file_ids": [file.id]})
    assert response.status_code == 200, response.text
    return project, response.json()["moved"][0]["item_id"]


async def _upload(client, filename: str, data: bytes):
    return await client.post(
        "/api/v1/library/files", files={"file": (filename, io.BytesIO(data), "application/octet-stream")}
    )


async def _file_manager_names(client) -> list[str]:
    response = await client.get("/api/v1/library/files")
    assert response.status_code == 200, response.text
    body = response.json()
    rows = body["items"] if isinstance(body, dict) else body
    return [row["filename"] for row in rows]


async def _revisions(db, item_id: int) -> list[ProjectRevision]:
    return list(
        (
            await db.execute(
                select(ProjectRevision)
                .where(ProjectRevision.item_id == item_id)
                .order_by(ProjectRevision.number)
                .execution_options(populate_existing=True)
            )
        ).scalars()
    )


# --- code parsing ----------------------------------------------------------------


def test_project_code_from_filename_cases():
    assert project_code_from_filename("P-0042_x.3mf") == "P-0042"
    assert project_code_from_filename("p-0042 x.stl") == "P-0042"
    assert project_code_from_filename("P-0042-x") == "P-0042"
    assert project_code_from_filename("P-42_x") is None  # needs 4+ digits
    assert project_code_from_filename("xP-0042_") is None


# --- upload hook -------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.integration
async def test_upload_with_code_files_next_revision(async_client: AsyncClient, db_session):
    project, item_id = await _project_with_support_item(async_client, db_session)
    filename = f"{project['code']}_support.3mf"

    response = await _upload(async_client, filename, _3mf("r2"))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["filename"] == filename
    assert body["filed_to_project"] == {
        "project_id": project["id"],
        "code": project["code"],
        "item_name": "support",
        "revision_number": 2,
    }
    assert filename not in await _file_manager_names(async_client)

    revisions = await _revisions(db_session, item_id)
    assert [r.number for r in revisions] == [1, 2]
    row = (
        await db_session.execute(
            select(LibraryFile).where(LibraryFile.id == body["id"]).execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert row.revision_id == revisions[1].id and row.project_id == project["id"]  # same row, re-pointed
    items = (await db_session.execute(select(ProjectItem).where(ProjectItem.project_id == project["id"]))).scalars()
    assert [i.name for i in items] == ["support"]  # existing item reused


@pytest.mark.asyncio
@pytest.mark.integration
async def test_upload_non_printable_with_code_stays_in_file_manager(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    filename = f"{project['code']}_notes.pdf"
    response = await _upload(async_client, filename, b"%PDF-1.4\n%%EOF\n")
    assert response.status_code == 200, response.text
    assert response.json().get("filed_to_project") is None
    assert filename in await _file_manager_names(async_client)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_upload_unknown_code_stays_in_file_manager(async_client: AsyncClient, db_session):
    await _project(async_client)
    response = await _upload(async_client, "P-9876_support.3mf", _3mf())
    assert response.status_code == 200, response.text
    assert response.json().get("filed_to_project") is None
    assert "P-9876_support.3mf" in await _file_manager_names(async_client)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_upload_template_code_is_not_filed(async_client: AsyncClient, db_session):
    from backend.app.models.project import Project

    project = await _project(async_client)
    row = await db_session.get(Project, project["id"])
    row.is_template = True
    await db_session.commit()
    filename = f"{project['code']}_support.3mf"
    response = await _upload(async_client, filename, _3mf())
    assert response.status_code == 200, response.text
    assert response.json().get("filed_to_project") is None
    assert filename in await _file_manager_names(async_client)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_setting_off_disables_auto_filing(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    settings_response = await async_client.put("/api/v1/settings/", json={"projects_auto_file_by_code": False})
    assert settings_response.status_code == 200, settings_response.text
    assert settings_response.json()["projects_auto_file_by_code"] is False

    filename = f"{project['code']}_support.3mf"
    response = await _upload(async_client, filename, _3mf())
    assert response.status_code == 200, response.text
    assert response.json().get("filed_to_project") is None
    assert filename in await _file_manager_names(async_client)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_setting_defaults_to_true(async_client: AsyncClient):
    response = await async_client.get("/api/v1/settings/")
    assert response.status_code == 200
    assert response.json()["projects_auto_file_by_code"] is True


@pytest.mark.asyncio
@pytest.mark.integration
async def test_error_inside_auto_filing_keeps_upload(async_client: AsyncClient, db_session, monkeypatch):
    project = await _project(async_client)
    monkeypatch.setattr(project_files, "add_revision_from_sources", AsyncMock(side_effect=RuntimeError("disk on fire")))
    filename = f"{project['code']}_support.3mf"
    response = await _upload(async_client, filename, _3mf())
    assert response.status_code == 200, response.text
    assert response.json().get("filed_to_project") is None
    assert filename in await _file_manager_names(async_client)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_hook_survives_auto_file_raising(async_client: AsyncClient, db_session, monkeypatch):
    project = await _project(async_client)
    monkeypatch.setattr(project_filing, "auto_file_by_code", AsyncMock(side_effect=RuntimeError("boom")))
    filename = f"{project['code']}_support.3mf"
    response = await _upload(async_client, filename, _3mf())
    assert response.status_code == 200, response.text
    assert filename in await _file_manager_names(async_client)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_auto_file_copy_from_path_creates_new_item(async_client: AsyncClient, db_session, tmp_path):
    project = await _project(async_client)
    received = tmp_path / "received.3mf"
    received.write_bytes(_3mf("copy"))
    result = await auto_file_by_code(
        db_session,
        filename=f"{project['code'].lower()} Bracket.gcode.3mf",
        path=received,
        library_file=None,
        user_id=None,
    )
    assert result is not None
    assert (result.project_id, result.code, result.item_name, result.revision_number) == (
        project["id"],
        project["code"],
        "Bracket",
        1,
    )
    assert received.is_file()  # the source is never touched
    row = (await db_session.execute(select(LibraryFile).where(LibraryFile.id == result.file_id))).scalar_one()
    assert row.revision_id == result.revision_id and row.project_id == project["id"]


# --- virtual printer and review queue hooks -----------------------------------------


@pytest.mark.asyncio
@pytest.mark.integration
async def test_virtual_printer_archive_also_files_a_copy(async_client: AsyncClient, db_session, test_engine, tmp_path):
    from backend.app.services.virtual_printer.manager import VirtualPrinterInstance

    project, item_id = await _project_with_support_item(async_client, db_session)
    factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    vp_dir = tmp_path / "vp"
    vp_dir.mkdir()
    inst = VirtualPrinterInstance(
        vp_id=41,
        name="AutoFile",
        mode="archive",
        model="C12",
        access_code="12345678",
        serial_suffix="391800041",
        base_dir=vp_dir,
        session_factory=factory,
    )
    received = vp_dir / f"{project['code']}_support.3mf"
    received.write_bytes(_3mf("vp"))

    with patch.object(inst, "_broadcast_archive_created", new_callable=AsyncMock):
        await inst._archive_file(received, "192.168.1.50")

    archives = list((await db_session.execute(select(PrintArchive))).scalars())
    assert [a.filename for a in archives] == [received.name]
    revisions = await _revisions(db_session, item_id)
    assert [r.number for r in revisions] == [1, 2]
    copies = list(
        (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == revisions[1].id))).scalars()
    )
    assert [c.filename for c in copies] == [received.name]
    assert not received.exists()  # the temp file is still cleaned up


@pytest.mark.asyncio
@pytest.mark.integration
async def test_pending_upload_archive_also_files_a_copy(async_client: AsyncClient, db_session, tmp_path):
    project, item_id = await _project_with_support_item(async_client, db_session)
    filename = f"{project['code']}_support.3mf"
    temp = tmp_path / "pending" / filename
    temp.parent.mkdir()
    temp.write_bytes(_3mf("pending"))
    pending = PendingUpload(
        filename=filename, file_path=str(temp), file_size=temp.stat().st_size, source_ip="10.0.0.2", status="pending"
    )
    db_session.add(pending)
    await db_session.commit()

    response = await async_client.post(f"/api/v1/pending-uploads/{pending.id}/archive")
    assert response.status_code == 200, response.text
    assert response.json()["filename"] == filename

    revisions = await _revisions(db_session, item_id)
    assert [r.number for r in revisions] == [1, 2]
    copies = list(
        (await db_session.execute(select(LibraryFile).where(LibraryFile.revision_id == revisions[1].id))).scalars()
    )
    assert [c.filename for c in copies] == [filename]
    assert not temp.exists()


@pytest.mark.asyncio
@pytest.mark.integration
async def test_uploader_without_projects_update_is_not_auto_filed(async_client: AsyncClient, db_session):
    from backend.app.core.auth import create_access_token, get_password_hash
    from backend.app.core.permissions import Permission
    from backend.app.models.group import Group
    from backend.app.models.project import Project
    from backend.app.models.settings import Settings
    from backend.app.models.user import User

    project = Project(name="Support")
    db_session.add(project)
    db_session.add(Settings(key="auth_enabled", value="true"))
    group = Group(
        name="autofile-uploader",
        permissions=[Permission.LIBRARY_UPLOAD.value, Permission.LIBRARY_READ_ALL.value],
        is_system=False,
    )
    db_session.add(group)
    await db_session.flush()
    user = User(username="autofile-uploader", password_hash=get_password_hash("password"), is_active=True)
    user.groups.append(group)
    db_session.add(user)
    await db_session.commit()
    headers = {"Authorization": f"Bearer {create_access_token(data={'sub': user.username})}"}
    assert project.code and project.code.startswith("P-")

    filename = f"{project.code}_support.3mf"
    response = await async_client.post(
        "/api/v1/library/files",
        files={"file": (filename, io.BytesIO(_3mf()), "application/octet-stream")},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    assert response.json().get("filed_to_project") is None
    listed = await async_client.get("/api/v1/library/files", headers=headers)
    assert filename in [row["filename"] for row in listed.json()]


# --- pending-upload archive under auth: the auto-filing permission gate (T-046) ----------


async def _archive_pending_as(client: AsyncClient, db, permissions: list[str], tmp_path) -> dict:
    """Archive a ``P-xxxx_support.3mf`` pending upload as a user holding exactly
    ``permissions``, with auth on. The project (Impression > "support" at R1) and an
    active Aito order linked to it are set up with auth still off."""
    from backend.app.core.auth import create_access_token, get_password_hash
    from backend.app.models.aito_project import AitoProject
    from backend.app.models.aito_task import AitoTask
    from backend.app.models.group import Group
    from backend.app.models.settings import Settings
    from backend.app.models.user import User

    project, item_id = await _project_with_support_item(client, db)
    order = AitoProject(
        description="Commande", board_column="devis", status="active", client_id="C1", client_name="ACME"
    )
    db.add(order)
    await db.commit()
    task = AitoTask(project_id=order.id, title="Support")
    db.add(task)
    await db.commit()
    linked = await client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})
    assert linked.status_code == 200, linked.text

    filename = f"{project['code']}_support.3mf"
    data = _3mf("pending-auth")
    temp = tmp_path / "pending" / filename
    temp.parent.mkdir()
    temp.write_bytes(data)
    pending = PendingUpload(
        filename=filename, file_path=str(temp), file_size=len(data), source_ip="10.0.0.3", status="pending"
    )
    db.add(pending)
    db.add(Settings(key="auth_enabled", value="true"))
    group = Group(name=f"pending-archiver-{uuid.uuid4().hex[:8]}", permissions=permissions, is_system=False)
    db.add(group)
    await db.flush()
    user = User(username=f"archiver-{uuid.uuid4().hex[:8]}", password_hash=get_password_hash("pw"), is_active=True)
    user.groups.append(group)
    db.add(user)
    await db.commit()
    headers = {"Authorization": f"Bearer {create_access_token(data={'sub': user.username})}"}

    anonymous = await client.post(f"/api/v1/pending-uploads/{pending.id}/archive")
    assert anonymous.status_code == 401, anonymous.text  # auth really is on
    response = await client.post(f"/api/v1/pending-uploads/{pending.id}/archive", headers=headers)
    return {
        "response": response,
        "project": project,
        "item_id": item_id,
        "order_id": order.id,
        "filename": filename,
        "data": data,
        "temp": temp,
    }


async def _assert_pending_archive_filed_a_copy(db, run: dict) -> None:
    """The archive succeeded AND a copy was filed as R2 of the "support" item, with
    a ``project.revision_added`` event (no actor: the route passes user_id=None)."""
    from backend.app.api.routes.library import to_absolute_path
    from backend.app.models.aito_event import AitoEvent

    response = run["response"]
    assert response.status_code == 200, response.text
    assert response.json()["filename"] == run["filename"]
    archives = list((await db.execute(select(PrintArchive))).scalars())
    assert [a.filename for a in archives] == [run["filename"]]

    revisions = await _revisions(db, run["item_id"])
    assert [r.number for r in revisions] == [1, 2]
    items = list(
        (await db.execute(select(ProjectItem).where(ProjectItem.project_id == run["project"]["id"]))).scalars()
    )
    assert [i.name for i in items] == ["support"]
    copies = list(
        (
            await db.execute(
                select(LibraryFile)
                .where(LibraryFile.revision_id == revisions[1].id)
                .execution_options(populate_existing=True)
            )
        ).scalars()
    )
    assert [c.filename for c in copies] == [run["filename"]]
    assert copies[0].project_id == run["project"]["id"]
    on_disk = to_absolute_path(copies[0].file_path)
    assert on_disk is not None and on_disk.read_bytes() == run["data"]
    assert not run["temp"].exists()  # the temp file is still cleaned up

    events = list(
        (
            await db.execute(
                select(AitoEvent).where(
                    AitoEvent.project_id == run["order_id"], AitoEvent.kind == "project.revision_added"
                )
            )
        ).scalars()
    )
    assert len(events) == 1  # R1 predates the link
    assert events[0].subject_label == "support R2"
    assert events[0].actor_name is None
    assert events[0].detail["revision_id"] == revisions[1].id
    assert events[0].detail["item_id"] == run["item_id"]
    assert events[0].detail["project_id"] == run["project"]["id"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_pending_archive_without_projects_update_still_files_a_copy(
    async_client: AsyncClient, db_session, tmp_path
):
    """PINNED CURRENT BEHAVIOR, not a desired contract (T-046): the archive route is
    gated by queue:create only and calls auto_file_by_code with no projects:update
    check, so a caller WITHOUT projects:update still gets the file filed into the
    project as a new revision. Unlike the library upload path
    (test_uploader_without_projects_update_is_not_auto_filed). If that gap is
    closed, this test must change deliberately."""
    from backend.app.core.permissions import Permission

    run = await _archive_pending_as(async_client, db_session, [Permission.QUEUE_CREATE.value], tmp_path)
    await _assert_pending_archive_filed_a_copy(db_session, run)


@pytest.mark.asyncio
@pytest.mark.integration
async def test_pending_archive_with_projects_update_files_a_copy(async_client: AsyncClient, db_session, tmp_path):
    """The mirror case: a caller holding projects:update gets the same outcome."""
    from backend.app.core.permissions import Permission

    run = await _archive_pending_as(
        async_client, db_session, [Permission.QUEUE_CREATE.value, Permission.PROJECTS_UPDATE.value], tmp_path
    )
    await _assert_pending_archive_filed_a_copy(db_session, run)
