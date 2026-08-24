"""Filesystem bridge to a locally installed Bambu Studio (or BambuStudioBeta).

Reads and writes the user preset folders that Bambu Studio keeps under
``~/Library/Application Support/<App>/user/<uid>/filament`` (macOS layout),
and reads the bundled base-preset JSON files shipped inside the app. All
functions here are synchronous filesystem operations; API routes call them
via ``asyncio.to_thread`` to avoid blocking the event loop.

``settings.bambu_studio_user_dirs`` / ``settings.bambu_studio_bundle_dir``
override the derived paths for tests and non-macOS deployments where the app
isn't installed at the default Applications path.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from backend.app.core.config import settings
from backend.app.utils.safe_path import PathTraversalError, safe_join_under

logger = logging.getLogger(__name__)

BAMBU_APP_NAMES = ["BambuStudio", "BambuStudioBeta"]
DEFAULT_BAMBU_USER_ID = "1961034787"
DEFAULT_BUNDLE_DIR = "/Applications/BambuStudio.app/Contents/Resources/profiles/BBL/filament"


def effective_bambu_user_id() -> str:
    """The configured Bambu account id, or the default if it isn't digits-only.

    The id is used as a path component when deriving the per-user preset
    folders, so anything that isn't a plain digit string (e.g. a traversal
    attempt smuggled in via the env var) is rejected in favour of the
    well-known default.
    """
    uid = settings.bambu_user_id
    if uid and uid.isdigit():
        return uid
    logger.warning("Invalid BAMBU_USER_ID %r; falling back to default %s", uid, DEFAULT_BAMBU_USER_ID)
    return DEFAULT_BAMBU_USER_ID


def get_user_filament_dirs() -> list[Path]:
    """The per-app user filament preset folders, one per entry in ``BAMBU_APP_NAMES``.

    ``settings.bambu_studio_user_dirs`` overrides the derived list wholesale
    (used by tests and non-macOS deploys).
    """
    if settings.bambu_studio_user_dirs is not None:
        return [Path(d) for d in settings.bambu_studio_user_dirs]

    uid = effective_bambu_user_id()
    base = Path.home() / "Library" / "Application Support"
    dirs = []
    for app in BAMBU_APP_NAMES:
        parent = base / app / "user"
        dirs.append(safe_join_under(parent, uid, "filament", http=False))
    return dirs


def get_bundle_filament_dir() -> Path:
    """The bundled base-preset directory shipped inside the Bambu Studio app."""
    if settings.bambu_studio_bundle_dir:
        return Path(settings.bambu_studio_bundle_dir)
    return Path(DEFAULT_BUNDLE_DIR)


def _read_json_files(folder: Path) -> list[tuple[str, str]]:
    """List ``(filename, content)`` for every ``*.json`` file directly in *folder*.

    A missing folder naturally yields no matches. Any other listing failure,
    and any per-file read failure, is swallowed and the offending entry
    silently skipped — this is a best-effort scan of a directory maintained
    by a third-party app, not a trusted data store.
    """
    results: list[tuple[str, str]] = []
    try:
        paths = sorted(folder.glob("*.json"))
    except OSError:
        logger.warning("Could not list %s", folder)
        return results
    for path in paths:
        try:
            results.append((path.name, path.read_text()))
        except OSError:
            logger.warning("Could not read %s", path)
            continue
    return results


def scan_user_presets() -> list[dict[str, str]]:
    """All user presets across the configured folders, first folder wins by filename."""
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for folder in get_user_filament_dirs():
        for filename, content in _read_json_files(folder):
            if filename in seen:
                continue
            seen.add(filename)
            out.append({"filename": filename, "content": content})
    return out


def read_bundle_preset(filename: str) -> str | None:
    """Read a single base preset's raw content by bare filename, or None if absent.

    Callers are expected to have already validated *filename* is a bare
    basename (no path separators); ``safe_join_under`` is the belt-and-braces
    containment check.
    """
    bundle = get_bundle_filament_dir()
    try:
        path = safe_join_under(bundle, filename, http=False)
    except PathTraversalError:
        return None
    if not path.is_file():
        return None
    try:
        return path.read_text()
    except OSError:
        return None


def read_disk_state() -> dict[str, dict[str, str]]:
    """Map ``filename -> {str(folder): content}`` across every user preset folder."""
    state: dict[str, dict[str, str]] = {}
    for folder in get_user_filament_dirs():
        folder_key = str(folder)
        for filename, content in _read_json_files(folder):
            state.setdefault(filename, {})[folder_key] = content
    return state


def compute_sync_stats(
    presets: list[dict[str, str]], disk: dict[str, dict[str, str]], folders: list[Path]
) -> dict[str, int]:
    """Classify a proposed sync of *presets* against *disk* state without writing anything.

    - ``added``: filename present in no folder.
    - ``unchanged``: filename present in EVERY folder with byte-identical content.
    - ``updated``: present somewhere, but not unchanged.
    - ``removed``: filenames found on disk that aren't in the incoming set.

    Entries with an empty filename or content are skipped on the incoming side.
    """
    stats = {"added": 0, "updated": 0, "removed": 0, "unchanged": 0}
    incoming_names: set[str] = set()
    for preset in presets:
        filename = preset.get("filename") or ""
        content = preset.get("content") or ""
        if not filename or not content:
            continue
        incoming_names.add(filename)
        folder_map = disk.get(filename, {})
        if not folder_map:
            stats["added"] += 1
        elif all(folder_map.get(str(folder)) == content for folder in folders):
            stats["unchanged"] += 1
        else:
            stats["updated"] += 1

    for filename in disk:
        if filename not in incoming_names:
            stats["removed"] += 1

    return stats


def apply_sync(presets: list[dict[str, str]]) -> dict[str, int]:
    """Mirror *presets* into every user preset folder, removing anything not incoming.

    Ensures each folder exists, computes stats against the pre-write disk
    state, then per folder: writes each preset whose content in that folder
    differs (or is absent), then unlinks any on-disk filename not in the
    incoming set.
    """
    folders = get_user_filament_dirs()
    for folder in folders:
        folder.mkdir(parents=True, exist_ok=True)

    disk = read_disk_state()
    stats = compute_sync_stats(presets, disk, folders)

    valid = [p for p in presets if (p.get("filename") or "") and (p.get("content") or "")]
    incoming_names = {p["filename"] for p in valid}

    for folder in folders:
        folder_key = str(folder)

        for preset in valid:
            filename = preset["filename"]
            content = preset["content"]
            if disk.get(filename, {}).get(folder_key) == content:
                continue
            try:
                target = safe_join_under(folder, filename, http=False)
                target.write_text(content)
            except (OSError, PathTraversalError):
                logger.warning("Could not write %s into %s", filename, folder)

        for filename, folder_map in disk.items():
            if filename in incoming_names or folder_key not in folder_map:
                continue
            try:
                target = safe_join_under(folder, filename, http=False)
                if target.is_file():
                    target.unlink()
            except (OSError, PathTraversalError):
                logger.warning("Could not remove %s from %s", filename, folder)

    return stats


def _first(value: object) -> str:
    """Normalise a Bambu Studio slicer field (often a single-element list) to a string."""
    if isinstance(value, list):
        return str(value[0]) if value else ""
    if value is None:
        return ""
    return str(value)


def parse_base_preset_file(path: Path) -> dict[str, str]:
    """Parse one bundled base-preset JSON file into a flat record.

    Unparseable files (missing, unreadable, or invalid JSON) still produce a
    record — named after the file stem, every other field empty — so the
    bundle listing stays complete even when a shipped file is malformed.
    """
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return {
            "name": path.stem,
            "inherits": "",
            "brand": "",
            "material": "",
            "color": "",
            "color_hex": "",
            "filename": path.name,
        }

    return {
        "name": str(data.get("name") or path.stem),
        "inherits": _first(data.get("inherits")),
        "brand": _first(data.get("filament_vendor")),
        "material": _first(data.get("filament_type")),
        "color": "",
        "color_hex": _first(data.get("filament_colour")),
        "filename": path.name,
    }


def collect_base_presets() -> list[dict[str, str]]:
    """Every bundled base preset, expanded through its ``inherits`` closure.

    For each parsed record, walks the inheritance chain by name (guarded by
    a per-walk ``visited`` set of filenames against cycles) and accumulates
    every record touched into a single filename-keyed map, so the final
    result is stable regardless of iteration order or inheritance cycles.
    """
    bundle = get_bundle_filament_dir()
    try:
        paths = sorted(bundle.glob("*.json"))
    except OSError:
        logger.warning("Could not list %s", bundle)
        paths = []

    records = [parse_base_preset_file(path) for path in paths]
    by_name = {record["name"]: record for record in records}

    included: dict[str, dict[str, str]] = {}
    for record in records:
        visited: set[str] = set()
        current: dict[str, str] | None = record
        while current is not None and current["filename"] not in visited:
            visited.add(current["filename"])
            included[current["filename"]] = current
            parent_name = current.get("inherits") or ""
            current = by_name.get(parent_name) if parent_name else None

    return list(included.values())
