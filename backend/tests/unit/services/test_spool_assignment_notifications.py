"""Unit tests for spool assignment notification service."""

import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from backend.app.services.spool_assignment_notifications import notify_missing_spool_assignments_on_print_start


class _FakeAssignmentsResult:
    def __init__(self, rows):
        self._rows = rows

    def fetchall(self):
        return self._rows


class _FakeSession:
    """Fake DB session that returns legacy vs. Spoolman assignment rows based
    on which table the SELECT targets, so tests can exercise either mode."""

    def __init__(
        self,
        printer_name: str,
        legacy: list[SimpleNamespace] | None = None,
        spoolman: list[SimpleNamespace] | None = None,
    ):
        self._printer = SimpleNamespace(name=printer_name)
        self._legacy = legacy or []
        self._spoolman = spoolman or []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, model, key):
        return self._printer

    async def execute(self, statement):
        table = statement.get_final_froms()[0].name
        if table == "spoolman_slot_assignments":
            return _FakeAssignmentsResult(self._spoolman)
        return _FakeAssignmentsResult(self._legacy)


@pytest.mark.asyncio
async def test_missing_assignment_broadcasts_websocket_event_and_push_notification():
    """When a mapped tray is unassigned, service emits websocket and notification events."""
    logger = logging.getLogger(__name__)
    data = {
        "ams_mapping": [1],
        "raw_data": {},
    }

    # Assignment exists for A1 (global tray 0), but print uses A2 (global tray 1).
    assignments = [SimpleNamespace(ams_id=0, tray_id=0)]

    with (
        patch(
            "backend.app.services.spool_assignment_notifications.async_session",
            return_value=_FakeSession("Printer A", assignments),
        ),
        patch("backend.app.services.spool_assignment_notifications.printer_manager.get_status", return_value=None),
        patch(
            "backend.app.services.spool_assignment_notifications.ws_manager.send_missing_spool_assignment",
            new_callable=AsyncMock,
        ) as mock_ws,
        patch(
            "backend.app.services.spool_assignment_notifications.notification_service.on_print_missing_spool_assignment",
            new_callable=AsyncMock,
        ) as mock_notify,
    ):
        await notify_missing_spool_assignments_on_print_start(1, data, logger)

    mock_ws.assert_awaited_once()
    ws_kwargs = mock_ws.await_args.kwargs
    assert ws_kwargs["printer_id"] == 1
    assert ws_kwargs["printer_name"] == "Printer A"
    assert ws_kwargs["missing_slots"] == [{"slot": "A2", "profile": "Unknown", "color": "Unknown"}]

    mock_notify.assert_awaited_once()
    notify_kwargs = mock_notify.await_args.kwargs
    assert notify_kwargs["printer_id"] == 1
    assert notify_kwargs["printer_name"] == "Printer A"
    assert notify_kwargs["missing_slots"] == [{"slot": "A2", "profile": "Unknown", "color": "Unknown"}]


def _patches(session, spoolman_mode: bool = False):
    """Common patch set: the fake session + stubbed printer state / emitters.

    ``spoolman_mode`` decides which assignment table the check reads. Since
    #2812 it reads one, not both: nothing empties the inactive table on a mode
    toggle any more, so a leftover row there must not vouch for a tray.
    """
    return (
        patch(
            "backend.app.services.spool_assignment_notifications.spoolman_owns_assignments",
            new_callable=AsyncMock,
            return_value=spoolman_mode,
        ),
        patch(
            "backend.app.services.spool_assignment_notifications.async_session",
            return_value=session,
        ),
        patch("backend.app.services.spool_assignment_notifications.printer_manager.get_status", return_value=None),
        patch(
            "backend.app.services.spool_assignment_notifications.ws_manager.send_missing_spool_assignment",
            new_callable=AsyncMock,
        ),
        patch(
            "backend.app.services.spool_assignment_notifications.notification_service.on_print_missing_spool_assignment",
            new_callable=AsyncMock,
        ),
    )


@pytest.mark.asyncio
async def test_spoolman_only_assignment_suppresses_notification():
    """#1473 — trays bound only via spoolman_slot_assignments must NOT be
    flagged missing (the legacy spool_assignment table is empty in Spoolman
    mode, so checking it alone fired a false positive on every print)."""
    logger = logging.getLogger(__name__)
    data = {"ams_mapping": [0, 1], "raw_data": {}}  # print uses A1 + A2

    # Both used trays bound via Spoolman; legacy table empty.
    session = _FakeSession(
        "Printer A",
        legacy=[],
        spoolman=[SimpleNamespace(ams_id=0, tray_id=0), SimpleNamespace(ams_id=0, tray_id=1)],
    )
    p_mode, p_session, p_status, p_ws, p_notify = _patches(session, spoolman_mode=True)
    with p_mode, p_session, p_status, p_ws as mock_ws, p_notify as mock_notify:
        await notify_missing_spool_assignments_on_print_start(1, data, logger)

    mock_ws.assert_not_awaited()
    mock_notify.assert_not_awaited()


@pytest.mark.asyncio
async def test_spoolman_partial_coverage_flags_only_uncovered_tray():
    """A Spoolman assignment for A1 only, with a print using A1 + A2, flags
    A2 alone."""
    logger = logging.getLogger(__name__)
    data = {"ams_mapping": [0, 1], "raw_data": {}}

    session = _FakeSession(
        "Printer A",
        legacy=[],
        spoolman=[SimpleNamespace(ams_id=0, tray_id=0)],  # A1 only
    )
    p_mode, p_session, p_status, p_ws, p_notify = _patches(session, spoolman_mode=True)
    with p_mode, p_session, p_status, p_ws as mock_ws, p_notify as mock_notify:
        await notify_missing_spool_assignments_on_print_start(1, data, logger)

    mock_ws.assert_awaited_once()
    assert mock_ws.await_args.kwargs["missing_slots"] == [{"slot": "A2", "profile": "Unknown", "color": "Unknown"}]
    mock_notify.assert_awaited_once()


@pytest.mark.asyncio
async def test_a_row_in_the_inactive_modes_table_does_not_vouch_for_a_tray():
    """A1 bound in the legacy table, A2 bound in spoolman_slot_assignments.

    This used to union both and stay quiet. That was safe only because the mode
    toggle emptied whichever table the current mode was not using, so the two
    could never both hold rows -- and that emptying is what destroyed people's
    assignments for merely looking at the other mode (#2812). Nothing is
    emptied now, so in Spoolman mode the legacy row for A1 is a leftover from
    before the switch and says nothing about whether A1 is assigned today. A1
    is exactly the tray this notification exists to flag.
    """
    logger = logging.getLogger(__name__)
    data = {"ams_mapping": [0, 1], "raw_data": {}}

    session = _FakeSession(
        "Printer A",
        legacy=[SimpleNamespace(ams_id=0, tray_id=0)],  # A1 — leftover, not current
        spoolman=[SimpleNamespace(ams_id=0, tray_id=1)],  # A2 — the live binding
    )
    p_mode, p_session, p_status, p_ws, p_notify = _patches(session, spoolman_mode=True)
    with p_mode, p_session, p_status, p_ws as mock_ws, p_notify as mock_notify:
        await notify_missing_spool_assignments_on_print_start(1, data, logger)

    mock_ws.assert_awaited_once()
    assert mock_ws.await_args.kwargs["missing_slots"] == [{"slot": "A1", "profile": "Unknown", "color": "Unknown"}]
    mock_notify.assert_awaited_once()


@pytest.mark.asyncio
async def test_built_in_mode_reads_the_built_in_table():
    """The mirror image: in built-in mode a Spoolman row is the leftover."""
    logger = logging.getLogger(__name__)
    data = {"ams_mapping": [0, 1], "raw_data": {}}

    session = _FakeSession(
        "Printer A",
        legacy=[SimpleNamespace(ams_id=0, tray_id=0), SimpleNamespace(ams_id=0, tray_id=1)],
        spoolman=[SimpleNamespace(ams_id=0, tray_id=0)],
    )
    p_mode, p_session, p_status, p_ws, p_notify = _patches(session, spoolman_mode=False)
    with p_mode, p_session, p_status, p_ws as mock_ws, p_notify as mock_notify:
        await notify_missing_spool_assignments_on_print_start(1, data, logger)

    mock_ws.assert_not_awaited()
    mock_notify.assert_not_awaited()


@pytest.mark.asyncio
async def test_completion_notification_failure_keeps_the_callers_pending_debits():
    """#T-026: the caller's uncommitted debits survive a notification path that rolls back and raises."""
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from backend.app.models.notification import NotificationProvider
    from backend.app.models.printer import Printer
    from backend.app.services.spool_assignment_notifications import notify_missing_spool_assignments_on_print_complete

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Printer.__table__.create(c))
        await conn.run_sync(lambda c: NotificationProvider.__table__.create(c))
    sessions = async_sessionmaker(engine, expire_on_commit=False)

    async def failing_commit_path(*, db, **_kwargs):
        await db.rollback()  # what a failed bookkeeping commit leaves behind
        raise RuntimeError("database is locked")

    async with sessions() as db:
        db.add(NotificationProvider(name="pending-debit", provider_type="ntfy", config="{}"))  # stands in for a debit
        with (
            patch("backend.app.services.spool_assignment_notifications.ws_manager") as ws,
            patch("backend.app.services.spool_assignment_notifications.printer_manager") as pm,
            patch(
                "backend.app.services.spool_assignment_notifications.notification_service.on_print_missing_spool_assignment",
                side_effect=failing_commit_path,
            ),
        ):
            ws.send_missing_spool_assignment = AsyncMock()
            pm.get_status.return_value = None
            await notify_missing_spool_assignments_on_print_complete(1, [0], db, logging.getLogger("t"))
        await db.commit()
        names = [p.name for p in (await db.execute(select(NotificationProvider))).scalars()]
        assert names == ["pending-debit"]
    await engine.dispose()


# --- state parsing: tray lookup and MQTT mapping decode ---------------------------------------------------------------

_AMS_UNIT = {"id": 1, "tray": [{"id": 2, "tray_sub_brands": "PLA Basic", "tray_type": "PLA", "tray_color": "FF0000"}]}


@pytest.mark.parametrize(
    ("raw_data", "global_id", "expected"),
    [
        # ams as dict {"ams": [...]}: unit 1 tray 2 -> global 6
        ({"ams": {"ams": [_AMS_UNIT]}}, 6, ("PLA Basic", "FF0000")),
        # ams as bare list
        ({"ams": [_AMS_UNIT]}, 6, ("PLA Basic", "FF0000")),
        # garbage ams values resolve to nothing
        ({"ams": "garbage"}, 6, ("Unknown", "Unknown")),
        ({"ams": 42}, 6, ("Unknown", "Unknown")),
        ({"ams": {"ams": "nope"}}, 6, ("Unknown", "Unknown")),
        # tray_type fallback when no sub-brand; missing colour -> Unknown
        ({"ams": [{"id": 0, "tray": [{"id": 1, "tray_type": "PETG"}]}]}, 1, ("PETG", "Unknown")),
        # no profile/type at all
        ({"ams": [{"id": 0, "tray": [{"id": 3}]}]}, 3, ("Unknown", "Unknown")),
        # HT unit (id >= 128): global id is the unit id itself
        (
            {"ams": [{"id": 128, "tray": [{"id": 0, "tray_type": "ABS", "tray_color": "00FF00"}]}]},
            128,
            ("ABS", "00FF00"),
        ),
        # non-dict units / non-list tray / non-dict trays are skipped, a later match still wins
        (
            {"ams": ["x", {"id": 0, "tray": "bad"}, {"id": 0, "tray": ["y", {"id": 0, "tray_type": "TPU"}]}]},
            0,
            ("TPU", "Unknown"),
        ),
        # no match in a valid structure
        ({"ams": [_AMS_UNIT]}, 0, ("Unknown", "Unknown")),
        # vt_tray list: matched by id, takes precedence over AMS
        (
            {"vt_tray": [{"id": 254, "tray_type": "ASA", "tray_color": "0000FF"}], "ams": []},
            254,
            ("ASA", "0000FF"),
        ),
        # vt_tray: non-dict entries skipped
        (
            {"vt_tray": ["junk", {"id": 255, "tray_sub_brands": "Support", "tray_type": "PVA"}]},
            255,
            ("Support", "Unknown"),
        ),
        # vt_tray not a list (e.g. a dict) is ignored, and AMS is still consulted
        (
            {"vt_tray": {"id": 254, "tray_type": "ASA"}, "ams": [{"id": 0, "tray": [{"id": 0, "tray_type": "PLA"}]}]},
            254,
            ("Unknown", "Unknown"),
        ),
        (
            {"vt_tray": {"id": 254, "tray_type": "ASA"}, "ams": [{"id": 0, "tray": [{"id": 0, "tray_type": "PLA"}]}]},
            0,
            ("PLA", "Unknown"),
        ),
    ],
)
def test_tray_profile_and_color_for_global_id(raw_data, global_id, expected):
    from backend.app.services.spool_assignment_notifications import _tray_profile_and_color_for_global_id

    state = SimpleNamespace(raw_data=raw_data)
    assert _tray_profile_and_color_for_global_id(state, global_id) == expected


@pytest.mark.parametrize("state", [None, SimpleNamespace(raw_data=None), SimpleNamespace(raw_data={})])
def test_tray_profile_and_color_without_state_is_unknown(state):
    from backend.app.services.spool_assignment_notifications import _tray_profile_and_color_for_global_id

    assert _tray_profile_and_color_for_global_id(state, 0) == ("Unknown", "Unknown")


@pytest.mark.parametrize(
    ("mapping", "expected"),
    [
        # int: (ams_hw_id << 8) | slot; slot masked to 2 bits for AMS units 0-3
        ([0, 1, 258, 3 * 256 + 3], [0, 1, 6, 15]),
        ([256 + 7], [4 + 3]),
        # numeric strings are parsed base 10
        (["0", "259", "  1 "], [0, 7, 1]),
        # non-numeric strings are skipped, neighbours survive
        (["abc", 1, "0x10", ""], [1]),
        # None / float / bool-free other types are skipped
        ([None, 1.5, 2, [1], {}], [2]),
        # HT units 128-135 map to the unit id; external spools 254/255 by slot
        ([128 * 256, 135 * 256 + 1, 136 * 256], [128, 135]),
        ([254 * 256 + 255, 254 * 256 + 0, 255 * 256 + 1], [255, 254, 254]),
        # 65535 and above (unused marker) are skipped; unknown unit ids (4..127) too
        ([65535, 70000, 4 * 256, 127 * 256], []),
        # non-list or empty input
        ("string", []),
        (None, []),
        ({"a": 1}, []),
        ([], []),
    ],
)
def test_decode_mqtt_mapping_to_global_trays(mapping, expected):
    from backend.app.services.spool_assignment_notifications import _decode_mqtt_mapping_to_global_trays

    assert _decode_mqtt_mapping_to_global_trays(mapping) == expected


@pytest.mark.asyncio
async def test_snapshot_built_from_raw_mapping_and_ams_state_dict_shape():
    """MQTT-decoded mapping + dict-shaped AMS state yields labelled slots with profile/colour."""
    state = SimpleNamespace(
        raw_data={
            "ams": {"ams": [_AMS_UNIT]},
            "vt_tray": [{"id": 254, "tray_type": "ASA", "tray_color": "0000FF"}],
        }
    )
    # raw mapping: unit 1 slot 2 (global 6), ext-left, a garbage entry; nothing assigned
    data = {"ams_mapping": [], "raw_data": {"mapping": [258, "65024", "junk", None, 65535]}}

    with (
        patch(
            "backend.app.services.spool_assignment_notifications.async_session",
            return_value=_FakeSession("Printer B", []),
        ),
        patch("backend.app.services.spool_assignment_notifications.printer_manager.get_status", return_value=state),
        patch(
            "backend.app.services.spool_assignment_notifications.ws_manager.send_missing_spool_assignment",
            new_callable=AsyncMock,
        ) as mock_ws,
        patch(
            "backend.app.services.spool_assignment_notifications.notification_service.on_print_missing_spool_assignment",
            new_callable=AsyncMock,
        ) as mock_notify,
    ):
        await notify_missing_spool_assignments_on_print_start(1, data, logging.getLogger(__name__))

    expected = [
        {"slot": "B3", "profile": "PLA Basic", "color": "FF0000"},
        {"slot": "Ext-L", "profile": "ASA", "color": "0000FF"},
    ]
    assert mock_ws.await_args.kwargs["missing_slots"] == expected
    assert mock_ws.await_args.kwargs["printer_name"] == "Printer B"
    assert mock_notify.await_args.kwargs["missing_slots"] == expected


@pytest.mark.asyncio
async def test_explicit_ams_mapping_wins_over_raw_mapping_and_ignores_non_ints():
    """Non-int explicit values are dropped; negatives (unused) never count as missing."""
    data = {"ams_mapping": [-1, "3", 2.0, 2], "raw_data": {"mapping": [0]}}

    with (
        patch(
            "backend.app.services.spool_assignment_notifications.async_session",
            return_value=_FakeSession("P", []),
        ),
        patch("backend.app.services.spool_assignment_notifications.printer_manager.get_status", return_value=None),
        patch(
            "backend.app.services.spool_assignment_notifications.ws_manager.send_missing_spool_assignment",
            new_callable=AsyncMock,
        ) as mock_ws,
        patch(
            "backend.app.services.spool_assignment_notifications.notification_service.on_print_missing_spool_assignment",
            new_callable=AsyncMock,
        ),
    ):
        await notify_missing_spool_assignments_on_print_start(1, data, logging.getLogger(__name__))

    assert mock_ws.await_args.kwargs["missing_slots"] == [{"slot": "A3", "profile": "Unknown", "color": "Unknown"}]


@pytest.mark.asyncio
async def test_start_notification_failure_is_logged_not_raised(caplog):
    with (
        patch(
            "backend.app.services.spool_assignment_notifications.async_session",
            side_effect=RuntimeError("db down"),
        ),
        caplog.at_level(logging.WARNING, logger="t013"),
    ):
        await notify_missing_spool_assignments_on_print_start(1, {"ams_mapping": [0]}, logging.getLogger("t013"))

    assert "Missing spool-assignment notification failed: db down" in caplog.text
