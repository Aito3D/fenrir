"""Project files routes (spec §8) — fork-owned; registered before projects.router."""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse
from fastapi.routing import APIRoute
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTask

from backend.app.api.routes.library import _ensure_library_file_visible, may_modify_library_file, to_absolute_path
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
    ImportLibraryFilesRequest,
    ImportLibraryFilesResponse,
    ProjectItemCreate,
    ProjectItemFork,
    ProjectItemOut,
    ProjectItemRename,
    ProjectRevisionOut,
    ProjectRevisionUpdate,
    ProjectSuggestionForFile,
    ProjectTreeResponse,
    RevisionUploadResponse,
)
from backend.app.services import aito_project_links as aito_links, project_files as svc, project_filing

logger = logging.getLogger(__name__)

_UPLOAD_OVERHEAD_BYTES = 8 * 1024


def content_length_capped_route(*permissions: Permission) -> type[APIRoute]:
    """A route class that authorises with every one of ``permissions`` and rejects an
    over-cap multipart body from its Content-Length before Starlette spools it — same
    gate as the library upload routes (``_ContentLengthCappedRoute`` in library.py),
    authorised with project permissions instead of ``library:upload``."""
    checkers = [require_permission_if_auth_enabled(permission) for permission in permissions]

    class _CappedRoute(APIRoute):
        def get_route_handler(self):
            original = super().get_route_handler()

            async def handler(request: Request) -> Response:
                credentials = await security(request)
                for checker in checkers:
                    await checker(credentials, request.headers.get("x-api-key"))
                declared = request.headers.get("content-length")
                if declared and declared.isdigit():
                    cap = settings.library_max_upload_bytes
                    if int(declared) > cap + _UPLOAD_OVERHEAD_BYTES:
                        raise HTTPException(status_code=413, detail=f"Upload exceeds the maximum size of {cap} bytes")
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


router = APIRouter(prefix="/projects", tags=["projects"])
upload_router = APIRouter(prefix="/projects", tags=["projects"], route_class=_ProjectUploadCappedRoute)
# Phase 5: the File Manager side of the bridge (no upstream /library route shares these paths).
library_router = APIRouter(prefix="/library", tags=["projects"])


def _raise(exc: svc.ProjectFilesError):
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
    actor = user.username if user is not None else None
    try:
        async with db.begin_nested():
            order_ids = await aito_links.record_on_linked_orders(
                db,
                project_id,
                kind,
                actor=actor,
                subject_label=subject_label,
                detail=detail,
            )
        await db.commit()
    except Exception:
        logger.warning("%s event failed for project %s", kind, project_id, exc_info=True)
        await db.rollback()
        return
    await aito_links.broadcast_orders_changed(order_ids, actor)


def _uid(user: User | None) -> int | None:
    return user.id if user else None


async def _item_out(db: AsyncSession, project: Project, item_id: int) -> ProjectItemOut:
    tree = await svc.load_tree(db, project)
    for section in tree.sections:
        for item in section.items:
            if item.id == item_id:
                return item
    raise HTTPException(status_code=404, detail="Item not found")


async def _revision_out(db: AsyncSession, project: Project, revision_id: int) -> ProjectRevisionOut:
    tree = await svc.load_tree(db, project)
    for section in tree.sections:
        for item in section.items:
            for rev in item.revisions:
                if rev.id == revision_id:
                    return rev
    raise HTTPException(status_code=404, detail="Revision not found")


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
    try:
        item = await svc.create_item(db, project, section=body.section, name=body.name, user_id=_uid(user))
    except svc.ProjectFilesError as exc:
        _raise(exc)
    await db.commit()
    return await _item_out(db, project, item.id)


@router.patch("/items/{item_id}", response_model=ProjectItemOut)
async def rename_item(
    item_id: int,
    body: ProjectItemRename,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
):
    try:
        item, project = await svc.get_item_for_project(db, item_id)
        await svc.rename_item(db, project, item, body.name)
    except svc.ProjectFilesError as exc:
        _raise(exc)
    return await _item_out(db, project, item_id)


@router.delete("/items/{item_id}", status_code=204, response_model=None)
async def delete_item(
    item_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_DELETE),
) -> None:
    try:
        item, project = await svc.get_item_for_project(db, item_id)
        await svc.delete_item(db, project, item)
    except svc.ProjectFilesError as exc:
        _raise(exc)


@upload_router.post("/items/{item_id}/revisions", response_model=RevisionUploadResponse, status_code=201)
async def upload_revision(
    item_id: int,
    files: list[UploadFile] = File(...),
    note: str | None = Form(default=None),
    derived_from_id: int | None = Form(default=None),
    db: AsyncSession = Depends(get_db),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
):
    try:
        item, project = await svc.get_item_for_project(db, item_id)
        revision, warnings = await svc.add_revision(
            db, project, item, files, note=note, derived_from_id=derived_from_id, user_id=_uid(user)
        )
    except svc.ProjectFilesError as exc:
        _raise(exc)
    project_id, revision_id = project.id, revision.id
    await _record_linked(
        db,
        project_id,
        "project.revision_added",
        user,
        f"{item.name} R{revision.number}",
        {"section": item.section, "item_id": item.id, "revision_id": revision_id},
    )
    project = await _project(db, project_id)  # a failed event commit rolls back and expires the instances
    return RevisionUploadResponse(revision=await _revision_out(db, project, revision_id), warnings=warnings)


@router.post("/items/{item_id}/fork", response_model=ProjectItemOut, status_code=201)
async def fork_item(
    item_id: int,
    body: ProjectItemFork,
    db: AsyncSession = Depends(get_db),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
):
    try:
        item, project = await svc.get_item_for_project(db, item_id)
        revision, rev_item, _p = await svc.get_revision_bundle(db, body.revision_id)
        if rev_item.id != item.id:
            raise svc.ProjectFilesError(400, "Revision does not belong to this item")
        forked = await svc.fork_revision(db, project, item, revision, body.name, _uid(user))
    except svc.ProjectFilesError as exc:
        _raise(exc)
    return await _item_out(db, project, forked.id)


@upload_router.post("/revisions/{revision_id}/files")
async def add_files(
    revision_id: int,
    files: list[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
):
    try:
        revision, item, project = await svc.get_revision_bundle(db, revision_id)
        warnings = await svc.add_files_to_revision(db, project, item, revision, files, _uid(user))
    except svc.ProjectFilesError as exc:
        _raise(exc)
    return {"warnings": [w.model_dump() for w in warnings]}


@router.delete("/revisions/{revision_id}/files/{file_id}", status_code=204, response_model=None)
async def remove_file(
    revision_id: int,
    file_id: int,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
) -> None:
    try:
        revision, item, project = await svc.get_revision_bundle(db, revision_id)
        await svc.remove_file_from_revision(db, project, item, revision, file_id)
    except svc.ProjectFilesError as exc:
        _raise(exc)


@router.patch("/revisions/{revision_id}", response_model=ProjectRevisionOut)
async def update_revision(
    revision_id: int,
    body: ProjectRevisionUpdate,
    db: AsyncSession = Depends(get_db),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_UPDATE),
):
    try:
        revision, item, project = await svc.get_revision_bundle(db, revision_id)
        fields = {key: getattr(body, key) for key in body.model_fields_set}
        if "status" in fields and fields["status"] is None:
            raise svc.ProjectFilesError(400, "status cannot be null")
        previous_status = revision.status
        await svc.update_revision(db, project, revision, fields=fields, user_id=_uid(user))
    except svc.ProjectFilesError as exc:
        _raise(exc)
    # Save the change first and OUTSIDE the best-effort event hook: a failed commit must surface.
    await db.commit()
    project_id, new_status, item_label = project.id, revision.status, f"{item.name} R{revision.number}"
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
    try:
        revision, item, project = await svc.get_revision_bundle(db, revision_id)
        await svc.delete_revision(db, project, item, revision)
    except svc.ProjectFilesError as exc:
        _raise(exc)


@router.get("/revisions/{revision_id}/download")
async def download_revision(
    revision_id: int,
    file_id: int | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PROJECTS_READ),
):
    """One file (``?file_id=``) or every file of the revision as a zip."""
    try:
        revision, item, project = await svc.get_revision_bundle(db, revision_id)
    except svc.ProjectFilesError as exc:
        _raise(exc)
    rows = (await db.execute(select(LibraryFile).where(LibraryFile.revision_id == revision.id))).scalars().all()
    if file_id is not None:
        row = next((r for r in rows if r.id == file_id), None)
        path = to_absolute_path(row.file_path) if row else None
        if row is None or path is None or not path.exists():
            raise HTTPException(status_code=404, detail="File not found")
        return FileResponse(str(path), filename=row.filename, media_type="application/octet-stream")
    entries = []
    for row in rows:
        path = to_absolute_path(row.file_path)
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
    return FileResponse(
        str(archive),
        filename=name,
        media_type="application/zip",
        background=BackgroundTask(archive.unlink, missing_ok=True),
    )


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
    try:
        result = await project_filing.move_library_files_to_project(
            db, project, files, item_id=body.item_id, new_item_name=body.new_item_name, user_id=_uid(user)
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except svc.ProjectFilesError as exc:
        _raise(exc)

    revisions: dict[int, dict] = {}
    for entry in [*result.moved, *result.copied]:
        revisions.setdefault(entry["revision_id"], entry)
    for revision_id, entry in revisions.items():
        await _record_linked(
            db,
            project_id,
            "project.revision_added",
            user,
            f"{entry['item_name']} R{entry['revision_number']}",
            {"section": entry["section"], "item_id": entry["item_id"], "revision_id": revision_id},
        )
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
