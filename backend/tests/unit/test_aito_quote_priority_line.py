"""The project's priority surcharge spread over its Zoho quote lines: every
task service rate is raised by one common factor. Push, write-back, pull.

Pure functions against a fake catalogue, plus one push through the sync
worker's MockTransport seam. No network.
"""

import httpx
import pytest

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.models.calculator import CalculatorDefaults
from backend.app.services.aito_quote_export import ExportPriority, build_line_items
from backend.app.services.aito_quote_pull import plan_pull
from backend.app.services.aito_quote_sync import _deferred_reasons, load_export_priority, run_sync_once
from backend.app.services.zoho import zoho_service
from backend.tests.unit.test_aito_quote_export import CATALOGUE, SHIPPING, SHIPPING_CATALOGUE, task
from backend.tests.unit.test_aito_quote_pull import CARD, books, line
from backend.tests.unit.test_aito_quote_sync import _configure_zoho, zoho_handler

TASKS = [task(title="Helice", impression_cost=8000, modelisation_cost=2000)]


def _rates(lines):
    return [item["rate"] for item in lines if "rate" in item]


async def _priority(db, level, tasks, **defaults):
    db.add(CalculatorDefaults(id=1, **defaults))
    await db.commit()
    return await load_export_priority(db, AitoProject(priority=level), tasks)


@pytest.mark.asyncio
async def test_urgent_raises_every_task_line_by_the_same_factor_and_adds_none(db_session):
    priority = await _priority(db_session, "urgent", TASKS)
    assert priority == ExportPriority("urgent", 1.35)  # base 10000, 35% = 3500 beats the 1500 floor
    plain = build_line_items(TASKS, [], CATALOGUE)
    raised = build_line_items(TASKS, [], CATALOGUE, priority=priority)
    assert len(raised) == len(plain)
    assert sorted(_rates(raised)) == [2700, 10800]


@pytest.mark.asyncio
async def test_the_minimum_fee_sets_the_factor_on_a_small_job(db_session):
    tasks = [task(title="A", impression_cost=1400)]
    priority = await _priority(db_session, "urgent", tasks)
    assert _rates(build_line_items(tasks, [], CATALOGUE, priority=priority)) == [2900]


@pytest.mark.asyncio
async def test_a_multi_unit_line_scales_its_unit_rate(db_session):
    tasks = [task(title="A", impression_cost=3000, impression_quantity=3)]
    priority = await _priority(db_session, "priority", tasks)  # 15% of 3000 = 450 < 500 floor
    (item,) = [item for item in build_line_items(tasks, [], CATALOGUE, priority=priority) if "rate" in item]
    assert (item["rate"], item["quantity"]) == (1167, 3)  # 1000 x 3500/3000 = 1166.67


def test_a_discounted_line_keeps_its_discount_and_only_its_rate_scales():
    tasks = [task(title="A", impression_cost=10000, impression_discount_pct=10)]
    plain = next(item for item in build_line_items(tasks, [], CATALOGUE) if "rate" in item)
    raised = next(
        item
        for item in build_line_items(tasks, [], CATALOGUE, priority=ExportPriority("urgent", 1.35))
        if "rate" in item
    )
    assert {**plain, "rate": 13500} == raised
    assert raised["discount"] == "10%"


def test_the_shipping_line_is_never_scaled():
    lines = build_line_items(TASKS, [], SHIPPING_CATALOGUE, SHIPPING, ExportPriority("urgent", 1.35))
    ship = next(item for item in lines if item.get("item_id") == "SHIP-TU")
    assert ship["rate"] == SHIPPING.price


def test_a_normal_project_pushes_exactly_what_it_did_before():
    existing = [{"line_item_id": "F1", "item_id": "", "sku": "", "rate": 100, "item_order": 9}]
    assert build_line_items(TASKS, existing, CATALOGUE, priority=None) == build_line_items(TASKS, existing, CATALOGUE)


@pytest.mark.asyncio
async def test_no_scaling_for_a_normal_project_or_an_empty_base(db_session):
    assert await load_export_priority(None, AitoProject(priority="normal"), TASKS) is None
    assert await load_export_priority(None, AitoProject(priority="urgent"), [task(title="A", scan_cost=0)]) is None


@pytest.mark.asyncio
async def test_the_base_is_the_net_task_total(db_session):
    tasks = [
        task(title="A", scan_cost=10000, scan_discount_pct=10),
        task(title="B", impression_cost=2001, impression_quantity=3),
    ]
    # 9000 + 2001 = 11001; 35% = 3850.35 -> 3850.
    assert (await _priority(db_session, "urgent", tasks)).factor == 1 + 3850 / 11001


@pytest.mark.asyncio
async def test_the_surcharge_rounds_half_up_like_the_drawer(db_session):
    tasks = [task(title="A", scan_cost=3030)]  # 15% = 454.5; round() would give 454
    assert (await _priority(db_session, "priority", tasks, priority_min_fee=0)).factor == 1 + 455 / 3030


# --- pull -----------------------------------------------------------------

URGENT = ExportPriority("urgent", 1.35)


def test_an_untouched_urgent_quote_plans_nothing():
    assert plan_pull(CARD, books(CARD, priority=URGENT), CATALOGUE, None, URGENT) is None


def test_reading_an_urgent_quote_without_its_factor_sees_every_rate_as_edited():
    # The guard on the test above: the factor is what makes it plan nothing.
    plan = plan_pull(CARD, books(CARD, priority=URGENT), CATALOGUE, None)
    assert plan is not None and plan.task_patches


def test_a_books_rate_raised_on_an_urgent_card_lands_divided_by_the_factor():
    estimate = books(CARD, priority=URGENT)
    line(estimate, "P3DSCAN")["rate"] = 8100  # pushed at 6750 = 5000 x 1.35
    line(estimate, "P3DIMP")["rate"] = 1350  # pushed at 1080 = 800 x 1.35, 3 units
    plan = plan_pull(CARD, estimate, CATALOGUE, None, URGENT)
    assert plan is not None and plan.refused is None
    assert plan.task_patches == {0: {"scan_cost": 6000, "impression_cost": 3000}}  # 8100 / 1.35; 1350 x 3 / 1.35


# --- push through the worker ------------------------------------------------


@pytest.mark.asyncio
async def test_an_urgent_push_scales_the_rate_but_stores_the_unscaled_rounded_cost(db_session):
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
    # 2401 over 2 units: the quote can only say 1200 x 2 = 2400.
    db_session.add(
        AitoTask(project_id=project.id, position=0, title="Helice", impression_cost=2401, impression_quantity=2)
    )
    await db_session.commit()
    await _configure_zoho(db_session)

    seen: list = []
    estimate = {
        "estimate_id": "E1",
        "estimate_number": "DEV26-9001",
        "date": "2026-07-29",
        "status": "draft",
        "total": 3900,
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
    (item,) = [item for item in post[2]["line_items"] if "rate" in item]
    # Base 2401 -> 1500 floor; 1200 x (1 + 1500/2401) = 1949.69 -> 1950. The card's tax rides along.
    assert (item["rate"], item["quantity"], item["tax_id"]) == (1950, 2, "T0")
    stored = (await db_session.execute(AitoTask.__table__.select())).one()
    assert stored.impression_cost == 2400
