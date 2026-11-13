"""Reading is one local read of the stored board. Refresh runs one bounded sync
pass against Zoho Books (GETs only). The settings routes are their own
endpoints, not the general settings API, because Operators hold
``settings:read`` only and must still be able to tune the board.
"""

from dataclasses import asdict
from datetime import datetime
from typing import Annotated, Literal

from fastapi import Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field, StringConstraints, field_validator
from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.order_board._common import _logged, _pdf, _require_order, _run, logger, router
from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.notification_inbox import OrderWatch
from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.models.order_board_event import OrderBoardEvent
from backend.app.models.user import User
from backend.app.schemas.aito import AitoNoteCreate
from backend.app.services import (
    aito_tracking,
    order_board_actions,
    order_board_sync,
)
from backend.app.services.order_board_events import kinds_for_depth, record
from backend.app.services.order_board_prep_sheet import render_batch_prep_sheet, render_prep_sheet
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoUpstreamError


class OrderBoardSettingsBody(BaseModel):
    sync_enabled: bool
    sync_minutes: Literal[5, 15, 60]
    max_age_days: int = Field(ge=0, le=3650)
    core_brands: list[str] = Field(max_length=30)
    scan_enabled: bool = False

    @field_validator("core_brands")
    @classmethod
    def _clean_brands(cls, brands: list[str]) -> list[str]:
        cleaned: list[str] = []
        for brand in (b.strip() for b in brands):
            if not 1 <= len(brand) <= 60:
                raise ValueError("a brand must be 1 to 60 characters")
            if brand.casefold() not in {c.casefold() for c in cleaned}:
                cleaned.append(brand)
        return cleaned


@router.get("")
async def get_order_board(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    """The stored board, when it was computed, and the sync status."""
    return await order_board_sync.read_board(db)


@router.get("/finished")
async def get_finished_orders(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    """Shipped orders, newest first, from the stored list rows (no Zoho call)."""
    return await order_board_sync.read_finished(db)


@router.get("/finished/{salesorder_id}")
async def get_finished_order(
    salesorder_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    """One shipped order in full; fetched from Zoho the first time it is opened, then kept."""
    try:
        return await order_board_sync.read_finished_order(db, salesorder_id)
    except order_board_sync.OrderNotFinished:
        raise HTTPException(status_code=404, detail="Finished order not found.") from None
    except order_board_sync.ZohoBusy:
        raise HTTPException(status_code=503, detail="Zoho is busy, try again shortly.") from None
    except ZohoNotConfiguredError:
        raise HTTPException(status_code=503, detail="Zoho Books is not connected.") from None
    except ZohoUpstreamError as e:
        logger.warning("Finished order fetch failed (%s)", type(e).__name__)
        raise HTTPException(status_code=502, detail="Zoho Books did not answer.") from None


@router.post("/refresh")
async def refresh_order_board(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    """One bounded sync pass, then the board. A pass already running is left
    to finish; the caller gets the board as it stands."""
    await order_board_sync.run_pass(db)
    return await order_board_sync.read_board(db)


@router.get("/settings", response_model=OrderBoardSettingsBody)
async def get_order_board_settings(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    return asdict(await order_board_sync.load_settings(db))


@router.put("/settings", response_model=OrderBoardSettingsBody)
async def update_order_board_settings(
    body: OrderBoardSettingsBody,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    """Save the settings and rebuild the board from the local copy."""
    await order_board_sync.save_settings(db, order_board_sync.OrderBoardSettings(**body.model_dump()))
    return asdict(await order_board_sync.load_settings(db))


class OrderEventResponse(BaseModel):
    id: int
    occurred_at: datetime
    kind: str
    actor_class: str
    actor_name: str | None
    changes: list[dict] | None
    detail: dict | None
    note: str | None

    model_config = {"from_attributes": True}


class OrderEventPage(BaseModel):
    events: list[OrderEventResponse]
    has_more: bool


async def _own_watch(db: AsyncSession, salesorder_id: str, user: User | None) -> OrderWatch | None:
    if user is None:  # auth disabled: no user, no inbox, nothing to watch for
        return None
    return (
        await db.execute(
            select(OrderWatch).where(OrderWatch.user_id == user.id, OrderWatch.salesorder_id == salesorder_id)
        )
    ).scalar_one_or_none()


@router.get("/orders/{salesorder_id}/watch")
async def get_order_watch(
    salesorder_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    """Whether the caller watches this order."""
    await _require_order(db, salesorder_id)
    return {"watching": await _own_watch(db, salesorder_id, current_user) is not None}


@router.put("/orders/{salesorder_id}/watch")
async def watch_order(
    salesorder_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    """Watch this order: its bell rows reach the caller even for kinds switched off in their preferences.
    orders:read is enough, a watch only changes the caller's own bell. A no-op with auth disabled."""
    await _require_order(db, salesorder_id)
    if current_user is None:
        return {"watching": False}
    if await _own_watch(db, salesorder_id, current_user) is None:
        db.add(OrderWatch(user_id=current_user.id, salesorder_id=salesorder_id))
        try:
            await db.commit()
        except IntegrityError:  # another tab watched it between the read and the insert
            await db.rollback()
    return {"watching": True}


@router.delete("/orders/{salesorder_id}/watch")
async def unwatch_order(
    salesorder_id: str,
    db: AsyncSession = Depends(get_db, scope="function"),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    """Stop watching; no 404 for an order that has since gone, so a stale watch can always be dropped."""
    watch = await _own_watch(db, salesorder_id, current_user)
    if watch is not None:
        await db.delete(watch)
        await db.commit()
    return {"watching": False}


@router.get("/orders/{salesorder_id}/events", response_model=OrderEventPage)
async def list_order_events(
    salesorder_id: str,
    depth: Literal["story", "detail", "everything"] = "detail",
    before: int | None = None,
    before_at: datetime | None = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> OrderEventPage:
    """The order's timeline, newest first; the cursor is the pair (occurred_at, id), as on Aito."""
    await _require_order(db, salesorder_id)
    if (before is None) != (before_at is None):
        raise HTTPException(status_code=422, detail="The cursor needs both 'before' and 'before_at'")
    limit = max(1, min(limit, 200))
    query = (
        select(OrderBoardEvent)
        .where(OrderBoardEvent.salesorder_id == salesorder_id, OrderBoardEvent.kind.in_(kinds_for_depth(depth)))
        .order_by(OrderBoardEvent.occurred_at.desc(), OrderBoardEvent.id.desc())
        .limit(limit + 1)  # one extra row answers has_more without a count
    )
    if before is not None:
        query = query.where(
            or_(
                OrderBoardEvent.occurred_at < before_at,
                and_(OrderBoardEvent.occurred_at == before_at, OrderBoardEvent.id < before),
            )
        )
    rows = list((await db.execute(query)).scalars().all())
    return OrderEventPage(
        events=[OrderEventResponse.model_validate(r) for r in rows[:limit]], has_more=len(rows) > limit
    )


@router.post("/orders/{salesorder_id}/events", response_model=OrderEventResponse, status_code=201)
async def add_order_note(
    salesorder_id: str,
    payload: AitoNoteCreate,
    db: AsyncSession = Depends(get_db, scope="function"),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> OrderEventResponse:
    """Append a local note; kind and actor are fixed here so a client cannot fabricate other events."""
    await _require_order(db, salesorder_id)
    event = await record(
        db,
        salesorder_id,
        "note.added",
        actor_class="user",
        actor_name=current_user.username if current_user is not None else "Admin",
        note=payload.note,
    )
    await db.commit()
    await db.refresh(event)
    return OrderEventResponse.model_validate(event)


@router.post("/orders/{salesorder_id}/prep-sheet")
async def print_prep_sheet(
    salesorder_id: str,
    picklist_id: str | None = Query(default=None, min_length=1, max_length=64),
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> Response:
    """Stamp the order as printed and return its prep sheet: the units of one picklist, or everything packable."""
    content = await _run(order_board_actions.picklist_content(db, salesorder_id, picklist_id)) if picklist_id else None
    row = await _run(
        order_board_actions.stamp_print(
            db, salesorder_id, user.username if user else "", content["number"] if content else None
        )
    )
    base = await aito_tracking.external_url(db)
    pdf = render_prep_sheet(
        row,
        printed_at=datetime.now(),
        order_url=f"{base}/orders?order={salesorder_id}" if base else None,
        quantities={line["line_id"]: line["quantity"] for line in content["lines"]} if content else None,
        picklist_number=content["number"] if content else "",
    )
    _logged(user, salesorder_id, "prep_sheet")
    return _pdf(pdf, "bon-de-preparation.pdf")


class PrepSheetBatchBody(BaseModel):
    ids: list[Annotated[str, StringConstraints(min_length=1, max_length=64)]] = Field(min_length=1, max_length=30)


@router.post("/prep-sheet/batch")
async def print_prep_sheet_batch(
    body: PrepSheetBatchBody,
    db: AsyncSession = Depends(get_db, scope="function"),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> Response:
    """One PDF for a round of orders: a combined picking page, then each order's prep sheet. It only prints
    (no picklist, no parcel); each order is stamped as printed. Orders with nothing to pick are left out."""
    board = {r["id"]: r for r in (await order_board_sync.read_board(db))["rows"]}
    ids = [
        i
        for i in dict.fromkeys(body.ids)
        if any((ln.get("packable") or 0) > 0 for ln in (board.get(i) or {}).get("lines") or [])
    ]
    if not ids:
        raise HTTPException(status_code=404, detail="No order to prepare.")
    by = user.username if user else ""
    rows = [await _run(order_board_actions.stamp_print(db, i, by)) for i in ids]
    items = (await db.execute(select(OrderBoardDoc).where(OrderBoardDoc.kind == "item"))).scalars()
    base = await aito_tracking.external_url(db)
    pdf = render_batch_prep_sheet(
        rows,
        {d.zoho_id: (d.header or {}).get("brand") or "" for d in items},
        printed_at=datetime.now(),
        order_urls={i: f"{base}/orders?order={i}" for i in ids} if base else {},
    )
    for i in ids:
        _logged(user, i, "prep_sheet_batch")
    return _pdf(pdf, "bons-de-preparation.pdf")
