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
import logging
import uuid
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core import database
from backend.app.models.library import LibraryFile
from backend.app.models.project_item import ProjectRevision
from backend.app.services import project_files
from backend.app.services.http_status_error import HttpStatusError
from backend.app.services.project_files import ProjectFilesError
from backend.app.services.project_reslice import output_filename
from backend.app.services.project_revisions import find_revision_bundle, lock_revision_rows
from backend.app.services.project_storage import claim_unique_file_path, revision_dir
from backend.app.services.slice_dispatch import http_exception_to_job_error, slice_dispatch
from backend.app.services.slicer_api import SlicerApiError
from backend.app.utils.threemf_tools import classify_3mf

logger = logging.getLogger(__name__)

NO_SLICER = "No slicer is configured in Settings"
_SOURCE_MISSING = "The revision's source .3mf is missing"
SLICE_ERROR_MAX_CHARS = 500


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


async def _start(db: AsyncSession, revision_id: int, *, user_id: int | None, resume: bool) -> int | None:
    revision = await db.get(ProjectRevision, revision_id, populate_existing=True)
    if revision is None:
        return None
    if not resume and revision.slice_status in ("slicing", "sliced"):
        return revision.slice_job_id
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
    except Exception as exc:
        await _mark_failed(db, revision_id, f"Could not start the slice: {exc}")  # not "slicing" with no job
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

    A revision already ``slicing`` or ``sliced`` is left alone (its current job id is
    returned); one without a source ``.3mf`` is too (``None``). Otherwise the revision
    becomes ``slicing`` and a ``project_revision`` job owned by ``user_id`` is enqueued."""
    return await _start(db, revision_id, user_id=user_id, resume=False)


async def start_slice_after_upload(db: AsyncSession, revision_id: int, *, user_id: int | None) -> int | None:
    """``start_revision_slice`` for a revision just uploaded; never raises (the upload is already
    committed and must succeed whatever the slicer does). The test suite turns this off for every
    test but the ones that test it (``backend/tests/conftest.py``), so uploads never reach a slicer."""
    try:
        return await start_revision_slice(db, revision_id, user_id=user_id)
    except Exception:
        logger.warning("Could not start the slice of project revision %s", revision_id, exc_info=True)
        try:
            await db.rollback()
        except Exception:
            logger.warning("Rollback after the failed slice start of revision %s failed", revision_id, exc_info=True)
        return None


async def on_revision_slice_done(
    db: AsyncSession, revision: ProjectRevision, sliced_file: LibraryFile | None, error: str | None
) -> None:
    """Called once a slice ends, inside its transaction, after the revision's own slice fields are set
    (``sliced`` with ``sliced_file``, or ``failed`` with ``error``); the caller commits.

    The revision side needs nothing more; this is where the queue items waiting for the
    revision's G-code follow it."""
    if error is None:
        logger.info("Project revision %s sliced (library file %s)", revision.id, sliced_file and sliced_file.id)
    else:
        logger.warning("Project revision %s slice failed: %s", revision.id, error)


def _error_status_and_message(exc: Exception) -> tuple[int, str]:
    if isinstance(exc, HttpStatusError):
        return exc.status_code, str(exc.detail)
    if isinstance(exc, HTTPException):
        return exc.status_code, str(exc.detail)
    if isinstance(exc, SlicerApiError):
        return 502, str(exc) or type(exc).__name__
    return 500, f"Unexpected error: {exc}"


async def _mark_failed(db: AsyncSession, revision_id: int, message: str) -> None:
    """``failed`` with ``message``, unless the revision is gone. Never raises: the slice's own error is the one
    the job reports."""
    try:
        await db.rollback()
        revision = await db.get(ProjectRevision, revision_id, populate_existing=True)
        if revision is None:
            return
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


async def _run_slice(revision_id: int, *, user_id: int | None, job_id: int) -> dict[str, Any]:
    """The background job: slice, store, mark ``sliced``; on any error mark ``failed`` and fail the job."""
    async with database.async_session() as db:
        try:
            return await _slice_revision(db, revision_id, user_id=user_id, job_id=job_id)
        except Exception as exc:
            status, message = _error_status_and_message(exc)
            await _mark_failed(db, revision_id, message)
            raise http_exception_to_job_error(HTTPException(status, message[:SLICE_ERROR_MAX_CHARS])) from exc


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
        "sliced_for_model": printer_model,
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
                    project.id,
                    revision.id,
                    dest,
                    file_type="gcode.3mf",
                    file_size=len(content),
                    file_hash=hashlib.sha256(content).hexdigest(),
                    thumbnail_path=None,
                    file_metadata=metadata,
                    created_by_id=user_id,
                )
                row.derived_slice = True
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
                await on_revision_slice_done(db, revision, row, None)
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
                await db.rollback()
    return resumed
