"""Revenue dashboard read endpoints. Camel-case plain dicts (loki's shapes); zero Zoho calls."""

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any, TypeVar

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import async_sessionmaker

from backend.app.core import database
from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.permissions import Permission
from backend.app.models.user import User
from backend.app.services.revenue import analysis, insights, memo, products, series, store, sync
from backend.app.services.revenue.config import REVENUE_GRANULARITIES, REVENUE_HISTORY_START
from backend.app.services.revenue.dates import add_days, is_valid_day, org_today
from backend.app.services.revenue.insights import attach_targets, calendar_days, yoy_pivot
from backend.app.services.revenue.scope import ITEM_ID_RE, build_review_list
from backend.app.services.revenue.series import LineFilters

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
    now = datetime.now(timezone.utc)
    today = org_today(now)
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


@router.get("/customers")
async def get_customers(
    request: Request,
    from_: str = Query("", alias="from"),
    to: str = "",
    items: str | None = None,
    brand: list[str] = Query(default=[]),
    kind: str | None = None,
    segment: str | None = None,
    user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_READ, Permission.REVENUE_VIEW_CUSTOMERS),
):
    now = datetime.now(timezone.utc)
    _ordered_range(from_, to)
    flags = memo.caller_flags(user)
    filters = _filters(flags, items, brand, kind, segment)

    async def build(conn, _now, _status):
        ctx = await _context(conn, from_, to)
        result = insights.customer_breakdown(
            ctx["lines"],
            ctx["items"],
            ctx["decisions"],
            ctx["customers"],
            filters,
            await store.customer_first_days(conn),
            from_,
        )
        return {"from": from_, "to": to, **result}

    return await _respond(request, user, build, flags=flags, now=now)


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
            raise _unprocessable("granularity must be day, week, month or year")
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

        def rows(r: dict) -> list[dict]:
            return _breakdown(ctx, [x for x in ctx["lines"] if r["from"] <= x.day <= r["to"]], filters)

        shown = COMPARE_SHOWN if free else insights.MOVERS_SHOWN
        moved = insights.compute_movers(rows(cur), rows(prev), ranges, shown)
        return {"granularity": None if free else granularity, "key": None if free else key, **moved}

    return await _respond(request, user, build, flags=flags, now=now)


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


class AnnotationBody(BaseModel):
    day: Any = None
    label: Any = None


async def _body(request: Request, model: type[_M]) -> _M:
    """Lenient parse: a malformed or non-object body becomes an empty model, so the handler's own message applies."""
    try:
        raw = await request.json()
    except ValueError:
        raw = None
    return model.model_validate(raw if isinstance(raw, dict) else {})


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


@router.post("/annotations", status_code=201)
async def post_annotation(
    request: Request, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_MANAGE_NOTES)
):
    body = await _body(request, AnnotationBody)
    day = body.day if isinstance(body.day, str) else ""
    label = body.label.strip() if isinstance(body.label, str) else ""
    if not is_valid_day(day) or day < REVENUE_HISTORY_START:
        raise _unprocessable(f"day must be yyyy-MM-dd from {REVENUE_HISTORY_START}")
    if not label or len(label) > store.MAX_ANNOTATION_LABEL:
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


@router.post("/sync")
async def post_sync(
    full: str | None = None, user: User | None = RequirePermissionIfAuthEnabled(Permission.REVENUE_SYNC)
):
    sync.ensure_revenue_sync_loop()
    try:
        result = await asyncio.wait_for(sync.run_revenue_sync_batch(full=full == "1"), SYNC_TIMEOUT_S)
    except TimeoutError:
        raise HTTPException(status_code=504, detail="Upstream request timed out") from None
    except Exception as e:
        logger.error("revenue sync failed: %s", type(e).__name__)  # the message may carry a URL or token
        raise HTTPException(status_code=500, detail="Internal server error") from None
    async with store.snapshot() as conn:
        return {**result, "sync": await sync.get_revenue_sync_status(conn, datetime.now(timezone.utc))}
