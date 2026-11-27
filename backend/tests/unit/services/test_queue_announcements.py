"""Failure isolation of announce_queue_jobs_added: a queue add never fails because an announcement did."""

import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app.services.mqtt_relay import mqtt_relay
from backend.app.services.notification_service import notification_service
from backend.app.services.queue_announcements import announce_queue_jobs_added

LOGGER = "backend.app.services.queue_announcements"


def _row(item_id, printer_id, printer_name):
    return SimpleNamespace(
        id=item_id,
        printer_id=printer_id,
        target_model=None,
        printer_name=printer_name,
        archive_filename=f"job{item_id}.3mf",
        library_filename=None,
    )


def _db(rows=None, *, lookup_error=None):
    db = MagicMock()
    result = MagicMock()
    result.all.return_value = rows or []
    db.execute = AsyncMock(side_effect=lookup_error) if lookup_error else AsyncMock(return_value=result)
    db.rollback = AsyncMock()
    return db


@pytest.mark.asyncio
async def test_failed_row_lookup_is_swallowed_and_nothing_is_sent(caplog):
    notify, relay = AsyncMock(), AsyncMock()
    db = _db(lookup_error=RuntimeError("db down"))
    with (
        patch.object(notification_service, "on_queue_job_added", notify),
        patch.object(mqtt_relay, "on_queue_job_added", relay),
        caplog.at_level(logging.WARNING, logger=LOGGER),
    ):
        assert await announce_queue_jobs_added(db, [1, 2]) is None

    notify.assert_not_awaited()
    relay.assert_not_awaited()
    assert "Could not announce new queue jobs: db down" in caplog.text


@pytest.mark.asyncio
async def test_failing_mqtt_relay_does_not_stop_notifications_or_other_rows():
    rows = [_row(1, 10, "P1"), _row(2, 20, "P2")]
    notify = AsyncMock()
    relay = AsyncMock(side_effect=RuntimeError("broker gone"))
    db = _db(rows)
    with (
        patch.object(notification_service, "on_queue_job_added", notify),
        patch.object(mqtt_relay, "on_queue_job_added", relay),
    ):
        await announce_queue_jobs_added(db, [1, 2])

    assert relay.await_count == 2  # the second row is still relayed after the first failed
    assert [c.kwargs["printer_id"] for c in notify.await_args_list] == [10, 20]
    db.rollback.assert_not_awaited()


@pytest.mark.asyncio
async def test_failing_notification_logs_rolls_back_and_later_groups_are_still_announced(caplog):
    rows = [_row(1, 10, "P1"), _row(2, 20, "P2")]
    notify = AsyncMock(side_effect=[RuntimeError("smtp down"), None])
    db = _db(rows)
    with (
        patch.object(notification_service, "on_queue_job_added", notify),
        patch.object(mqtt_relay, "on_queue_job_added", AsyncMock()),
        caplog.at_level(logging.WARNING, logger=LOGGER),
    ):
        await announce_queue_jobs_added(db, [1, 2])

    assert [c.kwargs["printer_id"] for c in notify.await_args_list] == [10, 20]
    db.rollback.assert_awaited_once()
    assert "Queue job added notification failed: smtp down" in caplog.text


@pytest.mark.asyncio
async def test_failing_rollback_after_a_failed_notification_is_swallowed():
    rows = [_row(1, 10, "P1"), _row(2, 20, "P2")]
    notify = AsyncMock(side_effect=[RuntimeError("smtp down"), None])
    db = _db(rows)
    db.rollback = AsyncMock(side_effect=RuntimeError("rollback failed"))
    with (
        patch.object(notification_service, "on_queue_job_added", notify),
        patch.object(mqtt_relay, "on_queue_job_added", AsyncMock()),
    ):
        await announce_queue_jobs_added(db, [1, 2])

    assert notify.await_count == 2
