"""Shared router and helpers of the Order Board routes."""

import logging
import time
from collections.abc import Awaitable, Callable
from datetime import timedelta
from typing import TypeVar

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.aito import _EMAIL_GUARD, _email_guard_key_or_409
from backend.app.api.routes.aito_payments import _refuse
from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.models.order_board_event import OrderBoardEvent
from backend.app.models.user import User
from backend.app.services import (
    order_board_actions,
    order_board_sync,
)
from backend.app.services.aito_events import utc_now_naive
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoUnreachable, ZohoUpstreamError
from backend.app.utils.http import build_content_disposition

logger = logging.getLogger(__package__)
_T = TypeVar("_T")
router = APIRouter(prefix="/order-board", tags=["order-board"])
# A contact edit needs only orders:update: an address it just set is not mailed a document until this has passed.
_RECIPIENT_EDIT_COOLDOWN = timedelta(minutes=10)


async def _guarded_email(
    key_prefix: str,
    doc_id: str,
    to: str,
    content: dict,
    refused_detail: str,
    action: Callable[[], Awaitable[None]],
    *,
    db: AsyncSession,
    salesorder_id: str,
    keep_armed: tuple[type[Exception], ...] = (ZohoUnreachable,),
) -> None:
    """Send one document email: only to an address Books offered and not just edited, once a minute per document and address."""
    if to.lower() not in {r["email"].lower() for r in content["recipients"]}:
        raise HTTPException(status_code=422, detail=refused_detail)
    doc = (
        await db.execute(
            select(OrderBoardDoc).where(OrderBoardDoc.kind == "salesorder", OrderBoardDoc.zoho_id == salesorder_id)
        )
    ).scalar_one_or_none()
    customer_id = str(
        ((doc.detail or {}).get("customer_id") or (doc.header or {}).get("customer_id") or "") if doc else ""
    )
    edits = await db.execute(
        select(OrderBoardEvent.salesorder_id, OrderBoardEvent.detail).where(
            OrderBoardEvent.kind == "contact.edited",
            OrderBoardEvent.occurred_at >= utc_now_naive() - _RECIPIENT_EDIT_COOLDOWN,
        )
    )
    # The address lives on the client in Books: an edit made from any order of this client counts. Events recorded
    # before customer_id was stored match by order only.
    if any(
        (d or {}).get("email") == to.lower()
        and (so == salesorder_id or (customer_id and (d or {}).get("customer_id") == customer_id))
        for so, d in edits
    ):
        raise _refuse(409, "recipient_recently_edited", "That address was just edited: check it with the client first")
    key = _email_guard_key_or_409(key_prefix, 0, doc_id, to)
    _EMAIL_GUARD.arm(key, time.monotonic())

    async def send() -> None:
        try:
            await action()
        except keep_armed:
            raise  # Books may have sent it all the same: the guard stays armed
        except Exception:
            _EMAIL_GUARD.release(key)
            raise

    await _run(send())


async def _run(call: Awaitable[_T]) -> _T:
    """Await an order action and turn its failures into the statuses the board shows the operator."""
    try:
        return await call
    except (order_board_actions.OrderNotOnBoard, order_board_sync.OrderNotStored):
        raise HTTPException(status_code=404, detail="Order not found.") from None
    except order_board_actions.OrderActionRefused as e:
        raise HTTPException(status_code=400, detail=e.args[0]) from None
    except order_board_actions.OrderBusy:
        raise HTTPException(status_code=409, detail="Another action on this order is still running.") from None
    except order_board_sync.ZohoBusy:
        raise HTTPException(status_code=503, detail="Zoho is busy, try again shortly.") from None
    except ZohoNotConfiguredError:
        raise HTTPException(status_code=503, detail="Zoho Books is not connected.") from None
    except ZohoUpstreamError as e:
        # Books' message can name a customer or an item: the log keeps the step and the class only.
        logger.warning("Order board Zoho call failed: step=%s (%s)", getattr(call, "__name__", "?"), type(e).__name__)
        raise HTTPException(status_code=502, detail=str(e)[:300]) from None  # Books' own reason, for the operator


def _pdf(content: bytes, filename: str) -> Response:
    """Inline PDF with a fixed name; it holds customer data, so no cache keeps it."""
    return Response(
        content=content,
        media_type="application/pdf",
        headers={
            "Content-Disposition": build_content_disposition(filename, disposition="inline"),
            "Cache-Control": "no-store",
        },
    )


def _by(user: User | None) -> str | None:
    return user.username if user else None


def _logged(user: User | None, salesorder_id: str, action: str) -> None:
    logger.info("Order board: user=%s order=%s action=%s", user.id if user else "-", salesorder_id, action)


async def _require_order(db: AsyncSession, salesorder_id: str) -> None:
    """On the board, or a stored finished order; anything else is unknown."""
    if await order_board_sync.find_board_row(db, salesorder_id) is not None:
        return
    stored = await db.execute(
        select(OrderBoardDoc.id).where(OrderBoardDoc.kind == "salesorder", OrderBoardDoc.zoho_id == salesorder_id)
    )
    if stored.first() is None:
        raise HTTPException(status_code=404, detail="Order not found.")
