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
        "labor": [read, margin, Permission.REVENUE_MANAGE_TARGETS.value],
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
        "/checks",
        "/cash",
        "/pipeline",
        "/funnel",
        "/movers",
        "/pvm?from=2025-03-01&to=2025-03-31",
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
    assert not {"cost", "costedHt", "marginSplit", "costParts", "printHours", "bySegment", "bySegmentTtc"} & set(plain)
    full = (await async_client.get(URL, params=MONTH, headers=tokens["all"])).json()["buckets"][0]
    assert {"cost", "costedHt", "marginSplit", "costParts", "bySegment", "bySegmentTtc"} <= set(full)
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
async def test_customers_clamps_range_to_history(async_client, revenue_db):
    r = await async_client.get(
        f"{URL}/customers", params={"from": "1000-01-01", "to": "9999-12-31", "granularity": "day"}
    )
    body = r.json()
    assert (body["from"], body["to"]) == (
        revenue_routes.REVENUE_HISTORY_START,
        revenue_routes.org_today(datetime.now(timezone.utc)),
    )
    assert len(body["retention"]) < 5000


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
async def test_customers_carries_retention_per_bucket_of_the_granularity(async_client, revenue_db, tokens):
    params = {**RANGE, "granularity": "week"}
    body = (await async_client.get(f"{URL}/customers", params=params, headers=tokens["read_customers"])).json()
    weeks = body["retention"]
    assert [w["key"] for w in weeks] == ["2025-W09", "2025-W10", "2025-W11", "2025-W12", "2025-W13", "2025-W14"]
    assert (weeks[0]["start"], weeks[-1]["end"]) == ("2025-03-01", "2025-03-31")
    hit = next(w for w in weeks if w["key"] == "2025-W11")
    assert {k: hit[k] for k in ("newHt", "returningHt", "anonHt", "newCount", "returningCount")} == {
        "newHt": 1000,
        "returningHt": 0,
        "anonHt": 0,
        "newCount": 1,
        "returningCount": 0,
    }
    default = (await async_client.get(f"{URL}/customers", params=RANGE, headers=tokens["read_customers"])).json()
    assert [m["key"] for m in default["retention"]] == ["2025-03"]


@pytest.mark.asyncio
async def test_customers_rejects_an_unknown_granularity(async_client, revenue_db, tokens):
    params = {**RANGE, "granularity": "quarter"}
    r = await async_client.get(f"{URL}/customers", params=params, headers=tokens["read_customers"])
    assert r.status_code == 422


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
    assert "customerMovers" not in body
    body = (await async_client.get(f"{URL}/movers", params={"key": "2025-03"}, headers=tokens["read_customers"])).json()
    assert [(m["key"], m["delta"]) for m in body["customerMovers"]["up"]] == [("c1", 1000)]


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

    async def fake(*, full=False, recent=False):
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
    async def boom(*, full=False, recent=False):
        raise RuntimeError("https://zoho.example/?token=SECRET")

    monkeypatch.setattr(sync, "run_revenue_sync_batch", boom)
    r = await async_client.post(f"{URL}/sync", headers=tokens["sync"])
    assert r.status_code == 500
    assert r.json()["detail"] == "Internal server error"

    async def slow(*, full=False, recent=False):
        await asyncio.sleep(5)

    monkeypatch.setattr(sync, "run_revenue_sync_batch", slow)
    monkeypatch.setattr(revenue_routes, "SYNC_TIMEOUT_S", 0.05)
    r = await async_client.post(f"{URL}/sync", headers=tokens["sync"])
    assert r.status_code == 504
    assert r.json()["detail"] == "Upstream request timed out"


@pytest.mark.asyncio
async def test_sync_post_refused_rebuild_is_a_503_with_its_reason(async_client, revenue_db, tokens, monkeypatch):
    async def refused(*, full=False, recent=False):
        raise sync.RevenueRebuildRefused("Zoho credentials are not configured")

    monkeypatch.setattr(sync, "run_revenue_sync_batch", refused)
    r = await async_client.post(f"{URL}/sync", params={"full": "1"}, headers=tokens["sync"])
    assert r.status_code == 503
    assert r.json()["detail"] == "Zoho credentials are not configured"


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


LABOR = {"name": " Alice ", "hourlyRate": 1500, "hoursPerDay": 8, "daysPerWeek": 5, "since": None}


@pytest.mark.asyncio
async def test_labor_list_needs_margin_to_read_and_targets_too_to_write(async_client, revenue_db, tokens):
    url = f"{URL}/labor"
    assert (await async_client.get(url, headers=tokens["read"])).status_code == 403
    assert (await async_client.get(url, headers=tokens["read_margin"])).json() == {"providers": []}
    body = {"providers": [LABOR]}
    for who in ("read_margin", "targets"):
        assert (await async_client.put(url, json=body, headers=tokens[who])).status_code == 403
    assert (await async_client.put(url, json={"providers": [{}]}, headers=tokens["read"])).status_code == 403
    r = await async_client.put(url, json=body, headers=tokens["labor"])
    assert r.status_code == 200
    assert r.json()["providers"][0]["name"] == "Alice"
    assert (await async_client.get(url, headers=tokens["labor"])).json()["providers"][0]["hourlyRate"] == 1500
    bad = {**LABOR, "since": "2026-13-01"}
    assert (await async_client.put(url, json={"providers": [bad]}, headers=tokens["labor"])).status_code == 422
    assert (
        await async_client.put(url, json={"providers": [{**LABOR, "daysPerWeek": 8}]}, headers=tokens["labor"])
    ).status_code == 422


@pytest.mark.asyncio
async def test_checks_list_newest_first_with_rounded_amounts_and_a_one_franc_tolerance(
    async_client, revenue_db, tokens
):
    async with async_sessionmaker(revenue_db, expire_on_commit=False)() as db:
        await store.save_month_check(db, "2025-02", 1000.4, 999.6, NOW)
        await store.save_month_check(db, "2025-03", 1500, 1000, NOW)
    r = await async_client.get(f"{URL}/checks", headers=tokens["read"])
    assert r.json() == {
        "checks": [
            {
                "month": "2025-03",
                "zohoHt": 1500,
                "cacheHt": 1000,
                "gap": 500,
                "ok": False,
                "checkedAt": NOW.isoformat(),
            },
            {"month": "2025-02", "zohoHt": 1000, "cacheHt": 1000, "gap": 1, "ok": True, "checkedAt": NOW.isoformat()},
        ]
    }


@pytest.mark.asyncio
async def test_refetch_needs_revenue_sync_and_a_closed_yyyy_mm_month(async_client, revenue_db, tokens):
    url = f"{URL}/checks/2025-03/refetch"
    assert (await async_client.post(url, headers=tokens["read"])).status_code == 403
    for bad in ("2025-3", "2025-13", "march"):
        r = await async_client.post(f"{URL}/checks/{bad}/refetch", headers=tokens["sync"])
        assert r.status_code == 422
    this_month = datetime.now(timezone.utc).strftime("%Y-%m")
    r = await async_client.post(f"{URL}/checks/{this_month}/refetch", headers=tokens["sync"])
    assert (r.status_code, r.json()["detail"]) == (422, "month is not closed yet")


@pytest.mark.asyncio
async def test_refetch_drops_the_months_days_and_check(async_client, revenue_db, tokens):
    async with async_sessionmaker(revenue_db, expire_on_commit=False)() as db:
        await store.save_month_check(db, "2025-03", 1500, 1000, NOW)
    r = await async_client.post(f"{URL}/checks/2025-03/refetch", headers=tokens["sync"])
    assert r.json() == {"days": 1}
    async with store.snapshot(revenue_db) as conn:
        assert await store.read_day_index(conn) == []
        assert await store.read_lines(conn, "2025-03-01", "2025-03-31") == []
        assert await store.read_month_checks(conn) == []


async def _seed_cash(engine):
    from backend.app.services.revenue.dates import org_today

    today = org_today()
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        row = {"customer_id": "c1", "date": today, "amount": 500, "unapplied": 0, "last_modified_time": "t"}
        await store.save_payments(db, [{"payment_id": "p1", **row}], "2026-11-01T00:00:00+0000", NOW)
        invoice = {
            "invoice_id": "i1", "number": "INV-1", "customer_id": "c1", "customer_name": "Alice",
            "date": "2025-01-01", "due_date": "2025-02-01", "total": 300, "balance": 300,
        }  # fmt: skip
        await store.save_unpaid_invoices(db, [invoice], True, NOW)
    return today


@pytest.mark.asyncio
async def test_cash_shape_and_customer_names_need_view_customers(async_client, revenue_db, tokens):
    today = await _seed_cash(revenue_db)
    body = (await async_client.get(f"{URL}/cash", headers=tokens["read_customers"])).json()
    assert set(body) == {
        "months",
        "outstanding",
        "topOverdue",
        "aging",
        "dso",
        "forecast",
        "coverage",
        "syncedAt",
        "error",
    }
    assert body["aging"]["byCustomer"][0]["customerName"] == "Alice"
    assert [w["window"] for w in body["forecast"]] == ["d30", "d60", "d90"]
    assert len(body["months"]) == 12 and body["months"][-1]["month"] == today[:7]
    assert body["months"][-1]["collected"] == 500  # c1 bought only 3D items in the cache
    assert body["outstanding"] == {
        "total": 300,
        "overdue": 300,
        "invoices": 1,
        "unknown": 0,
        "dueSoon": 0,
        "lateRecent": 0,
        "lateOld": 300,
    }
    assert body["topOverdue"][0]["customerName"] == "Alice"
    assert body["coverage"] == {"known": 800, "unknown": 0}
    plain = (await async_client.get(f"{URL}/cash", headers=tokens["read"])).json()
    assert "topOverdue" not in plain and plain["outstanding"] == body["outstanding"]
    assert "byCustomer" not in plain["aging"] and plain["aging"]["buckets"] == body["aging"]["buckets"]


@pytest.mark.asyncio
async def test_cash_etag_moves_when_cash_rows_change(async_client, revenue_db, tokens):
    first = await async_client.get(f"{URL}/cash", headers=tokens["read"])
    etag = first.headers["etag"]
    assert (await async_client.get(f"{URL}/cash", headers={**tokens["read"], "If-None-Match": etag})).status_code == 304
    await _seed_cash(revenue_db)
    again = await async_client.get(f"{URL}/cash", headers={**tokens["read"], "If-None-Match": etag})
    assert again.status_code == 200 and again.json()["months"][-1]["collected"] == 500


@pytest.mark.asyncio
async def test_pipeline_reads_aito_cards_and_etag_moves_on_card_change(async_client, revenue_db, tokens):
    from backend.app.models.aito_project import AitoProject

    first = await async_client.get(f"{URL}/pipeline", headers=tokens["read"])
    assert first.json()["accepted"]["count"] == 0
    async with async_sessionmaker(revenue_db, expire_on_commit=False)() as db:
        db.add_all(
            [
                AitoProject(description="a", board_column="print", quote_status="accepted", quote_total=800),
                AitoProject(description="b", board_column="devis", quote_status="sent", quote_total=200),
                AitoProject(description="c", board_column="print", status="deleted", quote_status="accepted"),
            ]
        )
        await db.commit()
    again = await async_client.get(
        f"{URL}/pipeline", headers={**tokens["read"], "If-None-Match": first.headers["etag"]}
    )
    assert again.status_code == 200
    body = again.json()
    assert body["accepted"]["count"] == 1 and body["accepted"]["total"] == 800
    assert body["accepted"]["byColumn"] == [{"column": "print", "count": 1, "total": 800}]
    assert body["awaiting"]["count"] == 1 and body["awaiting"]["total"] == 200


@pytest.mark.asyncio
async def test_fixed_costs_need_margin_to_read_and_targets_too_to_write(async_client, revenue_db, tokens):
    url = f"{URL}/fixed-costs"
    assert (await async_client.get(url, headers=tokens["read"])).status_code == 403
    assert (await async_client.get(url, headers=tokens["read_margin"])).json() == {"costs": []}
    body = {"costs": [{"label": "  Loyer ", "monthly": 120000}]}
    for who in ("read_margin", "targets"):
        assert (await async_client.put(url, json=body, headers=tokens[who])).status_code == 403
    r = await async_client.put(url, json=body, headers=tokens["labor"])
    assert r.status_code == 200
    assert r.json() == {"costs": [{"label": "Loyer", "monthly": 120000}]}
    assert (await async_client.get(url, headers=tokens["labor"])).json() == r.json()
    for bad in (
        [{"label": "Loyer", "monthly": -1}],
        [{"label": "   ", "monthly": 1}],
        [{"label": "x" * 81, "monthly": 1}],
        [{"label": "a", "monthly": 1}] * 51,
    ):
        assert (await async_client.put(url, json={"costs": bad}, headers=tokens["labor"])).status_code == 422


@pytest.mark.asyncio
async def test_result_needs_margin_and_carries_twelve_months(async_client, revenue_db, tokens):
    url = f"{URL}/result"
    assert (await async_client.get(url, headers=tokens["read"])).status_code == 403
    body = (await async_client.get(url, headers=tokens["read_margin"])).json()
    assert set(body) == {"fixedMonthly", "charges", "months", "costsSince", "breakEven"}
    assert len(body["months"]) == 12
    assert set(body["months"][0]) == {
        "month",
        "ht",
        "variable",
        "labor",
        "fixed",
        "depreciation",
        "result",
        "coverage",
        "partial",
    }


@pytest.mark.asyncio
async def test_result_etag_moves_when_the_fixed_costs_change(async_client, revenue_db, tokens):
    url = f"{URL}/result"
    etag = (await async_client.get(url, headers=tokens["labor"])).headers["etag"]
    assert (await async_client.get(url, headers={**tokens["labor"], "If-None-Match": etag})).status_code == 304
    body = {"costs": [{"label": "Loyer", "monthly": 90000}]}
    assert (await async_client.put(f"{URL}/fixed-costs", json=body, headers=tokens["labor"])).status_code == 200
    again = await async_client.get(url, headers={**tokens["labor"], "If-None-Match": etag})
    assert again.status_code == 200 and again.json()["fixedMonthly"] == 90000


@pytest.mark.asyncio
async def test_cohorts_leave_out_sales_without_a_customer_and_the_walk_in_account(async_client, revenue_db, tokens):
    from backend.app.services.revenue.config import REVENUE_PASSAGE_CUSTOMER_IDS

    async with async_sessionmaker(revenue_db, expire_on_commit=False)() as db:
        lines = [
            RevenueLine(day="2025-03-11", item_id="i1", customer_id=c, name="PLA", sku="P1", quantity=1, amount=500)
            for c in ("", REVENUE_PASSAGE_CUSTOMER_IDS[0])
        ]
        await store.write_day(db, "2025-03-11", lines, True, NOW, 2)
    body = (await async_client.get(f"{URL}/cohorts", headers=tokens["read_customers"])).json()
    assert body["ltv"] == [{"segment": "inconnu", "customers": 1, "ltv12": 1000}]


@pytest.mark.asyncio
async def test_funnel_shape_and_etag_follow_the_board(async_client, revenue_db, tokens):
    from datetime import timedelta

    from backend.app.models.aito_project import AitoProject

    url = f"{URL}/funnel"
    first = await async_client.get(url, headers=tokens["read"])
    assert first.json()["sent"] == {"count": 0, "total": 0}
    sent = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=3)
    async with async_sessionmaker(revenue_db, expire_on_commit=False)() as db:
        card = {"description": "Logo", "board_column": "print", "quote_status": "accepted", "quote_total": 12000}
        db.add(AitoProject(**card, quote_sent_at=sent))
        await db.commit()
    again = await async_client.get(url, headers={**tokens["read"], "If-None-Match": first.headers["etag"]})
    assert again.status_code == 200
    assert again.json()["accepted"] == {"count": 1, "total": 12000}
    assert again.json()["bands"][1] == {"band": "medium", "decided": 1, "accepted": 1, "conversion": 100.0}


@pytest.mark.asyncio
async def test_pvm_compares_with_the_period_just_before(async_client, revenue_db, tokens):
    month = f"{DAY[:7]}-01"
    body = (await async_client.get(f"{URL}/pvm?from={month}&to={DAY}", headers=tokens["read"])).json()
    assert body["current"] == 1000 and body["previous"] == 0 and body["new"] == 1000
    assert body["previousTo"] < month
    assert (await async_client.get(f"{URL}/pvm?from={DAY}&to={month}", headers=tokens["read"])).status_code == 422


@pytest.mark.asyncio
async def test_cohorts_need_view_customers(async_client, revenue_db, tokens):
    url = f"{URL}/cohorts"
    assert (await async_client.get(url, headers=tokens["read"])).status_code == 403
    body = (await async_client.get(url, headers=tokens["read_customers"])).json()
    assert set(body) == {"cohorts", "ltv", "atRisk"}
    assert len(body["cohorts"]) == 12
    # c1 bought once, on 2025-03-10: older than a year, so it counts in the 12-month value.
    assert body["ltv"] == [{"segment": "inconnu", "customers": 1, "ltv12": 1000}]


@pytest.mark.asyncio
async def test_pvm_rejects_a_range_starting_before_the_history_start(async_client, revenue_db, tokens):
    early = await async_client.get(f"{URL}/pvm?from=0001-01-01&to=0001-01-10", headers=tokens["read"])
    assert early.status_code == 422
    at_start = await async_client.get(
        f"{URL}/pvm?from={revenue_routes.REVENUE_HISTORY_START}&to={DAY}", headers=tokens["read"]
    )
    assert at_start.status_code == 200


async def test_pvm_says_when_the_period_before_falls_outside_the_history(async_client, revenue_db, tokens):
    body = (await async_client.get(f"{URL}/pvm?from=2024-01-01&to={DAY}", headers=tokens["read"])).json()
    assert body["comparable"] is False
    assert (body["new"], body["current"]) == (0, 1000)
    month = (await async_client.get(f"{URL}/pvm?from={DAY[:7]}-01&to={DAY}", headers=tokens["read"])).json()
    assert month["comparable"] is True


ZOHO_ASSET = {
    "fixed_asset_id": "a1",
    "asset_number": "IMMO-1",
    "asset_name": "H2S01",
    "fixed_asset_type_name": "Machine 3D",
    "asset_cost": 360000,
    "depreciation_start_date": "2026-09-01",
    "total_life": 36,
    "status": "active",
    "created_by": "left out",
}
ASSET = {
    "id": "a1",
    "number": "IMMO-1",
    "name": "H2S01",
    "type": "Machine 3D",
    "cost": 360000,
    "start": "2026-09-01",
    "months": 36,
    "status": "active",
}


def _zoho_assets(monkeypatch, rows):
    from backend.app.services.zoho import zoho_service

    async def fake(_db):
        if isinstance(rows, Exception):
            raise rows
        return rows

    monkeypatch.setattr(zoho_service, "list_fixed_assets", fake)


@pytest.mark.asyncio
async def test_depreciation_rights_refresh_and_selection(async_client, revenue_db, tokens, monkeypatch):
    url = f"{URL}/depreciation"
    _zoho_assets(monkeypatch, [ZOHO_ASSET])
    assert (await async_client.get(url, headers=tokens["read"])).status_code == 403
    empty = {"assets": [], "selected": [], "readAt": None}
    assert (await async_client.get(url, headers=tokens["read_margin"])).json() == empty
    for who in ("read_margin", "targets"):
        assert (await async_client.post(f"{url}/refresh", headers=tokens[who])).status_code == 403
        assert (await async_client.put(url, json={"selected": []}, headers=tokens[who])).status_code == 403
    r = await async_client.post(f"{url}/refresh", headers=tokens["labor"])
    assert r.status_code == 200
    assert (r.json()["assets"], r.json()["selected"]) == ([ASSET], [])
    assert r.json()["readAt"]
    r = await async_client.put(url, json={"selected": ["a1"]}, headers=tokens["labor"])
    assert r.status_code == 200 and r.json()["selected"] == ["a1"]
    assert (await async_client.get(url, headers=tokens["labor"])).json() == r.json()
    assert (await async_client.put(url, json={"selected": ["nope"]}, headers=tokens["labor"])).status_code == 422
    # An asset deleted in Zoho leaves the selection with the list.
    _zoho_assets(monkeypatch, [])
    r = await async_client.post(f"{url}/refresh", headers=tokens["labor"])
    assert (r.json()["assets"], r.json()["selected"]) == ([], [])


@pytest.mark.asyncio
async def test_refresh_keeps_the_stored_list_when_zoho_fails(async_client, revenue_db, tokens, monkeypatch):
    from backend.app.services.zoho import ZohoNotConfiguredError, ZohoUnreachable

    url = f"{URL}/depreciation"
    _zoho_assets(monkeypatch, [ZOHO_ASSET])
    await async_client.post(f"{url}/refresh", headers=tokens["labor"])
    stored = (await async_client.put(url, json={"selected": ["a1"]}, headers=tokens["labor"])).json()
    _zoho_assets(monkeypatch, ZohoUnreachable("https://zoho.example/?token=SECRET"))
    r = await async_client.post(f"{url}/refresh", headers=tokens["labor"])
    assert r.status_code == 502 and "SECRET" not in r.text
    _zoho_assets(monkeypatch, ZohoNotConfiguredError("no credentials"))
    assert (await async_client.post(f"{url}/refresh", headers=tokens["labor"])).status_code == 409
    assert (await async_client.get(url, headers=tokens["labor"])).json() == stored


@pytest.mark.asyncio
async def test_result_etag_moves_when_the_depreciation_selection_changes(async_client, revenue_db, tokens, monkeypatch):
    url = f"{URL}/result"
    # A life that covers any "today" the test runs on.
    _zoho_assets(monkeypatch, [{**ZOHO_ASSET, "total_life": 1200}])
    await async_client.post(f"{URL}/depreciation/refresh", headers=tokens["labor"])
    etag = (await async_client.get(url, headers=tokens["labor"])).headers["etag"]
    assert (await async_client.get(url, headers={**tokens["labor"], "If-None-Match": etag})).status_code == 304
    put = await async_client.put(f"{URL}/depreciation", json={"selected": ["a1"]}, headers=tokens["labor"])
    assert put.status_code == 200
    again = await async_client.get(url, headers={**tokens["labor"], "If-None-Match": etag})
    assert again.status_code == 200 and again.json()["charges"]["depreciation"] == 300
    assert again.json()["months"][-1]["depreciation"] > 0


@pytest.mark.asyncio
async def test_series_etag_moves_when_the_depreciation_selection_changes(async_client, revenue_db, tokens, monkeypatch):
    two = [{**ZOHO_ASSET, "total_life": 1200}, {**ZOHO_ASSET, "fixed_asset_id": "a2", "total_life": 1200}]
    _zoho_assets(monkeypatch, two)
    await async_client.post(f"{URL}/depreciation/refresh", headers=tokens["labor"])
    # One asset already on: the by-the-minute stamp is there before and after, it cannot be what moves the ETag.
    await async_client.put(f"{URL}/depreciation", json={"selected": ["a1"]}, headers=tokens["labor"])
    etag = (await async_client.get(URL, params=MONTH, headers=tokens["labor"])).headers["etag"]
    put = await async_client.put(f"{URL}/depreciation", json={"selected": ["a1", "a2"]}, headers=tokens["labor"])
    assert put.status_code == 200
    again = await async_client.get(URL, params=MONTH, headers={**tokens["labor"], "If-None-Match": etag})
    assert again.status_code == 200


@pytest.mark.asyncio
async def test_refresh_stores_numbers_and_iso_days_whatever_zoho_sends(async_client, revenue_db, tokens, monkeypatch):
    rows = [
        {**ZOHO_ASSET, "asset_cost": "360000.00", "total_life": "36"},
        {**ZOHO_ASSET, "fixed_asset_id": "a2", "total_life": 36.0, "depreciation_start_date": "01/09/2026"},
        {**ZOHO_ASSET, "fixed_asset_id": "a3", "asset_cost": "n/a", "total_life": "three years"},
    ]
    _zoho_assets(monkeypatch, rows)
    got = (await async_client.post(f"{URL}/depreciation/refresh", headers=tokens["labor"])).json()["assets"]
    assert [(a["cost"], a["months"], a["start"]) for a in got] == [
        (360000.0, 36, "2026-09-01"),
        (360000.0, 36, None),
        (None, None, "2026-09-01"),
    ]
    assert all(type(a["months"]) is int for a in got[:2])
    # Selected all the same, none of them can break a margin read.
    ids = {"selected": ["a1", "a2", "a3"]}
    assert (await async_client.put(f"{URL}/depreciation", json=ids, headers=tokens["labor"])).status_code == 200
    assert (await async_client.get(f"{URL}/result", headers=tokens["labor"])).status_code == 200
