"""The customer's public tracking page of a sales order.

One code per order, kept as a ``track`` row of ``order_board_docs`` (``zoho_id`` = the sales order id,
``header`` = ``{"token": code}``) and minted the first time a link is asked for. Codes come from the same
mint as the Aito cards' (``aito_tracking.mint_unique_token`` checks both), so a code names one thing only.
The page reads stored copies: it never calls Zoho or Heimdall.
"""

import asyncio
from collections.abc import Collection
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.order_board_doc import OrderBoardDoc
from backend.app.models.order_board_event import OrderBoardEvent
from backend.app.services import aito_tracking, order_board_events, order_board_sync as sync
from backend.app.services.aito_payment_links import current_link
from backend.app.services.order_board import order_row
from backend.app.services.order_board_payment import _r

TRACK_KIND = "track"
TTL_AFTER_HANDOVER = timedelta(days=30)
VIEW_DEDUP_WINDOW = timedelta(minutes=5)
_HANDOVER_KINDS = ("handover.delivered", "handover.shipped")
# What the customer can act on comes first.
_RANK = {"ready": 0, "preparing": 1, "to_prepare": 1, "waiting": 2, "handed_over": 3}
_STAGE = {"received": "received", "preparing": "preparing", "partly_ready": "ready", "ready": "ready"}
# The dedupe is check-then-insert: two opens logged at once would both see no row.
_VIEW_LOCK = asyncio.Lock()


def _qty(units: float) -> float | int:
    return int(units) if units == int(units) else units


def derive_tracking(row: dict, handed_days: Collection[str] = ()) -> dict | None:
    """What the page says about a board row: the state, the rail stage and the goods lines. Pure.

    A line is split by where its units stand, so a half-packed line reads as two entries: handed over
    (shipped), ready (in a parcel, not handed over), waiting (no stock for them), and the rest, which is
    "preparing" once the order was started (a prep sheet, a picklist, a parcel or a hand-over) and
    "to_prepare" before. Service and cancelled lines are left out. ``handed_days`` are the known hand-over
    moments (days or timestamps); a date is only shown when they all fall on one day, never guessed.
    None for an order with no goods line.
    """
    started = bool(
        row.get("prep")
        or row.get("picklists")
        or row.get("picked")
        or row.get("packed")
        or any(line.get("shipped") for line in row["lines"] if line["state"] not in ("service", "cancelled"))
    )
    handed_on = max(handed_days) if len({day[:10] for day in handed_days}) == 1 else None
    lines = []
    for line in row["lines"]:
        if line["state"] in ("service", "cancelled"):
            continue
        ready = line.get("packed_waiting") or 0.0
        rest = max(0.0, (line.get("remaining") or 0.0) - ready)
        waiting = min(rest, line.get("shortfall") or 0.0)
        for status, units in (
            ("handed_over", line.get("shipped") or 0.0),
            ("ready", ready),
            ("preparing" if started else "to_prepare", rest - waiting),
            ("waiting", waiting),
        ):
            if _r(units) > 0:
                lines.append(
                    {
                        "name": line.get("name") or "",
                        "quantity": _qty(_r(units)),
                        "status": status,
                        "handed_on": handed_on if status == "handed_over" else None,
                    }
                )
    if not lines:
        return None
    lines.sort(key=lambda entry: _RANK[entry["status"]])  # stable: the order's own sequence within a status
    open_lines = [entry for entry in lines if entry["status"] != "handed_over"]
    ready_count = sum(1 for entry in open_lines if entry["status"] == "ready")
    if not open_lines:
        state = "handed_over"
    elif ready_count == len(open_lines):
        state = "ready"
    elif ready_count:
        state = "partly_ready"
    else:
        state = "preparing" if started else "received"
    return {
        "state": state,
        "stage": _STAGE.get(state, "handed_over"),
        "lines": lines,
        "counts": {
            "open": len(open_lines),
            "ready": ready_count,
            "waiting": sum(1 for entry in open_lines if entry["status"] == "waiting"),
        },
    }


def _handed_days(detail: dict) -> list[str]:
    """The day Books says each parcel was delivered, else shipped; a parcel still in the shop has neither."""
    days = []
    for package in detail.get("packages") or []:
        order = package.get("shipment_order") or {}
        day = order.get("delivery_date") or package.get("delivery_date") or package.get("shipment_date")
        if day:
            days.append(str(day)[:10])
    return days


def is_expired(finished_at: datetime | None, now: datetime) -> bool:
    """A handed-over order's page goes dark 30 days later; one whose hand-over moment is unknown is dark already."""
    return finished_at is None or finished_at + TTL_AFTER_HANDOVER < now


def _track_query(salesorder_id: str):
    return select(OrderBoardDoc).where(OrderBoardDoc.kind == TRACK_KIND, OrderBoardDoc.zoho_id == salesorder_id)


async def ensure_token(db: AsyncSession, salesorder_id: str) -> str:
    """The order's code, minted and committed on first use. The table's unique key keeps one per order: the
    loser of a simultaneous first mint returns the winner's code."""
    doc = (await db.execute(_track_query(salesorder_id))).scalar_one_or_none()
    if doc is None:
        doc = OrderBoardDoc(
            kind=TRACK_KIND, zoho_id=salesorder_id, header={"token": await aito_tracking.mint_unique_token(db)}
        )
        db.add(doc)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            doc = (await db.execute(_track_query(salesorder_id))).scalar_one()
    return doc.header["token"]


def tracking_url_for(base: str, token: str) -> str | None:
    """``/t/o/<code>``: beside the Aito cards' ``/t/<code>``, whose links stay as they are."""
    return f"{base}/t/o/{token}" if base and token else None


async def tracking_url(db: AsyncSession, salesorder_id: str) -> str | None:
    """The order's public link, minting its code. None while ``external_url`` is empty (nothing is minted)."""
    base = await aito_tracking.external_url(db)
    if not base:
        return None
    return tracking_url_for(base, await ensure_token(db, salesorder_id))


async def _pay_url(db: AsyncSession, salesorder_id: str, now: datetime) -> str | None:
    """The checkout page of the order's open payment link, read off the ledger only."""
    link = await current_link(db, ("order", salesorder_id), kind=None)
    if link is None or link.heimdall_id is None or link.status != "pending":
        return None
    if link.expires_on and link.expires_on < now.date().isoformat():
        return None
    return link.url or None


async def compute(db: AsyncSession, token: str, now: datetime) -> tuple[str, dict] | None:
    """The page's payload and the sales order id, or None for an unknown code, a cancelled or void order, an
    order with no stored copy and a handed-over order past its 30 days alike: the caller answers them all with
    the same 404."""
    code = aito_tracking.normalize_token(token)
    if code is None or len(code) != aito_tracking.TOKEN_LENGTH:
        return None
    track = (
        await db.execute(
            select(OrderBoardDoc).where(
                OrderBoardDoc.kind == TRACK_KIND, OrderBoardDoc.header["token"].as_string() == code
            )
        )
    ).scalar_one_or_none()
    if track is None:
        return None
    salesorder_id = track.zoho_id
    row = await sync.find_board_row(db, salesorder_id)
    if row is None:  # off the board: only a finished order still has a page
        finished = next(iter(await sync._finished_docs(db, salesorder_id)), None)
        if finished is None or not finished.detail:
            return None
        row = order_row(finished.detail, {}, now.date())
    stored = (await db.execute(sync._stored_query(salesorder_id))).scalar_one_or_none()
    detail = (stored.detail if stored else None) or {}

    event = OrderBoardEvent
    latest = await db.execute(
        select(event.kind, func.max(event.occurred_at))
        .where(event.salesorder_id == salesorder_id, event.kind != "tracking.viewed")
        .group_by(event.kind)
    )
    moments: dict[str, datetime] = dict(latest.tuples().all())
    days = _handed_days(detail) or [moments[k].isoformat() for k in _HANDOVER_KINDS if k in moments]
    tracking = derive_tracking(row, days)
    if tracking is None:
        return None
    modified = sync._naive_utc(str(detail.get("last_modified_time") or ""))
    if tracking["state"] == "handed_over":
        finished_at = (
            datetime.fromisoformat(max(days))
            if days
            else moments.get("order.finished") or max(moments.values(), default=modified)
        )
        if is_expired(finished_at, now):
            return None

    payment = row.get("payment")
    left = max(0, round(payment["left"])) if payment else 0
    facts = row.get("facts") or {}
    stamps: list[datetime] = [*moments.values(), *([modified] if modified else [])]
    updated = max(stamps, default=now)
    return salesorder_id, {
        **tracking,
        "reference": f"#{facts['shopify_order']}" if facts.get("shopify_order") else row["number"],
        "date": row.get("date") or None,
        "pickup": (facts.get("delivery_method") or "").upper() in ("", "PICK UP"),
        "payment": {
            "currency": row.get("currency") or "XPF",
            "total": round(row["total"]),
            "paid": round(row["total"]) - left,
            "left": left,
        }
        if payment and row.get("total")
        else None,
        "pay_url": await _pay_url(db, salesorder_id, now) if left > 0 else None,
        "updated_at": updated.replace(microsecond=0),
    }


async def log_view(db: AsyncSession, salesorder_id: str, now: datetime) -> None:
    """One ``tracking.viewed`` per open on the order's history; a repeat inside the window writes nothing."""
    async with _VIEW_LOCK:
        if await sync._has_event(db, salesorder_id, "tracking.viewed", after=now - VIEW_DEDUP_WINDOW):
            return
        await order_board_events.record(
            db, salesorder_id, "tracking.viewed", actor_class="client", occurred_at=now, alert=False
        )
        await db.commit()
