"""Project files routes (spec §8) — fork-owned; registered before projects.router."""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import zipfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse
from fastapi.routing import APIRoute
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.types import Message, Receive, Scope, Send

from backend.app.api.routes.library import _ensure_library_file_visible, may_modify_library_file
from backend.app.core import database
from backend.app.core.auth import (
    RequirePermissionIfAuthEnabled,
    require_ownership_permission,
    require_permission_if_auth_enabled,
    security,
)
from backend.app.core.config import settings
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.library import LibraryFile
from backend.app.models.project import Project
from backend.app.models.user import User
from backend.app.schemas.aito_project_links import ProjectOrdersResponse
from backend.app.schemas.project_files import (
    REVISION_NOTE_MAX_LENGTH,
    ImportLibraryFilesRequest,
    ImportLibraryFilesResponse,
    LegacyMigrationStatus,
    ProjectItemCreate,
    ProjectItemFork,
    ProjectItemOut,
    ProjectItemRename,
    ProjectRevisionOut,
    ProjectRevisionUpdate,
    ProjectSuggestionForFile,
    ProjectTreeResponse,
    ResliceBody,
    ResliceStarted,
    RevisionUploadResponse,
)
from backend.app.services import (
    aito_project_links as aito_links,
    project_files as svc,
    project_filing,
    project_reslice,
)
from backend.app.services.actor import actor_name, actor_user_id
from backend.app.services.slice_dispatch import http_exception_to_job_error, slice_dispatch

logger = logging.getLogger(__name__)

_UPLOAD_OVERHEAD_BYTES = 8 * 1024


def _upload_too_large(cap: int) -> HTTPException:
    return HTTPException(status_code=413, detail=f"Upload exceeds the maximum size of {cap} bytes")


def _receive_capped(request: Request, cap: int) -> Request:
    """``request`` with a receive that counts body bytes and raises the 413 once they pass
    ``cap`` plus the multipart overhead — the multipart parser never gets the excess."""
    limit = cap + _UPLOAD_OVERHEAD_BYTES
    upstream = request.receive
    received = 0

    async def receive() -> Message:
        nonlocal received
        message = await upstream()
        if message["type"] == "http.request":
            received += len(message.get("body", b""))
            if received > limit:
                raise _upload_too_large(cap)
        return message

    return Request(request.scope, receive)


def content_length_capped_route(*permissions: Permission) -> type[APIRoute]:
    """A route class that authorises with every one of ``permissions`` and rejects an
    over-cap multipart body from its Content-Length before Starlette spools it — same
    gate as the library upload routes (``_ContentLengthCappedRoute`` in library.py),
    authorised with project permissions instead of ``library:upload``.

    A body with no usable Content-Length (chunked transfer encoding) is counted as it
    arrives instead, and refused past the same limit before the parser spools the rest."""
    checkers = [require_permission_if_auth_enabled(permission) for permission in permissions]

    class _CappedRoute(APIRoute):
        def get_route_handler(self):
            original = super().get_route_handler()

            async def handler(request: Request) -> Response:
                credentials = await security(request)
                for checker in checkers:
                    await checker(credentials, request.headers.get("x-api-key"))
                cap = settings.library_max_upload_bytes
                declared = request.headers.get("content-length")
                if declared and declared.isdigit():
                    if int(declared) > cap + _UPLOAD_OVERHEAD_BYTES:
                        raise _upload_too_large(cap)
                else:
                    request = _receive_capped(request, cap)
                return await original(request)

            return handler

    return _CappedRoute


_ProjectUploadCappedRoute = content_length_capped_route(Permission.PROJECTS_UPDATE)


_STORED_SUFFIXES = (".3mf", ".zip", ".jpg", ".jpeg", ".png", ".step", ".stp")


def _build_zip(paths_and_names: list[tuple[Path, str]], archive: Path) -> int:
    """Blocking zip build (run in a thread). Returns the number of files written."""
    written = 0
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        for path, name in paths_and_names:
            method = zipfile.ZIP_STORED if name.lower().endswith(_STORED_SUFFIXES) else zipfile.ZIP_DEFLATED
            zf.write(path, arcname=name, compress_type=method)
            written += 1
    return written


class _TempFileResponse(FileResponse):
    """``FileResponse`` over a temp file that it deletes once the response ends.

    The unlink runs in ``finally``, so the file also goes when the client drops
    mid-body or Starlette answers a bad ``Range`` header (400/416) — both paths
    return or raise before a ``BackgroundTask`` would run."""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            Path(self.path).unlink(missing_ok=True)


router = APIRouter(prefix="/projects", tags=["projects"])
upload_router = APIRouter(prefix="/projects", tags=["projects"], route_class=_ProjectUploadCappedRoute)
# Phase 5: the File Manager side of the bridge (no upstream /library route shares these paths).
library_router = APIRouter(prefix="/library", tags=["projects"])


@contextmanager
def _file_errors() -> Iterator[None]:
    """A ``ProjectFilesError`` becomes its HTTP error, chained ``from`` it."""
    try:
        yield
    except svc.ProjectFilesError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


async def _project(db: AsyncSession, project_id: int) -> Project:
    project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


async def _record_linked(
    db: AsyncSession,
    project_id: int,
    kind: str,
    user: User | None,
    subject_label: str,
    detail: dict,
) -> None:
    """Best-effort event on every order linked to the project, then an
    ``aito_changed`` broadcast to each so their open panels refresh. The revision
    change is already stored (or committed here first), so a failure here only
    costs the event."""
    await aito_links.record_and_broadcast(
        db,
        project_id,
        kind,
        actor=actor_name(user),
        subject_label=subject_label,
        detail=detail,
        log=logger,
    )


async def _item_out(db: AsyncSession, project: Project, item_id: int) -> ProjectItemOut:
    item = svc.find_item(await svc.load_tree(db, project), item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    return item


async def _revision_out(db: AsyncSession, project: Project, revision_id: int) -> ProjectRevisionOut:
    rev = svc.find_revision(await svc.load_tree(db, project), revision_id)
    if rev is None:
        raise HTTPException(status_code=404, detail="Revision not found")
    return rev


# --- phase 5: legacy migration (literal paths, before the /{project_id} routes) ---


@router.post("/legacy-migration/start", response_model=LegacyMigrationStatus, status_code=202)
async def start_legacy_migration(
    db: AsyncSession = Depends(get_db),
    _settings: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
    _projects: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
):
    """Move every not-yet-migrated project's legacy printing files into its tree,
    in the background (one project at a time). 409 while a run is in progress."""
    if not project_filing.start_legacy_migration():
        raise HTTPException(status_code=409, detail="The legacy migration is already running")
    return await project_filing.legacy_migration_status(db)


@router.get("/legacy-migration/status", response_model=LegacyMigrationStatus)
async def get_legacy_migration_status(
    db: AsyncSession = Depends(get_db),
    _settings: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
    _projects: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
):
    """Progress of the current (or last) run; ``pending`` = projects still to migrate."""
    return await project_filing.legacy_migration_status(db)


@router.get("/{project_id}/tree", response_model=ProjectTreeResponse)
async def get_tree(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_READ),
):
    return await svc.load_tree(db, await _project(db, project_id))


@router.get("/{project_id}/orders", response_model=ProjectOrdersResponse)
async def get_project_orders(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_READ),
    __: User | None = RequirePermissionIfAuthEnabled(Permission.AITO_READ),
):
    """Aito orders/clients linking to the project: needs aito:read as well as projects:read."""
    return await aito_links.orders_for_project(db, (await _project(db, project_id)).id)


@router.post("/{project_id}/items", response_model=ProjectItemOut, status_code=201)
async def create_item(
    project_id: int,
    body: ProjectItemCreate,
    db: AsyncSession = Depends(get_db),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
):
    project = await _project(db, project_id)
    with _file_errors():
        svc.require_enabled_section(body.section)  # projects hold printing files only for now
        item = await svc.create_item(db, project, section=body.section, name=body.name, user_id=actor_user_id(user))
    await db.commit()
    return await _item_out(db, project, item.id)


@router.patch("/items/{item_id}", response_model=ProjectItemOut)
async def rename_item(
    item_id: int,
    body: ProjectItemRename,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
):
    with _file_errors():
        item, project = await svc.get_item_for_project(db, item_id)
        await svc.rename_item(db, project, item, body.name)
    return await _item_out(db, project, item_id)


@router.delete("/items/{item_id}", status_code=204, response_model=None)
async def delete_item(
    item_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_DELETE),
) -> None:
    with _file_errors():
        item, project = await svc.get_item_for_project(db, item_id)
        await svc.delete_item(db, project, item)


@upload_router.post("/items/{item_id}/revisions", response_model=RevisionUploadResponse, status_code=201)
async def upload_revision(
    item_id: int,
    files: list[UploadFile] = File(...),
    note: str | None = Form(default=None, max_length=REVISION_NOTE_MAX_LENGTH),
    derived_from_id: int | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
):
    with _file_errors():
        svc.require_printable_uploads(files)
        item, project = await svc.get_item_for_project(db, item_id)
        svc.require_enabled_section(item.section)
        revision, warnings = await svc.add_revision(
            db, project, item, files, note=note, derived_from_id=derived_from_id, user_id=actor_user_id(user)
        )
    project_id, revision_id = project.id, revision.id
    label, detail = aito_links.revision_added_payload(
        item_name=item.name,
        revision_number=revision.number,
        section=item.section,
        item_id=item.id,
        revision_id=revision_id,
    )
    await _record_linked(db, project_id, "project.revision_added", user, label, detail)
    project = await _project(db, project_id)  # a failed event commit rolls back and expires the instances
    return RevisionUploadResponse(revision=await _revision_out(db, project, revision_id), warnings=warnings)


@router.post("/items/{item_id}/fork", response_model=ProjectItemOut, status_code=201)
async def fork_item(
    item_id: int,
    body: ProjectItemFork,
    db: AsyncSession = Depends(get_db),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
):
    with _file_errors():
        item, project = await svc.get_item_for_project(db, item_id)
        revision, rev_item, _p = await svc.get_revision_bundle(db, body.revision_id)
        if rev_item.id != item.id:
            raise svc.ProjectFilesError(400, "Revision does not belong to this item")
        forked = await svc.fork_revision(db, project, item, revision, body.name, actor_user_id(user))
    return await _item_out(db, project, forked.id)


@upload_router.post("/revisions/{revision_id}/files")
async def add_files(
    revision_id: int,
    files: list[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
):
    with _file_errors():
        svc.require_printable_uploads(files)
        revision, item, project = await svc.get_revision_bundle(db, revision_id)
        svc.require_enabled_section(item.section)
        warnings = await svc.add_files_to_revision(db, project, item, revision, files, actor_user_id(user))
    return {"warnings": [w.model_dump() for w in warnings]}


@router.delete("/revisions/{revision_id}/files/{file_id}", status_code=204, response_model=None)
async def remove_file(
    revision_id: int,
    file_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
) -> None:
    with _file_errors():
        revision, item, project = await svc.get_revision_bundle(db, revision_id)
        await svc.remove_file_from_revision(db, project, item, revision, file_id)


@router.post("/revisions/{revision_id}/reslice", response_model=ResliceStarted, status_code=202)
async def reslice_revision(
    revision_id: int,
    body: ResliceBody,
    db: AsyncSession = Depends(get_db),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
    _slice: User | None = RequirePermissionIfAuthEnabled(Permission.LIBRARY_UPLOAD),
    _pipelines: User | None = RequirePermissionIfAuthEnabled(Permission.PIPELINES_READ),
):
    """Re-trancher (spec §12.1): slice one 3MF of this revision with a saved pipeline in the
    background; the result becomes the next revision of the same item. Poll ``status_url``."""
    with _file_errors():
        req = await project_reslice.prepare_reslice(db, revision_id, body, actor_user_id(user))

    async def _run(job_id: int) -> dict:
        async with database.async_session() as task_db:
            try:
                return await project_reslice.run_reslice(task_db, req, job_id=job_id)
            except svc.ProjectFilesError as exc:
                raise http_exception_to_job_error(HTTPException(exc.status_code, exc.detail)) from exc
            except HTTPException as exc:
                raise http_exception_to_job_error(exc) from exc

    job = await slice_dispatch.enqueue(
        kind="project_revision",
        source_id=req.revision_id,
        source_name=req.source_filename,
        owner_id=actor_user_id(user),
        run=_run,
    )
    return ResliceStarted(job_id=job.id, status=job.status, status_url=f"/api/v1/slice-jobs/{job.id}")


@router.patch("/revisions/{revision_id}", response_model=ProjectRevisionOut)
async def update_revision(
    revision_id: int,
    body: ProjectRevisionUpdate,
    db: AsyncSession = Depends(get_db),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
):
    with _file_errors():
        revision, item, project = await svc.get_revision_bundle(db, revision_id)
        fields = {key: getattr(body, key) for key in body.model_fields_set}
        if "status" in fields and fields["status"] is None:
            raise svc.ProjectFilesError(400, "status cannot be null")
        previous_status = revision.status
        await svc.update_revision(db, project, revision, fields=fields, user_id=actor_user_id(user))
    # Save the change first and OUTSIDE the best-effort event hook: a failed commit must surface.
    await db.commit()
    project_id, new_status, item_label = project.id, revision.status, svc.revision_label(item.name, revision.number)
    if new_status != previous_status:
        await _record_linked(
            db,
            project_id,
            "project.revision_status_changed",
            user,
            item_label,
            {
                "section": item.section,
                "item_id": item.id,
                "revision_id": revision_id,
                "from": previous_status,
                "to": new_status,
            },
        )
    project = await _project(db, project_id)
    return await _revision_out(db, project, revision_id)


@router.delete("/revisions/{revision_id}", status_code=204, response_model=None)
async def delete_revision(
    revision_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_DELETE),
) -> None:
    with _file_errors():
        revision, item, project = await svc.get_revision_bundle(db, revision_id)
        await svc.delete_revision(db, project, item, revision)


@router.get("/revisions/{revision_id}/download")
async def download_revision(
    revision_id: int,
    file_id: int | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_READ),
):
    """One file (``?file_id=``) or every file of the revision as a zip."""
    with _file_errors():
        revision, item, project = await svc.get_revision_bundle(db, revision_id)
    rows = (await db.execute(select(LibraryFile).where(LibraryFile.revision_id == revision.id))).scalars().all()
    if file_id is not None:
        row = next((r for r in rows if r.id == file_id), None)
        path = svc.revision_file_path(row.file_path) if row else None
        if row is None or path is None or not path.exists():
            raise HTTPException(status_code=404, detail="File not found")
        return FileResponse(str(path), filename=row.filename, media_type="application/octet-stream")
    entries = []
    for row in rows:
        path = svc.revision_file_path(row.file_path)
        if path is not None and path.exists():
            entries.append((path, row.filename))
    fd, archive_name = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    archive = Path(archive_name)
    try:
        written = await asyncio.to_thread(_build_zip, entries, archive)
        if written == 0:
            raise HTTPException(status_code=404, detail="No file available on disk")
    except BaseException:
        archive.unlink(missing_ok=True)
        raise
    name = f"{project.code or project.id}_{item.name}_R{revision.number}.zip"
    return _TempFileResponse(str(archive), filename=name, media_type="application/zip")


# --- phase 5: File Manager bridge ---------------------------------------------


@router.post("/{project_id}/import-library-files", response_model=ImportLibraryFilesResponse)
async def import_library_files(
    project_id: int,
    body: ImportLibraryFilesRequest,
    db: AsyncSession = Depends(get_db),
    auth_result: tuple[User | None, bool] = Depends(
        require_ownership_permission(Permission.LIBRARY_UPDATE_ALL, Permission.LIBRARY_UPDATE_OWN)
    ),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
):
    """Move File Manager files into the project (Impression). Same ownership rule
    as ``/library/files/move``: files of others are skipped (``not_owner``) without
    ``library:update_all``. Files the File Manager can't see (project files,
    trashed, unknown ids) are skipped as ``not_found``."""
    user, can_modify_all = auth_result
    project = await _project(db, project_id)
    file_ids = list(dict.fromkeys(body.file_ids))
    rows = {
        row.id: row
        for row in (await db.execute(LibraryFile.file_manager().where(LibraryFile.id.in_(file_ids)))).scalars()
    }
    files: list[LibraryFile] = []
    pre_skipped: list[dict] = []
    for file_id in file_ids:
        row = rows.get(file_id)
        if row is None:
            pre_skipped.append({"file_id": file_id, "code": "not_found", "reason": "file not found"})
        elif not may_modify_library_file(row, user, can_modify_all):
            pre_skipped.append({"file_id": file_id, "code": "not_owner", "reason": "not the file owner"})
        else:
            files.append(row)
    with _file_errors():
        try:
            result = await project_filing.move_library_files_to_project(
                db, project, files, item_id=body.item_id, new_item_name=body.new_item_name, user_id=actor_user_id(user)
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    for revision_id, entry in result.revisions().items():
        label, detail = aito_links.revision_added_payload(
            item_name=entry["item_name"],
            revision_number=entry["revision_number"],
            section=entry["section"],
            item_id=entry["item_id"],
            revision_id=revision_id,
        )
        await _record_linked(db, project_id, "project.revision_added", user, label, detail)
    return ImportLibraryFilesResponse(moved=result.moved, copied=result.copied, skipped=pre_skipped + result.skipped)


@library_router.get("/files/{file_id}/project-suggestions", response_model=list[ProjectSuggestionForFile])
async def library_file_project_suggestions(
    file_id: int,
    limit: int = Query(default=5, ge=1, le=20),
    db: AsyncSession = Depends(get_db),
    auth_result: tuple[User | None, bool] = Depends(
        require_ownership_permission(Permission.LIBRARY_READ_ALL, Permission.LIBRARY_READ_OWN)
    ),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_READ),
):
    """Projects the file likely belongs to (code prefix, then item name, then project name)."""
    user, can_read_all = auth_result
    row = (await db.execute(LibraryFile.file_manager().where(LibraryFile.id == file_id))).scalar_one_or_none()
    file = _ensure_library_file_visible(row, user, can_read_all)
    return await project_filing.suggest_projects_for_filename(db, file.filename, limit)
