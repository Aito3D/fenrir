"""The Order Board's writes towards Books: print stamp, picklist, parcel, hand-over, invoice and credit."""

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
from backend.app.services.order_board import picked_waiting, units_to_invoice
from backend.app.services.zoho import ZohoNotFound, ZohoRateLimited, ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)

_writing: set[str] = set()


class OrderNotOnBoard(Exception):
    """The order has no row on the stored board."""


class OrderBusy(Exception):
    """Another write on this order is still running."""


class OrderActionRefused(Exception):
    """args[0] is one of "nothing_to_pack", "unknown_line", "too_many", "bad_quantity", "unknown_package",
    "picklist_open", "unknown_picklist", "picklist_shared"."""


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
    offered: dict[str, float] = {}
    for line in prefill.get("line_items") or []:
        line_id = line.get("so_line_item_id") or ""
        units = min(_num(line.get("quantity_to_be_picked")), shelf.get(line_id, 0.0) - held.get(line_id, 0.0))
        if line.get("salesorder_id") == salesorder_id and round(units, 6) > 0:
            offered[line_id] = round(units, 6)
    return prefill, offered


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
    row id. A completed picklist counts what was picked, an open one what is to be picked."""
    done = picklist.get("status") == "completed"
    result: dict[str, tuple[float, float, str]] = {}
    for line in picklist.get("line_items") or []:
        if line.get("salesorder_id") != salesorder_id:
            raise OrderActionRefused("picklist_shared")  # cutting it down here would touch another order
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
        _within(wanted, {line_id: units for line_id, (units, _, _) in on_list.items()}, set(on_list))
        try:
            if picklist.get("status") != "completed":
                body = {
                    "date": picklist.get("date") or date.today().isoformat(),
                    "location_id": picklist.get("location_id"),
                    "group_by": picklist.get("group_by"),
                    # Books removes the rows left out: the picklist becomes exactly what was picked.
                    "line_items": [
                        {
                            "line_item_id": on_list[line_id][2],
                            "quantity_to_be_picked": on_list[line_id][1] + q,
                            "quantity_picked": on_list[line_id][1] + q,
                        }
                        for line_id, q in wanted.items()
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

_ORDER_MONEY = ("discount", "shipping_charge", "adjustment")
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


def _nonzero(value) -> bool:
    """A money field that is set: ``"10%"`` counts, ``0`` and ``""`` do not."""
    try:
        return float(str(value or 0).strip().rstrip("%") or 0) != 0
    except ValueError:
        return True


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
