"""Schema of the Hours tab's event log and the calibration/purchase columns."""

from datetime import date

import pytest
from sqlalchemy import select

from backend.app.models.maintenance import HourEvent, HourMachine, HourReading


@pytest.mark.asyncio
async def test_hour_event_round_trip(db_session):
    m = HourMachine(name="X1C04", model="X1C")
    db_session.add(m)
    await db_session.flush()
    db_session.add(HourEvent(machine_id=m.id, event_date=date(2026, 4, 25), kind="note", label="hotend changed"))
    await db_session.commit()
    assert (await db_session.execute(select(HourEvent))).scalar_one().label == "hotend changed"
    cols = {c.name for c in HourEvent.__table__.columns}
    assert cols == {"id", "machine_id", "event_date", "kind", "label", "source_id", "created_at"}


def test_hour_machine_and_reading_new_columns():
    machine_cols = {c.name for c in HourMachine.__table__.columns}
    assert {"calibrated_at", "last_drift_hours", "purchase_price", "purchase_date"} <= machine_cols
    assert "raw_hours" in {c.name for c in HourReading.__table__.columns}
