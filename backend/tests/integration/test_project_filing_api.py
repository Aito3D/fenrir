"""Importing File Manager files into a project and project suggestions (phase 5, task 2)."""

from datetime import datetime, timezone
from difflib import SequenceMatcher

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.api.routes.library import to_absolute_path
from backend.app.core.auth import create_access_token, get_password_hash
from backend.app.core.permissions import Permission
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.group import Group
from backend.app.models.library import LibraryFile
from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem
from backend.app.models.settings import Settings
from backend.app.models.user import User
from backend.app.services.project_filing import project_code_from_filename, suggest_projects_for_filename
from backend.tests.project_fixtures import (
    api_project as _project,
    make_managed_library_file as _managed,
    projects_root_fixture,
)

root = projects_root_fixture(autouse=True, subdir="projects", library=True)


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
async def test_import_records_the_revision_added_label_and_detail(async_client: AsyncClient, db_session):
    """Each imported revision is a ``project.revision_added`` on the linked orders:
    ``"<item> R<n>"`` and section/item_id/revision_id, in that order after project_id/code."""
    project = await _project(async_client)
    order = AitoProject(description="Commande", board_column="devis", status="active", client_id="C1")
    db_session.add(order)
    await db_session.commit()
    db_session.add(AitoTask(project_id=order.id, title="Support", linked_project_id=project["id"]))
    await db_session.commit()
    printable = await _managed(db_session, "Bracket.3mf")

    response = await async_client.post(_import_url(project["id"]), json={"file_ids": [printable.id]})
    assert response.status_code == 200, response.text
    moved = response.json()["moved"][0]
    [event] = (
        (
            await db_session.execute(
                select(AitoEvent).where(AitoEvent.project_id == order.id, AitoEvent.kind == "project.revision_added")
            )
        )
        .scalars()
        .all()
    )
    assert event.subject_label == "Bracket R1"
    assert list(event.detail.items()) == [
        ("project_id", project["id"]),
        ("code", project["code"]),
        ("section", "impression"),
        ("item_id", moved["item_id"]),
        ("revision_id", moved["revision_id"]),
    ]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_import_with_an_unexpected_group_failure_reports_it_and_records_the_rest(
    async_client: AsyncClient, db_session, monkeypatch
):
    """T-285 (user-approved): a group failing with an unexpected error (here "database is
    locked") is listed under ``skipped`` with code ``error``; the response is a 200 and the
    groups that went through are moved and recorded as ``project.revision_added``."""
    from sqlalchemy.exc import OperationalError

    from backend.app.services import project_files

    project = await _project(async_client)
    order = AitoProject(description="Commande", board_column="devis", status="active", client_id="C1")
    db_session.add(order)
    await db_session.commit()
    order_id = order.id
    db_session.add(AitoTask(project_id=order_id, title="Support", linked_project_id=project["id"]))
    await db_session.commit()
    files = [await _managed(db_session, name) for name in ("Arm.3mf", "Bracket.3mf", "Lid.3mf")]
    ids = [f.id for f in files]
    bracket_path = files[1].file_path
    real = project_files.add_revision_from_sources

    async def locked(db, project, item, sources, **kwargs):
        if item.name == "Bracket":
            raise OperationalError("COMMIT", {}, Exception("database is locked"))
        return await real(db, project, item, sources, **kwargs)

    monkeypatch.setattr(project_files, "add_revision_from_sources", locked)
    response = await async_client.post(_import_url(project["id"]), json={"file_ids": ids})

    assert response.status_code == 200, response.text
    body = response.json()
    assert [(m["file_id"], m["item_name"]) for m in body["moved"]] == [(ids[0], "Arm"), (ids[2], "Lid")]
    assert body["copied"] == []
    assert body["skipped"] == [{"file_id": ids[1], "code": "error", "reason": "unexpected error while moving the file"}]
    events = (
        (
            await db_session.execute(
                select(AitoEvent).where(AitoEvent.project_id == order_id, AitoEvent.kind == "project.revision_added")
            )
        )
        .scalars()
        .all()
    )
    assert sorted(e.subject_label for e in events) == ["Arm R1", "Lid R1"]
    row = (
        await db_session.execute(
            select(LibraryFile).where(LibraryFile.id == ids[1]).execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert (row.file_path, row.revision_id, row.project_id) == (bracket_path, None, None)
    assert to_absolute_path(bracket_path).is_file()


@pytest.mark.asyncio
@pytest.mark.integration
async def test_import_with_a_non_409_group_error_is_still_the_whole_calls_error(
    async_client: AsyncClient, db_session, monkeypatch
):
    """Unchanged by T-285: a non-409 ProjectFilesError while storing stops the import with its status."""
    from backend.app.services import project_files

    project = await _project(async_client)
    printable = await _managed(db_session, "Bracket.3mf")

    async def refused(*_args, **_kwargs):
        raise project_files.ProjectFilesError(413, "Too big")

    monkeypatch.setattr(project_files, "add_revision_from_sources", refused)
    response = await async_client.post(_import_url(project["id"]), json={"file_ids": [printable.id]})
    assert response.status_code == 413, response.text
    assert response.json()["detail"] == "Too big"


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
    legacy = ProjectItem(project_id=project["id"], section="modelisation", name="Arm", name_key="arm")
    db_session.add(legacy)  # disabled sections take no new items; an existing one may remain
    await db_session.commit()
    item = {"id": legacy.id}
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
async def test_suggestions_project_name_ties_sort_by_id_and_round_the_score(async_client: AsyncClient, db_session):
    # Pin: equal project-name ratios keep ascending project id, the compare is
    # case-folded and the score is rounded to 4 decimals.
    first = await _project(async_client, "BRACKET ARM STAND")
    second = await _project(async_client, "bracket arm stand")
    file = await _managed(db_session, "Bracket arm.3mf")
    body = (await async_client.get(_suggest_url(file.id))).json()
    assert [(s["project_id"], s["reason"]) for s in body] == [
        (first["id"], "project_name"),
        (second["id"], "project_name"),
    ]
    expected = round(SequenceMatcher(None, "bracket arm", "bracket arm stand").ratio(), 4)
    assert [s["score"] for s in body] == [expected, expected]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_suggestions_item_name_pass_ranks_dedups_and_cuts(async_client: AsyncClient, db_session):
    # Pin: the item-name pass sorts by ratio desc, then project id, then item id;
    # a project appears once (its best item, lowest item id on a tie), never again
    # under project_name; the threshold is 0.6; scores round to 4 decimals; the
    # limit cuts the merged list.
    async def item(project_id: int, name: str) -> int:
        response = await async_client.post(
            f"/api/v1/projects/{project_id}/items", json={"section": "impression", "name": name}
        )
        assert response.status_code == 201, response.text
        return response.json()["id"]

    tied = await _project(async_client, "Qx1")
    tied_first_item = await item(tied["id"], "Bracket armz")
    await item(tied["id"], "Bracket arms")
    exact = await _project(async_client, "Qx2")
    exact_item = await item(exact["id"], "Bracket arm")
    later = await _project(async_client, "Bracket arm")
    later_item = await item(later["id"], "Bracket armx")
    weak = await _project(async_client, "Qx4")
    await item(weak["id"], "Brk")
    by_name = await _project(async_client, "Bracket arm stand")

    file = await _managed(db_session, "Bracket arm.3mf")
    body = (await async_client.get(_suggest_url(file.id))).json()
    assert [(s["project_id"], s["reason"], s["item_id"]) for s in body] == [
        (exact["id"], "item_name", exact_item),
        (tied["id"], "item_name", tied_first_item),
        (later["id"], "item_name", later_item),
        (by_name["id"], "project_name", None),
    ]
    near = round(SequenceMatcher(None, "bracket arm", "bracket arms").ratio(), 4)
    assert [s["score"] for s in body[:3]] == [1.0, near, near]
    assert body[1]["item_name"] == "Bracket armz"
    assert body[3]["score"] == round(SequenceMatcher(None, "bracket arm", "bracket arm stand").ratio(), 4)

    limited = (await async_client.get(_suggest_url(file.id), params={"limit": 3})).json()
    assert [s["project_id"] for s in limited] == [exact["id"], tied["id"], later["id"]]
    assert await suggest_projects_for_filename(db_session, "Bracket arm.3mf", limit=0) == []


@pytest.mark.asyncio
@pytest.mark.integration
async def test_suggestions_unknown_code_and_keyless_name(async_client: AsyncClient, db_session):
    # Pin: a code prefix no project carries falls through to the name passes;
    # a name with no item key ("." strips to nothing) skips the item pass only.
    zeta = await _project(async_client, "Zeta")
    dot = await _project(async_client, ".")
    body = await suggest_projects_for_filename(db_session, "P-9999_Zeta.3mf")
    assert [(s.project_id, s.reason, s.score, s.item_id) for s in body] == [(zeta["id"], "project_name", 1.0, None)]
    body = await suggest_projects_for_filename(db_session, "..3mf")
    assert [(s.project_id, s.reason, s.score) for s in body] == [(dot["id"], "project_name", 1.0)]


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
