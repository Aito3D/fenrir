"""Machine-hours history behind the Maintenance → Hours tab.

Manual readings are the operator's lifetime hours off each printer's screen;
auto readings are Fenrir's own counter (runtime + offset), snapshotted daily.
A manual reading dated today also recalibrates the printer's counter — that
rule lives in the route, this module provides the pieces.
"""

import asyncio
import logging
from datetime import date, datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core import database as _database
from backend.app.models.maintenance import (
    HourEvent,
    HourMachine,
    HourReading,
    MaintenanceHistory,
    MaintenanceType,
    PrinterMaintenance,
)
from backend.app.models.printer import Printer

logger = logging.getLogger(__name__)

SOURCE_MANUAL = "manual"
SOURCE_AUTO = "auto"

EVENT_KINDS = ("note", "maintenance", "added", "retired", "calibrated")

DRIFT_FLOOR_HOURS = 24.0
DRIFT_FRACTION = 0.02


def current_hours(runtime_seconds: int | None, offset_hours: float | None) -> float:
    """Fenrir's counter: active runtime (RUNNING only, #1521) plus the operator baseline."""
    return (runtime_seconds or 0) / 3600.0 + (offset_hours or 0.0)


def trust_state(machine: HourMachine, last_manual_hours: float | None) -> tuple[str | None, float | None]:
    """How far to trust the machine's counter: ``(state, last_drift_hours)``; ``(None, None)`` when retired."""
    if machine.retired:
        return None, None
    if machine.calibrated_at is None:
        return "uncalibrated", None
    drift = machine.last_drift_hours
    if drift is not None and abs(drift) > max(DRIFT_FLOOR_HOURS, DRIFT_FRACTION * (last_manual_hours or 0.0)):
        return "drifting", drift
    return "calibrated", drift


def added_on(machine: HourMachine, first_manual: date | None, printer_created: date | None) -> date | None:
    """When the machine joined the fleet: the older of its first manual reading and its printer's creation."""
    candidates = [d for d in (first_manual, printer_created if machine.printer_id is not None else None) if d]
    return min(candidates) if candidates else None


def recalibrate_printer(printer: Printer, total_hours: float) -> float:
    """Set the offset so the printer's counter reads ``total_hours``. Returns runtime hours; caller commits."""
    runtime_hours = (printer.runtime_seconds or 0) / 3600.0
    printer.print_hours_offset = max(0.0, total_hours - runtime_hours)
    return runtime_hours


def _retire(db: AsyncSession, machine: HourMachine) -> None:
    """Unlink and retire ``machine``, logging a ``retired`` event the first time and dropping its trust state."""
    if not machine.retired:
        db.add(HourEvent(machine_id=machine.id, event_date=date.today(), kind="retired", label=machine.name))
    machine.printer_id = None
    machine.retired = True
    machine.calibrated_at = None
    machine.last_drift_hours = None


async def _sync_machines(db: AsyncSession) -> None:
    printers = {p.id: p for p in (await db.execute(select(Printer))).scalars().all()}
    machines = (await db.execute(select(HourMachine))).scalars().all()
    linked: set[int] = set()
    for m in machines:
        if m.printer_id is None:
            _retire(db, m)
            continue
        p = printers.get(m.printer_id)
        if p is None or (m.serial_number and p.serial_number != m.serial_number):
            _retire(db, m)
            continue
        linked.add(p.id)
        if (m.name, m.model, m.serial_number, m.retired) != (p.name, p.model, p.serial_number, False):
            m.name, m.model, m.serial_number, m.retired = p.name, p.model, p.serial_number, False
    # Release unlinked printer ids before inserting rows that claim them (printer_id is unique).
    await db.flush()
    for p in printers.values():
        if p.id not in linked:
            db.add(HourMachine(printer_id=p.id, name=p.name, model=p.model, serial_number=p.serial_number))
    await db.flush()


async def ensure_hour_machines(db: AsyncSession) -> list[HourMachine]:
    """Create/sync one machine per printer, retire orphans, and return every machine by name.

    Commits — call it before staging other writes in the same session.
    """
    try:
        await _sync_machines(db)
        await db.commit()
    except IntegrityError:
        # The hourly snapshot and a GET raced to create the same row; the winner's row is there now.
        await db.rollback()
        await _sync_machines(db)
        await db.commit()
    result = await db.execute(select(HourMachine).order_by(HourMachine.name, HourMachine.id))
    return list(result.scalars().all())


async def sync_events(db: AsyncSession, machines: list[HourMachine]) -> None:
    """Mirror maintenance history into ``hour_events`` and keep each machine's one ``added`` event on ``added_on``.

    Idempotent; never deletes; commits.
    """
    for machine in machines:
        known = (
            await db.execute(select(HourEvent.kind, HourEvent.source_id).where(HourEvent.machine_id == machine.id))
        ).all()
        seen_sources = {src for kind, src in known if kind == "maintenance"}
        if machine.printer_id is not None:
            rows = await db.execute(
                select(MaintenanceHistory.id, MaintenanceHistory.performed_at, MaintenanceType.name)
                .join(PrinterMaintenance, PrinterMaintenance.id == MaintenanceHistory.printer_maintenance_id)
                .join(MaintenanceType, MaintenanceType.id == PrinterMaintenance.maintenance_type_id)
                .where(PrinterMaintenance.printer_id == machine.printer_id)
            )
            for history_id, performed_at, type_name in rows.all():
                if history_id not in seen_sources:
                    db.add(
                        HourEvent(
                            machine_id=machine.id,
                            event_date=performed_at.date(),
                            kind="maintenance",
                            label=type_name,
                            source_id=history_id,
                        )
                    )
        first_manual = (
            await db.execute(
                select(func.min(HourReading.reading_date)).where(
                    HourReading.machine_id == machine.id, HourReading.source == SOURCE_MANUAL
                )
            )
        ).scalar_one_or_none()
        printer_created = None
        if machine.printer_id is not None:
            created = (
                await db.execute(select(Printer.created_at).where(Printer.id == machine.printer_id))
            ).scalar_one_or_none()
            printer_created = created.date() if created else None
        joined = added_on(machine, first_manual, printer_created)
        if joined is None:
            continue
        existing = (
            await db.execute(select(HourEvent).where(HourEvent.machine_id == machine.id, HourEvent.kind == "added"))
        ).scalar_one_or_none()
        if existing is None:
            db.add(HourEvent(machine_id=machine.id, event_date=joined, kind="added", label=machine.name))
        elif existing.event_date != joined:
            existing.event_date = joined  # an older reading arrived: the tick follows added_on
    await db.commit()


async def next_service_hours(db: AsyncSession, printer_id: int) -> float | None:
    """Printer hours at which the nearest enabled hour-based maintenance item falls due, or ``None``."""
    from backend.app.api.routes.maintenance import _get_printer_maintenance_internal  # route imports this module

    overview = await _get_printer_maintenance_internal(printer_id, db, commit=False)
    due = [
        item.current_hours + item.hours_until_due
        for item in overview.maintenance_items
        if item.enabled and item.interval_type == "hours"
    ]
    return min(due) if due else None


DEFAULT_READING_INTERVAL_DAYS = 90


async def reading_interval_days(db: AsyncSession) -> int:
    """Days after which a manual reading is stale (setting ``hours_reading_interval_days``, default 90)."""
    from backend.app.api.routes.settings import get_setting  # route imports this module

    try:
        value = int(await get_setting(db, "hours_reading_interval_days") or DEFAULT_READING_INTERVAL_DAYS)
    except ValueError:
        return DEFAULT_READING_INTERVAL_DAYS
    return value if value > 0 else DEFAULT_READING_INTERVAL_DAYS


def due_machine_ids(machines, readings, interval_days: int, today: date) -> list[int]:
    """Live machines whose newest manual reading is older than ``interval_days`` days, or missing."""
    newest: dict[int, date] = {}
    for r in readings:
        if r.source == SOURCE_MANUAL and r.reading_date > newest.get(r.machine_id, date.min):
            newest[r.machine_id] = r.reading_date
    return [
        m.id for m in machines if not m.retired and (m.id not in newest or (today - newest[m.id]).days > interval_days)
    ]


async def upsert_reading(
    db: AsyncSession,
    machine_id: int,
    reading_date: date,
    source: str,
    hours: float | None,
    raw_hours: float | None = None,
) -> None:
    """Insert or replace the (machine, date, source) reading; ``hours=None`` deletes it. No commit."""
    result = await db.execute(
        select(HourReading).where(
            HourReading.machine_id == machine_id,
            HourReading.reading_date == reading_date,
            HourReading.source == source,
        )
    )
    existing = result.scalar_one_or_none()
    if hours is None:
        if existing is not None:
            await db.delete(existing)
        return
    if existing is None:
        db.add(
            HourReading(
                machine_id=machine_id, reading_date=reading_date, source=source, hours=hours, raw_hours=raw_hours
            )
        )
    else:
        existing.hours = hours
        existing.raw_hours = raw_hours


async def machine_for_printer(db: AsyncSession, printer_id: int) -> HourMachine:
    """The machine row linked to ``printer_id``, creating rows first (commits via ``ensure_hour_machines``)."""
    for machine in await ensure_hour_machines(db):
        if machine.printer_id == printer_id:
            return machine
    raise ValueError(f"No hour machine for printer {printer_id}")


async def calibrate_machine(
    db: AsyncSession, machine: HourMachine, printer: Printer, total_hours: float, today: date
) -> float:
    """Recalibrate ``printer``'s counter to ``total_hours`` and record it on ``machine``.

    Returns the counter's actual value afterwards (the offset clamps at 0). Stamps ``calibrated_at``, stores the
    drift against the previous counter (``None`` on the first calibration), rewrites today's auto reading and adds a
    ``calibrated`` event. No commit.
    """
    counter_before = current_hours(printer.runtime_seconds, printer.print_hours_offset)
    first_time = machine.calibrated_at is None
    recalibrate_printer(printer, total_hours)
    actual = current_hours(printer.runtime_seconds, printer.print_hours_offset)
    machine.calibrated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    machine.last_drift_hours = None if first_time else counter_before - total_hours
    await upsert_reading(
        db, machine.id, today, SOURCE_AUTO, round(actual, 1), raw_hours=(printer.runtime_seconds or 0) / 3600.0
    )
    db.add(HourEvent(machine_id=machine.id, event_date=today, kind="calibrated", label=f"{total_hours:g} h"))
    return actual


async def snapshot_today(db: AsyncSession, today: date | None = None) -> int:
    """Write today's auto reading for every linked machine. Idempotent per day. Returns rows written."""
    today = today or date.today()
    machines = await ensure_hour_machines(db)
    rows = (await db.execute(select(Printer.id, Printer.runtime_seconds, Printer.print_hours_offset))).all()
    hours_by_printer = {pid: current_hours(runtime, offset) for pid, runtime, offset in rows}
    raw_by_printer = {pid: (runtime or 0) / 3600.0 for pid, runtime, _offset in rows}
    written = 0
    for m in machines:
        if m.retired or m.printer_id not in hours_by_printer:
            continue
        await upsert_reading(
            db,
            m.id,
            today,
            SOURCE_AUTO,
            round(hours_by_printer[m.printer_id], 1),
            raw_hours=raw_by_printer[m.printer_id],
        )
        written += 1
    await db.commit()
    return written


class PrinterHoursService:
    """Hourly sweep writing today's auto reading. Hourly, not at midnight, so a restart never loses a day."""

    def __init__(self):
        self._scheduler_task: asyncio.Task | None = None
        self._startup_delay = 60
        self._check_interval = 3600

    async def start_scheduler(self):
        if self._scheduler_task is not None:
            return
        logger.info("Starting printer hours snapshot sweeper")
        self._scheduler_task = asyncio.create_task(self._scheduler_loop())

    def stop_scheduler(self):
        if self._scheduler_task:
            self._scheduler_task.cancel()
            self._scheduler_task = None
            logger.info("Stopped printer hours snapshot sweeper")

    async def _scheduler_loop(self):
        delay = self._startup_delay
        while True:
            try:
                await asyncio.sleep(delay)
                delay = self._check_interval
                async with _database.async_session() as db:
                    written = await snapshot_today(db)
                logger.debug("Printer hours snapshot: %s machines", written)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning("Printer hours snapshot failed: %s", e)


printer_hours_service = PrinterHoursService()
