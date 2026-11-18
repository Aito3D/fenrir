"""Order Board campaign (O3) golden probe: the prep sheet PDFs, on fixed inputs.

render_prep_sheet (whole order; one picklist's units; no contact/payment; long list that
spills to a second page; non-cp1252 names) and render_batch_prep_sheet (combined picking
page + each sheet), plus combine_picks. Per PDF: page count, the text pdfium extracts per
page, and every page's drawing operators (reportlab invariant mode, no compression, so
the bytes carry no date or random id; image streams are summarised by length + sha256).
"""
import hashlib
import json
import re
import sys
from datetime import datetime

sys.path.insert(0, "tools")
import probe_orders_lib  # noqa: E402,F401  (temp DATA_DIR before the app is imported)

from reportlab import rl_config  # noqa: E402

rl_config.invariant = 1
rl_config.pageCompression = 0

import pypdfium2 as pdfium  # noqa: E402

from backend.app.services.order_board_prep_sheet import (  # noqa: E402
    combine_picks,
    render_batch_prep_sheet,
    render_prep_sheet,
)

NOW = datetime(2026, 11, 6, 9, 5)
STREAM = re.compile(rb"(\d+) 0 obj\s*<<(.*)>>\s*stream\r?\n(.*?)\r?\n?endstream", re.S)


def line(sku, name="Support mural", packable=2.0, quantity=3.0, remaining=3.0, waiting=0.0, item_id=None):
    return {"id": sku, "sku": sku, "name": name, "quantity": quantity, "remaining": remaining,
            "packed_waiting": waiting, "packable": packable, "item_id": item_id or sku}


def row(**kw):
    base = {
        "id": "so412", "number": "SO-00412", "customer": "Atelier Moana", "date": "2026-11-02", "currency": "XPF",
        "contact": {"name": "Hina Teriitahi", "email": "hina@example.test", "phone": "40 12 34 56", "mobile": "87 11 22 33"},
        "facts": {"channel": "Shopify", "reference": "1042", "shopify_order": "1042", "quote_number": "", "delivery_method": "Livraison"},
        "payment": {"left": 4000.0},
        "lines": [line("SKU-A"), line("SKU-B", "Boîte à clés", packable=0.0, quantity=5.0, remaining=5.0),
                  line("SKU-C", "Pièce C", packable=1.5, quantity=5.0, remaining=4.0, waiting=2.0)],
    }
    base.update(kw)
    return base


def describe(pdf: bytes) -> dict:
    doc = pdfium.PdfDocument(pdf)
    texts = [page.get_textpage().get_text_range().replace("\r\n", "\n").replace("\r", "\n") for page in doc]
    streams = []
    for num, head, body in (m.groups() for chunk in pdf.split(b"endobj") if (m := STREAM.search(chunk))):
        if b"/Image" in head or b"/FontFile" in head:
            streams.append(f"obj {int(num)}: <{head.decode('latin-1').strip()}> {len(body)} bytes sha256={hashlib.sha256(body).hexdigest()[:16]}")
        else:
            streams.append(f"obj {int(num)}: <{head.decode('latin-1').strip()}>\n{body.decode('latin-1')}")
    return {"pages": len(doc), "text": texts, "streams": streams}


out = {}
out["single"] = describe(render_prep_sheet(row(), printed_at=NOW, order_url="https://shop.example/orders?order=so412"))
out["picklist"] = describe(render_prep_sheet(row(), printed_at=NOW, order_url=None, quantities={"SKU-A": 1.0, "SKU-C": 0.5}, picklist_number="PL-00013"))
out["bare"] = describe(render_prep_sheet(
    row(contact=None, payment={"left": 0}, facts={"channel": "", "reference": "", "delivery_method": "Pick Up"},
        customer="Tāne Māʻohi 王"), printed_at=datetime(2026, 1, 31, 23, 59), order_url=None, shop_name="SHOP"))
out["long"] = describe(render_prep_sheet(row(lines=[line(f"SKU-{i:03d}", f"Produit {i}", packable=1.0 + i % 3) for i in range(45)]),
                                         printed_at=NOW, order_url=None))
batch_rows = [
    row(id="so1", number="SO-00001", lines=[line("SKU-A", item_id="A"), line("SKU-B", item_id="B", packable=0.25)]),
    row(id="so2", number="SO-00002", customer="Second", lines=[line("SKU-A", item_id="A", packable=3.0), line("SKU-Z", "Sans marque", item_id="Z")]),
]
brands = {"A": "eSUN", "B": "Bambu Lab"}
out["combine_picks"] = combine_picks(batch_rows, brands)
out["batch"] = describe(render_batch_prep_sheet(batch_rows, brands, printed_at=NOW, order_urls={"so1": "https://shop.example/orders?order=so1"}))
print(json.dumps(out, indent=1, ensure_ascii=False, sort_keys=True))
