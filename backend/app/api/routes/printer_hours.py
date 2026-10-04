"""Maintenance → Hours tab: lifetime-hours history per machine."""

import logging
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.maintenance import notify_maintenance_attention
from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.maintenance import HourMachine, HourReading
from backend.app.models.printer import Printer
from backend.app.models.user import User
from backend.app.schemas.maintenance import (
    HourMachineOut,
    HourReadingBatch,
    HourReadingOut,
    HoursOverview,
)
from backend.app.services.printer_hours import (
    SOURCE_AUTO,
    SOURCE_MANUAL,
    current_hours,
    ensure_hour_machines,
    recalibrate_printer,
    upsert_reading,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/maintenance/hours", tags=["maintenance"])


async def _overview(db: AsyncSession) -> HoursOverview:
    machines = await ensure_hour_machines(db)
    rows = (await db.execute(select(Printer.id, Printer.runtime_seconds, Printer.print_hours_offset))).all()
    hours_by_printer = {pid: current_hours(runtime, offset) for pid, runtime, offset in rows}
    readings = (
        await db.execute(select(HourReading).order_by(HourReading.reading_date, HourReading.machine_id, HourReading.id))
    ).scalars()
    return HoursOverview(
        today=date.today(),
        machines=[
            HourMachineOut(
                id=m.id,
                printer_id=m.printer_id,
                name=m.name,
                model=m.model,
                retired=m.retired,
                current_hours=(
                    None
                    if m.retired or m.printer_id not in hours_by_printer
                    else round(hours_by_printer[m.printer_id], 1)
                ),
            )
            for m in machines
        ],
        readings=[HourReadingOut.model_validate(r) for r in readings],
    )


def _reject_future(reading_date: date) -> None:
    if reading_date > date.today():
        raise HTTPException(status_code=422, detail="Reading date is in the future")


@router.get("", response_model=HoursOverview)
async def get_hours(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_READ),
):
    return await _overview(db)


@router.post("/readings", response_model=HoursOverview)
async def save_readings(
    body: HourReadingBatch,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_UPDATE),
):
    """Upsert one date's manual readings. Readings dated today recalibrate their printer's counter."""
    _reject_future(body.reading_date)
    ids = [e.machine_id for e in body.entries]
    if len(set(ids)) != len(ids):
        raise HTTPException(status_code=422, detail="A machine appears twice in entries")
    await ensure_hour_machines(db)
    machines = {m.id: m for m in (await db.execute(select(HourMachine).where(HourMachine.id.in_(ids)))).scalars()}
    for machine_id in ids:
        m = machines.get(machine_id)
        if m is None:
            raise HTTPException(status_code=422, detail=f"Unknown machine {machine_id}")
        if m.retired:
            raise HTTPException(status_code=422, detail=f"{m.name} is retired; correct its history by pasting")

    is_today = body.reading_date == date.today()
    recalibrated: list[tuple[int, str]] = []
    for entry in body.entries:
        m = machines[entry.machine_id]
        await upsert_reading(db, m.id, body.reading_date, SOURCE_MANUAL, entry.hours)
        if entry.hours is None or not is_today or m.printer_id is None:
            continue
        printer = await db.get(Printer, m.printer_id)
        if printer is None:  # deleted mid-request: keep the reading, skip the counter
            continue
        recalibrate_printer(printer, entry.hours)
        await upsert_reading(db, m.id, body.reading_date, SOURCE_AUTO, entry.hours)
        recalibrated.append((printer.id, printer.name))
    await db.commit()

    for printer_id, printer_name in recalibrated:
        await notify_maintenance_attention(db, printer_id, printer_name)
    return await _overview(db)


@router.delete("/readings", response_model=HoursOverview)
async def delete_readings(
    reading_date: date,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_DELETE),
):
    """Delete every manual reading on a date; Fenrir's auto snapshots stay."""
    await db.execute(
        delete(HourReading).where(HourReading.reading_date == reading_date, HourReading.source == SOURCE_MANUAL)
    )
    await db.commit()
    return await _overview(db)
