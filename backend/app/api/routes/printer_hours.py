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
    HourImportBody,
    HourImportResult,
    HourMachineOut,
    HourMachineUpdate,
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


async def _overview(db: AsyncSession, today: date | None = None) -> HoursOverview:
    machines = await ensure_hour_machines(db)
    rows = (await db.execute(select(Printer.id, Printer.runtime_seconds, Printer.print_hours_offset))).all()
    hours_by_printer = {pid: current_hours(runtime, offset) for pid, runtime, offset in rows}
    readings = (
        await db.execute(select(HourReading).order_by(HourReading.reading_date, HourReading.machine_id, HourReading.id))
    ).scalars()
    return HoursOverview(
        today=today or date.today(),
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


def _reject_future(reading_date: date, today: date | None = None) -> None:
    if reading_date > (today or date.today()):
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
    today = date.today()
    _reject_future(body.reading_date, today)
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

    is_today = body.reading_date == today
    recalibrated: list[tuple[int, str]] = []
    for entry in body.entries:
        m = machines[entry.machine_id]
        existing = (
            await db.execute(
                select(HourReading.hours).where(
                    HourReading.machine_id == m.id,
                    HourReading.reading_date == body.reading_date,
                    HourReading.source == SOURCE_MANUAL,
                )
            )
        ).scalar_one_or_none()
        if entry.hours is not None and entry.hours == existing:
            continue  # unchanged value: never recalibrate (it would rewind the live counter)
        await upsert_reading(db, m.id, body.reading_date, SOURCE_MANUAL, entry.hours)
        if entry.hours is None or not is_today or m.printer_id is None:
            continue
        printer = await db.get(Printer, m.printer_id)
        if printer is None:  # deleted mid-request: keep the reading, skip the counter
            continue
        recalibrate_printer(printer, entry.hours)
        # recalibrate_printer clamps at 0, so record what the counter now actually reads
        actual = round(current_hours(printer.runtime_seconds, printer.print_hours_offset), 1)
        await upsert_reading(db, m.id, body.reading_date, SOURCE_AUTO, actual)
        recalibrated.append((printer.id, printer.name))
    await db.commit()

    for printer_id, printer_name in recalibrated:
        await notify_maintenance_attention(db, printer_id, printer_name)
    return await _overview(db, today)


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


@router.post("/import", response_model=HourImportResult)
async def import_readings(
    body: HourImportBody,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_UPDATE),
):
    """Bulk upsert manual readings from a pasted sheet, creating retired machines. Never recalibrates."""
    today = date.today()
    keys = [nm.key for nm in body.new_machines]
    if len(set(keys)) != len(keys):
        raise HTTPException(status_code=422, detail="Duplicate machine key")
    existing = await ensure_hour_machines(db)
    existing_ids = {m.id for m in existing}
    existing_names = {m.name.casefold() for m in existing}
    for nm in body.new_machines:
        if nm.name.strip().casefold() in existing_names:
            raise HTTPException(status_code=422, detail=f"A machine named {nm.name} already exists")
    for r in body.readings:
        if (r.machine_id is None) == (r.key is None):
            raise HTTPException(status_code=422, detail="Each reading needs exactly one of machine_id or key")
        if r.key is not None and r.key not in keys:
            raise HTTPException(status_code=422, detail=f"Unknown machine key {r.key}")
        if r.machine_id is not None and r.machine_id not in existing_ids:
            raise HTTPException(status_code=422, detail=f"Unknown machine {r.machine_id}")
        _reject_future(r.reading_date, today)

    created: dict[str, HourMachine] = {}
    for nm in body.new_machines:
        machine = HourMachine(name=nm.name.strip(), model=nm.model, retired=True)
        db.add(machine)
        created[nm.key] = machine
    await db.flush()
    for r in body.readings:
        machine_id = r.machine_id if r.machine_id is not None else created[r.key].id
        await upsert_reading(db, machine_id, r.reading_date, SOURCE_MANUAL, r.hours)
    await db.commit()
    return HourImportResult(machines_created=len(created), readings_written=len(body.readings))


async def _retired_machine(db: AsyncSession, machine_id: int) -> HourMachine:
    machine = await db.get(HourMachine, machine_id)
    if machine is None:
        raise HTTPException(status_code=404, detail="Machine not found")
    if not machine.retired:
        raise HTTPException(status_code=409, detail="Only retired machines can be changed here")
    return machine


@router.patch("/machines/{machine_id}", response_model=HourMachineOut)
async def update_machine(
    machine_id: int,
    body: HourMachineUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_UPDATE),
):
    await ensure_hour_machines(db)
    machine = await _retired_machine(db, machine_id)
    if body.name is not None:
        others = (await db.execute(select(HourMachine.name).where(HourMachine.id != machine_id))).scalars()
        if body.name.strip().casefold() in {n.casefold() for n in others}:
            raise HTTPException(status_code=422, detail=f"A machine named {body.name} already exists")
        machine.name = body.name.strip()
    if body.model is not None:
        machine.model = body.model or None
    await db.commit()
    return HourMachineOut(
        id=machine.id,
        printer_id=machine.printer_id,
        name=machine.name,
        model=machine.model,
        retired=machine.retired,
        current_hours=None,
    )


@router.delete("/machines/{machine_id}")
async def delete_machine(
    machine_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_DELETE),
):
    await ensure_hour_machines(db)
    machine = await _retired_machine(db, machine_id)
    # SQLite does not enforce the FK cascade; remove the history explicitly.
    await db.execute(delete(HourReading).where(HourReading.machine_id == machine.id))
    await db.delete(machine)
    await db.commit()
    return {"status": "deleted"}
