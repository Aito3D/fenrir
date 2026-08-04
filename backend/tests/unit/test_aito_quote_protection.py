"""Route-level guards that decide WHETHER a project is handed to the Zoho sync
worker at all (`_mark_pending` vs. `_mark_pending_if_ours` in
`backend/app/api/routes/aito.py`). These are exercised by calling the route
coroutines directly with a plain `db_session` and `current_user=None` —
bypassing FastAPI's dependency injection and HTTP layer entirely,
so this file has no dependency on auth wiring or the (separately in-flight)
HTTP-level route tests.

No Zoho traffic here: these tests only check the in-memory `quote_sync_state`
transition a request causes, never letting `run_sync_once` see the row.
"""

import pytest
from sqlalchemy import select

from backend.app.api.routes.aito import create_project, delete_project, restore_project, update_project
from backend.app.models.aito_project import AitoProject
from backend.app.schemas.aito import AitoProjectCreate, AitoProjectUpdate, AitoTaskCreate


@pytest.mark.asyncio
async def test_creating_a_project_without_a_quote_id_marks_it_pending(db_session):
    """C1 fix 1, the ordinary case: a genuinely new job has nothing in Books
    yet, so the worker must create its estimate."""
    payload = AitoProjectCreate(
        description="Helice",
        client_id="C1",
        client_name="Client",
        client_phone="+689-87000011",
        tasks=[AitoTaskCreate(title="Helice", scan_cost=5000)],
    )
    response = await create_project(payload=payload, db=db_session, current_user=None)
    assert response.quote_sync_state == "pending"


@pytest.mark.asyncio
async def test_importing_a_project_with_a_quote_id_does_not_mark_it_pending(db_session):
    """C1 fix 1, the bug: the Import flow POSTs through this same endpoint but
    with `quote_id` already set — the imported project's tasks were derived
    FROM that quote, so it is already in sync. Marking it pending would have
    the worker take the UPDATE path within one tick and PUT a
    freshly-regenerated `line_items` array onto a real, untouched customer
    estimate: hand-typed rows deleted, names/SKUs reverted to catalogue
    values, tax forced onto every line. The user's first real edit is what
    should mark this pending, not the import itself."""
    payload = AitoProjectCreate(
        description="Helice importee",
        client_id="C1",
        client_name="Client",
        quote_id="E1",
        quote_number="DEV26-9001",
        tasks=[AitoTaskCreate(title="Helice", scan_cost=5000)],
    )
    response = await create_project(payload=payload, db=db_session, current_user=None)
    assert response.quote_id == "E1"
    assert response.quote_sync_state == "idle"


@pytest.mark.asyncio
async def test_editing_a_legacy_quote_less_project_never_marks_it_pending(db_session):
    """C1b: a card migrated from the old localStorage board is marked
    `quote_sync_state = 'unmanaged'` at import time (and by the one-time
    migration backfill for rows that predate that marker) — an EXPLICIT
    signal, not inferred from being idle with no quote_id. The product
    decision is that such a card is left alone permanently: an edit to its
    description must not cause the worker to POST a brand-new estimate for a
    job that may already have been quoted outside the app."""
    project = AitoProject(
        description="Vieille piece",
        board_column="devis",
        position=0,
        status="active",
        quote_sync_state="unmanaged",
    )
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    response = await update_project(
        project_id=project.id,
        payload=AitoProjectUpdate(description="Vieille piece modifiee"),
        db=db_session,
        current_user=None,
    )
    assert response.description == "Vieille piece modifiee"
    assert response.quote_sync_state == "unmanaged"


@pytest.mark.asyncio
async def test_editing_a_project_of_ours_that_already_has_a_quote_still_marks_it_pending(db_session):
    """C1b's guard must not overcorrect: a project this feature previously
    synced successfully carries a quote_id and is back to 'idle' only because
    the push succeeded — an edit to it is exactly the normal case that must
    still reach the worker."""
    project = AitoProject(
        description="Piece suivie",
        board_column="devis",
        position=0,
        status="active",
        quote_id="E1",
        quote_sync_state="idle",
    )
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    response = await update_project(
        project_id=project.id,
        payload=AitoProjectUpdate(description="Piece suivie modifiee"),
        db=db_session,
        current_user=None,
    )
    assert response.quote_sync_state == "pending"


@pytest.mark.asyncio
async def test_editing_a_project_whose_first_creation_failed_still_retries(db_session):
    """C1b's guard must not swallow a project that IS ours but has never
    reached 'idle' — a project whose first creation attempt errored out stays
    'error' (never drops back to 'idle'), so it must still be re-marked
    pending on the next edit rather than getting stuck forever."""
    project = AitoProject(
        description="Piece en echec",
        board_column="devis",
        position=0,
        status="active",
        quote_sync_state="error",
        quote_sync_error="Invalid customer_id",
    )
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    response = await update_project(
        project_id=project.id,
        payload=AitoProjectUpdate(description="Piece en echec modifiee"),
        db=db_session,
        current_user=None,
    )
    assert response.quote_sync_state == "pending"


@pytest.mark.asyncio
async def test_deleting_a_legacy_quote_less_project_never_marks_it_pending(db_session):
    """C1b applies to every content handler, not just update_project — a
    legacy card sent to the trash must not suddenly acquire a quote either."""
    project = AitoProject(
        description="Vieille piece",
        board_column="devis",
        position=0,
        status="active",
        quote_sync_state="unmanaged",
    )
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    await delete_project(project_id=project.id, db=db_session, current_user=None)
    await db_session.refresh(project)
    assert project.status == "deleted"
    assert project.quote_sync_state == "unmanaged"


@pytest.mark.asyncio
async def test_restoring_a_legacy_quote_less_project_never_marks_it_pending(db_session):
    project = AitoProject(
        description="Vieille piece",
        board_column="devis",
        position=0,
        status="deleted",
        quote_sync_state="unmanaged",
    )
    db_session.add(project)
    await db_session.commit()
    await db_session.refresh(project)

    response = await restore_project(project_id=project.id, db=db_session, current_user=None)
    assert response.column == "devis"
    assert response.quote_sync_state == "unmanaged"


@pytest.mark.asyncio
async def test_trashing_before_first_quote_then_restoring_and_editing_is_re_enqueued(db_session):
    """Critical 1, the actual bug: a project this feature created (not a
    legacy import) gets trashed before its first sync tick ever runs. The
    worker's quote-less-deleted branch (aito_quote_sync.sync_project) then
    sets `quote_sync_state = 'idle'` to drop it out of the pending queue.
    Under the OLD guard (`quote_id is not None or quote_sync_state !=
    'idle'`), that made this project byte-identical to a legacy card and
    permanently unquotable on restore — silently, with no error and no UI
    signal. The fixed guard checks only for the EXPLICIT 'unmanaged' marker,
    which this project never carries, so restoring (and any later edit)
    re-enqueues it normally.

    Exercises the worker's own branch directly (monkeypatched onto the
    project) rather than a real Zoho round-trip — this file's whole point is
    testing the route-level guard in isolation from the sync worker/HTTP
    layer (see the module docstring)."""
    payload = AitoProjectCreate(
        description="Helice",
        client_id="C1",
        client_name="Client",
        client_phone="+689-87000012",
        tasks=[AitoTaskCreate(title="Helice", scan_cost=5000)],
    )
    created = await create_project(payload=payload, db=db_session, current_user=None)
    assert created.quote_sync_state == "pending"

    await delete_project(project_id=created.id, db=db_session, current_user=None)
    project = (await db_session.execute(select(AitoProject).where(AitoProject.id == created.id))).scalar_one()
    assert project.status == "deleted"
    assert project.quote_sync_state == "pending"  # still queued, the tick hasn't run yet

    # The worker's own quote-less-deleted branch, reproduced here rather than
    # imported: what matters to this test is the STATE it leaves behind, not
    # re-running the worker's Zoho plumbing.
    project.quote_sync_state = "idle"
    await db_session.commit()

    restored = await restore_project(project_id=project.id, db=db_session, current_user=None)
    assert restored.quote_sync_state == "pending"

    edited = await update_project(
        project_id=project.id,
        payload=AitoProjectUpdate(description="Helice modifiee"),
        db=db_session,
        current_user=None,
    )
    assert edited.quote_sync_state == "pending"
