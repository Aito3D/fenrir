"""The one-time backfill of `aito_projects.document_numbers` from history.

The sweep never revisits a paid or trashed card and quote sync stops reading
a locked estimate, so the invoice and retainer numbers of every card settled
before the column existed would never become searchable on their own. The
backfill recovers them from the numbers the timeline already recorded in
`aito_events.detail`.
"""

import json

import pytest
from sqlalchemy import text

from backend.app.core.database import run_migrations
from backend.tests.unit.test_aito_quote_status_confirmed_migration import _make_engine, _seed


async def _event(conn, project_id, kind, detail, when="2026-09-01 10:00:00"):
    await conn.execute(
        text(
            "INSERT INTO aito_events (project_id, occurred_at, kind, actor_class, detail, created_at) "
            "VALUES (:p, :w, :k, 'system', :d, :w)"
        ),
        {"p": project_id, "w": when, "k": kind, "d": None if detail is None else json.dumps(detail)},
    )


async def _numbers(conn, project_id):
    raw = (
        await conn.execute(text("SELECT document_numbers FROM aito_projects WHERE id = :p"), {"p": project_id})
    ).scalar_one()
    return None if raw is None else json.loads(raw)


@pytest.mark.asyncio
async def test_backfills_invoice_and_retainer_numbers_from_events():
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            paid = await _seed(conn, "Carte payee")
            await _event(conn, paid, "deposit.paid", {"retainer_number": "RET-00012"}, "2026-08-01 09:00:00")
            await _event(conn, paid, "invoice.created", {"invoice_number": "INV-000123"}, "2026-08-02 09:00:00")
            await _event(
                conn,
                paid,
                "deposit.applied",
                {"retainer_number": "RET-00012", "invoice_number": "INV-000123"},
                "2026-08-03 09:00:00",
            )
            await _event(conn, paid, "invoice.status", {"invoice_number": "", "status": "paid"})
            await _event(conn, paid, "task.added", None)
            await _event(conn, paid, "task.edited", {"field": "title"})
            bare = await _seed(conn, "Sans facture")
            await _event(conn, bare, "task.added", None)

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            assert await _numbers(conn, paid) == ["RET-00012", "INV-000123"]
            assert await _numbers(conn, bare) is None
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_keeps_only_the_newest_twenty():
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            project = await _seed(conn, "Beaucoup")
            for n in range(25):
                await _event(
                    conn, project, "invoice.created", {"invoice_number": f"INV-{n:03d}"}, f"2026-08-01 09:{n:02d}:00"
                )

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            assert await _numbers(conn, project) == [f"INV-{n:03d}" for n in range(5, 25)]
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_leaves_existing_numbers_alone_and_runs_once():
    engine = await _make_engine()
    try:
        async with engine.begin() as conn:
            stored = await _seed(conn, "Deja rempli")
            await conn.execute(
                text("UPDATE aito_projects SET document_numbers = :n WHERE id = :p"),
                {"n": json.dumps(["INV-9"]), "p": stored},
            )
            await _event(conn, stored, "invoice.created", {"invoice_number": "INV-OLD"})
            later = await _seed(conn, "Plus tard")

        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            assert await _numbers(conn, stored) == ["INV-9"]
            assert await _numbers(conn, later) is None

        # A number recorded after the first boot is the live code's job, not
        # the backfill's: a second boot changes nothing.
        async with engine.begin() as conn:
            await _event(conn, later, "invoice.created", {"invoice_number": "INV-NEW"})
        async with engine.begin() as conn:
            await run_migrations(conn)

        async with engine.connect() as conn:
            assert await _numbers(conn, stored) == ["INV-9"]
            assert await _numbers(conn, later) is None
    finally:
        await engine.dispose()
