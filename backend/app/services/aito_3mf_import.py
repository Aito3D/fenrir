"""Aito: turn a Bambu Studio project .3mf into per-plate facts (design 2026-11-14).

The new project modal imports a project file and creates one print task per plate. The file
is sliced with its own settings; this module reads the plate names, objects and sizes from
the SOURCE and the time, weight and filaments from the SLICE. Nothing is stored.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import re
import uuid
import zipfile
from typing import Any

import defusedxml.ElementTree as ET

from backend.app.services.http_status_error import HttpStatusError
from backend.app.services.project_snapshot import _MAX_PART_BYTES
from backend.app.utils.printer_models import normalize_printer_model_id

logger = logging.getLogger(__name__)

ALREADY_SLICED = "This file is already sliced; import the Bambu Studio project .3mf."
NO_SETTINGS = "This .3mf has no slicer settings; open and save it in Bambu Studio first."

_SETTINGS = "Metadata/project_settings.config"
_MODEL_SETTINGS = "Metadata/model_settings.config"
_SLICE_INFO = "Metadata/slice_info.config"
_GCODE_RE = re.compile(r"^Metadata/plate_\d+\.gcode$")
_NAME_EXT_RE = re.compile(r"\.(stl|step|stp|3mf|obj)$", re.IGNORECASE)
_MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024


class Import3mfError(HttpStatusError):
    """A refusal the operator can read."""


def check_importable(source: bytes) -> None:
    """Refuse anything but an unsliced Bambu project file. By content, never by name."""
    from backend.app.services.project_files import ProjectFilesError
    from backend.app.services.project_slice import check_source_within_caps

    try:
        with zipfile.ZipFile(io.BytesIO(source)) as zf:
            names = zf.namelist()
    except zipfile.BadZipFile as exc:
        raise Import3mfError(400, NO_SETTINGS) from exc
    if any(_GCODE_RE.match(name) for name in names):
        raise Import3mfError(400, ALREADY_SLICED)
    if _SETTINGS not in names:
        raise Import3mfError(400, NO_SETTINGS)
    try:
        check_source_within_caps(source)
    except ProjectFilesError as exc:
        raise Import3mfError(exc.status_code, exc.detail) from exc
    with zipfile.ZipFile(io.BytesIO(source)) as zf:
        if _MODEL_SETTINGS in names and zf.getinfo(_MODEL_SETTINGS).file_size > _MAX_PART_BYTES:
            raise Import3mfError(413, _model_settings_too_big())


def _model_settings_too_big() -> str:
    from backend.app.services.project_slice import _SETTINGS_TOO_BIG

    return _SETTINGS_TOO_BIG.format(limit=_MAX_PART_BYTES // (1024 * 1024))


def _read_capped(zf: zipfile.ZipFile, name: str, cap: int) -> bytes | None:
    """The entry's bytes, or None when it is over `cap` (declared size, or the actual read for a lying header)."""
    if zf.getinfo(name).file_size > cap:
        return None
    with zf.open(name) as f:
        data = f.read(cap + 1)
    return data if len(data) <= cap else None


def _metadata(elem) -> dict[str, str]:
    return {m.get("key"): m.get("value", "") for m in elem.findall("metadata") if m.get("key")}


def _read_xml(zf: zipfile.ZipFile, name: str):
    try:
        return ET.fromstring(zf.read(name))
    except (KeyError, ET.ParseError):
        return None


def _int(value: str | None) -> int | None:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _float(value: str | None) -> float | None:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _slice_plates(sliced: bytes) -> dict[int, dict[str, Any]]:
    """Plate index -> time, weight, printer and filaments, from the slicer's output."""
    out: dict[int, dict[str, Any]] = {}
    with zipfile.ZipFile(io.BytesIO(sliced)) as zf:
        root = _read_xml(zf, _SLICE_INFO)
        try:
            vendors = json.loads(zf.read(_SETTINGS)).get("filament_vendor") or []
        except (KeyError, ValueError, AttributeError):
            vendors = []
    for plate in root.findall(".//plate") if root is not None else []:
        meta = _metadata(plate)
        index = _int(meta.get("index"))
        if index is None:
            continue
        filaments = []
        for row in plate.findall("filament"):
            slot = _int(row.get("id"))
            vendor = vendors[slot - 1] if slot and 0 < slot <= len(vendors) else None
            filaments.append(
                {
                    "type": row.get("type") or "",
                    "color": row.get("color") or "",
                    "used_g": _float(row.get("used_g")) or 0.0,
                    "vendor": vendor if isinstance(vendor, str) and vendor else None,
                }
            )
        prediction = _float(meta.get("prediction"))
        out[index] = {
            "print_time_seconds": None if prediction is None else int(prediction),
            "weight_g": _float(meta.get("weight")),
            "printer_model": normalize_printer_model_id(meta.get("printer_model_id")),
            "filaments": filaments,
        }
    return out


def _instance_sizes(zf: zipfile.ZipFile) -> dict[str, list[tuple[int, int, int]]]:
    """Object id -> the size (x, y, z mm) of each of its build items, in file order.

    The world axis-aligned box of every mesh the object places, so a rotated part reports
    its footprint as it lies on the plate. Shares plate_thumbnail's streaming model reader.
    """
    import numpy as np

    from backend.app.services import plate_thumbnail
    from backend.app.services.plate_thumbnail import _MAX_COMPONENT_DEPTH, _MODEL_ROOT, _parse_model_file

    names = set(zf.namelist())
    files: dict[str, dict] = {}

    def objects_in(path: str) -> dict:
        if path not in files:
            files[path] = _parse_model_file(zf, path)[0] if path in names else {}
        return files[path]

    root_objects, build = _parse_model_file(zf, _MODEL_ROOT)
    files[_MODEL_ROOT] = root_objects

    placed_count = 0

    def corners(path: str, object_id: str, matrix, depth: int, trail: frozenset) -> list:
        # Same ceiling as the thumbnail renderer: a crafted component fan-out must not buy unbounded work.
        nonlocal placed_count
        placed_count += 1
        if placed_count > plate_thumbnail._MAX_PLACEMENTS:
            raise ValueError("too many placed parts to measure")
        key = (path, object_id)
        obj = objects_in(path).get(object_id)
        if obj is None or depth > _MAX_COMPONENT_DEPTH or key in trail:
            return []
        out = []
        if obj.vertices is not None and len(obj.vertices):
            placed = obj.vertices @ matrix[:3, :3].T + matrix[:3, 3]
            out += [placed.min(axis=0), placed.max(axis=0)]
        for ref, child_id, child_matrix in obj.components:
            out += corners(ref or path, child_id, matrix @ child_matrix, depth + 1, trail | {key})
        return out

    sizes: dict[str, list[tuple[int, int, int]]] = {}
    for ref, object_id, matrix in build:
        points = corners(ref or _MODEL_ROOT, object_id, matrix, 0, frozenset())
        if not points:
            continue
        stacked = np.vstack(points)
        x, y, z = (round(float(v)) for v in stacked.max(axis=0) - stacked.min(axis=0))
        sizes.setdefault(object_id, []).append((x, y, z))
    return sizes


def _plate_objects(plate, names: dict[str, str], sizes: dict[str, list[tuple[int, int, int]]]) -> list[dict]:
    """The plate's instances, identical ones (name and size) merged, in order of first appearance."""
    groups: dict[tuple, dict] = {}
    for instance in plate.findall("model_instance"):
        meta = _metadata(instance)
        object_id = meta.get("object_id")
        if not object_id:
            continue
        name = _NAME_EXT_RE.sub("", names.get(object_id, "").strip()) or f"#{object_id}"
        of_object = sizes.get(object_id) or []
        # Instance k of an object is its k-th build item; Bambu Studio writes copies as
        # separate objects, so k is normally 0.
        k = _int(meta.get("instance_id")) or 0
        x, y, z = of_object[k] if 0 <= k < len(of_object) else (of_object[0] if of_object else (None, None, None))
        group = groups.setdefault((name, x, y, z), {"name": name, "count": 0, "x_mm": x, "y_mm": y, "z_mm": z})
        group["count"] += 1
    return list(groups.values())


def plate_facts(source: bytes, sliced: bytes) -> list[dict[str, Any]]:
    """One dict per plate of the project file, ordered by plate number."""
    slices = _slice_plates(sliced)
    plates: list[dict[str, Any]] = []
    with zipfile.ZipFile(io.BytesIO(source)) as zf:
        try:
            raw = _read_capped(zf, _MODEL_SETTINGS, _MAX_PART_BYTES)
            if raw is None:
                raise Import3mfError(413, _model_settings_too_big())
            root = ET.fromstring(raw)
        except (KeyError, ET.ParseError):
            return []
        try:
            sizes = _instance_sizes(zf)
        except Exception:  # best effort: a plate without sizes is still worth importing
            logger.warning("Aito .3mf import: could not measure the objects", exc_info=True)
            sizes = {}
        names = {oid: _metadata(obj).get("name", "") for obj in root.findall("object") if (oid := obj.get("id"))}
        zip_names = set(zf.namelist())
        thumbnails: dict[int, str | None] = {}
        for plate in root.findall("plate"):
            meta = _metadata(plate)
            index = _int(meta.get("plater_id"))
            if index is None:
                continue
            if index not in thumbnails:
                thumb = f"Metadata/plate_{index}_small.png"
                data = _read_capped(zf, thumb, _MAX_THUMBNAIL_BYTES) if thumb in zip_names else None
                thumbnails[index] = None if data is None else "data:image/png;base64," + base64.b64encode(data).decode()
            empty = {"print_time_seconds": None, "weight_g": None, "printer_model": None, "filaments": []}
            plates.append(
                {
                    "index": index,
                    "name": meta.get("plater_name", "").strip() or None,
                    **slices.get(index, empty),
                    "objects": _plate_objects(plate, names, sizes),
                    "thumbnail": thumbnails[index],
                }
            )
    return sorted(plates, key=lambda p: p["index"])


async def slice_source(db, source: bytes, filename: str, job_id: int) -> bytes:
    """Slice the project file with its own settings, all plates; the slicer's output .3mf.

    The same call as ``project_slice._slice_source``, without a revision to store into."""
    import asyncio

    from backend.app.api.routes.library import resolve_slicer_api_url
    from backend.app.services.project_slice import NO_SLICER, _error_status_and_message, _slice_slot
    from backend.app.services.slice_dispatch import slice_dispatch
    from backend.app.services.slicer_api import SlicerApiService, get_stall_timeout_seconds
    from backend.app.utils.threemf_tools import sanitize_project_settings_sentinels

    url = await resolve_slicer_api_url(db)
    if url is None:
        raise Import3mfError(400, NO_SLICER)
    timeout = await get_stall_timeout_seconds(db)
    await db.commit()  # end the read transaction: the slice can take minutes
    try:
        # The slot project revisions take: a queued import holds no transaction (committed above) and its
        # stall clock starts with the sidecar call, inside the slot.
        async with _slice_slot(), SlicerApiService(url, timeout_seconds=timeout) as service:
            result = await service.slice_without_profiles(
                model_bytes=await asyncio.to_thread(sanitize_project_settings_sentinels, source),
                model_filename=filename,
                plate=0,
                export_3mf=True,
                request_id=uuid.uuid4().hex,
                on_progress=lambda snapshot: slice_dispatch.set_progress(job_id, snapshot),
            )
    except Exception as exc:
        raise Import3mfError(*_error_status_and_message(exc)) from exc
    return result.content
