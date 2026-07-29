"""Quote -> Aito project conversion. Fixtures mirror the live org's payload
shape and formatting quirks with invented customers."""

import json
from pathlib import Path

from backend.app.services.aito_quote_import import (
    build_preview,
    group_lines,
    parse_description,
    parse_lines,
    parse_time_min,
    parse_weight_g,
    service_for_sku,
)

_FIXTURES = Path(__file__).parent.parent / "fixtures" / "zoho_estimates"


def load_estimate(name: str) -> dict:
    return json.loads((_FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def test_fixtures_load():
    assert load_estimate("dev-2461-three-services")["estimate_number"] == "DEV26-2461"
    assert len(load_estimate("dev-2462-two-tasks")["line_items"]) == 3


def test_parse_description_splits_labels_from_free_text():
    labels, free = parse_description(
        "Projet: Tapis souple X4 bloc\nMatériau: TPU 95 A --- 1.5mm\nPoids: 210 gr\nTemps: 13h\nCouleur: NOIR"
    )
    assert labels == {
        "projet": "Tapis souple X4 bloc",
        "materiau": "TPU 95 A --- 1.5mm",
        "poids": "210 gr",
        "temps": "13h",
        "couleur": "NOIR",
    }
    assert free == ()


def test_parse_description_drops_boilerplate_and_keeps_free_text():
    labels, free = parse_description(
        "Info: Logo F170\n*Fichier non cédé*\nCouleur Noir de face.\nFaire plusieurs pièce"
    )
    assert labels == {"info": "Logo F170"}
    # "Couleur Noir de face." has no colon, so it is free text, not a label.
    assert free == ("Couleur Noir de face.", "Faire plusieurs pièce")


def test_parse_description_treats_unfilled_placeholders_as_empty():
    labels, free = parse_description("Projet: [TITLE]\nMatériau: [MATERIAL]\nPoids: [WEIGHT]")
    assert labels == {"projet": "", "materiau": "", "poids": ""}
    assert free == ()


def test_parse_description_keeps_first_value_when_a_label_repeats():
    labels, _free = parse_description("Info: first\nInfo: second")
    assert labels["info"] == "first"


def test_parse_description_handles_empty_input():
    assert parse_description("") == ({}, ())
    assert parse_description(None) == ({}, ())


def test_parse_weight_g_units():
    assert parse_weight_g("210 gr") == 210
    assert parse_weight_g("30gr") == 30
    assert parse_weight_g("2g") == 2
    assert parse_weight_g("1,5 kg") == 1500
    assert parse_weight_g("0.25kg") == 250
    assert parse_weight_g("45") == 45  # bare number = grams
    assert parse_weight_g("") is None
    assert parse_weight_g("à définir") is None


def test_parse_time_min_units():
    assert parse_time_min("13h") == 780
    assert parse_time_min("26min") == 26
    assert parse_time_min("2h30") == 150
    assert parse_time_min("1j 4h") == 1680
    assert parse_time_min("2h 15 min") == 135
    assert parse_time_min("90") == 90  # bare number = minutes
    assert parse_time_min("") is None
    assert parse_time_min("à définir") is None


def test_service_for_sku_matches_by_prefix():
    assert service_for_sku("P3DSCAN") == "scan"
    assert service_for_sku("P3DMOD") == "modelisation"
    assert service_for_sku("P3DIMP") == "impression"
    assert service_for_sku("U3DIMP") == "usinage"
    # The -VENTE variant rides the same prefix.
    assert service_for_sku("U3DIMP-VENTE") == "usinage"
    assert service_for_sku(" p3dimp ") == "impression"
    # Laser, the legacy generic, retail and blank SKUs are not Aito services.
    assert service_for_sku("L3DIMP") is None
    assert service_for_sku("P3D2024") is None
    assert service_for_sku("PB05016") is None
    assert service_for_sku("") is None


def test_parse_lines_amounts_are_ttc_when_the_quote_is_inclusive():
    lines, skipped = parse_lines(load_estimate("dev-2462-two-tasks"))
    assert skipped == []
    assert [line.service for line in lines] == ["modelisation", "impression", "impression"]
    # rate x quantity: 800 x 3. item_total (2124) is the pre-tax figure.
    assert lines[1].amount == 2400
    assert lines[1].quantity == 3
    assert lines[0].amount == 3000


def test_parse_lines_amounts_add_tax_when_the_quote_is_exclusive():
    lines, _skipped = parse_lines(load_estimate("dev-2448-vente"))
    # item_total 4000 + tax 520
    assert [line.amount for line in lines] == [4520, 4520]


def test_parse_lines_reports_unrecognised_lines():
    lines, skipped = parse_lines(load_estimate("dev-2463-retail"))
    assert lines == []
    assert [s["sku"] for s in skipped] == ["PB05016", "L3DIMP"]
    assert skipped[0]["amount"] == 8000  # 4000 x 2, tax-inclusive quote
    assert skipped[1]["name"].startswith("Découpe")


def test_group_lines_merges_a_strictly_rising_run():
    lines, _skipped = parse_lines(load_estimate("dev-2461-three-services"))
    groups = group_lines(lines)
    assert len(groups) == 1
    assert [line.service for line in groups[0]] == ["scan", "modelisation", "impression"]


def test_group_lines_starts_a_new_group_on_a_repeated_service():
    lines, _skipped = parse_lines(load_estimate("dev-2462-two-tasks"))
    groups = group_lines(lines)
    assert [[line.service for line in g] for g in groups] == [
        ["modelisation", "impression"],
        ["impression"],
    ]


def test_group_lines_merges_all_four_services():
    lines, _skipped = parse_lines(load_estimate("dev-2467-template"))
    groups = group_lines(lines)
    assert len(groups) == 1
    assert [line.service for line in groups[0]] == ["scan", "modelisation", "impression", "usinage"]


def test_group_lines_merges_a_gap_in_the_run():
    lines, _skipped = parse_lines(load_estimate("dev-2448-vente"))
    # modelisation (rank 1) then usinage (rank 3) still rises, so one task.
    assert len(group_lines(lines)) == 1


CONTACT = {
    "id": "66407000003700001",
    "name": "SARL Exemple Import",
    "company_name": "SARL Exemple Import",
    "customer_sub_type": "business",
    "phone": "40123456",
    "mobile": "87123456",
    "email": "contact@exemple.pf",
}
URL = "https://books.zoho.eu/app/999#/estimates/1"


def test_build_preview_three_services_becomes_one_task():
    preview = build_preview(load_estimate("dev-2461-three-services"), CONTACT, URL)
    assert len(preview["tasks"]) == 1
    task = preview["tasks"][0]
    # The impression line's Projet: wins the title.
    assert task["title"] == "Tapis souple X4 bloc"
    # The other services' titles and the material are folded into the body;
    # weight, time and colour were consumed into their own fields.
    assert task["description"] == (
        "Scan3D: Prise de mesure d'une gouttière de pièce.\n"
        "Modelisation3D: Dessin d'un tapis de gouttière en 4 zones\n"
        "Matériau: TPU 95 A --- 1.5mm"
    )
    assert task["scan_cost"] == 3500
    assert task["modelisation_cost"] == 4500
    assert task["impression_cost"] == 10000
    assert task["usinage_cost"] is None
    assert task["impression_weight_g"] == 210
    assert task["impression_time_min"] == 780
    assert task["impression_color"] == "NOIR"
    assert task["impression_quantity"] == 1
    # The quote never names a printer or a filament, and the inventory is
    # brand-prefixed, so these are always left for the user.
    assert task["impression_printer_id"] is None
    assert task["impression_filament_id"] is None


def test_build_preview_splits_a_repeated_service_into_two_tasks():
    preview = build_preview(load_estimate("dev-2462-two-tasks"), None, URL)
    assert [t["title"] for t in preview["tasks"]] == ["Helice grise", "helice"]
    first, second = preview["tasks"]
    assert first["modelisation_cost"] == 3000
    assert first["impression_cost"] == 2400
    assert first["description"] == "Matériau: PETG"
    assert second["modelisation_cost"] is None
    assert second["impression_cost"] == 200
    # Every label on the second line was blank, so nothing is preserved.
    assert second["description"] == ""
    assert second["impression_weight_g"] is None
    assert second["impression_time_min"] is None
    assert second["impression_color"] is None
    assert preview["suggested_description"] == "Helice grise\nhelice"


def test_build_preview_template_quote_yields_one_empty_task():
    preview = build_preview(load_estimate("dev-2467-template"), None, URL)
    assert len(preview["tasks"]) == 1
    task = preview["tasks"][0]
    assert task["title"] == ""
    assert task["description"] == ""
    assert task["scan_cost"] == 0
    assert task["usinage_cost"] == 0
    # No title anywhere, so the description falls back to the quote number.
    assert preview["suggested_description"] == "DEV26-2467"


def test_build_preview_preserves_everything_from_a_messy_quote():
    preview = build_preview(load_estimate("dev-2466-messy"), None, URL)
    task = preview["tasks"][0]
    # The impression line's Projet: is blank, so the first Info: wins.
    assert task["title"] == "Logo F170 à la place du F150"
    body = task["description"]
    assert 'Modelisation3D: Logo F170 à la place du F150  ---- "BY BLAST" à la place de XLP' in body
    assert "Couleur Noir de face + fond avec écriture Bleu menthe." in body
    assert "Faire plusieurs pièce" in body
    assert "Prix d'impression défini après confection du logo final.------------------" in body
    assert "Matériau: PETG" in body
    # The scan line supplied the title, so its Info: is not repeated.
    assert "Scan3D:" not in body
    assert task["impression_color"] == "bleu menthe + Noir"
    assert task["impression_weight_g"] is None
    assert task["impression_quantity"] == 2
    assert task["modelisation_cost"] == 6750  # 4500 x 1.5


def test_build_preview_preserves_unconsumed_labels_on_a_usinage_line():
    preview = build_preview(load_estimate("dev-2448-vente"), None, URL)
    task = preview["tasks"][0]
    # No impression line, so the title falls back to the first line in
    # canonical service order that has one — modelisation, not usinage.
    assert task["title"] == "Bride de fixation"
    body = task["description"]
    # Usinage has no weight/time/colour fields on an Aito task, so its
    # template values must survive in the body rather than being dropped.
    assert "Usinage: Bride alu" in body
    assert "Modelisation3D:" not in body  # it supplied the title
    assert "Matériau: Aluminium 6060" in body
    assert "Poids: 1,2 kg" in body
    assert "Temps: 1j 4h" in body
    assert "Couleur: Brut" in body
    assert task["usinage_cost"] == 4520
    assert task["impression_cost"] is None


def test_build_preview_retail_quote_has_no_tasks():
    preview = build_preview(load_estimate("dev-2463-retail"), None, URL)
    assert preview["tasks"] == []
    assert len(preview["skipped_lines"]) == 2
    assert preview["suggested_description"] == "DEV26-2463"


def test_build_preview_maps_the_contact_snapshot():
    preview = build_preview(load_estimate("dev-2461-three-services"), CONTACT, URL)
    assert preview["client"] == {
        "id": "66407000003700001",
        "name": "SARL Exemple Import",
        # mobile wins over phone, matching how the board stores a client.
        "phone": "87123456",
        "email": "contact@exemple.pf",
        "is_company": True,
    }
    assert preview["quote"] == {
        "id": "66407000009400001",
        "number": "DEV26-2461",
        "date": "2026-07-27",
        "status": "sent",
        "total": 18000,
        "currency_code": "XPF",
        "url": URL,
    }


def test_build_preview_degrades_when_the_contact_is_missing():
    preview = build_preview(load_estimate("dev-2461-three-services"), None, URL)
    assert preview["client"] == {
        "id": "66407000003700001",
        "name": "SARL Exemple Import",
        "phone": None,
        "email": None,
        "is_company": None,
    }


def test_build_preview_truncates_a_long_title_and_keeps_the_full_text():
    estimate = load_estimate("dev-2461-three-services")
    long_title = "Tapis " + "très long " * 40  # > 200 characters
    estimate["line_items"][2]["description"] = f"Projet: {long_title}"
    preview = build_preview(estimate, None, URL)
    task = preview["tasks"][0]
    assert len(task["title"]) <= 200
    assert long_title.strip() in task["description"]
