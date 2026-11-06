"""Order-board campaign golden probe: the prep sheet PDF (services/order_board_prep_sheet.render_prep_sheet).

Renders fixed board rows at a FIXED ``printed_at`` and prints, per sheet, the
page count, the text of every page (pypdfium2, the extractor the unit tests
use) and the sha256 of the bytes. reportlab's ``invariant`` mode is switched on
here so the bytes carry no creation time and no random document id.

The text is what the operator reads; the sha256 also moves on anything the
text cannot show (the QR code's target, line positions, fonts, boxes).
"""

import hashlib
import json
import re
import sys
from datetime import datetime

sys.path.insert(0, ".")
import pypdfium2 as pdfium  # noqa: E402
from reportlab import rl_config  # noqa: E402

rl_config.invariant = 1

from backend.app.services.order_board_prep_sheet import render_prep_sheet  # noqa: E402

PRINTED_AT = datetime(2026, 3, 14, 9, 5, 30)


def line(n, name="Support mural", *, packable=2.0, quantity=3.0, remaining=3.0, waiting=0.0, sku=None):
    return {"id": f"l{n}", "sku": sku if sku is not None else f"SKU-{n:03d}", "name": name, "quantity": quantity,
            "remaining": remaining, "packed_waiting": waiting, "packable": packable}


def row(**kw):
    base = {
        "number": "SO-00412", "customer": "Atelier Moana", "date": "2026-03-10", "currency": "XPF",
        "contact": {"name": "Hina Teriitahi", "email": "hina@example.pf", "phone": "40 12 34 56", "mobile": "87 11 22 33"},
        "facts": {"channel": "Shopify", "reference": "#1042", "delivery_method": "Livraison"},
        "payment": {"left": 4000.0},
        "lines": [line(1), line(2, "Boîte à clés", packable=0.0, quantity=5.0, remaining=5.0), line(3, "Cordage au mètre", packable=1.25, quantity=2.5, remaining=2.5, waiting=0.5)],
    }
    base.update(kw)
    return base


LONG = [line(n, f"Pièce imprimée numéro {n} " + "très longue désignation " * (n % 4), packable=float(n % 5), quantity=float(n % 5 + 2), remaining=float(n % 5 + 1), sku=f"REF-{n:04d}-" + "X" * (n % 30)) for n in range(1, 91)]
ODD = [
    line(1, "Tāne Māʻohi tiki ʻōkina ʼeta"),
    line(2, "東京 フィラメント 1kg", sku="日本-001"),
    line(3, "Łódź Ω € œ “quoted” – dash … ellipsis ™", sku="ŁÓDŹ-Ω"),
    line(4, "Emoji 🚀 and tab\there and ﬁ ligature ½ ²", sku="🚀"),
    line(5, "", sku="", packable=1.0),
    line(6, None, sku=None, packable=0.0),
]

SHEETS = {
    "short: everything packable, link, no picklist": (row(), {"order_url": "https://fenrir.example/orders?order=so412"}),
    "short: units of one picklist": (row(), {"order_url": "https://fenrir.example/orders?order=so412", "quantities": {"l1": 1, "l3": 0.75, "zzz": 9}, "picklist_number": "PL-00007"}),
    "short: no link, picklist number alone, other shop name": (row(), {"order_url": None, "picklist_number": "PL-00008", "shop_name": "Fenrir Māʻohi"}),
    "paid, pick-up, quote reference": (row(payment={"left": 0.4}, facts={"channel": "", "reference": "DEV26-2638", "delivery_method": "pick up"}, contact={"name": "", "phone": "40 12 34 56"}), {"order_url": ""}),
    "euros, no contact, no payment, no facts": (row(currency="EUR", payment=None, contact=None, facts=None, date="pas une date"), {"order_url": None}),
    "euros, left to pay": (row(currency="EUR", payment={"left": 1234.5}, date="2026-12-01"), {"order_url": None}),
    "nothing packable": (row(lines=[line(1, packable=0.0), line(2, packable=0.0, remaining=0.0)]), {"order_url": None}),
    "empty row": ({}, {"order_url": None}),
    "long: several pages of lines and of leftovers": (row(lines=LONG, customer="Client " + "au nom interminable " * 6), {"order_url": "https://fenrir.example/orders?order=long"}),
    "long: picklist of every line": (row(lines=LONG), {"order_url": None, "quantities": {f"l{n}": 0.5 for n in range(1, 91)}, "picklist_number": "PL-00099"}),
    "characters Helvetica cannot encode": (row(lines=ODD, customer="Tāne Māʻohi 東京 Łódź 🚀", number="SO-ʻ001", contact={"name": "Ōrama Teʻa", "mobile": "８７ １１"}, facts={"channel": "shopify", "reference": "№ 1042 ✓", "delivery_method": "Livraison à Māhina"}), {"order_url": "https://fenrir.example/orders?order=ʻ001", "picklist_number": "PL-Ω"}),
}

out = {}
for label, (board_row, kwargs) in SHEETS.items():
    try:
        pdf = render_prep_sheet(board_row, printed_at=PRINTED_AT, **kwargs)
        doc = pdfium.PdfDocument(pdf)
        out[label] = {
            "pages": len(doc),
            "starts_with_pdf": pdf.startswith(b"%PDF-"),
            "sha256": hashlib.sha256(pdf).hexdigest(),
            "bytes": len(pdf),
            "text": [[ln for ln in (re.sub(r"\s+", " ", t).strip() for t in page.get_textpage().get_text_range().splitlines()) if ln] for page in doc],
        }
    except Exception as e:
        out[label] = {"__raised__": f"{type(e).__name__}: {e}"}
print(json.dumps(out, indent=1, ensure_ascii=False))
