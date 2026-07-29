"""Aito board routes: required client, move reindexing, soft delete, one-shot import."""

import pytest
from sqlalchemy import select

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask


async def _create(client, **overrides):
    payload = {
        "description": "Support GoPro",
        "client_id": "z1",
        "client_name": "ACME",
        "client_phone": "+33 6 12 34 56 78",
    }
    payload.update(overrides)
    return await client.post("/api/v1/aito/", json=payload)


@pytest.mark.asyncio
async def test_create_requires_client(async_client):
    r = await _create(async_client, client_id=None, client_name=None)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_and_list(async_client):
    r = await _create(async_client)
    assert r.status_code == 201
    body = r.json()
    assert body["column"] == "devis" and body["position"] == 0
    assert body["client_name"] == "ACME"

    r2 = await async_client.get("/api/v1/aito/")
    assert [p["id"] for p in r2.json()] == [body["id"]]


@pytest.mark.asyncio
async def test_move_reindexes_both_columns(async_client):
    a = (await _create(async_client, description="a")).json()
    b = (await _create(async_client, description="b")).json()  # devis order: b(0), a(1)
    r = await async_client.patch(f"/api/v1/aito/{a['id']}/move", json={"column": "print", "position": 0})
    assert r.status_code == 200
    board = (await async_client.get("/api/v1/aito/")).json()
    by_id = {p["id"]: p for p in board}
    assert by_id[a["id"]]["column"] == "print" and by_id[a["id"]]["position"] == 0
    assert by_id[b["id"]]["column"] == "devis" and by_id[b["id"]]["position"] == 0


@pytest.mark.asyncio
async def test_move_rejects_bad_column(async_client):
    a = (await _create(async_client)).json()
    r = await async_client.patch(f"/api/v1/aito/{a['id']}/move", json={"column": "nope", "position": 0})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_soft_delete_hides_but_keeps_row(async_client, db_session):
    a = (await _create(async_client)).json()
    r = await async_client.delete(f"/api/v1/aito/{a['id']}")
    assert r.status_code == 204
    assert (await async_client.get("/api/v1/aito/")).json() == []
    row = (await db_session.execute(select(AitoProject).where(AitoProject.id == a["id"]))).scalar_one()
    assert row.status == "deleted"


@pytest.mark.asyncio
async def test_import_only_on_empty_board(async_client):
    payload = {"projects": [{"description": "legacy", "column": "print", "position": 0}]}
    r = await async_client.post("/api/v1/aito/import", json=payload)
    assert r.status_code == 201
    assert (await async_client.get("/api/v1/aito/")).json()[0]["client_id"] is None
    # second fire must 409 — board is no longer empty (soft-deleted rows count)
    assert (await async_client.post("/api/v1/aito/import", json=payload)).status_code == 409


@pytest.mark.asyncio
async def test_trash_lists_deleted_newest_first(async_client):
    a = (await _create(async_client, description="a")).json()
    b = (await _create(async_client, description="b")).json()
    assert (await async_client.get("/api/v1/aito/trash")).json() == []
    await async_client.delete(f"/api/v1/aito/{a['id']}")
    await async_client.delete(f"/api/v1/aito/{b['id']}")
    trash = (await async_client.get("/api/v1/aito/trash")).json()
    assert [p["id"] for p in trash] == sorted([a["id"], b["id"]], reverse=True)
    assert all(p["status"] == "deleted" for p in trash)


@pytest.mark.asyncio
async def test_restore_appends_to_end_of_column(async_client):
    a = (await _create(async_client, description="a")).json()
    b = (await _create(async_client, description="b")).json()  # devis: b(0), a(1)
    await async_client.delete(f"/api/v1/aito/{a['id']}")
    r = await async_client.post(f"/api/v1/aito/{a['id']}/restore")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "active"
    assert body["column"] == "devis"
    assert body["position"] == 1  # appended after b
    board = (await async_client.get("/api/v1/aito/")).json()
    assert {p["id"] for p in board} == {a["id"], b["id"]}


@pytest.mark.asyncio
async def test_restore_active_or_missing_404s(async_client):
    a = (await _create(async_client, description="a")).json()
    assert (await async_client.post(f"/api/v1/aito/{a['id']}/restore")).status_code == 404
    assert (await async_client.post("/api/v1/aito/999999/restore")).status_code == 404


@pytest.mark.asyncio
async def test_update_description_leaves_client_untouched(async_client):
    a = (await _create(async_client)).json()
    r = await async_client.patch(f"/api/v1/aito/{a['id']}", json={"description": "Nouveau support"})
    assert r.status_code == 200
    body = r.json()
    assert body["description"] == "Nouveau support"
    assert body["client_name"] == "ACME"
    assert body["client_phone"] == "+33 6 12 34 56 78"


@pytest.mark.asyncio
async def test_update_replaces_the_whole_client_snapshot(async_client):
    a = (await _create(async_client)).json()
    r = await async_client.patch(
        f"/api/v1/aito/{a['id']}",
        json={"client_id": "z9", "client_name": "Globex", "client_phone": None},
    )
    assert r.status_code == 200
    body = r.json()
    assert (body["client_id"], body["client_name"], body["client_phone"]) == ("z9", "Globex", None)
    assert body["description"] == "Support GoPro"


@pytest.mark.asyncio
async def test_update_rejects_client_id_without_a_name(async_client):
    """A client_id whose merged client_name would be absent is rejected, even
    though client_id alone is fine when the stored name already satisfies it."""
    a = (await _create(async_client)).json()
    r = await async_client.patch(f"/api/v1/aito/{a['id']}", json={"client_id": "z9", "client_name": None})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_update_rejects_nulling_the_client_name_alone(async_client):
    """A lone client_name:null would leave client_id pointing at a nameless contact."""
    a = (await _create(async_client)).json()
    r = await async_client.patch(f"/api/v1/aito/{a['id']}", json={"client_name": None})
    assert r.status_code == 422
    unchanged = (await async_client.get("/api/v1/aito/")).json()[0]
    assert unchanged["client_name"] == "ACME" and unchanged["client_id"] == "z1"


@pytest.mark.asyncio
async def test_update_allows_clearing_the_whole_client_snapshot(async_client):
    """Clearing id and name together is consistent, so it is allowed."""
    a = (await _create(async_client)).json()
    r = await async_client.patch(
        f"/api/v1/aito/{a['id']}", json={"client_id": None, "client_name": None, "client_phone": None}
    )
    assert r.status_code == 200
    body = r.json()
    assert (body["client_id"], body["client_name"], body["client_phone"]) == (None, None, None)


@pytest.mark.asyncio
async def test_update_allows_renaming_the_client_without_resending_the_id(async_client):
    """The stored client_id satisfies the invariant, so a name-only edit is fine."""
    a = (await _create(async_client)).json()
    r = await async_client.patch(f"/api/v1/aito/{a['id']}", json={"client_name": "ACME SARL"})
    assert r.status_code == 200
    assert r.json()["client_name"] == "ACME SARL" and r.json()["client_id"] == "z1"


@pytest.mark.asyncio
async def test_update_rejects_blank_description(async_client):
    a = (await _create(async_client)).json()
    assert (await async_client.patch(f"/api/v1/aito/{a['id']}", json={"description": ""})).status_code == 422
    assert (await async_client.patch(f"/api/v1/aito/{a['id']}", json={"description": "   "})).status_code == 422


@pytest.mark.asyncio
async def test_update_never_touches_column_or_position(async_client):
    a = (await _create(async_client)).json()
    await async_client.patch(f"/api/v1/aito/{a['id']}/move", json={"column": "print", "position": 0})
    r = await async_client.patch(
        f"/api/v1/aito/{a['id']}", json={"description": "moved then edited", "column": "devis", "position": 7}
    )
    assert r.status_code == 200
    assert r.json()["column"] == "print" and r.json()["position"] == 0


@pytest.mark.asyncio
async def test_update_404s_on_deleted_or_missing(async_client):
    a = (await _create(async_client)).json()
    await async_client.delete(f"/api/v1/aito/{a['id']}")
    assert (await async_client.patch(f"/api/v1/aito/{a['id']}", json={"description": "x"})).status_code == 404
    assert (await async_client.patch("/api/v1/aito/99999", json={"description": "x"})).status_code == 404


@pytest.mark.asyncio
async def test_create_project_persists_client_email(async_client):
    r = await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "Support de caméra",
            "client_id": "z1",
            "client_name": "ACME SARL",
            "client_phone": "+689-87123456",
            "client_email": "hi@acme.pf",
        },
    )
    assert r.status_code == 201
    assert r.json()["client_email"] == "hi@acme.pf"
    listed = (await async_client.get("/api/v1/aito/")).json()
    assert listed[0]["client_email"] == "hi@acme.pf"


@pytest.mark.asyncio
async def test_update_project_writes_and_clears_client_email(async_client):
    project_id = (await _create(async_client)).json()["id"]

    r = await async_client.patch(f"/api/v1/aito/{project_id}", json={"client_email": "hi@acme.pf"})
    assert r.status_code == 200
    assert r.json()["client_email"] == "hi@acme.pf"

    # Explicit null clears it; an omitted key leaves it alone (existing semantics).
    r = await async_client.patch(f"/api/v1/aito/{project_id}", json={"client_email": None})
    assert r.json()["client_email"] is None

    r = await async_client.patch(f"/api/v1/aito/{project_id}", json={"description": "Autre pièce"})
    assert r.json()["client_email"] is None


@pytest.mark.asyncio
async def test_create_project_persists_client_is_company(async_client):
    r = await _create(async_client, client_is_company=True)
    assert r.status_code == 201
    assert r.json()["client_is_company"] is True
    listed = (await async_client.get("/api/v1/aito/")).json()
    assert listed[0]["client_is_company"] is True


@pytest.mark.asyncio
async def test_create_project_defaults_client_is_company_to_null(async_client):
    """Legacy rows and callers that omit the flag are indistinguishable from
    'not a company' at render time, but stay distinguishable in the data."""
    r = await _create(async_client)
    assert r.json()["client_is_company"] is None


@pytest.mark.asyncio
async def test_update_project_writes_and_clears_client_is_company(async_client):
    project_id = (await _create(async_client)).json()["id"]

    r = await async_client.patch(f"/api/v1/aito/{project_id}", json={"client_is_company": True})
    assert r.json()["client_is_company"] is True

    r = await async_client.patch(f"/api/v1/aito/{project_id}", json={"client_is_company": None})
    assert r.json()["client_is_company"] is None

    r = await async_client.patch(f"/api/v1/aito/{project_id}", json={"description": "Autre pièce"})
    assert r.json()["client_is_company"] is None


def _task(**overrides):
    payload = {"title": "Boîtier", "scan_cost": 4000.0}
    payload.update(overrides)
    return payload


@pytest.mark.asyncio
async def test_create_project_with_tasks_creates_them_in_order(async_client):
    r = await _create(
        async_client,
        tasks=[_task(title="Un"), _task(title="Deux", scan_cost=None, usinage_cost=12000.0)],
    )
    assert r.status_code == 201
    project_id = r.json()["id"]

    tasks = (await async_client.get(f"/api/v1/aito/{project_id}/tasks")).json()
    assert [t["title"] for t in tasks] == ["Un", "Deux"]
    assert [t["position"] for t in tasks] == [0, 1]
    assert tasks[1]["scan_cost"] is None
    assert tasks[1]["usinage_cost"] == 12000.0


@pytest.mark.asyncio
async def test_create_project_without_tasks_is_still_valid(async_client):
    r = await _create(async_client)
    assert r.status_code == 201
    assert (await async_client.get(f"/api/v1/aito/{r.json()['id']}/tasks")).json() == []


@pytest.mark.asyncio
async def test_project_list_does_not_include_tasks(async_client):
    """GET /aito/ drives the whole board and is refetched on every WebSocket
    invalidation; loading every task of every card would bloat it. The card's
    summary is served instead by three aggregate fields from one grouped query
    — see test_project_list_summarises_tasks."""
    await _create(async_client, tasks=[_task()])
    body = (await async_client.get("/api/v1/aito/")).json()
    assert "tasks" not in body[0]


@pytest.mark.asyncio
async def test_create_project_rejects_a_negative_cost(async_client):
    r = await _create(async_client, tasks=[_task(scan_cost=-1)])
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_add_task_appends_at_the_end(async_client):
    project_id = (await _create(async_client, tasks=[_task(title="Un")])).json()["id"]
    r = await async_client.post(f"/api/v1/aito/{project_id}/tasks", json=_task(title="Deux"))
    assert r.status_code == 201
    assert r.json()["position"] == 1


@pytest.mark.asyncio
async def test_patch_task_writes_clears_and_leaves_alone(async_client):
    project_id = (await _create(async_client, tasks=[_task(scan_cost=4000.0)])).json()["id"]
    task_id = (await async_client.get(f"/api/v1/aito/{project_id}/tasks")).json()[0]["id"]

    r = await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"usinage_cost": 12000.0})
    assert r.json()["usinage_cost"] == 12000.0
    assert r.json()["scan_cost"] == 4000.0  # untouched sibling

    r = await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"scan_cost": None})
    assert r.json()["scan_cost"] is None  # explicit null disables the service
    assert r.json()["usinage_cost"] == 12000.0

    r = await async_client.patch(f"/api/v1/aito/tasks/{task_id}", json={"title": "Autre"})
    assert r.json()["usinage_cost"] == 12000.0  # omitted key left alone


@pytest.mark.asyncio
async def test_delete_task_removes_only_that_task(async_client):
    project_id = (await _create(async_client, tasks=[_task(title="Un"), _task(title="Deux")])).json()["id"]
    tasks = (await async_client.get(f"/api/v1/aito/{project_id}/tasks")).json()

    assert (await async_client.delete(f"/api/v1/aito/tasks/{tasks[0]['id']}")).status_code == 204
    remaining = (await async_client.get(f"/api/v1/aito/{project_id}/tasks")).json()
    assert [t["title"] for t in remaining] == ["Deux"]


@pytest.mark.asyncio
async def test_task_endpoints_404_on_unknown_ids(async_client):
    assert (await async_client.patch("/api/v1/aito/tasks/9999", json={"title": "x"})).status_code == 404
    assert (await async_client.delete("/api/v1/aito/tasks/9999")).status_code == 404
    assert (await async_client.post("/api/v1/aito/9999/tasks", json=_task())).status_code == 404


@pytest.mark.asyncio
async def test_soft_deleting_a_project_keeps_its_tasks(async_client):
    project_id = (await _create(async_client, tasks=[_task()])).json()["id"]
    await async_client.delete(f"/api/v1/aito/{project_id}")
    await async_client.post(f"/api/v1/aito/{project_id}/restore")
    assert len((await async_client.get(f"/api/v1/aito/{project_id}/tasks")).json()) == 1


@pytest.mark.asyncio
async def test_project_list_summarises_tasks(async_client):
    r = await _create(
        async_client,
        tasks=[
            _task(title="Un", scan_cost=4000.0),
            _task(title="Deux", scan_cost=None, usinage_cost=12000.0),
        ],
    )
    project_id = r.json()["id"]

    body = (await async_client.get("/api/v1/aito/")).json()
    card = next(p for p in body if p["id"] == project_id)
    assert card["task_count"] == 2
    assert card["tasks_total"] == 16000.0
    assert card["task_services"] == ["scan", "usinage"]


@pytest.mark.asyncio
async def test_project_without_tasks_summarises_to_zero(async_client):
    r = await _create(async_client)
    body = (await async_client.get("/api/v1/aito/")).json()
    card = next(p for p in body if p["id"] == r.json()["id"])
    assert card["task_count"] == 0
    assert card["tasks_total"] == 0.0
    assert card["task_services"] == []


@pytest.mark.asyncio
async def test_a_free_service_still_counts_as_enabled(async_client):
    """0 is a price, NULL is a disabled service. A service quoted at zero must
    still appear in task_services — an aggregate testing `> 0` instead of
    IS NOT NULL would silently drop it, and the total would look identical."""
    r = await _create(async_client, tasks=[_task(scan_cost=0.0)])
    body = (await async_client.get("/api/v1/aito/")).json()
    card = next(p for p in body if p["id"] == r.json()["id"])
    assert card["task_services"] == ["scan"]
    assert card["tasks_total"] == 0.0
    assert card["task_count"] == 1


@pytest.mark.asyncio
async def test_task_services_use_canonical_order_not_insertion_order(async_client):
    r = await _create(
        async_client,
        tasks=[
            _task(title="Un", scan_cost=None, usinage_cost=100.0),
            _task(title="Deux", scan_cost=None, modelisation_cost=200.0),
            _task(title="Trois", scan_cost=1.0),
        ],
    )
    body = (await async_client.get("/api/v1/aito/")).json()
    card = next(p for p in body if p["id"] == r.json()["id"])
    assert card["task_services"] == ["scan", "modelisation", "usinage"]


@pytest.mark.asyncio
async def test_tasks_total_sums_exactly_the_four_cost_columns(async_client):
    """Pins the arithmetic. This mirrors `taskTotal` in
    frontend/src/utils/taskDraft.ts; the two are in different languages and
    cannot share code, so a change to one must be made in the other."""
    r = await _create(
        async_client,
        tasks=[
            _task(
                scan_cost=1.0,
                modelisation_cost=20.0,
                usinage_cost=300.0,
                impression_cost=4000.0,
            )
        ],
    )
    body = (await async_client.get("/api/v1/aito/")).json()
    card = next(p for p in body if p["id"] == r.json()["id"])
    assert card["tasks_total"] == 4321.0


@pytest.mark.asyncio
async def test_patch_response_carries_the_task_summary(async_client):
    """The detail panel writes the PATCH response straight into the board cache
    (setQueryData replaces the row), so a response missing the aggregate would
    blank the card's badges until the next fetch."""
    r = await _create(async_client, tasks=[_task(scan_cost=4000.0)])
    project_id = r.json()["id"]
    patched = await async_client.patch(f"/api/v1/aito/{project_id}", json={"description": "Nouveau"})
    assert patched.status_code == 200
    assert patched.json()["task_count"] == 1
    assert patched.json()["tasks_total"] == 4000.0
    assert patched.json()["task_services"] == ["scan"]


@pytest.mark.asyncio
async def test_create_response_carries_the_task_summary(async_client):
    r = await _create(async_client, tasks=[_task(title="Un"), _task(title="Deux")])
    assert r.status_code == 201
    assert r.json()["task_count"] == 2


@pytest.mark.asyncio
async def test_move_and_restore_responses_carry_the_task_summary(async_client):
    r = await _create(async_client, tasks=[_task(scan_cost=4000.0)])
    project_id = r.json()["id"]

    moved = await async_client.patch(f"/api/v1/aito/{project_id}/move", json={"column": "print", "position": 0})
    assert moved.json()["task_count"] == 1

    await async_client.delete(f"/api/v1/aito/{project_id}")
    restored = await async_client.post(f"/api/v1/aito/{project_id}/restore")
    assert restored.json()["task_count"] == 1


@pytest.mark.asyncio
async def test_task_summaries_handles_many_projects_and_an_empty_list(db_session):
    from backend.app.api.routes.aito import _task_summaries

    assert await _task_summaries(db_session, []) == {}

    db_session.add_all(
        [
            AitoTask(project_id=1, position=0, scan_cost=10.0),
            AitoTask(project_id=1, position=1, usinage_cost=5.0),
            AitoTask(project_id=2, position=0, modelisation_cost=7.0),
        ]
    )
    await db_session.commit()

    summaries = await _task_summaries(db_session, [1, 2, 3])
    assert summaries[1].count == 2
    assert summaries[1].total == 15.0
    assert summaries[1].services == ("scan", "usinage")
    assert summaries[2].services == ("modelisation",)
    # A project with no tasks is simply absent — callers fall back to the empty
    # summary rather than paying for a row per task-free card.
    assert 3 not in summaries


@pytest.mark.asyncio
async def test_create_project_stores_quote_link(async_client):
    r = await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "Tapis souple X4 bloc",
            "client_id": "z1",
            "client_name": "ACME",
            "quote_id": "664070000095",
            "quote_number": "DEV26-2461",
            "quote_date": "2026-07-28",
            "quote_total": 18000.0,
            "quote_url": "https://books.zoho.eu/app/999#/estimates/664070000095",
        },
    )
    assert r.status_code == 201
    body = r.json()
    assert body["quote_id"] == "664070000095"
    assert body["quote_number"] == "DEV26-2461"
    assert body["quote_date"] == "2026-07-28"
    assert body["quote_total"] == 18000.0
    assert body["quote_url"].endswith("#/estimates/664070000095")

    listed = (await async_client.get("/api/v1/aito/")).json()
    assert listed[0]["quote_number"] == "DEV26-2461"


@pytest.mark.asyncio
async def test_create_project_accepts_an_https_quote_url(async_client):
    r = await _create(async_client, quote_url="https://books.zoho.eu/app/999#/estimates/664070000095")
    assert r.status_code == 201
    assert r.json()["quote_url"] == "https://books.zoho.eu/app/999#/estimates/664070000095"


@pytest.mark.asyncio
async def test_create_project_rejects_a_javascript_quote_url(async_client):
    # quote_url is rendered as a trustworthy-looking anchor labelled with the
    # quote number, so anything other than https (including a javascript:
    # scheme, a bare http:, or a relative value) must be rejected outright.
    r = await _create(async_client, quote_url="javascript:alert(1)")
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_create_project_without_quote_leaves_quote_fields_null(async_client):
    r = await async_client.post(
        "/api/v1/aito/",
        json={"description": "Manual card", "client_id": "z1", "client_name": "ACME"},
    )
    assert r.status_code == 201
    body = r.json()
    assert body["quote_id"] is None
    assert body["quote_number"] is None
    assert body["quote_date"] is None
    assert body["quote_total"] is None
    assert body["quote_url"] is None
