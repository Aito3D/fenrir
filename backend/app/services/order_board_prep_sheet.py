"""A4 prep sheet an operator prints to pick and pack an order (internal document)."""

import io
import unicodedata
from collections.abc import Mapping
from datetime import datetime

from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas as rl_canvas

from backend.app.services.label_renderer import _qr_png_bytes

_MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."]
_W, _H = A4
_M = 42.0  # side margin
_GREY = (0.4, 0.4, 0.4)
_ROW_H = 24.0
_BOTTOM = 60.0
_COLS = (_M + 30, _M + 80, _W - _M - 150, _W - _M)  # tick | qty right edge, product x, ref x, right edge


def _safe(text: str) -> str:
    """Fold what Helvetica (cp1252) cannot encode: macrons lose the mark, okina becomes ', the rest '?'."""
    out = []
    for ch in str(text).replace("ʻ", "'").replace("ʼ", "'"):
        if _encodable(ch):
            out.append(ch)
            continue
        base = "".join(k for k in unicodedata.normalize("NFKD", ch) if not unicodedata.combining(k))
        out.append(base if base and all(_encodable(k) for k in base) else "?")
    return "".join(out)


def _encodable(ch: str) -> bool:
    try:
        ch.encode("cp1252")
        return True
    except UnicodeEncodeError:
        return False


class _Canvas(rl_canvas.Canvas):
    """Every string drawn or measured goes through _safe."""

    def drawString(self, x, y, text, *a, **k):
        super().drawString(x, y, _safe(text), *a, **k)

    def drawRightString(self, x, y, text, *a, **k):
        super().drawRightString(x, y, _safe(text), *a, **k)

    def drawCentredString(self, x, y, text, *a, **k):
        super().drawCentredString(x, y, _safe(text), *a, **k)

    def stringWidth(self, text, *a, **k):
        return super().stringWidth(_safe(text), *a, **k)


def _qty(v: float) -> str:
    return f"{round(float(v), 3):.3f}".rstrip("0").rstrip(".") or "0"


def _amount(v: float, currency: str) -> str:
    if currency == "XPF":
        return f"{round(v):,}".replace(",", " ") + " FCFP"
    return f"{v:,.2f}".replace(",", " ") + f" {currency}"


def _long_date(iso: str) -> str:
    try:
        y, m, d = (int(p) for p in iso[:10].split("-"))
        return f"{d} {_MONTHS[m - 1]} {y}"
    except (ValueError, IndexError):
        return iso


def _fit(c: rl_canvas.Canvas, text: str, font: str, size: float, width: float) -> str:
    if c.stringWidth(text, font, size) <= width:
        return text
    while text and c.stringWidth(text + "…", font, size) > width:
        text = text[:-1]
    return text + "…"


def _grey(c: rl_canvas.Canvas, on: bool = True) -> None:
    c.setFillColorRGB(*(_GREY if on else (0, 0, 0)))


def _header(
    c: rl_canvas.Canvas,
    row: dict,
    printed_at: datetime,
    shop_name: str,
    picklist: str = "",
    title: str = "BON DE PRÉPARATION",
) -> float:
    top = _H - _M
    c.setFont("Helvetica-Bold", 22)
    c.drawString(_M, top - 18, shop_name)
    c.setFont("Helvetica-Bold", 15)
    c.drawRightString(_W - _M, top - 14, title)
    c.setFont("Courier", 14)
    c.drawRightString(_W - _M, top - 32, " · ".join(n for n in (row.get("number") or "", picklist) if n))
    c.setFont("Helvetica", 9)
    _grey(c)
    c.drawRightString(
        _W - _M, top - 46, f"Imprimé le {_long_date(printed_at.strftime('%Y-%m-%d'))} à {printed_at:%H:%M}"
    )
    _grey(c, False)
    c.setLineWidth(1.5)
    c.line(_M, top - 54, _W - _M, top - 54)
    return top - 54


def _info(c: rl_canvas.Canvas, row: dict, y: float, order_url: str | None) -> float:
    y -= 18
    c.setFont("Helvetica", 8)
    _grey(c)
    c.drawString(_M, y, "Client")
    _grey(c, False)
    c.setFont("Helvetica-Bold", 14)
    c.drawString(_M, y - 17, _fit(c, row.get("customer") or "", "Helvetica-Bold", 14, 220))
    contact = row.get("contact") or {}
    c.setFont("Helvetica", 10)
    for i, s in enumerate((contact.get("name"), contact.get("mobile") or contact.get("phone"))):
        if s:
            c.drawString(_M, y - 32 - 13 * i, _fit(c, s, "Helvetica", 10, 220))

    facts, payment, cur = row.get("facts") or {}, row.get("payment"), row.get("currency") or ""
    pickup = (facts.get("delivery_method") or "").upper() == "PICK UP"
    infos = [("Commande du", _long_date(row.get("date") or ""))]
    if facts.get("shopify_order"):
        infos.append(("Shopify", facts["shopify_order"]))
    if facts.get("quote_number"):
        infos.append(("Devis", facts["quote_number"]))
    if facts.get("delivery_method"):
        infos.append(("Livraison", "Retrait en boutique" if pickup else facts["delivery_method"]))
    if payment is not None:
        left = payment.get("left") or 0
        paid = round(left, 0 if cur == "XPF" else 2) <= 0
        infos.append(("Paiement", "Payée" if paid else f"Reste à payer {_amount(left, cur)}"))
    x = _M + 215
    for i, (k, v) in enumerate(infos):
        yy = y - 4 - 14 * i
        c.setFont("Helvetica", 10)
        _grey(c)
        c.drawString(x, yy, k)
        _grey(c, False)
        c.setFont("Helvetica-Bold", 10)
        c.drawString(x + 78, yy, _fit(c, v, "Helvetica-Bold", 10, _W - _M - 76 - x - 78))
    bottom = y - 4 - 14 * len(infos)
    png = _qr_png_bytes(order_url or "")
    if png:
        c.drawImage(ImageReader(io.BytesIO(png)), _W - _M - 64, y - 66, width=64, height=64, mask="auto")
        c.setFont("Helvetica", 7)
        _grey(c)
        c.drawCentredString(_W - _M - 32, y - 76, "Ouvrir la commande")
        _grey(c, False)
        bottom = min(bottom, y - 78)
    return min(bottom, y - 58) - 14


def _table_head(c: rl_canvas.Canvas, y: float, last: str = "Commandé") -> float:
    c.setFont("Helvetica-Bold", 8)
    _grey(c)
    c.drawRightString(_COLS[1] - 8, y, "Qté")
    c.drawString(_COLS[1], y, "Produit")
    c.drawString(_COLS[2], y, "Référence")
    c.drawRightString(_COLS[3], y, last)
    _grey(c, False)
    c.setLineWidth(0.5)
    c.line(_M, y - 6, _W - _M, y - 6)
    return y - 6


def _box(c: rl_canvas.Canvas, x: float, y: float, w: float, h: float, label: str) -> None:
    c.setLineWidth(0.8)
    c.setStrokeColorRGB(0.6, 0.6, 0.6)
    c.roundRect(x, y - h, w, h, 3)
    c.setStrokeColorRGB(0, 0, 0)
    c.setFont("Helvetica", 8)
    _grey(c)
    c.drawString(x + 6, y - 12, label)
    _grey(c, False)


def _pick_rows(c: rl_canvas.Canvas, pick: list[dict], take: dict, y: float) -> float:
    for ln in pick:
        if y - _ROW_H < _BOTTOM + 40:
            c.showPage()
            y = _table_head(c, _H - _M - 10)
        base = y - 16
        c.setLineWidth(1.2)
        c.rect(_M + 2, base - 2, 10, 10)
        c.setFont("Helvetica-Bold", 13)
        c.drawRightString(_COLS[1] - 8, base, _qty(take[ln.get("id")]))
        c.setFont("Helvetica", 10)
        c.drawString(_COLS[1], base, _fit(c, ln.get("name") or "", "Helvetica", 10, _COLS[2] - _COLS[1] - 8))
        c.setFont("Courier", 9)
        c.drawString(_COLS[2], base, _fit(c, ln.get("sku") or "", "Courier", 9, _COLS[3] - _COLS[2] - 60))
        _grey(c)
        c.setFont("Helvetica", 10)
        c.drawRightString(_COLS[3], base, _qty(ln.get("quantity") or 0))
        _grey(c, False)
        c.setLineWidth(0.3)
        c.line(_M, y - _ROW_H, _W - _M, y - _ROW_H)
        y -= _ROW_H
    return y


def _later_segment(c: rl_canvas.Canvas, later: list[tuple[dict, float]], y: float, picklist_mode: bool) -> float:
    seg_top, seg_n = -1.0, 0  # -1: no segment started yet (page coordinates are positive)

    def close_segment() -> None:
        h = 22 + 14 * seg_n + 4
        c.setDash(3, 2)
        c.setLineWidth(0.8)
        c.roundRect(_M, seg_top - h, _W - 2 * _M, h, 3)
        c.setDash()

    for ln, q in later:
        if seg_top < 0 or seg_top - 22 - 14 * (seg_n + 1) < _BOTTOM:
            if seg_top >= 0:
                close_segment()
            if seg_top >= 0 or y - 36 < _BOTTOM:
                c.showPage()
                y = _H - _M
            seg_top, seg_n = y, 0
            c.setFont("Helvetica", 8)
            _grey(c)
            c.drawString(
                _M + 10,
                seg_top - 14,
                "Pas en stock, reste à livrer" if not picklist_mode else "Hors de ce prélèvement, reste à livrer",
            )
            _grey(c, False)
        yy = seg_top - 34 - 14 * seg_n
        c.setFont("Helvetica-Bold", 10)
        c.drawRightString(_M + 40, yy, _qty(q))
        c.setFont("Helvetica", 10)
        c.drawString(_M + 50, yy, _fit(c, ln.get("name") or "", "Helvetica", 10, _W - 2 * _M - 70))
        seg_n += 1
    close_segment()
    y = seg_top - (22 + 14 * seg_n + 4) - 18
    return y


def _footer(c: rl_canvas.Canvas, y: float) -> None:
    # The four boxes and the footer need about 90pt, else they go on a new page.
    if y - 90 < 30:
        c.showPage()
        y = _H - _M
    gap = 10.0
    w = (_W - 2 * _M - 3 * gap) / 4
    for i, label in enumerate(("Préparé par", "Contrôlé par", "Nombre de colis", "Poids")):
        _box(c, _M + i * (w + gap), y, w, 54, label)
    c.setFont("Helvetica", 8)
    _grey(c)
    c.drawString(_M, y - 70, "Document interne. Le colis est créé dans Zoho Books après contrôle.")


def _sheet(
    c: rl_canvas.Canvas,
    row: dict,
    printed_at: datetime,
    order_url: str | None,
    shop_name: str,
    quantities: Mapping[str, float] | None = None,
    picklist_number: str = "",
) -> None:
    lines = row.get("lines") or []
    take = {
        ln.get("id"): (ln.get("packable") or 0) if quantities is None else (quantities.get(ln.get("id") or "") or 0)
        for ln in lines
    }
    pick = [ln for ln in lines if take[ln.get("id")] > 0]
    later = [(ln, (ln.get("remaining") or 0) - (ln.get("packed_waiting") or 0) - take[ln.get("id")]) for ln in lines]
    later = [(ln, q) for ln, q in later if round(q, 3) > 0]

    y = _table_head(c, _info(c, row, _header(c, row, printed_at, shop_name, picklist_number), order_url))
    y = _pick_rows(c, pick, take, y)
    y = _totals(c, len(pick), sum(take[ln.get("id")] for ln in pick), y)

    if later:
        y = _later_segment(c, later, y, quantities is not None)
    _footer(c, y)
    c.showPage()


def _totals(c: rl_canvas.Canvas, n: int, units: float, y: float) -> float:
    units = round(units, 3)
    c.setFont("Helvetica-Bold", 10)
    c.drawRightString(
        _W - _M, y - 16, f"{n} article{'s' if n > 1 else ''} · {_qty(units)} unité{'s' if units > 1 else ''}"
    )
    return y - 30


def render_prep_sheet(
    row: dict,
    *,
    printed_at: datetime,
    order_url: str | None,
    shop_name: str = "AITO3D",
    quantities: Mapping[str, float] | None = None,
    picklist_number: str = "",
) -> bytes:
    """The sheet of what to take off the shelf: everything packable, or the units of one picklist
    (``quantities``: units per line id)."""
    buf = io.BytesIO()
    c = _Canvas(buf, pagesize=A4)
    c.setTitle(f"Bon de préparation {row.get('number') or ''}")
    _sheet(c, row, printed_at, order_url, shop_name, quantities, picklist_number)
    c.save()
    return buf.getvalue()


def combine_picks(rows: list[dict], brands: Mapping[str, str]) -> list[dict]:
    """Every product the rows' sheets list to pick, once, by brand then SKU (no brand last): the total
    units and the units per order number. ``brands``: brand per item id."""
    out: dict[str, dict] = {}
    for row in rows:
        number = row.get("number") or ""
        for ln in row.get("lines") or []:
            q = ln.get("packable") or 0
            if q <= 0:
                continue
            item_id = ln.get("item_id") or ""
            p = out.setdefault(
                item_id or ln.get("sku") or ln.get("name") or "",
                {
                    "brand": brands.get(item_id) or "",
                    "sku": ln.get("sku") or "",
                    "name": ln.get("name") or "",
                    "quantity": 0.0,
                    "orders": {},
                },
            )
            p["quantity"] = round(p["quantity"] + q, 3)
            p["orders"][number] = round(p["orders"].get(number, 0) + q, 3)
    return sorted(
        out.values(), key=lambda p: (not p["brand"], p["brand"].casefold(), p["sku"].casefold(), p["name"].casefold())
    )


def _wrap(c: rl_canvas.Canvas, parts: list[str], font: str, size: float, width: float) -> list[str]:
    lines = [""]
    for part in parts:
        joined = f"{lines[-1]}, {part}" if lines[-1] else part
        if lines[-1] and c.stringWidth(joined, font, size) > width:
            lines.append(part)
        else:
            lines[-1] = joined
    return lines


def _combined(c: rl_canvas.Canvas, picks: list[dict], orders: int, printed_at: datetime, shop_name: str) -> None:
    count = {"number": f"{orders} commande{'s' if orders > 1 else ''}"}
    y = _table_head(c, _header(c, count, printed_at, shop_name, title="LISTE DE PRÉLÈVEMENT") - 22, last="")
    brand = None
    for p in picks:
        wants = _wrap(c, [f"{n} ×{_qty(q)}" for n, q in p["orders"].items()], "Helvetica", 8, _W - _M - _COLS[1])
        heading = 16 if p["brand"] != brand else 0
        if y - heading - _ROW_H - 11 * len(wants) < _BOTTOM:
            c.showPage()
            y = _table_head(c, _H - _M - 10, last="")
        if heading:
            brand = p["brand"]
            c.setFont("Helvetica-Bold", 9)
            _grey(c)
            c.drawString(_M, y - 13, brand or "Sans marque")
            _grey(c, False)
            y -= heading
        base = y - 16
        c.setLineWidth(1.2)
        c.rect(_M + 2, base - 2, 10, 10)
        c.setFont("Helvetica-Bold", 13)
        c.drawRightString(_COLS[1] - 8, base, _qty(p["quantity"]))
        c.setFont("Helvetica", 10)
        c.drawString(_COLS[1], base, _fit(c, p["name"], "Helvetica", 10, _COLS[2] - _COLS[1] - 8))
        c.setFont("Courier", 9)
        c.drawString(_COLS[2], base, _fit(c, p["sku"], "Courier", 9, _COLS[3] - _COLS[2]))
        c.setFont("Helvetica", 8)
        _grey(c)
        for i, want in enumerate(wants):
            c.drawString(_COLS[1], base - 11 * (i + 1), want)
        _grey(c, False)
        y -= _ROW_H + 11 * len(wants)
        c.setLineWidth(0.3)
        c.line(_M, y, _W - _M, y)
    _totals(c, len(picks), sum(p["quantity"] for p in picks), y)
    c.showPage()


def render_batch_prep_sheet(
    rows: list[dict],
    brands: Mapping[str, str],
    *,
    printed_at: datetime,
    order_urls: Mapping[str, str],
    shop_name: str = "AITO3D",
) -> bytes:
    """One document for a round of orders: the combined picking page, then each order's own prep sheet."""
    buf = io.BytesIO()
    c = _Canvas(buf, pagesize=A4)
    c.setTitle("Bons de préparation")
    _combined(c, combine_picks(rows, brands), len(rows), printed_at, shop_name)
    for row in rows:
        _sheet(c, row, printed_at, order_urls.get(row.get("id") or ""), shop_name)
    c.save()
    return buf.getvalue()
