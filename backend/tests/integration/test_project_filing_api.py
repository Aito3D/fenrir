"""Importing File Manager files into a project and project suggestions (phase 5, task 2)."""

import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.api.routes.library import get_library_files_dir, to_absolute_path, to_relative_path
from backend.app.core.auth import create_access_token, get_password_hash
from backend.app.core.config import settings
from backend.app.core.permissions import Permission
from backend.app.models.group import Group
from backend.app.models.library import LibraryFile
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem
from backend.app.models.settings import Settings
from backend.app.models.user import User
from backend.app.services import project_storage
from backend.app.services.project_filing import project_code_from_filename


@pytest.fixture(autouse=True)
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    monkeypatch.setattr(settings, "archive_dir", tmp_path / "archive")
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setattr(project_storage, "projects_root", lambda: projects)
    return projects


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


async def _project(client, name="Support caméra") -> dict:
    response = await client.post("/api/v1/projects/", json={"name": name})
    assert response.status_code in (200, 201), response.text
    return response.json()


def _import_url(project_id: int) -> str:
    return f"/api/v1/projects/{project_id}/import-library-files"


# --- import route --------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.integration
async def test_import_moves_and_reports(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    printable = await _managed(db_session, "Bracket.3mf")
    mesh = await _managed(db_session, "Bracket.stl")
    printable_id, mesh_id = printable.id, mesh.id

    response = await async_client.post(_import_url(project["id"]), json={"file_ids": [printable_id, mesh_id]})
    assert response.status_code == 200, response.text
    body = response.json()
    assert [m["file_id"] for m in body["moved"]] == [printable_id]
    moved = body["moved"][0]
    assert moved["section"] == "impression" and moved["item_name"] == "Bracket" and moved["revision_number"] == 1
    assert body["copied"] == []
    assert body["skipped"] == [{"file_id": mesh_id, "code": "not_printable", "reason": body["skipped"][0]["reason"]}]

    row = (
        await db_session.execute(
            select(LibraryFile).where(LibraryFile.id == printable_id).execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert row.project_id == project["id"] and row.revision_id == moved["revision_id"]
    assert to_absolute_path(row.file_path).is_file()


@pytest.mark.asyncio
@pytest.mark.integration
async def test_project_trashed_and_unknown_files_are_not_found(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    first = await _managed(db_session, "Arm.3mf")
    trashed = await _managed(db_session, "Gone.3mf", deleted_at=datetime.now(timezone.utc))
    first_id, trashed_id = first.id, trashed.id
    assert (await async_client.post(_import_url(project["id"]), json={"file_ids": [first_id]})).status_code == 200

    response = await async_client.post(_import_url(project["id"]), json={"file_ids": [first_id, trashed_id, 987654]})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["moved"] == [] and body["copied"] == []
    assert sorted((s["file_id"], s["code"]) for s in body["skipped"]) == [
        (first_id, "not_found"),
        (trashed_id, "not_found"),
        (987654, "not_found"),
    ]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_import_validation(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    url = _import_url(project["id"])
    assert (await async_client.post(url, json={"file_ids": list(range(1, 202))})).status_code == 422
    assert (await async_client.post(url, json={"file_ids": []})).status_code == 422
    assert (await async_client.post(url, json={"file_ids": [1], "section": "scan"})).status_code == 422

    file = await _managed(db_session, "Arm.3mf")
    file_id = file.id
    item = (
        await async_client.post(
            f"/api/v1/projects/{project['id']}/items", json={"section": "modelisation", "name": "Arm"}
        )
    ).json()
    disabled = await async_client.post(url, json={"file_ids": [file_id], "item_id": item["id"]})
    assert disabled.status_code == 400
    both = await async_client.post(url, json={"file_ids": [file_id], "item_id": item["id"], "new_item_name": "X"})
    assert both.status_code == 400
    blank = await async_client.post(url, json={"file_ids": [file_id], "new_item_name": "  "})
    assert blank.status_code in (400, 422)
    assert (await async_client.post(url, json={"file_ids": [file_id], "item_id": 999999})).status_code == 404
    assert (await async_client.post(_import_url(999999), json={"file_ids": [file_id]})).status_code == 404
    # Nothing moved by the refused calls.
    row = (
        await db_session.execute(
            select(LibraryFile).where(LibraryFile.id == file_id).execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert row.revision_id is None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_import_into_new_item_name(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    a = await _managed(db_session, "a.3mf", b"a")
    b = await _managed(db_session, "b.gcode", b"b")
    response = await async_client.post(
        _import_url(project["id"]), json={"file_ids": [a.id, b.id], "new_item_name": "Kit"}
    )
    assert response.status_code == 200, response.text
    moved = response.json()["moved"]
    assert {m["item_name"] for m in moved} == {"Kit"} and {m["revision_number"] for m in moved} == {1}


# --- permissions ---------------------------------------------------------------


@pytest.fixture
async def users(db_session):
    """Auth on. Each user gets one group with exactly the listed permissions."""
    db_session.add(Settings(key="auth_enabled", value="true"))
    specs = {
        "own": [Permission.LIBRARY_UPDATE_OWN, Permission.PROJECTS_UPDATE],
        "all": [Permission.LIBRARY_UPDATE_ALL, Permission.PROJECTS_UPDATE],
        "no_projects": [Permission.LIBRARY_UPDATE_ALL],
        "reader": [Permission.LIBRARY_READ_OWN, Permission.PROJECTS_READ],
        "reader_no_projects": [Permission.LIBRARY_READ_ALL],
    }
    out = {}
    for key, permissions in specs.items():
        group = Group(name=f"filing-{key}", permissions=[p.value for p in permissions], is_system=False)
        db_session.add(group)
        await db_session.flush()
        user = User(username=f"filing-{key}", password_hash=get_password_hash("password"), is_active=True)
        user.groups.append(group)
        db_session.add(user)
        await db_session.flush()
        out[key] = (user.id, {"Authorization": f"Bearer {create_access_token(data={'sub': user.username})}"})
    await db_session.commit()
    return out


async def _project_row(db, name="Support") -> int:
    project = Project(name=name)
    db.add(project)
    await db.commit()
    return project.id


@pytest.mark.asyncio
@pytest.mark.integration
async def test_import_applies_the_file_manager_ownership_rule(async_client: AsyncClient, db_session, users):
    project_id = await _project_row(db_session)
    own_id, own_headers = users["own"]
    all_id, all_headers = users["all"]
    mine = await _managed(db_session, "Mine.3mf", b"m", created_by_id=own_id)
    theirs = await _managed(db_session, "Theirs.3mf", b"t", created_by_id=all_id)
    ownerless = await _managed(db_session, "Nobody.3mf", b"n")
    mine_id, theirs_id, ownerless_id = mine.id, theirs.id, ownerless.id

    response = await async_client.post(
        _import_url(project_id), json={"file_ids": [mine_id, theirs_id, ownerless_id]}, headers=own_headers
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert [m["file_id"] for m in body["moved"]] == [mine_id]
    assert sorted((s["file_id"], s["code"]) for s in body["skipped"]) == [
        (theirs_id, "not_owner"),
        (ownerless_id, "not_owner"),
    ]

    response = await async_client.post(
        _import_url(project_id), json={"file_ids": [theirs_id, ownerless_id]}, headers=all_headers
    )
    assert response.status_code == 200, response.text
    assert sorted(m["file_id"] for m in response.json()["moved"]) == sorted([theirs_id, ownerless_id])


@pytest.mark.asyncio
@pytest.mark.integration
async def test_import_needs_projects_update_and_library_update(async_client: AsyncClient, db_session, users):
    project_id = await _project_row(db_session)
    file = await _managed(db_session, "Arm.3mf")
    for key in ("no_projects", "reader"):
        response = await async_client.post(_import_url(project_id), json={"file_ids": [file.id]}, headers=users[key][1])
        assert response.status_code == 403, (key, response.text)


# --- suggestions ---------------------------------------------------------------


def test_project_code_from_filename():
    assert project_code_from_filename("P-0042_Bracket.3mf") == "P-0042"
    assert project_code_from_filename("p-42 x.3mf") is None
    assert project_code_from_filename("p-00042-x.gcode") == "P-0042"
    assert project_code_from_filename("P-12345 Arm.3mf") == "P-12345"
    assert project_code_from_filename("P-0042.3mf") is None
    assert project_code_from_filename("Bracket P-0042_x.3mf") is None


def _suggest_url(file_id: int) -> str:
    return f"/api/v1/library/files/{file_id}/project-suggestions"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_suggestions_order_code_item_project(async_client: AsyncClient, db_session):
    by_code = await _project(async_client, "Alpha")
    by_item = await _project(async_client, "Zeta")
    by_name = await _project(async_client, "Bracket arm stand")
    item = await async_client.post(
        f"/api/v1/projects/{by_item['id']}/items", json={"section": "impression", "name": "Bracket arm"}
    )
    assert item.status_code == 201, item.text
    template = Project(name="Bracket arm", is_template=True)
    db_session.add(template)
    await db_session.flush()
    db_session.add(
        ProjectItem(project_id=template.id, section="impression", name="Bracket arm", name_key="bracket arm")
    )
    await db_session.commit()
    template_id = template.id

    file = await _managed(db_session, f"{by_code['code']}_Bracket arm.3mf")
    response = await async_client.get(_suggest_url(file.id))
    assert response.status_code == 200, response.text
    body = response.json()
    assert [(s["project_id"], s["reason"]) for s in body] == [
        (by_code["id"], "code"),
        (by_item["id"], "item_name"),
        (by_name["id"], "project_name"),
    ]
    assert body[0]["score"] == 1.0 and body[0]["code"] == by_code["code"] and body[0]["item_id"] is None
    assert body[1]["item_id"] == item.json()["id"] and body[1]["item_name"] == "Bracket arm"
    assert body[1]["score"] == 1.0 and 0.45 <= body[2]["score"] < 1.0  # code prefix stripped: exact item match
    assert all(s["project_id"] != template_id for s in body)

    limited = (await async_client.get(_suggest_url(file.id), params={"limit": 2})).json()
    assert [s["project_id"] for s in limited] == [by_code["id"], by_item["id"]]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_suggestions_deduplicate_and_skip_non_printable(async_client: AsyncClient, db_session):
    project = await _project(async_client, "Bracket")
    await async_client.post(
        f"/api/v1/projects/{project['id']}/items", json={"section": "impression", "name": "Bracket"}
    )
    file = await _managed(db_session, f"{project['code']}_Bracket.3mf")
    body = (await async_client.get(_suggest_url(file.id))).json()
    assert [(s["project_id"], s["reason"]) for s in body] == [(project["id"], "code")]

    mesh = await _managed(db_session, "Bracket.stl")
    response = await async_client.get(_suggest_url(mesh.id))
    assert response.status_code == 200 and response.json() == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_suggestions_visibility(async_client: AsyncClient, db_session, users):
    reader_id, reader_headers = users["reader"]
    other_id, _ = users["own"]
    mine = await _managed(db_session, "Mine.3mf", b"m", created_by_id=reader_id)
    theirs = await _managed(db_session, "Theirs.3mf", b"t", created_by_id=other_id)
    trashed = await _managed(
        db_session, "Gone.3mf", b"g", created_by_id=reader_id, deleted_at=datetime.now(timezone.utc)
    )
    mine_id, theirs_id, trashed_id = mine.id, theirs.id, trashed.id

    assert (await async_client.get(_suggest_url(mine_id), headers=reader_headers)).status_code == 200
    assert (await async_client.get(_suggest_url(theirs_id), headers=reader_headers)).status_code == 404
    assert (await async_client.get(_suggest_url(trashed_id), headers=reader_headers)).status_code == 404
    assert (await async_client.get(_suggest_url(987654), headers=reader_headers)).status_code == 404
    response = await async_client.get(_suggest_url(mine_id), headers=users["reader_no_projects"][1])
    assert response.status_code == 403


@pytest.mark.asyncio
@pytest.mark.integration
async def test_suggestions_hide_project_files(async_client: AsyncClient, db_session):
    project = await _project(async_client)
    file = await _managed(db_session, "Arm.3mf")
    file_id = file.id
    assert (await async_client.post(_import_url(project["id"]), json={"file_ids": [file_id]})).status_code == 200
    assert (await async_client.get(_suggest_url(file_id))).status_code == 404
