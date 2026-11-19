"""The project's priority surcharge as its own Zoho quote line: push, import, pull.

Pure functions against a fake catalogue, plus one push through the sync
worker's MockTransport seam (the card's tax must reach the line). No network.
"""

from dataclasses import replace

import httpx
import pytest

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.calculator import CalculatorDefaults
from backend.app.services.aito_quote_export import ExportPriority, build_line_items
from backend.app.services.aito_quote_import import build_preview, discount_issues
from backend.app.services.aito_quote_pull import plan_pull
from backend.app.services.aito_quote_sync import (
    PriorityCatalogueUnavailable,
    _deferred_reasons,
    load_export_priority,
    run_sync_once,
)
from backend.app.services.zoho import zoho_service
from backend.tests.unit.test_aito_quote_export import _SKU_FOR_ITEM, CATALOGUE, task
from backend.tests.unit.test_aito_quote_pull import books
from backend.tests.unit.test_aito_quote_sync import _configure_zoho, zoho_handler

CAT = replace(CATALOGUE, priority_item_id="P1", urgent_item_id="U1")
PRIORITY_IDS = {"priority": "P1", "urgent": "U1"}
TASKS = [task(title="Helice", scan_cost=5000)]


def _ids(lines):
    return [line.get("item_id") for line in lines]


def test_the_priority_line_comes_last_with_its_rate_and_no_discount():
    shipping_free = build_line_items(TASKS, [], CAT, priority=ExportPriority("urgent", 1500))
    assert shipping_free[-1] == {"item_id": "U1", "rate": 1500, "quantity": 1, "tax_id": "TAX", "item_order": 3}


def test_a_project_set_back_to_normal_drops_its_old_priority_line():
    existing = [{"line_item_id": "L9", "item_id": "U1", "rate": 1500, "item_order": 3}]
    lines = build_line_items(TASKS, existing, CAT)
    assert not {"P1", "U1"} & set(_ids(lines))
    assert all(line.get("line_item_id") != "L9" for line in lines)


def test_a_level_change_replaces_the_line_rather_than_adding_one():
    existing = [{"line_item_id": "L9", "item_id": "U1", "rate": 1500, "item_order": 3}]
    lines = build_line_items(TASKS, existing, CAT, priority=ExportPriority("priority", 500))
    assert [i for i in _ids(lines) if i in {"P1", "U1"}] == ["P1"]
    assert all(line.get("line_item_id") != "L9" for line in lines)


def test_a_normal_project_pushes_exactly_what_it_did_before():
    existing = [{"line_item_id": "F1", "item_id": "", "sku": "", "rate": 100, "item_order": 9}]
    assert build_line_items(TASKS, existing, CAT, priority=None) == build_line_items(TASKS, existing, CATALOGUE)


def test_an_unset_priority_item_does_not_claim_free_text_lines():
    # Books answers a free-text line with item_id "": an empty setting must
    # never make such a foreign line read as ours (it would be deleted).
    existing = [{"line_item_id": "F1", "item_id": "", "sku": "", "rate": 100, "item_order": 9}]
    assert {"line_item_id": "F1", "item_order": 3} in build_line_items(TASKS, existing, CATALOGUE)


@pytest.mark.asyncio
async def test_an_unset_item_id_refuses_rather_than_dropping_the_line(db_session):
    project = AitoProject(priority="urgent")
    with pytest.raises(PriorityCatalogueUnavailable, match="zoho_item_urgent_id"):
        await load_export_priority(db_session, project, replace(CAT, urgent_item_id=""), TASKS)


@pytest.mark.asyncio
async def test_a_normal_project_never_reads_the_catalogue():
    assert await load_export_priority(None, AitoProject(priority="normal"), None, TASKS) is None


@pytest.mark.asyncio
async def test_the_base_is_the_net_task_total_and_the_minimum_fee_applies(db_session):
    db_session.add(CalculatorDefaults(id=1))
    await db_session.commit()
    tasks = [
        task(title="A", scan_cost=10000, scan_discount_pct=10),
        task(title="B", impression_cost=2001, impression_quantity=3),
    ]
    # 9000 + 2001 = 11001; 35% = 3850.35 -> rounded for price_precision 0.
    assert await load_export_priority(db_session, AitoProject(priority="urgent"), CAT, tasks) == ExportPriority(
        "urgent", 3850
    )
    # 15% of 5000 = 750 beats the 500 floor; 15% of 1000 = 150 does not.
    assert (await load_export_priority(db_session, AitoProject(priority="priority"), CAT, TASKS)).amount == 750
    small = [task(title="C", scan_cost=1000)]
    assert (await load_export_priority(db_session, AitoProject(priority="priority"), CAT, small)).amount == 500


def _estimate_with_urgent_line(**urgent_fields) -> dict:
    estimate = books(TASKS, catalogue=CAT)
    estimate["line_items"].append(
        {"line_item_id": "L9", "item_id": "U1", "sku": "SVC-URG", "rate": 1500, "quantity": 1, "item_order": 9}
        | urgent_fields
    )
    return estimate


def test_import_reads_the_level_and_does_not_list_the_line_as_skipped():
    preview = build_preview(_estimate_with_urgent_line(), None, "", priority_ids=PRIORITY_IDS)
    assert preview["priority"] == "urgent"
    assert all(row["sku"] != "SVC-URG" for row in preview["skipped_lines"])
    assert build_preview(books(TASKS, catalogue=CAT), None, "", priority_ids=PRIORITY_IDS)["priority"] == "normal"


def test_a_discount_on_the_priority_line_is_an_issue():
    estimate = _estimate_with_urgent_line(discount="10%")
    issues = discount_issues(estimate, priority_ids=PRIORITY_IDS)
    assert [issue["sku"] for issue in issues] == ["SVC-URG"]


def test_a_hand_edited_priority_rate_is_neither_a_task_change_nor_a_refusal():
    estimate = _estimate_with_urgent_line(rate=900)
    plan = plan_pull(TASKS, estimate, CAT, None)
    assert plan is None or (plan.task_patches == {} and plan.refused is None)
    # Even a discount typed on it: the next push rewrites the line anyway.
    plan = plan_pull(TASKS, _estimate_with_urgent_line(discount="10%"), CAT, None)
    assert plan is None or (plan.task_patches == {} and plan.refused is None)


def test_a_priority_item_whose_sku_looks_like_a_service_is_still_ignored_by_the_pull():
    estimate = _estimate_with_urgent_line(sku=_SKU_FOR_ITEM["ITEM_SCAN"], rate=900)
    plan = plan_pull(TASKS, estimate, CAT, None)
    assert plan is None or (plan.task_patches == {} and plan.refused is None)


@pytest.mark.asyncio
async def test_the_pushed_priority_line_carries_the_card_tax(db_session):
    _deferred_reasons.clear()
    project = AitoProject(
        description="Helice",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client de passage",
        quote_sync_state="pending",
        priority="urgent",
        tax_id="T0",
    )
    db_session.add(project)
    db_session.add(CalculatorDefaults(id=1))
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Helice grise", scan_cost=5000))
    await db_session.commit()
    await _configure_zoho(db_session)
    await set_setting(db_session, "zoho_item_urgent_id", "U1")

    seen: list = []
    estimate = {
        "estimate_id": "E1",
        "estimate_number": "DEV26-9001",
        "date": "2026-07-29",
        "status": "draft",
        "total": 6500,
        "last_modified_time": "2026-07-29T10:00:00-1000",
        "is_inclusive_tax": True,
    }
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {("GET", "/items"): {"items": []}, ("GET", "/estimates"): {"estimates": []}, ("POST", "/estimates"): {"estimate": estimate}},
            seen,
        )
    )  # fmt: skip
    zoho_service.invalidate_token()
    try:
        assert await run_sync_once(db_session) == 1
    finally:
        zoho_service.transport = None
        zoho_service.invalidate_token()

    post = next(entry for entry in seen if entry[0] == "POST")
    last = post[2]["line_items"][-1]
    assert (last["item_id"], last["rate"], last["tax_id"]) == ("U1", 1750, "T0")  # 35% of 5000 beats the 1500 floor


@pytest.mark.asyncio
async def test_a_priority_project_with_no_item_configured_stays_pending_and_pushes_nothing(db_session):
    _deferred_reasons.clear()
    project = AitoProject(
        description="Helice",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client de passage",
        quote_sync_state="pending",
        priority="priority",
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Helice grise", scan_cost=5000))
    await db_session.commit()
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(zoho_handler({("GET", "/items"): {"items": []}}, seen))
    zoho_service.invalidate_token()
    try:
        assert await run_sync_once(db_session) == 1
    finally:
        zoho_service.transport = None
        zoho_service.invalidate_token()
    await db_session.refresh(project)
    assert project.quote_sync_state == "pending"
    assert (project.quote_sync_failures or 0) == 0
    assert not any(method in ("POST", "PUT") for method, _, _ in seen)
    assert "zoho_item_priority_id" in _deferred_reasons[project.id]
    _deferred_reasons.clear()


@pytest.mark.asyncio
async def test_the_preview_route_returns_the_quote_priority_level(async_client):
    from backend.app.core.database import async_session
    from backend.tests.unit.test_zoho_estimate_routes import _books_handler, _configure, _estimate

    await _configure(async_client)
    async with async_session() as db:
        await set_setting(db, "zoho_item_urgent_id", "U1")
        await db.commit()
    estimate = _estimate("dev-2461-three-services")
    estimate["line_items"].append(
        {"line_item_id": "L9", "item_id": "U1", "sku": "SVC-URG", "rate": 1500, "quantity": 1}
    )
    zoho_service.transport = httpx.MockTransport(_books_handler(estimate))
    try:
        body = (await async_client.get(f"/api/v1/zoho/estimates/{estimate['estimate_id']}/preview")).json()
    finally:
        zoho_service.transport = None
        zoho_service.invalidate_token()
    assert body["priority"] == "urgent"
    assert body["skipped_lines"] == []
