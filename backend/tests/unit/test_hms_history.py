"""HMS error history: one row per appearance, closed when the tracking forgets it."""

import time
from unittest.mock import patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app import main as main_module
from backend.app.main import _take_new_hms_faults_and_save
from backend.app.models.hms_fault_occurrence import HmsFaultOccurrence
from backend.app.models.printer import Printer
from backend.app.services.bambu_mqtt import BambuMQTTClient

DRYING = {"attr": 0x07002500, "code": 0x00020001}  # hidden at parse time
LENS = {"attr": 0x0C000100, "code": 0x00020017}


def _clear_tracking(pid):
    for d in (main_module._notified_hms_errors, main_module._hms_print_state, main_module._hms_forget_when_gone):
        d.pop(pid, None)


@pytest.fixture
async def printer_id(db_session):
    printer = Printer(name="P", serial_number="00M09A000000009", ip_address="192.168.1.100", access_code="12345678")
    db_session.add(printer)
    await db_session.commit()
    pid = printer.id
    _clear_tracking(pid)
    yield pid
    _clear_tracking(pid)


@pytest.fixture(autouse=True)
def app_session(test_engine):
    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    with patch("backend.app.services.hms_notified.async_session", maker):
        yield


def _errors(*hms):
    client = BambuMQTTClient(ip_address="192.168.1.100", serial_number="00M09A000000009", access_code="12345678")
    client._update_state({"hms": list(hms)})
    return client.state.hms_errors


async def _rows(db_session, pid):
    db_session.expire_all()
    return list(
        (
            await db_session.execute(
                select(HmsFaultOccurrence).where(HmsFaultOccurrence.printer_id == pid).order_by(HmsFaultOccurrence.id)
            )
        ).scalars()
    )


@pytest.mark.asyncio
async def test_one_row_per_appearance_and_cleared_when_forgotten(printer_id, db_session):
    errors = _errors(LENS)
    await _take_new_hms_faults_and_save(printer_id, errors, "RUNNING")
    await _take_new_hms_faults_and_save(printer_id, errors, "RUNNING")  # still listed: no new row

    (row,) = await _rows(db_session, printer_id)
    assert row.code == "0C00010000020017"
    assert row.severity == 2
    assert row.cleared_at is None

    # Gone past the grace period: forgotten, so the row is closed, and a re-raise is a new row.
    main_module._notified_hms_errors[printer_id]["0C00010000020017"] = time.time() - 10_000
    await _take_new_hms_faults_and_save(printer_id, [], "RUNNING")
    await _take_new_hms_faults_and_save(printer_id, errors, "RUNNING")

    first, second = await _rows(db_session, printer_id)
    assert first.cleared_at is not None
    assert second.cleared_at is None


@pytest.mark.asyncio
async def test_hidden_codes_never_reach_history(printer_id, db_session):
    errors = _errors(DRYING)
    assert errors == []
    await _take_new_hms_faults_and_save(printer_id, errors, "RUNNING")
    assert await _rows(db_session, printer_id) == []


@pytest.mark.asyncio
async def test_endpoint_aggregates(async_client, printer_id, db_session):
    from backend.app.utils.local_time import utcnow_naive

    now = utcnow_naive()
    for code in ("A", "A", "A", "B"):
        db_session.add(HmsFaultOccurrence(printer_id=printer_id, code=code, severity=2, first_seen=now))
    db_session.add(
        HmsFaultOccurrence(
            printer_id=printer_id, code="OLD", severity=1, first_seen=now.replace(year=now.year - 1), description="x"
        )
    )
    await db_session.commit()

    resp = await async_client.get(f"/api/v1/printers/{printer_id}/hms/history?limit=3")
    assert resp.status_code == 200
    body = resp.json()
    assert [(t["code"], t["count"]) for t in body["top_codes"]] == [("A", 3), ("B", 1)]
    assert len(body["recent"]) == 3

    assert (await async_client.get("/api/v1/printers/99999/hms/history")).status_code == 404
