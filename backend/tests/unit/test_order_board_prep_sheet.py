import re
from datetime import datetime

import pypdfium2 as pdfium

from backend.app.services.order_board_prep_sheet import combine_picks, render_batch_prep_sheet, render_prep_sheet

NOW = datetime(2026, 11, 6, 9, 5)


def _line(sku, name="Support mural", packable=2.0, quantity=3.0, remaining=3.0, waiting=0.0):
    return {
        "id": sku,
        "sku": sku,
        "name": name,
        "quantity": quantity,
        "remaining": remaining,
        "packed_waiting": waiting,
        "packable": packable,
    }


def _row(**kw):
    row = {
        "number": "SO-00412",
        "customer": "Atelier Moana",
        "date": "2026-11-02",
        "currency": "XPF",
        "contact": {"name": "Hina Teriitahi", "email": "", "phone": "40 12 34 56", "mobile": "87 11 22 33"},
        "facts": {
            "channel": "Shopify",
            "reference": "1042",
            "shopify_order": "1042",
            "quote_number": "",
            "delivery_method": "Livraison",
        },
        "payment": {"left": 4000.0},
        "lines": [_line("SKU-A"), _line("SKU-B", "Boîte à clés", packable=0.0, quantity=5.0, remaining=5.0)],
    }
    row.update(kw)
    return row


def text(pdf: bytes) -> str:
    doc = pdfium.PdfDocument(pdf)
    out = " ".join(page.get_textpage().get_text_range() for page in doc)
    return re.sub(r"\s+", " ", out)


def pages(pdf: bytes) -> int:
    return len(pdfium.PdfDocument(pdf))


def sheet(row=None, **kw):
    kw.setdefault("order_url", "https://x.example/orders?o=SO-00412")
    return render_prep_sheet(row or _row(), printed_at=NOW, **kw)


def test_sheet_names_the_order_and_lists_only_packable_units():
    t = text(sheet())
    for s in (
        "BON DE PRÉPARATION",
        "SO-00412",
        "Atelier Moana",
        "Hina Teriitahi",
        "87 11 22 33",
        "Support mural",
        "SKU-A",
    ):
        assert s in t
    assert "Imprimé le 6 nov. 2026 à 09:05" in t
    assert "1 article · 2 unités" in t
    assert "Pas en stock, reste à livrer" in t
    assert "Boîte à clés" in t
    assert "Ouvrir la commande" in t


def test_payment_line_says_paid_or_what_is_left():
    assert "Reste à payer 4 000 FCFP" in text(sheet())
    assert "Payée" in text(sheet(_row(payment={"left": 0})))


def test_sheet_without_contact_payment_reference_or_url_still_renders():
    row = _row(contact=None, payment=None, facts={"channel": "", "reference": "", "delivery_method": ""})
    t = text(sheet(row, order_url=None))
    assert "SO-00412" in t
    assert "Paiement" not in t and "Livraison" not in t and "Ouvrir la commande" not in t


def test_pick_up_reads_retrait_en_boutique():
    row = _row(facts={"channel": "", "reference": "", "delivery_method": "Pick Up"})
    assert "Retrait en boutique" in text(sheet(row))


def test_a_long_order_spills_onto_a_second_page():
    row = _row(lines=[_line(f"SKU-{i:03d}") for i in range(60)])
    pdf = sheet(row)
    assert pages(pdf) >= 2
    t = text(pdf)
    assert all(f"SKU-{i:03d}" in t for i in range(60))


def test_fractional_quantity_is_printed_as_is():
    assert "2.5" in text(sheet(_row(lines=[_line("SKU-A", packable=2.5, quantity=2.5, remaining=2.5)])))


def test_output_is_a_pdf():
    assert sheet().startswith(b"%PDF-")


def test_short_quantity_in_the_box_accounts_for_packed_waiting():
    row = _row(lines=[_line("SKU-A", "Pièce A", packable=1.0, quantity=5.0, remaining=5.0, waiting=2.0)])
    assert "Pas en stock, reste à livrer 2 Pièce A" in text(sheet(row))
    assert "Pas en stock, reste à livrer 4 Pièce A" in text(
        sheet(_row(lines=[_line("SKU-A", "Pièce A", 1.0, 5.0, 5.0)]))
    )


def test_tahitian_and_chinese_text_is_folded_not_squared():
    t = text(sheet(_row(customer="Tāne Māʻohi", contact={"name": "王小明", "phone": "1", "mobile": ""})))
    assert "Tane Ma'ohi" in t
    assert "???" in t
    assert "\ufffd" not in t


def test_float_dust_is_rounded():
    row = _row(lines=[_line("SKU-A", packable=0.1 + 0.2, quantity=0.3, remaining=0.3), _line("SKU-B", packable=1.0)])
    t = text(sheet(row))
    assert "0.3 " in t and "0.30000" not in t
    assert "2 articles · 1.3 unités" in t


def test_amount_that_rounds_to_zero_reads_paid():
    assert "Payée" in text(sheet(_row(payment={"left": 0.3})))


def test_a_long_short_list_flows_onto_further_pages():
    row = _row(lines=[_line(f"S{i}", f"Manque{i:03d}", packable=0.0, quantity=1.0, remaining=1.0) for i in range(60)])
    pdf = sheet(row)
    assert pages(pdf) >= 2
    t = text(pdf)
    assert all(f"Manque{i:03d}" in t for i in range(60))
    assert "Document interne" in t


def test_a_picklist_sheet_prints_its_units_and_number_and_what_stays_behind():
    row = _row(
        lines=[_line("SKU-A", packable=3.0), _line("SKU-B", "Boîte à clés", packable=2.0, quantity=2.0, remaining=2.0)]
    )
    t = text(
        render_prep_sheet(row, printed_at=NOW, order_url=None, quantities={"SKU-A": 1.0}, picklist_number="PL-00013")
    )
    assert "SO-00412 · PL-00013" in t
    assert "1 article · 1 unité" in t and "unités" not in t
    assert "Hors de ce prélèvement, reste à livrer" in t and "Pas en stock" not in t
    assert "Boîte à clés" in t  # left for a later picklist, with the two units of SKU-A not taken


def _batch_rows():
    a = _line("PLA-BK", "PLA Noir", packable=2.0)
    b = _line("ABS-WH", "ABS Blanc", packable=0.1)
    return [
        _row(id="so1", lines=[{**a, "item_id": "A"}, {**b, "item_id": "B"}]),
        _row(
            id="so2",
            number="SO-00415",
            lines=[
                {**a, "item_id": "A", "packable": 1.0},
                {**b, "item_id": "B", "packable": 0.2},
                {**_line("ZZ-1", "Colle"), "item_id": "C"},
                {**_line("NOPE", "Rupture", packable=0.0), "item_id": "D"},
            ],
        ),
    ]


BRANDS = {"A": "eSUN", "B": "Bambu Lab", "D": "eSUN"}


def test_combine_totals_each_product_once_by_brand_then_sku_with_no_brand_last():
    picks = combine_picks(_batch_rows(), BRANDS)
    assert [(p["brand"], p["sku"], p["quantity"]) for p in picks] == [
        ("Bambu Lab", "ABS-WH", 0.3),  # 0.1 + 0.2, not 0.30000000000000004
        ("eSUN", "PLA-BK", 3.0),
        ("", "ZZ-1", 2.0),
    ]
    assert picks[1]["orders"] == {"SO-00412": 2.0, "SO-00415": 1.0}


def test_combine_adds_up_two_lines_of_one_item_in_one_order():
    line = {**_line("PLA-BK"), "item_id": "A"}
    [pick] = combine_picks([_row(lines=[line, {**line, "id": "other", "packable": 1.5}])], {})
    assert pick["quantity"] == 3.5 and pick["orders"] == {"SO-00412": 3.5}


def test_batch_is_the_combined_page_then_one_sheet_per_order():
    pdf = render_batch_prep_sheet(_batch_rows(), BRANDS, printed_at=NOW, order_urls={"so1": "https://x.example/o"})
    assert pages(pdf) == 3
    first = re.sub(r"\s+", " ", pdfium.PdfDocument(pdf)[0].get_textpage().get_text_range())
    for s in ("LISTE DE PRÉLÈVEMENT", "2 commandes", "eSUN", "Sans marque", "SO-00412 ×2, SO-00415 ×1", "0.3"):
        assert s in first
    assert "3 articles · 5.3 unités" in first
    assert first.index("Bambu Lab") < first.index("eSUN") < first.index("Sans marque")
    assert text(pdf).count("BON DE PRÉPARATION") == 2


def test_a_long_combined_list_spills_onto_a_second_page():
    rows = [_row(lines=[{**_line(f"SKU-{i:03d}"), "item_id": str(i)} for i in range(60)])]
    pdf = render_batch_prep_sheet(rows, {}, printed_at=NOW, order_urls={})
    assert pages(pdf) >= 4 and text(pdf).count("SKU-059") == 2
