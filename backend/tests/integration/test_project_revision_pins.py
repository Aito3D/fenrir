"""Notes pinned on a revision's part in the part viewer (2026-10-31): saved with the revision,
listed oldest first with their author, deleted on request, gone with the revision."""

from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.core.permissions import Permission as P
from backend.app.models.project_pin import ProjectRevisionPin
from backend.app.models.settings import Settings
from backend.tests.integration.test_project_slice import roots  # noqa: F401  # fixture
from backend.tests.project_fixtures import add_user_with_group, bearer_headers, threemf_bytes


async def _upload(client: AsyncClient) -> tuple[int, dict]:
    """A project revision holding one source file; returns (item id, revision)."""
    project = (await client.post("/api/v1/projects/", json={"name": "Support caméra"})).json()
    item = (
        await client.post(f"/api/v1/projects/{project['id']}/items", json={"section": "impression", "name": "Support"})
    ).json()
    up = await client.post(
        f"/api/v1/projects/items/{item['id']}/revisions",
        files=[("files", ("support.3mf", threemf_bytes(), "application/octet-stream"))],
    )
    assert up.status_code == 201, up.text
    return item["id"], up.json()["revision"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_pins_are_saved_listed_and_deleted_on_the_revision(async_client: AsyncClient, roots):  # noqa: F811
    _, rev = await _upload(async_client)
    url = f"/api/v1/projects/revisions/{rev['id']}/pins"

    assert (await async_client.get(url)).json() == []

    created = await async_client.post(url, json={"x": 12.5, "y": 40, "z": 21, "text": "  Chamfer here  "})
    assert created.status_code == 201, created.text
    pin = created.json()
    assert pin["text"] == "Chamfer here"
    assert (pin["x"], pin["y"], pin["z"]) == (12.5, 40, 21)
    # The test client runs with auth off, so there is no actor to name; with a signed-in user
    # the username comes back (test_a_signed_in_author_is_named).
    assert pin["created_by"] is None

    second = (await async_client.post(url, json={"x": 0, "y": 0, "z": 0, "text": "second"})).json()
    listed = (await async_client.get(url)).json()
    assert [p["id"] for p in listed] == [pin["id"], second["id"]]

    assert (await async_client.delete(f"/api/v1/projects/revisions/pins/{pin['id']}")).status_code == 204
    assert [p["id"] for p in (await async_client.get(url)).json()] == [second["id"]]
    assert (await async_client.delete(f"/api/v1/projects/revisions/pins/{pin['id']}")).status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
async def test_pins_refuse_an_unknown_revision_and_an_empty_note(async_client: AsyncClient, roots):  # noqa: F811
    assert (await async_client.get("/api/v1/projects/revisions/987654/pins")).status_code == 404
    _, rev = await _upload(async_client)
    url = f"/api/v1/projects/revisions/{rev['id']}/pins"
    assert (await async_client.post(url, json={"x": 0, "y": 0, "z": 0, "text": ""})).status_code == 422


@pytest.mark.asyncio
@pytest.mark.integration
async def test_pins_leave_with_their_revision(async_client: AsyncClient, db_session, roots):  # noqa: F811
    item_id, rev = await _upload(async_client)
    url = f"/api/v1/projects/revisions/{rev['id']}/pins"
    created = await async_client.post(url, json={"x": 1, "y": 2, "z": 3, "text": "n"})
    assert created.status_code == 201
    # A second revision keeps the item alive; the first can then be deleted with its pins.
    up = await async_client.post(
        f"/api/v1/projects/items/{item_id}/revisions",
        files=[("files", ("support.3mf", threemf_bytes(), "application/octet-stream"))],
    )
    assert up.status_code == 201, up.text
    assert (await async_client.delete(f"/api/v1/projects/revisions/{rev['id']}")).status_code == 204
    assert (await async_client.get(url)).status_code == 404
    # the pin rows themselves are gone, not merely hidden behind the revision's 404
    left = await db_session.execute(select(ProjectRevisionPin).where(ProjectRevisionPin.revision_id == rev["id"]))
    assert left.scalars().all() == []
    pin_url = f"/api/v1/projects/revisions/pins/{created.json()['id']}"
    assert (await async_client.delete(pin_url)).status_code == 404


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_signed_in_author_is_named(async_client: AsyncClient, db_session, roots):  # noqa: F811
    _, rev = await _upload(async_client)
    db_session.add(Settings(key="auth_enabled", value="true"))
    user = await add_user_with_group(
        db_session,
        username="pin-author",
        group_name="pin-author",
        permissions=[P.PROJECTS_READ.value, P.PROJECTS_UPDATE.value],
    )
    await db_session.commit()
    url = f"/api/v1/projects/revisions/{rev['id']}/pins"
    headers = bearer_headers(user)

    created = await async_client.post(url, json={"x": 1, "y": 2, "z": 3, "text": "mine"}, headers=headers)
    assert created.status_code == 201, created.text
    assert created.json()["created_by"] == "pin-author"
    listed = (await async_client.get(url, headers=headers)).json()
    assert [p["created_by"] for p in listed] == ["pin-author"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_reused_revision_id_does_not_inherit_deleted_pins(async_client: AsyncClient, roots):  # noqa: F811
    for delete_whole_item in (False, True):
        item_id, rev = await _upload(async_client)
        url = f"/api/v1/projects/revisions/{rev['id']}/pins"
        assert (await async_client.post(url, json={"x": 1, "y": 2, "z": 3, "text": "stale"})).status_code == 201
        target = f"/api/v1/projects/items/{item_id}" if delete_whole_item else f"/api/v1/projects/revisions/{rev['id']}"
        assert (await async_client.delete(target)).status_code == 204
        # the newest id is free again; wherever the next revision lands, no deleted note follows it
        if delete_whole_item:
            _, again = await _upload(async_client)
        else:
            up = await async_client.post(
                f"/api/v1/projects/items/{item_id}/revisions",
                files=[("files", ("support.3mf", threemf_bytes(), "application/octet-stream"))],
            )
            assert up.status_code == 201, up.text
            again = up.json()["revision"]
        assert again["id"] == rev["id"]
        assert (await async_client.get(f"/api/v1/projects/revisions/{again['id']}/pins")).json() == []
