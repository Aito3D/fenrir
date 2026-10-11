"""Shared revision lookups (services/project_revisions.py)."""

import pytest

from backend.app.models.project import Project
from backend.app.models.project_item import ProjectItem, ProjectRevision
from backend.app.services import project_files, project_print_trace, project_revisions
from backend.app.services.project_revisions import find_revision_bundle, revision_label


def test_revision_label_names_item_and_number():
    assert revision_label("Support", 3) == "Support R3"


def test_revision_label_is_the_same_function_everywhere():
    # project_files re-exports it (routes and services import it from there).
    assert project_files.revision_label is project_revisions.revision_label
    assert project_print_trace.revision_label is project_revisions.revision_label


@pytest.mark.asyncio
async def test_find_revision_bundle_returns_revision_item_and_project(db_session):
    project = Project(name="P")
    db_session.add(project)
    await db_session.flush()
    item = ProjectItem(project_id=project.id, section="impression", name="Mesh", name_key="mesh")
    db_session.add(item)
    await db_session.flush()
    rev = ProjectRevision(item_id=item.id, number=1)
    db_session.add(rev)
    await db_session.flush()

    bundle = await find_revision_bundle(db_session, rev.id)

    assert isinstance(bundle, tuple)
    assert bundle == (rev, item, project)


@pytest.mark.asyncio
async def test_find_revision_bundle_unknown_revision_is_none(db_session):
    assert await find_revision_bundle(db_session, 987654) is None


@pytest.mark.asyncio
async def test_get_revision_bundle_unknown_revision_is_404(db_session):
    with pytest.raises(project_files.ProjectFilesError) as exc:
        await project_files.get_revision_bundle(db_session, 987654)
    assert exc.value.status_code == 404
    assert exc.value.detail == "Revision not found"


# --- T-291: revision row locks (PostgreSQL only) ------------------------------
# There is no PostgreSQL in the test environment: the lock semantics are pinned by
# the compiled SQL, and the call sites by spies (test_project_files_service,
# test_aito_project_links_service, test_print_trace_queue).


def _compiled(statement, dialect) -> str:
    return " ".join(str(statement.compile(dialect=dialect)).split())


def test_revision_lock_statement_renders_for_update_and_for_share_on_postgresql_only():
    from sqlalchemy.dialects import postgresql, sqlite

    update_lock = project_revisions.revision_lock_statement([3, 1])
    share_lock = project_revisions.revision_lock_statement([3, 1], share=True)
    pg_update = _compiled(update_lock, postgresql.dialect())
    pg_share = _compiled(share_lock, postgresql.dialect())
    assert pg_update.startswith("SELECT project_revisions.id FROM project_revisions WHERE project_revisions.id IN")
    assert pg_update.endswith("ORDER BY project_revisions.id FOR UPDATE")
    assert pg_share.endswith("ORDER BY project_revisions.id FOR SHARE")
    for statement in (update_lock, share_lock):
        lite = _compiled(statement, sqlite.dialect())
        assert "FOR " not in lite and lite.endswith("ORDER BY project_revisions.id")


@pytest.mark.asyncio
async def test_lock_revision_rows_runs_nothing_on_sqlite(db_session, test_engine):
    from sqlalchemy import event

    statements: list[str] = []

    def record(_conn, _cursor, statement, *_args):
        statements.append(statement)

    event.listen(test_engine.sync_engine, "before_cursor_execute", record)
    try:
        assert await project_revisions.lock_revision_rows(db_session, [1, 2]) is None
        assert await project_revisions.lock_revision_rows(db_session, [1], share=True) is None
    finally:
        event.remove(test_engine.sync_engine, "before_cursor_execute", record)
    assert statements == []


class _PostgresSession:
    """Just enough AsyncSession for lock_revision_rows: a PostgreSQL bind and a recording execute."""

    def __init__(self, present: list[int]):
        from sqlalchemy.dialects import postgresql

        self.dialect = postgresql.dialect()
        self.present = present
        self.executed = []

    def get_bind(self):
        return self

    async def execute(self, statement):
        self.executed.append(statement)
        present = self.present

        class _Result:
            def scalars(self):
                return iter(present)

        return _Result()


@pytest.mark.asyncio
@pytest.mark.parametrize(("share", "clause"), [(False, "FOR UPDATE"), (True, "FOR SHARE")])
async def test_lock_revision_rows_on_postgresql_locks_and_returns_the_ids_still_there(share, clause):
    db = _PostgresSession(present=[1])
    assert await project_revisions.lock_revision_rows(db, [1, 2], share=share) == {1}
    [statement] = db.executed
    assert _compiled(statement, db.dialect).endswith(clause)
