"""Notes pinned on a revision's part in the part viewer (2026-10-31): saved with the revision,
listed oldest first with their author, deleted on request, gone with the revision."""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.tests.integration.test_project_slice import roots  # noqa: F401  # fixture
from backend.tests.project_fixtures import threemf_bytes


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
    # the username comes back (see the permission matrix for the auth-on path).
    assert pin["created_by"] in (None, "admin")

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
async def test_pins_leave_with_their_revision(async_client: AsyncClient, roots):  # noqa: F811
    item_id, rev = await _upload(async_client)
    url = f"/api/v1/projects/revisions/{rev['id']}/pins"
    assert (await async_client.post(url, json={"x": 1, "y": 2, "z": 3, "text": "n"})).status_code == 201
    # A second revision keeps the item alive; the first can then be deleted with its pins.
    up = await async_client.post(
        f"/api/v1/projects/items/{item_id}/revisions",
        files=[("files", ("support.3mf", threemf_bytes(), "application/octet-stream"))],
    )
    assert up.status_code == 201, up.text
    assert (await async_client.delete(f"/api/v1/projects/revisions/{rev['id']}")).status_code == 204
    assert (await async_client.get(url)).status_code == 404
