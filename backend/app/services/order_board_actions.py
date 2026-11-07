"""The Order Board's writes towards Books: print stamp, picklist, parcel, hand-over, invoice, credit and invoice email."""

import contextlib
import logging
import math
from collections.abc import Mapping
from contextlib import contextmanager
from datetime import date
from typing import Literal

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services import order_board_sync as sync
from backend.app.services.order_board import _ORDER_MONEY, _nonzero, picked_waiting, units_to_invoice
from backend.app.services.zoho import (
    ZohoNotFound,
    ZohoRateLimited,
    ZohoRequestRejected,
    ZohoUpstreamError,
    zoho_service,
)

logger = logging.getLogger(__name__)

_writing: set[str] = set()


class OrderNotOnBoard(Exception):
    """The order has no row on the stored board."""


class OrderBusy(Exception):
    """Another write on this order is still running."""


class OrderActionRefused(Exception):
    """args[0] is one of "nothing_to_pack", "unknown_line", "too_many", "bad_quantity", "unknown_package",
    "picklist_open", "unknown_picklist", "picklist_shared", and from an order edit "version", "service_line",
    "below_floor", "unknown_item", "nothing_changed", and from a parcel edit "package_shipped", "package_changed"."""


@contextmanager
def writing(salesorder_id: str):
    if salesorder_id in _writing:
        raise OrderBusy(salesorder_id)
    _writing.add(salesorder_id)
    try:
        yield
    finally:
        _writing.discard(salesorder_id)


def _prep_query(salesorder_id: str):
    return select(OrderBoardDoc).where(OrderBoardDoc.kind == "prep", OrderBoardDoc.zoho_id == salesorder_id)


async def _row(db: AsyncSession, salesorder_id: str) -> dict:
    row = await sync.find_board_row(db, salesorder_id)
    if row is None:
        raise OrderNotOnBoard(salesorder_id)
    return row


def _stored_query(salesorder_id: str):
    return (
        select(OrderBoardDoc)
        .where(OrderBoardDoc.kind == "salesorder", OrderBoardDoc.zoho_id == salesorder_id)
        .execution_options(populate_existing=True)
    )


async def confirm_stored_copy(db: AsyncSession, salesorder_id: str) -> OrderBoardDoc:
    """Entry check of every Books write, inside the writer lock: an order whose last write was never confirmed
    by a re-read, or whose stored copy is pending (that flag survives a restart), is re-read first, and a failure
    here stops the action before anything is sent. Returns the stored order."""
    if sync.zoho_busy():
        raise sync.ZohoBusy(salesorder_id)
    doc = (await db.execute(_stored_query(salesorder_id))).scalar_one_or_none()
    if doc is None:
        raise OrderNotOnBoard(salesorder_id)
    if doc.pending or sync.needs_refresh(salesorder_id):
        try:
            await sync.refresh_order(db, salesorder_id)
        except sync.OrderNotStored as e:
            raise OrderNotOnBoard(salesorder_id) from e
        except ZohoRateLimited as e:
            sync.open_rate_limit_window(e)
            raise sync.ZohoBusy(salesorder_id) from e
    return doc


async def stamp_print(db: AsyncSession, salesorder_id: str, by: str) -> dict:
    await _row(db, salesorder_id)
    stamp = {"at": sync._now(), "by": by}
    doc = (await db.execute(_prep_query(salesorder_id))).scalar_one_or_none()
    if doc is None:
        db.add(OrderBoardDoc(kind="prep", zoho_id=salesorder_id, header=stamp))
    else:
        doc.header = stamp
    try:
        await db.commit()
    except IntegrityError:  # a simultaneous first stamp won the unique key: update theirs
        await db.rollback()
        doc = (await db.execute(_prep_query(salesorder_id))).scalar_one()
        doc.header = stamp
        await db.commit()
    return await _row(db, salesorder_id)


async def _best_effort_refresh(db: AsyncSession, salesorder_id: str, number: str) -> None:
    try:
        await sync.refresh_order(db, salesorder_id)
    except Exception as e:
        logger.warning("Order board: re-read after a write failed for %s (%s)", number, type(e).__name__)
        try:  # the next pass, and the next write, re-read it
            await db.rollback()
            doc = (await db.execute(_stored_query(salesorder_id))).scalar_one_or_none()
            if doc is not None:
                doc.pending = True
                await db.commit()
        except Exception:
            with contextlib.suppress(Exception):
                await db.rollback()


def _num(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


async def _write(salesorder_id: str, number: str, step: str, call):
    """One Books write: logged, and fenced so that no sync pass stores a copy fetched while it ran."""
    logger.info("Order board write: order=%s step=%s", number, step)
    sync.note_write(salesorder_id)
    try:
        return await call
    except ZohoRateLimited as e:
        sync.open_rate_limit_window(e)
        raise
    finally:
        sync.note_write(salesorder_id)


# --- Picklist, parcel ------------------------------------------------------------------------------------------


def _wanted(quantities: Mapping[str, float]) -> dict[str, float]:
    if any(not math.isfinite(q) or q < 0 for q in quantities.values()):
        raise OrderActionRefused("bad_quantity")
    wanted = {line_id: q for line_id, q in quantities.items() if q > 0}
    if not wanted:
        raise OrderActionRefused("nothing_to_pack")
    return wanted


def _within(wanted: Mapping[str, float], allowed: Mapping[str, float], known: set[str]) -> None:
    if any(line_id not in known for line_id in wanted):
        raise OrderActionRefused("unknown_line")
    if any(q > allowed.get(line_id, 0.0) + 1e-9 for line_id, q in wanted.items()):
        raise OrderActionRefused("too_many")


def _open_picklists(order: dict) -> list[dict]:
    return [p for p in order.get("picklists") or [] if p.get("status") != "completed"]


async def _stored_order(db: AsyncSession, salesorder_id: str) -> dict:
    doc = (await db.execute(_stored_query(salesorder_id))).scalar_one_or_none()
    if doc is None or not doc.detail:
        raise OrderNotOnBoard(salesorder_id)
    return doc.detail


async def _reread(db: AsyncSession, salesorder_id: str) -> dict:
    """The order as Books has it now, stored and returned: an edit compares and validates against this."""
    try:
        await sync.refresh_order(db, salesorder_id)
    except sync.OrderNotStored as e:
        raise OrderNotOnBoard(salesorder_id) from e
    except ZohoRateLimited as e:
        sync.open_rate_limit_window(e)
        raise sync.ZohoBusy(salesorder_id) from e
    return await _stored_order(db, salesorder_id)


async def _pickable(db: AsyncSession, salesorder_id: str, row: dict, order: dict) -> tuple[dict, dict[str, float]]:
    """Books' own picklist draft for the order and, per line, what a new picklist may hold: what Books still
    offers (units already on a picklist are not), never above what the shelf covers once the units picked and
    not boxed yet are set aside."""
    try:
        prefill = await zoho_service.picklist_prefill(db, salesorder_id) or {}
    except ZohoRateLimited as e:
        sync.open_rate_limit_window(e)
        raise sync.ZohoBusy(salesorder_id) from e
    shelf = {line["id"]: line["packable"] for line in row["lines"]}
    held = picked_waiting(order)
    books: dict[str, float] = {}
    for line in prefill.get("line_items") or []:
        if line.get("salesorder_id") == salesorder_id and line.get("so_line_item_id"):
            line_id = line["so_line_item_id"]
            books[line_id] = books.get(line_id, 0.0) + _num(line.get("quantity_to_be_picked"))
    offered = {
        line_id: round(min(units, shelf.get(line_id, 0.0) - held.get(line_id, 0.0)), 6)
        for line_id, units in books.items()
    }
    return prefill, {line_id: units for line_id, units in offered.items() if units > 0}


def _lines(units: Mapping[str, float]) -> list[dict]:
    return [{"line_id": line_id, "quantity": q} for line_id, q in units.items()]


async def picklist_preview(db: AsyncSession, salesorder_id: str) -> dict:
    """What a new picklist of this order may hold. Reads only."""
    order = await _stored_order(db, salesorder_id)
    row = await _row(db, salesorder_id)
    if _open_picklists(order):
        raise OrderActionRefused("picklist_open")
    if sync.zoho_busy():
        raise sync.ZohoBusy(salesorder_id)
    return {"lines": _lines((await _pickable(db, salesorder_id, row, order))[1])}


async def create_picklist(db: AsyncSession, salesorder_id: str, quantities: dict[str, float]) -> dict:
    """Create a picklist in Books for the given line quantities; returns its ``id`` and ``number``."""
    with writing(salesorder_id):
        doc = await confirm_stored_copy(db, salesorder_id)
        row = await _row(db, salesorder_id)
        number = row.get("number") or ""
        wanted = _wanted(quantities)
        # One at a time: what an open picklist holds is not on the stored order, so the shelf could not be shared.
        if _open_picklists(doc.detail or {}):
            raise OrderActionRefused("picklist_open")
        prefill, offered = await _pickable(db, salesorder_id, row, doc.detail or {})
        _within(wanted, offered, {line["id"] for line in row["lines"]})
        body = {
            "date": date.today().isoformat(),
            "location_id": prefill.get("location_id"),
            "parent_entity": "salesorder",
            "group_by": "none",
            "line_items": [
                {
                    "salesorder_id": salesorder_id,
                    "so_line_item_id": line_id,
                    "quantity_to_be_picked": q,
                    "quantity_picked": 0,
                }
                for line_id, q in wanted.items()
            ],
        }
        try:
            picklist = await _write(salesorder_id, number, "picklist", zoho_service.create_picklist(db, body))
        except ZohoUpstreamError:
            await _best_effort_refresh(db, salesorder_id, number)  # a timeout can mean Books did create it
            raise
        await _best_effort_refresh(db, salesorder_id, number)
    return {"id": picklist.get("picklist_id") or "", "number": picklist.get("picklist_number") or ""}


async def _picklist(db: AsyncSession, order: dict, picklist_id: str) -> dict:
    """A picklist of this order, as Books has it now."""
    if not any(p.get("picklist_id") == picklist_id for p in order.get("picklists") or []):
        raise OrderActionRefused("unknown_picklist")
    try:
        return await zoho_service.get_picklist(db, picklist_id)
    except ZohoNotFound as e:
        raise OrderActionRefused("unknown_picklist") from e
    except ZohoRateLimited as e:
        sync.open_rate_limit_window(e)
        raise sync.ZohoBusy(picklist_id) from e


def _to_box(picklist: dict, salesorder_id: str) -> dict[str, tuple[float, float, str]]:
    """Per order line of a picklist: the units no parcel holds yet, the units already boxed, and the picklist
    row id. A completed picklist counts what was picked, an open one what is to be picked. A picklist that also
    holds another order, or two rows for one line, is left to Books ("picklist_shared")."""
    done = picklist.get("status") == "completed"
    result: dict[str, tuple[float, float, str]] = {}
    for line in picklist.get("line_items") or []:
        if line.get("salesorder_id") != salesorder_id or line.get("so_line_item_id") in result:
            raise OrderActionRefused("picklist_shared")  # cutting it down here would touch rows it cannot tell apart
        boxed = _num(line.get("quantity_packed"))
        units = round(_num(line.get("quantity_picked" if done else "quantity_to_be_picked")) - boxed, 6)
        if line.get("so_line_item_id") and line.get("line_item_id"):
            result[line["so_line_item_id"]] = (max(0.0, units), boxed, line["line_item_id"])
    return result


async def picklist_content(db: AsyncSession, salesorder_id: str, picklist_id: str) -> dict:
    """What a parcel made from this picklist may hold. Reads only."""
    order = await _stored_order(db, salesorder_id)
    if sync.zoho_busy():
        raise sync.ZohoBusy(salesorder_id)
    picklist = await _picklist(db, order, picklist_id)
    return {
        "id": picklist_id,
        "number": picklist.get("picklist_number") or "",
        "status": picklist.get("status") or "",
        "lines": _lines(
            {line_id: units for line_id, (units, _, _) in _to_box(picklist, salesorder_id).items() if units > 0}
        ),
    }


async def create_parcel(db: AsyncSession, salesorder_id: str, picklist_id: str, quantities: dict[str, float]) -> str:
    """Box what was picked; returns Books' package number.

    The picklist is cut down to the confirmed quantities and completed, then its package is created. A step whose
    result Books already shows is skipped, so the same request repeated finishes the job.
    """
    with writing(salesorder_id):
        doc = await confirm_stored_copy(db, salesorder_id)
        row = await _row(db, salesorder_id)
        number = row.get("number") or ""
        wanted = _wanted(quantities)
        picklist = await _picklist(db, doc.detail or {}, picklist_id)
        on_list = _to_box(picklist, salesorder_id)
        done = picklist.get("status") == "completed"
        # Never more than the order still has to box; and for a completed picklist never more than the order
        # counts as picked and not boxed, so a parcel Books created without telling the picklist is not repeated.
        unboxed = {line["id"]: line["remaining"] - line["packed_waiting"] for line in row["lines"]}
        held = picked_waiting(doc.detail or {})
        allowed = {
            line_id: min(units, unboxed.get(line_id, 0.0), held.get(line_id, 0.0) if done else units)
            for line_id, (units, _, _) in on_list.items()
        }
        _within(wanted, allowed, set(on_list))
        try:
            if not done:
                body = {
                    "date": picklist.get("date") or date.today().isoformat(),
                    "location_id": picklist.get("location_id"),
                    "group_by": picklist.get("group_by"),
                    # Books removes the rows left out: the picklist becomes exactly what was picked
                    # (a row with units already in a parcel stays, at those units).
                    "line_items": [
                        {
                            "line_item_id": row_id,
                            "quantity_to_be_picked": boxed + wanted.get(line_id, 0.0),
                            "quantity_picked": boxed + wanted.get(line_id, 0.0),
                        }
                        for line_id, (_, boxed, row_id) in on_list.items()
                        if boxed + wanted.get(line_id, 0.0) > 0
                    ],
                }
                updated = await _write(
                    salesorder_id,
                    number,
                    "picklist_picked",
                    zoho_service.update_picklist(db, picklist_id, {k: v for k, v in body.items() if v}),
                )
                if updated.get("status") != "completed":
                    await _write(
                        salesorder_id, number, "picklist_completed", zoho_service.complete_picklist(db, picklist_id)
                    )
            package = await _write(
                salesorder_id,
                number,
                "parcel",
                zoho_service.create_package(
                    db,
                    salesorder_id,
                    date=date.today().isoformat(),
                    line_items=[
                        {"so_line_item_id": line_id, "quantity": q, "picklist_item_id": on_list[line_id][2]}
                        for line_id, q in wanted.items()
                    ],
                ),
            )
        except ZohoUpstreamError:
            # A timeout can mean Books did it: look once, keep the original error.
            await _best_effort_refresh(db, salesorder_id, number)
            raise
        # The parcel exists in Books: nothing below may turn that into an error.
        try:
            await db.execute(
                delete(OrderBoardDoc).where(OrderBoardDoc.kind == "prep", OrderBoardDoc.zoho_id == salesorder_id)
            )
            await db.commit()
        except Exception as e:
            logger.warning("Order board: bookkeeping after a parcel failed for %s (%s)", number, type(e).__name__)
            await db.rollback()
        await _best_effort_refresh(db, salesorder_id, number)
    return package.get("package_number") or ""


# --- Hand-over, invoice, credit --------------------------------------------------------------------------------

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


def _drafts(order: dict) -> list[str]:
    # Books may not count a draft in quantity_invoiced (unverified): a draft on the order blocks a second invoice.
    return [i.get("invoice_number") or "" for i in order.get("invoices") or [] if i.get("status") == "draft"]


def _delivery_method(mode: str, order: dict) -> str:
    if mode == "pickup":
        return "PICK UP"
    own = (order.get("delivery_method") or "").strip()
    return own if own and own.casefold() != "pick up" else "Aito3D"


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
    """Apply the customer's unused payments, oldest first, up to ``cap``; returns the amount applied."""
    payments = await zoho_service.list_customer_payments(db, customer_id)
    applied, left = [], round(cap, 2)
    for payment in sorted(payments, key=lambda p: p.get("date") or ""):
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
) -> dict:
    """Steps 2 to 6 of a hand-over (``deliver`` is the shipment to mark delivered). Never raises: a failure stops
    the sequence and is reported in the outcome. ``row`` is the board row read before the first write."""
    advance = _num(((row or {}).get("payment") or {}).get("advance"))
    step = "delivered"
    try:
        if deliver is not None:
            if not deliver:
                raise ZohoUpstreamError("Books returned no shipment id")
            await _write(salesorder_id, number, step, zoho_service.mark_shipment_delivered(db, deliver))
            outcome["delivered"] = "done"
        step = "invoice"
        fresh = await zoho_service.get_salesorder(db, salesorder_id)
        keep = units_to_invoice(fresh, service_line_ids=_service_line_ids(fresh))
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
        await _best_effort_refresh(db, salesorder_id, number)
    return outcome


async def hand_over(
    db: AsyncSession, salesorder_id: str, package_id: str, *, mode: Literal["pickup", "delivery"], apply_credit: bool
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
        if status not in ("not_shipped", "shipped", "delivered"):
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
        deliver = shipment_id if mode == "pickup" and status != "delivered" else None
        return await _finish(db, salesorder_id, number, outcome, row=row, deliver=deliver, apply_credit=apply_credit)


async def cancel_order(db: AsyncSession, salesorder_id: str) -> None:
    """Mark the order void in Books; the re-read then takes it off the board. Books refuses an order it cannot
    void (shipped, invoiced), and its reason reaches the operator as it is."""
    with writing(salesorder_id):
        doc = await confirm_stored_copy(db, salesorder_id)
        number = doc.header.get("salesorder_number") or ""
        try:
            await _write(salesorder_id, number, "void", zoho_service.void_salesorder(db, salesorder_id))
        except ZohoUpstreamError:
            await _best_effort_refresh(db, salesorder_id, number)  # a timeout can mean it went through
            raise
        await _best_effort_refresh(db, salesorder_id, number)


# --- Edit the order's lines ------------------------------------------------------------------------------------

_SO_LINE_FIELDS = ("line_item_id", "item_id", "name", "description", "rate", "quantity", "unit", "tax_id", "discount")


async def search_items(db: AsyncSession, query: str) -> list[dict]:
    """Books items matching ``query`` that are goods, not services; the first five."""
    if sync.zoho_busy():
        raise sync.ZohoBusy(query)
    try:
        found = await zoho_service.list_items(db, query)
    except ZohoRateLimited as e:
        sync.open_rate_limit_window(e)
        raise sync.ZohoBusy(query) from e
    return [
        {
            "id": item.get("item_id") or "",
            "name": item.get("name") or "",
            "sku": item.get("sku") or "",
            "rate": float(_num(item.get("rate"))),
            "stock_on_hand": None if item.get("stock_on_hand") is None else float(_num(item.get("stock_on_hand"))),
            "product_type": item.get("product_type") or "",
        }
        for item in found
        if item.get("product_type") != "service"
    ][:5]


def _is_physical(raw: dict) -> bool:
    return bool(raw.get("item_id")) and raw.get("product_type") != "service"


async def edit_lines(db: AsyncSession, salesorder_id: str, version: str, lines: list[dict]) -> dict:
    """Set the quantities of an order's goods lines, drop the ones left out and add new items, in Books. The whole
    line list is sent back, service lines untouched. ``version`` is the order's ``last_modified_time`` the operator
    saw: an order saved in Books since is refused. Lines already packed, picked or invoiced cannot go below that."""
    with writing(salesorder_id):
        doc = await confirm_stored_copy(db, salesorder_id)
        number = doc.header.get("salesorder_number") or ""
        if _open_picklists(doc.detail or {}):
            raise OrderActionRefused("picklist_open")
        detail = await _reread(db, salesorder_id)  # the comparison and the floors must come from Books as it is now
        if detail.get("last_modified_time", "") != version:
            raise OrderActionRefused("version")
        floors = {line["id"]: line["floor"] for line in (await _row(db, salesorder_id))["lines"]}
        raws = detail.get("line_items") or []
        physical = {raw["line_item_id"] for raw in raws if _is_physical(raw)}
        edits: dict[str, float] = {}
        new: dict[str, float] = {}
        for entry in lines:
            q = entry.get("quantity")
            if not isinstance(q, int | float) or not math.isfinite(q) or q <= 0 or round(q, 3) != q:
                raise OrderActionRefused("bad_quantity")
            if "line_id" in entry:
                line_id = entry["line_id"]
                if any(raw.get("line_item_id") == line_id and not _is_physical(raw) for raw in raws):
                    raise OrderActionRefused("service_line")
                if line_id not in physical:
                    raise OrderActionRefused("unknown_line")
                if line_id in edits:
                    raise OrderActionRefused("unknown_line")
                if q < floors.get(line_id, 0.0) - 1e-9:
                    raise OrderActionRefused("below_floor")
                edits[line_id] = q
            else:
                item_id = entry.get("item_id")
                if not item_id or item_id in new or any(raw.get("item_id") == item_id for raw in raws):
                    raise OrderActionRefused("unknown_item")
                new[item_id] = q
        if any(floors.get(line_id, 0.0) > 0 and line_id not in edits for line_id in physical):
            raise OrderActionRefused("below_floor")
        items: dict[str, dict] = {}
        if new:
            try:
                found = await zoho_service.list_items_by_ids(db, list(new))
            except ZohoRateLimited as e:
                sync.open_rate_limit_window(e)
                raise sync.ZohoBusy(salesorder_id) from e
            items = {item.get("item_id"): item for item in found}
            if any(i not in items or items[i].get("product_type") == "service" for i in new):
                raise OrderActionRefused("unknown_item")
        if (
            not new
            and len(edits) == len(physical)
            and all(
                _num(raw.get("quantity")) == edits[raw["line_item_id"]]
                for raw in raws
                if raw["line_item_id"] in physical
            )
        ):
            raise OrderActionRefused("nothing_changed")
        body_lines = []
        for raw in raws:
            line_id = raw.get("line_item_id")
            if line_id in physical and line_id not in edits:
                continue
            kept = {k: raw[k] for k in _SO_LINE_FIELDS if k in raw}
            if line_id in edits:
                kept["quantity"] = edits[line_id]
            body_lines.append(kept)
        body_lines += [{"item_id": i, "quantity": q, "rate": float(_num(items[i].get("rate")))} for i, q in new.items()]
        try:
            await _write(
                salesorder_id,
                number,
                "lines",
                zoho_service.update_salesorder(db, salesorder_id, {"line_items": body_lines}),
            )
        except ZohoUpstreamError:
            await _best_effort_refresh(db, salesorder_id, number)  # a timeout can mean Books saved it
            raise
        await _best_effort_refresh(db, salesorder_id, number)
    return await _row(db, salesorder_id)


# --- Edit a packed parcel --------------------------------------------------------------------------------------

# False: edit the package and its completed picklist in place. True: the spec's fallback (delete the package, fix
# the picklist, create the package again), for when the first live run shows Books refuses a completed picklist.
_PARCEL_EDIT_REPLACES = False


def _units(quantities: Mapping[str, float]) -> dict[str, float]:
    if any(not isinstance(q, int | float) or not math.isfinite(q) or q < 0 for q in quantities.values()):
        raise OrderActionRefused("bad_quantity")
    return {line_id: q for line_id, q in quantities.items() if q > 0}


def _same(a: Mapping[str, float], b: Mapping[str, float]) -> bool:
    return a.keys() == b.keys() and all(abs(a[k] - b[k]) <= 1e-9 for k in a)


def _boxed(package: dict) -> dict[str, float]:
    """Units per order line in a package."""
    result: dict[str, float] = {}
    for line in package.get("line_items") or []:
        line_id = line.get("so_line_item_id") or ""
        result[line_id] = result.get(line_id, 0.0) + _num(line.get("quantity"))
    return result


async def _package(db: AsyncSession, package_id: str) -> dict:
    try:
        return await zoho_service.get_package(db, package_id)
    except ZohoNotFound as e:
        raise OrderActionRefused("unknown_package") from e
    except ZohoRateLimited as e:
        sync.open_rate_limit_window(e)
        raise sync.ZohoBusy(package_id) from e


async def _parcel(db: AsyncSession, salesorder_id: str, package_id: str, order: dict, row: dict):
    """The package and its picklist as Books has them now, and per order line the most the parcel may hold: its
    own units plus what the shelf still covers once the units picked for another parcel are set aside."""
    if not any(p.get("package_id") == package_id for p in order.get("packages") or []):
        raise OrderActionRefused("unknown_package")
    # An open picklist's units are outside the shelf figure, whichever picklist it is.
    if _open_picklists(order):
        raise OrderActionRefused("picklist_open")
    package = await _package(db, package_id)
    if package.get("status") != "not_shipped":
        raise OrderActionRefused("package_shipped")
    boxed = _boxed(package)
    known = {line["id"] for line in row["lines"]}
    rows = {line.get("picklist_item_id") for line in package.get("line_items") or []}
    if any(line_id not in known for line_id in boxed) or not rows or "" in rows or None in rows:
        raise OrderActionRefused("picklist_shared")
    picklist = None
    for entry in order.get("picklists") or []:
        found = await _picklist(db, order, entry.get("picklist_id") or "")
        hit = rows & {r.get("line_item_id") for r in found.get("line_items") or []}
        if hit:
            if hit != rows:  # the parcel's lines point to two picklists
                raise OrderActionRefused("picklist_shared")
            picklist = found
            break
    if picklist is None:
        raise OrderActionRefused("picklist_shared")
    # Units picked on the parcel's own picklist and not boxed (a step A whose step B failed) may go in it.
    here = {line_id: units for line_id, (units, _, _) in _to_box(picklist, salesorder_id).items()}
    held = picked_waiting(order)
    ceiling = {
        line["id"]: round(
            boxed.get(line["id"], 0.0)
            + max(0.0, line["packable"] - max(0.0, held.get(line["id"], 0.0) - here.get(line["id"], 0.0))),
            6,
        )
        for line in row["lines"]
    }
    return package, picklist, boxed, {line_id: q for line_id, q in ceiling.items() if q > 0}


async def package_content(db: AsyncSession, salesorder_id: str, package_id: str) -> dict:
    """What a packed parcel holds and may hold, for its editor. Reads only."""
    order = await _stored_order(db, salesorder_id)
    row = await _row(db, salesorder_id)
    if sync.zoho_busy():
        raise sync.ZohoBusy(salesorder_id)
    package, picklist, boxed, ceiling = await _parcel(db, salesorder_id, package_id, order, row)
    return {
        "id": package_id,
        "number": package.get("package_number") or "",
        "version": order.get("last_modified_time", ""),
        "picklist_id": picklist.get("picklist_id") or "",
        "lines": [
            {"line_id": line_id, "quantity": boxed.get(line_id, 0.0), "max": q} for line_id, q in ceiling.items()
        ],
    }


def _picklist_rows(
    picklist: dict, package: dict, old: Mapping[str, float], new: Mapping[str, float], rising: bool, salesorder_id: str
) -> tuple[list[dict], dict[str, float], bool]:
    """The picklist rows to send, the units per order line, and whether Books already shows them.

    A line this edit changes holds the units the other parcels boxed from its row plus this parcel's: the larger of
    its old and new units while rising (never under what is picked), its new units otherwise. Every other row stays
    as it is. Counted from what Books shows now, so the same request repeated finds a done step done.
    """
    in_parcel = _boxed(package)
    rows, units, same = [], {}, True
    for r in picklist.get("line_items") or []:
        line_id = r.get("so_line_item_id") or ""
        picked = _num(r.get("quantity_picked"))
        target = picked
        before, after = old.get(line_id, 0.0), new.get(line_id, 0.0)
        if abs(before - after) > 1e-9:
            others = max(0.0, _num(r.get("quantity_packed")) - in_parcel.get(line_id, 0.0))
            target = max(picked, others + max(before, after)) if rising else others + after
        target = round(target, 6)
        same = same and abs(target - picked) <= 1e-9
        units[line_id] = target
        if target > 0:  # Books removes the rows left out
            rows.append({"line_item_id": r["line_item_id"], "quantity_to_be_picked": target, "quantity_picked": target})
    for line_id, q in new.items():
        if line_id not in units:  # a line new to the parcel and to its picklist
            same = False
            units[line_id] = q
            rows.append(
                {
                    "salesorder_id": salesorder_id,
                    "so_line_item_id": line_id,
                    "quantity_to_be_picked": q,
                    "quantity_picked": q,
                }
            )
    return rows, units, same


def _package_lines(picklist: dict, new: Mapping[str, float]) -> list[dict]:
    row_ids = {r.get("so_line_item_id"): r.get("line_item_id") for r in picklist.get("line_items") or []}
    if any(not row_ids.get(line_id) for line_id in new):
        raise ZohoUpstreamError("picklist row missing for a parcel line")
    return [
        {"so_line_item_id": line_id, "quantity": q, "picklist_item_id": row_ids[line_id]} for line_id, q in new.items()
    ]


async def _rewrite_parcel(
    db: AsyncSession,
    salesorder_id: str,
    number: str,
    order: dict,
    package: dict,
    picklist: dict,
    old: dict[str, float],
    new: dict[str, float],
) -> None:
    """The Books writes of a parcel edit, in an order that never shows a package row above its picklist row. Each
    step is skipped when Books already shows its result; a step that ran is followed by a re-read."""
    package_id, picklist_id = package["package_id"], picklist["picklist_id"]

    def body(rows: list[dict]) -> dict:
        head = {"date": picklist.get("date"), "location_id": picklist.get("location_id")}
        return {**{k: v for k, v in head.items() if v}, "group_by": picklist.get("group_by"), "line_items": rows}

    async def update_picklist(step: str, rows: list[dict]) -> dict:
        await _write(salesorder_id, number, step, zoho_service.update_picklist(db, picklist_id, body(rows)))
        return await _picklist(db, order, picklist_id)

    if _PARCEL_EDIT_REPLACES:
        await _write(salesorder_id, number, "delete_package", zoho_service.delete_package(db, package_id))
        picklist = await _picklist(db, order, picklist_id)
        rows, units, same = _picklist_rows(picklist, {}, old, new, False, salesorder_id)
        if not rows:  # no parcel holds anything from it any more
            await _write(salesorder_id, number, "delete_picklist", zoho_service.delete_picklist(db, picklist_id))
            return
        if not same:
            try:
                picklist = await update_picklist("picklist", rows)
            except ZohoRequestRejected:  # Books will not change a completed picklist: make it again
                held = await _picklist(db, order, picklist_id)
                if any(_num(r.get("quantity_packed")) > 0 for r in held.get("line_items") or []):
                    raise  # another parcel boxed from it: keep it (picklist ≥ package), "Créer le colis" finishes
                await _write(salesorder_id, number, "delete_picklist", zoho_service.delete_picklist(db, picklist_id))
                fresh = {
                    "date": date.today().isoformat(),
                    "location_id": picklist.get("location_id"),
                    "parent_entity": "salesorder",
                    "group_by": "none",
                    "line_items": [
                        {
                            "salesorder_id": salesorder_id,
                            "so_line_item_id": k,
                            "quantity_to_be_picked": q,
                            "quantity_picked": q,
                        }
                        for k, q in units.items()
                        if q > 0
                    ],
                }
                picklist = await _write(salesorder_id, number, "picklist", zoho_service.create_picklist(db, fresh))
                if picklist.get("status") != "completed":
                    await _write(
                        salesorder_id,
                        number,
                        "picklist_completed",
                        zoho_service.complete_picklist(db, picklist.get("picklist_id") or ""),
                    )
        if new:
            await _write(
                salesorder_id,
                number,
                "parcel",
                zoho_service.create_package(
                    db, salesorder_id, date=date.today().isoformat(), line_items=_package_lines(picklist, new)
                ),
            )
        return

    if not new:
        await _write(salesorder_id, number, "delete_package", zoho_service.delete_package(db, package_id))
        picklist = await _picklist(db, order, picklist_id)
        if not any(_num(r.get("quantity_packed")) > 0 for r in picklist.get("line_items") or []):
            await _write(salesorder_id, number, "delete_picklist", zoho_service.delete_picklist(db, picklist_id))
            return
        package = {}
    if any(q > old.get(line_id, 0.0) + 1e-9 for line_id, q in new.items()):  # A: picklist up
        rows, _, same = _picklist_rows(picklist, package, old, new, True, salesorder_id)
        if not same:
            picklist = await update_picklist("picklist_up", rows)
    if new and not _same(_boxed(package), new):  # B: the package
        parcel = {"date": package.get("date") or date.today().isoformat(), "line_items": _package_lines(picklist, new)}
        await _write(
            salesorder_id, number, "parcel", zoho_service.update_package(db, package_id, salesorder_id, parcel)
        )
        package = await _package(db, package_id)
        picklist = await _picklist(db, order, picklist_id)
    if any(q > new.get(line_id, 0.0) + 1e-9 for line_id, q in old.items()):  # C: picklist down
        rows, _, same = _picklist_rows(picklist, package, old, new, False, salesorder_id)
        if not same:
            await update_picklist("picklist_down", rows)


async def edit_parcel(
    db: AsyncSession, salesorder_id: str, package_id: str, version: str, was: dict[str, float], lines: dict[str, float]
) -> dict:
    """Set what a packed parcel holds, in Books, its picklist kept in step; returns the recomputed row. ``version``
    is the order's ``last_modified_time`` and ``was`` the parcel's units the operator saw; an empty ``lines`` deletes
    the parcel. The same request repeated after a failure finishes the job: a parcel that already holds ``lines``
    is not "changed", it is a step done."""
    with writing(salesorder_id):
        old, new = _units(was), _units(lines)
        doc = await confirm_stored_copy(db, salesorder_id)
        number = doc.header.get("salesorder_number") or ""
        detail = await _reread(db, salesorder_id)
        if detail.get("last_modified_time", "") != version:
            raise OrderActionRefused("version")
        row = await _row(db, salesorder_id)
        package, picklist, boxed, ceiling = await _parcel(db, salesorder_id, package_id, detail, row)
        if not _same(boxed, old) and not _same(boxed, new):
            raise OrderActionRefused("package_changed")
        _within(new, ceiling, {line["id"] for line in row["lines"]})
        if _same(old, new):
            raise OrderActionRefused("nothing_changed")
        try:
            await _rewrite_parcel(db, salesorder_id, number, detail, package, picklist, old, new)
        except Exception:
            await _best_effort_refresh(db, salesorder_id, number)  # a timeout can mean Books did it
            raise
        await _best_effort_refresh(db, salesorder_id, number)
    return await _row(db, salesorder_id)


async def invoice_shipped(db: AsyncSession, salesorder_id: str, *, apply_credit: bool) -> dict:
    """Invoice what is shipped and not invoiced yet, for any stored order (a finished one has no board row)."""
    with writing(salesorder_id):
        doc = await confirm_stored_copy(db, salesorder_id)
        row = await sync.find_board_row(db, salesorder_id)
        number = doc.header.get("salesorder_number") or ""
        return await _finish(db, salesorder_id, number, _outcome(), row=row, deliver=None, apply_credit=apply_credit)


async def handover_preview(db: AsyncSession, salesorder_id: str, package_id: str) -> dict:
    """What a hand-over of this parcel would do, from the stored order and Books' own prefill. Reads only."""
    doc = (await db.execute(_stored_query(salesorder_id))).scalar_one_or_none()
    if doc is None or not doc.detail:
        raise OrderNotOnBoard(salesorder_id)
    order = doc.detail
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
        if status not in ("not_shipped", "shipped", "delivered"):
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
    # Only a total Books would print as is: tax included, no discount and no order-level money to add.
    if (
        payload
        and payload.get("is_inclusive_tax")
        and not any(_nonzero(line.get("discount")) for line in payload["line_items"])
        and not any(_nonzero(payload.get(k)) for k in _ORDER_MONEY)
    ):
        total = round(sum(_num(line.get("rate")) * line["quantity"] for line in payload["line_items"]), 2)
        result["invoice_total"] = total
        result["credit"] = min(total, _num(((row or {}).get("payment") or {}).get("advance")))
    return result


async def email_invoice(db: AsyncSession, salesorder_id: str, number: str, invoice_id: str, to: str) -> None:
    """Email one of the order's invoices through Books, then re-read the order: Books marks a draft invoice sent."""
    with writing(salesorder_id):
        logger.info("Order board write: order=%s step=invoice_email", number)
        await zoho_service.email_invoice(db, invoice_id, to_mail_ids=[to])
        await _best_effort_refresh(db, salesorder_id, number)
