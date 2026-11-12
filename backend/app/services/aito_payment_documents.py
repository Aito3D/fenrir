"""Which Zoho Books document a counter payment is for, verified against the
project it was requested from. Every payment route takes `(kind, document_id)`
from the browser and must not trust it: a quote id must be THIS project's
quote, an invoice id must be one Books raised from that quote."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.services.zoho import zoho_service

logger = logging.getLogger(__name__)


class DocumentMismatch(Exception):
    """The document is not this project's (or the kind is unknown)."""


@dataclass(frozen=True)
class PaymentDocument:
    kind: str
    id: str
    number: str
    customer_id: str
    balance: int | None


async def resolve_document(db: AsyncSession, project: AitoProject, kind: str, document_id: str) -> PaymentDocument:
    quote_id = project.quote_id or ""
    client_id = project.client_id or ""
    if not quote_id or not document_id:
        raise DocumentMismatch("This project has no Zoho quote")
    if kind == "quote":
        if document_id != quote_id:
            raise DocumentMismatch("That quote is not this project's")
        estimate = await zoho_service.get_estimate(db, quote_id)
        return PaymentDocument(
            kind="quote",
            id=quote_id,
            number=project.quote_number or "",
            customer_id=str(estimate.get("customer_id") or client_id),
            balance=None,
        )
    if kind == "invoice":
        invoices = await zoho_service.list_project_invoices(db, quote_id, client_id)
        if not any(str(i.get("id") or "") == document_id for i in invoices):
            raise DocumentMismatch("That invoice was not raised from this project's quote")
        raw = await zoho_service.get_invoice_raw(db, document_id)
        return PaymentDocument(
            kind="invoice",
            id=document_id,
            number=str(raw.get("invoice_number") or document_id),
            customer_id=str(raw.get("customer_id") or client_id),
            balance=int(round(float(raw.get("balance") or 0))),
        )
    raise DocumentMismatch(f"Unknown document kind {kind!r}")


# --- Order Board scope -------------------------------------------------------
# The two Heimdall ledgers also hold Order Board payments: such a row has
# `project_id = 0` and `salesorder_id` set. A ledger "scope" is either an Aito
# project id (int) or `("order", salesorder_id)`; every Aito lookup keeps
# `salesorder_id IS NULL`, so an order row never reaches a project's card.
Scope = int | tuple[str, str]


def scope_where(model, scope: Scope):
    """The ledger rows of one scope (`model` is either ledger class)."""
    if isinstance(scope, tuple):
        assert scope[0] == "order" and isinstance(scope[1], str), scope
        return model.salesorder_id == scope[1]
    return and_(model.project_id == scope, model.salesorder_id.is_(None))


def scope_columns(scope: Scope) -> dict:
    """`project_id` / `salesorder_id` for a new row of this scope."""
    if isinstance(scope, tuple):
        assert scope[0] == "order" and isinstance(scope[1], str), scope
        return {"project_id": 0, "salesorder_id": scope[1]}
    return {"project_id": scope, "salesorder_id": None}


async def resolve_order_document(db: AsyncSession, order_detail: dict, kind: str, document_id: str) -> PaymentDocument:
    """`resolve_document` for a stored sales order (`order_board_docs.detail`):
    an invoice must be one of the order's non-void invoices with something
    left to pay; a retainer must be one of its quote's `_retainers`; a quote
    must be the order's own, still open and for the same customer (Heimdall
    books a quote payment as a new retainer invoice on it)."""
    customer_id = str(order_detail.get("customer_id") or "")
    if not document_id:
        raise DocumentMismatch("No document given")
    if kind == "invoice":
        listed = next(
            (
                i
                for i in order_detail.get("invoices") or []
                if str(i.get("invoice_id") or "") == document_id and i.get("status") != "void"
            ),
            None,
        )
        if listed is None or _num(listed.get("balance")) <= 0:
            raise DocumentMismatch("That invoice is not an open invoice of this order")
        raw = await zoho_service.get_invoice_raw(db, document_id)
        balance = int(round(_num(raw.get("balance"))))
        if raw.get("status") == "void":
            raise DocumentMismatch("That invoice is void")
        if balance <= 0:
            raise DocumentMismatch("That invoice has nothing left to pay")
        return PaymentDocument(
            kind="invoice",
            id=document_id,
            number=str(raw.get("invoice_number") or listed.get("invoice_number") or document_id),
            customer_id=str(raw.get("customer_id") or customer_id),
            balance=balance,
        )
    if kind == "retainer":
        listed = next((r for r in order_detail.get("_retainers") or [] if str(r.get("id") or "") == document_id), None)
        if listed is None or listed.get("status") == "void":
            raise DocumentMismatch("That retainer is not one of this order's quote")
        if _num(listed.get("balance")) <= 0:
            raise DocumentMismatch("That retainer has nothing left to pay")
        # The stored row can be a sync behind: re-read it live, as the invoice branch does.
        raw = await zoho_service.get_retainer_raw(db, document_id)
        balance = int(round(_num(raw.get("balance"))))
        if raw.get("status") == "void":
            raise DocumentMismatch("That retainer is void")
        if balance <= 0:
            raise DocumentMismatch("That retainer has nothing left to pay")
        return PaymentDocument(
            kind="retainer",
            id=document_id,
            number=str(raw.get("retainerinvoice_number") or listed.get("number") or document_id),
            customer_id=str(raw.get("customer_id") or customer_id),
            balance=balance,
        )
    if kind == "quote":
        if document_id != str(order_detail.get("estimate_id") or ""):
            raise DocumentMismatch("That quote is not this order's")
        estimate = await zoho_service.get_estimate(db, document_id)
        status = str(estimate.get("status") or "")
        if status in _CLOSED_QUOTE:
            # Invoiced: collect on the invoice. Declined / void: Books takes no retainer on it.
            raise DocumentMismatch(f"That quote is {status}")
        quote_customer = str(estimate.get("customer_id") or "")
        if customer_id and quote_customer and quote_customer != customer_id:
            raise DocumentMismatch("That quote belongs to another customer")
        return PaymentDocument(
            kind="quote",
            id=document_id,
            number=str(estimate.get("estimate_number") or document_id),
            customer_id=quote_customer or customer_id,
            balance=None,
        )
    raise DocumentMismatch(f"Unknown document kind {kind!r}")


_CLOSED_QUOTE = frozenset({"invoiced", "declined", "void"})


def _num(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


async def record_order_payment(
    db: AsyncSession, salesorder_id: str, *, amount: int, method: str, since: datetime | None
) -> None:
    """The order's `payment.received` for one settled ledger row. Flushes only:
    the caller commits it with the settle (that commit is the once-only marker).

    Heimdall books the money in Books itself, so a board pass may already have
    recorded this payment (a board event: no `method`) after the row was created
    (`since`). Then the newest such event is annotated with `method` (its amount
    stays the board's) instead of telling the same payment twice."""
    from backend.app.models.order_board_event import OrderBoardEvent
    from backend.app.services import order_board_events

    if since is not None:
        stmt = (
            select(OrderBoardEvent)
            .where(
                OrderBoardEvent.salesorder_id == salesorder_id,
                OrderBoardEvent.kind == "payment.received",
                OrderBoardEvent.occurred_at > since,
            )
            .order_by(OrderBoardEvent.occurred_at.desc(), OrderBoardEvent.id.desc())
        )
        for event in (await db.execute(stmt)).scalars():
            if "method" not in (event.detail or {}):
                event.detail = {**(event.detail or {}), "method": method}  # a new dict: JSON change tracking
                await db.flush()
                return
    await order_board_events.record(
        db, salesorder_id, "payment.received", actor_class="system", detail={"amount": amount, "method": method}
    )


async def refresh_order_after_payment(db: AsyncSession, salesorder_id: str) -> None:
    """Best effort, after the settle committed: re-read the order so the board
    shows the money. `refresh_order` recomputes with the order quiet, so the
    board records no second `payment.received`. Never raises."""
    from backend.app.services import order_board_sync

    try:
        await order_board_sync.refresh_order(db, salesorder_id)
    except Exception as exc:  # noqa: BLE001 — the payment is settled; a stale board must not undo it
        logger.warning("order %s: refresh after a Heimdall payment failed: %s", salesorder_id, exc)
        await db.rollback()
