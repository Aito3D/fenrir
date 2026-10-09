"""Pins the best-effort "record on linked orders, commit, broadcast" contract of
the three sites that share it: ``routes.project_files._record_linked``,
``project_filing.record_revision_added`` and ``aito_project_links._fan_out_revision``.

A fake session records every call so the side-effect ORDER is asserted, plus
the failure contract of each site (what is swallowed, what propagates, which
logger and message, what is returned, whether the broadcast happens)."""

import logging
from types import SimpleNamespace

import pytest

from backend.app.api.routes import project_files as files_routes
from backend.app.models.user import User
from backend.app.services import aito_project_links as links, project_filing


class _Savepoint:
    def __init__(self, calls):
        self.calls = calls

    async def __aenter__(self):
        self.calls.append(("savepoint_enter",))
        return self

    async def __aexit__(self, exc_type, _exc, _tb):
        self.calls.append(("savepoint_exit", exc_type.__name__ if exc_type else None))
        return False


class FakeSession:
    def __init__(self, *, fail_commit=False, fail_rollback=False, fail_get=False, username="Paul"):
        self.calls = []
        self.fail_commit = fail_commit
        self.fail_rollback = fail_rollback
        self.fail_get = fail_get
        self.username = username

    def begin_nested(self):
        return _Savepoint(self.calls)

    async def commit(self):
        self.calls.append(("commit",))
        if self.fail_commit:
            raise RuntimeError("commit failed")

    async def rollback(self):
        self.calls.append(("rollback",))
        if self.fail_rollback:
            raise RuntimeError("rollback failed")

    async def get(self, model, ident):
        self.calls.append(("get", model.__name__, ident))
        if self.fail_get:
            raise RuntimeError("get failed")
        return SimpleNamespace(username=self.username)


@pytest.fixture
def patched(monkeypatch):
    state = {"record_fails": False, "broadcast_fails": False, "order_ids": [3, 5]}

    async def record(db, project_id, kind, **kwargs):
        kwargs.setdefault("exclude_order_ids", ())  # the real default: an omitted exclusion is ()
        db.calls.append(("record", project_id, kind, kwargs))
        if state["record_fails"]:
            raise RuntimeError("record failed")
        return list(state["order_ids"])

    async def broadcast(order_ids, actor):
        state["db"].calls.append(("broadcast", list(order_ids), actor))
        if state["broadcast_fails"]:
            raise RuntimeError("broadcast failed")

    monkeypatch.setattr(links, "record_on_linked_orders", record)
    monkeypatch.setattr(links, "broadcast_orders_changed", broadcast)
    return state


def _warnings(caplog):
    return [(r.name, r.getMessage(), r.exc_info is not None) for r in caplog.records if r.levelno == logging.WARNING]


# --- routes.project_files._record_linked ------------------------------------

ROUTE_LOGGER = files_routes.__name__
KIND = "project.revision_status_changed"
DETAIL = {"revision_id": 9, "from": "wip", "to": "valide"}


async def _call_route(db, user=SimpleNamespace(username="Paul")):
    return await files_routes._record_linked(db, 7, KIND, user, "Support R2", DETAIL)


def _route_record_call(actor="Paul"):
    return (
        "record",
        7,
        KIND,
        {"actor": actor, "subject_label": "Support R2", "detail": DETAIL, "exclude_order_ids": ()},
    )


@pytest.mark.asyncio
async def test_route_success_order(patched, caplog):
    db = patched["db"] = FakeSession()
    with caplog.at_level(logging.WARNING):
        assert await _call_route(db) is None
    assert db.calls == [
        ("savepoint_enter",),
        _route_record_call(),
        ("savepoint_exit", None),
        ("commit",),
        ("broadcast", [3, 5], "Paul"),
    ]
    assert _warnings(caplog) == []


@pytest.mark.asyncio
async def test_route_anonymous_user_has_no_actor(patched):
    db = patched["db"] = FakeSession()
    await _call_route(db, user=None)
    assert db.calls[1] == _route_record_call(actor=None)
    assert db.calls[-1] == ("broadcast", [3, 5], None)


@pytest.mark.asyncio
async def test_route_record_failure_is_swallowed(patched, caplog):
    patched["record_fails"] = True
    db = patched["db"] = FakeSession()
    with caplog.at_level(logging.WARNING):
        assert await _call_route(db) is None
    assert db.calls == [
        ("savepoint_enter",),
        _route_record_call(),
        ("savepoint_exit", "RuntimeError"),
        ("rollback",),
    ]
    assert _warnings(caplog) == [(ROUTE_LOGGER, f"{KIND} event failed for project 7", True)]


@pytest.mark.asyncio
async def test_route_commit_failure_is_swallowed(patched, caplog):
    db = patched["db"] = FakeSession(fail_commit=True)
    with caplog.at_level(logging.WARNING):
        assert await _call_route(db) is None
    assert db.calls == [
        ("savepoint_enter",),
        _route_record_call(),
        ("savepoint_exit", None),
        ("commit",),
        ("rollback",),
    ]
    assert _warnings(caplog) == [(ROUTE_LOGGER, f"{KIND} event failed for project 7", True)]


@pytest.mark.asyncio
async def test_route_rollback_failure_propagates(patched):
    patched["record_fails"] = True
    db = patched["db"] = FakeSession(fail_rollback=True)
    with pytest.raises(RuntimeError, match="rollback failed"):
        await _call_route(db)
    assert db.calls[-1] == ("rollback",)


@pytest.mark.asyncio
async def test_route_broadcast_failure_propagates(patched):
    patched["broadcast_fails"] = True
    db = patched["db"] = FakeSession()
    with pytest.raises(RuntimeError, match="broadcast failed"):
        await _call_route(db)
    assert db.calls[-2:] == [("commit",), ("broadcast", [3, 5], "Paul")]


# --- project_filing.record_revision_added -----------------------------------

FILING_LOGGER = project_filing.__name__
ENTRY = {"section": "impression", "item_id": 4, "item_name": "Support", "revision_id": 11, "revision_number": 2}


def _filing_record_call(actor="Paul"):
    return (
        "record",
        7,
        "project.revision_added",
        {
            "actor": actor,
            "subject_label": "Support R2",
            "detail": {"section": "impression", "item_id": 4, "revision_id": 11},
            "exclude_order_ids": (),
        },
    )


@pytest.mark.asyncio
async def test_filing_success_order(patched, caplog):
    db = patched["db"] = FakeSession()
    with caplog.at_level(logging.WARNING):
        assert await project_filing.record_revision_added(db, 7, ENTRY, 42) is None
    assert db.calls == [
        ("get", User.__name__, 42),
        ("savepoint_enter",),
        _filing_record_call(),
        ("savepoint_exit", None),
        ("commit",),
        ("broadcast", [3, 5], "Paul"),
    ]
    assert _warnings(caplog) == []


@pytest.mark.asyncio
async def test_filing_without_user_skips_the_lookup(patched):
    db = patched["db"] = FakeSession()
    await project_filing.record_revision_added(db, 7, ENTRY, None)
    assert db.calls[0] == ("savepoint_enter",)
    assert db.calls[1] == _filing_record_call(actor=None)
    assert db.calls[-1] == ("broadcast", [3, 5], None)


@pytest.mark.asyncio
async def test_filing_user_lookup_failure_is_swallowed(patched, caplog):
    db = patched["db"] = FakeSession(fail_get=True)
    with caplog.at_level(logging.WARNING):
        assert await project_filing.record_revision_added(db, 7, ENTRY, 42) is None
    assert db.calls == [("get", User.__name__, 42), ("rollback",)]
    assert _warnings(caplog) == [(FILING_LOGGER, "project.revision_added event failed for project 7", True)]


@pytest.mark.asyncio
async def test_filing_record_failure_is_swallowed(patched, caplog):
    patched["record_fails"] = True
    db = patched["db"] = FakeSession()
    with caplog.at_level(logging.WARNING):
        assert await project_filing.record_revision_added(db, 7, ENTRY, 42) is None
    assert db.calls == [
        ("get", User.__name__, 42),
        ("savepoint_enter",),
        _filing_record_call(),
        ("savepoint_exit", "RuntimeError"),
        ("rollback",),
    ]
    assert _warnings(caplog) == [(FILING_LOGGER, "project.revision_added event failed for project 7", True)]


@pytest.mark.asyncio
async def test_filing_commit_failure_is_swallowed(patched, caplog):
    db = patched["db"] = FakeSession(fail_commit=True)
    with caplog.at_level(logging.WARNING):
        assert await project_filing.record_revision_added(db, 7, ENTRY, 42) is None
    assert db.calls[-2:] == [("commit",), ("rollback",)]
    assert _warnings(caplog) == [(FILING_LOGGER, "project.revision_added event failed for project 7", True)]


@pytest.mark.asyncio
async def test_filing_rollback_failure_propagates(patched):
    patched["record_fails"] = True
    db = patched["db"] = FakeSession(fail_rollback=True)
    with pytest.raises(RuntimeError, match="rollback failed"):
        await project_filing.record_revision_added(db, 7, ENTRY, 42)


@pytest.mark.asyncio
async def test_filing_broadcast_failure_propagates(patched):
    patched["broadcast_fails"] = True
    db = patched["db"] = FakeSession()
    with pytest.raises(RuntimeError, match="broadcast failed"):
        await project_filing.record_revision_added(db, 7, ENTRY, 42)
    assert db.calls[-2:] == [("commit",), ("broadcast", [3, 5], "Paul")]


# --- aito_project_links._fan_out_revision -----------------------------------

LINKS_LOGGER = links.__name__
REV_DETAIL = {"section": "impression", "item_id": 4, "revision_id": 11}


async def _call_fan_out(db):
    return await links._fan_out_revision(db, 7, REV_DETAIL, "Support R2", dropping_order_id=2, actor="Paul")


def _fan_out_record_call():
    return (
        "record",
        7,
        "project.revision_added",
        {"actor": "Paul", "subject_label": "Support R2", "detail": REV_DETAIL, "exclude_order_ids": {2}},
    )


@pytest.mark.asyncio
async def test_fan_out_success_returns_ids_without_broadcasting(patched, caplog):
    db = patched["db"] = FakeSession()
    with caplog.at_level(logging.WARNING):
        assert await _call_fan_out(db) == [3, 5]
    assert db.calls == [
        ("savepoint_enter",),
        _fan_out_record_call(),
        ("savepoint_exit", None),
        ("commit",),
    ]
    assert _warnings(caplog) == []


@pytest.mark.asyncio
async def test_fan_out_record_failure_returns_empty_list(patched, caplog):
    patched["record_fails"] = True
    db = patched["db"] = FakeSession()
    with caplog.at_level(logging.WARNING):
        assert await _call_fan_out(db) == []
    assert db.calls == [
        ("savepoint_enter",),
        _fan_out_record_call(),
        ("savepoint_exit", "RuntimeError"),
        ("rollback",),
    ]
    assert _warnings(caplog) == [(LINKS_LOGGER, "project.revision_added fan-out failed for project 7", True)]


@pytest.mark.asyncio
async def test_fan_out_commit_failure_returns_empty_list(patched, caplog):
    db = patched["db"] = FakeSession(fail_commit=True)
    with caplog.at_level(logging.WARNING):
        assert await _call_fan_out(db) == []
    assert db.calls[-2:] == [("commit",), ("rollback",)]
    assert _warnings(caplog) == [(LINKS_LOGGER, "project.revision_added fan-out failed for project 7", True)]


@pytest.mark.asyncio
async def test_fan_out_rollback_failure_propagates(patched):
    patched["record_fails"] = True
    db = patched["db"] = FakeSession(fail_rollback=True)
    with pytest.raises(RuntimeError, match="rollback failed"):
        await _call_fan_out(db)


@pytest.mark.asyncio
async def test_fan_out_empty_success_is_an_empty_list(patched):
    patched["order_ids"] = []
    db = patched["db"] = FakeSession()
    assert await _call_fan_out(db) == []
    assert db.calls[-1] == ("commit",)


@pytest.mark.asyncio
async def test_filing_bad_entry_is_swallowed_inside_the_savepoint(patched, caplog):
    db = patched["db"] = FakeSession()
    entry = {k: v for k, v in ENTRY.items() if k != "revision_id"}
    with caplog.at_level(logging.WARNING):
        assert await project_filing.record_revision_added(db, 7, entry, 42) is None
    assert db.calls == [
        ("get", User.__name__, 42),
        ("savepoint_enter",),
        ("savepoint_exit", "KeyError"),
        ("rollback",),
    ]
    assert _warnings(caplog) == [(FILING_LOGGER, "project.revision_added event failed for project 7", True)]
