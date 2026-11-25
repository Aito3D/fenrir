"""Persistence for the revenue dashboard: the per-day Zoho cache, scope decisions, customers, targets, notes, items.

Reads take a connection from `snapshot()` (one point in time); writes take the caller's AsyncSession and commit.
"""

import zlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, cast

from sqlalchemy import CursorResult, and_, delete, func, insert, or_, select, update
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, AsyncSession

from backend.app.core import database
from backend.app.models.calculator import CalculatorDefaults, CalculatorFilament, CalculatorPrinter
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.printer import Printer
from backend.app.models.revenue import (
    RevenueAnnotation,
    RevenueCustomer,
    RevenueDay,
    RevenueDayLine,
    RevenueInvoiceShare,
    RevenueItem,
    RevenueMonthCheck,
    RevenuePayment,
    RevenueScopeDecision,
    RevenueTarget,
)
from backend.app.models.settings import Settings
from backend.app.services.revenue.customers import RevenueCustomerFacts
from backend.app.services.revenue.scope import RevenueDecision, ScopeItem, service_nature, unit_cost_of
from backend.app.services.revenue.series import RevenueLine
from backend.app.services.revenue.sync_plan import DayRow

MAX_ANNOTATION_LABEL = 80
LINE_CHUNK_SIZE = 500
ITEMS_SYNCED_KEY = "revenue_items_synced_at"
PAYMENTS_SINCE_KEY = "revenue_payments_since"
CASH_SYNCED_KEY = "revenue_cash_synced_at"


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


def _internal_customers():
    """The shop's own production line (« O'SEA - Aito 3D »): stock it took on zero invoices is a transfer, not a sale,
    and the farm's real consumption is already in the services' print-log cost."""
    name = func.lower(RevenueCustomer.name)
    return select(RevenueCustomer.customer_id).where(or_(name.like("%aito 3d%"), name.like("%aito3d%")))


async def read_lines(conn: AsyncConnection, from_: str, to: str) -> list[RevenueLine]:
    t = RevenueDayLine
    rows = await conn.execute(
        select(t)
        .where(t.day >= from_, t.day <= to, t.customer_id.not_in(_internal_customers()))
        .order_by(t.day, t.item_id, t.customer_id)
    )
    return [
        RevenueLine(
            day=r.day,
            item_id=r.item_id,
            customer_id=r.customer_id,
            name=r.name,
            sku=r.sku,
            quantity=r.quantity,
            amount=r.amount,
            unit_cost=r.unit_cost,
            tax_percentage=r.tax_percentage,
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
            "unit_cost": ln.unit_cost,
            "tax_percentage": ln.tax_percentage,
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
    """Days, lines and their month checks only: decisions, targets, notes and customers are the operator's and survive a rebuild."""
    await db.execute(delete(RevenueDayLine))
    await db.execute(delete(RevenueDay))
    await db.execute(delete(RevenueMonthCheck))
    await db.commit()


async def read_month_checks(conn: AsyncConnection) -> list[dict]:
    """Newest month first."""
    t = RevenueMonthCheck
    rows = await conn.execute(select(t).order_by(t.month.desc()))
    return [
        {"month": r.month, "zohoAmount": r.zoho_amount, "cacheAmount": r.cache_amount, "checkedAt": r.checked_at}
        for r in rows
    ]


async def save_month_check(
    db: AsyncSession, month: str, zoho_amount: float, cache_amount: float, now: datetime
) -> None:
    fields = {"zoho_amount": zoho_amount, "cache_amount": cache_amount, "checked_at": now.isoformat()}
    row = await db.get(RevenueMonthCheck, month)
    if row is None:
        db.add(RevenueMonthCheck(month=month, **fields))
    else:
        for k, v in fields.items():
            setattr(row, k, v)
    await db.commit()


async def month_line_sum(db: AsyncSession, month: str) -> float:
    """Every cached line of the month, all items, no scope."""
    t = RevenueDayLine
    total = await db.execute(select(func.sum(t.amount)).where(t.day >= f"{month}-01", t.day <= f"{month}-31"))
    return total.scalar() or 0.0


async def clear_month(db: AsyncSession, month: str) -> int:
    """Drops a month's days, lines and check so the sync fetches and checks it again; returns the day count.
    Lines go explicitly: SQLite runs with foreign_keys off, so the cascade never fires."""
    first, last = f"{month}-01", f"{month}-31"
    await db.execute(delete(RevenueDayLine).where(RevenueDayLine.day >= first, RevenueDayLine.day <= last))
    result = await db.execute(delete(RevenueDay).where(RevenueDay.day >= first, RevenueDay.day <= last))
    await db.execute(delete(RevenueMonthCheck).where(RevenueMonthCheck.month == month))
    await db.commit()
    return cast(CursorResult, result).rowcount


_decisions_generation = (
    0  # bumped on every scope change; a cash refresh compares it to drop shares it computed too early
)


def _current_decisions_generation() -> int:
    return _decisions_generation


def _bump_decisions_generation() -> None:
    global _decisions_generation
    _decisions_generation += 1


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
    await _forget_invoice_shares(db)
    await db.commit()
    _bump_decisions_generation()
    return {"itemId": item_id, "included": included, "decidedAt": decided_at}


async def clear_decision(db: AsyncSession, item_id: str) -> bool:
    await _forget_invoice_shares(db)
    deleted = await _delete_one(db, delete(RevenueScopeDecision).where(RevenueScopeDecision.item_id == item_id))
    _bump_decisions_generation()
    return deleted


async def _forget_invoice_shares(db: AsyncSession) -> None:
    """A scope decision changes what counts as 3D: the cash step re-reads the invoices it had split."""
    _bump_decisions_generation()
    await db.execute(update(RevenueInvoiceShare).values(share=None, share_total=None))


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


async def customer_item_first_lines(conn: AsyncConnection) -> list[RevenueLine]:
    """Each identified customer's first day per item over the whole cache; scope and filters are folded in Python."""
    t = RevenueDayLine
    rows = await conn.execute(
        select(t.customer_id, t.item_id, func.min(t.day))
        .where(t.customer_id != "", t.customer_id.not_in(_internal_customers()))
        .group_by(t.customer_id, t.item_id)
    )
    return [RevenueLine(day=d, item_id=i, customer_id=c, name="", sku="", quantity=0, amount=0) for c, i, d in rows]


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
            nature=service_nature(r.name, r.item_type, _blank_to_none(r.nature)),
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
    # Only these columns reach classify_revenue_item (name and item_type via service_nature); a change invalidates shares.
    cols = (RevenueItem.item_id, RevenueItem.nature, RevenueItem.brand, RevenueItem.name, RevenueItem.item_type)
    old = set((await db.execute(select(*cols))).all())
    if old != {(i["item_id"], i.get("nature"), i.get("brand"), i.get("name", ""), i.get("item_type")) for i in items}:
        await _forget_invoice_shares(db)
    await db.execute(delete(RevenueItem))
    if items:
        blank = {c.name: None for c in RevenueItem.__table__.columns}
        await db.execute(
            insert(RevenueItem), [{**blank, "name": "", "sku": "", **i, "fetched_at": stamp} for i in items]
        )
    await _put_setting(db, ITEMS_SYNCED_KEY, stamp)
    await db.commit()


async def _put_setting(db: AsyncSession, key: str, value: str) -> None:
    setting = (await db.execute(select(Settings).where(Settings.key == key))).scalar_one_or_none()
    if setting is None:
        db.add(Settings(key=key, value=value))
    else:
        setting.value = value


async def get_setting(conn: AsyncConnection, key: str) -> str | None:
    return (await conn.execute(select(Settings.value).where(Settings.key == key))).scalar_one_or_none()


async def items_synced_at(conn: AsyncConnection) -> str | None:
    return await get_setting(conn, ITEMS_SYNCED_KEY)


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
        (RevenueMonthCheck, RevenueMonthCheck.checked_at),
        # The services' margin reads the print log, the calculator's machine rates, filament prices and printer names.
        (PrintLogEntry, PrintLogEntry.completed_at),
        (CalculatorPrinter, CalculatorPrinter.updated_at),
        (CalculatorDefaults, CalculatorDefaults.updated_at),
        (CalculatorFilament, CalculatorFilament.updated_at),
        (Printer, Printer.updated_at),
    ):
        n, at = (await conn.execute(select(func.count(), func.max(col)).select_from(model))).one()
        parts.append(f"{n}@{at or ''}")
    # Both lists feed the daily margin.
    for key in ("revenue_labor", "revenue_fixed_costs"):
        at = (await conn.execute(select(Settings.updated_at).where(Settings.key == key))).scalar()
        parts.append(f"{key}@{at or ''}")
    # The selected Zoho assets feed it too. Its value, not its timestamp: two saves can share a second.
    parts.append(f"dep@{zlib.crc32((await get_setting(conn, 'revenue_depreciation') or '').encode())}")
    return "|".join(parts)


# ── cash: payments and invoice balances (not cleared by a rebuild: they do not come from the day cache) ──


async def customer_item_pairs(conn: AsyncConnection) -> list[tuple[str, str]]:
    """Every (customer, item) pair in the whole cache: the input of the cash classification."""
    t = RevenueDayLine
    rows = await conn.execute(select(t.customer_id, t.item_id).where(t.customer_id != "").distinct())
    return [(r.customer_id, r.item_id) for r in rows]


async def read_payments(conn: AsyncConnection, from_: str) -> list[dict]:
    t = RevenuePayment
    rows = await conn.execute(select(t).where(t.date >= from_).order_by(t.date, t.payment_id))
    return [
        {
            "paymentId": r.payment_id,
            "customerId": r.customer_id,
            "date": r.date,
            "amount": r.amount,
            "unapplied": r.unapplied,
            "applications": r.applications,
        }
        for r in rows
    ]


async def read_invoice_shares(conn: AsyncConnection) -> list[dict]:
    t = RevenueInvoiceShare
    rows = await conn.execute(select(t).order_by(t.date, t.invoice_id))
    return [
        {
            "invoiceId": r.invoice_id,
            "number": r.number,
            "customerId": r.customer_id,
            "customerName": r.customer_name,
            "date": r.date,
            "dueDate": r.due_date,
            "total": r.total,
            "balance": r.balance,
            "share": r.share,
        }
        for r in rows
    ]


async def save_payments(db: AsyncSession, rows: list[dict], cursor: str | None, now: datetime) -> None:
    """Upserts listed payments (dicts of RevenuePayment columns) and moves the listing cursor in the same commit.
    A payment Zoho touched again drops its applications, so they are read again."""
    stamp = now.isoformat()
    ids = [r["payment_id"] for r in rows]
    existing = {
        p.payment_id: p
        for p in (await db.execute(select(RevenuePayment).where(RevenuePayment.payment_id.in_(ids)))).scalars()
    }
    for r in rows:
        p = existing.get(r["payment_id"])
        if p is None:
            p = RevenuePayment(payment_id=r["payment_id"], applications=None)
            db.add(p)
            existing[r["payment_id"]] = p
        elif p.last_modified_time != r["last_modified_time"]:
            p.applications = None
        for k, v in r.items():
            setattr(p, k, v)
        p.fetched_at = stamp
    if cursor:
        await _put_setting(db, PAYMENTS_SINCE_KEY, cursor)
    await db.commit()


async def save_payment_applications(
    db: AsyncSession, payment_id: str, applications: list[dict], unapplied: float, now: datetime
) -> None:
    await db.execute(
        update(RevenuePayment)
        .where(RevenuePayment.payment_id == payment_id)
        .values(applications=applications, unapplied=unapplied, fetched_at=now.isoformat())
    )
    await db.commit()


async def delete_payment(db: AsyncSession, payment_id: str) -> None:
    await _delete_one(db, delete(RevenuePayment).where(RevenuePayment.payment_id == payment_id))


async def save_unpaid_invoices(db: AsyncSession, rows: list[dict], zero_missing: bool, now: datetime) -> None:
    """Upserts the unpaid listings' invoices with their current balance; a total that moved forgets the share.
    With `zero_missing` (no listing was cut short), a stored invoice none of them returned is paid."""
    stamp = now.isoformat()
    ids = [r["invoice_id"] for r in rows]
    t = RevenueInvoiceShare
    existing = {i.invoice_id: i for i in (await db.execute(select(t).where(t.invoice_id.in_(ids)))).scalars()}
    for r in rows:
        inv = existing.get(r["invoice_id"])
        if inv is None:
            inv = RevenueInvoiceShare(invoice_id=r["invoice_id"], share=None, share_total=None)
            db.add(inv)
            existing[r["invoice_id"]] = inv
        elif inv.share_total != r["total"]:
            inv.share = None
        for k, v in r.items():
            setattr(inv, k, v)
        inv.fetched_at = stamp
    if zero_missing:
        await db.execute(update(t).where(t.balance > 0, t.invoice_id.not_in(ids)).values(balance=0.0, fetched_at=stamp))
    await db.commit()


async def save_invoice_detail(db: AsyncSession, row: dict, now: datetime, generation: int | None = None) -> None:
    """One read invoice (dict of RevenueInvoiceShare columns, `share` included); the share is pinned to its total.

    A `generation` that is no longer current means the scope changed while the share was computed: it stays queued.
    """
    inv = await db.get(RevenueInvoiceShare, row["invoice_id"])
    if inv is None:
        inv = RevenueInvoiceShare(invoice_id=row["invoice_id"])
        db.add(inv)
    for k, v in row.items():
        setattr(inv, k, v)
    inv.share_total = row["total"]
    inv.fetched_at = now.isoformat()
    # Once flushed this session holds the write lock, so a later scope change forgets after our commit; check here.
    await db.flush()
    if generation is not None and generation != _decisions_generation:
        inv.share = inv.share_total = None
    await db.commit()


async def save_cash_synced(db: AsyncSession, now: datetime) -> None:
    await _put_setting(db, CASH_SYNCED_KEY, now.isoformat())
    await db.commit()


async def cash_stamp(conn: AsyncConnection) -> str:
    parts = []
    for model, col in (
        (RevenuePayment, RevenuePayment.fetched_at),
        (RevenueInvoiceShare, RevenueInvoiceShare.fetched_at),
    ):
        n, at = (await conn.execute(select(func.count(), func.max(col)).select_from(model))).one()
        parts.append(f"{n}@{at or ''}")
    for key in (PAYMENTS_SINCE_KEY, CASH_SYNCED_KEY):
        parts.append(await get_setting(conn, key) or "")
    return "|".join(parts)
