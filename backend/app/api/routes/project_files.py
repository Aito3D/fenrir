"""Project files routes (spec §8) — fork-owned; registered before projects.router."""

from __future__ import annotations

import asyncio
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

from backend.app.api.routes.library import to_absolute_path
from backend.app.core.auth import RequirePermissionIfAuthEnabled, require_permission_if_auth_enabled, security
from backend.app.core.config import settings
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.library import LibraryFile
from backend.app.models.project import Project
from backend.app.models.user import User
from backend.app.schemas.aito_project_links import ProjectOrdersResponse
from backend.app.schemas.project_files import (
    ProjectItemCreate,
    ProjectItemFork,
    ProjectItemOut,
    ProjectItemRename,
    ProjectRevisionOut,
    ProjectRevisionUpdate,
    ProjectTreeResponse,
    RevisionUploadResponse,
)
from backend.app.services import aito_project_links as aito_links, project_files as svc

_UPLOAD_OVERHEAD_BYTES = 8 * 1024
_upload_permission = require_permission_if_auth_enabled(Permission.PROJECTS_UPDATE)


class _ProjectUploadCappedRoute(APIRoute):
    """Rejects an over-cap multipart body from its Content-Length before Starlette
    spools it — same gate as the library upload routes (``_ContentLengthCappedRoute``
    in library.py), authorised with ``projects:update`` instead of ``library:upload``."""

    def get_route_handler(self):
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            await _upload_permission(await security(request), request.headers.get("x-api-key"))
            declared = request.headers.get("content-length")
            if declared and declared.isdigit():
                cap = settings.library_max_upload_bytes
                if int(declared) > cap + _UPLOAD_OVERHEAD_BYTES:
                    raise HTTPException(status_code=413, detail=f"Upload exceeds the maximum size of {cap} bytes")
            return await original(request)

        return handler


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


def _raise(exc: svc.ProjectFilesError):
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


async def _project(db: AsyncSession, project_id: int) -> Project:
    project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


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
):
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
    return RevisionUploadResponse(revision=await _revision_out(db, project, revision.id), warnings=warnings)


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
        revision, _item, project = await svc.get_revision_bundle(db, revision_id)
        fields = {key: getattr(body, key) for key in body.model_fields_set}
        if "status" in fields and fields["status"] is None:
            raise svc.ProjectFilesError(400, "status cannot be null")
        await svc.update_revision(db, project, revision, fields=fields, user_id=_uid(user))
    except svc.ProjectFilesError as exc:
        _raise(exc)
    await db.commit()
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
