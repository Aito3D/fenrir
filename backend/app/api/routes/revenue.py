"""Revenue dashboard read endpoints. Camel-case plain dicts (loki's shapes); zero Zoho calls."""

from collections.abc import Awaitable, Callable
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, Request, Response

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.permissions import Permission
from backend.app.models.user import User
from backend.app.services.revenue import memo, products, series, store, sync
from backend.app.services.revenue.config import REVENUE_GRANULARITIES, REVENUE_HISTORY_START
from backend.app.services.revenue.dates import add_days, is_valid_day, org_today
from backend.app.services.revenue.insights import attach_targets, calendar_days, yoy_pivot
from backend.app.services.revenue.scope import build_review_list
from backend.app.services.revenue.series import LineFilters

router = APIRouter(prefix="/revenue", tags=["revenue"])

_FROM_TO_ERROR = "from/to must be yyyy-MM-dd"


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


async def _respond(
    request: Request,
    user: User | None,
    build: Callable[..., Awaitable[dict]],
    *,
    live_sync: bool = False,
    flags: memo.CallerFlags | None = None,
) -> Response:
    """One snapshot per request: it computes the stamp and then feeds the build."""
    flags = flags or memo.caller_flags(user)
    sync.ensure_revenue_sync_loop()
    now = datetime.now(timezone.utc)
    async with store.snapshot() as conn:
        stamp = f"{await store.revenue_data_stamp(conn)}|{await store.items_synced_at(conn)}|{org_today(now)}"
        status = None
        if live_sync:
            status = await sync.get_revenue_sync_status(conn, now)
            stamp += f"|{status}"
        return await memo.revenue_json(request, flags, stamp, lambda: build(conn, now, status))


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
        raise _unprocessable("granularity must be day, week, month or year")
    today = org_today()
    if (from_ and not is_valid_day(from_)) or (to and not is_valid_day(to)):
        raise _unprocessable(_FROM_TO_ERROR)
    flags = memo.caller_flags(user)
    filters = _filters(flags, items, brand, kind, segment)
    base = (
        series.range_preset(preset, today, REVENUE_HISTORY_START)
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

    return await _respond(request, user, build, live_sync=True, flags=flags)


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
    if not is_valid_day(from_) or not is_valid_day(to) or from_ > to:
        raise _unprocessable("from/to must be yyyy-MM-dd with from ≤ to")
    flags = memo.caller_flags(user)
    filters = _filters(flags, items, brand, kind, segment)

    async def build(conn, _now, _status):
        ctx = await _context(conn, from_, to)
        rows = series.item_breakdown(ctx["lines"], ctx["items"], ctx["decisions"], ctx["customers"], filters)
        return {"items": rows, "from": from_, "to": to}

    return await _respond(request, user, build, flags=flags)


@router.get("/products")
async def get_products(request: Request, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ)):
    async def build(conn, now, _status):
        rows = products.build_product_list(
            await store.item_totals(conn), await store.read_scope_items(conn), await store.read_decisions(conn)
        )
        return {"products": rows, "fetchedAt": now.isoformat()}

    return await _respond(request, user, build)


@router.get("/review")
async def get_review(request: Request, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ)):
    async def build(conn, _now, _status):
        return build_review_list(
            await store.item_totals(conn), await store.read_scope_items(conn), await store.read_decisions(conn)
        )

    return await _respond(request, user, build)


@router.get("/sync")
async def get_sync(request: Request, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ)):
    async def build(_conn, _now, status):
        return {"sync": status}

    return await _respond(request, user, build, live_sync=True)


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
    today = org_today()

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

    return await _respond(request, user, build, flags=flags)


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
    today = org_today()
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

    return await _respond(request, user, build, flags=flags)


@router.get("/targets")
async def get_targets(request: Request, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ)):
    async def build(conn, _now, _status):
        return {"targets": await store.read_targets(conn)}

    return await _respond(request, user, build)


@router.get("/annotations")
async def get_annotations(
    request: Request, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ)
):
    async def build(conn, _now, _status):
        return {"annotations": await store.read_annotations(conn)}

    return await _respond(request, user, build)
