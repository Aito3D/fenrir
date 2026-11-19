"""Revenue read endpoints: permissions, stripping, validation, ETag.

Revenue rows live in a file database that `store.snapshot()` reads (it opens its own engine
connection); users and permissions live in the shared test database.
"""

from datetime import datetime, timezone

import pytest
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

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
    [{"key": "2023-12"}, {"granularity": "month", "key": "2026-W42"}, {"key": "2999-01"}],
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
