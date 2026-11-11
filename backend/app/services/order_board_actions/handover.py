"""Hand a parcel over: shipment, delivered on a pick-up, then the invoice steps."""

from datetime import date
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services import order_board_sync as sync
from backend.app.services.order_board import units_to_invoice
from backend.app.services.order_board_actions._common import (
    OrderActionRefused,
    OrderNotOnBoard,
    _best_effort_refresh,
    _log,
    _num,
    _on_account,
    _stored_order,
    _write,
    confirm_stored_copy,
    writing,
)
from backend.app.services.order_board_actions.invoice import (
    _PACKAGE_STATUSES,
    _drafts,
    _finish,
    _outcome,
    _printed_total,
    _service_line_ids,
    invoice_payload,
)
from backend.app.services.zoho import ZohoNotFound, ZohoRateLimited, ZohoUpstreamError, zoho_service


def _delivery_method(mode: str, order: dict) -> str:
    if mode == "pickup":
        return "PICK UP"
    own = (order.get("delivery_method") or "").strip()
    return own if own and own.casefold() != "pick up" else "Aito3D"


async def hand_over(
    db: AsyncSession,
    salesorder_id: str,
    package_id: str,
    *,
    mode: Literal["pickup", "delivery"],
    apply_credit: bool,
    by: str | None = None,
) -> dict:
    """Ship a parcel, mark it delivered on a pick-up, invoice what is shipped and apply the customer's credit.

    Every step whose result Books already shows is skipped, so the same request repeated finishes the job.
    """
    with writing(salesorder_id):
        doc = await confirm_stored_copy(db, salesorder_id)
        order = doc.detail or {}
        number = doc.header.get("salesorder_number") or ""
        row = await sync.find_board_row(db, salesorder_id)  # read now: the shipment may take it off the board
        try:
            package = await zoho_service.get_package(db, package_id)
        except ZohoNotFound as e:
            raise OrderActionRefused("unknown_package") from e
        except ZohoRateLimited as e:
            sync.open_rate_limit_window(e)
            raise
        if package.get("salesorder_id") != salesorder_id:
            raise OrderActionRefused("unknown_package")
        status = package.get("status")
        if status not in _PACKAGE_STATUSES:
            raise ZohoUpstreamError("unexpected package status")  # never guess "already shipped"
        # A new shipment needs the order on the board; a retry may find it gone after its last parcel shipped.
        if row is None and status == "not_shipped":
            raise OrderNotOnBoard(salesorder_id)
        outcome = _outcome(package.get("package_number") or "")
        shipment_id = package.get("shipment_id") or next(
            (p.get("shipment_id") or "" for p in order.get("packages") or [] if p.get("package_id") == package_id), ""
        )
        if status == "not_shipped":
            try:
                shipment = await _write(
                    salesorder_id,
                    number,
                    "shipment",
                    zoho_service.create_shipment(
                        db,
                        salesorder_id,
                        package_id,
                        date=date.today().isoformat(),
                        delivery_method=_delivery_method(mode, order),
                    ),
                )
            except ZohoUpstreamError:
                await _best_effort_refresh(db, salesorder_id, number)  # a timeout can mean it went through
                raise
            shipment_id = shipment.get("shipment_id") or ""
            outcome["shipment"] = "done"
            await _log(
                db,
                salesorder_id,
                "handover.delivered" if mode == "pickup" else "handover.shipped",
                by,
                package=outcome["package_number"],
            )
        deliver = shipment_id if mode == "pickup" and status != "delivered" else None
        return await _finish(
            db, salesorder_id, number, outcome, row=row, deliver=deliver, apply_credit=apply_credit, by=by
        )


async def handover_preview(db: AsyncSession, salesorder_id: str, package_id: str) -> dict:
    """What a hand-over of this parcel would do, from the stored order and Books' own prefill. Reads only."""
    order = await _stored_order(db, salesorder_id)
    stored = next((p for p in order.get("packages") or [] if p.get("package_id") == package_id), None)
    if stored is None:
        raise OrderActionRefused("unknown_package")
    result = {
        "units": _num(stored.get("quantity")),
        "available": False,
        "to_invoice": False,
        "invoice_total": None,
        "manual": False,
        "manual_reason": None,
        "credit": 0.0,
        "covered_by": [],
    }
    if sync.zoho_busy():
        return result
    row = await sync.find_board_row(db, salesorder_id)
    try:
        package = await zoho_service.get_package(db, package_id)
        status = package.get("status")
        if status not in _PACKAGE_STATUSES:
            raise ValueError("unexpected package status")
        boxed: dict[str, float] = {}
        if status == "not_shipped":  # a shipped parcel is already in quantity_shipped
            for line in package.get("line_items") or []:
                line_id = line.get("so_line_item_id") or ""
                boxed[line_id] = boxed.get(line_id, 0.0) + _num(line.get("quantity"))
        keep = units_to_invoice(order, extra_shipped=boxed, service_line_ids=_service_line_ids(order))
        drafts = _drafts(order) if keep else []
        prefill = await zoho_service.invoice_prefill(db, salesorder_id) if keep and not drafts else None
        if keep and not drafts and prefill is None:
            return result  # Books refused although units are owed an invoice: unknown, not "already invoiced"
        payload, reason = invoice_payload(prefill or {}, keep, date.today().isoformat())
    except (ZohoUpstreamError, AttributeError, KeyError, TypeError, ValueError) as e:  # a malformed Books answer
        if isinstance(e, ZohoRateLimited):
            sync.open_rate_limit_window(e)
        return result
    result["available"] = True
    if drafts:
        result.update(manual=True, manual_reason="draft", covered_by=drafts)
        return result
    if payload is None and reason is None:
        result["covered_by"] = [
            i.get("invoice_number") or "" for i in order.get("invoices") or [] if i.get("status") != "void"
        ]
        return result
    result.update(to_invoice=True, manual=payload is None, manual_reason=reason)
    total = _printed_total(payload)
    if total is not None:
        result["invoice_total"] = total
        result["credit"] = min(total, _on_account(row))
    return result
