"""Quote -> Aito project conversion. Fixtures mirror the live org's payload
shape and formatting quirks with invented customers."""

import json
from pathlib import Path

from backend.app.services.aito_quote_export import ExportShipping, build_shipping_description
from backend.app.services.aito_quote_import import (
    build_preview,
    group_lines,
    parse_description,
    parse_lines,
    parse_shipping_line,
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
    labels, free = parse_description("Info: first\nInfo: second\nPoids: 210 gr\nPoids: 50 gr")
    assert labels["info"] == "first"
    assert labels["poids"] == "210 gr"
    # The losing rows must not vanish -- they survive verbatim as free text.
    assert free == ("Info: second", "Poids: 50 gr")


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
    lines, skipped, _shipping = parse_lines(load_estimate("dev-2462-two-tasks"))
    assert skipped == []
    assert [line.service for line in lines] == ["modelisation", "impression", "impression"]
    # rate x quantity: 800 x 3. item_total (2124) is the pre-tax figure.
    assert lines[1].amount == 2400
    assert lines[1].quantity == 3
    assert lines[0].amount == 3000


def test_parse_lines_amounts_add_tax_when_the_quote_is_exclusive():
    lines, _skipped, _shipping = parse_lines(load_estimate("dev-2448-vente"))
    # item_total 4000 + tax 520
    assert [line.amount for line in lines] == [4520, 4520]


def test_parse_lines_reports_unrecognised_lines():
    lines, skipped, _shipping = parse_lines(load_estimate("dev-2463-retail"))
    assert lines == []
    assert [s["sku"] for s in skipped] == ["PB05016", "L3DIMP"]
    assert skipped[0]["amount"] == 8000  # 4000 x 2, tax-inclusive quote
    assert skipped[1]["name"].startswith("Découpe")


def test_group_lines_merges_a_strictly_rising_run():
    lines, _skipped, _shipping = parse_lines(load_estimate("dev-2461-three-services"))
    groups = group_lines(lines)
    assert len(groups) == 1
    assert [line.service for line in groups[0]] == ["scan", "modelisation", "impression"]


def test_group_lines_starts_a_new_group_on_a_repeated_service():
    lines, _skipped, _shipping = parse_lines(load_estimate("dev-2462-two-tasks"))
    groups = group_lines(lines)
    assert [[line.service for line in g] for g in groups] == [
        ["modelisation", "impression"],
        ["impression"],
    ]


def test_group_lines_merges_all_four_services():
    lines, _skipped, _shipping = parse_lines(load_estimate("dev-2467-template"))
    groups = group_lines(lines)
    assert len(groups) == 1
    assert [line.service for line in groups[0]] == ["scan", "modelisation", "impression", "usinage"]


def test_group_lines_merges_a_gap_in_the_run():
    lines, _skipped, _shipping = parse_lines(load_estimate("dev-2448-vente"))
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
    # Each line's own wording lands on the description of the service that
    # priced it: the two Info: rows become those services' descriptions bare
    # (the field already says which service it is), and the material — which
    # has no Aito field — is preserved under impression. Weight, time and
    # colour were consumed into their own fields.
    assert task["scan_description"] == "Prise de mesure d'une gouttière de pièce."
    assert task["modelisation_description"] == "Dessin d'un tapis de gouttière en 4 zones"
    assert task["impression_description"] == "Matériau: TPU 95 A --- 1.5mm"
    assert task["usinage_description"] is None
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
    assert first["impression_description"] == "Matériau: PETG"
    assert second["modelisation_cost"] is None
    assert second["impression_cost"] == 200
    # Every label on the second line was blank, so nothing is preserved.
    assert all(
        second[f"{service}_description"] is None for service in ("scan", "modelisation", "impression", "usinage")
    )
    assert second["impression_weight_g"] is None
    assert second["impression_time_min"] is None
    assert second["impression_color"] is None
    assert preview["suggested_description"] == "Helice grise\nhelice"


def test_build_preview_template_quote_yields_one_empty_task():
    preview = build_preview(load_estimate("dev-2467-template"), None, URL)
    assert len(preview["tasks"]) == 1
    task = preview["tasks"][0]
    assert task["title"] == ""
    assert all(task[f"{service}_description"] is None for service in ("scan", "modelisation", "impression", "usinage"))
    assert task["scan_cost"] == 0
    assert task["usinage_cost"] == 0
    # No title anywhere, so the description falls back to the quote number.
    assert preview["suggested_description"] == "DEV26-2467"


def test_build_preview_preserves_everything_from_a_messy_quote():
    preview = build_preview(load_estimate("dev-2466-messy"), None, URL)
    task = preview["tasks"][0]
    # The impression line's Projet: is blank, so the first Info: wins.
    assert task["title"] == "Logo F170 à la place du F150"
    modelisation, impression = task["modelisation_description"], task["impression_description"]
    # The modelisation line's Info: is that service's description, stored bare
    # — the field itself says which service it belongs to.
    assert 'Logo F170 à la place du F150  ---- "BY BLAST" à la place de XLP' in modelisation
    assert "Couleur Noir de face + fond avec écriture Bleu menthe." in modelisation
    assert "Faire plusieurs pièce" in modelisation
    assert "Prix d'impression défini après confection du logo final.------------------" in impression
    assert "Matériau: PETG" in impression
    # The scan line supplied the title, so its Info: is not repeated.
    assert task["scan_description"] is None
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
    body = task["usinage_description"]
    # Usinage has no weight/time/colour fields on an Aito task, so its
    # template values must survive in the body rather than being dropped —
    # under usinage, the service whose line carried them.
    assert "Usinage: Bride alu" in body
    assert task["modelisation_description"] is None  # it supplied the title
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
        "salesperson": None,
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
    # The tail lives on the group's first service, whichever line carried the
    # title — otherwise the truncated half would simply be lost.
    assert long_title.strip() in task["scan_description"]


def test_build_preview_preserves_a_poids_or_temps_that_fails_to_parse():
    estimate = load_estimate("dev-2461-three-services")
    estimate["line_items"][2]["description"] = (
        "Projet: Tapis souple X4 bloc\nPoids: à définir\nTemps: à définir\nCouleur: NOIR"
    )
    preview = build_preview(estimate, None, URL)
    task = preview["tasks"][0]
    # Neither label parsed to a number, so both fields stay null and both
    # rows are preserved verbatim in the body rather than being dropped.
    assert task["impression_weight_g"] is None
    assert task["impression_time_min"] is None
    assert "Poids: à définir" in task["impression_description"]
    assert "Temps: à définir" in task["impression_description"]


def test_build_preview_preserves_the_prose_around_a_partially_parsed_weight():
    estimate = load_estimate("dev-2461-three-services")
    estimate["line_items"][2]["description"] = (
        "Projet: Tapis souple X4 bloc\nPoids: 210 gr par piece, 4 pieces\nTemps: 13h\nCouleur: NOIR"
    )
    preview = build_preview(estimate, None, URL)
    task = preview["tasks"][0]
    # The number was found, so the field is populated — but the sentence
    # around it is not part of the number, so it must survive too.
    assert task["impression_weight_g"] == 210
    assert "Poids: 210 gr par piece, 4 pieces" in task["impression_description"]


def test_build_preview_preserves_the_second_token_of_a_multi_token_weight():
    estimate = load_estimate("dev-2461-three-services")
    estimate["line_items"][2]["description"] = (
        "Projet: Tapis souple X4 bloc\nPoids: 210 gr 50 gr\nTemps: 13h\nCouleur: NOIR"
    )
    preview = build_preview(estimate, None, URL)
    task = preview["tasks"][0]
    # Only the first token ("210 gr") was ever parsed into the field. The
    # second token ("50 gr") must not be silently swallowed by `sub`
    # stripping every match -- the whole row is preserved in the body too.
    assert task["impression_weight_g"] == 210
    assert "Poids: 210 gr 50 gr" in task["impression_description"]


def test_build_preview_carries_the_quote_salesperson():
    estimate = load_estimate("dev-2462-two-tasks") | {"salesperson_name": "Marie VENDEUSE"}
    preview = build_preview(estimate, None, "https://books.zoho.eu/app/1#/estimates/e2")
    assert preview["quote"]["salesperson"] == "Marie VENDEUSE"


def test_build_preview_salesperson_is_none_when_the_quote_has_none():
    preview = build_preview(load_estimate("dev-2462-two-tasks"), None, "https://books.zoho.eu/app/1#/estimates/e2")
    assert preview["quote"]["salesperson"] is None


def test_build_preview_truncates_a_salesperson_name_longer_than_the_field_limit():
    # AitoProjectCreate.quote_salesperson has max_length=200; an unclipped
    # value here would 422 the entire import rather than degrade gracefully.
    long_name = "A" * 250
    estimate = load_estimate("dev-2462-two-tasks") | {"salesperson_name": long_name}
    preview = build_preview(estimate, None, "https://books.zoho.eu/app/1#/estimates/e2")
    assert preview["quote"]["salesperson"] == "A" * 200


def test_build_preview_preserves_a_colour_longer_than_the_field_limit():
    estimate = load_estimate("dev-2461-three-services")
    long_color = (
        "Bleu menthe pantone 3255C sur la face avant et Noir RAL 9005 sur le fond avec un liseré doré sur le pourtour"
    )
    assert len(long_color) > 100
    estimate["line_items"][2]["description"] = f"Projet: Tapis souple X4 bloc\nCouleur: {long_color}"
    preview = build_preview(estimate, None, URL)
    task = preview["tasks"][0]
    # The field is truncated to fit, but the full value must still appear
    # in the body rather than losing its tail silently.
    assert task["impression_color"] == long_color[:100]
    assert f"Couleur: {long_color}" in task["impression_description"]


def _estimate_with_headers() -> dict:
    """Two tasks whose service ranks rise across the boundary (scan then
    modelisation). Without header awareness the heuristic merges them."""
    return {
        "estimate_id": "e1",
        "estimate_number": "DEV26-9001",
        "is_inclusive_tax": True,
        "price_precision": 0,
        "line_items": [
            {"item_order": 1, "line_item_category": "header", "name": "Premiere piece", "sku": ""},
            {"item_order": 2, "sku": "P3DSCAN", "description": "Info: Premiere piece", "rate": 5000, "quantity": 1},
            {"item_order": 3, "line_item_category": "header", "name": "Deuxieme piece", "sku": ""},
            {"item_order": 4, "sku": "P3DMOD", "description": "Info: Deuxieme piece", "rate": 3000, "quantity": 1},
        ],
    }


def test_header_row_is_not_reported_as_skipped():
    _, skipped, _shipping = parse_lines(_estimate_with_headers())
    assert skipped == []


def test_header_row_starts_a_new_group_even_when_rank_rises():
    lines, _, _shipping = parse_lines(_estimate_with_headers())
    assert [line.starts_group for line in lines] == [True, True]
    groups = group_lines(lines)
    assert len(groups) == 2
    assert [line.service for group in groups for line in group] == ["scan", "modelisation"]


def _estimate_with_line_headers() -> dict:
    """The format Books ACTUALLY stores (reference: quote DEV26-2506): there
    is no header row — every grouped line carries ``header_name`` and a
    Books-generated ``header_id``. Ranks rise across the boundary here, so
    only header awareness keeps the two tasks apart."""
    return {
        "estimate_id": "e1",
        "estimate_number": "DEV26-9001",
        "is_inclusive_tax": True,
        "price_precision": 0,
        "line_items": [
            {
                "item_order": 1,
                "sku": "P3DSCAN",
                "description": "Info: Premiere piece",
                "rate": 5000,
                "quantity": 1,
                "header_id": "H1",
                "header_name": "Premiere piece",
            },
            {
                "item_order": 2,
                "sku": "P3DMOD",
                "description": "Info: Deuxieme piece",
                "rate": 3000,
                "quantity": 1,
                "header_id": "H2",
                "header_name": "Deuxieme piece",
            },
        ],
    }


def test_header_name_change_starts_a_new_group_even_when_rank_rises():
    lines, skipped, _shipping = parse_lines(_estimate_with_line_headers())
    assert skipped == []
    assert [line.starts_group for line in lines] == [True, True]
    groups = group_lines(lines)
    assert len(groups) == 2
    assert [line.service for group in groups for line in group] == ["scan", "modelisation"]


def test_lines_sharing_a_header_stay_in_one_group():
    estimate = _estimate_with_line_headers()
    for line in estimate["line_items"]:
        line["header_id"] = "H1"
        line["header_name"] = "Premiere piece"
    lines, _, _shipping = parse_lines(estimate)
    assert [line.starts_group for line in lines] == [True, False]
    assert len(group_lines(lines)) == 1


def test_same_header_name_with_different_ids_still_splits():
    """Two tasks can share a title. Books keeps their headers distinct via
    header_id, and so must the boundary detection."""
    estimate = _estimate_with_line_headers()
    for line in estimate["line_items"]:
        line["header_name"] = "Piece"
    lines, _, _shipping = parse_lines(estimate)
    assert [line.starts_group for line in lines] == [True, True]


def test_line_discount_is_adopted_onto_the_impression_task():
    """Books answers with `discount: "10.00%"` on a discounted line (org is
    item-level, see DEV26-2469 where the user hand-set exactly this). The
    import must adopt it — the next push rebuilds the whole line_items array,
    so an unadopted discount would be silently wiped from a real quote."""
    estimate = {
        "estimate_id": "e1",
        "estimate_number": "DEV26-9001",
        "is_inclusive_tax": True,
        "price_precision": 0,
        "line_items": [
            {
                "item_order": 1,
                "sku": "P3DIMP",
                "description": "Projet: Punisher",
                "rate": 1600,
                "quantity": 1,
                "discount": "10.00%",
            },
        ],
    }
    preview = build_preview(estimate, None, "https://x")
    assert preview["tasks"][0]["impression_discount_pct"] == 10
    # Pre-discount figure, matching what the exporter writes back.
    assert preview["tasks"][0]["impression_cost"] == 1600


def test_flat_amount_discount_is_not_adopted():
    """A hand-typed flat discount ("150", no percent sign) has no field to
    live in — leave it None rather than misread it as 150%."""
    estimate = {
        "estimate_id": "e1",
        "estimate_number": "DEV26-9001",
        "is_inclusive_tax": True,
        "price_precision": 0,
        "line_items": [
            {
                "item_order": 1,
                "sku": "P3DIMP",
                "description": "Projet: X",
                "rate": 1600,
                "quantity": 1,
                "discount": 150,
            },
        ],
    }
    preview = build_preview(estimate, None, "https://x")
    assert preview["tasks"][0]["impression_discount_pct"] is None


def _line(sku: str, rate: float, *, description: str = "", header_name: str | None = None, **extra) -> dict:
    """One line item in the shape `parse_lines` reads."""
    line = {"sku": sku, "rate": rate, "quantity": 1, "description": description, **extra}
    if header_name is not None:
        line["header_name"] = header_name
    return line


def _estimate(lines: list[dict]) -> dict:
    return {
        "estimate_id": "e1",
        "estimate_number": "DEV26-9002",
        "is_inclusive_tax": True,
        "price_precision": 0,
        "line_items": [{**line, "item_order": order} for order, line in enumerate(lines, start=1)],
    }


def test_header_name_wins_the_title_and_info_becomes_the_service_description():
    estimate = _estimate(
        [
            _line(
                "P3DSCAN", 5000, description="Info: Scanner la pièce\n*Fichier non cédé*", header_name="Helice grise"
            ),
        ]
    )
    tasks = build_preview(estimate, None, "https://x")["tasks"]
    assert tasks[0]["title"] == "Helice grise"
    assert tasks[0]["scan_description"] == "Scanner la pièce"


def test_legacy_headerless_quote_still_titles_from_info():
    # Old-format quote: no header, Info: carries the title (the pre-rework
    # export wrote it that way). The fallback must keep these importable.
    estimate = _estimate([_line("P3DSCAN", 5000, description="Info: Helice grise")])
    tasks = build_preview(estimate, None, "https://x")["tasks"]
    assert tasks[0]["title"] == "Helice grise"
    assert tasks[0]["scan_description"] is None


def test_leftover_labels_and_free_text_land_on_their_line_s_service():
    estimate = _estimate(
        [
            _line(
                "P3DIMP",
                2400,
                description="Info: Pièce détachée\nDimensions: 40x60\nCouleur Noir de face.",
                header_name="Support",
            ),
        ]
    )
    tasks = build_preview(estimate, None, "https://x")["tasks"]
    desc = tasks[0]["impression_description"]
    assert "Pièce détachée" in desc
    assert "Dimensions: 40x60" in desc
    assert "Couleur Noir de face." in desc


def test_pre_rework_headed_quote_does_not_repeat_its_title_in_every_description():
    """The app's OWN pre-rework export, for any project with two or more
    tasks, wrote the title BOTH as `header_name` and as a title label on every
    one of the task's lines. The header now supplies the title, so those
    labels are duplicates: keeping them would put `Info: Impression3D: Helice
    grise` on the customer's PDF at the very next push."""
    estimate = _estimate(
        [
            _line("P3DSCAN", 5000, description="Info: Helice grise\n*Fichier non cédé*", header_name="Helice grise"),
            _line("P3DIMP", 2400, description="Projet: Helice grise\nMatériau: PETG", header_name="Helice grise"),
            _line("U3DIMP", 500, description="Usinage: Helice grise", header_name="Helice grise"),
        ]
    )
    task = build_preview(estimate, None, "https://x")["tasks"][0]
    assert task["title"] == "Helice grise"
    assert task["scan_description"] is None
    assert task["usinage_description"] is None
    # Only the material — which has no Aito field — survives on impression.
    assert task["impression_description"] == "Matériau: PETG"


def test_a_title_label_that_is_not_the_header_still_survives():
    """The de-duplication is an EXACT match against the header, so wording a
    line happens to carry under a title label is preserved, not dropped."""
    estimate = _estimate(
        [
            _line("P3DSCAN", 5000, description="Info: Scanner la pièce", header_name="Helice grise"),
            _line("P3DIMP", 2400, description="Projet: Autre pièce", header_name="Helice grise"),
            _line("U3DIMP", 500, description="Usinage: Bride alu", header_name="Helice grise"),
        ]
    )
    task = build_preview(estimate, None, "https://x")["tasks"][0]
    assert task["title"] == "Helice grise"
    assert task["scan_description"] == "Scanner la pièce"
    assert task["impression_description"] == "Impression3D: Autre pièce"
    assert task["usinage_description"] == "Usinage: Bride alu"


def test_quote_without_headers_groups_exactly_as_before():
    # dev-2461 walks scan -> model -> impression: one job, one task. Unchanged.
    lines, _, _shipping = parse_lines(load_estimate("dev-2461-three-services"))
    assert all(not line.starts_group for line in lines)
    assert len(group_lines(lines)) == 1


SHIPPING_IDS = {"tuamotu": "SHIP-TU", "societe": "SHIP-SO"}


def test_parse_shipping_line_reads_back_what_the_exporter_wrote():
    written = build_shipping_description(
        ExportShipping(
            service="tuamotu",
            island_label="Rangiroa",
            first_name="Jean-Pierre",
            last_name="DUPONT",
            phone="+689-89645864",
            price=3200.0,
        )
    )
    parsed = parse_shipping_line(
        {"item_id": "SHIP-TU", "description": written, "rate": 3200, "quantity": 1}, SHIPPING_IDS
    )
    assert parsed.service == "tuamotu"
    assert parsed.island == "rangiroa"
    assert parsed.first_name == "Jean-Pierre"
    assert parsed.last_name == "DUPONT"
    assert parsed.phone == "+689-89645864"
    assert parsed.price == 3200.0


def test_parse_shipping_line_ignores_a_line_that_is_not_shipping():
    assert parse_shipping_line({"item_id": "I", "description": "Poids: 210 gr"}, SHIPPING_IDS) is None


def test_parse_shipping_line_gives_up_on_an_unknown_island():
    # Leaves the project without shipping. The export step's echo rule is what
    # then keeps the line alive on the quote — see build_line_items.
    line = {"item_id": "SHIP-TU", "description": "Nom: X\nÎle: Atlantis", "rate": 1}
    assert parse_shipping_line(line, SHIPPING_IDS) is None


def test_parse_shipping_line_splits_a_single_token_name_as_a_last_name():
    line = {"item_id": "SHIP-TU", "description": "Nom: DUPONT\nÎle: Rangiroa", "rate": 1}
    parsed = parse_shipping_line(line, SHIPPING_IDS)
    assert (parsed.first_name, parsed.last_name) == ("", "DUPONT")


def test_a_shipping_line_is_not_reported_as_a_skipped_line():
    estimate = {
        "line_items": [
            {
                "item_id": "SHIP-TU",
                "sku": "LIV-TU",
                "name": "Livraison Avion Tuamotu",
                "description": "Nom: Jean-Pierre DUPONT\nÎle: Rangiroa",
                "rate": 3200,
                "quantity": 1,
                "item_order": 2,
            },
        ]
    }
    recognised, skipped, _shipping = parse_lines(estimate, shipping_ids=SHIPPING_IDS)
    assert recognised == []
    assert skipped == [], "a recognised shipping line is not an unimportable row"


def test_build_preview_returns_the_shipment():
    estimate = {
        "estimate_id": "E1",
        "estimate_number": "DEV-1",
        "line_items": [
            {
                "item_id": "SHIP-TU",
                "sku": "LIV-TU",
                "name": "Livraison Avion Tuamotu",
                "description": "Nom: Jean-Pierre DUPONT\nTéléphone: +689-89645864\nÎle: Rangiroa",
                "rate": 3200,
                "quantity": 1,
                "item_order": 1,
            },
        ],
    }
    preview = build_preview(estimate, None, "https://books.example/q", shipping_ids=SHIPPING_IDS)
    assert preview["shipping"] == {
        "island": "rangiroa",
        "service": "tuamotu",
        "first_name": "Jean-Pierre",
        "last_name": "DUPONT",
        "phone": "+689-89645864",
        "price": 3200.0,
    }


def test_build_preview_has_no_shipping_by_default():
    preview = build_preview({"estimate_id": "E1", "line_items": []}, None, "https://x")
    assert preview["shipping"] is None


def test_shipping_round_trips_export_to_import_to_export():
    from backend.app.services.aito_quote_export import Catalogue, build_line_items

    catalogue = Catalogue("S", "M", "I", "U", "T", {"tuamotu": "SHIP-TU"})
    original = ExportShipping(
        service="tuamotu",
        island_label="Rangiroa",
        first_name="Jean-Pierre",
        last_name="DUPONT",
        phone="+689-89645864",
        price=3200.0,
    )
    first = build_line_items([], [], catalogue, shipping=original)
    parsed = parse_shipping_line(first[0], catalogue.shipping)
    again = ExportShipping(
        service=parsed.service,
        island_label="Rangiroa",
        first_name=parsed.first_name,
        last_name=parsed.last_name,
        phone=parsed.phone,
        price=parsed.price,
    )
    assert build_line_items([], [], catalogue, shipping=again) == first


def test_a_nom_row_on_an_ordinary_service_line_is_not_silently_erased():
    """Regression: shipping's "Nom:" label must not be shared with the
    catalogue-template labels parse_description uses for every line. Sharing
    it would let parse_description CAPTURE "Nom: Marie Curie" as a labelled
    value on an ordinary P3DIMP line — but LABEL_ORDER (which _build_task
    uses to re-emit a preserved label) has no entry for "nom", so the row
    would be silently dropped from the task description and then permanently
    erased from the quote on the next push. It must instead fall through as
    free text and survive verbatim."""
    estimate = _estimate(
        [_line("P3DIMP", 2400, description="Projet: Support\nNom: Marie Curie", header_name="Support")]
    )
    task = build_preview(estimate, None, "https://x")["tasks"][0]
    assert "Nom: Marie Curie" in task["impression_description"]


def test_an_ile_row_on_an_ordinary_service_line_is_not_silently_erased():
    """Same regression, covering the accent/case-folded variant of the
    shipping label ("ÎLE:" folds to the same key as "Île:")."""
    estimate = _estimate([_line("P3DIMP", 2400, description="Projet: Support\nÎLE: Rangiroa", header_name="Support")])
    task = build_preview(estimate, None, "https://x")["tasks"][0]
    assert "ÎLE: Rangiroa" in task["impression_description"]
