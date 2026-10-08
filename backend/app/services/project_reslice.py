"""Re-trancher: re-slice a project 3MF revision with a saved pipeline (spec §12.1).

The slicer writes its output as a loose library file; this copies it into the
next revision of the SAME item and always deletes that intermediate row and its
bytes, success or failure, so nothing is left in the File Manager."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.library import LibraryFile
from backend.app.models.slicer_pipeline import SlicerPipeline
from backend.app.schemas.slicer import SliceRequest
from backend.app.services import project_files
from backend.app.services.project_files import ProjectFilesError

logger = logging.getLogger(__name__)


def is_resliceable(filename: str) -> bool:
    """3MF sources only (``.gcode.3mf`` included); G-code cannot be re-sliced."""
    return filename.lower().endswith(".3mf")


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
    """Everything the background job needs, read by the route before it enqueues.

    ``slice_request`` is built from the pipeline in the route, so a pipeline the
    slicer cannot use is a 400 there, never a failed job."""

    revision_id: int
    revision_number: int
    source_file_id: int
    source_filename: str
    model_bytes: bytes
    pipeline_id: int
    slice_request: SliceRequest
    user_id: int | None


async def _slice(db: AsyncSession, **kwargs):
    """Test seam around the library slicer (imported lazily: it lives in a route module)."""
    from backend.app.api.routes.library import slice_and_persist

    return await slice_and_persist(db, **kwargs)


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
    from backend.app.api.routes.library import to_absolute_path

    pipeline = (
        await db.execute(
            select(SlicerPipeline).where(SlicerPipeline.id == req.pipeline_id, SlicerPipeline.is_deleted.is_(False))
        )
    ).scalar_one_or_none()
    if pipeline is None:
        raise ProjectFilesError(404, "Pipeline not found")
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
        # Read everything before _drop_intermediate commits.
        return {
            "project_id": project.id,
            "item_id": item.id,
            "revision_id": revision.id,
            "revision_number": revision.number,
            "file_id": row.id if row is not None else None,
            "filename": row.filename if row is not None else source.filename,
        }
    finally:
        await _drop_intermediate(db, intermediate_id)
