"""The Aito -> Zoho outbox worker, driven through zoho_service's MockTransport
seam. No network, no real Books org."""

import json

import httpx
import pytest
from sqlalchemy import select

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.services.aito_quote_sync import SYNC_FAILURE_LIMIT, run_sync_once
from backend.app.services.zoho import zoho_service


@pytest.fixture(autouse=True)
def reset_zoho_service():
    """Undo the MockTransport + cached token each test installs on the module
    singleton, so no state leaks into unrelated tests (mirrors the reset
    fixture in test_zoho_service.py)."""
    zoho_service.invalidate_token()
    zoho_service.transport = None
    yield
    zoho_service.invalidate_token()
    zoho_service.transport = None


async def _configure_zoho(db) -> None:
    """Seed the settings the sync worker needs to consider Zoho configured.

    Mirrors ``_configure`` in test_zoho_service.py, but writes straight to the
    settings table via ``db_session`` rather than through the HTTP API, since
    this module has no ``async_client`` dependency to spare.
    """
    for key, value in {
        "zoho_client_id": "1000.FAKE",
        "zoho_client_secret": "fake-secret",
        "zoho_refresh_token": "1000.fake.refresh",
        "zoho_organization_id": "999",
    }.items():
        await set_setting(db, key, value)
    await db.commit()


def zoho_handler(routes: dict[tuple[str, str], dict], seen: list | None = None):
    """Map (METHOD, path-suffix) -> JSON body. Token requests are auto-answered."""

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


@pytest.mark.asyncio
async def test_pending_project_without_a_quote_gets_one_created(db_session):
    project = AitoProject(
        description="Helice",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client de passage",
        quote_sync_state="pending",
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Helice grise", scan_cost=5000))
    await db_session.commit()
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates"): {"estimates": []},
                ("POST", "/estimates"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "estimate_number": "DEV26-9001",
                        "date": "2026-07-29",
                        "status": "draft",
                        "total": 5000,
                        "last_modified_time": "2026-07-29T10:00:00-1000",
                        "is_inclusive_tax": True,
                    }
                },
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_id == "E1"
    assert project.quote_number == "DEV26-9001"
    assert project.quote_status == "draft"
    assert project.quote_synced_at == "2026-07-29T10:00:00-1000"
    assert project.quote_sync_state == "idle"
    assert project.quote_url.startswith("https://books.")

    post = next(entry for entry in seen if entry[0] == "POST")
    assert post[2]["customer_id"] == "C1"
    assert post[2]["reference_number"] == f"AITO-{project.id}"
    assert post[2]["is_inclusive_tax"] is True
    assert len(post[2]["line_items"]) == 1


@pytest.mark.asyncio
async def test_idle_project_is_never_touched(db_session):
    """An old quote-less card. The migration default excludes it from sync."""
    db_session.add(AitoProject(description="Vieux", board_column="devis", position=0, quote_sync_state="idle"))
    await db_session.commit()
    zoho_service.transport = httpx.MockTransport(zoho_handler({}))
    assert await run_sync_once(db_session) == 0


@pytest.mark.asyncio
async def test_unexpected_bug_in_one_project_does_not_abort_the_next(db_session, monkeypatch):
    """The catch-all in ``sync_project`` isolates one project's unexpected bug
    from its neighbours: a plain, non-Zoho exception (here a ``TypeError``
    from ``build_line_items``) is caught and recorded on that project alone,
    and ``run_sync_once`` still processes the rest of the batch.

    This does NOT exercise per-project commit placement — the exception is
    caught inside ``sync_project``'s own try block, so it never reaches
    ``run_sync_once``'s loop at all. See
    ``test_commit_failure_for_one_project_does_not_roll_back_a_good_ones_write``
    for that guarantee.
    """
    good = AitoProject(
        description="Bonne piece",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client OK",
        quote_sync_state="pending",
    )
    bad = AitoProject(
        description="Piece cassee",
        board_column="devis",
        position=1,
        client_id="C2",
        client_name="Client KO",
        quote_sync_state="pending",
    )
    db_session.add_all([good, bad])
    await db_session.flush()
    db_session.add(AitoTask(project_id=good.id, position=0, title="Good", scan_cost=5000))
    db_session.add(AitoTask(project_id=bad.id, position=0, title="Bad", scan_cost=5000))
    await db_session.commit()
    await _configure_zoho(db_session)

    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates"): {"estimates": []},
                ("POST", "/estimates"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "estimate_number": "DEV26-9001",
                        "date": "2026-07-29",
                        "status": "draft",
                        "total": 5000,
                        "last_modified_time": "2026-07-29T10:00:00-1000",
                        "is_inclusive_tax": True,
                    }
                },
            }
        )
    )
    zoho_service.invalidate_token()

    # Simulate an unexpected, non-Zoho bug (a plain TypeError) in the export
    # step, but only for the "bad" project's task, so "good" still syncs
    # cleanly through the real code path first.
    from backend.app.services import aito_quote_sync

    original_build_line_items = aito_quote_sync.build_line_items

    def flaky_build_line_items(tasks, existing_line_items, catalogue):
        if any(t.title == "Bad" for t in tasks):
            raise TypeError("simulated bug in export")
        return original_build_line_items(tasks, existing_line_items, catalogue)

    monkeypatch.setattr(aito_quote_sync, "build_line_items", flaky_build_line_items)

    assert await run_sync_once(db_session) == 2

    await db_session.refresh(good)
    await db_session.refresh(bad)
    assert good.quote_id == "E1"
    assert good.quote_sync_state == "idle"
    assert bad.quote_sync_state == "error"
    assert bad.quote_id is None
    assert "simulated bug" in (bad.quote_sync_error or "")


@pytest.mark.asyncio
async def test_commit_failure_for_one_project_does_not_roll_back_a_good_ones_write(db_session, monkeypatch):
    """Regression guard for the duplicate-quote bug: committing per project
    means an unexpected failure that escapes ``sync_project`` entirely — a
    failure in ``db.commit()`` itself, not one ``sync_project``'s catch-all
    can intercept — must not discard an earlier project's already-successful,
    already-committed write.

    Unlike a bug in ``build_line_items``, a broken commit is NOT caught by
    ``sync_project``'s try/except (commit happens in ``run_sync_once``, after
    ``sync_project`` returns), so this is the only scenario that actually
    exercises per-project vs. batch commit placement. To prove that, this
    test is written to fail if ``run_sync_once`` is reverted to a single
    ``if projects: await db.commit()`` after the loop: under a batch commit,
    the second project's failure would take the first project's write down
    with it, because both are still sitting in one uncommitted transaction
    when the failure hits.
    """
    good = AitoProject(
        description="Bonne piece",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client OK",
        quote_sync_state="pending",
    )
    bad = AitoProject(
        description="Piece cassee",
        board_column="devis",
        position=1,
        client_id="C2",
        client_name="Client KO",
        quote_sync_state="pending",
    )
    db_session.add_all([good, bad])
    await db_session.flush()
    db_session.add(AitoTask(project_id=good.id, position=0, title="Good", scan_cost=5000))
    db_session.add(AitoTask(project_id=bad.id, position=0, title="Bad", scan_cost=5000))
    await db_session.commit()
    await _configure_zoho(db_session)

    # Both projects sync cleanly through the real code path — no injected bug
    # in the export step this time. What fails is the second project's
    # commit itself.
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates"): {"estimates": []},
                ("POST", "/estimates"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "estimate_number": "DEV26-9001",
                        "date": "2026-07-29",
                        "status": "draft",
                        "total": 5000,
                        "last_modified_time": "2026-07-29T10:00:00-1000",
                        "is_inclusive_tax": True,
                    }
                },
            }
        )
    )
    zoho_service.invalidate_token()

    # Fail commit once "bad" has been synced (its in-memory quote_id is set by
    # sync_project, no DB round-trip needed to see that). Under per-project
    # commits this is specifically the second commit call: "good"'s own
    # commit already landed before "bad" was even touched. Under a reverted
    # batch commit there is only one call, and by the time it runs both
    # projects' in-memory state already includes "bad"'s quote_id — so this
    # same condition fails that single call too, taking "good" down with it.
    original_commit = db_session.commit

    async def flaky_commit():
        if bad.quote_id is not None:
            raise RuntimeError("simulated commit failure")
        await original_commit()

    monkeypatch.setattr(db_session, "commit", flaky_commit)

    assert await run_sync_once(db_session) == 2

    await db_session.refresh(good)
    await db_session.refresh(bad)
    # Under per-project commits, good's write already landed before bad's
    # commit ever failed — it survives untouched.
    assert good.quote_id == "E1"
    assert good.quote_sync_state == "idle"
    # bad's commit failed, so run_sync_once's own guard rolled it back: its
    # in-memory "idle"/quote_id update was discarded, and its row is exactly
    # as it was before this tick started — still pending, ready to be
    # retried on the next tick rather than stuck in a broken state.
    assert bad.quote_sync_state == "pending"
    assert bad.quote_id is None


@pytest.mark.asyncio
async def test_commit_failure_for_middle_project_does_not_abort_the_last_one(db_session, monkeypatch):
    """Regression guard for the ``MissingGreenlet`` cascade: with three pending
    projects, the middle one's ``db.commit()`` failing must not take the third
    one down with it.

    ``rollback()`` expires every object in the session's identity map, not
    just the failing project's — so if ``run_sync_once`` still held a list of
    ORM instances loaded before the loop, touching the third project's
    already-expired attributes after the second project's rollback would
    raise ``MissingGreenlet`` (a lazy-load attempted outside a greenlet
    context), aborting the tick before the third project is ever synced.
    First and last project (a two-project version of the existing commit-
    failure test) can't reproduce this: nothing is left to expire once the
    failing project is the last one processed.
    """
    first = AitoProject(
        description="Premiere piece",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client A",
        quote_sync_state="pending",
    )
    middle = AitoProject(
        description="Piece du milieu",
        board_column="devis",
        position=1,
        client_id="C2",
        client_name="Client B",
        quote_sync_state="pending",
    )
    last = AitoProject(
        description="Derniere piece",
        board_column="devis",
        position=2,
        client_id="C3",
        client_name="Client C",
        quote_sync_state="pending",
    )
    db_session.add_all([first, middle, last])
    await db_session.flush()
    db_session.add(AitoTask(project_id=first.id, position=0, title="First", scan_cost=5000))
    db_session.add(AitoTask(project_id=middle.id, position=0, title="Middle", scan_cost=5000))
    db_session.add(AitoTask(project_id=last.id, position=0, title="Last", scan_cost=5000))
    await db_session.commit()
    await _configure_zoho(db_session)

    # All three sync cleanly through the real code path — no injected bug in
    # the export step. What fails is the middle project's commit itself.
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates"): {"estimates": []},
                ("POST", "/estimates"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "estimate_number": "DEV26-9001",
                        "date": "2026-07-29",
                        "status": "draft",
                        "total": 5000,
                        "last_modified_time": "2026-07-29T10:00:00-1000",
                        "is_inclusive_tax": True,
                    }
                },
            }
        )
    )
    zoho_service.invalidate_token()

    # Fail exactly the second of the three per-project commits (the middle
    # project's). Counting calls rather than inspecting project state avoids
    # touching an already-expired instance after the rollback below, which
    # would itself raise trying to lazily reload outside a greenlet context.
    original_commit = db_session.commit
    commit_calls = 0

    async def flaky_commit():
        nonlocal commit_calls
        commit_calls += 1
        if commit_calls == 2:
            raise RuntimeError("simulated commit failure")
        await original_commit()

    monkeypatch.setattr(db_session, "commit", flaky_commit)

    assert await run_sync_once(db_session) == 3

    await db_session.refresh(first)
    await db_session.refresh(middle)
    await db_session.refresh(last)
    # First project's write already landed before the middle one's commit
    # ever failed — it survives untouched.
    assert first.quote_id == "E1"
    assert first.quote_sync_state == "idle"
    # Middle project's commit failed, so run_sync_once's own guard rolled it
    # back: still pending, ready for retry on the next tick.
    assert middle.quote_sync_state == "pending"
    assert middle.quote_id is None
    # The point of the test: the last project must still be processed and
    # committed, even though it was loaded before the rollback that expired
    # every object in the session's identity map.
    assert last.quote_id == "E1"
    assert last.quote_sync_state == "idle"


@pytest.mark.asyncio
async def test_zoho_not_configured_leaves_project_pending(db_session):
    """No credentials entered yet: stay pending, not a failure."""
    project = AitoProject(
        description="Sans creds",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_sync_state="pending",
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Task", scan_cost=5000))
    await db_session.commit()
    # Deliberately not calling _configure_zoho: settings table has no Zoho keys.

    zoho_service.transport = httpx.MockTransport(zoho_handler({}))
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "pending"
    assert project.quote_id is None
    assert project.quote_sync_error is None


@pytest.mark.asyncio
async def test_zoho_request_rejected_goes_straight_to_error(db_session):
    """Books rejects the payload (HTTP 400): not retried, message recorded."""
    project = AitoProject(
        description="Payload invalide",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_sync_state="pending",
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Task", scan_cost=5000))
    await db_session.commit()
    await _configure_zoho(db_session)

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        if request.method == "GET" and request.url.path.endswith("/estimates"):
            return httpx.Response(200, json={"estimates": []})
        if request.method == "POST" and request.url.path.endswith("/estimates"):
            return httpx.Response(400, json={"message": "Invalid customer_id"})
        return httpx.Response(404, json={"message": "no route"})

    zoho_service.transport = httpx.MockTransport(handler)
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    assert project.quote_sync_error == "Invalid customer_id"
    assert project.quote_sync_failures == 0
    assert project.quote_id is None


async def _project_with_quote(db, **task_fields) -> AitoProject:
    project = AitoProject(
        description="Helice",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_id="E1",
        quote_number="DEV26-9001",
        quote_sync_state="pending",
    )
    db.add(project)
    await db.flush()
    db.add(AitoTask(project_id=project.id, position=0, title="Helice", **task_fields))
    await db.commit()
    return project


@pytest.mark.asyncio
async def test_update_preserves_foreign_lines_and_refreshes_status(db_session):
    project = await _project_with_quote(db_session, scan_cost=5000)
    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "sent",
                        "is_transaction_created": False,
                        "invoiced_amount": 0,
                        "is_inclusive_tax": True,
                        "line_items": [
                            {"line_item_id": "OLD", "sku": "P3DSCAN", "item_order": 1},
                            {"line_item_id": "FOREIGN", "sku": "", "name": "Bobine", "item_order": 2},
                        ],
                    }
                },
                ("PUT", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "estimate_number": "DEV26-9001",
                        "status": "sent",
                        "total": 8500,
                        "last_modified_time": "2026-07-29T11:00:00-1000",
                    }
                },
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "idle"
    assert project.quote_status == "sent"
    assert project.quote_total == 8500

    put = next(entry for entry in seen if entry[0] == "PUT")
    assert set(put[2]) == {"line_items"}  # partial PUT: nothing else is sent
    assert put[2]["line_items"][-1] == {"line_item_id": "FOREIGN", "item_order": 2}


@pytest.mark.asyncio
async def test_invoiced_quote_is_locked_and_never_written(db_session):
    project = await _project_with_quote(db_session, scan_cost=5000)
    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "accepted",
                        "is_transaction_created": True,
                        "invoiced_amount": 8500,
                    }
                }
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "locked"
    assert not any(entry[0] == "PUT" for entry in seen)


@pytest.mark.asyncio
async def test_accepted_quote_still_pushes(db_session):
    project = await _project_with_quote(db_session, scan_cost=5000)
    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "accepted",
                        "invoiced_amount": 0,
                        "is_inclusive_tax": True,
                        "line_items": [],
                    }
                },
                ("PUT", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "accepted", "total": 5000}},
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "idle"
    assert any(entry[0] == "PUT" for entry in seen)


@pytest.mark.asyncio
async def test_impression_cost_is_written_back_to_what_the_quote_can_express(db_session):
    project = await _project_with_quote(db_session, impression_cost=2401, impression_quantity=2)
    await _configure_zoho(db_session)
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "draft",
                        "invoiced_amount": 0,
                        "is_inclusive_tax": True,
                        "line_items": [],
                    }
                },
                ("PUT", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "draft", "total": 2400}},
            }
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    task_row = (await db_session.execute(select(AitoTask).where(AitoTask.project_id == project.id))).scalar_one()
    # 2401 over 2 units cannot be expressed at price_precision 0; the project
    # adopts the achievable figure so the two sides never disagree.
    assert task_row.impression_cost == 2400


@pytest.mark.asyncio
async def test_upstream_failures_escalate_to_error_after_the_limit(db_session):
    project = await _project_with_quote(db_session, scan_cost=1)
    await _configure_zoho(db_session)

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(503, json={"message": "down"})

    zoho_service.transport = httpx.MockTransport(handler)
    zoho_service.invalidate_token()

    for _ in range(SYNC_FAILURE_LIMIT - 1):
        await run_sync_once(db_session)
        await db_session.refresh(project)
        assert project.quote_sync_state == "pending"
    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"


@pytest.mark.asyncio
async def test_project_row_vanished_before_the_loop_reaches_it_is_skipped(db_session, monkeypatch):
    """The id was selected up front by run_sync_once's initial SELECT, but the
    row is gone by the time the per-iteration db.get() runs for it — e.g. hard
    deleted by something else in the same tick window. Must be skipped
    silently: no Zoho call, and the (nonexistent) project is certainly never
    flipped to 'error'."""
    project = AitoProject(
        description="Va disparaitre",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_sync_state="pending",
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Task", scan_cost=5000))
    await db_session.commit()
    project_id = project.id
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(zoho_handler({}, seen))
    zoho_service.invalidate_token()

    original_get = db_session.get

    async def get_as_if_deleted(model, ident, *args, **kwargs):
        if model is AitoProject and ident == project_id:
            return None
        return await original_get(model, ident, *args, **kwargs)

    monkeypatch.setattr(db_session, "get", get_as_if_deleted)

    assert await run_sync_once(db_session) == 0
    assert seen == []

    await db_session.refresh(project)
    assert project.quote_sync_state == "pending"
    assert project.quote_sync_error is None


@pytest.mark.asyncio
async def test_trashing_a_project_declines_its_quote_and_snapshots_the_status(db_session):
    project = await _project_with_quote(db_session, scan_cost=1)
    await _configure_zoho(db_session)
    project.status = "deleted"
    await db_session.commit()
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {"estimate_id": "E1", "status": "sent", "invoiced_amount": 0, "line_items": []}
                },
                ("POST", "/status/declined"): {"message": "ok"},
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_status_before_trash == "sent"
    assert project.quote_status == "declined"
    assert project.quote_sync_state == "idle"
    assert any(entry[1].endswith("/status/declined") for entry in seen)
    assert not any(entry[0] == "PUT" for entry in seen)


@pytest.mark.asyncio
async def test_restoring_reapplies_the_snapshotted_status(db_session):
    project = await _project_with_quote(db_session, scan_cost=1)
    await _configure_zoho(db_session)
    project.quote_status = "declined"
    project.quote_status_before_trash = "accepted"
    await db_session.commit()
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "declined",
                        "invoiced_amount": 0,
                        "is_inclusive_tax": True,
                        "line_items": [],
                    }
                },
                ("POST", "/status/accepted"): {"message": "ok"},
                ("PUT", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "accepted", "total": 1}},
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_status_before_trash is None
    assert any(entry[1].endswith("/status/accepted") for entry in seen)
    # The status restore is only half the tick: with is_inclusive_tax present,
    # the worker must fall through to the normal push afterwards. Without this
    # field a fail-closed guard would lock the project here and skip the PUT
    # entirely, which is exactly the coverage gap this test now closes.
    assert any(entry[0] == "PUT" for entry in seen)
    assert project.quote_sync_state == "idle"


@pytest.mark.asyncio
async def test_a_quote_that_was_a_draft_stays_declined_on_restore(db_session):
    """Books offers no /status/draft. The snapshot is kept as the record of
    what it was, and the panel explains it — nothing pretends otherwise."""
    project = await _project_with_quote(db_session, scan_cost=1)
    await _configure_zoho(db_session)
    project.quote_status = "declined"
    project.quote_status_before_trash = "draft"
    await db_session.commit()
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "declined",
                        "invoiced_amount": 0,
                        "is_inclusive_tax": True,
                        "line_items": [],
                    }
                },
                ("PUT", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "declined", "total": 1}},
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_status_before_trash == "draft"
    assert not any("/status/" in entry[1] for entry in seen)


@pytest.mark.asyncio
async def test_an_invoiced_quote_is_never_declined_by_trashing(db_session):
    project = await _project_with_quote(db_session, scan_cost=1)
    await _configure_zoho(db_session)
    project.status = "deleted"
    await db_session.commit()
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {"estimate_id": "E1", "status": "accepted", "invoiced_amount": 900}
                }
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "locked"
    assert not any("/status/" in entry[1] for entry in seen)


@pytest.mark.asyncio
async def test_a_trashed_project_with_no_quote_costs_no_call(db_session):
    await _configure_zoho(db_session)
    db_session.add(
        AitoProject(
            description="Jamais devise",
            board_column="devis",
            position=0,
            status="deleted",
            quote_sync_state="pending",
        )
    )
    await db_session.commit()
    seen: list = []
    zoho_service.transport = httpx.MockTransport(zoho_handler({}, seen))
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    assert seen == []


@pytest.mark.asyncio
async def test_project_state_changed_away_from_pending_before_the_loop_reaches_it_is_skipped(db_session, monkeypatch):
    """The id was selected up front, but something else already moved the
    project's state on (e.g. a concurrent request handler) by the time the
    loop's db.get() reaches it. Must be skipped, not reprocessed and not
    flipped to 'error'."""
    project = AitoProject(
        description="Deja traite ailleurs",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_sync_state="pending",
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Task", scan_cost=5000))
    await db_session.commit()
    project_id = project.id
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(zoho_handler({}, seen))
    zoho_service.invalidate_token()

    original_get = db_session.get

    async def get_with_state_moved_on(model, ident, *args, **kwargs):
        obj = await original_get(model, ident, *args, **kwargs)
        if model is AitoProject and ident == project_id and obj is not None:
            obj.quote_sync_state = "idle"
        return obj

    monkeypatch.setattr(db_session, "get", get_with_state_moved_on)

    assert await run_sync_once(db_session) == 0
    assert seen == []

    # refresh() re-queries the DB and overwrites the in-memory attribute,
    # discarding the uncommitted "idle" the monkeypatch set above — proving
    # the guard never persisted anything for this project either.
    await db_session.refresh(project)
    assert project.quote_sync_state == "pending"
    assert project.quote_sync_error is None


@pytest.mark.asyncio
async def test_sync_interval_falls_back_to_sixty_seconds(db_session):
    from backend.app.services.aito_quote_sync import sync_interval_seconds

    assert await sync_interval_seconds(db_session) == 60


@pytest.mark.asyncio
async def test_sync_is_skipped_when_disabled_in_settings(db_session):
    from backend.app.services.aito_quote_sync import sync_enabled

    assert await sync_enabled(db_session) is True
    await set_setting(db_session, "aito_quote_sync_enabled", "false")
    assert await sync_enabled(db_session) is False


# --- Final pre-merge review fixes -------------------------------------------


@pytest.mark.asyncio
async def test_tax_exclusive_estimate_is_locked_and_never_written(db_session):
    """C1: board costs are stored TTC and this module never converts. Pushing
    our line items onto a tax-EXCLUSIVE estimate would have Books add tax on
    top of a figure that already includes it, silently inflating the total by
    the tax rate on every push. Must be locked exactly like an invoiced quote,
    and nothing may be PUT."""
    project = await _project_with_quote(db_session, scan_cost=5000)
    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "draft",
                        "is_transaction_created": False,
                        "invoiced_amount": 0,
                        "is_inclusive_tax": False,
                        "line_items": [],
                    }
                },
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "locked"
    assert project.quote_sync_error
    assert not any(entry[0] == "PUT" for entry in seen)


@pytest.mark.asyncio
async def test_update_response_omitting_is_inclusive_tax_is_locked_not_pushed(db_session):
    """Important 4: the fail-OPEN bug this replaces checked
    `estimate.get("is_inclusive_tax") is False`, which lets a response that
    OMITS the field entirely (None, not False) fall through to the PUT —
    exactly what the existing test_update_preserves_foreign_lines... mock
    used to do by accident. A guard protecting real customer money must fail
    CLOSED: an absent field is treated the same as an explicit False."""
    project = await _project_with_quote(db_session, scan_cost=5000)
    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "draft",
                        "is_transaction_created": False,
                        "invoiced_amount": 0,
                        # is_inclusive_tax deliberately absent.
                        "line_items": [],
                    }
                },
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "locked"
    assert project.quote_sync_error
    assert not any(entry[0] == "PUT" for entry in seen)


@pytest.mark.asyncio
async def test_create_response_omitting_is_inclusive_tax_is_locked(db_session):
    """Important 4, create path: the original code never checked the create
    response at all, so in a tax-exclusive org (or on any response that omits
    the field) `_create_quote` could produce a brand-new customer estimate
    inflated by the tax rate with no lock and no error. The estimate already
    exists in Books by the time the response is back, so its identity
    (quote_id/url) is still captured — only further writes are blocked."""
    project = AitoProject(
        description="Helice",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_sync_state="pending",
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Helice", scan_cost=5000))
    await db_session.commit()
    await _configure_zoho(db_session)

    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates"): {"estimates": []},
                ("POST", "/estimates"): {
                    "estimate": {
                        "estimate_id": "E-EXCL",
                        "estimate_number": "DEV26-9003",
                        "status": "draft",
                        "total": 5500,
                        # is_inclusive_tax deliberately absent.
                    }
                },
            }
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "locked"
    assert project.quote_sync_error
    assert project.quote_id == "E-EXCL"
    assert project.quote_url.startswith("https://books.")


@pytest.mark.asyncio
async def test_create_writes_back_rounded_impression_immediately(db_session):
    """I3: the write-back must happen on the CREATE path too, not just
    update — otherwise a brand new project shows a stale, unrounded figure on
    its card until some unrelated later edit converges the two sides."""
    project = AitoProject(
        description="Helice",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_sync_state="pending",
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(
        AitoTask(project_id=project.id, position=0, title="Helice", impression_cost=2401, impression_quantity=2)
    )
    await db_session.commit()
    await _configure_zoho(db_session)

    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates"): {"estimates": []},
                ("POST", "/estimates"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "estimate_number": "DEV26-9001",
                        "status": "draft",
                        "total": 2400,
                        "is_inclusive_tax": True,
                    }
                },
            }
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    task_row = (await db_session.execute(select(AitoTask).where(AitoTask.project_id == project.id))).scalar_one()
    # 2401 over 2 units cannot be expressed at price_precision 0, same as the
    # update-path test above — this one exercises the create path instead.
    assert task_row.impression_cost == 2400
    # With is_inclusive_tax present, the create must land 'idle', not fall
    # through to the tax-exclusive lock guard — proving the create-success
    # path is still exercised end to end, not just the write-back that
    # happens before the guard runs.
    assert project.quote_sync_state == "idle"


@pytest.mark.asyncio
async def test_create_adopts_an_existing_estimate_with_the_same_reference_instead_of_duplicating(db_session):
    """I4: simulates the aftermath of a POST that succeeded but whose commit
    then failed — the project is still `pending` and quote_id-less, but Books
    already holds an estimate under this exact AITO-{id} reference. The next
    tick must adopt that orphan's IDENTITY, not POST a second one.

    Important 3: adopting must NOT declare the project in sync. The
    looked-up object is a list summary, not the full estimate (no
    line_items), and the project may have been edited since the orphaned
    POST — so the project stays 'pending' rather than going 'idle'. See
    ``test_adopted_orphan_is_brought_into_sync_by_the_following_tick`` for the
    full scenario this protects, through to the next tick's push."""
    project = AitoProject(
        description="Helice",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_sync_state="pending",
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Helice", scan_cost=5000))
    await db_session.commit()
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates"): {
                    "estimates": [
                        {
                            "estimate_id": "E-ORPHAN",
                            "estimate_number": "DEV26-9002",
                            "reference_number": f"AITO-{project.id}",
                            "customer_id": "C1",
                            "date": "2026-07-29",
                            "status": "draft",
                            "total": 5000,
                            "last_modified_time": "2026-07-29T09:00:00-1000",
                        }
                    ]
                },
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_id == "E-ORPHAN"
    assert project.quote_number == "DEV26-9002"
    assert project.quote_url.startswith("https://books.")
    # NOT 'idle': see the Important-3 note in the docstring above.
    assert project.quote_sync_state == "pending"
    assert not any(entry[0] == "POST" for entry in seen)


@pytest.mark.asyncio
async def test_adopted_orphan_is_brought_into_sync_by_the_following_tick(db_session):
    """Important 3: the exact scenario the fix targets. POST succeeds with a
    scan-only line, the commit that would have recorded its estimate_id
    fails, and — before the next tick — the user enables Impression3D on the
    same task. The tick that finds the orphan must leave the project
    'pending' (proven by the previous test); THIS test proves the payoff:
    the immediately-following tick takes the normal update path, re-reads the
    FULL estimate, and pushes BOTH services — not just the one Books already
    had. Before the fix, the adopt branch declared the card 'idle' on the
    first tick and this second tick never ran at all, leaving Books diverged
    from the board forever."""
    project = AitoProject(
        description="Helice",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_sync_state="pending",
    )
    db_session.add(project)
    await db_session.flush()
    task = AitoTask(project_id=project.id, position=0, title="Helice", scan_cost=5000)
    db_session.add(task)
    await db_session.commit()
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates"): {
                    "estimates": [
                        {
                            "estimate_id": "E-ORPHAN",
                            "reference_number": f"AITO-{project.id}",
                            "customer_id": "C1",
                            "status": "draft",
                            "total": 5000,
                        }
                    ]
                },
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_id == "E-ORPHAN"
    assert project.quote_sync_state == "pending"
    assert not any(entry[0] == "POST" for entry in seen)

    # The edit that motivated this scenario, made before the adopting tick's
    # POST-commit-failure could even be retried — the same task, now with a
    # second service enabled.
    task.impression_cost = 1000
    task.impression_quantity = 1
    await db_session.commit()

    seen.clear()
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E-ORPHAN"): {
                    "estimate": {
                        "estimate_id": "E-ORPHAN",
                        "status": "draft",
                        "invoiced_amount": 0,
                        "is_inclusive_tax": True,
                        # Books still holds only the scan line from the
                        # orphaned POST — this is the divergence Important 3
                        # exists to close, not paper over.
                        "line_items": [{"line_item_id": "L1", "sku": "P3DSCAN", "item_order": 1}],
                    }
                },
                ("PUT", "/estimates/E-ORPHAN"): {
                    "estimate": {"estimate_id": "E-ORPHAN", "status": "draft", "total": 6000}
                },
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "idle"
    assert project.quote_total == 6000

    put = next(entry for entry in seen if entry[0] == "PUT")
    # Both services pushed, proving the divergence is closed: the scan line
    # is regenerated fresh from the task (build_line_items never echoes an
    # AITO-owned line, only foreign ones), and the impression line is new.
    assert len(put[2]["line_items"]) == 2


@pytest.mark.asyncio
async def test_create_lookup_failure_retries_rather_than_blindly_creating(db_session):
    """I4: when the reference-number lookup itself fails, creation must NOT
    fall back to POSTing anyway — that risks the exact duplicate this fix
    exists to prevent. It is treated as an ordinary upstream failure and
    retried next tick, the same as any other Zoho outage."""
    project = AitoProject(
        description="Helice",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_sync_state="pending",
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Helice", scan_cost=5000))
    await db_session.commit()
    await _configure_zoho(db_session)

    seen: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        seen.append((request.method, request.url.path))
        if request.method == "GET" and request.url.path.endswith("/estimates"):
            return httpx.Response(503, json={"message": "down"})
        return httpx.Response(500, json={"message": "should not be reached"})

    zoho_service.transport = httpx.MockTransport(handler)
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "pending"
    assert project.quote_id is None
    assert project.quote_sync_failures == 1
    assert not any(method == "POST" for method, _ in seen)


@pytest.mark.asyncio
async def test_create_does_not_adopt_when_the_reference_number_is_ambiguous(db_session):
    """Critical 2: Books does not enforce reference_number uniqueness. If two
    estimates both carry AITO-{id}, the unverified original code took
    estimates[0] and adopted whichever one happened to sort first — this
    project's tasks would then overwrite a real, unrelated customer estimate
    on the very next push. The fix refuses to guess: no adoption, no POST
    (which would risk a THIRD estimate under the same reference), a terminal
    'error' state naming the ambiguity."""
    project = AitoProject(
        description="Helice",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_sync_state="pending",
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Helice", scan_cost=5000))
    await db_session.commit()
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates"): {
                    "estimates": [
                        {
                            "estimate_id": "E-MINE",
                            "reference_number": f"AITO-{project.id}",
                            "customer_id": "C1",
                        },
                        {
                            "estimate_id": "E-SOMEONE-ELSES",
                            "reference_number": f"AITO-{project.id}",
                            "customer_id": "C1",
                        },
                    ]
                },
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    assert project.quote_id is None
    assert project.quote_sync_error
    assert not any(entry[0] == "POST" for entry in seen)


@pytest.mark.asyncio
async def test_create_does_not_adopt_an_estimate_belonging_to_a_different_customer(db_session):
    """Critical 2, the actual money-risk scenario: a single exact-reference
    match exists, but its customer_id does not match this project's
    client_id — Books' reference_number filter matched (or the query was
    ignored and it fell through to a coincidental collision), and the
    unverified original code would have adopted a LIVE, unrelated customer's
    estimate. This project's line items would then overwrite it on the very
    next push. Must be refused, not adopted, terminal 'error' recorded."""
    project = AitoProject(
        description="Helice",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_sync_state="pending",
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Helice", scan_cost=5000))
    await db_session.commit()
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates"): {
                    "estimates": [
                        {
                            "estimate_id": "E-STRANGER",
                            "reference_number": f"AITO-{project.id}",
                            "customer_id": "SOMEONE_ELSE",
                        }
                    ]
                },
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    assert project.quote_id is None
    assert project.quote_sync_error
    assert not any(entry[0] == "POST" for entry in seen)


@pytest.mark.asyncio
async def test_create_with_no_priced_service_becomes_a_terminal_error(db_session):
    """Minor 5: mirrors the update-path test of the same name, on the create
    path. A project whose only task has every service disabled must not spin
    forever re-attempting creation every tick — it lands in a terminal state,
    and a second tick makes no Zoho call at all."""
    project = AitoProject(
        description="Vide",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_sync_state="pending",
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Rien"))  # no cost fields set at all
    await db_session.commit()
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(zoho_handler({}, seen))
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    assert project.quote_sync_error
    assert seen == []  # no Zoho call at all: caught before any lookup or POST

    seen.clear()
    assert await run_sync_once(db_session) == 0
    assert seen == []


@pytest.mark.asyncio
async def test_trashing_before_first_tick_then_restoring_and_editing_is_re_enqueued(db_session):
    """Critical 1: the exact reported sequence — create, trash before the
    first sync tick ever runs, tick, restore, edit — must end with the
    project re-enqueued ('pending'), not permanently frozen like a legacy
    card. Runs the REAL route handlers and a REAL sync tick (unlike the
    hand-set-state version in test_aito_quote_protection.py), so this is the
    end-to-end regression guard for Critical 1's first bug."""
    from backend.app.api.routes.aito import create_project, delete_project, restore_project, update_project
    from backend.app.schemas.aito import AitoProjectCreate, AitoProjectUpdate, AitoTaskCreate

    payload = AitoProjectCreate(
        description="Helice",
        client_id="C1",
        client_name="Client",
        tasks=[AitoTaskCreate(title="Helice", scan_cost=5000)],
    )
    created = await create_project(payload=payload, db=db_session, current_user=None)
    assert created.quote_sync_state == "pending"

    await delete_project(project_id=created.id, db=db_session, _=None)
    row = (await db_session.execute(select(AitoProject).where(AitoProject.id == created.id))).scalar_one()
    assert row.status == "deleted"
    assert row.quote_sync_state == "pending"  # still queued — the tick hasn't run yet

    await _configure_zoho(db_session)
    zoho_service.transport = httpx.MockTransport(zoho_handler({}))
    zoho_service.invalidate_token()
    assert await run_sync_once(db_session) == 1
    await db_session.refresh(row)
    assert row.status == "deleted"
    assert row.quote_id is None
    # Ticked out of the pending queue, but NOT 'unmanaged': see
    # sync_project's quote-less-deleted branch. Under the OLD, inferred-
    # ownership guard this row and a true legacy card were indistinguishable
    # from here on, and restoring left it frozen forever.
    assert row.quote_sync_state != "pending"
    assert row.quote_sync_state != "unmanaged"

    restored = await restore_project(project_id=created.id, db=db_session, _=None)
    assert restored.quote_sync_state == "pending"

    edited = await update_project(
        project_id=created.id,
        payload=AitoProjectUpdate(description="Helice modifiee"),
        db=db_session,
        _=None,
    )
    assert edited.quote_sync_state == "pending"


@pytest.mark.asyncio
async def test_update_with_no_priced_service_does_not_wipe_the_quotes_lines(db_session):
    """I6: clearing the only priced service on the only task of an existing
    quote must not PUT an empty line_items array onto it — Books would delete
    every Aito line the live estimate has.

    Minor 5: also must not spin forever. Left as 'pending', this project
    would be re-selected and re-GET every single tick indefinitely; it must
    land in a terminal state instead, with the explanatory error kept."""
    project = await _project_with_quote(db_session)  # no cost fields set -> nothing priced
    await _configure_zoho(db_session)
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "sent",
                        "invoiced_amount": 0,
                        "is_inclusive_tax": True,
                        "line_items": [],
                    }
                },
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert not any(entry[0] == "PUT" for entry in seen)
    assert project.quote_sync_error
    assert project.quote_sync_state == "error"

    # A second tick must not even attempt another Zoho call: 'error' is
    # terminal, not re-selected by run_sync_once's `WHERE quote_sync_state ==
    # 'pending'` — this is the actual regression guard for Minor 5's
    # "unbounded GET every 60s" complaint.
    seen.clear()
    assert await run_sync_once(db_session) == 0
    assert seen == []


@pytest.mark.asyncio
async def test_decline_snapshot_survives_a_commit_failure_that_happens_after_the_decline_call(db_session, monkeypatch):
    """Deferred item 5: quote_status_before_trash must be durably persisted
    BEFORE the (irreversible) decline call, not only by the caller's later
    commit. Failing every commit issued once Books has actually recorded the
    decline characterises "the commit after the decline call fails" without
    hardcoding a specific call count — which would differ between the pre-fix
    (one commit total) and post-fix (two commits) versions of this code."""
    project = await _project_with_quote(db_session, scan_cost=1)
    await _configure_zoho(db_session)
    project.status = "deleted"
    await db_session.commit()

    decline_seen = {"done": False}

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        if request.method == "GET" and request.url.path.endswith("/estimates/E1"):
            return httpx.Response(
                200,
                json={"estimate": {"estimate_id": "E1", "status": "sent", "invoiced_amount": 0, "line_items": []}},
            )
        if request.method == "POST" and request.url.path.endswith("/status/declined"):
            decline_seen["done"] = True
            return httpx.Response(200, json={"message": "ok"})
        return httpx.Response(404, json={"message": "no route"})

    zoho_service.transport = httpx.MockTransport(handler)
    zoho_service.invalidate_token()

    original_commit = db_session.commit

    async def flaky_commit():
        if decline_seen["done"]:
            raise RuntimeError("simulated commit failure after the decline call")
        await original_commit()

    monkeypatch.setattr(db_session, "commit", flaky_commit)

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_status_before_trash == "sent"
