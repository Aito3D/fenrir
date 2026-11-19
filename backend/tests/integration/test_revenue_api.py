"""Revenue read endpoints: permissions, stripping, validation, ETag.

Revenue rows live in a file database that `store.snapshot()` reads (it opens its own engine
connection); users and permissions live in the shared test database.
"""

import asyncio
from datetime import datetime, timezone

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.api.routes import revenue as revenue_routes
from backend.app.core import database
from backend.app.core.database import Base, _set_sqlite_pragmas, load_all_models
from backend.app.core.permissions import Permission
from backend.app.services.revenue import store, sync
from backend.app.services.revenue.series import RevenueLine

URL = "/api/v1/revenue"
NOW = datetime(2025, 3, 11, 20, 0, tzinfo=timezone.utc)
DAY = "2025-03-10"
MONTH = {"granularity": "month", "from": "2025-03-01", "to": "2025-03-31"}


@pytest.fixture(autouse=True)
def no_sync_loop(monkeypatch):
    monkeypatch.setattr(sync, "ensure_revenue_sync_loop", lambda: None)


@pytest.fixture
async def revenue_db(tmp_path, monkeypatch):
    load_all_models()
    eng = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'revenue.db'}")
    event.listen(eng.sync_engine, "connect", _set_sqlite_pragmas)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(database, "engine", eng)
    async with async_sessionmaker(eng, expire_on_commit=False)() as db:
        await store.replace_items(
            db,
            [{"item_id": "i1", "name": "PLA", "sku": "P1", "brand": "eSUN", "nature": "Filaments", "purchase_rate": 4}],
            NOW,
        )
        line = RevenueLine(day=DAY, item_id="i1", customer_id="c1", name="PLA", sku="P1", quantity=2, amount=1000)
        await store.write_day(db, DAY, [line], True, NOW, 2)
    yield eng
    await eng.dispose()


@pytest.fixture
async def tokens(db_session):
    from backend.app.core.auth import create_access_token, get_password_hash
    from backend.app.models.group import Group
    from backend.app.models.settings import Settings
    from backend.app.models.user import User

    read = Permission.REVENUE_READ.value
    customers = Permission.REVENUE_VIEW_CUSTOMERS.value
    margin = Permission.REVENUE_VIEW_MARGIN.value
    db_session.add(Settings(key="auth_enabled", value="true"))
    password_hash = get_password_hash("password")
    principals = {
        "none": [],
        "read": [read],
        "read_customers": [read, customers],
        "read_margin": [read, margin],
        "all": [read, customers, margin],
        "scope": [Permission.REVENUE_MANAGE_SCOPE.value],
        "targets": [Permission.REVENUE_MANAGE_TARGETS.value],
        "notes": [Permission.REVENUE_MANAGE_NOTES.value],
        "sync": [Permission.REVENUE_SYNC.value],
    }
    for name, perms in principals.items():
        group = Group(name=f"revenue-{name}", permissions=perms, is_system=False)
        user = User(username=f"revenue-{name}", password_hash=password_hash, is_active=True)
        user.groups.append(group)
        db_session.add_all([group, user])
    await db_session.commit()
    return {
        name: {"Authorization": f"Bearer {create_access_token(data={'sub': f'revenue-{name}'})}"} for name in principals
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path",
    [
        "",
        "/items?from=2025-03-01&to=2025-03-31",
        "/products",
        "/review",
        "/sync",
        "/yoy",
        "/daily",
        "/targets",
        "/annotations",
        "/movers",
        "/analysis?from=2025-03-01&to=2025-03-31",
    ],
)
async def test_every_read_route_needs_revenue_read(async_client, revenue_db, tokens, path):
    assert (await async_client.get(URL + path, headers=tokens["none"])).status_code == 403
    assert (await async_client.get(URL + path, headers=tokens["read"])).status_code == 200


@pytest.mark.asyncio
async def test_series_payload_keys(async_client, revenue_db, tokens):
    r = await async_client.get(URL, params=MONTH, headers=tokens["read"])
    assert set(r.json()) == {
        "granularity", "from", "to", "items", "brands", "kind", "segment",
        "buckets", "sync", "reviewCount", "itemsSyncedAt", "fetchedAt",
    }  # fmt: skip
    body = r.json()
    assert body["buckets"][0]["key"] == "2025-03"
    assert body["buckets"][0]["ht"] == 1000
    assert body["items"] is None


@pytest.mark.asyncio
async def test_read_user_buckets_lack_cost_and_segments_all_user_has_them(async_client, revenue_db, tokens):
    plain = (await async_client.get(URL, params=MONTH, headers=tokens["read"])).json()["buckets"][0]
    assert not {"cost", "costedHt", "bySegment", "bySegmentTtc"} & set(plain)
    full = (await async_client.get(URL, params=MONTH, headers=tokens["all"])).json()["buckets"][0]
    assert {"cost", "costedHt", "bySegment", "bySegmentTtc"} <= set(full)
    assert full["cost"] == 8


@pytest.mark.asyncio
async def test_segment_filter_needs_view_customers(async_client, revenue_db, tokens):
    params = {**MONTH, "segment": "pro"}
    assert (await async_client.get(URL, params=params, headers=tokens["read"])).status_code == 403
    assert (await async_client.get(URL, params=params, headers=tokens["read_customers"])).status_code == 200


@pytest.mark.asyncio
async def test_auth_disabled_gives_every_flag_and_unstripped_payloads(async_client, revenue_db):
    r = await async_client.get(URL, params={**MONTH, "segment": "pro"})
    assert r.status_code == 200
    assert {"cost", "bySegment"} <= set(r.json()["buckets"][0])


@pytest.mark.asyncio
async def test_customers_with_auth_disabled_is_allowed(async_client, revenue_db):
    r = await async_client.get(f"{URL}/customers", params={"from": "2025-03-01", "to": "2025-03-31"})
    assert r.status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("params", "message"),
    [
        ({"granularity": "hour"}, "granularity must be day, week, month or year"),
        ({"from": "nope"}, "from/to must be yyyy-MM-dd"),
        ({"items": "a b"}, "items must be a comma-separated list of item ids"),
        (
            {"brand": "x" * 65},
            "brand must be repeated names of at most 64 characters, 50 at most",
        ),
        (
            {"brand": [f"b{n}" for n in range(51)]},
            "brand must be repeated names of at most 64 characters, 50 at most",
        ),
        ({"kind": "other"}, "kind must be goods or services"),
        ({"segment": "vip"}, "segment must be one of pro, particulier, passage, inconnu"),
    ],
)
async def test_series_validation_messages(async_client, revenue_db, tokens, params, message):
    r = await async_client.get(URL, params=params, headers=tokens["all"])
    assert r.status_code == 422
    assert r.json()["detail"] == message


@pytest.mark.asyncio
@pytest.mark.parametrize("params", [{}, {"from": "2025-03-01"}, {"from": "2025-03-31", "to": "2025-03-01"}])
async def test_items_needs_ordered_from_and_to(async_client, revenue_db, tokens, params):
    r = await async_client.get(f"{URL}/items", params=params, headers=tokens["read"])
    assert r.status_code == 422
    assert r.json()["detail"] == "from/to must be yyyy-MM-dd with from ≤ to"


@pytest.mark.asyncio
async def test_items_lists_the_bucket_and_hides_cost_from_read(async_client, revenue_db, tokens):
    params = {"from": "2025-03-01", "to": "2025-03-31"}
    row = (await async_client.get(f"{URL}/items", params=params, headers=tokens["read"])).json()["items"][0]
    assert row["itemId"] == "i1"
    assert row["ht"] == 1000
    assert "cost" not in row
    row = (await async_client.get(f"{URL}/items", params=params, headers=tokens["read_margin"])).json()["items"][0]
    assert row["cost"] == 8


@pytest.mark.asyncio
async def test_etag_304(async_client, revenue_db, tokens):
    first = await async_client.get(URL, params=MONTH, headers=tokens["read"])
    etag = first.headers["etag"]
    again = await async_client.get(URL, params=MONTH, headers={**tokens["read"], "If-None-Match": etag})
    assert again.status_code == 304
    other = await async_client.get(URL, params=MONTH, headers={**tokens["all"], "If-None-Match": etag})
    assert other.status_code == 200


@pytest.mark.asyncio
async def test_daily_before_the_history_is_clamped(async_client, revenue_db, tokens):
    r = await async_client.get(
        f"{URL}/daily", params={"from": "2020-01-01", "to": "2024-01-05"}, headers=tokens["read"]
    )
    assert (r.json()["from"], r.json()["to"]) == ("2024-01-01", "2024-01-05")
    assert len(r.json()["days"]) == 5


@pytest.mark.asyncio
async def test_sync_get_returns_the_status(async_client, revenue_db, tokens):
    r = await async_client.get(f"{URL}/sync", headers=tokens["read"])
    assert set(r.json()) == {"sync"}
    assert r.json()["sync"]["fetchedDays"] == 1


@pytest.mark.asyncio
async def test_products_review_yoy_targets_annotations_shapes(async_client, revenue_db, tokens):
    h = tokens["read"]
    products = (await async_client.get(f"{URL}/products", headers=h)).json()
    assert products["products"][0]["itemId"] == "i1"
    assert set((await async_client.get(f"{URL}/review", headers=h)).json()) == {"unclassified", "decided"}
    assert set((await async_client.get(f"{URL}/yoy", headers=h)).json()) == {"years", "today"}
    assert (await async_client.get(f"{URL}/targets", headers=h)).json() == {"targets": []}
    assert (await async_client.get(f"{URL}/annotations", headers=h)).json() == {"annotations": []}


@pytest.mark.asyncio
async def test_api_key_cannot_read_revenue(async_client, db_session, tokens):
    from backend.app.core.auth import generate_api_key
    from backend.app.models.api_key import APIKey

    full_key, key_hash, key_prefix = generate_api_key()
    db_session.add(APIKey(name="k", key_hash=key_hash, key_prefix=key_prefix, can_read_status=True, enabled=True))
    await db_session.commit()
    assert (await async_client.get(URL, headers={"X-API-Key": full_key})).status_code == 403


RANGE = {"from": "2025-03-01", "to": "2025-03-31"}


@pytest.mark.asyncio
async def test_customers_needs_view_customers(async_client, revenue_db, tokens):
    path = f"{URL}/customers"
    assert (await async_client.get(path, params=RANGE, headers=tokens["none"])).status_code == 403
    assert (await async_client.get(path, params=RANGE, headers=tokens["read"])).status_code == 403
    assert (await async_client.get(path, params=RANGE, headers=tokens["read_customers"])).status_code == 200


@pytest.mark.asyncio
async def test_customers_payload_always_carries_acquisition(async_client, revenue_db, tokens):
    body = (await async_client.get(f"{URL}/customers", params=RANGE, headers=tokens["read_customers"])).json()
    assert {"from", "to", "segments", "customers", "customerCount", "unsplitHt", "acquisition"} <= set(body)
    assert body["acquisition"] is not None
    assert body["customers"][0]["customerId"] == "c1"


@pytest.mark.asyncio
async def test_customers_and_analysis_validate_the_range(async_client, revenue_db, tokens):
    for path in ("customers", "analysis"):
        r = await async_client.get(
            f"{URL}/{path}", params={"from": "2025-03-31", "to": "2025-03-01"}, headers=tokens["all"]
        )
        assert r.status_code == 422
        assert r.json()["detail"] == "from/to must be yyyy-MM-dd with from ≤ to"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "params",
    [
        {"key": "2023-12"},
        {"granularity": "month", "key": "2026-W42"},
        {"key": "2999-01"},
        {"granularity": "week", "key": "9999-W53"},
        {"granularity": "month", "key": "0000-01"},
    ],
)
async def test_movers_refuses_a_key_outside_the_history(async_client, revenue_db, tokens, params):
    r = await async_client.get(f"{URL}/movers", params=params, headers=tokens["read"])
    assert r.status_code == 422
    assert r.json()["detail"] == "key is not a bucket of this granularity inside the history"


@pytest.mark.asyncio
async def test_movers_validates_granularity_and_compare_ranges(async_client, revenue_db, tokens):
    r = await async_client.get(f"{URL}/movers", params={"granularity": "hour"}, headers=tokens["read"])
    assert r.json()["detail"] == "granularity must be day, week, month or year"
    r = await async_client.get(f"{URL}/movers", params={"cfrom": "2025-02-01"}, headers=tokens["read"])
    assert r.status_code == 422
    assert r.json()["detail"] == "from/to/cfrom/cto must be yyyy-MM-dd with from ≤ to and cfrom ≤ cto"


@pytest.mark.asyncio
async def test_movers_defaults_to_the_bucket_of_today_and_compares_a_bucket(async_client, revenue_db, tokens):
    body = (await async_client.get(f"{URL}/movers", headers=tokens["read"])).json()
    assert body["granularity"] == "month"
    assert len(body["key"]) == 7
    body = (await async_client.get(f"{URL}/movers", params={"key": "2025-03"}, headers=tokens["read"])).json()
    assert body["items"]["up"][0]["key"] == "i1"
    assert body["totals"] == {"current": 1000, "previous": 0}


@pytest.mark.asyncio
async def test_movers_free_mode_returns_the_top_ten(async_client, revenue_db, tokens):
    rows = [
        {"item_id": f"m{n}", "name": f"Item {n:02d}", "sku": f"M{n}", "brand": "eSUN", "nature": "Filaments"}
        for n in range(12)
    ]
    lines = [
        RevenueLine(
            day=DAY, item_id=f"m{n}", customer_id="c1", name=f"Item {n:02d}", sku=f"M{n}", quantity=1, amount=100 + n
        )
        for n in range(12)
    ]
    async with async_sessionmaker(revenue_db, expire_on_commit=False)() as db:
        await store.replace_items(db, rows, NOW)
        await store.write_day(db, DAY, lines, True, NOW, 2)
    params = {**RANGE, "cfrom": "2025-02-01", "cto": "2025-02-28"}
    body = (await async_client.get(f"{URL}/movers", params=params, headers=tokens["read"])).json()
    assert (body["granularity"], body["key"]) == (None, None)
    assert len(body["items"]["up"]) == 10
    assert body["previous"] == {"from": "2025-02-01", "to": "2025-02-28"}


@pytest.mark.asyncio
async def test_analysis_payload_and_margin_stripping(async_client, revenue_db, tokens):
    plain = (await async_client.get(f"{URL}/analysis", params=RANGE, headers=tokens["read"])).json()
    assert set(plain) == {"from", "to", "abc", "dormant"}
    full = (await async_client.get(f"{URL}/analysis", params=RANGE, headers=tokens["read_margin"])).json()
    assert set(full) == {"from", "to", "abc", "marginByBrand", "marginByNature", "dormant"}
    assert full["marginByBrand"][0]["key"] == "eSUN"


WRITES = [
    ("put", "/scope/i1", {"included": True}, "scope"),
    ("delete", "/scope/i1", None, "scope"),
    ("put", "/targets/2025-03", {"amountHt": 5000}, "targets"),
    ("delete", "/targets/2025-03", None, "targets"),
    ("post", "/annotations", {"day": DAY, "label": "Promo"}, "notes"),
    ("delete", "/annotations/1", None, "notes"),
    ("post", "/sync", None, "sync"),
]


@pytest.fixture
def stub_sync(monkeypatch):
    calls = []

    async def fake(*, full=False):
        calls.append(full)
        return {"fetched": 3, "pending": 2, "days": 10, "customers": 1}

    monkeypatch.setattr(sync, "run_revenue_sync_batch", fake)
    return calls


@pytest.mark.asyncio
@pytest.mark.parametrize(("method", "path", "body", "perm"), WRITES)
async def test_every_write_route_has_its_own_permission(
    async_client, revenue_db, tokens, stub_sync, method, path, body, perm
):
    def send(url, **kw):
        return async_client.request(method.upper(), url, **kw)

    assert (await send(URL + path, json=body, headers=tokens["read"])).status_code == 403
    for other in {"scope", "targets", "notes", "sync"} - {perm}:
        assert (await send(URL + path, json=body, headers=tokens[other])).status_code == 403
    assert (await send(URL + path, json=body, headers=tokens[perm])).status_code in (200, 201)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("put", "/scope/a b", {"included": True}),
        ("delete", "/scope/a b", None),
        ("put", "/scope/i1", {"included": "yes"}),
        ("put", "/targets/2026-13", {"amountHt": 1}),
        ("put", "/targets/2025-03", {"amountHt": -1}),
        ("delete", "/targets/2026-13", None),
        ("delete", "/annotations/abc", None),
        ("post", "/annotations", {"day": "2023-12-31", "label": " "}),
    ],
)
async def test_write_validation_never_precedes_the_permission(async_client, revenue_db, tokens, method, path, body):
    r = await async_client.request(method.upper(), URL + path, json=body, headers=tokens["read"])
    assert r.status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path", "body", "who", "message"),
    [
        ("put", "/scope/a b", {"included": True}, "scope", "malformed itemId"),
        ("delete", "/scope/a b", None, "scope", "malformed itemId"),
        ("put", "/scope/i1", {"included": "yes"}, "scope", "body must be { included: boolean }"),
        ("put", "/scope/i1", [1], "scope", "body must be { included: boolean }"),
        ("put", "/targets/2026-13", {"amountHt": 1}, "targets", "month must be yyyy-MM"),
        ("delete", "/targets/2026-13", None, "targets", "month must be yyyy-MM"),
        ("put", "/targets/2025-03", {"amountHt": -1}, "targets", "amountHt must be a number between 0 and 10^12"),
        ("put", "/targets/2025-03", {"amountHt": 1e13}, "targets", "amountHt must be a number between 0 and 10^12"),
        ("put", "/targets/2025-03", {"amountHt": "x"}, "targets", "amountHt must be a number between 0 and 10^12"),
        ("put", "/targets/2025-03", {}, "targets", "amountHt must be a number between 0 and 10^12"),
        ("delete", "/annotations/abc", None, "notes", "id must be a positive integer"),
        (
            "post",
            "/annotations",
            {"day": "2023-12-31", "label": "x"},
            "notes",
            "day must be yyyy-MM-dd from 2024-01-01",
        ),
        ("post", "/annotations", {"day": 5, "label": "x"}, "notes", "day must be yyyy-MM-dd from 2024-01-01"),
        ("post", "/annotations", {"day": DAY, "label": " "}, "notes", "label must be 1 to 80 characters"),
        ("post", "/annotations", {"day": DAY, "label": "x" * 81}, "notes", "label must be 1 to 80 characters"),
    ],
)
async def test_write_validation_messages(async_client, revenue_db, tokens, method, path, body, who, message):
    r = await async_client.request(method.upper(), URL + path, json=body, headers=tokens[who])
    assert r.status_code == 422
    assert r.json()["detail"] == message


@pytest.mark.asyncio
async def test_scope_put_changes_the_next_etag_and_delete_clears(async_client, revenue_db, tokens):
    etag = (await async_client.get(URL, params=MONTH, headers=tokens["read"])).headers["etag"]
    r = await async_client.put(f"{URL}/scope/i1", json={"included": False}, headers=tokens["scope"])
    assert r.json()["decision"]["included"] is False
    assert (await async_client.get(URL, params=MONTH, headers=tokens["read"])).headers["etag"] != etag
    assert (await async_client.delete(f"{URL}/scope/i1", headers=tokens["scope"])).json() == {"cleared": True}
    assert (await async_client.delete(f"{URL}/scope/i1", headers=tokens["scope"])).json() == {"cleared": False}


@pytest.mark.asyncio
async def test_targets_and_annotations_round_trip(async_client, revenue_db, tokens):
    r = await async_client.put(f"{URL}/targets/2025-03", json={"amountHt": 1234.6}, headers=tokens["targets"])
    assert r.json()["target"]["amountHt"] == 1235
    assert (await async_client.get(f"{URL}/targets", headers=tokens["read"])).json()["targets"][0]["month"] == "2025-03"
    assert (await async_client.delete(f"{URL}/targets/2025-03", headers=tokens["targets"])).json() == {"cleared": True}
    assert (await async_client.delete(f"{URL}/targets/2025-03", headers=tokens["targets"])).status_code == 200
    r = await async_client.post(f"{URL}/annotations", json={"day": DAY, "label": "  Promo "}, headers=tokens["notes"])
    assert r.status_code == 201
    note = r.json()["annotation"]
    assert note["label"] == "Promo"
    assert (await async_client.get(f"{URL}/annotations", headers=tokens["read"])).json()["annotations"] == [note]
    gone = await async_client.delete(f"{URL}/annotations/{note['id']}", headers=tokens["notes"])
    assert gone.json() == {"deleted": True}


@pytest.mark.asyncio
async def test_sync_post_returns_the_batch_and_status_and_honours_full(async_client, revenue_db, tokens, stub_sync):
    r = await async_client.post(f"{URL}/sync", headers=tokens["sync"])
    assert {"fetched", "pending", "days", "customers", "sync"} == set(r.json())
    await async_client.post(f"{URL}/sync", params={"full": "1"}, headers=tokens["sync"])
    assert stub_sync == [False, True]


@pytest.mark.asyncio
async def test_sync_post_timeout_and_failure_are_clean_errors(async_client, revenue_db, tokens, monkeypatch):
    async def boom(*, full=False):
        raise RuntimeError("https://zoho.example/?token=SECRET")

    monkeypatch.setattr(sync, "run_revenue_sync_batch", boom)
    r = await async_client.post(f"{URL}/sync", headers=tokens["sync"])
    assert r.status_code == 500
    assert r.json()["detail"] == "Internal server error"

    async def slow(*, full=False):
        await asyncio.sleep(5)

    monkeypatch.setattr(sync, "run_revenue_sync_batch", slow)
    monkeypatch.setattr(revenue_routes, "SYNC_TIMEOUT_S", 0.05)
    r = await async_client.post(f"{URL}/sync", headers=tokens["sync"])
    assert r.status_code == 504
    assert r.json()["detail"] == "Upstream request timed out"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "raw",
    [b'{"day": "2026-01-05", "label": "\\ud800x"}', b"[" * 100_000],
    ids=["lone-surrogate", "deep-nesting"],
)
async def test_annotation_body_that_breaks_the_parser_or_encoding_is_a_422(async_client, revenue_db, tokens, raw):
    headers = {**tokens["notes"], "Content-Type": "application/json"}
    r = await async_client.post(f"{URL}/annotations", content=raw, headers=headers)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_deeply_nested_body_gets_the_routes_own_message(async_client, revenue_db, tokens):
    headers = {**tokens["scope"], "Content-Type": "application/json"}
    r = await async_client.put(f"{URL}/scope/i1", content=b"[" * 100_000, headers=headers)
    assert r.status_code == 422
    assert r.json()["detail"] == "body must be { included: boolean }"


@pytest.mark.asyncio
async def test_target_put_and_annotation_post_invalidate_the_etag(async_client, revenue_db, tokens):
    for path, write in (
        (
            "/targets",
            lambda: async_client.put(f"{URL}/targets/2025-03", json={"amountHt": 5}, headers=tokens["targets"]),
        ),
        (
            "/annotations",
            lambda: async_client.post(f"{URL}/annotations", json={"day": DAY, "label": "x"}, headers=tokens["notes"]),
        ),
    ):
        etag = (await async_client.get(URL + path, headers=tokens["read"])).headers["etag"]
        assert (await write()).status_code in (200, 201)
        again = await async_client.get(URL + path, headers={**tokens["read"], "If-None-Match": etag})
        assert again.status_code == 200
