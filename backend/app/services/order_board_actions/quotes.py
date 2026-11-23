"""Create, edit, decline and reopen a product quote (Books estimate) from the Order Board."""

import contextlib
import logging
from datetime import date, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.services import order_board_sync as sync
from backend.app.services.order_board_actions._common import OrderActionRefused, _log, _num, writing
from backend.app.services.order_board_actions.create import (
    _check_discount_fits,
    _discount,
    _fingerprint,
    checked_quantity,
    once_per_ref,
    priced_lines,
    remember,
)
from backend.app.services.order_board_quotes import editable_here, is_converted, quote_state
from backend.app.services.order_board_sync._quotes import _aito_quote_ids
from backend.app.services.zoho import ZohoNotFound, zoho_service

logger = logging.getLogger(__name__)

_KEPT_FIELDS = ("line_item_id", "item_id", "name", "description", "rate", "tax_id", "unit")
_DEFAULT_VALIDITY_DAYS = 16


class QuoteNotStored(Exception):
    """The quote has no stored copy (never listed, dropped, or owned by an Aito card): the board does not write it."""


async def create_quote(
    db: AsyncSession, customer_id: str, lines: list[dict], client_ref: str, *, by: str | None
) -> str:
    """Create a draft estimate at the items' own rates (tax inclusive) and store it; returns its ``estimate_id``. The
    same ``client_ref`` twice returns the first quote."""
    ref = "quote:" + client_ref
    fingerprint = _fingerprint(customer_id, lines)

    async def make() -> str:
        payload = {
            "customer_id": customer_id,
            "date": date.today().isoformat(),
            "is_inclusive_tax": True,
            "discount_type": "item_level",
            "is_discount_before_tax": True,
            "line_items": await priced_lines(db, customer_id, lines),
        }
        with sync._busy_on_rate_limit(customer_id):
            created = await zoho_service.create_estimate(db, payload)
        estimate_id = str(created["estimate_id"])
        logger.info("Order board write: quote=%s step=create", estimate_id)
        remember(ref, fingerprint, estimate_id)  # before any local write: a retry must not create a second quote
        await _settle(db, estimate_id, "quote.created", by)
        return estimate_id

    return await once_per_ref(ref, fingerprint, make)


async def edit_quote(
    db: AsyncSession, estimate_id: str, customer_id: str, lines: list[dict], *, by: str | None
) -> None:
    """Replace the quote's lines. A line naming a ``line_id`` keeps Books' own name, price and tax with the new quantity
    and discount; a line without one is priced from its item. An expired quote is re-dated for its own validity."""
    with writing(estimate_id):
        detail = await _fresh(db, estimate_id)
        if not editable_here(detail):
            raise OrderActionRefused("quote_not_editable")
        raws = {raw.get("line_item_id"): raw for raw in detail.get("line_items") or []}
        kept: list[dict] = []
        new: list[dict] = []
        for entry in lines:
            line_id = entry.get("line_id")
            if line_id is None:
                new.append(entry)
                continue
            if (
                line_id not in raws
                or raws[line_id].get("item_id") != entry.get("item_id")
                or any(k.get("line_item_id") == line_id for k in kept)
            ):
                raise OrderActionRefused("unknown_line")
            raw = raws[line_id]
            q = checked_quantity(entry.get("quantity"))
            discount = _discount(entry.get("discount"))
            _check_discount_fits(discount, q, _num(raw.get("rate")))
            kept.append(
                {
                    **{k: raw[k] for k in _KEPT_FIELDS if k in raw},
                    "quantity": q,
                    "discount": entry["discount"] if discount else 0,  # always stated: a removed discount is cleared
                }
            )
        body_lines = kept + (await priced_lines(db, estimate_id, new) if new else [])
        redate = None
        if quote_state(detail, date.today()) == "expired":
            redate = {"date": date.today().isoformat(), "expiry_date": _redated_expiry(detail).isoformat()}
        moved_to = customer_id if customer_id != detail.get("customer_id") else None
        contact_person_id = None
        if moved_to is not None:  # the old customer's contact person cannot stay on the quote
            with sync._busy_on_rate_limit(estimate_id):
                persons = await zoho_service.list_contact_persons(db, moved_to)
            primary = next((p for p in persons if p["is_primary"]), persons[0] if persons else None)
            contact_person_id = (primary or {}).get("contact_person_id") or None
        sync.note_write(estimate_id)
        with sync._busy_on_rate_limit(estimate_id):
            await zoho_service.update_estimate_lines(
                db, estimate_id, body_lines, customer_id=moved_to, contact_person_id=contact_person_id
            )
            logger.info("Order board write: quote=%s step=lines", estimate_id)
            if redate is not None:
                await zoho_service.update_estimate_fields(db, estimate_id, redate)
                logger.info("Order board write: quote=%s step=redate", estimate_id)
        await _settle(db, estimate_id, "quote.edited", by)


async def decline_quote(db: AsyncSession, estimate_id: str, *, by: str | None) -> None:
    with writing(estimate_id):
        detail = await _fresh(db, estimate_id)
        sync.note_write(estimate_id)
        with sync._busy_on_rate_limit(estimate_id):
            await zoho_service.advance_estimate_status(db, estimate_id, "declined", current=detail.get("status"))
        logger.info("Order board write: quote=%s step=decline", estimate_id)
        await _settle(db, estimate_id, "quote.declined", by)


async def reopen_quote(db: AsyncSession, estimate_id: str, *, by: str | None) -> None:
    with writing(estimate_id):
        detail = await _fresh(db, estimate_id)
        if detail.get("status") != "declined":
            raise OrderActionRefused("not_declined")
        sync.note_write(estimate_id)
        with sync._busy_on_rate_limit(estimate_id):
            await zoho_service.set_estimate_status(db, estimate_id, "sent")
        logger.info("Order board write: quote=%s step=reopen", estimate_id)
        await _settle(db, estimate_id, "quote.reopened", by)


async def _owned_quote(db: AsyncSession, estimate_id: str) -> OrderBoardDoc:
    """The stored copy of a quote this board owns; none, or an Aito card's, raises ``QuoteNotStored`` (no Books call)."""
    doc = await sync.find_quote(db, estimate_id)
    if doc is None or estimate_id in await _aito_quote_ids(db):
        raise QuoteNotStored(estimate_id)
    return doc


async def _stored_number(db: AsyncSession, estimate_id: str) -> str:
    """The stored quote's number; no copy means no Books call (``QuoteNotStored``)."""
    doc = await _owned_quote(db, estimate_id)
    return str((doc.detail or {}).get("estimate_number") or estimate_id)


async def quote_pdf(db: AsyncSession, estimate_id: str) -> tuple[bytes, str]:
    """The quote's PDF and its number."""
    number = await _stored_number(db, estimate_id)
    return await zoho_service.get_estimate_pdf(db, estimate_id), number


async def quote_email_content(db: AsyncSession, estimate_id: str) -> dict:
    """What Books would email for the quote now, with the quote's id and number."""
    number = await _stored_number(db, estimate_id)
    content = await zoho_service.get_estimate_email_content(db, estimate_id)
    return {**content, "document_id": estimate_id, "document_number": number}


async def email_quote(db: AsyncSession, estimate_id: str, to: str, *, by: str | None) -> None:
    """Email the quote through Books, which marks it sent itself (no status call), then re-read and store it."""
    await _stored_number(db, estimate_id)
    with writing(estimate_id):
        sync.note_write(estimate_id)
        with sync._busy_on_rate_limit(estimate_id):
            await zoho_service.email_estimate(db, estimate_id, to_mail_ids=[to])
        logger.info("Order board write: quote=%s step=email", estimate_id)
        await _settle(db, estimate_id, "quote.emailed", by, to=to)


async def _fresh(db: AsyncSession, estimate_id: str) -> dict:
    """Entry check of every quote write: a stored copy must exist (no Books call otherwise), and the estimate as Books
    has it now must not be converted to an order or invoice. Returns that fresh estimate."""
    doc = await _owned_quote(db, estimate_id)
    if sync.zoho_busy():
        raise sync.ZohoBusy(estimate_id)
    try:
        with sync._busy_on_rate_limit(estimate_id):
            detail = await zoho_service.get_estimate(db, estimate_id)
    except ZohoNotFound:  # deleted in Books: drop the copy so the row leaves the list now
        await db.delete(doc)
        await db.commit()
        await sync.announce_board_change(quotes=True)
        raise QuoteNotStored(estimate_id) from None
    if is_converted(detail):
        try:  # store what Books says, so a stale row (an accepted quote whose order exists) leaves the list now
            await sync.store_quote(db, detail)
            await db.commit()
            await sync.announce_board_change(quotes=True)
        except Exception as e:
            logger.warning("Order board: storing converted quote %s failed (%s)", estimate_id, type(e).__name__)
            with contextlib.suppress(Exception):
                await db.rollback()
        raise OrderActionRefused("quote_converted")
    return detail


def _redated_expiry(detail: dict) -> date:
    """Today plus the quote's own validity (expiry minus date), 16 days when that is unknown or not positive."""
    try:
        days = (date.fromisoformat(detail["expiry_date"]) - date.fromisoformat(detail["date"])).days
    except (KeyError, TypeError, ValueError):
        days = 0
    return date.today() + timedelta(days=days if days > 0 else _DEFAULT_VALIDITY_DAYS)


async def _settle(db: AsyncSession, estimate_id: str, kind: str | None, by: str | None, **detail) -> None:
    """After a Books write: re-read and store the quote, log the event (if any), ping the open pages. The write stands
    even when the re-read fails: the stored copy is then left pending for the next pass."""
    sync.note_write(estimate_id)
    try:
        with sync._busy_on_rate_limit(estimate_id):
            await sync.store_quote(db, await zoho_service.get_estimate(db, estimate_id))
        await db.commit()
    except Exception as e:
        logger.warning("Order board: re-read after a write failed for quote %s (%s)", estimate_id, type(e).__name__)
        with contextlib.suppress(Exception):
            await db.rollback()
            if (doc := await sync.find_quote(db, estimate_id)) is not None:
                doc.pending = True
                await db.commit()
    if kind is not None:
        await _log(db, estimate_id, kind, by, **detail)
    await sync.announce_board_change(quotes=True)
