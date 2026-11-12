"""The pull's pure half: what a Books-side edit of the quote's lines means
for the card (aito_quote_pull.plan_pull). Books is simulated the way it
answers a push: the lines this app would send, each given an id and the
catalogue item's SKU, then edited by hand."""

from dataclasses import replace

from backend.app.services.aito_quote_export import Catalogue, ExportShipping, build_line_items
from backend.app.services.aito_quote_pull import plan_pull
from backend.tests.unit.test_aito_quote_export import _SKU_FOR_ITEM, CATALOGUE, task

SHIPPING_CATALOGUE = replace(CATALOGUE, shipping={"standard": "ITEM_SHIP"})


def books(tasks, shipping=None, catalogue: Catalogue = CATALOGUE, total=None) -> dict:
    """The estimate Books would return after this card's push."""
    lines = []
    for number, line in enumerate(build_line_items(tasks, [], catalogue, shipping), start=1):
        line = {**line, "sku": _SKU_FOR_ITEM.get(line.get("item_id"), "")}
        if line.get("line_item_category") == "header":
            # Books' read-back spelling: the title under `name`, no id.
            line = {"line_item_category": "header", "name": line["description"], "item_order": line["item_order"]}
        else:
            line["line_item_id"] = f"L{number}"
        lines.append(line)
    return {"is_inclusive_tax": True, "price_precision": 0, "total": total, "line_items": lines}


def line(estimate: dict, sku: str, nth: int = 0) -> dict:
    return [item for item in estimate["line_items"] if item.get("sku") == sku][nth]


HELICE = task(
    title="Helice",
    scan_cost=5000,
    scan_description="Scan de la pale",
    impression_cost=2400,
    impression_quantity=3,
    impression_weight_g=20,
    impression_time_min=60,
    impression_color="Noir",
    impression_description="Sans supports",
    material="PETG",
)
SOCLE = task(title="Socle", usinage_cost=8000, usinage_quantity=2)
CARD = [HELICE, SOCLE]


def test_a_quote_books_has_not_edited_plans_nothing():
    assert plan_pull(CARD, books(CARD), CATALOGUE, None) is None


def test_a_rate_edit_becomes_the_new_cost():
    estimate = books(CARD)
    line(estimate, "P3DSCAN")["rate"] = 6500
    plan = plan_pull(CARD, estimate, CATALOGUE, None)
    assert (plan.refused, plan.task_patches, plan.shipping) == (None, {0: {"scan_cost": 6500}}, {})


def test_a_quantity_edit_moves_quantity_and_total():
    estimate = books(CARD)
    line(estimate, "P3DIMP")["quantity"] = 5
    assert plan_pull(CARD, estimate, CATALOGUE, None).task_patches == {
        0: {"impression_cost": 4000, "impression_quantity": 5}
    }


def test_a_percent_discount_is_taken_and_one_removed_is_cleared():
    estimate = books(CARD)
    line(estimate, "U3DIMP")["discount"] = "15.00%"
    assert plan_pull(CARD, estimate, CATALOGUE, None).task_patches == {1: {"usinage_discount_pct": 15}}

    discounted = [HELICE, replace(SOCLE, usinage_discount_pct=15)]
    estimate = books(discounted)
    del line(estimate, "U3DIMP")["discount"]
    assert plan_pull(discounted, estimate, CATALOGUE, None).task_patches == {1: {"usinage_discount_pct": None}}


def test_a_flat_discount_is_taken_only_as_an_exact_percent_the_total_confirms():
    estimate = books(CARD, total=5000 + 2400 + 8000 - 800)
    line(estimate, "U3DIMP")["discount"] = 800
    assert plan_pull(CARD, estimate, CATALOGUE, None).task_patches == {1: {"usinage_discount_pct": 10}}

    estimate = books(CARD, total=5000 + 2400 + 8000 - 850)
    line(estimate, "U3DIMP")["discount"] = 850  # 10.625%
    plan = plan_pull(CARD, estimate, CATALOGUE, None)
    assert (plan.refused, plan.task_patches) == ("discount", {})


def test_a_whole_quote_discount_added_in_books_is_refused():
    estimate = {**books(CARD), "discount": "10.00%", "discount_type": "entity_level"}
    assert plan_pull(CARD, estimate, CATALOGUE, None).refused == "discount"


def test_a_description_edit_lands_on_that_service_without_the_material_row():
    estimate = books(CARD)
    printing = line(estimate, "P3DIMP")
    assert "Matériau: PETG" in printing["description"]
    printing["description"] = printing["description"].replace("Info: Sans supports", "Info: Avec supports")
    assert plan_pull(CARD, estimate, CATALOGUE, None).task_patches == {0: {"impression_description": "Avec supports"}}


def test_print_parameters_edited_in_books_are_read_into_their_fields():
    estimate = books(CARD)
    printing = line(estimate, "P3DIMP")
    printing["description"] = (
        printing["description"].replace("20 gr", "35 gr").replace("Temps: 1h", "Temps: 2h30").replace("Noir", "Rouge")
    )
    assert plan_pull(CARD, estimate, CATALOGUE, None).task_patches == {
        0: {"impression_weight_g": 35, "impression_time_min": 150, "impression_color": "Rouge"}
    }


def test_a_material_books_changed_cannot_be_held_and_is_refused():
    """The card keeps a filament id, not the word on the quote."""
    estimate = books(CARD)
    printing = line(estimate, "P3DIMP")
    printing["description"] = printing["description"].replace("PETG", "PLA")
    assert plan_pull(CARD, estimate, CATALOGUE, None).refused == "unverified"


def test_a_rename_is_taken_alone_and_refused_with_anything_else():
    estimate = books(CARD)
    estimate["line_items"][0]["name"] = "Helice V2"
    assert plan_pull(CARD, estimate, CATALOGUE, None).task_patches == {0: {"title": "Helice V2"}}

    line(estimate, "P3DSCAN")["rate"] = 6500
    assert plan_pull(CARD, estimate, CATALOGUE, None).refused == "tasks"


def test_a_removed_header_never_blanks_a_title():
    estimate = books([SOCLE])
    estimate["line_items"] = [item for item in estimate["line_items"] if item.get("line_item_category") != "header"]
    assert plan_pull([SOCLE], estimate, CATALOGUE, None).refused == "tasks"


def test_a_line_removed_under_its_header_drops_the_step_and_its_tick():
    estimate = books(CARD)
    estimate["line_items"].remove(line(estimate, "P3DSCAN"))
    assert plan_pull(CARD, estimate, CATALOGUE, None).task_patches == {
        0: {"scan_cost": None, "scan_quantity": None, "scan_description": None, "scan_done": False}
    }


def test_a_line_added_under_its_header_becomes_a_step():
    estimate = books(CARD)
    position = estimate["line_items"].index(line(estimate, "U3DIMP"))
    estimate["line_items"].insert(
        position,
        {
            "line_item_id": "NEW",
            "sku": "P3DMOD",
            "rate": 3000,
            "quantity": 1,
            "description": "Info: Plan\n*Fichier non cédé*",
        },
    )
    for order, item in enumerate(estimate["line_items"], start=1):
        item["item_order"] = order
    assert plan_pull(CARD, estimate, CATALOGUE, None).task_patches == {
        1: {"modelisation_cost": 3000, "modelisation_quantity": 1, "modelisation_description": "Plan"}
    }


def test_a_line_added_to_an_untitled_task_is_refused():
    card = [task(title=None, scan_cost=5000)]
    estimate = books(card)
    estimate["line_items"].append(
        {"line_item_id": "NEW", "sku": "P3DMOD", "rate": 3000, "quantity": 1, "item_order": 9, "description": ""}
    )
    assert plan_pull(card, estimate, CATALOGUE, None).refused == "tasks"


def test_a_task_added_or_removed_in_books_is_refused():
    estimate = books(CARD)
    estimate["line_items"] = estimate["line_items"][:-2]  # Socle's header and line
    assert plan_pull(CARD, estimate, CATALOGUE, None).refused == "tasks"

    estimate = books(CARD)
    estimate["line_items"] += [
        {"line_item_category": "header", "name": "Capot", "item_order": 8},
        {"line_item_id": "NEW", "sku": "P3DSCAN", "rate": 1000, "quantity": 1, "item_order": 9, "description": ""},
    ]
    assert plan_pull(CARD, estimate, CATALOGUE, None).refused == "tasks"


def test_untitled_tasks_that_read_back_merged_are_refused():
    """No header between them, and scan -> impression reads as one job."""
    card = [task(title=None, scan_cost=5000), task(title=None, impression_cost=1000)]
    estimate = books(card)
    line(estimate, "P3DSCAN")["rate"] = 6000
    assert plan_pull(card, estimate, CATALOGUE, None).refused == "tasks"


def test_foreign_lines_are_never_read():
    estimate = books(CARD)
    estimate["line_items"].append(
        {"line_item_id": "F1", "sku": "PB05016", "name": "Bobine", "rate": 4000, "quantity": 2, "item_order": 9}
    )
    assert plan_pull(CARD, estimate, CATALOGUE, None) is None


def test_a_hand_typed_labour_line_the_card_does_not_price_is_never_read():
    estimate = books(CARD)
    estimate["line_items"].append(
        {"line_item_id": "MO", "sku": "PM-CM-D", "item_id": "ITEM_MO", "rate": 25000, "quantity": 1, "item_order": 9}
    )
    assert plan_pull(CARD, estimate, CATALOGUE, None) is None


def test_a_labour_line_emptied_of_its_description_is_refused():
    card = [task(title="Pose", maindoeuvre_cost=9000, maindoeuvre_description="Montage sur site")]
    estimate = books(card)
    line(estimate, "PM-CM-D")["description"] = ""
    assert plan_pull(card, estimate, CATALOGUE, None).refused == "description"


def test_a_catalogue_override_is_recognised_by_item_id():
    """Books answers with the override item's own SKU, which no prefix knows."""
    estimate = books(CARD)
    scan = line(estimate, "P3DSCAN")
    scan.update(sku="SCAN-MAISON", rate=6500)
    assert plan_pull(CARD, estimate, CATALOGUE, None).task_patches == {0: {"scan_cost": 6500}}


SHIPMENT = ExportShipping(
    service="standard", island_label="Moorea", first_name="Jean", last_name="DUPONT", phone="87123456", price=3200
)


def test_a_shipping_price_or_recipient_edit_is_taken():
    estimate = books(CARD, SHIPMENT, SHIPPING_CATALOGUE)
    assert plan_pull(CARD, estimate, SHIPPING_CATALOGUE, SHIPMENT) is None
    freight = next(item for item in estimate["line_items"] if item.get("item_id") == "ITEM_SHIP")
    freight["rate"] = 4100
    freight["description"] = freight["description"].replace("87123456", "87654321")
    plan = plan_pull(CARD, estimate, SHIPPING_CATALOGUE, SHIPMENT)
    assert (plan.task_patches, plan.shipping) == ({}, {"phone": "87654321", "price": 4100})


def test_a_shipping_line_removed_or_sent_elsewhere_is_refused():
    estimate = books(CARD, SHIPMENT, SHIPPING_CATALOGUE)
    freight = next(item for item in estimate["line_items"] if item.get("item_id") == "ITEM_SHIP")
    freight["description"] = freight["description"].replace("Moorea", "Bora Bora")
    assert plan_pull(CARD, estimate, SHIPPING_CATALOGUE, SHIPMENT).refused == "shipping"
    estimate["line_items"].remove(freight)
    assert plan_pull(CARD, estimate, SHIPPING_CATALOGUE, SHIPMENT).refused == "shipping"
