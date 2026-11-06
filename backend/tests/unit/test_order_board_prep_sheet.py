import re
from datetime import datetime

import pypdfium2 as pdfium

from backend.app.services.order_board_prep_sheet import render_prep_sheet

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
        "facts": {"channel": "Shopify", "reference": "#1042", "delivery_method": "Livraison"},
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
