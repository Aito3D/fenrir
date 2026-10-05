"""Slicer settings snapshot read from a 3MF (spec §5.1).

A Bambu Studio / OrcaSlicer 3MF embeds the effective settings it was saved or
sliced with in ``Metadata/project_settings.config`` (JSON). Storing that JSON
on the revision means editing a preset or a pipeline later never changes what
a past revision says about how it was made. Read defensively: a missing or
corrupt part leaves the field empty, it never fails the upload.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import zipfile
import zlib
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

_MAX_PART_BYTES = 8 * 1024 * 1024
# The model part carries the meshes (often well above 8 MB); the Application
# metadata sits in its header, so only its start is read.
_MODEL_HEAD_BYTES = 64 * 1024
_APPLICATION_RE = re.compile(r'<metadata\s+name="Application"\s*>([^<]+)</metadata>')
_CLIENT_VERSION_RE = re.compile(r'key="X-BBL-Client-Version"\s+value="([^"]*)"')


@dataclass(frozen=True)
class PrintSnapshot:
    config: dict | None
    config_hash: str | None
    slicer_name: str | None
    slicer_version: str | None
    print_profile: dict = field(default_factory=dict)


def is_3mf(filename: str) -> bool:
    return filename.lower().endswith(".3mf")


_READ_ERRORS = (zipfile.BadZipFile, RuntimeError, NotImplementedError, zlib.error, EOFError, OSError)


def _read(zf: zipfile.ZipFile, name: str) -> str | None:
    try:
        info = zf.getinfo(name)
    except KeyError:
        return None
    if info.file_size > _MAX_PART_BYTES:
        return None
    try:
        with zf.open(name) as part:
            data = part.read(_MAX_PART_BYTES + 1)
    except _READ_ERRORS:
        return None
    if len(data) > _MAX_PART_BYTES:
        return None
    return data.decode("utf-8", errors="replace")


def _read_head(zf: zipfile.ZipFile, name: str, limit: int) -> str | None:
    """The first ``limit`` bytes of a part, whatever its size (bounded read)."""
    try:
        with zf.open(name) as part:
            data = part.read(limit)
    except (KeyError, *_READ_ERRORS):
        return None
    return data.decode("utf-8", errors="replace")


def _load_config(raw: str | None) -> dict | None:
    if raw is None:
        return None
    try:
        value = json.loads(raw)
    except (ValueError, RecursionError):
        return None
    if not isinstance(value, dict) or not value:
        return None
    return value


def _first(value):
    return value[0] if isinstance(value, list) and value else value


def _as_list(value) -> list | None:
    if value is None:
        return None
    return value if isinstance(value, list) else [value]


def _profile(config: dict | None, sliced: bool) -> dict:
    profile: dict = {}
    if config:
        candidates = {
            "printer_model": config.get("printer_model"),
            "printer_preset": config.get("printer_settings_id"),
            "process_preset": config.get("print_settings_id"),
            "filament_presets": _as_list(config.get("filament_settings_id")),
            "filament_types": _as_list(config.get("filament_type")),
            "nozzle_diameter": _first(config.get("nozzle_diameter")),
            "layer_height": config.get("layer_height"),
        }
        profile = {key: value for key, value in candidates.items() if value not in (None, "", [])}
    profile["sliced"] = sliced
    return profile


def read_print_snapshot(path: Path) -> PrintSnapshot | None:
    """Snapshot of ``path``; None when it is not a readable zip."""
    try:
        zf = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError):
        return None
    try:
        with zf:
            names = set(zf.namelist())
            config = _load_config(_read(zf, "Metadata/project_settings.config"))
            slice_info = _read(zf, "Metadata/slice_info.config") or ""
            model = _read_head(zf, "3D/3dmodel.model", _MODEL_HEAD_BYTES) or ""
        slicer_name = slicer_version = None
        application = _APPLICATION_RE.search(model)
        if application:
            name, dash, version = application.group(1).strip().rpartition("-")
            slicer_name, slicer_version = (name, version) if dash and name else (application.group(1).strip(), None)
        if slicer_version is None:
            header = _CLIENT_VERSION_RE.search(slice_info)
            if header and header.group(1):
                slicer_version = header.group(1)
        if slicer_version is None and config and config.get("version"):
            slicer_version = str(config["version"])
        sliced = any(n.startswith("Metadata/plate_") and n.endswith(".gcode") for n in names)
        config_hash = (
            hashlib.sha256(
                json.dumps(config, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
                    "utf-8", errors="surrogatepass"
                )
            ).hexdigest()
            if config
            else None
        )
        return PrintSnapshot(config, config_hash, slicer_name, slicer_version, _profile(config, sliced))
    except Exception:
        logger.warning("Failed to read snapshot from %s", path, exc_info=True)
        return PrintSnapshot(None, None, None, None, {"sliced": False})
