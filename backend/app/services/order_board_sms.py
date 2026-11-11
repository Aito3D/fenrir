"""The pickup SMS of an order: a fixed template filled from the order, no AI.

The wording follows the Zoho "Nature du produit" of the lines (``cf_nature_du_produit``
on the stored item): only filaments, one printer with or without filaments, or
anything else. The text stays in the GSM-7 alphabet (straight apostrophes, plain
spaces, no "n°", no "ô") so that 160 characters cost one SMS.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services import order_board_actions as actions
from backend.app.services.aito_payment_links import current_link

FILAMENTS = "Filaments"
PRINTERS = "3D Printers"
SIGNATURE = "Aito3D"


def _amount(value: float, currency: str) -> str:
    # Plain spaces: a narrow no-break space is outside GSM-7 and would make the SMS cost double.
    digits = f"{round(value):,}".replace(",", " ")
    return f"{digits} {'FCFP' if currency in ('', 'XPF') else currency}"


def _goods(row: dict) -> list[dict]:
    """Lines that are products still on the order (not services, not fully cancelled)."""
    return [
        line
        for line in row["lines"]
        if line.get("item_id") and line["state"] != "service" and line["quantity"] > line.get("cancelled", 0)
    ]


def compose(row: dict, natures: dict[str, str], link_url: str | None = None) -> dict:
    """The draft for one board row. ``natures`` maps item id to its Zoho nature; ``link_url`` is the order's open
    payment link, if any."""
    goods = _goods(row)
    kinds = [natures.get(line["item_id"] or "", "") for line in goods]
    printers = [line for line, kind in zip(goods, kinds, strict=True) if kind == PRINTERS]
    if goods and all(k == FILAMENTS for k in kinds):
        kind = "filaments"
    elif len(printers) == 1 and printers[0]["quantity"] == 1 and all(k in (FILAMENTS, PRINTERS) for k in kinds):
        kind = "printer_filaments" if FILAMENTS in kinds else "printer"
    else:
        kind = "other"

    shopify = (row.get("facts") or {}).get("shopify_order") or ""
    reference = f"#{shopify}" if shopify else row["number"]
    partial = row["ready_ratio"] < 1
    if partial:
        opening = f"une partie de ta commande {reference} est disponible, le reste arrive prochainement"
        pronoun = "la"
    elif kind == "filaments":
        opening, pronoun = f"tes filaments de la commande {reference} sont disponibles", "les"
    elif kind == "printer_filaments":
        name = printers[0]["name"].replace(" - ", " ")
        opening, pronoun = f"ton imprimante {name} et tes filaments de la commande {reference} sont disponibles", "les"
    elif kind == "printer":
        name = printers[0]["name"].replace(" - ", " ")
        opening, pronoun = f"ton imprimante {name} de la commande {reference} est disponible", "la"
    else:
        opening, pronoun = f"ta commande {reference} est disponible", "la"

    due = ((row.get("payment") or {}).get("left")) or 0
    message = f"Ia Ora na, {opening}. Tu peux venir {pronoun} récupérer à notre boutique à Arue."
    if due > 0:
        message += f" Reste à régler : {_amount(due, row.get('currency') or '')}."
    if link_url:
        message += f"\nLien de paiement : {link_url}"
    return {"message": f"{message}\n{SIGNATURE}", "kind": kind, "partial": partial, "due": due}


async def draft(db: AsyncSession, salesorder_id: str) -> dict:
    """The draft for an order on the board; raises OrderNotOnBoard otherwise."""
    row = await actions._row(db, salesorder_id)
    ids = [line["item_id"] for line in _goods(row)]
    docs = (
        await db.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind == "item", OrderBoardDoc.zoho_id.in_(ids)))
    ).scalars()
    natures = {d.zoho_id: (d.header or {}).get("cf_nature_du_produit") or "" for d in docs}
    link = await current_link(db, ("order", salesorder_id), kind=None)
    live = link if link is not None and link.heimdall_id and link.status == "pending" and link.url else None
    out = compose(row, natures, live.url if live else None)
    out["payment_link"] = {"id": live.id, "url": live.url, "amount": live.amount} if live else None
    return out
