"""Maintenance → Hours tab: lifetime-hours history per machine."""

import logging
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.maintenance import notify_maintenance_attention
from backend.app.api.routes.settings import set_setting
from backend.app.core.auth import RequestPrinterScope, RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.core.printer_scope import ALL_PRINTERS, PrinterScope
from backend.app.models.maintenance import HourEvent, HourMachine, HourReading
from backend.app.models.printer import Printer
from backend.app.models.user import User
from backend.app.schemas.maintenance import (
    HourEventCreate,
    HourEventOut,
    HourImportBody,
    HourImportResult,
    HourMachineOut,
    HourMachineUpdate,
    HourReadingBatch,
    HourReadingOut,
    HourSettingsUpdate,
    HoursOverview,
)
from backend.app.services.printer_hours import (
    SOURCE_MANUAL,
    added_on,
    calibrate_machine,
    current_hours,
    due_machine_ids,
    ensure_hour_machines,
    next_service_hours,
    reading_interval_days,
    sync_events,
    trust_state,
    upsert_reading,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/maintenance/hours", tags=["maintenance"])


async def _machine_out(
    db: AsyncSession,
    m: HourMachine,
    printer: tuple[int, float, datetime | None] | None,
    manual: list[HourReading],
) -> HourMachineOut:
    """One machine's row: live counter, trust, service threshold and join date."""
    live = printer is not None and not m.retired
    runtime, offset, created = printer or (0, 0.0, None)
    trust, drift = trust_state(m, manual[-1].hours if manual else None)
    next_service = None
    if live and m.printer_id is not None and trust in ("calibrated", "drifting"):
        try:
            next_service = await next_service_hours(db, m.printer_id)
        except HTTPException:  # printer deleted since ensure_hour_machines
            next_service = None
    return HourMachineOut(
        id=m.id,
        printer_id=m.printer_id,
        name=m.name,
        model=m.model,
        retired=m.retired,
        current_hours=round(current_hours(runtime, offset), 1) if live else None,
        trust=trust,
        last_drift_hours=drift,
        calibrated_at=m.calibrated_at,
        counter_raw_hours=(runtime or 0) / 3600.0 if live else None,
        next_service_hours=next_service,
        purchase_price=m.purchase_price,
        purchase_date=m.purchase_date,
        added_on=added_on(m, manual[0].reading_date if manual else None, created.date() if created else None),
    )


async def _overview(
    db: AsyncSession, today: date | None = None, printer_scope: PrinterScope = ALL_PRINTERS
) -> HoursOverview:
    today = today or date.today()
    machines = await ensure_hour_machines(db)
    await sync_events(db, machines)  # syncs every machine; only the response is scoped
    machines = [m for m in machines if printer_scope.allows(m.printer_id)]
    rows = (
        await db.execute(select(Printer.id, Printer.runtime_seconds, Printer.print_hours_offset, Printer.created_at))
    ).all()
    printers = {pid: (runtime, offset, created) for pid, runtime, offset, created in rows}
    readings = (
        (
            await db.execute(
                select(HourReading).order_by(HourReading.reading_date, HourReading.machine_id, HourReading.id)
            )
        )
        .scalars()
        .all()
    )
    events = (await db.execute(select(HourEvent).order_by(HourEvent.event_date, HourEvent.id))).scalars().all()
    in_scope_ids = {m.id for m in machines}
    readings = [r for r in readings if r.machine_id in in_scope_ids]
    events = [e for e in events if e.machine_id in in_scope_ids]
    manual: dict[int, list[HourReading]] = {}
    for r in readings:
        if r.source == SOURCE_MANUAL:
            manual.setdefault(r.machine_id, []).append(r)
    interval = await reading_interval_days(db)
    return HoursOverview(
        today=today,
        machines=[
            await _machine_out(
                db, m, printers.get(m.printer_id) if m.printer_id is not None else None, manual.get(m.id, [])
            )
            for m in machines
        ],
        readings=[HourReadingOut.model_validate(r) for r in readings],
        events=[HourEventOut.model_validate(e) for e in events],
        reading_interval_days=interval,
        due_machine_ids=due_machine_ids(machines, readings, interval, today),
    )


def _reject_future(reading_date: date, today: date | None = None) -> None:
    if reading_date > (today or date.today()):
        raise HTTPException(status_code=422, detail="Reading date is in the future")


@router.get("", response_model=HoursOverview)
async def get_hours(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_READ),
    printer_scope: PrinterScope = RequestPrinterScope,
):
    return await _overview(db, printer_scope=printer_scope)


@router.post("/readings", response_model=HoursOverview)
async def save_readings(
    body: HourReadingBatch,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_UPDATE),
    printer_scope: PrinterScope = RequestPrinterScope,
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
        if m is None or not printer_scope.allows(m.printer_id):
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
        await calibrate_machine(db, m, printer, entry.hours, today)
        recalibrated.append((printer.id, printer.name))
    await db.commit()

    for printer_id, printer_name in recalibrated:
        await notify_maintenance_attention(db, printer_id, printer_name)
    return await _overview(db, today, printer_scope)


@router.delete("/readings", response_model=HoursOverview)
async def delete_readings(
    reading_date: date,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_DELETE),
    printer_scope: PrinterScope = RequestPrinterScope,
):
    """Delete every manual reading on a date; Fenrir's auto snapshots stay."""
    stmt = delete(HourReading).where(HourReading.reading_date == reading_date, HourReading.source == SOURCE_MANUAL)
    in_scope = printer_scope.where(HourMachine.printer_id)
    if in_scope is not None:  # restricted caller: only machines of their printers (and retired ones)
        stmt = stmt.where(HourReading.machine_id.in_(select(HourMachine.id).where(in_scope)))
    await db.execute(stmt)
    await db.commit()
    return await _overview(db, printer_scope=printer_scope)


@router.post("/import", response_model=HourImportResult)
async def import_readings(
    body: HourImportBody,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_UPDATE),
    printer_scope: PrinterScope = RequestPrinterScope,
):
    """Bulk upsert manual readings from a pasted sheet, creating retired machines. Never recalibrates."""
    today = date.today()
    keys = [nm.key for nm in body.new_machines]
    if len(set(keys)) != len(keys):
        raise HTTPException(status_code=422, detail="Duplicate machine key")
    existing = await ensure_hour_machines(db)
    existing_ids = {m.id for m in existing if printer_scope.allows(m.printer_id)}
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


async def _scoped_machine(db: AsyncSession, machine_id: int, printer_scope: PrinterScope) -> HourMachine | None:
    """The machine, or None when missing or on a printer outside the caller's scope."""
    machine = await db.get(HourMachine, machine_id)
    return machine if machine is not None and printer_scope.allows(machine.printer_id) else None


async def _retired_machine(db: AsyncSession, machine_id: int, printer_scope: PrinterScope) -> HourMachine:
    machine = await _scoped_machine(db, machine_id, printer_scope)
    if machine is None:
        raise HTTPException(status_code=404, detail="Machine not found")
    if not machine.retired:
        raise HTTPException(status_code=409, detail="Only retired machines can be changed here")
    return machine


@router.post("/machines/{machine_id}/events", response_model=HourEventOut)
async def add_note_event(
    machine_id: int,
    body: HourEventCreate,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_UPDATE),
    printer_scope: PrinterScope = RequestPrinterScope,
):
    """Add a free-text note to a machine's timeline."""
    await ensure_hour_machines(db)
    if await _scoped_machine(db, machine_id, printer_scope) is None:
        raise HTTPException(status_code=404, detail="Machine not found")
    _reject_future(body.event_date)
    event = HourEvent(machine_id=machine_id, event_date=body.event_date, kind="note", label=body.label.strip())
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return event


@router.delete("/events/{event_id}", status_code=204)
async def delete_note_event(
    event_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_UPDATE),
    printer_scope: PrinterScope = RequestPrinterScope,
):
    """Delete a note; mirrored events (maintenance, calibration, ...) are not deletable."""
    event = await db.get(HourEvent, event_id)
    if event is None or await _scoped_machine(db, event.machine_id, printer_scope) is None:
        raise HTTPException(status_code=404, detail="Event not found")
    if event.kind != "note":
        raise HTTPException(status_code=409, detail="Only notes can be deleted")
    await db.delete(event)
    await db.commit()


@router.patch("/settings", response_model=HoursOverview)
async def update_hour_settings(
    body: HourSettingsUpdate,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_UPDATE),
    printer_scope: PrinterScope = RequestPrinterScope,
):
    """Set the reading reminder interval and return the refreshed overview."""
    await set_setting(db, "hours_reading_interval_days", str(body.reading_interval_days))
    await db.commit()
    return await _overview(db, date.today(), printer_scope)


@router.patch("/machines/{machine_id}", response_model=HourMachineOut)
async def update_machine(
    machine_id: int,
    body: HourMachineUpdate,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_UPDATE),
    printer_scope: PrinterScope = RequestPrinterScope,
):
    await ensure_hour_machines(db)
    changes = body.model_fields_set
    if changes & {"name", "model"}:
        machine = await _retired_machine(db, machine_id, printer_scope)
    else:
        machine = await _scoped_machine(db, machine_id, printer_scope)
        if machine is None:
            raise HTTPException(status_code=404, detail="Machine not found")
    if "purchase_price" in changes:
        machine.purchase_price = body.purchase_price
    if "purchase_date" in changes:
        machine.purchase_date = body.purchase_date
    if body.name is not None:
        others = (await db.execute(select(HourMachine.name).where(HourMachine.id != machine_id))).scalars()
        if body.name.strip().casefold() in {n.casefold() for n in others}:
            raise HTTPException(status_code=422, detail=f"A machine named {body.name} already exists")
        machine.name = body.name.strip()
    if body.model is not None:
        machine.model = body.model or None
    await db.commit()
    overview = await _overview(db, date.today(), printer_scope)
    return next(m for m in overview.machines if m.id == machine.id)


@router.delete("/machines/{machine_id}")
async def delete_machine(
    machine_id: int,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.MAINTENANCE_DELETE),
    printer_scope: PrinterScope = RequestPrinterScope,
):
    await ensure_hour_machines(db)
    machine = await _retired_machine(db, machine_id, printer_scope)
    # SQLite does not enforce the FK cascade; remove the history explicitly.
    await db.execute(delete(HourReading).where(HourReading.machine_id == machine.id))
    await db.execute(delete(HourEvent).where(HourEvent.machine_id == machine.id))
    await db.delete(machine)
    await db.commit()
    return {"status": "deleted"}
