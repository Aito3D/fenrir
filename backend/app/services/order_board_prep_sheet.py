"""A4 prep sheet an operator prints to pick and pack an order (internal document)."""

import io
import unicodedata
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
        try:
            ch.encode("cp1252")
            out.append(ch)
            continue
        except UnicodeEncodeError:
            pass
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


def _header(c: rl_canvas.Canvas, row: dict, printed_at: datetime, shop_name: str) -> float:
    top = _H - _M
    c.setFont("Helvetica-Bold", 22)
    c.drawString(_M, top - 18, shop_name)
    c.setFont("Helvetica-Bold", 15)
    c.drawRightString(_W - _M, top - 14, "BON DE PRÉPARATION")
    c.setFont("Courier", 14)
    c.drawRightString(_W - _M, top - 32, row.get("number") or "")
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
    shopify = (facts.get("channel") or "").lower() == "shopify"
    infos = [("Commande du", _long_date(row.get("date") or ""))]
    if facts.get("reference"):
        infos.append(("Shopify" if shopify else "Devis", facts["reference"]))
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


def _table_head(c: rl_canvas.Canvas, y: float) -> float:
    c.setFont("Helvetica-Bold", 8)
    _grey(c)
    c.drawRightString(_COLS[1] - 8, y, "Qté")
    c.drawString(_COLS[1], y, "Produit")
    c.drawString(_COLS[2], y, "Référence")
    c.drawRightString(_COLS[3], y, "Commandé")
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


def render_prep_sheet(row: dict, *, printed_at: datetime, order_url: str | None, shop_name: str = "AITO3D") -> bytes:
    buf = io.BytesIO()
    c = _Canvas(buf, pagesize=A4)
    c.setTitle(f"Bon de préparation {row.get('number') or ''}")
    lines = row.get("lines") or []
    pick = [ln for ln in lines if (ln.get("packable") or 0) > 0]
    later = [
        (ln, (ln.get("remaining") or 0) - (ln.get("packed_waiting") or 0) - (ln.get("packable") or 0)) for ln in lines
    ]
    later = [(ln, q) for ln, q in later if round(q, 3) > 0]

    y = _table_head(c, _info(c, row, _header(c, row, printed_at, shop_name), order_url))
    for ln in pick:
        if y - _ROW_H < _BOTTOM + 40:
            c.showPage()
            y = _table_head(c, _H - _M - 10)
        base = y - 16
        c.setLineWidth(1.2)
        c.rect(_M + 2, base - 2, 10, 10)
        c.setFont("Helvetica-Bold", 13)
        c.drawRightString(_COLS[1] - 8, base, _qty(ln["packable"]))
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

    units = round(sum(ln["packable"] for ln in pick), 3)
    n = len(pick)
    c.setFont("Helvetica-Bold", 10)
    c.drawRightString(
        _W - _M, y - 16, f"{n} article{'s' if n > 1 else ''} · {_qty(units)} unité{'s' if units > 1 else ''}"
    )
    y -= 30

    if later:
        seg_top, seg_n = None, 0

        def close_segment() -> None:
            h = 22 + 14 * seg_n + 4
            c.setDash(3, 2)
            c.setLineWidth(0.8)
            c.roundRect(_M, seg_top - h, _W - 2 * _M, h, 3)
            c.setDash()

        for ln, q in later:
            if seg_top is None or seg_top - 22 - 14 * (seg_n + 1) < _BOTTOM:
                if seg_top is not None:
                    close_segment()
                if seg_top is not None or y - 36 < _BOTTOM:
                    c.showPage()
                    y = _H - _M
                seg_top, seg_n = y, 0
                c.setFont("Helvetica", 8)
                _grey(c)
                c.drawString(_M + 10, seg_top - 14, "Pas en stock, reste à livrer")
                _grey(c, False)
            yy = seg_top - 34 - 14 * seg_n
            c.setFont("Helvetica-Bold", 10)
            c.drawRightString(_M + 40, yy, _qty(q))
            c.setFont("Helvetica", 10)
            c.drawString(_M + 50, yy, _fit(c, ln.get("name") or "", "Helvetica", 10, _W - 2 * _M - 70))
            seg_n += 1
        close_segment()
        y = seg_top - (22 + 14 * seg_n + 4) - 18
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
    c.showPage()
    c.save()
    return buf.getvalue()
