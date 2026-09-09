"""Tracking token: minting, link building, and the two response fields."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, text

from backend.app.models.aito_project import AitoProject
from backend.app.models.settings import Settings
from backend.app.services.aito_tracking import (
    TOKEN_ALPHABET,
    build_tracking_url,
    ensure_tracking_token,
    log_view,
    mint_token,
    normalize_token,
    purge_tracking_views,
    tracking_url,
    tracking_url_for,
)
from backend.tests.unit.test_aito_contacted import _declared_permissions


async def _create(client, **overrides):
    payload = {"description": "Job", "client_id": "zA", "client_name": "ACME", "client_phone": "+689 87 00 00 01"}
    payload.update(overrides)
    r = await client.post("/api/v1/aito/", json=payload)
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _project(db_session, pid: int) -> AitoProject:
    return (await db_session.execute(select(AitoProject).where(AitoProject.id == pid))).scalar_one()


async def _set_external_url(db_session, value: str):
    db_session.add(Settings(key="external_url", value=value))
    await db_session.commit()


def test_mint_token_is_six_crockford_chars_and_unique():
    # Six from the 32-symbol alphabet: no I, L, O, U, no lowercase, no
    # punctuation — a code that survives handwriting and a small QR.
    a, b = mint_token(), mint_token()
    assert len(a) == 6 and a != b
    assert all(c in TOKEN_ALPHABET for c in a)
    assert not set("ILOU-_") & set(TOKEN_ALPHABET)
    assert "".join(sorted(set(TOKEN_ALPHABET))) == TOKEN_ALPHABET


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("K7F3XQ", "K7F3XQ"),
        ("k7f3xq", "K7F3XQ"),  # case folded
        ("k7f-3xq", "K7F3XQ"),  # hyphen and space dropped
        (" K7F 3XQ ", "K7F3XQ"),
        ("kof3lq", "K0F31Q"),  # O → 0, L → 1
        ("KIF3XQ", "K1F3XQ"),  # I → 1
        ("K7F3X", None),  # too short
        ("K7F3XQ9", None),  # too long
        ("K7F3XU", None),  # U is not in the alphabet
        ("K7F3X!", None),
        ("", None),
    ],
)
def test_normalize_token_reads_what_a_client_typed(raw, expected):
    assert normalize_token(raw) == expected


def test_normalize_token_passes_a_legacy_long_token_through():
    legacy = "lQ38LSKdM7M9yUTn-7dvl_03NqAXCZP1hlqvpvMNKT4"
    assert normalize_token(legacy) == legacy


def test_tracking_url_for_needs_both_halves():
    assert tracking_url_for("", "abc") is None
    assert tracking_url_for("https://x.pf", None) is None
    assert tracking_url_for("https://x.pf", "abc") == "https://x.pf/t/abc"


@pytest.mark.asyncio
async def test_ensure_mints_once_and_is_stable(async_client, db_session):
    pid = await _create(async_client)
    project = await _project(db_session, pid)
    assert project.tracking_token is None
    first = await ensure_tracking_token(db_session, project)
    second = await ensure_tracking_token(db_session, project)
    await db_session.commit()
    assert first == second == (await _project(db_session, pid)).tracking_token
    other = await _project(db_session, await _create(async_client, description="other"))
    assert await ensure_tracking_token(db_session, other) != first


@pytest.mark.asyncio
async def test_ensure_token_race_loser_returns_winners_token(async_client, db_session):
    """Interleaving from T-007: operator A holds a `project` instance loaded
    before operator B minted and committed a token, so A's in-memory
    attribute is still None when A's own mint runs. The conditional UPDATE
    must lose to B's already-stored token instead of overwriting it, and A
    must walk away with B's token, not a second one."""
    pid = await _create(async_client)
    project = await _project(db_session, pid)
    assert project.tracking_token is None
    await _set(db_session, pid, tracking_token="tokenA")
    assert project.tracking_token is None  # A's stale in-memory view

    won = await ensure_tracking_token(db_session, project)
    await db_session.commit()

    assert won == "tokenA"
    assert project.tracking_token == "tokenA"
    assert (await _project(db_session, pid)).tracking_token == "tokenA"


@pytest.mark.asyncio
async def test_tracking_url_follows_external_url_without_minting(async_client, db_session):
    pid = await _create(async_client)
    project = await _project(db_session, pid)
    assert await tracking_url(db_session, project) is None
    assert project.tracking_token is None  # a read never mints
    await _set_external_url(db_session, "https://aito.example/")
    assert await tracking_url(db_session, project) is None  # still no token
    url = await build_tracking_url(db_session, project)
    assert url == f"https://aito.example/t/{project.tracking_token}"
    assert await tracking_url(db_session, project) == url


@pytest.mark.asyncio
async def test_build_mints_even_when_external_url_is_empty(async_client, db_session):
    project = await _project(db_session, await _create(async_client))
    assert await build_tracking_url(db_session, project) is None
    assert project.tracking_token is not None


@pytest.mark.asyncio
async def test_project_responses_carry_tracking_configured_but_not_the_url(async_client, db_session):
    """The board response exposes `tracking_configured` so the panel can show
    the right state, but never the URL itself — that bearer credential is
    served only by the AITO_UPDATE-gated /tracking-link and /tracking-token
    routes."""
    pid = await _create(async_client)
    body = (await async_client.get("/api/v1/aito/")).json()[0]
    assert body["tracking_configured"] is False
    assert "tracking_url" not in body
    await _set_external_url(db_session, "https://aito.example")
    project = await _project(db_session, pid)
    await ensure_tracking_token(db_session, project)
    await db_session.commit()
    body = (await async_client.get("/api/v1/aito/")).json()[0]
    assert body["tracking_configured"] is True
    assert "tracking_url" not in body


TRACK = "/api/v1/aito/track/"


async def _set(db_session, pid: int, **cols):
    sets = ", ".join(f"{k} = :{k}" for k in cols)
    await db_session.execute(text(f"UPDATE aito_projects SET {sets} WHERE id = :pid"), {"pid": pid, **cols})
    await db_session.commit()


async def _done_event(db_session, pid: int, days_ago: float):
    at = (datetime.now(timezone.utc) - timedelta(days=days_ago)).replace(tzinfo=None).isoformat(sep=" ")
    await db_session.execute(
        text(
            "INSERT INTO aito_events (project_id, occurred_at, kind, actor_class, changes) "
            "VALUES (:pid, :at, 'stage.changed', 'user', :changes)"
        ),
        {"pid": pid, "at": at, "changes": '[{"field": "column", "from": "finish", "to": "done"}]'},
    )
    await db_session.commit()


async def _token(async_client, db_session, pid: int) -> str:
    project = await _project(db_session, pid)
    token = await ensure_tracking_token(db_session, project)
    await db_session.commit()
    return token


@pytest.mark.asyncio
async def test_public_shape_titles_fallback_due_date_and_shipping(async_client, db_session):
    pid = await _create(async_client, description="job")
    await async_client.post(f"/api/v1/aito/{pid}/tasks", json={"title": "Support GoPro", "scan_cost": 1000.0})
    await async_client.post(f"/api/v1/aito/{pid}/tasks", json={"title": None, "modelisation_cost": 500.0})
    await _set(
        db_session,
        pid,
        due_date="2026-09-20",
        board_column="print",
        shipping_island="rangiroa",
        shipping_service="tuamotu",
        shipping_first_name="A",
        shipping_last_name="B",
        shipping_phone="+689-87000001",
        shipping_price=3200.0,
    )
    token = await _token(async_client, db_session, pid)

    r = await async_client.get(TRACK + token)
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    body = r.json()
    assert set(body) == {"column", "tasks", "due_date", "shipping", "done_at", "invoice", "reference", "updated_at"}
    assert body["updated_at"]  # project.updated_at, naive UTC ISO string
    assert body["column"] == "print"
    assert body["tasks"] == [{"title": "Support GoPro", "quantity": None}, {"title": "Pièce 2", "quantity": None}]
    assert body["due_date"] == "2026-09-20"
    assert body["shipping"]["island"] == "Rangiroa"  # label resolved server-side, key 'rangiroa' → its real label
    assert body["shipping"]["service"] == "Livraison Avion Tuamotu"
    # The air waybill is null until the parcel is handed over, then quoted verbatim.
    assert body["shipping"]["lta"] is None
    await _set(db_session, pid, shipping_lta="123-4567")
    assert (await async_client.get(TRACK + token)).json()["shipping"]["lta"] == "123-4567"
    assert body["done_at"] is None
    assert body["invoice"] is None
    assert body["reference"] is None
    await _set(db_session, pid, quote_number="EST-000142")
    assert (await async_client.get(TRACK + token)).json()["reference"] == "EST-000142"


@pytest.mark.asyncio
async def test_public_task_quantity_only_when_every_priced_service_agrees(async_client, db_session):
    pid = await _create(async_client)
    await async_client.post(
        f"/api/v1/aito/{pid}/tasks",
        json={
            "title": "agree",
            "scan_cost": 100.0,
            "scan_quantity": 2,
            "modelisation_cost": 50.0,
            "modelisation_quantity": 2,
        },
    )
    await async_client.post(
        f"/api/v1/aito/{pid}/tasks",
        json={
            "title": "disagree",
            "scan_cost": 100.0,
            "scan_quantity": 2,
            "modelisation_cost": 50.0,
            "modelisation_quantity": 1,
        },
    )
    await async_client.post(
        f"/api/v1/aito/{pid}/tasks", json={"title": "single", "scan_cost": 100.0, "scan_quantity": 1}
    )
    await async_client.post(
        f"/api/v1/aito/{pid}/tasks",
        json={"title": "print only", "impression_cost": 900.0, "impression_quantity": 3, "scan_quantity": 7},
    )  # unpriced scan ignored
    tasks = (await async_client.get(TRACK + await _token(async_client, db_session, pid))).json()["tasks"]
    assert [t["quantity"] for t in tasks] == [2, None, None, 3]


@pytest.mark.asyncio
async def test_public_updated_at_is_the_latest_event_else_the_row_timestamp(async_client, db_session):
    pid = await _create(async_client)
    token = await _token(async_client, db_session, pid)
    # A fresh card has a project.created event from the API; force a known latest event.
    await _done_event(db_session, pid, 0.5)  # 12 h ago
    body = (await async_client.get(TRACK + token)).json()
    latest = (
        await db_session.execute(
            text("SELECT MAX(COALESCE(occurred_until, occurred_at)) FROM aito_events WHERE project_id = :pid"),
            {"pid": pid},
        )
    ).scalar_one()
    assert body["updated_at"].replace("T", " ")[:19] == str(latest)[:19]
    # A coalesced editing session (occurred_until set by the folding path in
    # services/aito_events.py) reports the window's END, not its start.
    until = (datetime.now(timezone.utc) + timedelta(hours=1)).replace(tzinfo=None, microsecond=0)
    await db_session.execute(
        text(
            "UPDATE aito_events SET occurred_until = :until "
            "WHERE id = (SELECT id FROM aito_events WHERE project_id = :pid ORDER BY occurred_at DESC LIMIT 1)"
        ),
        {"until": until.isoformat(sep=" "), "pid": pid},
    )
    await db_session.commit()
    body = (await async_client.get(TRACK + token)).json()
    assert body["updated_at"].replace("T", " ")[:19] == until.isoformat(sep=" ")[:19]
    await db_session.execute(text("DELETE FROM aito_events WHERE project_id = :pid"), {"pid": pid})
    await db_session.commit()
    body = (await async_client.get(TRACK + token)).json()
    row = (
        await db_session.execute(text("SELECT updated_at FROM aito_projects WHERE id = :pid"), {"pid": pid})
    ).scalar_one()
    assert body["updated_at"].replace("T", " ")[:19] == str(row)[:19]


@pytest.mark.asyncio
async def test_log_view_dedups_within_5min_but_not_across_projects_or_past_the_window(async_client, db_session):
    pid = await _create(async_client)
    other_pid = await _create(async_client, description="other")

    def count(project_id):
        return db_session.execute(
            text("SELECT COUNT(*) FROM aito_tracking_views WHERE project_id = :pid"), {"pid": project_id}
        )

    base = datetime(2026, 9, 6, 12, 0, 0)
    await log_view(db_session, pid, base)
    assert (await count(pid)).scalar_one() == 1

    # A repeat open 4 minutes later — inside the window — writes nothing.
    await log_view(db_session, pid, base + timedelta(minutes=4))
    assert (await count(pid)).scalar_one() == 1

    # A different project inside the same window still writes.
    await log_view(db_session, other_pid, base + timedelta(minutes=4))
    assert (await count(other_pid)).scalar_one() == 1

    # An open 5+ minutes after the first write is outside the window.
    await log_view(db_session, pid, base + timedelta(minutes=5, seconds=1))
    assert (await count(pid)).scalar_one() == 2


@pytest.mark.asyncio
async def test_public_view_is_logged_once_per_open_deduped_within_5min_and_never_breaks_the_page(
    async_client, db_session, monkeypatch
):
    pid = await _create(async_client)
    token = await _token(async_client, db_session, pid)

    def count(project_id=pid):
        return db_session.execute(
            text("SELECT COUNT(*) FROM aito_tracking_views WHERE project_id = :pid"), {"pid": project_id}
        )

    # A repeat open of the same project inside the 5-minute dedup window
    # (a refresh, a link-scanner refetch) writes no new row.
    assert (await async_client.get(TRACK + token)).status_code == 200
    assert (await async_client.get(TRACK + token)).status_code == 200
    assert (await async_client.get(TRACK + "nope")).status_code == 404
    assert (await count()).scalar_one() == 1

    # A different project opened inside the same window still writes.
    other_pid = await _create(async_client, description="other")
    other_token = await _token(async_client, db_session, other_pid)
    assert (await async_client.get(TRACK + other_token)).status_code == 200
    assert (await count()).scalar_one() == 1
    assert (await count(other_pid)).scalar_one() == 1

    # An open 5+ minutes later writes a second row for the original project.
    from backend.app.api.routes import aito as aito_routes

    class _ShiftedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.now(tz) + timedelta(minutes=6)

    monkeypatch.setattr(aito_routes, "datetime", _ShiftedDatetime)
    assert (await async_client.get(TRACK + token)).status_code == 200
    assert (await count()).scalar_one() == 2
    monkeypatch.undo()

    from backend.app.services import aito_tracking as svc

    async def boom(*_args, **_kwargs):
        raise RuntimeError("disk full")

    monkeypatch.setattr(svc, "log_view", boom)
    assert (await async_client.get(TRACK + token)).status_code == 200
    assert (await count()).scalar_one() == 2


@pytest.mark.asyncio
async def test_purge_tracking_views_drops_only_rows_past_retention(async_client, db_session):
    pid = await _create(async_client)
    old = (datetime.now(timezone.utc) - timedelta(days=401)).replace(tzinfo=None)
    recent = (datetime.now(timezone.utc) - timedelta(days=399)).replace(tzinfo=None)
    await db_session.execute(
        text("INSERT INTO aito_tracking_views (project_id, viewed_at) VALUES (:pid, :at)"),
        {"pid": pid, "at": old.isoformat(sep=" ")},
    )
    await db_session.execute(
        text("INSERT INTO aito_tracking_views (project_id, viewed_at) VALUES (:pid, :at)"),
        {"pid": pid, "at": recent.isoformat(sep=" ")},
    )
    await db_session.commit()

    removed = await purge_tracking_views(db_session)
    assert removed == 1

    remaining = (
        (
            await db_session.execute(
                text("SELECT viewed_at FROM aito_tracking_views WHERE project_id = :pid"), {"pid": pid}
            )
        )
        .scalars()
        .all()
    )
    assert len(remaining) == 1
    assert str(remaining[0])[:19] == recent.isoformat(sep=" ")[:19]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "expected"),
    [
        ("paid", "paid"),
        ("overdue", "overdue"),
        ("sent", "unpaid"),
        ("unpaid", "unpaid"),
        ("partially_paid", "unpaid"),
        ("draft", None),
        ("void", None),
        (None, None),
    ],
)
async def test_public_invoice_state_is_mapped_without_amounts(async_client, db_session, status, expected):
    pid = await _create(async_client)
    await _set(db_session, pid, invoice_status=status, invoice_balance=1234.5)
    body = await async_client.get(TRACK + await _token(async_client, db_session, pid))
    assert body.status_code == 200
    assert body.json()["invoice"] == expected
    assert "1234" not in body.text and "balance" not in body.text


@pytest.mark.asyncio
async def test_public_404s_for_unknown_and_trashed(async_client, db_session):
    pid = await _create(async_client)
    token = await _token(async_client, db_session, pid)
    unknown = await async_client.get(TRACK + "nope")
    assert unknown.status_code == 404
    assert unknown.headers["cache-control"] == "no-store"
    assert (await async_client.get(TRACK + token)).status_code == 200
    await _set(db_session, pid, status="deleted")
    r = await async_client.get(TRACK + token)
    assert r.status_code == 404 and r.json() == {"detail": "Lien introuvable"}
    assert r.headers["cache-control"] == "no-store"


@pytest.mark.asyncio
async def test_public_expires_30_days_after_the_latest_move_to_done(async_client, db_session):
    fresh = await _create(async_client, description="fresh")
    stale = await _create(async_client, description="stale")
    never = await _create(async_client, description="never")
    for pid in (fresh, stale, never):
        await _set(db_session, pid, board_column="done")
    await _done_event(db_session, fresh, 29)
    await _done_event(db_session, stale, 40)
    await _done_event(db_session, stale, 31)  # latest is still > 30 days
    assert (await async_client.get(TRACK + await _token(async_client, db_session, fresh))).status_code == 200
    expired = await async_client.get(TRACK + await _token(async_client, db_session, stale))
    assert expired.status_code == 404
    assert expired.headers["cache-control"] == "no-store"
    # No stage.changed-to-done event at all (pre-event-log card): the clock
    # runs from its last activity instead, and it was created just now.
    assert (await async_client.get(TRACK + await _token(async_client, db_session, never))).status_code == 200
    # Left Done and came back 2 days ago → fresh window, and done_at is that move.
    await _done_event(db_session, stale, 2)
    r = await async_client.get(TRACK + await _token(async_client, db_session, stale))
    assert r.status_code == 200 and r.json()["done_at"] is not None


@pytest.mark.asyncio
async def test_public_never_leaks_client_or_money(async_client, db_session):
    pid = await _create(async_client, client_name="Secret Person", client_email="s@example.pf")
    await _set(db_session, pid, quote_total=12345.0)
    body = (await async_client.get(TRACK + await _token(async_client, db_session, pid))).text
    for needle in ("Secret", "example.pf", "12345", "client", "quote_", "balance", "total", '"id"'):
        assert needle not in body


@pytest.mark.asyncio
async def test_link_route_mints_and_regenerate_replaces(async_client, db_session):
    await _set_external_url(db_session, "https://aito.example")
    pid = await _create(async_client)
    first_resp = await async_client.get(f"/api/v1/aito/{pid}/tracking-link")
    first = first_resp.json()["tracking_url"]
    assert first.startswith("https://aito.example/t/")
    assert first_resp.headers["cache-control"] == "no-store"
    assert (await async_client.get(f"/api/v1/aito/{pid}/tracking-link")).json()["tracking_url"] == first
    old_token = first.rsplit("/", 1)[1]
    assert (await async_client.get(TRACK + old_token)).status_code == 200

    second_resp = await async_client.post(f"/api/v1/aito/{pid}/tracking-token")
    second = second_resp.json()["tracking_url"]
    assert second_resp.headers["cache-control"] == "no-store"
    assert second != first
    assert (await async_client.get(TRACK + old_token)).status_code == 404
    assert (await async_client.get(TRACK + second.rsplit("/", 1)[1])).status_code == 200
    events = (await async_client.get(f"/api/v1/aito/{pid}/events")).json()
    kinds = [e["kind"] for e in events["events"]]
    assert "tracking.regenerated" in kinds
    assert old_token not in (await async_client.get(f"/api/v1/aito/{pid}/events")).text


@pytest.mark.asyncio
async def test_link_route_without_external_url_returns_null_but_mints(async_client, db_session):
    pid = await _create(async_client)
    resp = await async_client.get(f"/api/v1/aito/{pid}/tracking-link")
    assert resp.json()["tracking_url"] is None
    assert resp.headers["cache-control"] == "no-store"
    assert (await _project(db_session, pid)).tracking_token is not None


@pytest.mark.asyncio
async def test_public_route_bypasses_auth_middleware_but_siblings_do_not(async_client, db_session):
    pid = await _create(async_client)
    token = await _token(async_client, db_session, pid)
    db_session.add(Settings(key="auth_enabled", value="true"))
    await db_session.commit()
    assert (await async_client.get(TRACK + token)).status_code == 200
    assert (await async_client.get(f"/api/v1/aito/{pid}/tracking-link")).status_code == 401
    assert (await async_client.get("/api/v1/aito/")).status_code == 401


def test_permissions():
    from backend.app.main import app

    assert _declared_permissions("get_tracking_link") == ["aito:update"]
    assert _declared_permissions("regenerate_tracking_token") == ["aito:update"]
    route = next(r for r in app.routes if getattr(r, "name", "") == "get_tracking")
    assert all(d.name != "current_user" for d in route.dependant.dependencies)


@pytest.mark.asyncio
async def test_public_route_accepts_a_typed_code_in_any_case(async_client, db_session):
    pid = await _create(async_client)
    project = await _project(db_session, pid)
    token = await ensure_tracking_token(db_session, project)
    await db_session.commit()
    assert len(token) == 6
    typed = token.lower().replace("0", "o").replace("1", "l")
    r = await async_client.get(f"/api/v1/aito/track/{typed}")
    assert r.status_code == 200, r.text
    r = await async_client.get(f"/api/v1/aito/track/{token}x")
    assert r.status_code == 404


class _Clock:
    """Stands in for routes/aito.py's `time` name — see test_aito_proofread_route."""

    def __init__(self) -> None:
        self.now = 1000.0

    def monotonic(self) -> float:
        return self.now


@pytest.mark.asyncio
async def test_public_route_is_rate_limited_per_ip_and_recovers(async_client, monkeypatch):
    from backend.app.api.routes import aito as aito_routes

    clock = _Clock()
    monkeypatch.setattr(aito_routes, "time", clock)
    aito_routes._reset_track_rate_limits()
    for _ in range(aito_routes._TRACK_RATE_MAX_MISSES_PER_IP):
        assert (await async_client.get("/api/v1/aito/track/ZZZZZZ")).status_code == 404
    r = await async_client.get("/api/v1/aito/track/ZZZZZZ")
    assert r.status_code == 429
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["retry-after"] == "60"
    clock.now += aito_routes._TRACK_RATE_WINDOW_S + 1
    assert (await async_client.get("/api/v1/aito/track/ZZZZZZ")).status_code == 404
    aito_routes._reset_track_rate_limits()


@pytest.mark.asyncio
async def test_public_route_global_cap_holds_across_addresses(async_client, monkeypatch):
    from backend.app.api.routes import aito as aito_routes

    clock = _Clock()
    monkeypatch.setattr(aito_routes, "time", clock)
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_MISSES_GLOBAL", 3)
    aito_routes._reset_track_rate_limits()
    # Three calls fill the global window even though no single IP is near
    # its own cap; the fourth is refused whoever sends it.
    for _ in range(3):
        assert (await async_client.get("/api/v1/aito/track/ZZZZZZ")).status_code == 404
    assert (await async_client.get("/api/v1/aito/track/ZZZZZZ")).status_code == 429
    aito_routes._reset_track_rate_limits()


@pytest.mark.asyncio
async def test_public_route_rate_limit_unwraps_a_trusted_proxy_and_forgets_idle_hosts(async_client, monkeypatch):
    from backend.app.api.routes import aito as aito_routes, auth as auth_routes

    clock = _Clock()
    monkeypatch.setattr(aito_routes, "time", clock)
    # The test client's TCP peer is the trusted proxy; the real visitor is
    # whoever X-Forwarded-For names, so two visitors get two buckets.
    monkeypatch.setattr(auth_routes, "_TRUSTED_PROXY_IPS", frozenset({"127.0.0.1", "testclient"}))
    for _ in range(aito_routes._TRACK_RATE_MAX_MISSES_PER_IP):
        r = await async_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": "203.0.113.5"})
        assert r.status_code == 404
    r = await async_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": "203.0.113.5"})
    assert r.status_code == 429
    r = await async_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": "203.0.113.6"})
    assert r.status_code == 404
    assert set(aito_routes._track_rate_ip_misses) == {"203.0.113.5", "203.0.113.6"}
    # Once the dict is bigger than a window can justify, hosts whose calls
    # have all aged out are swept — including ones that never come back.
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_SWEEP_ABOVE", 1)
    clock.now += aito_routes._TRACK_RATE_WINDOW_S + 1
    r = await async_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": "203.0.113.7"})
    assert r.status_code == 404
    assert set(aito_routes._track_rate_ip_misses) == {"203.0.113.7"}


@pytest.mark.asyncio
async def test_regenerate_rewrites_the_quote_notes_with_the_new_link(async_client, db_session, monkeypatch):
    from backend.app.services.zoho import zoho_service

    await _set_external_url(db_session, "https://aito.example")
    pid = await _create(async_client)
    old = await _token(async_client, db_session, pid)
    await _set(db_session, pid, quote_id="E1")
    remote = {
        "notes": f"Signature du client\n\nLien de suivi de votre projet : https://aito.example/t/{old}\nCode de suivi : {old}"
    }
    written = []

    async def fake_get_estimate(db, estimate_id):
        return {"estimate_id": estimate_id, **remote}

    async def fake_update_estimate_notes(db, estimate_id, notes):
        written.append((estimate_id, notes))
        return {}

    monkeypatch.setattr(zoho_service, "get_estimate", fake_get_estimate)
    monkeypatch.setattr(zoho_service, "update_estimate_notes", fake_update_estimate_notes)

    body = (await async_client.post(f"/api/v1/aito/{pid}/tracking-token")).json()
    new = body["tracking_url"].rsplit("/", 1)[1]
    assert new != old and body["quote_notes"] == "updated"
    assert written == [
        (
            "E1",
            f"Signature du client\n\nLien de suivi de votre projet : https://aito.example/t/{new}\nCode de suivi : {new}",
        )
    ]
    # "detail" depth: the regenerate is filed there (services/aito_events.py), below the story.
    events = (await async_client.get(f"/api/v1/aito/{pid}/events?depth=detail")).json()["events"]
    regen = next(e for e in events if e["kind"] == "tracking.regenerated")
    assert regen["detail"] == {"quote_notes": "updated"}


@pytest.mark.asyncio
async def test_regenerate_still_replaces_the_token_when_books_is_away(async_client, db_session, monkeypatch):
    from backend.app.services.zoho import zoho_service

    await _set_external_url(db_session, "https://aito.example")
    pid = await _create(async_client)
    old = await _token(async_client, db_session, pid)
    await _set(db_session, pid, quote_id="E1")

    async def failing_get_estimate(db, estimate_id):
        raise RuntimeError("Books is away")

    monkeypatch.setattr(zoho_service, "get_estimate", failing_get_estimate)
    body = (await async_client.post(f"/api/v1/aito/{pid}/tracking-token")).json()
    assert body["quote_notes"] == "failed"
    assert body["tracking_url"].rsplit("/", 1)[1] != old
    # The old link is dead regardless.
    assert (await async_client.get(TRACK + old)).status_code == 404


@pytest.mark.asyncio
async def test_regenerate_without_a_quote_reports_no_notes(async_client, db_session):
    await _set_external_url(db_session, "https://aito.example")
    pid = await _create(async_client)
    body = (await async_client.post(f"/api/v1/aito/{pid}/tracking-token")).json()
    assert body["quote_notes"] is None


# ── Review follow-ups (2026-09-08 security review) ───────────────────────────


@pytest.mark.asyncio
async def test_public_404s_once_the_quote_is_declined_or_expired(async_client, db_session):
    """The rules park a declined quote in Done (aito_board_rules.evaluate),
    and the page used to read that as "Récupérée le …" — on the link printed
    on the very quote the client just declined. A settled-the-other-way
    quote has no story to tell: same 404 as an unknown link."""
    pid = await _create(async_client)
    token = await _token(async_client, db_session, pid)
    assert (await async_client.get(TRACK + token)).status_code == 200
    await _set(db_session, pid, quote_status="declined", board_column="done")
    r = await async_client.get(TRACK + token)
    assert r.status_code == 404 and r.headers["cache-control"] == "no-store"
    await _set(db_session, pid, quote_status="expired", board_column="waiting")
    assert (await async_client.get(TRACK + token)).status_code == 404
    # Derived, never destroyed: an acceptance in Books brings the link back.
    await _set(db_session, pid, quote_status="accepted", board_column="scan")
    assert (await async_client.get(TRACK + token)).status_code == 200


async def _age(db_session, pid: int, days: float) -> None:
    """Push every trace of activity on the card `days` into the past — its
    events and its row timestamp — so last_activity reads that old."""
    at = (datetime.now(timezone.utc) - timedelta(days=days)).replace(tzinfo=None).isoformat(sep=" ")
    await db_session.execute(
        text("UPDATE aito_events SET occurred_at = :at, occurred_until = NULL WHERE project_id = :pid"),
        {"pid": pid, "at": at},
    )
    await _set(db_session, pid, updated_at=at)


@pytest.mark.asyncio
async def test_public_expires_a_dormant_card_that_never_got_the_go_ahead(async_client, db_session):
    """Every quoted card gets a code (the sync prints it on the estimate), and
    only Done ever expired — so an abandoned quote kept a live code forever
    and the guessable space filled up with them. A card still waiting for
    its go-ahead goes dark after TRACKING_TTL_DORMANT of silence; any
    activity on it — an edit, a status from Books — is a fresh clock."""
    from backend.app.services.aito_tracking import TRACKING_TTL_DORMANT

    pid = await _create(async_client)
    token = await _token(async_client, db_session, pid)
    await _age(db_session, pid, TRACKING_TTL_DORMANT.days - 1)
    assert (await async_client.get(TRACK + token)).status_code == 200
    await _age(db_session, pid, TRACKING_TTL_DORMANT.days + 1)
    assert (await async_client.get(TRACK + token)).status_code == 404
    await _set(db_session, pid, quote_status="sent", board_column="waiting")
    assert (await async_client.get(TRACK + token)).status_code == 404
    # A card in production is never dormant, however quiet.
    await _set(db_session, pid, quote_status="accepted", board_column="print")
    assert (await async_client.get(TRACK + token)).status_code == 200
    # Back to waiting, but with fresh activity: alive again.
    await _set(db_session, pid, quote_status="sent", board_column="waiting")
    await _done_event(db_session, pid, 0)  # any event is activity; the kind is irrelevant here
    assert (await async_client.get(TRACK + token)).status_code == 200


@pytest.mark.asyncio
async def test_public_done_without_a_stage_event_expires_from_its_last_activity(async_client, db_session):
    """A card that reached Done without a stage.changed event (imported
    straight into Done, or older than the event log) had no expiry clock at
    all. Its last activity stands in — but only for the clock: done_at on
    the page stays null, because "collected on <some edit's date>" would
    be a made-up fact."""
    pid = await _create(async_client)
    token = await _token(async_client, db_session, pid)
    await _set(db_session, pid, quote_status="accepted", board_column="done")
    r = await async_client.get(TRACK + token)
    assert r.status_code == 200 and r.json()["done_at"] is None
    await _age(db_session, pid, 29)
    r = await async_client.get(TRACK + token)
    assert r.status_code == 200 and r.json()["done_at"] is None
    await _age(db_session, pid, 31)
    assert (await async_client.get(TRACK + token)).status_code == 404


@pytest.mark.asyncio
async def test_public_route_hits_never_count_against_the_caps(async_client, db_session, monkeypatch):
    """A guesser only ever produces misses and a real client only ever
    produces hits, so the caps count misses. Otherwise a promo SMS to a
    carrier-grade-NAT town, or one scanner at the global cap, locked every
    client out of their own page."""
    from backend.app.api.routes import aito as aito_routes

    clock = _Clock()
    monkeypatch.setattr(aito_routes, "time", clock)
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_MISSES_GLOBAL", 2)
    pid = await _create(async_client)
    token = await _token(async_client, db_session, pid)
    aito_routes._reset_track_rate_limits()
    for _ in range(aito_routes._TRACK_RATE_MAX_MISSES_PER_IP + 5):
        assert (await async_client.get(TRACK + token)).status_code == 200
    # Misses are still capped — globally here. Past a tripped miss cap
    # EVERYTHING is a 429, hits included: a hit cannot be told apart before
    # the lookup runs, and answering hits through the cap would hand a
    # guesser exactly the oracle the cap exists to hide.
    assert (await async_client.get(TRACK + "ZZZZZZ")).status_code == 404
    assert (await async_client.get(TRACK + "ZZZZZZ")).status_code == 404
    assert (await async_client.get(TRACK + "ZZZZZZ")).status_code == 429
    assert (await async_client.get(TRACK + token)).status_code == 429
    clock.now += aito_routes._TRACK_RATE_WINDOW_S + 1
    assert (await async_client.get(TRACK + token)).status_code == 200
    aito_routes._reset_track_rate_limits()


def test_public_route_reserves_the_miss_at_arrival_and_releases_it_on_a_hit(monkeypatch):
    """The caps are enforced when a call ARRIVES, not after its lookup: with
    the miss counted afterwards, every request in flight at once passed the
    pre-check together, and a scanner spreading addresses could fire a whole
    window's worth of guesses concurrently. A hit releases what it reserved,
    so a client still pays nothing."""
    from types import SimpleNamespace

    from backend.app.api.routes import aito as aito_routes

    clock = _Clock()
    monkeypatch.setattr(aito_routes, "time", clock)
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_MISSES_GLOBAL", 3)
    aito_routes._reset_track_rate_limits()
    request = SimpleNamespace(client=SimpleNamespace(host="203.0.113.9"), headers={})
    # Three arrivals, none looked up yet: the fourth is already refused.
    stamps = [aito_routes._track_rate_limited(request) for _ in range(3)]
    assert all(stamps)
    assert aito_routes._track_rate_limited(request) is None
    # One of them turns out to be a hit and hands its slot back.
    aito_routes._track_rate_hit(*stamps[0])
    assert aito_routes._track_rate_limited(request) is not None
    assert aito_routes._track_rate_limited(request) is None
    aito_routes._reset_track_rate_limits()


@pytest.mark.asyncio
async def test_public_route_global_cap_holds_under_concurrent_misses(async_client, monkeypatch):
    import asyncio

    from backend.app.api.routes import aito as aito_routes

    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_MISSES_GLOBAL", 3)
    aito_routes._reset_track_rate_limits()
    codes = [await async_client.get(TRACK + "ZZZZZZ") for _ in range(0)]  # warm nothing
    results = await asyncio.gather(*(async_client.get(TRACK + "ZZZZZZ") for _ in range(12)))
    codes = sorted(r.status_code for r in results)
    assert codes.count(404) == 3 and codes.count(429) == 9
    aito_routes._reset_track_rate_limits()


@pytest.mark.asyncio
async def test_public_route_backstops_a_single_address_whatever_it_sends(async_client, db_session, monkeypatch):
    """Hits are uncapped by the miss windows, not free: one address looping
    on a valid code still meets a generous per-address ceiling."""
    from backend.app.api.routes import aito as aito_routes

    clock = _Clock()
    monkeypatch.setattr(aito_routes, "time", clock)
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_CALLS_PER_IP", 4)
    pid = await _create(async_client)
    token = await _token(async_client, db_session, pid)
    aito_routes._reset_track_rate_limits()
    for _ in range(4):
        assert (await async_client.get(TRACK + token)).status_code == 200
    r = await async_client.get(TRACK + token)
    assert r.status_code == 429 and r.headers["retry-after"] == "60"
    clock.now += aito_routes._TRACK_RATE_WINDOW_S + 1
    assert (await async_client.get(TRACK + token)).status_code == 200
    aito_routes._reset_track_rate_limits()


@pytest.mark.asyncio
async def test_regenerate_commits_the_new_token_before_talking_to_books(async_client, db_session, monkeypatch):
    """The new token is committed BEFORE the estimate is fetched. Otherwise
    the dirty row autoflushed on the first settings read inside the Zoho
    client and SQLite's write lock was held across two HTTP round trips —
    longer than the busy timeout when Books is slow, so unrelated writers
    (MQTT status, the sync worker) failed with "database is locked"."""
    from backend.app.services.zoho import zoho_service

    await _set_external_url(db_session, "https://aito.example")
    pid = await _create(async_client)
    old = await _token(async_client, db_session, pid)
    await _set(db_session, pid, quote_id="E1")
    seen: dict[str, str | None] = {}

    async def fake_get_estimate(db, estimate_id):
        # A different session sees only what is committed.
        seen["token"] = (
            await db_session.execute(select(AitoProject.tracking_token).where(AitoProject.id == pid))
        ).scalar_one()
        return {"estimate_id": estimate_id, "notes": ""}

    async def fake_update_estimate_notes(db, estimate_id, notes):
        return {}

    monkeypatch.setattr(zoho_service, "get_estimate", fake_get_estimate)
    monkeypatch.setattr(zoho_service, "update_estimate_notes", fake_update_estimate_notes)
    body = (await async_client.post(f"/api/v1/aito/{pid}/tracking-token")).json()
    new = body["tracking_url"].rsplit("/", 1)[1]
    assert new != old and seen["token"] == new
