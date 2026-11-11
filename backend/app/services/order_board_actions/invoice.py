"""Invoice an order's shipped, packed or whole units in Books, apply the customer's credit, email an invoice."""

import logging
from collections.abc import Mapping
from datetime import date
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services import order_board_sync as sync
from backend.app.services.order_board import _ORDER_MONEY, _nonzero, units_to_invoice
from backend.app.services.order_board_actions._common import (
    _best_effort_refresh,
    _boxed,
    _log,
    _num,
    _on_account,
    _stored_order,
    _write,
    confirm_stored_copy,
    writing,
)
from backend.app.services.order_board_payment import _r
from backend.app.services.zoho import ZohoRateLimited, ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)


_PACKAGE_STATUSES = ("not_shipped", "shipped", "delivered")


_INVOICE_FIELDS = (
    "customer_id",
    "is_inclusive_tax",
    "discount",
    "discount_type",
    "is_discount_before_tax",
    "shipping_charge",
    "adjustment",
    "adjustment_description",
    "reference_number",
    "payment_terms",
    "payment_terms_label",
    "notes",
    "terms",
)


_LINE_FIELDS = (
    "salesorder_item_id",
    "item_id",
    "name",
    "description",
    "rate",
    "quantity",
    "unit",
    "tax_id",
    "discount",
)


def _offered(prefill: dict | None, keep: Mapping[str, float]) -> list[dict]:
    """The prefill's lines this invoice may bill; a kept line Books does not offer is not invoiceable."""
    return [line for line in (prefill or {}).get("line_items") or [] if line.get("salesorder_item_id") in keep]


def _is_amount(discount) -> bool:
    """A line discount that is a fixed amount ("10.00%" is a percentage, a bare number an amount)."""
    return _nonzero(discount) and not str(discount).strip().endswith("%")


def invoice_payload(prefill: dict, keep: Mapping[str, float], today: str) -> tuple[dict | None, str | None]:
    """Books' own prefill restricted to ``keep`` (units per order line), never above what it offers.

    Returns ``(body, None)``; ``(None, None)`` when no line is left; ``(None, reason)`` when Books has to do it:
    "order_money" (order-level money a partial invoice would split), "line_discount" (a fixed-amount line discount
    on a reduced line).
    """
    lines, reduced = [], False
    for line in _offered(prefill, keep):
        offered = _num(line.get("quantity"))
        quantity = min(_num(keep[line["salesorder_item_id"]]), offered)
        if quantity <= 0:
            continue
        if quantity < offered:
            reduced = True
            if _is_amount(line.get("discount")):
                return None, "line_discount"
        lines.append({**{k: line[k] for k in _LINE_FIELDS if line.get(k) not in (None, "")}, "quantity": quantity})
    if not lines:
        return None, None
    sent = {line["salesorder_item_id"] for line in lines}
    dropped = any(
        raw.get("salesorder_item_id") not in sent
        for raw in prefill.get("line_items") or []
        if _num(raw.get("quantity")) > 0
    )
    if (reduced or dropped) and any(_nonzero(prefill.get(k)) for k in _ORDER_MONEY):
        return None, "order_money"
    head = {k: prefill[k] for k in _INVOICE_FIELDS if prefill.get(k) not in (None, "")}
    return {**head, "date": today, "line_items": lines}, None


def _service_line_ids(order: dict) -> set[str]:
    """Lines billable before they ship, from the raw order alone (the board's "service" state also covers
    untracked physical goods, which must wait for their parcel)."""
    return {
        line.get("line_item_id") or ""
        for line in order.get("line_items") or []
        if line.get("product_type") == "service"
    }


InvoiceScope = Literal["shipped", "packed", "whole"]


async def _unshipped_boxes(db: AsyncSession, order: dict) -> dict[str, float]:
    """Units per order line in the parcels still waiting to go out (Books' order detail does not say which line is
    in which parcel, so each one is read)."""
    result: dict[str, float] = {}
    for stored in order.get("packages") or []:
        if stored.get("status") != "not_shipped" or not stored.get("package_id"):
            continue
        package = await zoho_service.get_package(db, stored["package_id"])
        if package.get("status") not in _PACKAGE_STATUSES:
            raise ValueError("unexpected package status")
        if package.get("status") == "not_shipped":  # a shipped parcel is already in quantity_shipped
            for line_id, units in _boxed(package).items():
                result[line_id] = result.get(line_id, 0.0) + units
    return result


async def _scope_units(db: AsyncSession, order: dict, scope: InvoiceScope) -> dict[str, float]:
    """Units per order line an invoice of ``scope`` bills: what left, plus what is packed, or the whole order."""
    if scope == "whole":
        return units_to_invoice(
            order, service_line_ids={line.get("line_item_id") or "" for line in order.get("line_items") or []}
        )
    extra = await _unshipped_boxes(db, order) if scope == "packed" else None
    return units_to_invoice(order, extra_shipped=extra, service_line_ids=_service_line_ids(order))


def _printed_total(payload: dict | None) -> float | None:
    """The total Books would print for this body, only when it is plain: tax included, no discount and no
    order-level money to add."""
    if (
        payload
        and payload.get("is_inclusive_tax")
        and not any(_nonzero(line.get("discount")) for line in payload["line_items"])
        and not any(_nonzero(payload.get(k)) for k in _ORDER_MONEY)
    ):
        return round(sum(_num(line.get("rate")) * line["quantity"] for line in payload["line_items"]), 2)
    return None


def _drafts(order: dict) -> list[str]:
    # Books may not count a draft in quantity_invoiced (unverified): a draft on the order blocks a second invoice.
    return [i.get("invoice_number") or "" for i in order.get("invoices") or [] if i.get("status") == "draft"]


def _outcome(package_number: str = "") -> dict:
    return {
        "package_number": package_number,
        "shipment": "skipped",
        "delivered": "skipped",
        "invoice": "none",
        "invoice_number": None,
        "manual_reason": None,
        "credit_applied": 0.0,
        "failed_step": None,
        "error": None,
    }


async def _credit(db: AsyncSession, salesorder_id: str, number: str, invoice: dict, customer_id: str, cap: float):
    """Apply the customer's unused payments up to ``cap``: the order's own retainers first (the board counts them as
    this order's payment), then the rest oldest first. Returns the amount applied."""
    own = {str(r.get("id") or "") for r in (await _stored_order(db, salesorder_id)).get("_retainers") or []}
    own.discard("")
    payments = await zoho_service.list_customer_payments(db, customer_id)
    applied, left = [], round(cap, 2)
    ranked = sorted(payments, key=lambda p: (str(p.get("retainerinvoice_id") or "") not in own, p.get("date") or ""))
    for payment in ranked:
        amount = round(min(_num(payment.get("unused_amount")), left), 2)
        if amount > 0 and payment.get("payment_id"):
            applied.append({"payment_id": payment["payment_id"], "amount_applied": amount})
            left = round(left - amount, 2)
    if not applied:
        return 0.0
    await _write(
        salesorder_id, number, "credit", zoho_service.apply_invoice_credits(db, invoice["invoice_id"], applied)
    )
    return round(sum(p["amount_applied"] for p in applied), 2)


async def _finish(
    db: AsyncSession,
    salesorder_id: str,
    number: str,
    outcome: dict,
    *,
    row: dict | None,
    deliver: str | None,
    apply_credit: bool,
    scope: InvoiceScope = "shipped",
    by: str | None = None,
) -> dict:
    """Steps 2 to 6 of a hand-over (``deliver`` is the shipment to mark delivered). Never raises: a failure stops
    the sequence and is reported in the outcome. ``row`` is the board row read before the first write."""
    advance = _on_account(row)
    step = "delivered"
    try:
        if deliver is not None:
            if not deliver:
                raise ZohoUpstreamError("Books returned no shipment id")
            await _write(salesorder_id, number, step, zoho_service.mark_shipment_delivered(db, deliver))
            outcome["delivered"] = "done"
        step = "invoice"
        fresh = await zoho_service.get_salesorder(db, salesorder_id)
        keep = await _scope_units(db, fresh, scope)
        if not keep:
            return outcome
        drafts = _drafts(fresh)
        if drafts:
            outcome.update(invoice="manual", manual_reason="draft", invoice_number=drafts[0])
            return outcome
        prefill = await zoho_service.invoice_prefill(db, salesorder_id)
        if prefill is None:  # units are owed an invoice, so Books' refusal is not "nothing to invoice"
            raise ZohoUpstreamError("prefill_refused")
        payload, reason = invoice_payload(prefill, keep, date.today().isoformat())
        if payload is None:
            if reason:
                outcome.update(invoice="manual", manual_reason=reason)
            return outcome
        invoice = await _write(salesorder_id, number, step, zoho_service.create_invoice(db, payload))
        outcome.update(invoice="draft", invoice_number=invoice.get("invoice_number"))
        step = "sent"
        if not invoice.get("invoice_id"):
            raise ZohoUpstreamError("Books returned no invoice id")
        await _write(salesorder_id, number, step, zoho_service.mark_invoice_sent(db, invoice["invoice_id"]))
        outcome["invoice"] = "created"
        if apply_credit and row is None:  # no board row, no advance to cap the credit by
            outcome.update(failed_step="credit", error="credit_off_board")
        elif apply_credit and advance > 0:
            step = "credit"
            balance = invoice.get("balance") if invoice.get("balance") is not None else invoice.get("total")
            cap = min(_num(balance), advance)
            outcome["credit_applied"] = await _credit(
                db, salesorder_id, number, invoice, fresh.get("customer_id") or "", cap
            )
    except Exception as e:  # after a write nothing may raise: the operator needs to see what was done
        if isinstance(e, ZohoRateLimited):
            sync.open_rate_limit_window(e)
        if step == "invoice":
            outcome["invoice"] = "failed"
        outcome.update(failed_step=step, error=str(e)[:300])
    finally:
        if outcome["invoice"] in ("draft", "created"):  # the invoice exists in Books whatever the credit step did
            await _log(
                db,
                salesorder_id,
                "invoice.created",
                by,
                invoice=outcome["invoice_number"],
                total=invoice.get("total"),
                credit_applied=outcome["credit_applied"],
                scope=scope,
            )
        await _best_effort_refresh(db, salesorder_id, number)
    return outcome


async def invoice_shipped(
    db: AsyncSession, salesorder_id: str, *, apply_credit: bool, scope: InvoiceScope = "shipped", by: str | None = None
) -> dict:
    """Invoice what is not invoiced yet, for any stored order (a finished one has no board row): what is shipped,
    also what is packed (before the hand-over, which then invoices nothing more), or the whole order."""
    with writing(salesorder_id):
        doc = await confirm_stored_copy(db, salesorder_id)
        row = await sync.find_board_row(db, salesorder_id)
        number = doc.header.get("salesorder_number") or ""
        return await _finish(
            db, salesorder_id, number, _outcome(), row=row, deliver=None, apply_credit=apply_credit, scope=scope, by=by
        )


async def invoice_preview(db: AsyncSession, salesorder_id: str) -> dict:
    """What an invoice made now would bill, for what is packed and for the whole order, from the stored order and
    Books' own prefill. Reads only. ``credit`` is the advance a hand-over would apply, capped by each total."""
    order = await _stored_order(db, salesorder_id)
    row = await sync.find_board_row(db, salesorder_id)
    empty = {"units": 0.0, "invoice_total": None, "manual_reason": None}
    result = {
        "available": False,
        "credit": _on_account(row),
        "drafts": [],
        "packed": dict(empty),
        "whole": dict(empty),
    }
    if sync.zoho_busy():
        return result
    try:
        keeps = {scope: await _scope_units(db, order, scope) for scope in ("packed", "whole")}
        drafts = _drafts(order)
        prefill = await zoho_service.invoice_prefill(db, salesorder_id) if keeps["whole"] and not drafts else None
        if keeps["whole"] and not drafts and prefill is None:
            return result  # Books refused although units are owed an invoice: unknown, not "nothing to invoice"
        today = date.today().isoformat()
        for scope, keep in keeps.items():
            payload, reason = invoice_payload(prefill or {}, keep, today) if keep and prefill else (None, None)
            result[scope] = {
                "units": _r(sum(keep.values())) if payload or reason else 0.0,
                "invoice_total": _printed_total(payload),
                "manual_reason": reason,
            }
    except (ZohoUpstreamError, AttributeError, KeyError, TypeError, ValueError) as e:  # a malformed Books answer
        if isinstance(e, ZohoRateLimited):
            sync.open_rate_limit_window(e)
        return result
    result.update(available=True, drafts=drafts)
    return result


async def email_invoice(
    db: AsyncSession,
    salesorder_id: str,
    number: str,
    invoice_id: str,
    to: str,
    *,
    by: str | None = None,
    invoice_number: str = "",
) -> None:
    """Email one of the order's invoices through Books, then re-read the order: Books marks a draft invoice sent."""
    with writing(salesorder_id):
        logger.info("Order board write: order=%s step=invoice_email", number)
        await zoho_service.email_invoice(db, invoice_id, to_mail_ids=[to])
        await _log(db, salesorder_id, "invoice.emailed", by, invoice=invoice_number or invoice_id, to=to)
        await _best_effort_refresh(db, salesorder_id, number)
