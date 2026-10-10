"""Re-trancher: re-slice a project 3MF revision with a saved pipeline (spec §12.1).

The slicer writes its output as a loose library file; this copies it into the
next revision of the SAME item and always deletes that intermediate row and its
bytes, success or failure, so nothing is left in the File Manager."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.library import slice_and_persist, to_absolute_path
from backend.app.models.library import LibraryFile
from backend.app.models.slicer_pipeline import SlicerPipeline
from backend.app.schemas.project_files import ResliceBody
from backend.app.schemas.slicer import SliceRequest
from backend.app.services import project_files
from backend.app.services.project_files import ProjectFilesError
from backend.app.services.project_snapshot import is_3mf
from backend.app.services.slicer_pipeline_request import slice_request_from_pipeline

logger = logging.getLogger(__name__)


def is_resliceable(filename: str) -> bool:
    """3MF sources only (``.gcode.3mf`` included); G-code cannot be re-sliced."""
    return is_3mf(filename)


def output_filename(source_filename: str) -> str:
    """``support.3mf`` / ``support.gcode.3mf`` → ``support.gcode.3mf``."""
    name = source_filename
    lower = name.lower()
    for suffix in (".gcode.3mf", ".3mf"):
        if lower.endswith(suffix):
            name = name[: -len(suffix)]
            break
    return f"{name or 'tranche'}.gcode.3mf"


def reslice_note(source_number: int, pipeline_name: str) -> str:
    return f"Re-tranché depuis R{source_number} · pipeline {pipeline_name}"


@dataclass(frozen=True)
class ResliceRequest:
    """Everything the background job needs, read by ``prepare_reslice`` before the route enqueues.

    ``slice_request`` is built from the pipeline there, so a pipeline the
    slicer cannot use is a 400 from the route, never a failed job."""

    revision_id: int
    revision_number: int
    source_file_id: int
    source_filename: str
    model_bytes: bytes
    pipeline_id: int
    slice_request: SliceRequest
    user_id: int | None


async def load_pipeline(db: AsyncSession, pipeline_id: int) -> SlicerPipeline:
    """The live (not deleted) pipeline ``pipeline_id``; ``ProjectFilesError`` 404 otherwise."""
    pipeline = (
        await db.execute(
            select(SlicerPipeline).where(SlicerPipeline.id == pipeline_id, SlicerPipeline.is_deleted.is_(False))
        )
    ).scalar_one_or_none()
    if pipeline is None:
        raise ProjectFilesError(404, "Pipeline not found")
    return pipeline


async def prepare_reslice(db: AsyncSession, revision_id: int, body: ResliceBody, user_id: int | None) -> ResliceRequest:
    """Validate a re-slice of ``body.file_id`` in revision ``revision_id`` and read its bytes.

    Raises ``ProjectFilesError``, first failing check wins: revision 404, section 400,
    file not in the revision 404, not a 3MF 400, pipeline 404, unusable preset 400,
    source missing on disk 404."""
    revision, item, _project = await project_files.get_revision_bundle(db, revision_id)
    project_files.require_enabled_section(item.section)
    source = (
        await db.execute(
            select(LibraryFile).where(LibraryFile.id == body.file_id, LibraryFile.revision_id == revision.id)
        )
    ).scalar_one_or_none()
    if source is None:
        raise ProjectFilesError(404, "File not found in this revision")
    if not is_resliceable(source.filename):
        raise ProjectFilesError(400, "Only 3MF files can be re-sliced")
    pipeline = await load_pipeline(db, body.pipeline_id)
    try:
        # Built here, not in the job: a pipeline the slicer cannot use is a 400, never a failed job.
        slice_request = slice_request_from_pipeline(pipeline)
    except ValidationError as exc:
        raise ProjectFilesError(400, "Pipeline has no usable filament preset") from exc
    path = project_files._revision_file_path(source.file_path)
    if path is None or not path.exists():
        raise ProjectFilesError(404, "Source file missing on disk")
    return ResliceRequest(
        revision_id=revision.id,
        revision_number=revision.number,
        source_file_id=source.id,
        source_filename=source.filename,
        model_bytes=await asyncio.to_thread(path.read_bytes),
        pipeline_id=pipeline.id,
        slice_request=slice_request,
        user_id=user_id,
    )


async def _slice(db: AsyncSession, **kwargs):
    """Test seam around the library slicer."""
    return await slice_and_persist(db, **kwargs)


async def _record_revision_added(db: AsyncSession, project_id: int, entry: dict, user_id: int | None) -> None:
    """``project.revision_added`` on the linked Aito orders, through the helper shared with
    auto-filing (looked up at call time, so a patched ``project_filing.record_revision_added``
    is the one called). Never raises: the helper swallows the event's own failures, but a
    failing rollback inside it propagates, and an event is not worth failing a revision
    that is already committed."""
    from backend.app.services.project_filing import record_revision_added

    try:
        await record_revision_added(db, project_id, entry, user_id)
    except Exception:
        logger.warning("Re-trancher: project.revision_added failed for project %s", project_id, exc_info=True)


async def _drop_intermediate(db: AsyncSession, file_id: int) -> None:
    """Hard-delete the slicer's loose library row and its bytes (row + file + thumbnail)."""
    from backend.app.services.library_trash import library_trash_service

    try:
        row = (await db.execute(select(LibraryFile).where(LibraryFile.id == file_id))).scalar_one_or_none()
        if row is not None:
            await library_trash_service.hard_delete_many(db, [row])
    except Exception:
        await db.rollback()
        logger.exception("Re-trancher: could not delete intermediate library file %s", file_id)


async def run_reslice(db: AsyncSession, req: ResliceRequest, *, job_id: int | None = None) -> dict:
    """Slice ``req``'s source and file the output as the next revision of the source's item. Commits.

    Raises ``ProjectFilesError`` (pipeline gone, source revision or item deleted or
    renamed into a conflict meanwhile) or the slicer's ``HTTPException``."""
    pipeline = await load_pipeline(db, req.pipeline_id)
    pipeline_id, pipeline_name = pipeline.id, pipeline.name
    sliced = await _slice(
        db,
        model_bytes=req.model_bytes,
        model_filename=req.source_filename,
        folder_id=None,
        extra_metadata={"sliced_from_library_file_id": req.source_file_id},
        request=req.slice_request,
        current_user_id=req.user_id,
        job_id=job_id,
    )
    intermediate_id = sliced.library_file_id
    try:
        intermediate_path = (
            await db.execute(select(LibraryFile.file_path).where(LibraryFile.id == intermediate_id))
        ).scalar_one()
        path = to_absolute_path(intermediate_path)
        if path is None or not path.exists():
            raise ProjectFilesError(500, "The slicer output is missing on disk")
        # Re-read the source now: the item or revision may have changed during the slice.
        _revision, item, project = await project_files.get_revision_bundle(db, req.revision_id)
        source = project_files.RevisionSource(path=path, filename=output_filename(req.source_filename))
        revision = await project_files.add_revision_from_sources(
            db,
            project,
            item,
            [source],
            note=reslice_note(req.revision_number, pipeline_name),
            user_id=req.user_id,
            derived_from_id=req.revision_id,
            pipeline_id=pipeline_id,
            pipeline_name=pipeline_name,
        )
        row = source.row
        # Read everything now: the event below and _drop_intermediate commit (or roll back,
        # which expires every instance of the session).
        result = {
            "project_id": project.id,
            "item_id": item.id,
            "revision_id": revision.id,
            "revision_number": revision.number,
            "file_id": row.id if row is not None else None,
            "filename": row.filename if row is not None else source.filename,
        }
        entry = {
            "section": item.section,
            "item_id": item.id,
            "item_name": item.name,
            "revision_id": revision.id,
            "revision_number": revision.number,
        }
        # Spec §4.4: the linked orders' history shows every new revision. Best-effort:
        # the helper logs and swallows its own failures, and the revision is already committed.
        await _record_revision_added(db, result["project_id"], entry, req.user_id)
        return result
    finally:
        await _drop_intermediate(db, intermediate_id)
