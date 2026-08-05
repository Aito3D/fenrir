"""Route -> sync worker -> wire, end to end over one MockTransport.

The two halves the rest of the suite tests separately — the HTTP API writing
rows and the worker translating rows into Books calls — joined up: a project
created through ``POST /api/v1/aito/`` must produce the exact ``line_items``
JSON Books receives, and a hostile wire (429s, outages, malformed 200s) must
degrade into the documented per-project states, never a crash or a half-write.

Mocking follows the house rules: ``zoho_service.transport`` for anything that
asserts wire shape, class-level monkeypatching never — patch the INSTANCE if
you must patch at all (see the instance-shadow warning in
test_aito_quote_email.py) — and the three autouse reset fixtures below mirror
test_aito_quote_sync.py exactly.
"""

import json
from datetime import datetime, timezone

import httpx
import pytest
from sqlalchemy import select

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_event import AitoEvent
from backend.app.models.aito_project import AitoProject
from backend.app.services.aito_quote_sync import SYNC_FAILURE_LIMIT, _deferred_reasons, run_sync_once
from backend.app.services.zoho import zoho_service


@pytest.fixture(autouse=True)
def reset_zoho_service():
    zoho_service.invalidate_token()
    zoho_service.transport = None
    yield
    zoho_service.invalidate_token()
    zoho_service.transport = None


@pytest.fixture(autouse=True)
def fresh_wake_event():
    import asyncio

    from backend.app.services import aito_quote_sync

    aito_quote_sync._wake = asyncio.Event()
    aito_quote_sync._debounce_deadline = None
    yield
    aito_quote_sync._debounce_deadline = None


@pytest.fixture(autouse=True)
def reset_deferred_reasons():
    _deferred_reasons.clear()
    yield
    _deferred_reasons.clear()


async def _configure_zoho(db) -> None:
    for key, value in {
        "zoho_client_id": "1000.FAKE",
        "zoho_client_secret": "fake-secret",
        "zoho_refresh_token": "1000.fake.refresh",
        "zoho_organization_id": "999",
    }.items():
        await set_setting(db, key, value)
    await db.commit()


def zoho_handler(routes: dict[tuple[str, str], dict], seen: list | None = None):
    """(METHOD, path-suffix) -> JSON body; token auto-answered; anything
    unrouted 404s loudly (mirrors test_aito_quote_sync.py)."""

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        if seen is not None:
            seen.append((request.method, request.url.path, json.loads(request.content) if request.content else None))
        for (method, suffix), body in routes.items():
            if request.method == method and request.url.path.endswith(suffix):
                return httpx.Response(200, json=body)
        return httpx.Response(404, json={"message": "no route"})

    return handler


async def _seed_shipping_cache(db) -> None:
    """A warm, fresh shipping catalogue so route-side refresh=True calls are
    answered from cache and the sync worker owns the shipping item id."""
    await set_setting(db, "zoho_shipping_catalogue", json.dumps({"tuamotu": {"item_id": "SHIP-T", "rate": 3200}}))
    await set_setting(db, "zoho_shipping_catalogue_at", datetime.now(timezone.utc).replace(tzinfo=None).isoformat())
    await db.commit()


_ESTIMATE_CREATED = {
    "estimate": {
        "estimate_id": "E1",
        "estimate_number": "DEV26-9100",
        "date": "2026-08-05",
        "status": "draft",
        "total": 27500,
        "last_modified_time": "2026-08-05T10:00:00-1000",
        "is_inclusive_tax": True,
    }
}


async def _events_of_kind(db, project_id: int, kind: str) -> list[AitoEvent]:
    rows = await db.execute(select(AitoEvent).where(AitoEvent.project_id == project_id, AitoEvent.kind == kind))
    return list(rows.scalars().all())


# ---------------------------------------------------------------------------
# Quote generation: the exact wire body a project built through the API produces
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_project_created_through_the_api_produces_the_exact_wire_line_items(async_client, db_session):
    response = await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "Hélice bâbord",
            "client_id": "C1",
            "client_name": "Moana TEMARII",
            "client_phone": "+689 87 11 22 33",
            "tasks": [
                {
                    "title": "Hélice bâbord",
                    "scan_cost": 3500,
                    "scan_description": "Numérisation de la pièce.",
                    "modelisation_cost": 8000,
                    "usinage_cost": 4000,
                    "usinage_description": "Reprise du moyeu.",
                    "impression_cost": 12000,
                    "impression_quantity": 3,
                    "impression_weight_g": 210,
                    "impression_time_min": 780,
                    "impression_color": "Noir",
                    "impression_discount_pct": 10,
                }
            ],
        },
    )
    assert response.status_code == 201, response.text
    project_id = response.json()["id"]
    assert response.json()["quote_sync_state"] == "pending"

    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {("GET", "/estimates"): {"estimates": []}, ("POST", "/estimates"): _ESTIMATE_CREATED},
            seen,
        )
    )
    assert await run_sync_once(db_session) == 1

    post = next(entry for entry in seen if entry[0] == "POST")
    body = post[2]
    assert body["customer_id"] == "C1"
    assert body["reference_number"] == f"AITO-{project_id}"
    assert body["is_inclusive_tax"] is True
    # The full array, not a sample: canonical service order, header on every
    # task line, default catalogue ids, the impression rate/qty/discount split.
    assert body["line_items"] == [
        {
            "item_id": "66407000006501192",
            "tax_id": "66407000009281008",
            "unit": "Projet",
            "rate": 3500,
            "quantity": 1,
            "description": "Info: Numérisation de la pièce.\n*Fichier non cédé*",
            "header_name": "Hélice bâbord",
            "item_order": 1,
        },
        {
            "item_id": "66407000006485001",
            "tax_id": "66407000009281008",
            "unit": "Projet",
            "rate": 8000,
            "quantity": 1,
            "description": "*Fichier non cédé*",
            "header_name": "Hélice bâbord",
            "item_order": 2,
        },
        {
            "item_id": "66407000006485012",
            "tax_id": "66407000009281008",
            "unit": "Projet",
            "rate": 4000,
            "quantity": 3,
            "description": "Poids: 210 gr\nTemps: 13h\nCouleur: Noir",
            "header_name": "Hélice bâbord",
            "discount": "10%",
            "item_order": 3,
        },
        {
            "item_id": "66407000006884825",
            "tax_id": "66407000009281008",
            "unit": "Projet",
            "rate": 4000,
            "quantity": 1,
            "description": "Info: Reprise du moyeu.",
            "header_name": "Hélice bâbord",
            "item_order": 4,
        },
    ]

    project = await db_session.get(AitoProject, project_id)
    await db_session.refresh(project)
    assert project.quote_id == "E1"
    assert project.quote_sync_state == "idle"


@pytest.mark.asyncio
async def test_shipping_attached_through_the_api_reaches_the_wire_then_a_detach_deletes_it(async_client, db_session):
    """The full shipping lifecycle over the wire: attach at create time (price
    defaulted from the cached rate), the line lands after the tasks with no
    header; detach via PATCH island=null, and the next push omits both the
    fresh line AND the echo — which is what deletes it in Books."""
    await _seed_shipping_cache(db_session)
    response = await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "Livraison Rangiroa",
            "client_id": "C1",
            "client_name": "Moana TEMARII",
            "client_phone": "+689 87 11 22 33",
            "shipping_island": "rangiroa",
            "shipping_first_name": "Moana",
            "shipping_last_name": "TEMARII",
            "shipping_phone": "+689-87112233",
            "tasks": [{"title": "Support", "impression_cost": 6000}],
        },
    )
    assert response.status_code == 201, response.text
    project_id = response.json()["id"]
    assert response.json()["shipping_service"] == "tuamotu"
    assert response.json()["shipping_price"] == 3200

    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {("GET", "/estimates"): {"estimates": []}, ("POST", "/estimates"): _ESTIMATE_CREATED},
            seen,
        )
    )
    assert await run_sync_once(db_session) == 1
    body = next(entry for entry in seen if entry[0] == "POST")[2]
    shipping_line = body["line_items"][-1]
    assert shipping_line == {
        "item_id": "SHIP-T",
        "tax_id": "66407000009281008",
        "unit": "Projet",
        "rate": 3200,
        "quantity": 1,
        "description": "Nom: Moana TEMARII\nTéléphone: +689-87112233\nÎle: Rangiroa",
        "item_order": 2,
    }
    assert "header_name" not in shipping_line

    # --- Detach ---
    response = await async_client.patch(f"/api/v1/aito/{project_id}", json={"shipping_island": None})
    assert response.status_code == 200, response.text
    assert response.json()["shipping_service"] is None
    assert response.json()["quote_sync_state"] == "pending"

    remote_lines = [
        {
            "line_item_id": "L1",
            "item_id": "66407000006485012",
            "sku": "P3DIMP",
            "item_order": 1,
            "rate": 6000,
            "quantity": 1,
            "description": "",
        },
        {
            "line_item_id": "L2",
            "item_id": "SHIP-T",
            "item_order": 2,
            "rate": 3200,
            "quantity": 1,
            "description": "Nom: Moana TEMARII\nTéléphone: +689-87112233\nÎle: Rangiroa",
        },
    ]
    seen_update: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {**_ESTIMATE_CREATED["estimate"], "line_items": remote_lines, "status": "draft"}
                },
                ("PUT", "/estimates/E1"): _ESTIMATE_CREATED,
            },
            seen_update,
        )
    )
    assert await run_sync_once(db_session) == 1
    put = next(entry for entry in seen_update if entry[0] == "PUT")
    pushed = put[2]["line_items"]
    assert all(line.get("item_id") != "SHIP-T" for line in pushed)
    assert all(line.get("line_item_id") != "L2" for line in pushed)  # not echoed either -> deleted in Books


# ---------------------------------------------------------------------------
# Quote status: the actual wire shape of the sent-first hop
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_accepting_a_sent_quote_posts_exactly_one_status_change(async_client, db_session):
    response = await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "Import",
            "client_id": "C1",
            "client_name": "Moana TEMARII",
            "client_phone": "+689 87 11 22 33",
            "quote_id": "E9",
            "quote_status": "sent",
        },
    )
    assert response.status_code == 201, response.text
    project_id = response.json()["id"]

    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E9"): {"estimate": {"estimate_id": "E9", "status": "sent"}},
                ("POST", "/status/accepted"): {},
            },
            seen,
        )
    )
    response = await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "accepted"})
    assert response.status_code == 200
    assert response.json()["zoho_synced"] is True
    posts = [path for method, path, _ in seen if method == "POST"]
    assert posts == ["/books/v3/estimates/E9/status/accepted"]  # no sent-hop: it already left draft


@pytest.mark.asyncio
async def test_accepting_a_draft_quote_marks_it_sent_first_on_the_wire(async_client, db_session):
    response = await async_client.post(
        "/api/v1/aito/",
        json={
            "description": "Import",
            "client_id": "C1",
            "client_name": "Moana TEMARII",
            "client_phone": "+689 87 11 22 33",
            "quote_id": "E9",
            "quote_status": "draft",
        },
    )
    project_id = response.json()["id"]

    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E9"): {"estimate": {"estimate_id": "E9", "status": "draft"}},
                ("POST", "/status/sent"): {},
                ("POST", "/status/accepted"): {},
            },
            seen,
        )
    )
    response = await async_client.post(f"/api/v1/aito/{project_id}/quote-status", json={"status": "accepted"})
    assert response.json()["zoho_synced"] is True
    posts = [path for method, path, _ in seen if method == "POST"]
    assert posts == [
        "/books/v3/estimates/E9/status/sent",
        "/books/v3/estimates/E9/status/accepted",
    ]


# ---------------------------------------------------------------------------
# The wire misbehaving: 429s, outages, malformed 200s
# ---------------------------------------------------------------------------


def _swept_project(**overrides) -> AitoProject:
    fields = {
        "description": "Swept",
        "board_column": "waiting",
        "position": 0,
        "status": "active",
        "client_id": "C1",
        "client_name": "Client",
        "quote_id": "E5",
        "quote_status": "sent",
        "quote_sync_state": "idle",
    }
    fields.update(overrides)
    return AitoProject(**fields)


@pytest.mark.asyncio
async def test_429s_escalate_after_the_limit_and_one_healthy_read_recovers(db_session):
    """Pinned end to end: every rate-limited tick spends one unit of the
    failure budget (a 429 is indistinguishable from an outage today), the
    escalation to 'error' emits exactly ONE sync.failed event however long the
    outage lasts, and a single healthy read walks the project back to idle."""
    project = _swept_project()
    db_session.add(project)
    await db_session.commit()
    await _configure_zoho(db_session)

    def rate_limited(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(429, json={"message": "Rate limited"})

    zoho_service.transport = httpx.MockTransport(rate_limited)

    for tick in range(1, SYNC_FAILURE_LIMIT):
        assert await run_sync_once(db_session) == 1
        await db_session.refresh(project)
        assert project.quote_sync_failures == tick
        assert project.quote_sync_state == "idle"  # still retrying quietly
        assert project.quote_sync_error == "Zoho Books error (HTTP 429)"

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    assert project.quote_sync_failures == SYNC_FAILURE_LIMIT
    assert len(await _events_of_kind(db_session, project.id, "sync.failed")) == 1

    # Still down: stays in error, no second event row.
    assert await run_sync_once(db_session) == 1
    assert len(await _events_of_kind(db_session, project.id, "sync.failed")) == 1

    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates/E5"): {"estimate": {"estimate_id": "E5", "status": "sent", "total": 100}}})
    )
    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "idle"
    assert project.quote_sync_error is None
    assert project.quote_sync_failures == 0


@pytest.mark.asyncio
async def test_a_network_outage_during_the_sweep_counts_one_failure_and_names_the_exception(db_session):
    project = _swept_project()
    db_session.add(project)
    await db_session.commit()
    await _configure_zoho(db_session)

    def down(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        raise httpx.ConnectError("no route")

    zoho_service.transport = httpx.MockTransport(down)
    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "idle"
    assert project.quote_sync_failures == 1
    assert project.quote_sync_error == "Zoho Books unreachable: ConnectError"


@pytest.mark.asyncio
async def test_create_response_without_an_estimate_id_stays_pending_and_retries(db_session):
    """A 200 whose body omits (or nulls) the estimate — the push cannot be
    confirmed, so the project must NOT go idle (an orphan may exist in Books);
    it stays pending with one failure on the meter."""
    project = AitoProject(
        description="Pending",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_sync_state="pending",
    )
    db_session.add(project)
    await db_session.flush()
    from backend.app.models.aito_task import AitoTask

    db_session.add(AitoTask(project_id=project.id, position=0, title="Piece", scan_cost=1000))
    await db_session.commit()
    await _configure_zoho(db_session)

    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates"): {"estimates": []}, ("POST", "/estimates"): {"code": 0}})
    )
    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "pending"
    assert project.quote_id is None
    assert project.quote_sync_failures == 1
    assert project.quote_sync_error == "Zoho returned no estimate_id; the push cannot be confirmed"


@pytest.mark.asyncio
async def test_update_response_without_an_estimate_id_stays_pending_and_retries(db_session):
    """The update-path twin of the create test above: a PUT answered 200 with
    no ``estimate`` key cannot confirm the push, so the project must stay
    pending with one failure on the meter — and the identity Books already
    gave it must survive untouched (no half-write)."""
    project = _swept_project(quote_sync_state="pending", quote_status="draft", quote_number="DEV26-9100")
    db_session.add(project)
    await db_session.flush()
    from backend.app.models.aito_task import AitoTask

    db_session.add(AitoTask(project_id=project.id, position=0, title="Piece", scan_cost=1000))
    await db_session.commit()
    await _configure_zoho(db_session)

    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E5"): {
                    "estimate": {
                        "estimate_id": "E5",
                        "status": "draft",
                        "is_inclusive_tax": True,
                        "line_items": [],
                    }
                },
                ("PUT", "/estimates/E5"): {"code": 0},
            }
        )
    )
    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "pending"
    assert project.quote_sync_failures == 1
    assert project.quote_sync_error == "Zoho returned no estimate_id; the push cannot be confirmed"
    assert project.quote_id == "E5"
    assert project.quote_number == "DEV26-9100"


@pytest.mark.asyncio
async def test_a_null_estimate_body_on_the_sweep_is_a_terminal_error_not_a_crash(db_session):
    """``{"estimate": null}`` reaches the worker as None; the catch-all owns
    it: terminal error, failure counter 0 (so the recovery branch can never
    mistake it for the outage escalation), one sync.failed event."""
    project = _swept_project(quote_id="E7")
    db_session.add(project)
    await db_session.commit()
    await _configure_zoho(db_session)

    zoho_service.transport = httpx.MockTransport(zoho_handler({("GET", "/estimates/E7"): {"estimate": None}}))
    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    assert project.quote_sync_failures == 0
    assert project.quote_sync_error  # the stringified AttributeError, shape unpinned
    assert len(await _events_of_kind(db_session, project.id, "sync.failed")) == 1
