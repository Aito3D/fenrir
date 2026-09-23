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
    mint_unique_token,
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
async def test_mint_unique_token_retries_past_a_collision(async_client, db_session, monkeypatch):
    """T-032: every existing test mints against an empty tracking_token
    column, so the retry body (a second lap of the `for` loop) never ran.
    Force a first candidate that collides — with a TRASHED card's token,
    proving the uniqueness lookup does not filter on status — and confirm
    the loop draws again and returns the fresh candidate, not the taken
    one."""
    taken_pid = await _create(async_client, description="trashed")
    await _set(db_session, taken_pid, status="deleted", tracking_token="TAKEN1")

    from backend.app.services import aito_tracking as svc

    candidates = ["TAKEN1", "FRESH2"]
    calls: list[str] = []

    def fake_mint_token():
        calls.append(candidates[len(calls)])
        return calls[-1]

    monkeypatch.setattr(svc, "mint_token", fake_mint_token)

    token = await mint_unique_token(db_session)

    assert token == "FRESH2"
    assert calls == ["TAKEN1", "FRESH2"]  # collided once, then a single fresh draw won — no third


@pytest.mark.asyncio
async def test_mint_unique_token_gives_up_after_ten_collisions(async_client, db_session, monkeypatch):
    """Every candidate collides with the same taken card: after 10 draws the
    loop raises instead of looping forever or handing out a duplicate."""
    taken_pid = await _create(async_client)
    await _set(db_session, taken_pid, tracking_token="TAKEN1")

    from backend.app.services import aito_tracking as svc

    calls: list[str] = []

    def fake_mint_token():
        calls.append("TAKEN1")
        return "TAKEN1"

    monkeypatch.setattr(svc, "mint_token", fake_mint_token)

    with pytest.raises(RuntimeError, match="could not mint a unique tracking token"):
        await mint_unique_token(db_session)

    assert len(calls) == 10  # the loop's own bound is exercised, not an infinite retry


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
    assert set(body) == {
        "column",
        "tasks",
        "due_date",
        "shipping",
        "done_at",
        "invoice",
        "reference",
        "updated_at",
        "payment",
    }
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


@pytest.fixture
def track_rate_clock(monkeypatch):
    """Shared setup/teardown for the public tracking route's rate limiter:
    build the `_Clock` double, patch it in as `routes/aito.py`'s `time`
    name, and reset the limiter's module-level state before and after the
    test (belt-and-braces alongside conftest's autouse reset, since a test
    here may monkeypatch the limiter's tunables before its first call)."""
    from backend.app.api.routes import aito as aito_routes

    clock = _Clock()
    monkeypatch.setattr(aito_routes, "time", clock)
    aito_routes._reset_track_rate_limits()
    yield clock
    aito_routes._reset_track_rate_limits()


async def _exhaust_ip_misses(client, token="ZZZZZZ", headers=None):
    """Send exactly `_TRACK_RATE_MAX_MISSES_PER_IP` guesses at `token`,
    asserting each one misses (404) — the per-IP cap is now full and the
    next call is the one a test actually wants to look at."""
    from backend.app.api.routes import aito as aito_routes

    for _ in range(aito_routes._TRACK_RATE_MAX_MISSES_PER_IP):
        r = await client.get(TRACK + token, headers=headers)
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_public_route_is_rate_limited_per_ip_and_recovers(async_client, track_rate_clock):
    from backend.app.api.routes import aito as aito_routes

    clock = track_rate_clock
    await _exhaust_ip_misses(async_client)
    r = await async_client.get("/api/v1/aito/track/ZZZZZZ")
    assert r.status_code == 429
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["retry-after"] == "60"
    clock.now += aito_routes._TRACK_RATE_WINDOW_S + 1
    assert (await async_client.get("/api/v1/aito/track/ZZZZZZ")).status_code == 404


@pytest.mark.asyncio
async def test_public_route_global_cap_holds_across_addresses(async_client, track_rate_clock, monkeypatch):
    from backend.app.api.routes import aito as aito_routes

    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_MISSES_PER_NET", 3)
    # Three calls fill the global window even though no single IP is near
    # its own cap; the fourth is refused whoever sends it.
    for _ in range(3):
        assert (await async_client.get("/api/v1/aito/track/ZZZZZZ")).status_code == 404
    assert (await async_client.get("/api/v1/aito/track/ZZZZZZ")).status_code == 429


@pytest.mark.asyncio
async def test_public_route_rate_limit_unwraps_a_trusted_proxy_and_forgets_idle_hosts(
    async_client, track_rate_clock, monkeypatch
):
    from backend.app.api.routes import aito as aito_routes, auth as auth_routes

    clock = track_rate_clock
    # The test client's TCP peer is the trusted proxy; the real visitor is
    # whoever X-Forwarded-For names, so two visitors get two buckets.
    monkeypatch.setattr(auth_routes, "_TRUSTED_PROXY_IPS", frozenset({"127.0.0.1", "testclient"}))
    await _exhaust_ip_misses(async_client, headers={"X-Forwarded-For": "203.0.113.5"})
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
async def test_public_route_collapsed_bucket_falls_back_to_the_global_miss_cap(
    async_client, db_session, track_rate_clock, monkeypatch
):
    """TRUSTED_PROXY_IPS unset but X-Forwarded-For present, with the T-029
    opt-in set: _get_client_ip cannot unwrap the header, so every one of
    these "visitors" collapses onto the same peer address. T-087: without
    the fallback the 31st miss would 429 on the (now site-wide) 30-miss
    per-IP cap; with it, only the much larger global cap governs, and a
    real code still resolves."""
    from backend.app.api.routes import aito as aito_routes, auth as auth_routes

    monkeypatch.setattr(auth_routes, "_TRUSTED_PROXY_IPS", frozenset())
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_COLLAPSED_PROXY", True)
    for i in range(aito_routes._TRACK_RATE_MAX_MISSES_PER_IP + 5):
        r = await async_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": f"203.0.113.{i}"})
        assert r.status_code == 404
    pid = await _create(async_client)
    token = await _token(async_client, db_session, pid)
    r = await async_client.get(TRACK + token, headers={"X-Forwarded-For": "203.0.113.99"})
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_public_route_direct_install_per_ip_miss_cap_is_unchanged(async_client, track_rate_clock, monkeypatch):
    """No X-Forwarded-For header at all (a direct, unproxied install):
    the collapsed-bucket fallback must not engage, and the 31st miss still
    429s exactly as before T-087."""
    from backend.app.api.routes import auth as auth_routes

    monkeypatch.setattr(auth_routes, "_TRUSTED_PROXY_IPS", frozenset())
    await _exhaust_ip_misses(async_client)
    r = await async_client.get("/api/v1/aito/track/ZZZZZZ")
    assert r.status_code == 429


@pytest.mark.asyncio
async def test_public_route_collapsed_bucket_no_longer_bounded_by_the_calls_cap(
    async_client, track_rate_clock, monkeypatch
):
    """T-017: on a collapsed bucket (opted-in unconfigured proxy, T-029)
    the per-IP CALLS cap used to stay in force even though T-087 already
    suspended the per-IP MISS cap there, so it silently became a 120/min
    site-wide ceiling — 5x tighter than the 600-miss per-net budget the
    collapse path is meant to rely on instead. It is now suspended
    alongside the miss cap: many more than the old (here lowered) calls
    cap succeed, and only the per-net miss budget still bounds the
    bucket."""
    from backend.app.api.routes import aito as aito_routes, auth as auth_routes

    monkeypatch.setattr(auth_routes, "_TRUSTED_PROXY_IPS", frozenset())
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_COLLAPSED_PROXY", True)
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_CALLS_PER_IP", 3)
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_MISSES_PER_NET", 5)
    # Five misses — already past the old 3-call cap — all still answered.
    for _ in range(5):
        r = await async_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": "203.0.113.5"})
        assert r.status_code == 404
    # The per-net miss budget, not the (suspended) calls cap, is what trips.
    r = await async_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": "203.0.113.6"})
    assert r.status_code == 429


@pytest.mark.asyncio
async def test_public_route_collapsed_bucket_never_429s_past_the_old_calls_cap_on_hits(
    async_client, db_session, track_rate_clock, monkeypatch
):
    """T-017: an opted-in unconfigured proxy (T-029: _TRACK_RATE_COLLAPSED_PROXY,
    collapsed bucket) making more than 120 real-code hits inside one window
    must never see a 429 — the per-IP CALLS cap is suspended there just
    like the per-IP miss cap already was, and a hit releases the per-net
    reservation it made at arrival (`_track_rate_hit`), so it never
    accumulates against that budget either."""
    from httpx import ASGITransport, AsyncClient

    from backend.app.api.routes import aito as aito_routes, auth as auth_routes
    from backend.app.main import app

    monkeypatch.setattr(auth_routes, "_TRUSTED_PROXY_IPS", frozenset())
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_COLLAPSED_PROXY", True)
    pid = await _create(async_client)
    token = await _token(async_client, db_session, pid)
    transport = ASGITransport(app=app, client=("10.0.0.5", 5555))
    async with AsyncClient(transport=transport, base_url="http://test") as private_client:
        for _ in range(aito_routes._TRACK_RATE_MAX_CALLS_PER_IP + 10):
            r = await private_client.get(TRACK + token, headers={"X-Forwarded-For": "203.0.113.5"})
            assert r.status_code == 200


# ── T-028: hits are not free on a collapsed bucket — a per-net CALLS ceiling ─


@pytest.mark.asyncio
async def test_public_route_collapsed_bucket_net_calls_cap_trips_on_hits(
    async_client, db_session, track_rate_clock, monkeypatch
):
    """T-028: on an opted-in collapsed bucket (T-029) the per-net MISS
    budget never grows from hits (a hit releases its miss reservation, per
    `_track_rate_hit`), but the per-net CALLS ceiling counts every
    admitted call — hit or miss — and is never released. Enough real-code
    lookups alone must eventually trip it, unlike before T-028 where hits
    there were entirely free."""
    from httpx import ASGITransport, AsyncClient

    from backend.app.api.routes import aito as aito_routes, auth as auth_routes
    from backend.app.main import app

    monkeypatch.setattr(auth_routes, "_TRUSTED_PROXY_IPS", frozenset())
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_COLLAPSED_PROXY", True)
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_CALLS_PER_NET", 5)
    pid = await _create(async_client)
    token = await _token(async_client, db_session, pid)
    transport = ASGITransport(app=app, client=("10.0.0.5", 5555))
    async with AsyncClient(transport=transport, base_url="http://test") as private_client:
        for _ in range(5):
            r = await private_client.get(TRACK + token, headers={"X-Forwarded-For": "203.0.113.5"})
            assert r.status_code == 200
        r = await private_client.get(TRACK + token, headers={"X-Forwarded-For": "203.0.113.5"})
        assert r.status_code == 429


@pytest.mark.asyncio
async def test_public_route_net_calls_cap_isolates_a_flood_of_hits_from_other_networks(
    async_client, db_session, track_rate_clock, monkeypatch
):
    """Non-collapsed case: several distinct IPs on one /24, each well under
    its own per-IP caps, still share the (here lowered) per-net CALLS
    ceiling — the next hit on that network 429s once it trips, while a
    visitor on an unrelated /24 keeps getting answered."""
    from backend.app.api.routes import aito as aito_routes, auth as auth_routes

    monkeypatch.setattr(auth_routes, "_TRUSTED_PROXY_IPS", frozenset({"127.0.0.1", "testclient"}))
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_CALLS_PER_NET", 5)
    pid = await _create(async_client)
    token = await _token(async_client, db_session, pid)
    # Five hits spread over five different addresses on 198.51.100.0/24 —
    # none anywhere near its own per-IP CALLS cap of 120.
    for i in range(5):
        r = await async_client.get(TRACK + token, headers={"X-Forwarded-For": f"198.51.100.{i}"})
        assert r.status_code == 200
    r = await async_client.get(TRACK + token, headers={"X-Forwarded-For": "198.51.100.250"})
    assert r.status_code == 429
    # A visitor on an unrelated /24 is untouched by that network's ceiling.
    r = await async_client.get(TRACK + token, headers={"X-Forwarded-For": "203.0.113.42"})
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_public_route_net_calls_cap_recovers_after_the_window(
    async_client, db_session, track_rate_clock, monkeypatch
):
    """The per-net CALLS ceiling is a sliding window like every other cap
    here: once every recorded call has aged out, the same network is served
    again."""
    from backend.app.api.routes import aito as aito_routes, auth as auth_routes

    clock = track_rate_clock
    monkeypatch.setattr(auth_routes, "_TRUSTED_PROXY_IPS", frozenset({"127.0.0.1", "testclient"}))
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_CALLS_PER_NET", 3)
    pid = await _create(async_client)
    token = await _token(async_client, db_session, pid)
    for i in range(3):
        r = await async_client.get(TRACK + token, headers={"X-Forwarded-For": f"198.51.100.{i}"})
        assert r.status_code == 200
    r = await async_client.get(TRACK + token, headers={"X-Forwarded-For": "198.51.100.9"})
    assert r.status_code == 429
    clock.now += aito_routes._TRACK_RATE_WINDOW_S + 1
    r = await async_client.get(TRACK + token, headers={"X-Forwarded-For": "198.51.100.9"})
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_public_route_collapsed_bucket_still_bounded_by_the_global_cap(
    async_client, track_rate_clock, monkeypatch
):
    """The per-IP miss cap is suspended on a collapsed bucket, but the
    global miss cap — the site-wide backstop — still trips."""
    from backend.app.api.routes import aito as aito_routes, auth as auth_routes

    monkeypatch.setattr(auth_routes, "_TRUSTED_PROXY_IPS", frozenset())
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_MISSES_PER_NET", 3)
    for i in range(3):
        r = await async_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": f"203.0.113.{i}"})
        assert r.status_code == 404
    r = await async_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": "203.0.113.9"})
    assert r.status_code == 429


# ── T-029: collapsing an unconfigured proxy needs an explicit opt-in,
# never inferred from the direct peer's address alone (Docker bridge
# networking makes that address private for every internet visitor too,
# so the old inference was spoofable by anyone able to set their own
# X-Forwarded-For). `_peer_is_private` is gone; these three replace the
# peer-based tests and its own parametrized table above. ──────────────────


@pytest.mark.asyncio
async def test_public_route_public_peer_with_xff_and_no_opt_in_is_not_collapsed(
    async_client, track_rate_clock, monkeypatch
):
    """Baseline: a public-internet peer's own X-Forwarded-For must not
    suspend the per-IP miss cap when the T-029 opt-in is unset (the
    default) — the 31st miss on that bucket still 429s."""
    from httpx import ASGITransport, AsyncClient

    from backend.app.api.routes import auth as auth_routes
    from backend.app.main import app

    monkeypatch.setattr(auth_routes, "_TRUSTED_PROXY_IPS", frozenset())
    # A real public IP (Python's ipaddress.is_private is True for several
    # documentation/reserved ranges such as 203.0.113.0/24 used elsewhere in
    # this file as a stand-in visitor address — 1.2.3.4 is not one of them).
    transport = ASGITransport(app=app, client=("1.2.3.4", 5555))
    async with AsyncClient(transport=transport, base_url="http://test") as public_client:
        await _exhaust_ip_misses(public_client, headers={"X-Forwarded-For": "203.0.113.5"})
        r = await public_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": "203.0.113.5"})
        assert r.status_code == 429


@pytest.mark.asyncio
async def test_public_route_private_peer_with_xff_and_no_opt_in_is_not_collapsed_either(
    async_client, track_rate_clock, monkeypatch
):
    """T-029 fix: a private/RFC-1918 direct peer (what every visitor looks
    like behind Docker's bridge networking) must NOT suspend the per-IP
    miss cap on its own either — only the explicit
    _TRACK_RATE_COLLAPSED_PROXY opt-in may. Before this fix such a peer
    alone collapsed the bucket, so any internet client behind a bridge
    network could add its own X-Forwarded-For and buy the higher budget
    for free; the 31st miss on that bucket still 429s now."""
    from httpx import ASGITransport, AsyncClient

    from backend.app.api.routes import auth as auth_routes
    from backend.app.main import app

    monkeypatch.setattr(auth_routes, "_TRUSTED_PROXY_IPS", frozenset())
    transport = ASGITransport(app=app, client=("10.0.0.5", 5555))
    async with AsyncClient(transport=transport, base_url="http://test") as private_client:
        await _exhaust_ip_misses(private_client, headers={"X-Forwarded-For": "203.0.113.5"})
        r = await private_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": "203.0.113.5"})
        assert r.status_code == 429


@pytest.mark.asyncio
async def test_public_route_collapsed_proxy_opt_in_collapses_regardless_of_peer(
    async_client, track_rate_clock, monkeypatch
):
    """With the T-029 opt-in set, the bucket collapses even behind a
    PUBLIC direct peer — it is the operator's explicit flag that decides
    now, not any property of the peer's address — and the per-IP miss cap
    is suspended: many more than that cap succeed, bounded by the
    (here lowered) per-net miss budget instead."""
    from httpx import ASGITransport, AsyncClient

    from backend.app.api.routes import aito as aito_routes, auth as auth_routes
    from backend.app.main import app

    monkeypatch.setattr(auth_routes, "_TRUSTED_PROXY_IPS", frozenset())
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_COLLAPSED_PROXY", True)
    transport = ASGITransport(app=app, client=("1.2.3.4", 5555))
    async with AsyncClient(transport=transport, base_url="http://test") as public_client:
        for i in range(aito_routes._TRACK_RATE_MAX_MISSES_PER_IP + 5):
            r = await public_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": f"203.0.113.{i}"})
            assert r.status_code == 404


@pytest.mark.asyncio
async def test_regenerate_rewrites_the_quote_notes_with_the_new_link(async_client, db_session, monkeypatch):
    from backend.app.services.zoho import zoho_service

    await _set_external_url(db_session, "https://aito.example")
    pid = await _create(async_client)
    old = await _token(async_client, db_session, pid)
    await _set(db_session, pid, quote_id="E1")
    remote = {
        "notes": f"Signature du client\n\nSuivi et paiement de votre projet : https://aito.example/t/{old}\nCode de suivi : {old}"
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
            f"Signature du client\n\nSuivi et paiement de votre projet : https://aito.example/t/{new}\nCode de suivi : {new}",
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
async def test_public_route_hits_never_count_against_the_caps(async_client, db_session, track_rate_clock, monkeypatch):
    """A guesser only ever produces misses and a real client only ever
    produces hits, so the caps count misses. Otherwise a promo SMS to a
    carrier-grade-NAT town, or one scanner at the global cap, locked every
    client out of their own page."""
    from backend.app.api.routes import aito as aito_routes

    clock = track_rate_clock
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_MISSES_PER_NET", 2)
    pid = await _create(async_client)
    token = await _token(async_client, db_session, pid)
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


def test_public_route_reserves_the_miss_at_arrival_and_releases_it_on_a_hit(track_rate_clock, monkeypatch):
    """The caps are enforced when a call ARRIVES, not after its lookup: with
    the miss counted afterwards, every request in flight at once passed the
    pre-check together, and a scanner spreading addresses could fire a whole
    window's worth of guesses concurrently. A hit releases what it reserved,
    so a client still pays nothing."""
    from types import SimpleNamespace

    from backend.app.api.routes import aito as aito_routes

    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_MISSES_PER_NET", 3)
    request = SimpleNamespace(client=SimpleNamespace(host="203.0.113.9"), headers={})
    # Three arrivals, none looked up yet: the fourth is already refused.
    stamps = [aito_routes._track_rate_limited(request) for _ in range(3)]
    assert all(stamps)
    assert aito_routes._track_rate_limited(request) is None
    # One of them turns out to be a hit and hands its slot back.
    aito_routes._track_rate_hit(*stamps[0])
    assert aito_routes._track_rate_limited(request) is not None
    assert aito_routes._track_rate_limited(request) is None


def test_release_miss_tolerates_a_key_with_nothing_reserved(track_rate_clock):
    """The guard `_release_miss` opens with, exercised directly: a key that
    was never reserved (or was already released) must be a no-op, not a
    dict-access error."""
    from backend.app.api.routes import aito as aito_routes

    aito_routes._release_miss({}, "never-reserved", 1.0)  # must not raise


def test_release_miss_tolerates_a_bucket_the_sweep_deleted_first(track_rate_clock, monkeypatch):
    """T-034: a release runs after this request's own lookup, so between
    its reservation and its release another arrival CAN sweep this host's
    whole bucket away first — once the window has lapsed and a dict has
    grown past `_TRACK_RATE_SWEEP_ABOVE`, `_track_rate_limited` drops every
    host whose stamps are all stale before it appends its own. Reproduce
    that ordering for real, via the sweep itself, not by clearing the dict
    by hand: reserve host A, then host B on a different /24 so both the
    per-IP and per-net miss dicts hold two keys each (past the patched
    threshold of 1), let the window lapse, then let a third arrival's own
    sweep delete A's (and B's) entries before A's request gets around to
    releasing what it reserved."""
    from types import SimpleNamespace

    from backend.app.api.routes import aito as aito_routes

    clock = track_rate_clock
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_SWEEP_ABOVE", 1)
    req_a = SimpleNamespace(client=SimpleNamespace(host="203.0.113.51"), headers={})
    req_b = SimpleNamespace(client=SimpleNamespace(host="198.51.100.9"), headers={})
    admitted_a = aito_routes._track_rate_limited(req_a)
    admitted_b = aito_routes._track_rate_limited(req_b)
    assert admitted_a is not None and admitted_b is not None
    host_a, stamp_a = admitted_a
    # Two hosts on two distinct /24s: both the per-IP and the per-net miss
    # dicts now hold 2 keys each, past the (patched) sweep threshold of 1.
    assert len(aito_routes._track_rate_ip_misses) == 2
    assert len(aito_routes._track_rate_net_misses) == 2

    clock.now += aito_routes._TRACK_RATE_WINDOW_S + 1
    req_c = SimpleNamespace(client=SimpleNamespace(host="8.8.8.8"), headers={})
    assert aito_routes._track_rate_limited(req_c) is not None  # its own sweep runs first
    # A's (and B's) reservations are gone, swept as stale before C's own
    # fresh stamp was ever recorded.
    assert host_a not in aito_routes._track_rate_ip_misses
    assert "203.0.113.0/24" not in aito_routes._track_rate_net_misses

    # A's request now finishes and releases what it reserved. Without the
    # `if bucket is None: return` guard this raises — a KeyError off `del`,
    # or an AttributeError off a None bucket.
    aito_routes._track_rate_hit(host_a, stamp_a)

    # And the limiter is left usable, not corrupted, for the next arrival.
    assert aito_routes._track_rate_limited(req_a) is not None


# ── T-012: a no-peer host must fail closed to a real, cappable bucket ────────


def test_no_peer_requests_share_one_bucket_and_trip_the_net_miss_cap(track_rate_clock, monkeypatch):
    """`_get_client_ip` mints a fresh, per-request-unique `__no_ip_...`
    placeholder when `request.client` is None (a unix-socket bind has no
    peer). Left uncollapsed, every such request would land in its own
    empty, uncapped bucket and no cap could ever be reached. Two requests
    with no peer at all must share one bucket instead, so a cap can trip —
    T-030: the shared `__no_ip__` bucket is itself collapsed, so the
    per-IP miss cap is suspended for it and it is the per-net miss budget
    that trips instead (otherwise the one shared bucket would silently be
    the whole install's 30-miss cap, not just this one visitor's)."""
    from types import SimpleNamespace

    from backend.app.api.routes import aito as aito_routes

    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_MISSES_PER_NET", 3)
    # A fresh request each time (as a real connection would be), but every
    # one of them has no TCP peer.
    request = SimpleNamespace(client=None, headers={})
    stamps = [aito_routes._track_rate_limited(request) for _ in range(3)]
    assert all(stamps)
    # All three collapsed onto the same shared key, not one each.
    assert {host for host, _ in stamps} == {"__no_ip__"}
    assert aito_routes._track_rate_limited(request) is None


def test_unparseable_host_collapses_onto_the_same_shared_bucket(track_rate_clock, monkeypatch):
    """A host string that isn't a real peer address either — e.g. a test
    client's literal "testclient" — collapses onto the same `"__no_ip__"`
    sentinel as a genuinely missing peer, so the two share one budget
    rather than each getting fail-closed to its own unbounded bucket.
    T-030: that shared bucket is itself collapsed, so it is the per-net
    miss budget that fills, not the per-IP one."""
    from types import SimpleNamespace

    from backend.app.api.routes import aito as aito_routes

    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_MISSES_PER_NET", 2)
    no_peer_request = SimpleNamespace(client=None, headers={})
    named_request = SimpleNamespace(client=SimpleNamespace(host="testclient"), headers={})
    admitted1 = aito_routes._track_rate_limited(no_peer_request)
    admitted2 = aito_routes._track_rate_limited(named_request)
    assert admitted1 is not None and admitted2 is not None
    assert admitted1[0] == admitted2[0] == "__no_ip__"
    # The shared bucket is now full for either kind of request.
    assert aito_routes._track_rate_limited(no_peer_request) is None
    assert aito_routes._track_rate_limited(named_request) is None


@pytest.mark.asyncio
async def test_public_route_global_cap_holds_under_concurrent_misses(async_client, monkeypatch):
    import asyncio

    from backend.app.api.routes import aito as aito_routes

    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_MISSES_PER_NET", 3)
    aito_routes._reset_track_rate_limits()
    codes = [await async_client.get(TRACK + "ZZZZZZ") for _ in range(0)]  # warm nothing
    results = await asyncio.gather(*(async_client.get(TRACK + "ZZZZZZ") for _ in range(12)))
    codes = sorted(r.status_code for r in results)
    assert codes.count(404) == 3 and codes.count(429) == 9
    aito_routes._reset_track_rate_limits()


@pytest.mark.asyncio
async def test_public_route_backstops_a_single_address_whatever_it_sends(
    async_client, db_session, track_rate_clock, monkeypatch
):
    """Hits are uncapped by the miss windows, not free: one address looping
    on a valid code still meets a generous per-address ceiling."""
    from backend.app.api.routes import aito as aito_routes

    clock = track_rate_clock
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_CALLS_PER_IP", 4)
    pid = await _create(async_client)
    token = await _token(async_client, db_session, pid)
    for _ in range(4):
        assert (await async_client.get(TRACK + token)).status_code == 200
    r = await async_client.get(TRACK + token)
    assert r.status_code == 429 and r.headers["retry-after"] == "60"
    clock.now += aito_routes._TRACK_RATE_WINDOW_S + 1
    assert (await async_client.get(TRACK + token)).status_code == 200


# ── T-122: the miss budget is per source network, not one global bucket ──────


@pytest.mark.asyncio
async def test_public_route_net_cap_isolates_a_flood_from_other_networks(async_client, track_rate_clock, monkeypatch):
    """A flood from one /24 must trip only that network's budget: a visitor
    on an unrelated /24 keeps getting answered while the flood is ongoing —
    the whole point of T-122 (previously ALL clients 429'd together)."""
    from backend.app.api.routes import aito as aito_routes, auth as auth_routes

    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_MISSES_PER_NET", 3)
    monkeypatch.setattr(auth_routes, "_TRUSTED_PROXY_IPS", frozenset({"127.0.0.1", "testclient"}))
    # Three misses from 198.51.100.7 fill its /24's budget.
    for _ in range(3):
        r = await async_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": "198.51.100.7"})
        assert r.status_code == 404
    # A different host on the SAME /24 (198.51.100.0/24) inherits the tripped
    # budget: no single IP address needs to be the one flooding.
    r = await async_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": "198.51.100.8"})
    assert r.status_code == 429
    # A visitor on an unrelated network still gets its normal answer.
    r = await async_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": "8.8.8.8"})
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_public_route_hit_releases_the_net_reservation(async_client, db_session, track_rate_clock, monkeypatch):
    """A real code fetched repeatedly must never trip the net cap: each hit
    hands its reservation back to the SAME network bucket it was taken
    from, exactly like the per-IP miss bucket already does."""
    from backend.app.api.routes import aito as aito_routes

    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_MISSES_PER_NET", 3)
    pid = await _create(async_client)
    token = await _token(async_client, db_session, pid)
    for _ in range(10):
        assert (await async_client.get(TRACK + token)).status_code == 200


@pytest.mark.asyncio
async def test_public_route_net_cap_ipv6_shares_a_slash_48(async_client, track_rate_clock, monkeypatch):
    """IPv6 addresses in the same /48 share a budget — even across different
    /64s of that /48, since a /64 is not a whole routed allocation the way a
    /24 is for IPv4 — and a different /48 does not, mirroring the IPv4 /24
    behaviour above."""
    from backend.app.api.routes import aito as aito_routes, auth as auth_routes

    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_MISSES_PER_NET", 3)
    monkeypatch.setattr(auth_routes, "_TRUSTED_PROXY_IPS", frozenset({"127.0.0.1", "testclient"}))
    for _ in range(3):
        r = await async_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": "2001:4860:4860::8888"})
        assert r.status_code == 404
    # Same /48 (2001:4860:4860::/48), same /64, different address: inherits the cap.
    r = await async_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": "2001:4860:4860::8844"})
    assert r.status_code == 429
    # Same /48, a different /64 of it (2001:4860:4860:1::/64): still inherits the cap.
    r = await async_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": "2001:4860:4860:1::9999"})
    assert r.status_code == 429
    # A different /48 is unaffected.
    r = await async_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": "2606:4700:4700::1111"})
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_public_route_net_cap_scaled_flood_no_longer_reaches_other_networks(
    async_client, track_rate_clock, monkeypatch
):
    """A scaled-down version of the original T-122 flood scenario: 600
    misses (the real cap, monkeypatched down here) from one /24 must not
    429 a visitor on a different /24."""
    from backend.app.api.routes import aito as aito_routes, auth as auth_routes

    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_MISSES_PER_NET", 20)
    monkeypatch.setattr(aito_routes, "_TRACK_RATE_MAX_MISSES_PER_IP", 20)
    monkeypatch.setattr(auth_routes, "_TRUSTED_PROXY_IPS", frozenset({"127.0.0.1", "testclient"}))
    for i in range(20):
        r = await async_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": f"198.51.100.{i}"})
        assert r.status_code == 404
    r = await async_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": "198.51.100.250"})
    assert r.status_code == 429
    # An address outside 198.51.100.0/24 was never touched by the flood.
    r = await async_client.get("/api/v1/aito/track/ZZZZZZ", headers={"X-Forwarded-For": "203.0.113.42"})
    assert r.status_code == 404


@pytest.mark.parametrize(
    ("host", "expected"),
    [
        ("203.0.113.5", "203.0.113.0/24"),
        ("203.0.113.250", "203.0.113.0/24"),
        ("2001:4860:4860::8888", "2001:4860:4860::/48"),
        ("2001:4860:4860::8844", "2001:4860:4860::/48"),
        ("2001:4860:4860:1::9999", "2001:4860:4860::/48"),  # different /64, same /48
        ("2606:4700:4700::1111", "2606:4700:4700::/48"),
        ("testclient", "testclient"),  # unparseable — fail closed to its own bucket
        ("__no_ip_deadbeef__", "__no_ip_deadbeef__"),  # no-peer placeholder — same
    ],
)
def test_track_rate_net_key(host, expected):
    from backend.app.api.routes import aito as aito_routes

    assert aito_routes._track_rate_net_key(host) == expected


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
