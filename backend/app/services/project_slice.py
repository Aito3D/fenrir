"""Server-side slicing of project revisions (design 2026-10-17, decisions 2, 4, 7, 9, 13).

A revision keeps its editable source ``.3mf``; the server slices it with the
file's own embedded settings (no presets), all plates in one sidecar call, and
stores the ``.gcode.3mf`` in the revision folder as a hidden library row
(``LibraryFile.derived_slice``) that ``ProjectRevision.sliced_file_id`` points at.

``ProjectRevision.slice_status`` is the state: ``None`` (never sliced), ``slicing``,
``sliced`` or ``failed`` (``slice_error`` says why). One slice per revision at a
time: a start only claims a revision that is not ``slicing`` or ``sliced``, with a
conditional UPDATE. The job runs on ``slice_dispatch`` with its own session; a
restart loses the in-memory jobs, so ``resume_interrupted_slices`` re-enqueues
every revision still marked ``slicing`` at startup.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import uuid
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core import database
from backend.app.core.config import settings
from backend.app.models.library import LibraryFile
from backend.app.models.print_queue import SLICE_WAIT_STATUSES, PrintQueueItem
from backend.app.models.project_item import ProjectRevision
from backend.app.services import project_files
from backend.app.services.http_status_error import HttpStatusError
from backend.app.services.project_files import ProjectFilesError
from backend.app.services.project_reslice import output_filename
from backend.app.services.project_revisions import find_revision_bundle, lock_revision_rows
from backend.app.services.project_snapshot import _MAX_PART_BYTES
from backend.app.services.project_storage import claim_unique_file_path, revision_dir
from backend.app.services.slice_dispatch import http_exception_to_job_error, slice_dispatch
from backend.app.services.slicer_api import SlicerApiError
from backend.app.utils.printer_models import is_gcode_compatible, normalize_printer_model
from backend.app.utils.threemf_tools import classify_3mf, extract_print_time_from_3mf

logger = logging.getLogger(__name__)

NO_SLICER = "No slicer is configured in Settings"
_SOURCE_MISSING = "The revision's source .3mf is missing"
SLICE_ERROR_MAX_CHARS = 500
UNEXPECTED_SLICE_ERROR = "Unexpected error while slicing"
COULD_NOT_START_SLICE = "Could not start the slice"
NOT_THE_SOURCE = "This file is not the revision's source; upload it as its own item."
NO_PROJECT_TO_SLICE = "This .3mf holds no Bambu Studio project to slice, so it cannot be printed."


async def _source_file(db: AsyncSession, revision_id: int) -> LibraryFile | None:
    """The revision's source ``.3mf``: its first non-derived ``.3mf`` whose content is a project
    (``classify_3mf`` says ``source``; a ``.gcode.3mf``, renamed or not, is not one)."""
    rows = (
        (
            await db.execute(
                select(LibraryFile)
                .where(LibraryFile.revision_id == revision_id, LibraryFile.derived_slice.is_(False))
                .order_by(LibraryFile.id)
            )
        )
        .scalars()
        .all()
    )
    for row in rows:
        if not row.filename.lower().endswith(".3mf"):
            continue
        path = project_files.revision_file_path(row.file_path)
        if path is not None and await asyncio.to_thread(classify_3mf, path) == "source":
            return row
    return None


def is_unsliced_project_source(library_file: LibraryFile) -> bool:
    """A project revision's own .3mf (not its hidden derived slice, not a .gcode.3mf)."""
    return library_file.revision_id is not None and not library_file.derived_slice and library_file.file_type == "3mf"


async def sliced_file_of(db: AsyncSession, library_file: LibraryFile) -> LibraryFile | None:
    """The server slice of ``library_file`` (an unsliced project ``.3mf``) when its revision is
    ``sliced`` and the row is still live, else None (not sliced yet).

    The slice is made from the revision's source ``.3mf`` only; any other ``.3mf`` a legacy
    revision holds has no slice and is refused (400), so it never prints another file's G-code."""
    revision_id = library_file.revision_id
    if revision_id is None:
        return None
    source = await _source_file(db, revision_id)
    if source is None:
        raise HTTPException(400, NO_PROJECT_TO_SLICE)
    if source.id != library_file.id:
        raise HTTPException(400, NOT_THE_SOURCE)
    revision = await db.get(ProjectRevision, revision_id)
    if revision is None or revision.slice_status != "sliced" or revision.sliced_file_id is None:
        return None
    return (
        await db.execute(LibraryFile.active().where(LibraryFile.id == revision.sliced_file_id))
    ).scalar_one_or_none()


# Revisions a start in this process is claiming or enqueuing (between its claim and its job id write).
_starting: set[int] = set()


async def _claim(db: AsyncSession, revision_id: int, *, resume: bool) -> bool:
    """Mark the revision ``slicing`` unless another slice holds it; True when this call claimed it.

    A plain start claims a revision that was never sliced or failed; a resume re-claims
    one left ``slicing`` by a restart (its in-memory job is gone)."""
    claimable = (
        ProjectRevision.slice_status == "slicing"
        if resume
        else or_(ProjectRevision.slice_status.is_(None), ProjectRevision.slice_status == "failed")
    )
    claimed = (
        await db.execute(
            update(ProjectRevision)
            .where(ProjectRevision.id == revision_id, claimable)
            .values(slice_status="slicing", slice_error=None)
            .returning(ProjectRevision.id)
            .execution_options(synchronize_session="fetch")
        )
    ).first()
    await db.commit()
    return claimed is not None


def _job_is_live(job_id: int | None) -> bool:
    """True while ``slice_dispatch`` still has the job pending or running (the in-memory job is
    gone after a restart, and a finished job does not hold its revision)."""
    job = slice_dispatch.get(job_id) if job_id is not None else None
    return job is not None and job.status in ("pending", "running")


async def _start(db: AsyncSession, revision_id: int, *, user_id: int | None, resume: bool) -> int | None:
    revision = await db.get(ProjectRevision, revision_id, populate_existing=True)
    if revision is None:
        return None
    if not resume and revision.slice_status == "sliced":
        return revision.slice_job_id
    if not resume and revision.slice_status == "slicing":
        # A start between another's claim and its job id is still in flight: leave it alone. A
        # revision whose job is gone (its failure could not be recorded) is interrupted: re-claim it.
        if revision_id in _starting or _job_is_live(revision.slice_job_id):
            return revision.slice_job_id
        resume = True
    _starting.add(revision_id)
    try:
        return await _start_claimed(db, revision_id, user_id=user_id, resume=resume)
    finally:
        _starting.discard(revision_id)


async def _start_claimed(db: AsyncSession, revision_id: int, *, user_id: int | None, resume: bool) -> int | None:
    source = await _source_file(db, revision_id)
    if source is None:
        return None
    source_name = source.filename
    if not await _claim(db, revision_id, resume=resume):
        # another start won the race between the read above and the claim
        current = await db.get(ProjectRevision, revision_id, populate_existing=True)
        return current.slice_job_id if current is not None else None

    async def run(job_id: int) -> dict[str, Any]:
        return await _run_slice(revision_id, user_id=user_id, job_id=job_id)

    try:
        job = await slice_dispatch.enqueue(
            kind="project_revision", source_id=revision_id, source_name=source_name, owner_id=user_id, run=run
        )
    except Exception:
        # The revision card and the queue items show a generic reason: the raw error can carry server paths.
        logger.warning("Could not start the slice of project revision %s", revision_id, exc_info=True)
        await _mark_failed(db, revision_id, COULD_NOT_START_SLICE)  # not "slicing" with no job
        raise
    # Only this column: the job may already be writing its outcome to the same row.
    await db.execute(
        update(ProjectRevision)
        .where(ProjectRevision.id == revision_id)
        .values(slice_job_id=job.id)
        .execution_options(synchronize_session="fetch")
    )
    await db.commit()
    return job.id


async def start_revision_slice(db: AsyncSession, revision_id: int, *, user_id: int | None) -> int | None:
    """Slice the revision's source ``.3mf`` in the background; returns the job id. Commits.

    A revision already ``sliced``, or ``slicing`` with a live job, is left alone (its current
    job id is returned); one without a source ``.3mf`` is too (``None``). A revision left
    ``slicing`` whose job is gone (its failure could not be recorded) is re-claimed like a
    resume. Otherwise the revision becomes ``slicing`` and a ``project_revision`` job owned by
    ``user_id`` is enqueued."""
    return await _start(db, revision_id, user_id=user_id, resume=False)


async def start_slice_after_upload(db: AsyncSession, revision_id: int, *, user_id: int | None) -> int | None:
    """``start_revision_slice`` for a revision just uploaded; never raises (the upload is already
    committed and must succeed whatever the slicer does). The test suite turns this off for every
    test but the ones that test it (``backend/tests/conftest.py``), so uploads never reach a slicer."""
    try:
        return await start_revision_slice(db, revision_id, user_id=user_id)
    except Exception:
        logger.warning("Could not start the slice of project revision %s", revision_id, exc_info=True)
        await _rollback_quietly(db, f"the failed slice start of revision {revision_id}")
        return None


async def _rollback_quietly(db: AsyncSession, what: str) -> None:
    try:
        await db.rollback()
    except Exception:
        logger.warning("Rollback after %s failed", what, exc_info=True)


async def settle_waiting_queue_items_quietly(db: AsyncSession, revision_id: int) -> None:
    """``settle_waiting_queue_items`` for a caller whose own work is already committed; never raises.
    An item it could not settle stays ``slicing`` and ``recover_waiting_queue_items`` picks it up."""
    try:
        await settle_waiting_queue_items(db, revision_id)
    except Exception:
        logger.warning("Could not settle the queue items waiting on project revision %s", revision_id, exc_info=True)
        await _rollback_quietly(db, f"the failed settle of revision {revision_id}")


async def start_slice_for_waiting_items(db: AsyncSession, revision_id: int, *, user_id: int | None) -> None:
    """Start (or join) the revision's slice for queue items already committed as ``slicing``, then
    settle them against whatever the slice already did. Never raises: the items exist either way;
    a failed start leaves them ``slice_failed`` with its reason, a failed settle leaves them for
    the startup sweep."""
    try:
        await start_revision_slice(db, revision_id, user_id=user_id)
    except Exception:
        logger.warning("Could not start the slice of project revision %s for the queue", revision_id, exc_info=True)
        await _rollback_quietly(db, f"the failed slice start of revision {revision_id}")
    await settle_waiting_queue_items_quietly(db, revision_id)


async def on_revision_slice_done(
    db: AsyncSession,
    revision: ProjectRevision,
    sliced_file: LibraryFile | None,
    error: str | None,
    facts: _OutcomeFacts | None = None,
) -> None:
    """Called once a slice ends, inside its transaction, after the revision's own slice fields are set
    (``sliced`` with ``sliced_file``, or ``failed`` with ``error``); the caller commits.

    The queue items waiting for the revision's G-code follow it (``settle_waiting_queue_items``
    covers an item committed after this ran). ``facts``: the file reads ``_store`` made before it took
    the write lock."""
    if error is None:
        logger.info("Project revision %s sliced (library file %s)", revision.id, sliced_file and sliced_file.id)
    else:
        logger.warning("Project revision %s slice failed: %s", revision.id, error)
    # The revision's own write first: on SQLite it takes the write lock, on PostgreSQL the row
    # lock ``settle_waiting_queue_items`` waits on, so an item committed after the read below is
    # seen by that settle, never by neither.
    await db.flush()
    await _apply_slice_outcome(db, revision.id, sliced_file, error, facts)


def library_file_print_time(library_file: LibraryFile, plate_id: int | None) -> int | None:
    """The file's predicted print time: the plate's own when ``plate_id`` is set and the file
    says, else the file's whole estimate from its metadata."""
    print_time = (library_file.file_metadata or {}).get("print_time_seconds")
    if plate_id:
        lib_path = Path(library_file.file_path)
        path = lib_path if lib_path.is_absolute() else settings.base_dir / library_file.file_path
        if path.exists():
            plate_time = extract_print_time_from_3mf(path, plate_id)
            if plate_time is not None:
                print_time = plate_time
    return print_time


def _gcode_filament_types(sliced_file: LibraryFile, plate_id: int | None) -> set[str]:
    """The filament types the sliced G-code names for ``plate_id`` (none when its file is missing)."""
    from backend.app.api.routes.print_queue import _extract_filament_types_from_3mf  # routes import this module

    lib_path = Path(sliced_file.file_path)
    path = lib_path if lib_path.is_absolute() else settings.base_dir / sliced_file.file_path
    return set(_extract_filament_types_from_3mf(path, plate_id)) if path.exists() else set()


def _required_filament_types(item: PrintQueueItem, gcode_types: set[str] | Exception) -> str | None:
    """A model-based item's filament types, read from the G-code now that it exists (queue time
    read the source; ``gcode_types`` is what that read found, or the error it raised), plus what
    the item's overrides and earlier read named, as ``add_to_queue`` merges them."""
    try:
        types: set[str] = set(json.loads(item.required_filament_types)) if item.required_filament_types else set()
        if isinstance(gcode_types, Exception):
            raise gcode_types
        types |= gcode_types
        if item.filament_overrides:
            types |= {o["type"] for o in json.loads(item.filament_overrides) if isinstance(o, dict) and "type" in o}
    except (ValueError, TypeError):  # a malformed stored list must not undo the slice it rides on
        logger.warning("Queue item %s: unreadable filament types, left as they were", item.id, exc_info=True)
        return item.required_filament_types
    return json.dumps(sorted(types)) if types else None


class _OutcomeFacts:
    """What a landing slice reads from files for its waiting items: the revision's source id, and the
    print time and G-code filament types per plate, each read once however many items wait on the plate.

    ``_store`` fills them before it takes the database's write lock (``_read_outcome_facts``); the
    outcome then runs row writes only. A plate nobody read yet (an item committed meanwhile) is read
    on first use, so the values are the same either way."""

    def __init__(self) -> None:
        self._source_known = False
        self._source_id: int | None = None
        self._print_times: dict[int | None, int | None] = {}
        self._gcode_types: dict[int | None, set[str] | Exception] = {}

    async def source_id(self, db: AsyncSession, revision_id: int) -> int | None:
        if not self._source_known:
            source = await _source_file(db, revision_id)
            self._source_id = source.id if source is not None else None
            self._source_known = True
        return self._source_id

    async def print_time(self, sliced_file: LibraryFile, plate_id: int | None) -> int | None:
        if plate_id not in self._print_times:
            self._print_times[plate_id] = await asyncio.to_thread(library_file_print_time, sliced_file, plate_id)
        return self._print_times[plate_id]

    async def gcode_types(self, sliced_file: LibraryFile, plate_id: int | None) -> set[str] | Exception:
        if plate_id not in self._gcode_types:
            try:
                self._gcode_types[plate_id] = await asyncio.to_thread(_gcode_filament_types, sliced_file, plate_id)
            except Exception as exc:  # raised again where the item uses it, as a direct read would
                self._gcode_types[plate_id] = exc
        return self._gcode_types[plate_id]


def _fails_cross_model_gate(sliced_file: LibraryFile, item: PrintQueueItem) -> bool:
    """Cross-model gate (#2578), deferred from queue time: there was no G-code to read then."""
    sliced_for = (sliced_file.file_metadata or {}).get("sliced_for_model")
    return bool(item.target_model) and not is_gcode_compatible(sliced_for, item.target_model)


async def _read_outcome_facts(db: AsyncSession, revision_id: int, sliced_file: LibraryFile) -> _OutcomeFacts:
    """Read, for the items waiting now, everything ``_apply_slice_outcome`` would read from files."""
    facts = _OutcomeFacts()
    for item in await _waiting_items(db, revision_id, SLICE_WAIT_STATUSES, facts):
        if _fails_cross_model_gate(sliced_file, item):
            continue
        await facts.print_time(sliced_file, item.plate_id)
        if item.target_model:
            await facts.gcode_types(sliced_file, item.plate_id)
    return facts


async def source_file_of(db: AsyncSession, revision_id: int) -> LibraryFile | None:
    """The revision's source ``.3mf``: the one file its slice is made from (None when it has none)."""
    return await _source_file(db, revision_id)


async def _waiting_items(
    db: AsyncSession, revision_id: int, statuses: tuple[str, ...], facts: _OutcomeFacts
) -> list[PrintQueueItem]:
    """Queue items in ``statuses`` on the revision's source ``.3mf``: the slice is that file's G-code
    only, never another ``.3mf`` a legacy revision also holds."""
    source_id = await facts.source_id(db, revision_id)
    if source_id is None:
        return []
    return list(
        (
            await db.execute(
                select(PrintQueueItem).where(
                    PrintQueueItem.status.in_(statuses), PrintQueueItem.library_file_id == source_id
                )
            )
        )
        .scalars()
        .all()
    )


async def _slicing_items_of_revision(db: AsyncSession, revision_id: int) -> list[PrintQueueItem]:
    """Every ``slicing`` queue item on a non-derived file of the revision, whether or not the source
    ``.3mf`` can still be read: a failed slice must reach them all, or they wait forever."""
    return list(
        (
            await db.execute(
                select(PrintQueueItem).where(
                    PrintQueueItem.status == "slicing",
                    PrintQueueItem.library_file_id.in_(
                        select(LibraryFile.id).where(
                            LibraryFile.revision_id == revision_id, LibraryFile.derived_slice.is_(False)
                        )
                    ),
                )
            )
        )
        .scalars()
        .all()
    )


async def _move_waiting_item(db: AsyncSession, item_id: int, statuses: tuple[str, ...], **values: Any) -> bool:
    """Write ``values`` onto the item only while it is still in ``statuses`` (a conditional UPDATE: a cancel
    or delete that landed since the item was read stays as it is). True when the row matched."""
    moved = (
        await db.execute(
            update(PrintQueueItem)
            .where(PrintQueueItem.id == item_id, PrintQueueItem.status.in_(statuses))
            .values(**values)
            .returning(PrintQueueItem.id)
            .execution_options(synchronize_session="fetch")
        )
    ).first()
    return moved is not None


async def _apply_slice_outcome(
    db: AsyncSession,
    revision_id: int,
    sliced_file: LibraryFile | None,
    error: str | None,
    facts: _OutcomeFacts | None = None,
) -> None:
    """Success: every item waiting on the revision's source (``slicing``, or ``slice_failed`` from an
    earlier attempt) moves onto the G-code as ``pending``. Failure: every ``slicing`` item on the
    revision's files becomes ``slice_failed`` with the reason, even once the source is gone. Does not commit.

    Each item is written with a conditional UPDATE on its waiting status, so an item cancelled or
    deleted since it was read (PostgreSQL's READ COMMITTED lets that happen) is skipped, never undone.
    ``facts`` carries the file reads made ahead of the write lock (``_read_outcome_facts``)."""
    facts = facts or _OutcomeFacts()
    if sliced_file is not None and error is None:
        sliced_for = (sliced_file.file_metadata or {}).get("sliced_for_model")
        for item in await _waiting_items(db, revision_id, SLICE_WAIT_STATUSES, facts):
            if _fails_cross_model_gate(sliced_file, item):
                await _move_waiting_item(
                    db,
                    item.id,
                    SLICE_WAIT_STATUSES,
                    status="slice_failed",
                    error_message=f"File was sliced for {sliced_for} and cannot be dispatched to {item.target_model} printers",
                )
                continue
            values: dict[str, Any] = {
                "library_file_id": sliced_file.id,
                "status": "pending",
                "error_message": None,
                "print_time_seconds": await facts.print_time(sliced_file, item.plate_id),
            }
            if item.target_model:
                values["required_filament_types"] = _required_filament_types(
                    item, await facts.gcode_types(sliced_file, item.plate_id)
                )
            await _move_waiting_item(db, item.id, SLICE_WAIT_STATUSES, **values)
        return
    for item in await _slicing_items_of_revision(db, revision_id):
        await _move_waiting_item(
            db,
            item.id,
            ("slicing",),
            status="slice_failed",
            error_message=(error or "The slice failed")[:SLICE_ERROR_MAX_CHARS],
        )


async def settle_waiting_queue_items(db: AsyncSession, revision_id: int) -> None:
    """Bring the revision's waiting queue items in line with its slice state now. Commits.

    For a caller that just committed ``slicing`` items: the slice may have ended before they
    existed, and its completion hook then found nothing to move. Under the revision's row lock
    (PostgreSQL; SQLite's single writer already orders the two), so a slice committing
    concurrently is either seen here or sees the items. A revision with no slice state left
    after a start (no source .3mf to slice, or a start that failed before claiming it) fails
    the items: they would otherwise wait for a slice that never comes."""
    await lock_revision_rows(db, [revision_id], share=True)
    revision = await db.get(ProjectRevision, revision_id, populate_existing=True)
    if revision is not None and revision.slice_status != "slicing":
        sliced_file = None
        if revision.slice_status == "sliced" and revision.sliced_file_id is not None:
            sliced_file = await db.get(LibraryFile, revision.sliced_file_id)
        if sliced_file is not None and sliced_file.deleted_at is None:
            await _apply_slice_outcome(db, revision_id, sliced_file, None)
        elif revision.slice_status == "sliced":
            await _apply_slice_outcome(db, revision_id, None, "The revision's sliced file is gone")
        else:
            await _apply_slice_outcome(db, revision_id, None, revision.slice_error or "The slice could not start")
    await db.commit()


def _error_status_and_message(exc: Exception) -> tuple[int, str]:
    if isinstance(exc, HttpStatusError):
        return exc.status_code, str(exc.detail)
    if isinstance(exc, HTTPException):
        return exc.status_code, str(exc.detail)
    if isinstance(exc, SlicerApiError):
        return 502, str(exc) or type(exc).__name__
    # Anything else (a disk or permission failure...) can carry server paths in its text: log it, show a generic reason.
    logger.error("Unexpected error while slicing a project revision", exc_info=exc)
    return 500, UNEXPECTED_SLICE_ERROR


async def _mark_failed(db: AsyncSession, revision_id: int, message: str) -> None:
    """``failed`` with ``message``, unless the revision is gone. Never raises: the slice's own error is the one
    the job reports."""
    try:
        await db.rollback()
        revision = await db.get(ProjectRevision, revision_id, populate_existing=True)
        if revision is None or revision.slice_status == "sliced":
            return  # gone, or another slice already landed: its G-code stands
        revision.slice_status = "failed"
        revision.slice_error = message[:SLICE_ERROR_MAX_CHARS]
        await on_revision_slice_done(db, revision, None, revision.slice_error)
        await db.commit()
    except Exception:
        logger.exception("Could not record the failed slice of project revision %s", revision_id)
        try:
            await db.rollback()
        except Exception:
            logger.warning("Rollback after recording a failed slice raised", exc_info=True)


# At most this many project slices run at once; the others wait their turn before reading their source
# or calling the sidecar (a bulk move or a startup resume would otherwise start one sidecar call per
# revision). A waiting job looks like a job the sidecar has not answered yet: ``running``, no progress;
# the stall clock only starts with its sidecar call.
_MAX_CONCURRENT_SLICES = 2
# One semaphore per event loop: an asyncio.Semaphore binds to the loop it first waits on.
_slice_slots: tuple[asyncio.AbstractEventLoop, asyncio.Semaphore] | None = None


def _slice_slot() -> asyncio.Semaphore:
    global _slice_slots
    loop = asyncio.get_running_loop()
    if _slice_slots is None or _slice_slots[0] is not loop:
        _slice_slots = (loop, asyncio.Semaphore(_MAX_CONCURRENT_SLICES))
    return _slice_slots[1]


async def _run_slice(revision_id: int, *, user_id: int | None, job_id: int) -> dict[str, Any]:
    """The background job: slice, store, mark ``sliced``; on any error mark ``failed`` and fail the job."""
    async with _slice_slot(), database.async_session() as db:
        try:
            return await _slice_revision(db, revision_id, user_id=user_id, job_id=job_id)
        except Exception as exc:
            status, message = _error_status_and_message(exc)
            await _mark_failed(db, revision_id, message)
            raise http_exception_to_job_error(HTTPException(status, message[:SLICE_ERROR_MAX_CHARS])) from exc


_SETTINGS_PART = "Metadata/project_settings.config"
_SETTINGS_TOO_BIG = "The .3mf's project settings are too large to slice (over {limit} MB)"
_SOURCE_TOO_BIG = "The .3mf is too large once unpacked to slice (over {limit} MB)"


def check_source_within_caps(model_bytes: bytes) -> None:
    """Refuse a source whose settings part or declared unpacked size is over the caps.

    The sanitiser inflates ``project_settings.config`` (and rewrites every entry) in memory, so a
    zip bomb would take the process down. ``zipfile`` stops a read at the entry's declared size, so
    the declared sizes are the bound. Caps: ``project_snapshot._MAX_PART_BYTES`` for the settings
    part, ``library_max_zip_extract_bytes`` for the whole archive. Not a zip: left to the slicer.
    Also run by ``project_reslice.prepare_reslice`` before a Re-slice job is enqueued."""
    try:
        with zipfile.ZipFile(BytesIO(model_bytes)) as zf:
            max_total = settings.library_max_zip_extract_bytes
            if sum(info.file_size for info in zf.infolist()) > max_total:
                raise ProjectFilesError(413, _SOURCE_TOO_BIG.format(limit=max_total // (1024 * 1024)))
            try:
                declared = zf.getinfo(_SETTINGS_PART).file_size
            except KeyError:
                return
            if declared > _MAX_PART_BYTES:
                raise ProjectFilesError(413, _SETTINGS_TOO_BIG.format(limit=_MAX_PART_BYTES // (1024 * 1024)))
    except zipfile.BadZipFile:
        return


async def _slice_revision(db: AsyncSession, revision_id: int, *, user_id: int | None, job_id: int) -> dict[str, Any]:
    from backend.app.api.routes.library import resolve_slicer_api_url
    from backend.app.services.slicer_api import SlicerApiService, get_stall_timeout_seconds
    from backend.app.utils.threemf_tools import sanitize_project_settings_sentinels

    bundle = await find_revision_bundle(db, revision_id)
    if bundle is None:
        return {}
    revision, _item, _project = bundle
    printer_model = (revision.print_profile or {}).get("printer_model")
    source = await _source_file(db, revision_id)
    path = project_files.revision_file_path(source.file_path) if source is not None else None
    if source is None or path is None:
        raise ProjectFilesError(404, _SOURCE_MISSING)
    source_name = source.filename
    try:
        model_bytes = await asyncio.to_thread(path.read_bytes)
    except OSError as exc:
        raise ProjectFilesError(404, f"{_SOURCE_MISSING} on disk") from exc
    await asyncio.to_thread(check_source_within_caps, model_bytes)
    url = await resolve_slicer_api_url(db)
    if url is None:
        raise ProjectFilesError(400, NO_SLICER)
    timeout = await get_stall_timeout_seconds(db)
    await db.commit()  # end the read transaction: the slice can take minutes

    def on_progress(snapshot: dict) -> None:
        slice_dispatch.set_progress(job_id, snapshot)

    async with SlicerApiService(url, timeout_seconds=timeout) as service:
        result = await service.slice_without_profiles(
            model_bytes=await asyncio.to_thread(sanitize_project_settings_sentinels, model_bytes),
            model_filename=source_name,
            plate=0,
            export_3mf=True,
            request_id=uuid.uuid4().hex,
            on_progress=on_progress,
        )
    metadata = {
        "print_time_seconds": result.print_time_seconds,
        "filament_used_grams": result.filament_used_g,
        # Short name ("X1C"), as every other sliced file stores it: the queue's cross-model gate
        # (is_gcode_compatible) does not match "Bambu Lab X1C" against an "X1C" target.
        "sliced_for_model": normalize_printer_model(printer_model),
    }
    return await _store(
        db,
        revision_id,
        output_filename(source_name),
        result.content,
        metadata,
        slice_dispatch.owner_now(job_id, user_id),
    )


def _write_claimed(dest: Path, content: bytes) -> None:
    with project_files._open_claimed(dest) as writer:
        writer.write(content)


async def _store(
    db: AsyncSession, revision_id: int, filename: str, content: bytes, metadata: dict, user_id: int | None
) -> dict[str, Any]:
    """Write the slice into the revision folder and point the revision at it. Commits.

    Under the item lock, like every write into an item folder, so a rename, delete or fork
    never runs under it. A revision deleted while slicing (or during this step) gets
    nothing: no row, no file, ``{}``."""
    bundle = await find_revision_bundle(db, revision_id)
    if bundle is None:
        return {}
    item_id = bundle[1].id
    async with project_files._item_lock(item_id):
        bundle = await find_revision_bundle(db, revision_id)
        if bundle is None:
            return {}
        revision, item, project = bundle
        await db.refresh(revision)
        await db.refresh(item)
        if revision.slice_status == "sliced":
            return {}  # someone else's slice already landed
        await project_files._claim_storage_dir(db, project)
        folder = revision_dir(project, item.section, item.name, revision.number)
        dest = await asyncio.to_thread(claim_unique_file_path, folder, filename)
        result: dict[str, Any] = {}

        async def undo() -> None:
            await db.rollback()
            project_files._unlink_quietly(dest)

        try:
            async with project_files._CommitGuard(db, undo, label=f"slice of revision {revision_id}") as commit:
                await asyncio.to_thread(_write_claimed, dest, content)
                row = project_files._new_library_row(
                    project_files._RowOwner(project.id, revision.id, user_id),
                    dest,
                    file_type="gcode.3mf",
                    file_size=len(content),
                    file_hash=hashlib.sha256(content).hexdigest(),
                    thumbnail_path=None,
                    file_metadata=metadata,
                )
                row.derived_slice = True
                # The source id and the waiting items' print times and filament types are read from
                # the files now, before the flush takes the write lock.
                facts = await _read_outcome_facts(db, revision_id, row)
                db.add(row)
                await db.flush()
                # The flush holds SQLite's write lock (PostgreSQL: the row lock below): a revision
                # deleted since it was read would strand this row and file, so undo them instead.
                still = await lock_revision_rows(db, [revision_id], share=True)
                exists = (
                    await db.execute(select(ProjectRevision.id).where(ProjectRevision.id == revision_id))
                ).first() is not None
                if not exists or (still is not None and revision_id not in still):
                    raise _RevisionGone
                revision.sliced_file_id = row.id
                revision.slice_status = "sliced"
                revision.slice_error = None
                await on_revision_slice_done(db, revision, row, None, facts)
                result = {
                    "revision_id": revision.id,
                    "file_id": row.id,
                    "filename": row.filename,
                    "print_time_seconds": metadata["print_time_seconds"],
                    "filament_used_grams": metadata["filament_used_grams"],
                }
                await commit()
        except _RevisionGone:
            project_files._remove_empty(folder)  # revision_dir re-created it
            return {}
    return result


class _RevisionGone(Exception):
    """Raised inside ``_store``'s commit guard to undo the write of a revision deleted meanwhile."""


async def resume_interrupted_slices() -> int:
    """Startup: re-enqueue every revision a restart left ``slicing`` (its job died with the process).

    Each gets a new job (owned by the revision's creator) and its new ``slice_job_id``; one whose
    source ``.3mf`` is gone is marked ``failed`` instead. Returns how many were re-enqueued."""
    resumed = 0
    async with database.async_session() as db:
        rows = (
            await db.execute(
                select(ProjectRevision.id, ProjectRevision.created_by_id)
                .where(ProjectRevision.slice_status == "slicing")
                .order_by(ProjectRevision.id)
            )
        ).all()
        await db.commit()
        for revision_id, created_by_id in rows:
            try:
                if await _source_file(db, revision_id) is None:
                    await _mark_failed(db, revision_id, _SOURCE_MISSING)
                    continue
                if await _start(db, revision_id, user_id=created_by_id, resume=True) is not None:
                    resumed += 1
            except Exception:
                logger.exception("Could not resume the slice of project revision %s", revision_id)
                await _rollback_quietly(db, f"the failed resume of revision {revision_id}")
    return resumed


async def recover_waiting_queue_items() -> int:
    """Startup, after ``resume_interrupted_slices``: queue items still ``slicing`` on a revision that is
    not (a settle that failed after their commit, a crash between the two) would wait forever.
    Each such revision's slice is started (or, already ``sliced``, just applied) and its items
    settled. Returns how many revisions were recovered."""
    async with database.async_session() as db:
        rows = (
            await db.execute(
                select(ProjectRevision.id, ProjectRevision.created_by_id)
                .join(LibraryFile, LibraryFile.revision_id == ProjectRevision.id)
                .join(PrintQueueItem, PrintQueueItem.library_file_id == LibraryFile.id)
                .where(
                    PrintQueueItem.status == "slicing",
                    or_(ProjectRevision.slice_status.is_(None), ProjectRevision.slice_status != "slicing"),
                )
                .distinct()
                .order_by(ProjectRevision.id)
            )
        ).all()
        await db.commit()
        for revision_id, created_by_id in rows:
            logger.info("Recovering queue items stranded in 'slicing' on project revision %s", revision_id)
            await start_slice_for_waiting_items(db, revision_id, user_id=created_by_id)
    return len(rows)


async def hold_unsliced_dispatch(db: AsyncSession, item: PrintQueueItem, library_file: LibraryFile) -> bool:
    """Dispatch-time guard: a printer never receives a project's unsliced ``.3mf``, whatever path
    queued the item (rows queued before server slicing, batch clones, any future writer).

    False: dispatch may go on, with the item repointed at the revision's G-code when it is the
    source of a ``sliced`` revision. True: the item must not be sent; it now waits in
    ``slicing`` with the slice started, or is ``slice_failed`` (not the revision's source).
    Commits whatever it changed."""
    if not is_unsliced_project_source(library_file):
        return False
    path = project_files.revision_file_path(library_file.file_path)
    if path is None or await asyncio.to_thread(classify_3mf, path) != "source":
        # Not a project by content: legacy G-code under a plain .3mf name prints as is, and a
        # missing or unreadable file fails on the dispatch path's own checks.
        return False
    revision_id = library_file.revision_id
    if revision_id is None:  # is_unsliced_project_source said otherwise; for the type checker
        return False
    try:
        sliced_file = await sliced_file_of(db, library_file)
    except HTTPException as exc:
        await _set_waiting_status(db, item.id, "slice_failed", str(exc.detail))
        logger.warning("Queue item %s held at dispatch: %s", item.id, exc.detail)
        return True
    if sliced_file is not None:
        item.library_file_id = sliced_file.id
        item.print_time_seconds = await asyncio.to_thread(library_file_print_time, sliced_file, item.plate_id)
        await db.commit()
        logger.info("Queue item %s dispatches the slice of project revision %s", item.id, revision_id)
        return False
    if await _set_waiting_status(db, item.id, "slicing", None):
        logger.info("Queue item %s held at dispatch until project revision %s is sliced", item.id, revision_id)
        await start_slice_for_waiting_items(db, revision_id, user_id=item.created_by_id)
    return True


async def _set_waiting_status(db: AsyncSession, item_id: int, status: str, error: str | None) -> bool:
    """Move a still-``pending`` item to ``status`` (a cancel may have won meanwhile). Commits."""
    moved = (
        await db.execute(
            update(PrintQueueItem)
            .where(PrintQueueItem.id == item_id, PrintQueueItem.status == "pending")
            .values(status=status, error_message=error)
            .returning(PrintQueueItem.id)
            .execution_options(synchronize_session="fetch")
        )
    ).first()
    await db.commit()
    return moved is not None
