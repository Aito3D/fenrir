"""Revenue dashboard read endpoints. Camel-case plain dicts (loki's shapes); the only Zoho call is the
fixed-asset refresh the operator asks for."""

import asyncio
import logging
import math
import re
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any, Literal, TypeVar, cast

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import async_sessionmaker

from backend.app.core import database
from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.permissions import Permission
from backend.app.models.user import User
from backend.app.services.revenue import (
    analysis,
    cash,
    cohorts,
    fixed_accounts,
    insights,
    memo,
    pipeline,
    production,
    products,
    result,
    series,
    store,
    sync,
)
from backend.app.services.revenue.config import REVENUE_GRANULARITIES, REVENUE_HISTORY_START
from backend.app.services.revenue.customers import customer_display_name
from backend.app.services.revenue.dates import add_days, days_between, days_in_month, is_valid_day, org_today
from backend.app.services.revenue.insights import attach_targets, calendar_days, yoy_pivot
from backend.app.services.revenue.scope import ITEM_ID_RE, build_review_list
from backend.app.services.revenue.series import LineFilters, js_round
from backend.app.services.revenue.sync_plan import month_window
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoUpstreamError, zoho_service

router = APIRouter(prefix="/revenue", tags=["revenue"])

_FROM_TO_ERROR = "from/to must be yyyy-MM-dd"
COMPARE_SHOWN = 10
SYNC_TIMEOUT_S = 60
_ANNOTATION_ID_RE = re.compile(r"[0-9]{1,12}")
_AMOUNT_ERROR = "amountHt must be a number between 0 and 10^12"

logger = logging.getLogger(__name__)


def _unprocessable(message: str) -> HTTPException:
    return HTTPException(status_code=422, detail=message)


def _filters(
    flags: memo.CallerFlags, items: str | None, brand: list[str], kind: str | None, segment: str | None
) -> LineFilters:
    try:
        filters = products.parse_series_filters(items, brand, kind, segment)
    except products.FilterError as e:
        raise _unprocessable(e.message) from None
    if filters.segment and not flags.customers:
        raise HTTPException(status_code=403, detail="Missing permission: revenue:view_customers")
    return filters


def _ordered_range(from_: str, to: str) -> None:
    if not is_valid_day(from_) or not is_valid_day(to) or from_ > to:
        raise _unprocessable("from/to must be yyyy-MM-dd with from ≤ to")


async def _respond(
    request: Request,
    user: User | None,
    build: Callable[..., Awaitable[dict]],
    *,
    live_sync: bool = False,
    flags: memo.CallerFlags | None = None,
    now: datetime,
    extra_stamp: Callable[..., Awaitable[str]] | None = None,
) -> Response:
    """One snapshot per request: it computes the stamp and then feeds the build."""
    flags = flags or memo.caller_flags(user)
    sync.ensure_revenue_sync_loop()
    async with store.snapshot() as conn:
        stamp = f"{await store.revenue_data_stamp(conn)}|{await store.items_synced_at(conn)}|{org_today(now)}"
        status = None
        if live_sync:
            status = await sync.get_revenue_sync_status(conn, now)
            stamp += f"|{status}"
        if extra_stamp is not None:
            stamp += f"|{await extra_stamp(conn)}"
        if flags.margin and (
            await production.read_fixed_accounts(conn)
            or await production.read_labor(conn)
            or production.selected_assets(await production.read_depreciation(conn))
        ):
            # Fixed costs, depreciation and today's labour grow by the minute, and so does the margin.
            stamp += f"|{now:%H:%M}"
        return await memo.revenue_json(request, flags, stamp, lambda: _timed_build(request, build(conn, now, status)))


SLOW_BUILD_S = 0.2


async def _timed_build(request: Request, pending: Awaitable[dict]) -> dict:
    """Read models are built on the event loop (80-150 ms on the dev Mac, 2026-11-20); this logs when that stops holding."""
    started = time.perf_counter()
    body = await pending
    elapsed = time.perf_counter() - started
    if elapsed > SLOW_BUILD_S:
        logger.warning(
            "Revenue read model %s took %d ms; move its build to asyncio.to_thread", request.url.path, elapsed * 1000
        )
    return body


async def _context(conn, from_: str, to: str) -> dict:
    return {
        "lines": await store.read_lines(conn, from_, to),
        "fetched_days": [d.day for d in await store.read_days(conn, from_, to)],
        "items": await store.read_scope_items(conn),
        "decisions": await store.read_decisions(conn),
        "customers": await store.read_customer_facts(conn),
    }


@router.get("")
async def get_revenue(
    request: Request,
    granularity: str = "month",
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    items: str | None = None,
    brand: list[str] = Query(default=[]),
    kind: str | None = None,
    segment: str | None = None,
    preset: str | None = None,
    user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ),
):
    if granularity not in REVENUE_GRANULARITIES:
        raise _unprocessable("granularity must be day, week, month, quarter or year")
    now = datetime.now(timezone.utc)
    today = org_today(now)
    if (from_ and not is_valid_day(from_)) or (to and not is_valid_day(to)):
        raise _unprocessable(_FROM_TO_ERROR)
    flags = memo.caller_flags(user)
    filters = _filters(flags, items, brand, kind, segment)
    base = (
        series.range_preset(cast(series.RangePresetId, preset), today, REVENUE_HISTORY_START)
        if preset in series.RANGE_PRESETS
        else series.default_range(granularity, today, REVENUE_HISTORY_START)
    )
    clamped_from, clamped_to = series.clamp_range(
        from_ if from_ is not None else base[0], to if to is not None else base[1], REVENUE_HISTORY_START, today
    )
    end = series.snap_to_bucket_end(clamped_to, granularity, today)

    async def build(conn, now, status):
        line_from, line_to = series.series_line_range(granularity, clamped_from, end, REVENUE_HISTORY_START)
        ctx = await _context(conn, line_from, line_to)
        scope_items = ctx["items"]
        buckets = series.build_revenue_series(
            **ctx,
            granularity=granularity,
            from_=clamped_from,
            to=end,
            today=today,
            history_start=REVENUE_HISTORY_START,
            filters=filters,
            production=await production.read_production_costs(conn, today, now) if flags.margin else None,
        )
        if not series.is_filtered(filters):
            buckets = attach_targets(buckets, granularity, await store.read_targets(conn))
        totals = await store.item_totals(conn)
        review = build_review_list(totals, scope_items, ctx["decisions"])
        return {
            "granularity": granularity,
            "from": clamped_from,
            "to": end,
            "items": sorted(filters.item_ids) if filters.item_ids else None,
            "brands": sorted(filters.brands) if filters.brands else None,
            "kind": filters.kind,
            "segment": filters.segment,
            "buckets": buckets,
            "sync": status,
            "reviewCount": len(review["unclassified"]),
            "itemsSyncedAt": await store.items_synced_at(conn),
            "fetchedAt": now.isoformat(),
        }

    return await _respond(request, user, build, live_sync=True, flags=flags, now=now)


@router.get("/items")
async def get_items(
    request: Request,
    from_: str = Query("", alias="from"),
    to: str = "",
    items: str | None = None,
    brand: list[str] = Query(default=[]),
    kind: str | None = None,
    segment: str | None = None,
    user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ),
):
    now = datetime.now(timezone.utc)
    _ordered_range(from_, to)
    flags = memo.caller_flags(user)
    filters = _filters(flags, items, brand, kind, segment)

    async def build(conn, _now, _status):
        ctx = await _context(conn, from_, to)
        rows = series.item_breakdown(ctx["lines"], ctx["items"], ctx["decisions"], ctx["customers"], filters)
        return {"items": rows, "from": from_, "to": to}

    return await _respond(request, user, build, flags=flags, now=now)


@router.get("/products")
async def get_products(request: Request, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ)):
    async def build(conn, now, _status):
        rows = products.build_product_list(
            await store.item_totals(conn), await store.read_scope_items(conn), await store.read_decisions(conn)
        )
        return {"products": rows, "fetchedAt": now.isoformat()}

    return await _respond(request, user, build, now=datetime.now(timezone.utc))


@router.get("/review")
async def get_review(request: Request, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ)):
    async def build(conn, _now, _status):
        return build_review_list(
            await store.item_totals(conn), await store.read_scope_items(conn), await store.read_decisions(conn)
        )

    return await _respond(request, user, build, now=datetime.now(timezone.utc))


@router.get("/sync")
async def get_sync(request: Request, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ)):
    async def build(_conn, _now, status):
        return {"sync": status}

    return await _respond(request, user, build, live_sync=True, now=datetime.now(timezone.utc))


@router.get("/yoy")
async def get_yoy(
    request: Request,
    items: str | None = None,
    brand: list[str] = Query(default=[]),
    kind: str | None = None,
    segment: str | None = None,
    user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ),
):
    flags = memo.caller_flags(user)
    filters = _filters(flags, items, brand, kind, segment)
    now = datetime.now(timezone.utc)
    today = org_today(now)

    async def build(conn, _now, _status):
        ctx = await _context(conn, REVENUE_HISTORY_START, today)
        buckets = series.build_revenue_series(
            **ctx,
            granularity="month",
            from_=REVENUE_HISTORY_START,
            to=today,
            today=today,
            history_start=REVENUE_HISTORY_START,
            filters=filters,
        )
        return {"years": yoy_pivot(buckets), "today": today}

    return await _respond(request, user, build, flags=flags, now=now)


@router.get("/daily")
async def get_daily(
    request: Request,
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    items: str | None = None,
    brand: list[str] = Query(default=[]),
    kind: str | None = None,
    segment: str | None = None,
    user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ),
):
    now = datetime.now(timezone.utc)
    today = org_today(now)
    if (from_ and not is_valid_day(from_)) or (to and not is_valid_day(to)):
        raise _unprocessable(_FROM_TO_ERROR)
    flags = memo.caller_flags(user)
    filters = _filters(flags, items, brand, kind, segment)
    start, end = series.clamp_range(
        from_ if from_ is not None else add_days(today, -364),
        to if to is not None else today,
        REVENUE_HISTORY_START,
        today,
    )

    async def build(conn, _now, _status):
        ctx = await _context(conn, start, end)
        buckets = series.build_revenue_series(
            **ctx,
            granularity="day",
            from_=start,
            to=end,
            today=today,
            history_start=REVENUE_HISTORY_START,
            filters=filters,
        )
        return {"from": start, "to": end, "days": calendar_days(buckets)}

    return await _respond(request, user, build, flags=flags, now=now)


@router.get("/targets")
async def get_targets(request: Request, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ)):
    async def build(conn, _now, _status):
        return {"targets": await store.read_targets(conn)}

    return await _respond(request, user, build, now=datetime.now(timezone.utc))


@router.get("/annotations")
async def get_annotations(
    request: Request, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ)
):
    async def build(conn, _now, _status):
        return {"annotations": await store.read_annotations(conn)}

    return await _respond(request, user, build, now=datetime.now(timezone.utc))


CHECK_TOLERANCE = 1  # XPF has no decimals; Zoho and the cache may round a line apart


@router.get("/checks")
async def get_checks(request: Request, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ)):
    async def build(conn, _now, _status):
        rows = []
        for c in await store.read_month_checks(conn):
            gap = js_round(c["zohoAmount"] - c["cacheAmount"])
            rows.append(
                {
                    "month": c["month"],
                    "zohoHt": js_round(c["zohoAmount"]),
                    "cacheHt": js_round(c["cacheAmount"]),
                    "gap": gap,
                    "ok": abs(gap) <= CHECK_TOLERANCE,
                    "checkedAt": c["checkedAt"],
                }
            )
        return {"checks": rows}

    return await _respond(request, user, build, now=datetime.now(timezone.utc))


@router.get("/customers")
async def get_customers(
    request: Request,
    from_: str = Query("", alias="from"),
    to: str = "",
    items: str | None = None,
    brand: list[str] = Query(default=[]),
    kind: str | None = None,
    segment: str | None = None,
    granularity: str = "month",
    user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ, Permission.REVENUE_VIEW_CUSTOMERS),
):
    now = datetime.now(timezone.utc)
    _ordered_range(from_, to)
    start, end = series.clamp_range(from_, to, REVENUE_HISTORY_START, org_today(now))
    if granularity not in REVENUE_GRANULARITIES:
        raise _unprocessable("granularity must be day, week, month, quarter or year")
    flags = memo.caller_flags(user)
    filters = _filters(flags, items, brand, kind, segment)

    async def build(conn, _now, _status):
        ctx = await _context(conn, start, end)
        scope = (ctx["items"], ctx["decisions"], ctx["customers"], filters)
        # "New" means first purchase of what the page shows: a 2025 print customer is new to filament this month.
        first_days = insights.first_days_in_scope(await store.customer_item_first_lines(conn), *scope)
        result = insights.customer_breakdown(ctx["lines"], *scope, first_days, start)
        retention = insights.retention_series(
            ctx["lines"], *scope, first_days, cast(series.Granularity, granularity), start, end
        )
        return {"from": start, "to": end, **result, "retention": retention}

    return await _respond(request, user, build, flags=flags, now=now)


@router.get("/cohorts")
async def get_cohorts(
    request: Request,
    user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ, Permission.REVENUE_VIEW_CUSTOMERS),
):
    """Cohorts by first purchase, 12-month value by segment and customers gone quiet: identified customers only."""
    now = datetime.now(timezone.utc)
    today = org_today(now)

    async def build(conn, _now, _status):
        ctx = await _context(conn, REVENUE_HISTORY_START, today)
        purchases, segments, names = [], {}, {}
        matched = series.matching_lines(ctx["lines"], ctx["items"], ctx["decisions"], ctx["customers"], LineFilters())
        for m in matched:
            customer = m.line.customer_id
            # The walk-in account is many people: nobody to follow.
            if not customer or m.segment == "passage":
                continue
            purchases.append((customer, m.line.day, m.line.amount))
            if customer not in segments:
                segments[customer] = m.segment
                names[customer] = customer_display_name(customer, ctx["customers"].get(customer))
        return cohorts.build_cohorts(purchases, segments, names, today)

    return await _respond(request, user, build, now=now)


@router.get("/cash")
async def get_cash(request: Request, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ)):
    """Collected vs invoiced per month and what is owed now, 3D share only; topOverdue needs view_customers."""
    now = datetime.now(timezone.utc)
    today = org_today(now)
    months = cash.last_months(today)
    start = f"{months[0]}-01"

    async def stamp(conn) -> str:
        return f"{await store.cash_stamp(conn)}|{sync.cash_error()}|{await pipeline.pipeline_stamp(conn)}"

    async def build(conn, _now, _status):
        items = await store.read_scope_items(conn)
        decisions = await store.read_decisions(conn)
        lines = await store.read_lines(conn, start, today)
        return cash.build_cash(
            invoiced_ttc_90d=cash.invoiced_ttc_since(lines, items, decisions, add_days(today, -cash.DSO_DAYS)),
            orders=cash.accepted_open(await pipeline.read_cards(conn)),
            payments=await store.read_payments(conn, start),
            invoices=await store.read_invoice_shares(conn),
            classes=cash.classify_customers(await store.customer_item_pairs(conn), items, decisions),
            invoiced_ttc=cash.invoiced_ttc_by_month(lines, items, decisions),
            months=months,
            today=today,
            synced_at=await store.get_setting(conn, store.CASH_SYNCED_KEY),
            error=sync.cash_error(),
        )

    return await _respond(request, user, build, now=now, extra_stamp=stamp)


@router.get("/pipeline")
async def get_pipeline(request: Request, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ)):
    """Order book from the Aito board: accepted quotes not invoiced yet, sent quotes awaiting an answer."""
    now = datetime.now(timezone.utc)

    async def build(conn, now, _status):
        return pipeline.build_pipeline(await pipeline.read_cards(conn), now.replace(tzinfo=None))

    return await _respond(request, user, build, now=now, extra_stamp=pipeline.pipeline_stamp)


@router.get("/funnel")
async def get_funnel(request: Request, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ)):
    """What became of the quotes sent from the Aito board in the last 12 months."""
    now = datetime.now(timezone.utc)

    async def build(conn, now, _status):
        return pipeline.build_funnel(await pipeline.read_funnel_cards(conn), now.replace(tzinfo=None))

    return await _respond(request, user, build, now=now, extra_stamp=pipeline.pipeline_stamp)


def _breakdown(ctx: dict, lines: list, filters: LineFilters) -> list[dict]:
    return series.item_breakdown(lines, ctx["items"], ctx["decisions"], ctx["customers"], filters)


@router.get("/movers")
async def get_movers(
    request: Request,
    granularity: str = "month",
    key: str | None = None,
    from_: str | None = Query(None, alias="from"),
    to: str | None = None,
    cfrom: str | None = None,
    cto: str | None = None,
    items: str | None = None,
    brand: list[str] = Query(default=[]),
    kind: str | None = None,
    segment: str | None = None,
    user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ),
):
    now = datetime.now(timezone.utc)
    today = org_today(now)
    flags = memo.caller_flags(user)
    free = cfrom is not None
    if free:
        days = [from_ or "", to or "", cfrom or "", cto or ""]
        if not all(is_valid_day(d) for d in days) or days[0] > days[1] or days[2] > days[3]:
            raise _unprocessable("from/to/cfrom/cto must be yyyy-MM-dd with from ≤ to and cfrom ≤ cto")
        ranges = {"current": {"from": days[0], "to": days[1]}, "previous": {"from": days[2], "to": days[3]}}
    else:
        if granularity not in REVENUE_GRANULARITIES:
            raise _unprocessable("granularity must be day, week, month, quarter or year")
        key = key or series.bucket_key_for(today, granularity)
        try:
            start, end = series.bucket_range(key, granularity) if series.is_bucket_key(key, granularity) else ("", "")
        except ValueError:
            start = end = ""
        if (
            not is_valid_day(start)
            or series.bucket_key_for(start, granularity) != key
            or start > today
            or end < REVENUE_HISTORY_START
        ):
            raise _unprocessable("key is not a bucket of this granularity inside the history")
        ranges = insights.mover_ranges(key, granularity, today)
    filters = _filters(flags, items, brand, kind, segment)

    async def build(conn, _now, _status):
        cur, prev = ranges["current"], ranges["previous"]
        ctx = await _context(conn, min(cur["from"], prev["from"]), max(cur["to"], prev["to"]))

        def lines_in(r: dict) -> list:
            return [x for x in ctx["lines"] if r["from"] <= x.day <= r["to"]]

        def by_customer(r: dict) -> dict:
            return insights.customer_totals(lines_in(r), ctx["items"], ctx["decisions"], ctx["customers"], filters)

        shown = COMPARE_SHOWN if free else insights.MOVERS_SHOWN
        # Built for every caller and stripped (memo._CUSTOMER_KEYS) for one without revenue:view_customers.
        moved = insights.compute_movers(
            _breakdown(ctx, lines_in(cur), filters),
            _breakdown(ctx, lines_in(prev), filters),
            ranges,
            shown,
            (by_customer(cur), by_customer(prev)),
        )
        return {"granularity": None if free else granularity, "key": None if free else key, **moved}

    return await _respond(request, user, build, flags=flags, now=now)


@router.get("/pvm")
async def get_pvm(
    request: Request,
    from_: str = Query("", alias="from"),
    to: str = "",
    items: str | None = None,
    brand: list[str] = Query(default=[]),
    kind: str | None = None,
    segment: str | None = None,
    user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ),
):
    """Price / volume / mix bridge between the period and the one of the same length just before it."""
    _ordered_range(from_, to)
    if from_ < REVENUE_HISTORY_START:  # also keeps add_days below inside the calendar
        raise _unprocessable(f"from must be yyyy-MM-dd from {REVENUE_HISTORY_START}")
    flags = memo.caller_flags(user)
    filters = _filters(flags, items, brand, kind, segment)
    prev_to = add_days(from_, -1)
    prev_from = add_days(from_, -days_between(from_, to))
    # A period before the history would read as "everything is new".
    comparable = prev_from >= REVENUE_HISTORY_START

    async def build(conn, _now, _status):
        ctx = await _context(conn, prev_from if comparable else from_, to)

        def rows(a: str, b: str) -> list[dict]:
            return _breakdown(ctx, [x for x in ctx["lines"] if a <= x.day <= b], filters)

        cur = rows(from_, to)
        bridge = analysis.price_volume_mix(cur, rows(prev_from, prev_to) if comparable else cur)
        if not comparable:
            bridge["items"] = []
        period = {"from": from_, "to": to, "previousFrom": prev_from, "previousTo": prev_to}
        return {"comparable": comparable, **period, **bridge}

    return await _respond(request, user, build, flags=flags, now=datetime.now(timezone.utc))


@router.get("/analysis")
async def get_analysis(
    request: Request,
    from_: str = Query("", alias="from"),
    to: str = "",
    items: str | None = None,
    brand: list[str] = Query(default=[]),
    kind: str | None = None,
    segment: str | None = None,
    user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ),
):
    now = datetime.now(timezone.utc)
    today = org_today(now)
    _ordered_range(from_, to)
    flags = memo.caller_flags(user)
    filters = _filters(flags, items, brand, kind, segment)
    start, end = series.clamp_range(from_, to, REVENUE_HISTORY_START, today)

    async def build(conn, _now, _status):
        ctx = await _context(conn, start, end)
        rows = _breakdown(ctx, ctx["lines"], filters)
        dr = analysis.dormant_ranges(today)
        year = await _context(conn, dr["before"]["from"], dr["recent"]["to"])
        last_days: dict[str, str] = {}
        for line in year["lines"]:
            if line.amount > 0 and last_days.get(line.item_id, "") < line.day:
                last_days[line.item_id] = line.day

        def dormant_rows(r: dict) -> list[dict]:
            return _breakdown(year, [x for x in year["lines"] if r["from"] <= x.day <= r["to"]], filters)

        return {
            "from": start,
            "to": end,
            "abc": analysis.abc_analysis(rows),
            "marginByBrand": analysis.margin_by(rows, "brand"),
            "marginByNature": analysis.margin_by(rows, "nature"),
            "dormant": analysis.dormant_items(dormant_rows(dr["before"]), dormant_rows(dr["recent"]), last_days),
        }

    return await _respond(request, user, build, flags=flags, now=now)


_M = TypeVar("_M", bound=BaseModel)


class ScopeBody(BaseModel):
    included: Any = None


class TargetBody(BaseModel):
    amountHt: Any = None  # noqa: N815 - loki's field name


class LaborProvider(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    hourlyRate: float = Field(ge=0, le=1e7)  # noqa: N815 - the page's camelCase
    hoursPerDay: float = Field(ge=0, le=24)  # noqa: N815
    daysPerWeek: int = Field(ge=1, le=7)  # noqa: N815
    since: str | None = None


class LaborBody(BaseModel):
    providers: list[LaborProvider] = Field(max_length=100)


class FixedAccountShare(BaseModel):
    percent: float = Field(ge=0, le=100)
    type: Literal["monthly", "annual", "one_off"]
    goodsShare: float = Field(ge=0, le=100)  # noqa: N815 - the page's camelCase


class FixedAccountsBody(BaseModel):
    accounts: dict[str, FixedAccountShare] = Field(max_length=500)


class DepreciationBody(BaseModel):
    selected: list[str] = Field(max_length=500)


class AnnotationBody(BaseModel):
    day: Any = None
    label: Any = None


async def _body(request: Request, model: type[_M]) -> _M:
    """Lenient parse: a malformed or non-object body becomes an empty model, so the handler's own message applies."""
    try:
        raw = await request.json()
    except (ValueError, RecursionError):
        raw = None
    return model.model_validate(raw if isinstance(raw, dict) else {})


def _unencodable(text: str) -> bool:
    try:
        text.encode()
    except UnicodeEncodeError:
        return True
    return False


def _writer() -> async_sessionmaker:
    return async_sessionmaker(database.engine, expire_on_commit=False)


def _check_item_id(item_id: str) -> None:
    if not ITEM_ID_RE.fullmatch(item_id):
        raise _unprocessable("malformed itemId")


def _check_month(month: str) -> None:
    if not insights.is_target_month(month):
        raise _unprocessable("month must be yyyy-MM")


@router.put("/scope/{item_id}")
async def put_scope(
    item_id: str, request: Request, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_MANAGE_SCOPE)
):
    _check_item_id(item_id)
    included = (await _body(request, ScopeBody)).included
    if not isinstance(included, bool):
        raise _unprocessable("body must be { included: boolean }")
    async with _writer()() as db:
        return {"decision": await store.set_decision(db, item_id, included, datetime.now(timezone.utc))}


@router.delete("/scope/{item_id}")
async def delete_scope(
    item_id: str, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_MANAGE_SCOPE)
):
    _check_item_id(item_id)
    async with _writer()() as db:
        return {"cleared": await store.clear_decision(db, item_id)}


@router.put("/targets/{month}")
async def put_target(
    month: str, request: Request, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_MANAGE_TARGETS)
):
    _check_month(month)
    amount = insights.parse_target_amount((await _body(request, TargetBody)).amountHt)
    if amount is None:
        raise _unprocessable(_AMOUNT_ERROR)
    async with _writer()() as db:
        return {"target": await store.set_target(db, month, amount, datetime.now(timezone.utc))}


@router.delete("/targets/{month}")
async def delete_target(
    month: str, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_MANAGE_TARGETS)
):
    _check_month(month)
    async with _writer()() as db:
        return {"cleared": await store.clear_target(db, month)}


@router.get("/labor")
async def get_labor(
    user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ, Permission.REVENUE_VIEW_MARGIN),
):
    async with store.snapshot() as conn:
        return {"providers": await production.read_labor(conn)}


@router.put("/labor")
async def put_labor(
    body: LaborBody,
    # Wages are margin data: editing them takes the margin view and the targets right.
    user: User | None = RequirePermissionIfAuthEnabled(
        Permission.REVENUE_VIEW_MARGIN, Permission.REVENUE_MANAGE_TARGETS
    ),
):
    providers = [p.model_dump() for p in body.providers]
    for p in providers:
        if p["since"] is not None and not is_valid_day(p["since"]):
            raise _unprocessable("since must be yyyy-MM-dd")
        p["name"] = p["name"].strip()
    async with _writer()() as db:
        return {"providers": await production.save_labor(db, providers)}


@router.get("/result")
async def get_result(
    request: Request,
    user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ, Permission.REVENUE_VIEW_MARGIN),
):
    """Operating result of the last 12 months and the current month's break-even."""
    now = datetime.now(timezone.utc)
    today = org_today(now)
    start = max(f"{cash.last_months(today, 12)[0]}-01", REVENUE_HISTORY_START)

    async def stamp(conn) -> str:
        keys = (
            production.FIXED_ACCOUNTS_KEY,
            production.FIXED_ACCOUNTS_CACHE_KEY,
            production.LABOR_KEY,
            production.DEPRECIATION_KEY,
        )
        return "|".join([str(await store.get_setting(conn, k)) for k in keys])

    async def build(conn, _now, _status):
        ctx = await _context(conn, start, today)
        costs = await production.read_production_costs(conn, today, now)

        def buckets(granularity: str, from_: str) -> list[dict]:
            return series.build_revenue_series(
                **ctx,
                granularity=cast(series.Granularity, granularity),
                from_=from_,
                to=today,
                today=today,
                history_start=REVENUE_HISTORY_START,
                production=costs,
            )

        charges = await production.read_fixed_charges(conn, today)
        fixed = {m: (c.real, c.estimated) for m, c in charges.items()}
        month_start = f"{today[:7]}-01"
        next_month = add_days(month_start, days_in_month(int(today[:4]), int(today[5:7])))
        # The whole month's labour, days still to come included.
        labor = sum(production.labor_by_day(await production.read_labor(conn), next_month, month_start).values())
        assets = production.selected_assets(await production.read_depreciation(conn))
        return result.build_result(
            buckets("month", start),
            buckets("day", month_start),
            fixed,
            today,
            labor,
            costs.first_day,
            production.day_shares(now)[0],
            sum(production.depreciation_by_day(assets, next_month, month_start).values()),
            charges[today[:7]].goods if today[:7] in charges else 0.0,
        )

    return await _respond(request, user, build, now=now, extra_stamp=stamp)


@router.get("/depreciation")
async def get_depreciation(
    user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ, Permission.REVENUE_VIEW_MARGIN),
):
    async with store.snapshot() as conn:
        return await production.read_depreciation(conn)


def _number(value: Any) -> float | None:
    """A Zoho figure as a finite number, or None: the stored list is computed on at every margin read."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


# Same rights as the fixed costs: charges are margin data.
_MANAGE_CHARGES = (Permission.REVENUE_VIEW_MARGIN, Permission.REVENUE_MANAGE_TARGETS)


@router.post("/depreciation/refresh")
async def refresh_depreciation(user: User | None = RequirePermissionIfAuthEnabled(*_MANAGE_CHARGES)):
    """Re-read Zoho's fixed assets. Zoho is asked first: a failure leaves the stored list and selection as they are."""
    async with _writer()() as db:
        try:
            rows = await zoho_service.list_fixed_assets(db)
        except ZohoNotConfiguredError:
            raise HTTPException(status_code=409, detail="Zoho is not configured") from None
        except ZohoUpstreamError as e:
            # The upstream message can carry a URL with credentials: only its kind is logged or returned.
            logger.warning("Fixed-asset refresh failed: %s", type(e).__name__)
            raise HTTPException(status_code=502, detail="Zoho could not be read") from None
        assets = [
            {
                "id": str(r.get("fixed_asset_id") or ""),
                "number": r.get("asset_number") or "",
                "name": r.get("asset_name") or "",
                "type": r.get("fixed_asset_type_name") or "",
                "cost": _number(r.get("asset_cost")),
                "start": start
                if isinstance(start := r.get("depreciation_start_date"), str) and is_valid_day(start)
                else None,
                "months": None if (life := _number(r.get("total_life"))) is None else int(life),
                "status": r.get("status") or "",
            }
            for r in rows
        ]
        async with store.snapshot() as conn:
            before = await production.read_depreciation(conn)
        ids = {a["id"] for a in assets}
        return await production.save_depreciation(
            db,
            {
                "assets": assets,
                "selected": [i for i in before["selected"] if i in ids],
                "readAt": datetime.now(timezone.utc).isoformat(),
            },
        )


@router.put("/depreciation")
async def put_depreciation(
    body: DepreciationBody, user: User | None = RequirePermissionIfAuthEnabled(*_MANAGE_CHARGES)
):
    async with store.snapshot() as conn:
        dep = await production.read_depreciation(conn)
    if not set(body.selected) <= {a["id"] for a in dep["assets"]}:
        raise _unprocessable("selected must be asset ids of the stored list")
    async with _writer()() as db:
        return await production.save_depreciation(db, {**dep, "selected": list(dict.fromkeys(body.selected))})


# The running month is re-read at most this often when the page opens.
_FIXED_CURRENT_MAX_AGE_S = 15 * 60
_fixed_refresh_lock = asyncio.Lock()


async def _fixed_accounts_view(conn) -> dict:
    return fixed_accounts.view(
        await production.read_fixed_accounts(conn),
        await production.read_fixed_cache(conn),
        org_today(datetime.now(timezone.utc))[:7],
    )


@router.get("/fixed-accounts")
async def get_fixed_accounts(
    user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ, Permission.REVENUE_VIEW_MARGIN),
):
    async with store.snapshot() as conn:
        return await _fixed_accounts_view(conn)


@router.put("/fixed-accounts")
async def put_fixed_accounts(
    body: FixedAccountsBody, user: User | None = RequirePermissionIfAuthEnabled(*_MANAGE_CHARGES)
):
    async with store.snapshot() as conn:
        cache = await production.read_fixed_cache(conn)
        before = await production.read_fixed_accounts(conn)
    # An account Zoho no longer lists keeps the share it already has.
    if not set(body.accounts) <= {a["id"] for a in cache["accounts"]} | set(before):
        raise _unprocessable("accounts must be account ids of the stored list")
    config = {i: share.model_dump() for i, share in body.accounts.items() if share.percent > 0}
    async with _writer()() as db:
        await production.save_fixed_accounts(db, config)
    async with store.snapshot() as conn:
        return await _fixed_accounts_view(conn)


@router.post("/fixed-accounts/refresh")
async def refresh_fixed_accounts(
    scope: Literal["current", "all"] = "all", user: User | None = RequirePermissionIfAuthEnabled(*_MANAGE_CHARGES)
):
    """Re-read Zoho's expense accounts and their monthly totals. Everything is read before anything is stored: a
    failure leaves the cache as it was. `current` is the page opening: the running month, the three before it and
    any month since the last read, at most every 15 minutes."""
    now = datetime.now(timezone.utc)
    months = fixed_accounts.months_to_read(org_today(now), production.COSTS_START)
    async with _fixed_refresh_lock, _writer()() as db:
        async with store.snapshot() as conn:
            cache = await production.read_fixed_cache(conn)
            config = await production.read_fixed_accounts(conn)
        last = cache["currentReadAt"]
        partial = scope == "current" and bool(cache["readAt"] and last)
        if partial and (now - datetime.fromisoformat(last)).total_seconds() < _FIXED_CURRENT_MAX_AGE_S:
            return {**fixed_accounts.view(config, cache, months[-1]), "changed": False}
        # Late entries are the rule: the three months before the running one are read again too (they also set
        # what a monthly account "usually" costs), and every month since the last read.
        since = min(months[-4], org_today(datetime.fromisoformat(last))[:7]) if partial else months[0]
        wanted = [m for m in months if m >= since]
        try:
            accounts = cache["accounts"]
            if not partial:
                accounts = fixed_accounts.class6_accounts(await zoho_service.list_chart_of_accounts(db))
                # An account with a share that Zoho deleted stays listed, inactive.
                listed = {a["id"] for a in accounts}
                accounts += [
                    {**a, "active": False} for a in cache["accounts"] if a["id"] in config and a["id"] not in listed
                ]
            read = {}
            for month in wanted:
                last_day = days_in_month(int(month[:4]), int(month[5:7]))
                report = await zoho_service.profit_and_loss(db, f"{month}-01", f"{month}-{last_day:02d}")
                read[month] = fixed_accounts.class6_totals(report)
        except ZohoNotConfiguredError:
            raise HTTPException(status_code=409, detail="Zoho is not configured") from None
        except ZohoUpstreamError as e:
            # The upstream message can carry a URL with credentials: only its kind is logged or returned.
            logger.warning("Fixed-account refresh failed: %s", type(e).__name__)
            raise HTTPException(status_code=502, detail="Zoho could not be read") from None
        kept = cache["months"] if partial else {}
        fresh = await production.save_fixed_cache(
            db,
            {
                "accounts": accounts,
                "months": {**kept, **read},
                "readAt": cache["readAt"] if partial else now.isoformat(),
                "currentReadAt": now.isoformat(),
            },
        )
        # `changed` tells the page whether the books moved: only then does it reload its figures.
        changed = (fresh["accounts"], fresh["months"]) != (cache["accounts"], cache["months"])
        return {**fixed_accounts.view(config, fresh, months[-1]), "changed": changed}


@router.post("/annotations", status_code=201)
async def post_annotation(
    request: Request, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_MANAGE_NOTES)
):
    body = await _body(request, AnnotationBody)
    day = body.day if isinstance(body.day, str) else ""
    label = body.label.strip() if isinstance(body.label, str) else ""
    if not is_valid_day(day) or day < REVENUE_HISTORY_START:
        raise _unprocessable(f"day must be yyyy-MM-dd from {REVENUE_HISTORY_START}")
    if not label or len(label) > store.MAX_ANNOTATION_LABEL or not label.isascii() and _unencodable(label):
        raise _unprocessable(f"label must be 1 to {store.MAX_ANNOTATION_LABEL} characters")
    async with _writer()() as db:
        return {"annotation": await store.add_annotation(db, day, label, datetime.now(timezone.utc))}


@router.delete("/annotations/{annotation_id}")
async def delete_annotation(
    annotation_id: str, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_MANAGE_NOTES)
):
    if not _ANNOTATION_ID_RE.fullmatch(annotation_id):
        raise _unprocessable("id must be a positive integer")
    async with _writer()() as db:
        return {"deleted": await store.delete_annotation(db, int(annotation_id))}


@router.post("/checks/{month}/refetch")
async def refetch_month(month: str, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_SYNC)):
    """Drops a closed month from the cache; the sync fetches it again (missing days first) and re-checks it."""
    _check_month(month)
    if month_window(month, REVENUE_HISTORY_START)[1] >= org_today():
        raise _unprocessable("month is not closed yet")
    async with _writer()() as db:
        return {"days": await store.clear_month(db, month)}


@router.post("/sync")
async def post_sync(
    full: str | None = None,
    recent: str | None = None,
    user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_SYNC),
):
    sync.ensure_revenue_sync_loop()
    try:
        result = await asyncio.wait_for(
            sync.run_revenue_sync_batch(full=full == "1", recent=recent == "1"), SYNC_TIMEOUT_S
        )
    except TimeoutError:
        raise HTTPException(status_code=504, detail="Upstream request timed out") from None
    except sync.RevenueRebuildRefused as e:
        raise HTTPException(status_code=503, detail=str(e)) from None
    except Exception as e:
        logger.error("revenue sync failed: %s", type(e).__name__)  # the message may carry a URL or token
        raise HTTPException(status_code=500, detail="Internal server error") from None
    async with store.snapshot() as conn:
        return {**result, "sync": await sync.get_revenue_sync_status(conn, datetime.now(timezone.utc))}
