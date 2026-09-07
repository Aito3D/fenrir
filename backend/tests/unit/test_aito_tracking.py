"""Tracking token: minting, link building, and the two response fields."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, text

from backend.app.models.aito_project import AitoProject
from backend.app.models.settings import Settings
from backend.app.services.aito_tracking import (
    build_tracking_url,
    ensure_tracking_token,
    log_view,
    mint_token,
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


def test_mint_token_is_43_urlsafe_chars_and_unique():
    a, b = mint_token(), mint_token()
    assert len(a) == 43 and a != b
    assert all(c.isalnum() or c in "-_" for c in a)


def test_tracking_url_for_needs_both_halves():
    assert tracking_url_for("", "abc") is None
    assert tracking_url_for("https://x.pf", None) is None
    assert tracking_url_for("https://x.pf", "abc") == "https://x.pf/track/abc"


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
    assert url == f"https://aito.example/track/{project.tracking_token}"
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
    # No stage.changed-to-done event at all (pre-event-log card): never expires.
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
    assert first.startswith("https://aito.example/track/")
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
    assert resp.json() == {"tracking_url": None}
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
