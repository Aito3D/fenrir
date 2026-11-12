"""GET /projects/revisions/{id}/lineage (spec §8): up, down, prints, deliveries."""

from functools import partial

import pytest
from httpx import AsyncClient

from backend.app.models.archive import PrintArchive
from backend.tests.project_fixtures import api_project, make_order, make_task, projects_root_fixture, threemf_bytes

root = projects_root_fixture(autouse=True)

_order = partial(make_order, commit=True)
_task = partial(make_task, commit=True)


async def _revision(client, project_id, name, derived_from_id=None):
    item = (
        await client.post(f"/api/v1/projects/{project_id}/items", json={"section": "impression", "name": name})
    ).json()
    response = await client.post(
        f"/api/v1/projects/items/{item['id']}/revisions",
        files=[("files", ("p.3mf", threemf_bytes(), "application/octet-stream"))],
    )
    assert response.status_code == 201, response.text
    revision_id = response.json()["revision"]["id"]
    if derived_from_id is not None:
        patched = await client.patch(
            f"/api/v1/projects/revisions/{revision_id}", json={"derived_from_id": derived_from_id}
        )
        assert patched.status_code == 200, patched.text
    return revision_id


@pytest.mark.asyncio
@pytest.mark.integration
async def test_lineage_up_down_prints_and_deliveries(async_client: AsyncClient, db_session):
    project = await api_project(async_client, check=False)
    root_id = await _revision(async_client, project["id"], "Scan")
    middle_id = await _revision(async_client, project["id"], "Modèle", root_id)
    leaf_id = await _revision(async_client, project["id"], "Plaque", middle_id)
    order = await _order(db_session)
    task = await _task(db_session, order)
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/project", json={"project_id": project["id"]})
    await async_client.put(f"/api/v1/aito/tasks/{task.id}/deliveries", json={"revision_ids": [middle_id]})
    db_session.add_all(
        [
            PrintArchive(filename="a.3mf", file_path="a.3mf", file_size=1, status="completed", revision_id=middle_id),
            PrintArchive(filename="b.3mf", file_path="b.3mf", file_size=1, status="failed", revision_id=leaf_id),
        ]
    )
    await db_session.commit()

    lineage = (await async_client.get(f"/api/v1/projects/revisions/{middle_id}/lineage")).json()

    assert lineage["revision"]["id"] == middle_id
    assert [r["id"] for r in lineage["up"]] == [root_id]
    assert [r["id"] for r in lineage["down"]] == [leaf_id]
    assert [(p["print_name"], p["status"]) for p in lineage["prints"]] == [("a.3mf", "completed")]
    assert lineage["deliveries"] == [
        {"task_id": task.id, "task_title": task.title, "order_id": order.id, "client_name": order.client_name}
    ]

    leaf = (await async_client.get(f"/api/v1/projects/revisions/{leaf_id}/lineage")).json()
    assert [r["id"] for r in leaf["up"]] == [middle_id, root_id]
    assert leaf["down"] == [] and leaf["deliveries"] == []

    assert (await async_client.get("/api/v1/projects/revisions/987654/lineage")).status_code == 404
