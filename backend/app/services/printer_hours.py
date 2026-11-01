"""Machine-hours history behind the Maintenance → Hours tab.

Manual readings are the operator's lifetime hours off each printer's screen;
auto readings are Fenrir's own counter (runtime + offset), snapshotted daily.
A manual reading dated today also recalibrates the printer's counter — that
rule lives in the route, this module provides the pieces.
"""

import asyncio
import logging
from datetime import date, datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core import database as _database
from backend.app.models.maintenance import HourEvent, HourMachine, HourReading
from backend.app.models.printer import Printer

logger = logging.getLogger(__name__)

SOURCE_MANUAL = "manual"
SOURCE_AUTO = "auto"

EVENT_KINDS = ("note", "maintenance", "added", "retired", "calibrated")


def current_hours(runtime_seconds: int | None, offset_hours: float | None) -> float:
    """Fenrir's counter: active runtime (RUNNING only, #1521) plus the operator baseline."""
    return (runtime_seconds or 0) / 3600.0 + (offset_hours or 0.0)


def recalibrate_printer(printer: Printer, total_hours: float) -> float:
    """Set the offset so the printer's counter reads ``total_hours``. Returns runtime hours; caller commits."""
    runtime_hours = (printer.runtime_seconds or 0) / 3600.0
    printer.print_hours_offset = max(0.0, total_hours - runtime_hours)
    return runtime_hours


async def _sync_machines(db: AsyncSession) -> None:
    printers = {p.id: p for p in (await db.execute(select(Printer))).scalars().all()}
    machines = (await db.execute(select(HourMachine))).scalars().all()
    linked: set[int] = set()
    for m in machines:
        if m.printer_id is None:
            m.retired = True
            continue
        p = printers.get(m.printer_id)
        if p is None or (m.serial_number and p.serial_number != m.serial_number):
            m.printer_id = None
            m.retired = True
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
