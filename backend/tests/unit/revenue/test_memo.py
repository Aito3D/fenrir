import copy
import json
from types import SimpleNamespace

import pytest
from starlette.requests import Request

from backend.app.services.revenue import memo as memo_mod
from backend.app.services.revenue.memo import (
    CallerFlags,
    Memo,
    caller_flags,
    etag_matches,
    revenue_etag,
    revenue_json,
    strip_payload,
)

ALL = CallerFlags(True, True)


def _request(path="/api/v1/revenue", query="granularity=month", inm=None):
    headers = [(b"if-none-match", inm.encode())] if inm else []
    return Request({"type": "http", "method": "GET", "path": path, "query_string": query.encode(), "headers": headers})


@pytest.fixture(autouse=True)
def _fresh_memo(monkeypatch):
    monkeypatch.setattr(memo_mod, "_memo", Memo(64))


def payload():
    return {
        "buckets": [
            {"key": "2026-11", "ht": 10, "bySegment": {"a": 1}, "bySegmentTtc": {"a": 2}, "cost": 4, "costedHt": 8}
        ],
        "items": [{"itemId": "1", "ht": 10, "cost": 4}],
        "marginByBrand": [{"key": "x"}],
        "marginByNature": [{"key": "y"}],
    }


def test_is_stable_for_one_stamp_query_and_moves_with_either():
    e = revenue_etag("s1", "/api/v1/revenue?granularity=month")
    assert e.startswith('W/"') and len(e) == 3 + 24 + 1
    assert revenue_etag("s1", "/api/v1/revenue?granularity=month") == e
    assert revenue_etag("s2", "/api/v1/revenue?granularity=month") != e
    assert revenue_etag("s1", "/api/v1/revenue?granularity=week") != e


def test_matches_a_single_tag_a_list_or_star_never_an_absent_header():
    assert etag_matches('W/"a"', 'W/"a"')
    assert etag_matches('W/"b", W/"a"', 'W/"a"')
    assert etag_matches("*", 'W/"a"')
    assert not etag_matches(None, 'W/"a"')
    assert not etag_matches('W/"b"', 'W/"a"')


def test_builds_once_per_key_and_evicts_the_oldest_past_max():
    m = Memo(2)
    m.set("a", 1)
    m.set("b", 2)
    assert m.get("a") == 1  # refreshes a
    m.set("c", 3)
    assert m.get("b") is None
    assert m.get("a") == 1 and m.get("c") == 3


async def test_flags_change_key_and_etag():
    calls = []

    async def build():
        calls.append(1)
        return payload()

    full = await revenue_json(_request(), ALL, "s", build)
    blind = await revenue_json(_request(), CallerFlags(False, False), "s", build)
    assert len(calls) == 2
    assert full.headers["etag"] != blind.headers["etag"]
    full_body, blind_body = json.loads(full.body), json.loads(blind.body)
    assert "cost" in full_body["buckets"][0] and "bySegment" in full_body["buckets"][0]
    assert "cost" not in blind_body["buckets"][0] and "bySegment" not in blind_body["buckets"][0]
    assert "marginByBrand" not in blind_body
    # back to the full caller: memo hit, still the full payload
    again = await revenue_json(_request(), ALL, "s", build)
    assert len(calls) == 2 and json.loads(again.body) == full_body


async def test_blind_read_first_never_poisons_a_full_read():
    async def build():
        return payload()

    await revenue_json(_request(), CallerFlags(False, False), "s", build)
    full = await revenue_json(_request(), CallerFlags(True, False), "s", build)
    body = json.loads(full.body)
    assert "bySegment" in body["buckets"][0] and "cost" not in body["buckets"][0]


async def test_304_on_match():
    calls = []

    async def build():
        calls.append(1)
        return payload()

    first = await revenue_json(_request(), ALL, "s", build)
    r = await revenue_json(_request(inm=first.headers["etag"]), ALL, "s", build)
    assert r.status_code == 304 and r.body == b""
    assert r.headers["cache-control"] == "no-cache"
    assert len(calls) == 1
    other = await revenue_json(_request(inm=first.headers["etag"]), CallerFlags(True, False), "s", build)
    assert other.status_code == 200


def test_strip_payload_covers_every_shape_without_mutating():
    p = payload()
    before = copy.deepcopy(p)
    s = strip_payload(p, CallerFlags(False, False))
    assert p == before
    assert s["buckets"][0].keys() == {"key", "ht"}
    assert s["items"] == [{"itemId": "1", "ht": 10}]
    assert "marginByBrand" not in s and "marginByNature" not in s
    s["buckets"][0]["ht"] = 99
    assert p == before
    assert strip_payload(p, ALL) == before
    only_margin = strip_payload(p, CallerFlags(False, True))
    assert "bySegment" not in only_margin["buckets"][0] and only_margin["buckets"][0]["cost"] == 4
    assert "marginByBrand" in only_margin


def test_caller_flags_none_is_auth_disabled_and_users_use_effective_permissions():
    assert caller_flags(None) == ALL
    user = SimpleNamespace(has_permission=lambda p: p == "revenue:view_margin")
    assert caller_flags(user) == CallerFlags(customers=False, margin=True)
