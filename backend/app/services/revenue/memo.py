from __future__ import annotations

import hashlib
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING

from fastapi import Request, Response
from fastapi.responses import JSONResponse

from backend.app.core.permissions import Permission

if TYPE_CHECKING:
    from backend.app.models.user import User

_CUSTOMER_KEYS = frozenset({"bySegment", "bySegmentTtc", "topOverdue", "byCustomer", "customerMovers"})
_MARGIN_KEYS = frozenset(
    {"cost", "costedHt", "marginByBrand", "marginByNature", "marginSplit", "costParts", "printHours"}
)


def revenue_etag(stamp: str, path_and_query: str) -> str:
    digest = hashlib.sha1(f"{stamp}|{path_and_query}".encode(), usedforsecurity=False).hexdigest()
    return f'W/"{digest[:24]}"'


def etag_matches(if_none_match: str | None, etag: str) -> bool:
    if not if_none_match:
        return False
    if if_none_match.strip() == "*":
        return True
    return any(t.strip() == etag for t in if_none_match.split(","))


class Memo:
    def __init__(self, max_size: int = 64):
        self._max = max_size
        self._data: OrderedDict[str, object] = OrderedDict()

    def get(self, key: str):
        if key not in self._data:
            return None
        self._data.move_to_end(key)
        return self._data[key]

    def set(self, key: str, value) -> None:
        self._data[key] = value
        self._data.move_to_end(key)
        while len(self._data) > self._max:
            self._data.popitem(last=False)


@dataclass(frozen=True)
class CallerFlags:
    customers: bool
    margin: bool


def caller_flags(user: User | None) -> CallerFlags:
    # None = auth disabled; API keys never get here (revenue permissions are denied for keys in auth.py), mapping one would give keys both flags
    if user is None:
        return CallerFlags(True, True)
    return CallerFlags(
        customers=user.has_permission(Permission.REVENUE_VIEW_CUSTOMERS.value),
        margin=user.has_permission(Permission.REVENUE_VIEW_MARGIN.value),
    )


def strip_payload(payload, flags: CallerFlags):
    """Copy of `payload` without what the caller may not see; walks every nested shape so none is missed."""
    drop = set()
    if not flags.customers:
        drop |= _CUSTOMER_KEYS
    if not flags.margin:
        drop |= _MARGIN_KEYS

    def walk(v):
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items() if k not in drop}
        if isinstance(v, list):
            return [walk(x) for x in v]
        return v

    return walk(payload)


_memo = Memo(64)


async def revenue_json(
    request: Request, flags: CallerFlags, stamp: str, build: Callable[[], Awaitable[dict]]
) -> Response:
    path_and_query = request.url.path + (f"?{request.url.query}" if request.url.query else "")
    flagged = f"{stamp}|c{int(flags.customers)}m{int(flags.margin)}"
    etag = revenue_etag(flagged, path_and_query)
    headers = {"ETag": etag, "Cache-Control": "no-cache"}
    if etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers=headers)
    key = f"{flagged}|{path_and_query}"
    body = _memo.get(key)
    if body is None:
        body = strip_payload(await build(), flags)  # only the stripped copy is ever memoised
        _memo.set(key, body)
    return JSONResponse(body, headers=headers)
