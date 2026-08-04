"""The Aito -> Zoho outbox worker, driven through zoho_service's MockTransport
seam. No network, no real Books org."""

import json
from datetime import datetime

import httpx
import pytest
from sqlalchemy import select

from backend.app.api.routes.settings import set_setting
from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.services.aito_quote_export import Catalogue
from backend.app.services.aito_quote_sync import (
    SYNC_FAILURE_LIMIT,
    ShippingCatalogueUnavailable,
    _deferred_reasons,
    load_export_shipping,
    run_sync_once,
    sync_project,
)
from backend.app.services.aito_shipping import SERVICE_LABELS
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


@pytest.fixture(autouse=True)
def reset_deferred_reasons():
    """_deferred_reasons is process-local, module-level state (deliberately —
    see its own comment), so it survives across tests in the same run just
    like the module singleton above and needs the same reset."""
    _deferred_reasons.clear()
    yield
    _deferred_reasons.clear()


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

    def flaky_build_line_items(tasks, existing_line_items, catalogue, shipping=None):
        if any(t.title == "Bad" for t in tasks):
            raise TypeError("simulated bug in export")
        return original_build_line_items(tasks, existing_line_items, catalogue, shipping=shipping)

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
async def test_sync_recomputes_board_column_so_the_card_does_not_go_stale(db_session):
    """Critical 2: sync_project writes quote_status straight onto the project
    but has no notion of board_column, and _to_response derives move_lock from
    the LIVE quote_status while returning the STORED board_column. Without
    run_sync_once also recomputing and storing board_column, a card sitting in
    Printing whose quote comes back `sent` renders self-contradictory: parked
    in Printing but locked with a "waiting on the client" badge. A project
    that sits in `print` while Books reports its estimate `sent` must end the
    sync tick relocated to `waiting`.

    The local status here is deliberately UNDECIDED ('draft'): a DECIDED one is
    no longer overwritten by an undecided remote (see _apply_estimate's guard
    and test_a_local_acceptance_survives_a_task_edit_while_books_still_says_sent),
    so staging this with a local 'accepted' would exercise a write the module
    is now specifically built not to make, and prove nothing about
    board_column."""
    project = await _project_with_quote(db_session, impression_cost=5000, impression_done=True)
    project.board_column = "print"
    project.quote_status = "draft"
    await db_session.commit()
    await _configure_zoho(db_session)
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
                        "line_items": [],
                    }
                },
                ("PUT", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "estimate_number": "DEV26-9001",
                        "status": "sent",
                        "total": 5000,
                        "last_modified_time": "2026-07-29T11:00:00-1000",
                    }
                },
            }
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_status == "sent"
    assert project.board_column == "waiting"


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
async def test_invoiced_lock_stamps_quote_invoiced(db_session):
    """Task 10: 'locked' also covers tax-exclusive quotes (see
    test_tax_exclusive_estimate_is_locked_and_never_written below), so the
    board's "this job is billed" glow cannot key off quote_sync_state alone.
    An estimate Books reports as invoiced (is_transaction_created) must stamp
    the dedicated quote_invoiced flag alongside the existing lock."""
    project = await _project_with_quote(db_session, scan_cost=5000)
    await _configure_zoho(db_session)
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
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "locked"
    assert project.quote_invoiced is True


@pytest.mark.asyncio
async def test_tax_exclusive_lock_does_not_stamp_quote_invoiced(db_session):
    """Task 10: a tax-exclusive estimate locks for a reason that has nothing
    to do with Books invoicing it — the glow must not claim it was invoiced
    just because it shares the same quote_sync_state."""
    project = await _project_with_quote(db_session, scan_cost=5000)
    await _configure_zoho(db_session)
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
            }
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "locked"
    assert project.quote_invoiced is False


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
async def test_a_quote_that_was_a_draft_comes_back_as_sent_on_restore(db_session):
    """Books offers no /status/draft, so a restore puts the estimate back to
    'sent' — its nearest legal state, and the literal truth: the trash path's
    sent-first chain really did mark it sent before declining it.

    This replaces an assertion that such a quote simply STAYED declined. That
    was written when a decline POST against a draft still 400'd (so the case
    was unreachable) and when the board still offered Accept on a declined
    card. Both changed, and 'declined' became an absorbing state a restored
    project could never leave."""
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
                ("POST", "/status/sent"): {"message": "ok"},
                ("PUT", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "sent", "total": 1}},
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_status == "sent"
    assert project.quote_status_before_trash is None
    assert any(entry[1].endswith("/status/sent") for entry in seen)
    assert not any(entry[1].endswith("/status/declined") for entry in seen)
    # Same as the accepted-snapshot restore above: the status hop is only half
    # the tick, the line-item push must still happen.
    assert any(entry[0] == "PUT" for entry in seen)


@pytest.mark.asyncio
async def test_a_local_acceptance_survives_a_task_edit_while_books_still_says_sent(db_session):
    """Important 2. Accepting a card whose estimate was still a draft marks it
    sent first; if the accept POST then fails, the board holds 'accepted' while
    Books holds 'sent'. The next task edit takes the pending path, and
    _apply_estimate used to copy Books' 'sent' straight back over the local
    acceptance — knocking the card off its work columns, hiding the Done
    toggle, 422-ing every tick, and leaving reconcile_quote_status unable to
    repair it (with an UNDECIDED local status it adopts Books' forever).

    A DECIDED local status is never replaced by an UNDECIDED remote one."""
    project = await _project_with_quote(db_session, impression_cost=5000, impression_done=True)
    await _configure_zoho(db_session)
    project.quote_status = "accepted"
    project.board_column = "print"
    await db_session.commit()
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
                        "line_items": [],
                    }
                },
                ("PUT", "/estimates/E1"): {
                    "estimate": {"estimate_id": "E1", "status": "sent", "total": 5000},
                },
            }
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_status == "accepted"
    # And the card stays on a WORK column — the rules advance it to 'finish'
    # because its impression is ticked — rather than being sent back to
    # 'waiting' by a status the shop never left.
    assert project.board_column == "finish"


@pytest.mark.asyncio
async def test_a_push_never_resolves_two_disagreeing_decisions_in_books_favour(db_session):
    """The C1 exit, undone by a copy-back. Accept on a DECLINED card writes
    'accepted' locally while the Books POST is best-effort (it can return
    zoho_synced=False), so the board holds 'accepted' against a Books
    'declined'. The next pending event of any kind — a task edit, an
    add/delete, the panel's Retry sync — comes through _apply_estimate.

    A guard phrased as "remote not in _DECIDED" passes here, because 'declined'
    IS decided, and silently re-declines the card. Two disagreeing decisions
    are the reconciler's conflict to record, never this path's to resolve."""
    project = await _project_with_quote(db_session, impression_cost=5000, impression_done=True)
    await _configure_zoho(db_session)
    project.quote_status = "accepted"
    project.board_column = "print"
    await db_session.commit()
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "declined",
                        "is_transaction_created": False,
                        "invoiced_amount": 0,
                        "is_inclusive_tax": True,
                        "line_items": [],
                    }
                },
                ("PUT", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "declined", "total": 5000}},
            }
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_status == "accepted"
    # And the card stays on a work column rather than being swept to 'done' by
    # a decline nobody on this side made.
    assert project.board_column == "finish"


@pytest.mark.asyncio
async def test_a_push_still_adopts_books_status_when_ours_is_undecided(db_session):
    """The other half of the same guard: the copy-back is not disabled, only
    made asymmetric. A client viewing the quote is still news to us."""
    project = await _project_with_quote(db_session, scan_cost=5000)
    await _configure_zoho(db_session)
    project.quote_status = "sent"
    await db_session.commit()
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "viewed",
                        "is_transaction_created": False,
                        "invoiced_amount": 0,
                        "is_inclusive_tax": True,
                        "line_items": [],
                    }
                },
                ("PUT", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "viewed", "total": 5000}},
            }
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_status == "viewed"


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


# --- Instant quote creation: wake-driven pending-only drain ------------------


def _estimate_body(estimate_id: str = "E1") -> dict:
    return {
        "estimate": {
            "estimate_id": estimate_id,
            "estimate_number": "DEV26-9001",
            "date": "2026-07-29",
            "status": "draft",
            "total": 5000,
            "last_modified_time": "2026-07-29T10:00:00-1000",
            "is_inclusive_tax": True,
        }
    }


@pytest.mark.asyncio
async def test_pending_only_drain_creates_the_quote_but_reconciles_nothing(db_session):
    """The wake path must cost only the Books calls the pending project was
    going to spend anyway. A quoted idle project — which a full tick WOULD
    poll for status — is left untouched, so waking on every creation cannot
    burn reconcile quota."""
    pending = AitoProject(
        description="Nouveau",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_sync_state="pending",
    )
    idle = AitoProject(
        description="Ancien",
        board_column="devis",
        position=1,
        client_id="C2",
        client_name="Autre",
        quote_id="E9",
        quote_sync_state="idle",
    )
    db_session.add_all([pending, idle])
    await db_session.flush()
    db_session.add(AitoTask(project_id=pending.id, position=0, title="Helice", scan_cost=5000))
    await db_session.commit()
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates"): {"estimates": []},
                ("POST", "/estimates"): _estimate_body(),
                # Present so that if the drain DOES wrongly reconcile the idle
                # project, the call is recorded in `seen` rather than 404ing
                # into an unrelated failure path.
                ("GET", "/estimates/E9"): _estimate_body("E9"),
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session, pending_only=True) == 1
    await db_session.refresh(pending)
    assert pending.quote_id == "E1"
    assert pending.quote_sync_state == "idle"
    assert not any(path.endswith("/estimates/E9") for _, path, _ in seen)


@pytest.mark.asyncio
async def test_wake_drains_a_pending_project_without_waiting_for_the_interval(db_session, test_engine, monkeypatch):
    """End to end through run_sync_loop: request_immediate_sync() must get a
    fresh project its quote within moments, not at the next 300s tick."""
    import asyncio

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from backend.app.services import aito_quote_sync

    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(aito_quote_sync, "async_session", maker)

    await _configure_zoho(db_session)
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates"): {"estimates": []},
                ("POST", "/estimates"): _estimate_body(),
            }
        )
    )
    zoho_service.invalidate_token()

    loop_task = asyncio.create_task(aito_quote_sync.run_sync_loop())
    try:
        # Let the startup full pass run; there is nothing for it to drain yet.
        await asyncio.sleep(0.05)
        project = AitoProject(
            description="Nouveau",
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

        aito_quote_sync.request_immediate_sync()

        for _ in range(100):  # up to ~2s — far below the 300s tick
            await asyncio.sleep(0.02)
            await db_session.refresh(project)
            if project.quote_id:
                break
        assert project.quote_id == "E1"
        assert project.quote_sync_state == "idle"
    finally:
        loop_task.cancel()
        await asyncio.gather(loop_task, return_exceptions=True)


@pytest.mark.asyncio
async def test_sync_interval_falls_back_to_three_hundred_seconds(db_session):
    from backend.app.services.aito_quote_sync import sync_interval_seconds

    assert await sync_interval_seconds(db_session) == 300


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
        client_phone="+689 87 00 00 13",
        tasks=[AitoTaskCreate(title="Helice", scan_cost=5000)],
    )
    created = await create_project(payload=payload, db=db_session, current_user=None)
    assert created.quote_sync_state == "pending"

    await delete_project(project_id=created.id, db=db_session, current_user=None)
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

    restored = await restore_project(project_id=created.id, db=db_session, current_user=None)
    assert restored.quote_sync_state == "pending"

    edited = await update_project(
        project_id=created.id,
        payload=AitoProjectUpdate(description="Helice modifiee"),
        db=db_session,
        current_user=None,
    )
    assert edited.quote_sync_state == "pending"


@pytest.mark.asyncio
async def test_update_with_no_priced_service_does_not_wipe_the_quotes_lines(db_session):
    """I6: clearing the only priced service on the only task of an existing
    quote must not PUT an empty line_items array onto it — Books would delete
    every Aito line the live estimate has.

    Minor 5: also must not spin forever RE-PUSHING the line items. Left as
    'pending', this project would be re-selected and re-GET every single tick
    indefinitely for a line-item retry that could never succeed; it must land
    in a terminal state instead, with the explanatory error kept. The
    quote-status sweep (Task 7) still reaches an 'error' project that has a
    quote_id — only 'pending', 'unmanaged' and 'locked' are excluded from it,
    deliberately, since a status mismatch is worth reconciling even when the
    line-item push is broken — so the second tick below is re-armed to prove
    that reconciliation read never turns into a PUT, rather than asserting no
    call happens at all."""
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

    # Second tick: the sweep's GET is a no-op for status too, since this
    # project's quote_status was never set (the create/update path errored out
    # before _apply_estimate ran) — mocking Books' status as absent matches
    # that "unset" local value, so reconcile_quote_status's own early return
    # (zoho_status falsy) fires and nothing is written.
    seen.clear()
    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1"}}}, seen)
    )
    assert await run_sync_once(db_session) == 1
    assert not any(entry[0] == "PUT" for entry in seen)
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    assert project.quote_sync_error


@pytest.mark.asyncio
async def test_an_accepted_board_pushes_to_a_draft_quote(db_session):
    """The live divergence: the board decided, the push failed, nothing
    retried. Books rejects a direct draft -> accepted push, so the reconciler
    must chain through advance_estimate_status's sent-first behaviour: a
    POST to /status/sent followed by one to /status/accepted."""
    project = await _project_with_quote(db_session, impression_cost=1000)
    project.quote_status = "accepted"
    project.quote_sync_state = "idle"
    await db_session.commit()
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "draft"}},
                ("GET", "/estimates/E1/comments"): {"comments": []},
                ("POST", "/status/sent"): {"message": "ok"},
                ("POST", "/status/accepted"): {"message": "ok"},
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    # Scoped to the estimate GET specifically (not just "GET"): the sweep now
    # also fires a GET at /estimates/E1/comments to mirror Books' history
    # (Task 7), which is unrelated to what this test is proving and would
    # otherwise be conflated with a redundant estimate re-read.
    estimate_gets = [entry for entry in seen if entry[0] == "GET" and entry[1].endswith("/estimates/E1")]
    posts = [entry[1] for entry in seen if entry[0] == "POST"]
    assert len(posts) == 2
    assert posts[0].endswith("/status/sent")
    assert posts[1].endswith("/status/accepted")
    # M4: proves `current=zoho_status` (the estimate the sweep already read)
    # was actually passed through to advance_estimate_status, not left as the
    # default None — with current=None the sent-first chain would re-read the
    # estimate itself before POSTing, costing a second GET this mock does not
    # even provide a route for.
    assert len(estimate_gets) == 1
    assert project.quote_status == "accepted"
    assert project.quote_sync_error is None


@pytest.mark.asyncio
async def test_a_comment_mirror_failure_does_not_corrupt_the_syncs_own_state(db_session, monkeypatch):
    """AitoEvent.zoho_comment_id is a UNIQUE column, so mirror_comments' own
    write path can raise (e.g. an IntegrityError from two overlapping ticks
    racing the same comment_id), not just the network fetch. Before the fix,
    only the fetch sat inside sync_project's try -- mirror_comments and the
    watermark writes ran in the else branch, outside it, so a raise from
    mirror_comments escaped straight to sync_project's own outer catch-all.
    That flips quote_sync_state to 'error' and overwrites quote_sync_error,
    discarding this tick's already-successful reconcile_quote_status result
    for what is only a history-mirroring problem. Mirror failures must stay
    contained."""
    project = await _project_with_quote(db_session, impression_cost=1000)
    project.quote_status = "accepted"
    project.quote_sync_state = "idle"
    await db_session.commit()
    await _configure_zoho(db_session)

    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "accepted"}},
                ("GET", "/estimates/E1/comments"): {"comments": []},
            }
        )
    )
    zoho_service.invalidate_token()

    from backend.app.services import aito_quote_sync

    async def boom(*args, **kwargs):
        raise RuntimeError("simulated IntegrityError from a racing tick")

    monkeypatch.setattr(aito_quote_sync, "mirror_comments", boom)

    await sync_project(db_session, project)

    assert project.quote_sync_state != "error"
    assert project.quote_sync_error is None
    # The reconciler's own successful work from this same tick must survive
    # the mirror's failure too.
    assert project.quote_status == "accepted"


@pytest.mark.asyncio
async def test_an_undecided_board_adopts_books_status(db_session):
    """A client opening a sent quote is news to us, not something to
    overwrite — the board adopts Books' status with no push."""
    project = await _project_with_quote(db_session, impression_cost=1000)
    project.quote_status = "sent"
    project.quote_sync_state = "idle"
    await db_session.commit()
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "viewed"}}}, seen)
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_status == "viewed"
    assert not any(entry[0] == "POST" for entry in seen)


@pytest.mark.asyncio
async def test_two_conflicting_decisions_change_nothing(db_session):
    """Overwriting either side is destructive and unrecoverable, so neither
    wins: the conflict is recorded and both sides are left alone.

    Round 4 moved the record from a sentence in quote_sync_error to the
    quote_status_block/quote_status_remote pair, and dropped the
    quote_sync_state = 'error' flip that I4's ruling had required only because
    the panel's sync row was the sole place a message could surface. The panel
    now renders a recorded block for ANY sync state, so the conflict reaches a
    human without this module borrowing another subsystem's field (or its
    error badge, which also gates a Retry button that cannot help here)."""
    project = await _project_with_quote(db_session, impression_cost=1000)
    project.quote_status = "accepted"
    project.quote_sync_state = "idle"
    await db_session.commit()
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "declined"}}}, seen)
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert not any(entry[0] == "POST" for entry in seen)
    assert project.quote_status == "accepted"
    assert project.quote_status_block == "conflict"
    assert project.quote_status_remote == "declined"
    # Neither side changed, and neither did the field this module does not own.
    assert project.quote_sync_state == "idle"
    assert project.quote_sync_error is None


@pytest.mark.asyncio
async def test_agreeing_statuses_cost_no_write(db_session):
    """Both sides already agree: reconcile_quote_status's early return means
    no push and no local write, just the sweep's one GET.

    M3: asserting only "no POST" also passes if the sweep never reached this
    project at all (e.g. the old pending-only WHERE, or a regression that
    re-narrows it) — that would prove nothing was pushed for the wrong
    reason. Asserting `run_sync_once(...) == 1` first proves the sweep
    actually attempted this project, so "no POST" is then evidence the
    reconciler chose not to write, not evidence it was never asked."""
    project = await _project_with_quote(db_session, impression_cost=1000)
    project.quote_status = "accepted"
    project.quote_sync_state = "idle"
    await db_session.commit()
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "accepted"}}}, seen)
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert not any(entry[0] == "POST" for entry in seen)
    assert project.quote_status == "accepted"
    assert project.quote_sync_state == "idle"


@pytest.mark.asyncio
async def test_the_sweep_never_touches_an_unmanaged_project(db_session):
    """'unmanaged' is the ONE state meaning this feature must not touch the
    quote — see _mark_pending_if_ours. run_sync_once's widened select must
    exclude it, so sync_project (and therefore Zoho) is never even reached.

    M3: without a managed sibling that IS reached, this test also passes
    under the OLD pending-only WHERE (which excludes 'unmanaged' too, simply
    by excluding every non-pending state) — proving nothing about the new
    predicate specifically. The second project below is 'idle' with a
    quote_id, exactly the shape the widened sweep exists to reach, so a
    regression that accidentally excludes everything (not just 'unmanaged')
    fails this test via that project's missing GET."""
    unmanaged = await _project_with_quote(db_session, impression_cost=1000)
    unmanaged.quote_status = "accepted"
    unmanaged.quote_sync_state = "unmanaged"
    managed = AitoProject(
        description="Gerable",
        board_column="devis",
        position=1,
        client_id="C2",
        client_name="Client",
        quote_id="E2",
        quote_number="DEV26-9002",
        quote_status="accepted",
        quote_sync_state="idle",
    )
    db_session.add(managed)
    await db_session.flush()
    db_session.add(AitoTask(project_id=managed.id, position=0, title="Autre", impression_cost=1000))
    await db_session.commit()
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates/E2"): {"estimate": {"estimate_id": "E2", "status": "accepted"}}}, seen)
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    assert not any(entry[1].endswith("/estimates/E1") for entry in seen)
    assert any(entry[1].endswith("/estimates/E2") for entry in seen)


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


# --- Round-1 review fixes (I1-I5) -------------------------------------------


@pytest.mark.asyncio
async def test_a_rejected_status_push_is_not_retried_every_tick(db_session):
    """I1: Books rejecting a status transition is terminal, exactly like a
    rejected line-item payload, because retrying an identical payload cannot
    help. Without a guard, the next tick's status-only branch would re-GET
    (fine) and then re-POST the exact same rejected, non-idempotent mutation
    against a real customer estimate — every 60s, forever. The second tick
    below proves the push is skipped, not the read: zero POSTs, but the GET
    still happens.

    Round 4: the rejection is recorded as quote_status_block = 'rejected'
    rather than as a parseable sentence in quote_sync_error, and no longer
    drags quote_sync_state to 'error' — that flip was what made a single
    rejection unrepairable in round 1 (see N1 below)."""
    project = await _project_with_quote(db_session, impression_cost=1000)
    project.quote_status = "accepted"
    project.quote_sync_state = "idle"
    await db_session.commit()
    await _configure_zoho(db_session)

    def handler(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        if request.method == "GET" and request.url.path.endswith("/estimates/E1"):
            return httpx.Response(200, json={"estimate": {"estimate_id": "E1", "status": "draft"}})
        if request.method == "POST" and request.url.path.endswith("/status/sent"):
            return httpx.Response(200, json={"message": "ok"})
        if request.method == "POST" and request.url.path.endswith("/status/accepted"):
            return httpx.Response(400, json={"message": "Books will not accept this estimate directly"})
        return httpx.Response(404, json={"message": "no route"})

    seen: list = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        if "oauth" not in request.url.path:
            seen.append((request.method, request.url.path))
        return handler(request)

    zoho_service.transport = httpx.MockTransport(wrapped)
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_status_block == "rejected"
    assert project.quote_status_remote == "draft"

    seen.clear()
    assert await run_sync_once(db_session) == 1
    assert not any(method == "POST" for method, _ in seen)
    assert any(method == "GET" for method, _ in seen)
    await db_session.refresh(project)
    assert project.quote_status_block == "rejected"


@pytest.mark.asyncio
async def test_transient_read_failures_do_not_permanently_strand_a_healthy_project(db_session):
    """I2: quote_sync_failures used to be monotonic on the sweep path — a run
    of transient outages during the status-only GET could tip an otherwise
    healthy, already-agreeing project over SYNC_FAILURE_LIMIT and leave it in
    'error' forever, with no way back except a user edit. A read that then
    succeeds and finds nothing to reconcile (the two sides already agree)
    must both reset the counter and restore 'idle'."""
    project = await _project_with_quote(db_session, impression_cost=1000)
    project.quote_status = "accepted"
    project.quote_sync_state = "idle"
    await db_session.commit()
    await _configure_zoho(db_session)

    def failing(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(503, json={"message": "down"})

    zoho_service.transport = httpx.MockTransport(failing)
    zoho_service.invalidate_token()

    for _ in range(SYNC_FAILURE_LIMIT - 1):
        await run_sync_once(db_session)
        await db_session.refresh(project)
        assert project.quote_sync_state == "idle"
    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    assert project.quote_sync_failures == SYNC_FAILURE_LIMIT

    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "accepted"}}})
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "idle"
    assert project.quote_sync_failures == 0
    assert project.quote_sync_error is None


@pytest.mark.asyncio
async def test_an_unrelated_error_diagnostic_survives_a_status_pull(db_session):
    """I3: reachable today — a project in 'error' for a reason the status
    reconciler has no visibility into (here, _update_quote's "no priced
    service left" guard) still gets swept for its STATUS, since only
    'pending', 'unmanaged' and 'locked' are excluded from the sweep. Its
    quote_status is unset, so any real status Books returns differs from
    local and the undecided/pull branch fires — that must still adopt the
    status (nothing here contradicts it) without erasing the only
    diagnostic the user has for the actual, still-live problem."""
    project = await _project_with_quote(db_session)  # no cost fields -> nothing priced
    await _configure_zoho(db_session)
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
            }
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    original_message = project.quote_sync_error
    assert original_message

    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "viewed"}}})
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_status == "viewed"
    assert project.quote_sync_state == "error"
    assert project.quote_sync_error == original_message


@pytest.mark.asyncio
async def test_a_resolved_conflict_is_cleared_once_both_sides_agree(db_session):
    """I4b: a recorded conflict must not persist forever once a human resolves
    it — a since-fixed Books status that now matches ours must clear the
    record, not leave it behind as a permanent, now-false ghost that
    misdescribes a project that is actually fine again.

    Round 4: the record is the quote_status_block/quote_status_remote pair,
    and clearing it is now unconditional — no "is this error mine?" guard,
    because these columns are the reconciler's own and there is nothing of
    anyone else's to destroy."""
    project = await _project_with_quote(db_session, impression_cost=1000)
    project.quote_status = "accepted"
    project.quote_sync_state = "idle"
    await db_session.commit()
    await _configure_zoho(db_session)

    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "declined"}}})
    )
    zoho_service.invalidate_token()
    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_status_block == "conflict"
    assert project.quote_status_remote == "declined"

    # The human resolves it in Books, bringing its status back to match ours.
    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "accepted"}}})
    )
    zoho_service.invalidate_token()
    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_status_block is None
    assert project.quote_status_remote is None
    assert project.quote_sync_state == "idle"
    assert project.quote_sync_error is None


@pytest.mark.asyncio
async def test_the_sweep_locks_a_quote_invoiced_since_the_last_sync(db_session):
    """I5: 'locked' was previously excluded from the sweep by REMEMBERED
    quote_sync_state alone — an estimate invoiced in Books since the last
    successful sync would still read whatever state it last settled into
    (here 'idle') and get a decided status POSTed onto a live transaction,
    exactly the write run_sync_once's own exclusion comment calls "no safer
    than a line-item write". The status-only branch must re-check
    is_transaction_created / invoiced_amount on the estimate it already
    fetched (no extra API call) and refuse to push."""
    project = await _project_with_quote(db_session, impression_cost=1000)
    project.quote_status = "accepted"
    project.quote_sync_state = "idle"
    await db_session.commit()
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "draft",
                        "is_transaction_created": True,
                        "invoiced_amount": 8500,
                    }
                },
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "locked"
    # Task 10: this is the sweep's own lock branch (sync_project), not
    # _update_quote's — the two are separate call sites and each must stamp
    # the flag independently, or a future refactor could silently drop it
    # from just this one.
    assert project.quote_invoiced is True
    assert not any(entry[0] == "POST" for entry in seen)
    assert not any(entry[0] == "PUT" for entry in seen)
    # N3: the estimate's "draft" must NOT silently replace the board's own
    # "accepted" decision — that overwrite (and the board-column move it
    # would then feed into via _apply_rules) is exactly what this branch
    # must never do, unlike _update_quote's one-shot pending-path lock.
    assert project.quote_status == "accepted"


@pytest.mark.asyncio
async def test_the_sweep_lock_branch_does_not_clear_an_unrelated_error(db_session):
    """N3, second half: the lock branch used to also clear quote_sync_error
    unconditionally, for the same reason the status adoption above was
    dropped — discovering an invoice is not evidence that whatever ELSE this
    project's quote_sync_error was recording is now resolved."""
    project = await _project_with_quote(db_session, impression_cost=1000)
    project.quote_status = "accepted"
    project.quote_sync_state = "error"
    project.quote_sync_error = "Project has no priced service left; nothing was written to the quote"
    await db_session.commit()
    await _configure_zoho(db_session)

    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "draft",
                        "is_transaction_created": True,
                        "invoiced_amount": 8500,
                    }
                },
            }
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "locked"
    assert project.quote_sync_error == "Project has no priced service left; nothing was written to the quote"


# --- Round-2 review fixes (N1, N2, N3) --------------------------------------


@pytest.mark.asyncio
async def test_a_status_change_in_books_unblocks_a_previously_rejected_push(db_session):
    """N1: the round-1 fix keyed the "don't retry a rejected push" guard off
    quote_sync_state alone, which — since the equality branch is the ONLY
    place that ever clears an 'error' set here, and it only fires when the
    two sides already match — meant a rejected push could never be retried
    by this worker again, ever, for any reason: not a Books outage that
    happened to coincide, not a human resolving the conflict to something
    OTHER than our exact status. That is precisely the population this task
    exists to repair (five accepted-vs-draft projects) becoming
    unrepairable after one contiguous rejection. The fix keys off the
    recorded attempt instead: once Books' status changes to anything other
    than the one that was rejected, the next tick attempts the push again —
    proven here by a status change from 'draft' (rejected) to 'sent' (not yet
    attempted), which this time succeeds.

    Round 4: that recorded attempt is quote_status_remote, a stored fact,
    rather than an (ours, theirs) pair re-parsed out of a prose message. Our
    side needs no recording at all, because set_quote_status clears the whole
    record whenever the board's status moves."""
    project = await _project_with_quote(db_session, impression_cost=1000)
    project.quote_status = "accepted"
    project.quote_sync_state = "idle"
    await db_session.commit()
    await _configure_zoho(db_session)

    def rejecting(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        if request.method == "GET" and request.url.path.endswith("/estimates/E1"):
            return httpx.Response(200, json={"estimate": {"estimate_id": "E1", "status": "draft"}})
        if request.method == "POST" and request.url.path.endswith("/status/sent"):
            return httpx.Response(200, json={"message": "ok"})
        if request.method == "POST" and request.url.path.endswith("/status/accepted"):
            return httpx.Response(400, json={"message": "Books will not accept this estimate directly"})
        return httpx.Response(404, json={"message": "no route"})

    zoho_service.transport = httpx.MockTransport(rejecting)
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_status_block == "rejected"
    assert project.quote_status_remote == "draft"

    # Books' status moves on (a human, or the client, changed it) — no
    # longer the attempt that was rejected. accepted-from-sent needs no
    # sent-first hop, so a single POST /status/accepted is expected.
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "sent"}},
                ("POST", "/status/accepted"): {"message": "ok"},
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert any(entry[0] == "POST" and entry[1].endswith("/status/accepted") for entry in seen)
    assert project.quote_status_block is None
    assert project.quote_status_remote is None
    assert project.quote_sync_state == "idle"
    assert project.quote_sync_error is None


@pytest.mark.asyncio
async def test_an_unrelated_error_survives_even_when_status_already_agreed(db_session):
    """N2: the round-1 immunity argument ("local is None, so equality can
    never fire") only covers a project that never synced. The common,
    reachable shape is a project that HAS synced before — quote_status
    pulled from Books and still equal to it, a real value like 'sent', not
    None — and then loses its priced service via an unrelated edit:
    _update_quote's guard sets 'error' with a real diagnostic but never
    touches quote_status, which is still exactly what Books itself last
    reported. The very next sweep tick's GET returns that same, unmoved
    status, landing on the TRUE-equality branch — which must not read
    "nothing changed" as "nothing is wrong"."""
    project = await _project_with_quote(db_session, impression_cost=1000)
    await _configure_zoho(db_session)

    # First tick: an ordinary successful push, landing 'idle' with a real,
    # non-None quote_status pulled straight from Books.
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
                ("PUT", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "sent", "total": 1000}},
            }
        )
    )
    zoho_service.invalidate_token()
    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "idle"
    assert project.quote_status == "sent"

    # The user clears the only task's priced service; an edit elsewhere
    # would re-mark the project pending exactly like this.
    task_row = (await db_session.execute(select(AitoTask).where(AitoTask.project_id == project.id))).scalar_one()
    task_row.impression_cost = None
    project.quote_sync_state = "pending"
    await db_session.commit()

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
            }
        )
    )
    zoho_service.invalidate_token()
    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    original_message = project.quote_sync_error
    assert original_message
    assert project.quote_status == "sent"
    assert project.quote_sync_failures == 0

    # Next sweep tick: Books still reads "sent", completely unchanged — the
    # true-equality branch fires, and must not treat that as proof the error
    # is resolved.
    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "sent"}}})
    )
    zoho_service.invalidate_token()
    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    assert project.quote_sync_error == original_message


# --- Round-3 review fix (N4) -------------------------------------------------


@pytest.mark.asyncio
async def test_a_rejected_push_does_not_overwrite_an_unrelated_diagnostic(db_session):
    """N4: the ZohoRequestRejected handler used to overwrite quote_sync_error
    unconditionally, even when the project was ALREADY in 'error' for an
    unrelated reason (no priced service). That both destroyed the only
    record of the real problem AND manufactured false evidence for the
    equality branch, which read that same field back: a later tick would see a
    message carrying this module's own rejection wording, conclude the error
    was its own doing, and wrongly restore 'idle' — leaving the card reading
    as in-sync while Books still holds the stale, broken lines, with no error
    badge and no Retry button to fix it (both gated on the error state).

    Round 4 removes the whole class: this module no longer writes or reads
    quote_sync_error at all, so there is nothing to overwrite and no message
    to misread.

    Sequence: an unrelated no-priced-service error lands first (quote_status
    stays a real DECIDED value, "accepted", since that guard never touches
    it) -> a sweep tick's push is rejected -> the ORIGINAL message must
    survive, not the rejection -> Books is then edited to match ours -> the
    equality branch must leave that still-unrelated message (and its 'error'
    state) exactly as it found them."""
    project = await _project_with_quote(db_session)  # no cost fields -> nothing priced
    project.quote_status = "accepted"
    project.quote_sync_state = "pending"
    await db_session.commit()
    await _configure_zoho(db_session)

    # Tick 1: the pending path hits the no-priced-service guard. quote_status
    # is left untouched at "accepted" — a real, decided value, not None.
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
            }
        )
    )
    zoho_service.invalidate_token()
    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    original_message = project.quote_sync_error
    assert original_message
    assert "priced service" in original_message
    assert project.quote_status == "accepted"

    # Tick 2: the sweep's pair guard does not match (no rejection recorded
    # yet), so the push is attempted — sent-first, then accepted — and Books
    # rejects it. The original, unrelated message must survive verbatim.
    def rejecting(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        if request.method == "GET" and request.url.path.endswith("/estimates/E1"):
            return httpx.Response(200, json={"estimate": {"estimate_id": "E1", "status": "draft"}})
        if request.method == "POST" and request.url.path.endswith("/status/sent"):
            return httpx.Response(200, json={"message": "ok"})
        if request.method == "POST" and request.url.path.endswith("/status/accepted"):
            return httpx.Response(400, json={"message": "Books will not accept this estimate directly"})
        return httpx.Response(404, json={"message": "no route"})

    zoho_service.transport = httpx.MockTransport(rejecting)
    zoho_service.invalidate_token()
    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    assert project.quote_sync_error == original_message
    # Round 4: the rejection is not lost either — it lands in the reconciler's
    # own columns, where recording it destroys nothing. Under the old design
    # this branch had to return without recording anything at all to protect
    # the unrelated message, which is what made a rejected push repeat forever.
    assert project.quote_status_block == "rejected"
    assert project.quote_status_remote == "draft"

    # Tick 3: a human accepts in Books, matching the board's decision. The
    # equality branch must not mistake the surviving, unrelated message for
    # evidence this reconciler owns the error.
    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "accepted"}}})
    )
    zoho_service.invalidate_token()
    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    assert project.quote_sync_error == original_message


# --- Round-4: the reconciler records facts, not prose -------------------------


@pytest.mark.asyncio
async def test_a_rejected_push_is_recorded_as_a_fact_not_a_message(db_session):
    """The block is a stored fact. quote_sync_error belongs to another
    subsystem and the reconciler must not touch it."""
    project = await _project_with_quote(db_session, impression_cost=1000)
    project.quote_status = "accepted"
    project.quote_sync_state = "idle"
    project.quote_sync_error = "a message this reconciler does not own"
    await db_session.commit()
    await _configure_zoho(db_session)

    def rejecting(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        if request.method == "GET" and request.url.path.endswith("/estimates/E1"):
            return httpx.Response(200, json={"estimate": {"estimate_id": "E1", "status": "draft"}})
        if request.method == "POST" and request.url.path.endswith("/status/sent"):
            return httpx.Response(200, json={"message": "ok"})
        if request.method == "POST" and request.url.path.endswith("/status/accepted"):
            return httpx.Response(400, json={"message": "Books will not accept this estimate directly"})
        return httpx.Response(404, json={"message": "no route"})

    zoho_service.transport = httpx.MockTransport(rejecting)
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_status_block == "rejected"
    assert project.quote_status_remote == "draft"
    assert project.quote_sync_error == "a message this reconciler does not own"


@pytest.mark.asyncio
async def test_a_recorded_rejection_suppresses_only_the_identical_attempt(db_session):
    """Bounded retry: the same attempt is not repeated, but a Books-side move
    unblocks it on the next tick."""
    project = await _project_with_quote(db_session, impression_cost=1000)
    project.quote_status = "accepted"
    project.quote_sync_state = "idle"
    await db_session.commit()
    await _configure_zoho(db_session)

    def rejecting(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        if request.method == "GET" and request.url.path.endswith("/estimates/E1"):
            return httpx.Response(200, json={"estimate": {"estimate_id": "E1", "status": "draft"}})
        if request.method == "POST" and request.url.path.endswith("/status/sent"):
            return httpx.Response(200, json={"message": "ok"})
        if request.method == "POST" and request.url.path.endswith("/status/accepted"):
            return httpx.Response(400, json={"message": "Books will not accept this estimate directly"})
        return httpx.Response(404, json={"message": "no route"})

    zoho_service.transport = httpx.MockTransport(rejecting)
    zoho_service.invalidate_token()

    # Tick 1: rejected, and the block is recorded against Books' 'draft'.
    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_status_block == "rejected"
    assert project.quote_status_remote == "draft"

    # Tick 2: Books has not moved, so the identical attempt is not repeated.
    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "draft"}}}, seen)
    )
    zoho_service.invalidate_token()
    assert await run_sync_once(db_session) == 1
    assert not any(entry[0] == "POST" for entry in seen)
    assert any(entry[0] == "GET" for entry in seen)
    await db_session.refresh(project)
    assert project.quote_status_block == "rejected"

    # Tick 3: Books moved to 'sent', so this is no longer the attempt that
    # failed and the push is made again — this time it succeeds.
    seen.clear()
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "sent"}},
                ("POST", "/status/accepted"): {"message": "ok"},
            },
            seen,
        )
    )
    zoho_service.invalidate_token()
    assert await run_sync_once(db_session) == 1
    assert any(entry[0] == "POST" and entry[1].endswith("/status/accepted") for entry in seen)
    await db_session.refresh(project)
    assert project.quote_status_block is None
    assert project.quote_status_remote is None


@pytest.mark.asyncio
async def test_an_unrelated_error_survives_and_never_blocks_the_push(db_session):
    """The case that produced findings I3, N2 and N4. An error owned by the
    line-item path is not evidence about status, in either direction."""
    project = await _project_with_quote(db_session, impression_cost=1000)
    project.quote_status = "accepted"
    project.quote_sync_state = "error"
    project.quote_sync_error = "Project has no priced service left; nothing was written to the quote"
    await db_session.commit()
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "draft"}},
                ("POST", "/status/sent"): {"message": "ok"},
                ("POST", "/status/accepted"): {"message": "ok"},
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert [entry[1] for entry in seen if entry[0] == "POST"][-1].endswith("/status/accepted")
    assert project.quote_sync_error == "Project has no priced service left; nothing was written to the quote"
    assert project.quote_sync_state == "error"
    assert project.quote_status_block is None
    assert project.quote_status_remote is None


@pytest.mark.asyncio
async def test_a_conflict_is_recorded_and_clears_when_books_agrees(db_session):
    """Both sides decided and differ -> neither wins, and the record clears
    itself once a human resolves it."""
    project = await _project_with_quote(db_session, impression_cost=1000)
    project.quote_status = "accepted"
    project.quote_sync_state = "idle"
    await db_session.commit()
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "declined"}}}, seen)
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert not any(entry[0] == "POST" for entry in seen)
    assert project.quote_status_block == "conflict"
    assert project.quote_status_remote == "declined"
    assert project.quote_status == "accepted"

    # A human resolves it in Books.
    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "accepted"}}})
    )
    zoho_service.invalidate_token()
    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_status_block is None
    assert project.quote_status_remote is None


@pytest.mark.asyncio
async def test_a_different_terminal_error_is_not_erased_by_the_outage_recovery(db_session):
    """Fix-round 1, Important 1: the sweep path's I2 recovery reads
    `quote_sync_failures >= SYNC_FAILURE_LIMIT` as proof that an 'error' is
    the ZohoUpstreamError escalation and nothing else. That is only true while
    every OTHER path that sets 'error' resets the counter — which four of
    sync_project's exception handlers did not.

    The hole: a project escalated by an outage run (failures == 5) that then
    hits a terminal error of a different kind lands a new, unrelated
    diagnostic with the counter still at 5, and the next successful read
    erases it and reports the card as in sync while the real fault stands.
    """
    project = await _project_with_quote(db_session, impression_cost=1000)
    project.quote_status = "accepted"
    project.quote_sync_state = "idle"
    await db_session.commit()
    await _configure_zoho(db_session)

    def failing(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(503, json={"message": "down"})

    zoho_service.transport = httpx.MockTransport(failing)
    zoho_service.invalidate_token()
    for _ in range(SYNC_FAILURE_LIMIT):
        await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    assert project.quote_sync_failures == SYNC_FAILURE_LIMIT

    # A terminal error of a DIFFERENT kind: the estimate is gone from Books.
    def gone(request: httpx.Request) -> httpx.Response:
        if "oauth" in request.url.path:
            return httpx.Response(200, json={"access_token": "t", "expires_in": 3600})
        return httpx.Response(404, json={"message": "not found"})

    zoho_service.transport = httpx.MockTransport(gone)
    zoho_service.invalidate_token()
    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    assert project.quote_sync_error == "The quote no longer exists in Zoho Books"
    # The handler must not leave this project wearing the outage's count.
    assert project.quote_sync_failures == 0

    # The quote reappears (restored in Books, or the 404 was transient) and
    # the read succeeds with both sides agreeing. The recovery must not read
    # this as "the outage passed" and erase a message it never wrote.
    zoho_service.transport = httpx.MockTransport(
        zoho_handler({("GET", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "accepted"}}})
    )
    zoho_service.invalidate_token()
    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    assert project.quote_sync_error == "The quote no longer exists in Zoho Books"


@pytest.mark.asyncio
async def test_an_invoiced_quote_does_not_keep_a_block_it_can_never_clear(db_session):
    """Fix-round 1, Minor 3: 'locked' leaves the sweep permanently, so a block
    recorded before the estimate was invoiced would render beside "Quote
    invoiced" forever, describing a push this module will never attempt
    again."""
    project = await _project_with_quote(db_session, impression_cost=1000)
    project.quote_status = "accepted"
    project.quote_sync_state = "idle"
    project.quote_status_block = "rejected"
    project.quote_status_remote = "draft"
    await db_session.commit()
    await _configure_zoho(db_session)

    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "draft",
                        "is_transaction_created": True,
                        "invoiced_amount": 8500,
                    }
                },
            }
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "locked"
    assert project.quote_status_block is None
    assert project.quote_status_remote is None


@pytest.mark.asyncio
async def test_adopting_books_status_on_a_push_clears_a_recorded_block(db_session):
    """Fix-round 1, Minor 2: _apply_estimate writes quote_status too, so it
    clears the block like every other writer. The model's invariant — a block
    always describes an attempt made from the CURRENT quote_status — is true
    by construction rather than by an argument about what values these sites
    happen to write."""
    project = await _project_with_quote(db_session, impression_cost=1000)
    project.quote_status_block = "conflict"
    project.quote_status_remote = "declined"
    await db_session.commit()
    await _configure_zoho(db_session)

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
                ("PUT", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "sent", "total": 1000}},
            }
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_status == "sent"
    assert project.quote_status_block is None
    assert project.quote_status_remote is None


@pytest.mark.asyncio
async def test_adopting_books_acceptance_stamps_quote_accepted_at(db_session):
    """The swept reconciler noticing a client acceptance stamps the same
    timestamp as the panel's Accept button would."""
    project = await _project_with_quote(db_session, scan_cost=1)
    await _configure_zoho(db_session)
    project.quote_status = "sent"
    project.quote_sync_state = "idle"
    await db_session.commit()
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "accepted",
                        "is_transaction_created": False,
                        "invoiced_amount": 0,
                        "is_inclusive_tax": True,
                        "line_items": [],
                    }
                },
                ("PUT", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "accepted", "total": 1}},
            }
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_status == "accepted"
    assert project.quote_accepted_at is not None


@pytest.mark.asyncio
async def test_adopting_a_non_acceptance_does_not_stamp(db_session):
    """Regression guard: swept reconciler adopting a non-decided status
    never stamps quote_accepted_at."""
    project = await _project_with_quote(db_session, scan_cost=1)
    await _configure_zoho(db_session)
    project.quote_status = "sent"
    project.quote_sync_state = "idle"
    await db_session.commit()
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "viewed",
                        "is_transaction_created": False,
                        "invoiced_amount": 0,
                        "is_inclusive_tax": True,
                        "line_items": [],
                    }
                },
                ("PUT", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "viewed", "total": 1}},
            }
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_status == "viewed"
    assert project.quote_accepted_at is None


@pytest.mark.asyncio
async def test_a_locked_quotes_adopted_acceptance_still_stamps(db_session):
    """An invoiced estimate takes the locked branch, which adopts Books'
    status without the reconciler — the acceptance is still news."""
    project = await _project_with_quote(db_session, scan_cost=1)
    await _configure_zoho(db_session)
    project.quote_status = "sent"
    await db_session.commit()
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "accepted",
                        "is_transaction_created": True,
                        "invoiced_amount": 1,
                        "is_inclusive_tax": True,
                        "line_items": [],
                    }
                },
            }
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "locked"
    assert project.quote_status == "accepted"
    assert project.quote_accepted_at is not None


@pytest.mark.asyncio
async def test_restore_from_trash_does_not_restamp_the_acceptance(db_session):
    """Mirror of test_restoring_reapplies_the_snapshotted_status: the restore
    returns the pre-trash 'accepted', but the job was accepted long ago —
    the old stamp must survive, not reset the card's clock to today."""
    old = datetime(2020, 3, 15, 8, 30, 0)
    project = await _project_with_quote(db_session, scan_cost=1)
    await _configure_zoho(db_session)
    project.quote_status = "declined"
    project.quote_status_before_trash = "accepted"
    project.quote_accepted_at = old
    await db_session.commit()
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
            }
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_status == "accepted"
    assert project.quote_accepted_at == old


@pytest.mark.asyncio
async def test_a_push_discovered_acceptance_stamps_quote_accepted_at(db_session):
    """A task-edit push discovers that Books reports 'accepted' — the pending
    path's _apply_estimate adoption (which reconcile_quote_status never sees)
    must also stamp the timestamp."""
    project = await _project_with_quote(db_session, scan_cost=1)
    await _configure_zoho(db_session)
    project.quote_status = "sent"
    await db_session.commit()
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/estimates/E1"): {
                    "estimate": {
                        "estimate_id": "E1",
                        "status": "accepted",
                        "is_transaction_created": False,
                        "invoiced_amount": 0,
                        "is_inclusive_tax": True,
                        "line_items": [],
                    }
                },
                ("PUT", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "accepted", "total": 1}},
            }
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_status == "accepted"
    assert project.quote_accepted_at is not None


# --- Task 5: push the shipping line ----------------------------------------


def _shipped_project():
    return AitoProject(
        id=1,
        description="ship it",
        board_column="devis",
        position=0,
        shipping_island="rangiroa",
        shipping_service="tuamotu",
        shipping_first_name="Jean-Pierre",
        shipping_last_name="DUPONT",
        shipping_phone="+689-89645864",
        shipping_price=3200.0,
    )


def test_load_export_shipping_returns_none_without_an_island():
    project = AitoProject(id=1, description="x", board_column="devis", position=0)
    assert load_export_shipping(project, Catalogue("S", "M", "I", "U", "T", {"tuamotu": "SHIP"})) is None


def test_load_export_shipping_resolves_the_island_label():
    shipping = load_export_shipping(_shipped_project(), Catalogue("S", "M", "I", "U", "T", {"tuamotu": "SHIP"}))
    assert shipping.island_label == "Rangiroa"
    assert shipping.service == "tuamotu"
    assert shipping.price == 3200.0


def test_load_export_shipping_refuses_an_unresolved_catalogue():
    with pytest.raises(ShippingCatalogueUnavailable):
        load_export_shipping(_shipped_project(), Catalogue("S", "M", "I", "U", "T", {}))


def test_load_export_shipping_falls_back_to_the_raw_key_when_the_island_table_forgot_it():
    """A table edit is not a reason to stop billing a job already in flight:
    an island key no longer present in the lookup must still export, using
    the stored key itself as the label."""
    project = _shipped_project()
    project.shipping_island = "no-longer-in-the-table"
    shipping = load_export_shipping(project, Catalogue("S", "M", "I", "U", "T", {"tuamotu": "SHIP"}))
    assert shipping.island_label == "no-longer-in-the-table"


async def _project_with_shipping_and_a_priced_task(db_session) -> AitoProject:
    project = AitoProject(
        description="Hélice",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client de passage",
        quote_sync_state="pending",
        shipping_island="rangiroa",
        shipping_service="tuamotu",
        shipping_first_name="Jean-Pierre",
        shipping_last_name="DUPONT",
        shipping_phone="+689-89645864",
        shipping_price=3200.0,
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Hélice grise", scan_cost=5000))
    await db_session.commit()
    return project


@pytest.mark.asyncio
async def test_a_project_with_an_unresolvable_service_stays_pending_and_pushes_nothing(db_session):
    """Silence beats a wrong quote. A quote written without its shipping line
    is one a client can be sent."""
    project = await _project_with_shipping_and_a_priced_task(db_session)
    await _configure_zoho(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(
        zoho_handler(
            {
                ("GET", "/items"): {"items": []},
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "pending"
    assert (project.quote_sync_failures or 0) == 0
    assert not any(method in ("POST", "PUT") for method, _, _ in seen), "no create/update call should have reached Zoho"
    # A deferral leaves no trace on the row: quote_sync_error belongs to the
    # line-item sync path (see AitoProject.quote_status_block's comment on
    # why recording another subsystem's state there is a defect, not a
    # convenience), so it must stay exactly as it was before this handler ran.
    assert project.quote_sync_error is None


@pytest.mark.asyncio
async def test_an_unresolvable_shipping_service_warms_the_catalogue_cache_for_the_next_tick(db_session, monkeypatch):
    """Requirement A: ``get_catalogue`` always reads the shipping cache with
    ``refresh=False``, so nothing else in this worker would ever warm it, and
    the drawer endpoint that will eventually warm it on the happy path does
    not exist yet — today this deferral handler is the SOLE warmer. The
    deferral path must itself call ``get_shipping_catalogue(refresh=True)``,
    or a project that gained shipping without going through that future
    drawer flow (an importer path, a wiped settings row, first boot with
    Books down) would have no self-healing route back to a warm cache."""
    await _project_with_shipping_and_a_priced_task(db_session)
    await _configure_zoho(db_session)

    calls: list = []
    real_get_shipping_catalogue = zoho_service.get_shipping_catalogue

    async def tracking_get_shipping_catalogue(db, *, refresh):
        # `refresh` has no default here on purpose: the point of this test is
        # to pin the LITERAL argument the deferral path passes. A default of
        # True would make the assertion below pass even if the
        # implementation started calling this with no `refresh` kwarg at all.
        calls.append(refresh)
        return await real_get_shipping_catalogue(db, refresh=refresh)

    monkeypatch.setattr(zoho_service, "get_shipping_catalogue", tracking_get_shipping_catalogue)
    zoho_service.transport = httpx.MockTransport(zoho_handler({("GET", "/items"): {"items": []}}))
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    assert True in calls, "the deferral must warm the cache with refresh=True before giving up for this tick"


@pytest.mark.asyncio
async def test_a_deferral_logs_once_then_stays_silent_for_the_same_reason(db_session, monkeypatch):
    """The suppression is process-local (see ``_deferred_reasons``' own
    comment for why it is deliberately NOT a column on the project). Two
    consecutive ticks that defer for the SAME reason must log exactly once."""
    from backend.app.services import aito_quote_sync

    project = await _project_with_shipping_and_a_priced_task(db_session)
    await _configure_zoho(db_session)

    calls: list = []
    monkeypatch.setattr(aito_quote_sync.logger, "warning", lambda *args, **kwargs: calls.append(args))

    zoho_service.transport = httpx.MockTransport(zoho_handler({("GET", "/items"): {"items": []}}))
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await run_sync_once(db_session)

    deferred_calls = [c for c in calls if c and c[0] == "Aito project %s deferred: %s"]
    assert len(deferred_calls) == 1, "the second tick's identical deferral must not log again"
    assert project.id in aito_quote_sync._deferred_reasons


@pytest.mark.asyncio
async def test_a_deferred_reason_is_cleared_once_the_project_syncs_successfully(db_session):
    """Once resolved, the process-local suppression entry must not linger: a
    project that recovers and later defers again for some new reason (a
    later catalogue change, say) must log afresh rather than staying
    silently suppressed by a stale entry from before whatever changed."""
    from backend.app.services import aito_quote_sync

    project = await _project_with_shipping_and_a_priced_task(db_session)
    await _configure_zoho(db_session)

    # Tick 1: catalogue unresolved -> defers, records a suppression entry.
    zoho_service.transport = httpx.MockTransport(zoho_handler({("GET", "/items"): {"items": []}}))
    zoho_service.invalidate_token()
    await run_sync_once(db_session)
    assert project.id in aito_quote_sync._deferred_reasons

    # Tick 2: catalogue is now warm (seeded directly -- no drawer endpoint
    # exists yet), so the push succeeds this time.
    await _seed_warm_shipping_catalogue(db_session)
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
                        "total": 8200,
                        "last_modified_time": "2026-07-29T10:00:00-1000",
                        "is_inclusive_tax": True,
                    }
                },
            }
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    await db_session.refresh(project)
    assert project.quote_sync_state == "idle"
    assert project.id not in aito_quote_sync._deferred_reasons


async def _seed_warm_shipping_catalogue(db, service: str = "tuamotu", item_id: str = "SHIP-TUAMOTU") -> None:
    """Writes a resolved shipping catalogue directly into settings, the same
    shape ``zoho.get_shipping_catalogue`` itself produces, so a test can
    exercise a project whose shipping IS resolvable without spending a real
    ``/items`` network call to get there."""
    catalogue = {service: {"item_id": item_id, "name": SERVICE_LABELS[service], "rate": 3200.0}}
    await set_setting(db, "zoho_shipping_catalogue", json.dumps(catalogue))
    await set_setting(db, "zoho_shipping_catalogue_at", datetime.utcnow().isoformat())
    await db.commit()


@pytest.mark.asyncio
async def test_create_with_shipping_but_no_priced_task_still_becomes_a_terminal_error(db_session):
    """CRITICAL: shipping alone must never make a project quotable.
    ``build_line_items`` appends the shipping line unconditionally, so gating
    the no-priced-service guard on the BUILT ``line_items`` array (rather
    than on task content) would let a project with zero priced tasks but
    shipping attached slip past it and POST a shipping-only estimate."""
    project = AitoProject(
        description="Rien a imprimer",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_sync_state="pending",
        shipping_island="rangiroa",
        shipping_service="tuamotu",
        shipping_first_name="Jean-Pierre",
        shipping_last_name="DUPONT",
        shipping_phone="+689-89645864",
        shipping_price=3200.0,
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Rien"))  # no cost fields set at all
    await db_session.commit()
    await _configure_zoho(db_session)
    await _seed_warm_shipping_catalogue(db_session)

    seen: list = []
    zoho_service.transport = httpx.MockTransport(zoho_handler({}, seen))
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    assert project.quote_sync_error == "Project has no priced service yet"
    assert not any(method == "POST" for method, _, _ in seen)


@pytest.mark.asyncio
async def test_update_with_shipping_but_no_priced_task_does_not_wipe_the_quotes_lines(db_session):
    """CRITICAL, the destructive half: the same guard on the update path.
    Without it, clearing a project's only priced task while shipping stays
    attached would PUT a ``line_items`` array containing ONLY the shipping
    line onto a LIVE quote, deleting every real task line Books had — exactly
    what the pre-existing "no priced service" guard exists to prevent for the
    no-shipping case. This is the one that must be pinned."""
    project = AitoProject(
        description="Rien a imprimer",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_id="E1",
        quote_number="DEV26-9001",
        quote_sync_state="pending",
        shipping_island="rangiroa",
        shipping_service="tuamotu",
        shipping_first_name="Jean-Pierre",
        shipping_last_name="DUPONT",
        shipping_phone="+689-89645864",
        shipping_price=3200.0,
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Rien"))  # no cost fields set at all
    await db_session.commit()
    await _configure_zoho(db_session)
    await _seed_warm_shipping_catalogue(db_session)

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
                        "line_items": [
                            {"line_item_id": "TASK1", "sku": "P3DSCAN", "item_order": 1},
                        ],
                    }
                },
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    await run_sync_once(db_session)
    await db_session.refresh(project)
    assert project.quote_sync_state == "error"
    assert project.quote_sync_error == "Project has no priced service left; nothing was written to the quote"
    assert not any(method == "PUT" for method, _, _ in seen)


@pytest.mark.asyncio
async def test_create_with_a_priced_task_and_shipping_still_pushes_normally(db_session):
    """The guard must not over-fire: a project that genuinely has a priced
    service must still create its quote even though shipping is attached."""
    project = await _project_with_shipping_and_a_priced_task(db_session)
    await _configure_zoho(db_session)
    await _seed_warm_shipping_catalogue(db_session)

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
                        "total": 8200,
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
    assert project.quote_sync_state == "idle"
    assert project.quote_id == "E1"

    post = next(entry for entry in seen if entry[0] == "POST" and entry[1].endswith("/estimates"))
    assert len(post[2]["line_items"]) == 2  # one task line, plus the shipping line


@pytest.mark.asyncio
async def test_update_pushes_the_shipping_line_too_not_only_on_create(db_session):
    """Important 2: shipping must not silently vanish on every push after the
    first. ``_update_quote`` has its own ``build_line_items`` call site and
    needs its own ``shipping=`` argument threaded through, independently of
    ``_create_quote``'s — deleting it there breaks nothing any OTHER test
    catches, because every other shipping integration test here exercises a
    project with no ``quote_id`` (the create path only)."""
    project = AitoProject(
        description="Helice grise",
        board_column="devis",
        position=0,
        client_id="C1",
        client_name="Client",
        quote_id="E1",
        quote_number="DEV26-9001",
        quote_sync_state="pending",
        shipping_island="rangiroa",
        shipping_service="tuamotu",
        shipping_first_name="Jean-Pierre",
        shipping_last_name="DUPONT",
        shipping_phone="+689-89645864",
        shipping_price=3200.0,
    )
    db_session.add(project)
    await db_session.flush()
    db_session.add(AitoTask(project_id=project.id, position=0, title="Helice grise", scan_cost=5000))
    await db_session.commit()
    await _configure_zoho(db_session)
    await _seed_warm_shipping_catalogue(db_session, item_id="SHIP-TUAMOTU")

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
                ("PUT", "/estimates/E1"): {"estimate": {"estimate_id": "E1", "status": "sent", "total": 8200}},
            },
            seen,
        )
    )
    zoho_service.invalidate_token()

    assert await run_sync_once(db_session) == 1
    put = next(entry for entry in seen if entry[0] == "PUT")
    shipping_lines = [line for line in put[2]["line_items"] if line.get("item_id") == "SHIP-TUAMOTU"]
    assert len(shipping_lines) == 1
    assert shipping_lines[0]["rate"] == 3200.0


@pytest.mark.asyncio
async def test_a_resolvable_shipping_service_reaches_books_with_the_right_item_and_description(db_session):
    """Important 3: nothing so far asserted that a RESOLVABLE shipping
    service actually reaches Books correctly — every other shipping
    integration test in this file is about the deferral. Pin the pushed
    line's content."""
    await _project_with_shipping_and_a_priced_task(db_session)
    await _configure_zoho(db_session)
    await _seed_warm_shipping_catalogue(db_session, item_id="SHIP-TUAMOTU")

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
                        "total": 8200,
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
    post = next(entry for entry in seen if entry[0] == "POST" and entry[1].endswith("/estimates"))
    shipping_line = next(line for line in post[2]["line_items"] if line.get("item_id") == "SHIP-TUAMOTU")
    assert shipping_line["rate"] == 3200.0
    assert shipping_line["quantity"] == 1
    assert "Jean-Pierre DUPONT" in shipping_line["description"]
    assert "Rangiroa" in shipping_line["description"]
    assert "header_name" not in shipping_line
