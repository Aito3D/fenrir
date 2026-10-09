"""Campaign-24 golden probe: the Projects-PDM REST API, end to end over HTTP.

Drives the real FastAPI app through httpx's ASGI transport against a fresh
in-memory SQLite database (same get_db override and module-level session
patches as backend/tests/conftest.py's async_client fixture). DATA_DIR points
at a wiped temp directory so project files land somewhere deterministic. Auth
is off because the database has no users, exactly as in the integration tests.

The sequence covers what a workshop user observes: creating a project with
tags, search and the tag catalogue, items (incl. a disabled section and a
duplicate name), revision uploads (3MF with a config snapshot, a non-printable
refusal, a derived revision), the tree, status/note edits, fork, rename,
adding/removing files, downloads (headers only), deletes and the refusals that
guard them, the legacy-migration status, the File Manager bridge refusals, the
AI routes' "not configured" answer, and the Aito side: codes by order,
suggestions, link/unlink, create-project-for-task, deliveries, file drops and
the order's link summary.
"""

import asyncio
import json
import os
import shutil
import sys
import zipfile
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

ROOT = Path("/tmp/fenrir-refactor-probe/pdm-api-data").resolve()
shutil.rmtree(ROOT, ignore_errors=True)
ROOT.mkdir(parents=True)
os.environ["DATA_DIR"] = str(ROOT)
sys.path.insert(0, ".")

from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402

import backend.app.main  # noqa: E402,F401  (registers every model on Base.metadata)
from backend.app.core.database import Base, get_db  # noqa: E402
from backend.app.main import app  # noqa: E402
from backend.app.models.aito_project import AitoProject  # noqa: E402
from backend.app.models.aito_task import AitoTask  # noqa: E402

B = "/api/v1"


def three_mf(config: dict | None, sliced: bool = False) -> bytes:
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        parts = {"3D/3dmodel.model": b'<model><metadata name="Application">BambuStudio-01.10.01.50</metadata></model>'}
        if config is not None:
            parts["Metadata/project_settings.config"] = json.dumps(config).encode()
        if sliced:
            parts["Metadata/plate_1.gcode"] = b"G28"
        for name, data in parts.items():
            zf.writestr(zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0)), data)
    return buf.getvalue()


CONFIG = {"printer_model": "Bambu Lab X1 Carbon", "print_settings_id": "0.20mm Standard", "filament_type": ["PLA"], "nozzle_diameter": ["0.4"], "layer_height": "0.2", "version": "01.09.00.70"}
PART_A = three_mf(CONFIG)
PART_A_SLICED = three_mf(CONFIG, sliced=True)
PART_B = three_mf({"printer_model": "Bambu Lab P1S", "layer_height": "0.28"})


async def main() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sm = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def override_get_db():
        async with sm() as session:
            try:
                yield session
                await session.commit()
            except BaseException:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = override_get_db
    out = []

    def rec(step, r, body=True):
        ct = r.headers.get("content-type", "")
        entry = {"step": step, "status": r.status_code}
        if body:
            entry["body"] = None if not r.content else (r.json() if ct.startswith("application/json") else r.text[:300])
        else:
            entry["headers"] = {k: r.headers.get(k) for k in ("content-type", "content-disposition", "content-length")}
            entry["bytes"] = len(r.content)
        out.append(entry)
        return entry.get("body")

    def upload(names_and_bytes, **form):
        return {"files": [("files", (n, b, "application/octet-stream")) for n, b in names_and_bytes], "data": form}

    with (
        patch("backend.app.core.database.async_session", sm),
        patch("backend.app.core.auth.async_session", sm),
        patch("backend.app.main.async_session", sm),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            rec("01-search-empty", await c.get(f"{B}/projects/search"))
            rec("02-tags-empty", await c.get(f"{B}/projects/tags"))
            proj = rec("03-create-project", await c.post(f"{B}/projects/", json={"name": "Support caméra FX3", "description": "Support imprimé", "tags": "drone, Caméra, drone"}))
            pid = proj["id"]
            proj2 = rec("04-create-project-2", await c.post(f"{B}/projects/", json={"name": "Boîtier électronique", "new_tag_names": ["Électronique", "caméra"]}))
            pid2 = proj2["id"]
            rec("05-get-project", await c.get(f"{B}/projects/{pid}"))
            rec("06-search-q", await c.get(f"{B}/projects/search", params={"q": "cam"}))
            rec("07-search-accent", await c.get(f"{B}/projects/search", params={"q": "Électro"}))
            tags = rec("08-tags", await c.get(f"{B}/projects/tags"))
            cam_id = next(t["id"] for t in tags if t["name"].lower() == "caméra")
            rec("09-search-tag-all", await c.get(f"{B}/projects/search", params={"tag_ids": [cam_id], "tag_mode": "all"}))
            rec("10-search-bad-limit", await c.get(f"{B}/projects/search", params={"limit": 0}))
            rec("11-search-escape-like", await c.get(f"{B}/projects/search", params={"q": "%_\\"}))
            item = rec("12-create-item", await c.post(f"{B}/projects/{pid}/items", json={"section": "impression", "name": "Pièce / principale"}))
            iid = item["id"]
            rec("13-create-item-disabled-section", await c.post(f"{B}/projects/{pid}/items", json={"section": "scan", "name": "Scan"}))
            rec("14-create-item-duplicate", await c.post(f"{B}/projects/{pid}/items", json={"section": "impression", "name": "PIÈCE / PRINCIPALE"}))
            rec("15-create-item-blank-name", await c.post(f"{B}/projects/{pid}/items", json={"section": "impression", "name": "   "}))
            rec("16-create-item-unknown-project", await c.post(f"{B}/projects/999/items", json={"section": "impression", "name": "x"}))
            up = rec("17-upload-revision", await c.post(f"{B}/projects/items/{iid}/revisions", **upload([("support.3mf", PART_A)], note="première version")))
            rid1 = up["revision"]["id"]
            rec("18-upload-non-printable", await c.post(f"{B}/projects/items/{iid}/revisions", **upload([("model.stl", b"solid x")])))
            rec("19-upload-duplicate-bytes", await c.post(f"{B}/projects/items/{iid}/revisions", **upload([("support.3mf", PART_A)])))
            up2 = rec("20-upload-derived", await c.post(f"{B}/projects/items/{iid}/revisions", **upload([("support.gcode.3mf", PART_A_SLICED), ("plate.gcode", b"G28\nG1")], derived_from_id=rid1)))
            rid2 = up2["revision"]["id"]
            rec("21-upload-bad-derived", await c.post(f"{B}/projects/items/{iid}/revisions", **upload([("x.3mf", PART_B)], derived_from_id=999)))
            rec("22-upload-unknown-item", await c.post(f"{B}/projects/items/999/revisions", **upload([("x.3mf", PART_B)])))
            rec("23-tree", await c.get(f"{B}/projects/{pid}/tree"))
            rec("24-patch-status", await c.patch(f"{B}/projects/revisions/{rid1}", json={"status": "valide", "note": "ok"}))
            rec("25-patch-status-null", await c.patch(f"{B}/projects/revisions/{rid1}", json={"status": None}))
            rec("26-patch-bad-status", await c.patch(f"{B}/projects/revisions/{rid1}", json={"status": "weird"}))
            rec("27-patch-unknown", await c.patch(f"{B}/projects/revisions/999", json={"note": "x"}))
            fork = rec("28-fork", await c.post(f"{B}/projects/items/{iid}/fork", json={"revision_id": rid1, "name": "Pièce v2"}))
            fid = fork["id"]
            rec("29-fork-wrong-item", await c.post(f"{B}/projects/items/{fid}/fork", json={"revision_id": rid2, "name": "x"}))
            rec("30-rename", await c.patch(f"{B}/projects/items/{fid}", json={"name": "Pièce renommée"}))
            rec("31-rename-conflict", await c.patch(f"{B}/projects/items/{fid}", json={"name": "pièce / principale"}))
            rec("32-add-files", await c.post(f"{B}/projects/revisions/{rid2}/files", **upload([("extra.bgcode", b"\x00bgc"), ("plate.gcode", b"G28\nG1")])))
            rec("33-add-files-non-printable", await c.post(f"{B}/projects/revisions/{rid2}/files", **upload([("notes.txt", b"hi")])))
            tree = rec("34-tree-after", await c.get(f"{B}/projects/{pid}/tree"))
            rev2 = next(r for s in tree["sections"] for i in s["items"] for r in i["revisions"] if r["id"] == rid2)
            f_ids = [f["id"] for f in rev2["files"]]
            rec("35-download-one", await c.get(f"{B}/projects/revisions/{rid2}/download", params={"file_id": f_ids[0]}), body=False)
            rec("36-download-zip", await c.get(f"{B}/projects/revisions/{rid2}/download"), body=False)
            rec("37-download-unknown-file", await c.get(f"{B}/projects/revisions/{rid2}/download", params={"file_id": 999}))
            rec("38-remove-file", await c.delete(f"{B}/projects/revisions/{rid2}/files/{f_ids[-1]}"))
            rec("39-remove-file-again", await c.delete(f"{B}/projects/revisions/{rid2}/files/{f_ids[-1]}"))
            rec("40-orders-none", await c.get(f"{B}/projects/{pid}/orders"))
            rec("41-legacy-status", await c.get(f"{B}/projects/legacy-migration/status"))
            rec("42-import-library-unknown", await c.post(f"{B}/projects/{pid}/import-library-files", json={"file_ids": [999, 998]}))
            rec("43-import-library-empty", await c.post(f"{B}/projects/{pid}/import-library-files", json={"file_ids": []}))
            rec("44-import-library-extra-field", await c.post(f"{B}/projects/{pid}/import-library-files", json={"file_ids": [1], "nope": 1}))
            rec("45-library-suggestions-unknown", await c.get(f"{B}/library/files/999/project-suggestions"))
            rec("46-ai-reformulate-unconfigured", await c.post(f"{B}/projects/ai/reformulate", json={"text": "support", "field": "title"}))
            rec("47-ai-suggest-tags-unconfigured", await c.post(f"{B}/projects/ai/suggest-tags", json={"title": "Support", "description": None, "exclude_tag_ids": []}))
            rec("48-reslice-unknown-pipeline", await c.post(f"{B}/projects/revisions/{rid1}/reslice", json={"file_id": f_ids[0], "pipeline_id": 1}))
            rec("49-delete-project-with-items", await c.delete(f"{B}/projects/{pid}"))

            # --- Aito side ----------------------------------------------------
            async with sm() as db:
                order = AitoProject(description="Commande support", board_column="devis", status="active", client_id="C1", client_name="ACME")
                db.add(order)
                await db.commit()
                task = AitoTask(project_id=order.id, title="Support caméra")
                task2 = AitoTask(project_id=order.id, title="Autre pièce")
                db.add_all([task, task2])
                await db.commit()
                oid, tid, tid2 = order.id, task.id, task2.id
            rec("50-project-codes-empty", await c.get(f"{B}/aito/project-codes"))
            rec("51-suggestions", await c.get(f"{B}/aito/tasks/{tid}/project-suggestions"))
            rec("52-link", await c.put(f"{B}/aito/tasks/{tid}/project", json={"project_id": pid}))
            rec("53-link-unknown-project", await c.put(f"{B}/aito/tasks/{tid}/project", json={"project_id": 999}))
            rec("54-link-unknown-task", await c.put(f"{B}/aito/tasks/999/project", json={"project_id": pid}))
            rec("55-project-codes", await c.get(f"{B}/aito/project-codes"))
            rec("56-order-links", await c.get(f"{B}/aito/{oid}/project-links"))
            rec("57-project-orders", await c.get(f"{B}/projects/{pid}/orders"))
            rec("58-deliveries", await c.put(f"{B}/aito/tasks/{tid}/deliveries", json={"revision_ids": [rid1, rid2]}))
            rec("59-deliveries-foreign-revision", await c.put(f"{B}/aito/tasks/{tid2}/deliveries", json={"revision_ids": [rid1]}))
            rec("60-create-project-for-task", await c.post(f"{B}/aito/tasks/{tid2}/project", json={"name": "Autre projet", "description": "créé depuis la carte", "new_tag_names": ["drone"]}))
            rec("61-create-project-for-task-blank", await c.post(f"{B}/aito/tasks/{tid2}/project", json={"name": "  "}))
            rec("62-drop-files", await c.post(f"{B}/aito/tasks/{tid2}/files", **upload([("boitier.3mf", PART_B), ("boitier.gcode", b"G1")])))
            rec("63-drop-non-printable", await c.post(f"{B}/aito/tasks/{tid2}/files", **upload([("scan.ply", b"ply")])))
            rec("64-unlink", await c.put(f"{B}/aito/tasks/{tid}/project", json={"project_id": None}))
            rec("65-order-links-final", await c.get(f"{B}/aito/{oid}/project-links"))
            rec("66-events-story", await c.get(f"{B}/aito/{oid}/events", params={"depth": "story"}))
            rec("67-tree-project-2", await c.get(f"{B}/projects/{pid2}/tree"))
            rec("68-delete-revision-used", await c.delete(f"{B}/projects/revisions/{rid1}"))
            rec("69-delete-revision", await c.delete(f"{B}/projects/revisions/{rid2}"))
            rec("70-delete-item-fork", await c.delete(f"{B}/projects/items/{fid}"))
            rec("71-delete-item-unknown", await c.delete(f"{B}/projects/items/999"))
            rec("72-tree-final", await c.get(f"{B}/projects/{pid}/tree"))
            rec("73-search-final", await c.get(f"{B}/projects/search"))

    app.dependency_overrides.clear()
    await engine.dispose()
    await asyncio.sleep(0.1)
    layout = sorted(str(p.relative_to(ROOT)) for p in (ROOT / "projects").rglob("*")) if (ROOT / "projects").exists() else []
    print(json.dumps({"steps": out, "disk_layout": layout}, sort_keys=True, indent=1, default=str, ensure_ascii=False))


asyncio.run(main())
