"""Project codes: P-0001…, from a counter, never reused (spec §1.1)."""

import threading
import time

import pytest
from sqlalchemy import create_engine, delete, select, text
from sqlalchemy.pool import NullPool

from backend.app.models.project import Project
from backend.app.models.settings import Settings
from backend.app.services.project_codes import (
    CODE_COUNTER_KEY,
    allocate_code_number,
    format_project_code,
    parse_project_code,
)


def test_format_and_parse_round_trip():
    assert format_project_code(1) == "P-0001"
    assert format_project_code(12345) == "P-12345"
    assert parse_project_code("P-0042") == 42
    assert parse_project_code("p-0042") == 42
    assert parse_project_code("X-1") is None
    assert parse_project_code(None) is None


@pytest.mark.asyncio
async def test_new_projects_get_sequential_codes(db_session):
    a = Project(name="Alpha")
    b = Project(name="Bêta")
    db_session.add_all([a, b])
    await db_session.commit()
    assert {a.code, b.code} == {"P-0001", "P-0002"}
    assert b.storage_dir == f"{b.code}_beta"


@pytest.mark.asyncio
async def test_code_never_reused_after_delete(db_session):
    first = Project(name="One")
    second = Project(name="Two")
    db_session.add(first)
    await db_session.commit()
    db_session.add(second)
    await db_session.commit()
    await db_session.execute(delete(Project).where(Project.id == second.id))
    await db_session.commit()
    third = Project(name="Three")
    db_session.add(third)
    await db_session.commit()
    assert third.code == "P-0003"


@pytest.mark.asyncio
async def test_counter_skips_past_existing_higher_code(db_session):
    db_session.add(Project(name="Imported", code="P-0100"))
    await db_session.commit()
    fresh = Project(name="Fresh")
    db_session.add(fresh)
    await db_session.commit()
    assert fresh.code == "P-0101"
    counter = (await db_session.execute(select(Settings).where(Settings.key == CODE_COUNTER_KEY))).scalar_one()
    assert counter.value == "101"


@pytest.mark.asyncio
async def test_explicit_code_is_kept(db_session):
    project = Project(name="Kept", code="P-0007")
    db_session.add(project)
    await db_session.commit()
    assert project.code == "P-0007"


def _concurrent_creates(db_path, allocate, rounds):
    """Two connections race ``allocate`` + INSERT + COMMIT, ``rounds`` times.

    File-backed SQLite in WAL mode like production: an in-memory database
    shares one connection and cannot show the race. Each creator holds its
    transaction open briefly after allocating, so a creator that read the
    counter without the write lock would compute the same number.
    """
    engine = create_engine(f"sqlite:///{db_path}", poolclass=NullPool, connect_args={"timeout": 10})
    with engine.begin() as conn:
        conn.execute(text("PRAGMA journal_mode = WAL"))
        conn.execute(text("CREATE TABLE settings (id INTEGER PRIMARY KEY, key TEXT UNIQUE, value TEXT)"))
        conn.execute(text("CREATE TABLE projects (id INTEGER PRIMARY KEY, code TEXT UNIQUE)"))
    numbers: list[int] = []
    errors: list[BaseException] = []

    def create(barrier: threading.Barrier) -> None:
        try:
            with engine.connect() as conn:
                barrier.wait()
                number = allocate(conn)
                time.sleep(0.05)
                conn.execute(text("INSERT INTO projects (code) VALUES (:code)"), {"code": format_project_code(number)})
                conn.commit()
                numbers.append(number)
        except BaseException as exc:  # recorded and asserted on by the caller
            errors.append(exc)

    for _ in range(rounds):
        barrier = threading.Barrier(2)
        threads = [threading.Thread(target=create, args=(barrier,)) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
    with engine.connect() as conn:
        counter = conn.execute(text("SELECT value FROM settings WHERE key = :key"), {"key": CODE_COUNTER_KEY}).scalar()
    engine.dispose()
    return numbers, errors, counter


def test_concurrent_allocations_on_sqlite_never_collide(tmp_path):
    numbers, errors, counter = _concurrent_creates(tmp_path / "codes.db", allocate_code_number, rounds=5)
    assert errors == []
    assert sorted(numbers) == list(range(1, 11))
    assert counter == "10"


class _RecordingConnection:
    """Stands in for a PostgreSQL connection: records SQL, serves canned rows."""

    def __init__(self, dialect_name, counter_row, codes):
        self.dialect = type("Dialect", (), {"name": dialect_name})()
        self.statements: list[tuple[str, dict | None]] = []
        self._counter_row = counter_row
        self._codes = codes

    def execute(self, statement, params=None):
        sql = str(statement)
        self.statements.append((sql, params))
        if sql.startswith("SELECT value FROM settings"):
            rows = [self._counter_row] if self._counter_row else []
        elif sql.startswith("SELECT code FROM projects"):
            rows = [(code,) for code in self._codes]
        else:
            rows = []
        return _Rows(rows)


class _Rows(list):
    def first(self):
        return self[0] if self else None


def test_postgresql_locks_the_counter_row_and_skips_the_noop_update():
    conn = _RecordingConnection("postgresql", ("4",), ["P-0002", "junk", None])
    assert allocate_code_number(conn) == 5
    sqls = [sql for sql, _ in conn.statements]
    assert sqls == [
        "SELECT value FROM settings WHERE key = :key FOR UPDATE",
        "SELECT code FROM projects WHERE code IS NOT NULL",
        "UPDATE settings SET value = :value WHERE key = :key",
    ]
    assert conn.statements[-1][1] == {"key": CODE_COUNTER_KEY, "value": "5"}


def test_unparseable_counter_counts_as_zero_and_missing_row_is_inserted():
    conn = _RecordingConnection("postgresql", ("not-a-number",), ["P-0003"])
    assert allocate_code_number(conn) == 4
    missing = _RecordingConnection("postgresql", None, [])
    assert allocate_code_number(missing) == 1
    assert missing.statements[-1] == (
        "INSERT INTO settings (key, value) VALUES (:key, :value)",
        {"key": CODE_COUNTER_KEY, "value": "1"},
    )
