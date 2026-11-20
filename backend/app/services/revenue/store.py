"""Persistence for the revenue dashboard: the per-day Zoho cache, scope decisions, customers, targets, notes, items.

Reads take a connection from `snapshot()` (one point in time); writes take the caller's AsyncSession and commit.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, cast

from sqlalchemy import CursorResult, and_, delete, func, insert, select
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, AsyncSession

from backend.app.core import database
from backend.app.models.calculator import CalculatorDefaults, CalculatorPrinter
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.revenue import (
    RevenueAnnotation,
    RevenueCustomer,
    RevenueDay,
    RevenueDayLine,
    RevenueItem,
    RevenueScopeDecision,
    RevenueTarget,
)
from backend.app.models.settings import Settings
from backend.app.services.revenue.customers import RevenueCustomerFacts
from backend.app.services.revenue.scope import RevenueDecision, ScopeItem, unit_cost_of
from backend.app.services.revenue.series import RevenueLine
from backend.app.services.revenue.sync_plan import DayRow

MAX_ANNOTATION_LABEL = 80
LINE_CHUNK_SIZE = 500
ITEMS_SYNCED_KEY = "revenue_items_synced_at"


def snapshot_isolation(dialect: str) -> str:
    return "REPEATABLE READ" if dialect == "postgresql" else "AUTOCOMMIT"


@asynccontextmanager
async def snapshot(bind: AsyncEngine | None = None) -> AsyncIterator[AsyncConnection]:
    """A connection on which every read sees one point in time, so a day another session commits mid-way stays invisible."""
    eng = bind or database.engine
    isolation = snapshot_isolation(eng.dialect.name)
    async with eng.connect() as conn:
        await conn.execution_options(isolation_level=isolation)
        if isolation == "AUTOCOMMIT":
            # pysqlite never emits BEGIN before a SELECT, so without it each read would see fresh commits.
            await conn.exec_driver_sql("BEGIN")
        try:
            yield conn
        finally:
            if isolation == "AUTOCOMMIT":
                await conn.exec_driver_sql("ROLLBACK")
            else:
                await conn.rollback()


def _day_row(r: Any) -> DayRow:
    return DayRow(day=r.day, closed=bool(r.closed), fetched_at=r.fetched_at, format=r.format)


async def read_day_index(conn: AsyncConnection) -> list[DayRow]:
    rows = await conn.execute(select(RevenueDay).order_by(RevenueDay.day))
    return [_day_row(r) for r in rows]


async def read_days(conn: AsyncConnection, from_: str, to: str) -> list[DayRow]:
    rows = await conn.execute(
        select(RevenueDay).where(RevenueDay.day >= from_, RevenueDay.day <= to).order_by(RevenueDay.day)
    )
    return [_day_row(r) for r in rows]


async def read_lines(conn: AsyncConnection, from_: str, to: str) -> list[RevenueLine]:
    t = RevenueDayLine
    rows = await conn.execute(select(t).where(t.day >= from_, t.day <= to).order_by(t.day, t.item_id, t.customer_id))
    return [
        RevenueLine(
            day=r.day,
            item_id=r.item_id,
            customer_id=r.customer_id,
            name=r.name,
            sku=r.sku,
            quantity=r.quantity,
            amount=r.amount,
        )
        for r in rows
    ]


async def write_day(
    db: AsyncSession, day: str, lines: list[RevenueLine], closed: bool, now: datetime, format: int
) -> None:
    """Replaces one day in a single transaction: a crash never leaves a half-written day."""
    fields = {"closed": closed, "fetched_at": now.isoformat(), "format": format}
    row = await db.get(RevenueDay, day)
    if row is None:
        db.add(RevenueDay(day=day, **fields))
    else:
        for k, v in fields.items():
            setattr(row, k, v)
    await db.flush()
    await db.execute(delete(RevenueDayLine).where(RevenueDayLine.day == day))
    rows = [
        {
            "day": day,
            "item_id": ln.item_id,
            "customer_id": ln.customer_id or "",
            "name": ln.name,
            "sku": ln.sku,
            "quantity": ln.quantity,
            "amount": ln.amount,
        }
        for ln in lines
    ]
    for i in range(0, len(rows), LINE_CHUNK_SIZE):
        await db.execute(insert(RevenueDayLine), rows[i : i + LINE_CHUNK_SIZE])
    await db.commit()


async def item_totals(conn: AsyncConnection) -> list[dict]:
    """Per-item totals over the whole cache; `name`/`sku` come from the item's most recent line."""
    t = RevenueDayLine
    agg = (
        select(
            t.item_id,
            func.sum(t.amount).label("total"),
            func.sum(t.quantity).label("qty"),
            func.max(t.day).label("last_day"),
        )
        .group_by(t.item_id)
        .subquery()
    )
    totals = {r.item_id: r for r in await conn.execute(select(agg))}
    latest = await conn.execute(
        select(t.item_id, t.name, t.sku)
        .join(agg, and_(t.item_id == agg.c.item_id, t.day == agg.c.last_day))
        .order_by(t.customer_id)
    )
    names: dict[str, tuple[str, str]] = {}
    for r in latest:
        names.setdefault(r.item_id, (r.name, r.sku))
    return [
        {
            "itemId": item_id,
            "name": names[item_id][0],
            "sku": names[item_id][1],
            "totalHt": r.total,
            "quantity": r.qty,
            "lastDay": r.last_day,
        }
        for item_id, r in totals.items()
    ]


async def clear_revenue_cache(db: AsyncSession) -> None:
    """Days and lines only: decisions, targets, notes and customers are the operator's and survive a rebuild."""
    await db.execute(delete(RevenueDayLine))
    await db.execute(delete(RevenueDay))
    await db.commit()


async def read_decisions(conn: AsyncConnection) -> list[RevenueDecision]:
    rows = await conn.execute(select(RevenueScopeDecision).order_by(RevenueScopeDecision.item_id))
    return [RevenueDecision(r.item_id, bool(r.included), r.decided_at) for r in rows]


async def set_decision(db: AsyncSession, item_id: str, included: bool, now: datetime) -> dict:
    decided_at = now.isoformat()
    row = await db.get(RevenueScopeDecision, item_id)
    if row is None:
        db.add(RevenueScopeDecision(item_id=item_id, included=included, decided_at=decided_at))
    else:
        row.included, row.decided_at = included, decided_at
    await db.commit()
    return {"itemId": item_id, "included": included, "decidedAt": decided_at}


async def clear_decision(db: AsyncSession, item_id: str) -> bool:
    return await _delete_one(db, delete(RevenueScopeDecision).where(RevenueScopeDecision.item_id == item_id))


async def _delete_one(db: AsyncSession, stmt: Any) -> bool:
    result = await db.execute(stmt)
    await db.commit()
    return cast(CursorResult, result).rowcount > 0


async def read_customer_facts(conn: AsyncConnection) -> dict[str, RevenueCustomerFacts]:
    rows = await conn.execute(select(RevenueCustomer).where(RevenueCustomer.found.is_(True)))
    return {r.customer_id: RevenueCustomerFacts(r.customer_id, r.name, r.company_name, r.sub_type) for r in rows}


async def unknown_customer_ids(db: AsyncSession) -> list[str]:
    """Customer ids on stored lines that no lookup has answered yet (found or not): the sync's lookup queue."""
    known = select(RevenueCustomer.customer_id)
    rows = await db.execute(
        select(RevenueDayLine.customer_id)
        .where(RevenueDayLine.customer_id != "", RevenueDayLine.customer_id.not_in(known))
        .distinct()
        .order_by(RevenueDayLine.customer_id)
    )
    return list(rows.scalars())


async def save_customer(db: AsyncSession, customer_id: str, facts: dict | None, now: datetime) -> None:
    """`facts` None means Zoho answered 404: stored as not found, never asked again."""
    fields = {
        "name": facts["name"] if facts else "",
        "company_name": facts["company_name"] if facts else "",
        "sub_type": facts["sub_type"] if facts else None,
        "found": facts is not None,
        "fetched_at": now.isoformat(),
    }
    row = await db.get(RevenueCustomer, customer_id)
    if row is None:
        db.add(RevenueCustomer(customer_id=customer_id, **fields))
    else:
        for k, v in fields.items():
            setattr(row, k, v)
    await db.commit()


async def read_targets(conn: AsyncConnection) -> list[dict]:
    rows = await conn.execute(select(RevenueTarget).order_by(RevenueTarget.month))
    return [{"month": r.month, "amountHt": r.amount_ht, "updatedAt": r.updated_at} for r in rows]


async def set_target(db: AsyncSession, month: str, amount_ht: float, now: datetime) -> dict:
    updated_at = now.isoformat()
    row = await db.get(RevenueTarget, month)
    if row is None:
        db.add(RevenueTarget(month=month, amount_ht=amount_ht, updated_at=updated_at))
    else:
        row.amount_ht, row.updated_at = amount_ht, updated_at
    await db.commit()
    return {"month": month, "amountHt": amount_ht, "updatedAt": updated_at}


async def clear_target(db: AsyncSession, month: str) -> bool:
    return await _delete_one(db, delete(RevenueTarget).where(RevenueTarget.month == month))


async def customer_first_days(conn: AsyncConnection) -> dict[str, str]:
    """Each identified customer's first day in the cache (any item, unfiltered): the "new customer" test."""
    t = RevenueDayLine
    rows = await conn.execute(select(t.customer_id, func.min(t.day)).where(t.customer_id != "").group_by(t.customer_id))
    return dict(rows.tuples().all())


async def read_annotations(conn: AsyncConnection) -> list[dict]:
    t = RevenueAnnotation
    rows = await conn.execute(select(t.id, t.day, t.label).order_by(t.day, t.id))
    return [{"id": r.id, "day": r.day, "label": r.label} for r in rows]


async def add_annotation(db: AsyncSession, day: str, label: str, now: datetime) -> dict:
    row = RevenueAnnotation(day=day, label=label, created_at=now.isoformat())
    db.add(row)
    await db.commit()
    return {"id": row.id, "day": row.day, "label": row.label}


async def delete_annotation(db: AsyncSession, id: int) -> bool:
    return await _delete_one(db, delete(RevenueAnnotation).where(RevenueAnnotation.id == id))


def _blank_to_none(v: str | None) -> str | None:
    return v.strip() or None if v else None


async def read_scope_items(conn: AsyncConnection) -> dict[str, ScopeItem]:
    rows = await conn.execute(select(RevenueItem))
    return {
        r.item_id: ScopeItem(
            item_id=r.item_id,
            name=r.name,
            sku=r.sku,
            brand=_blank_to_none(r.brand),
            nature=_blank_to_none(r.nature),
            item_type=r.item_type,
            tax_percentage=r.tax_percentage,
            unit_cost=unit_cost_of(r.purchase_rate, r.dealer_price),
            status=r.status,
        )
        for r in rows
    }


async def replace_items(db: AsyncSession, items: list[dict], now: datetime) -> None:
    """Swaps the whole item table for a fresh Zoho listing and stamps the refresh; items are dicts of RevenueItem columns."""
    stamp = now.isoformat()
    await db.execute(delete(RevenueItem))
    if items:
        blank = {c.name: None for c in RevenueItem.__table__.columns}
        await db.execute(
            insert(RevenueItem), [{**blank, "name": "", "sku": "", **i, "fetched_at": stamp} for i in items]
        )
    setting = (await db.execute(select(Settings).where(Settings.key == ITEMS_SYNCED_KEY))).scalar_one_or_none()
    if setting is None:
        db.add(Settings(key=ITEMS_SYNCED_KEY, value=stamp))
    else:
        setting.value = stamp
    await db.commit()


async def items_synced_at(conn: AsyncConnection) -> str | None:
    return (await conn.execute(select(Settings.value).where(Settings.key == ITEMS_SYNCED_KEY))).scalar_one_or_none()


async def revenue_data_stamp(conn: AsyncConnection) -> str:
    """A cheap fingerprint of every table the revenue read models depend on; the routes key their memo and ETag on it."""
    parts = []
    for model, col in (
        (RevenueDay, RevenueDay.fetched_at),
        (RevenueScopeDecision, RevenueScopeDecision.decided_at),
        (RevenueTarget, RevenueTarget.updated_at),
        (RevenueCustomer, RevenueCustomer.fetched_at),
        (RevenueAnnotation, RevenueAnnotation.created_at),
        (RevenueItem, RevenueItem.fetched_at),
        # The services' margin reads the print log and the calculator's machine rates.
        (PrintLogEntry, PrintLogEntry.completed_at),
        (CalculatorPrinter, CalculatorPrinter.updated_at),
        (CalculatorDefaults, CalculatorDefaults.updated_at),
    ):
        n, at = (await conn.execute(select(func.count(), func.max(col)).select_from(model))).one()
        parts.append(f"{n}@{at or ''}")
    labor = (await conn.execute(select(Settings.updated_at).where(Settings.key == "revenue_labor"))).scalar()
    parts.append(f"labor@{labor or ''}")
    return "|".join(parts)
