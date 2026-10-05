"""The projects space: where project files live, and how its paths are built.

A sibling of ``archive/`` under the data directory, so moving the whole data
directory to the NAS later moves projects with it (spec §2.1). Folder names are
human-readable on purpose — the tree is meant to be browsed from the share
once it lives there — and every path that reaches the filesystem goes through
``resolve_in_projects``, which refuses anything that would leave the root.
"""

from __future__ import annotations

import re
import shutil
import unicodedata
from datetime import datetime
from pathlib import Path

from backend.app.core.config import settings
from backend.app.utils.safe_path import PathTraversalError, safe_join_under

PROJECTS_DIRNAME = "projects"
MAX_COMPONENT_CHARS = 100
_FORBIDDEN_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WINDOWS_RESERVED = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def projects_root() -> Path:
    """``{data}/projects``, created on first use."""
    root = settings.base_dir / PROJECTS_DIRNAME  # SEC-PATH-OK: constant directory name under the data dir
    root.mkdir(parents=True, exist_ok=True)
    return root


def slugify(title: str, max_chars: int = 40) -> str:
    """ASCII, lowercase, dash-separated. Never empty: falls back to ``projet``."""
    ascii_text = unicodedata.normalize("NFKD", title or "").encode("ascii", "ignore").decode("ascii").lower()
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_text).strip("-")
    slug = slug[:max_chars].rstrip("-")
    return slug or "projet"


def sanitize_component(name: str, fallback: str = "sans-nom") -> str:
    """One safe path component: separators, control and Windows-reserved
    characters removed, no leading/trailing dots or spaces, at most 100
    characters, and never a bare Windows device name (spec §2.2)."""
    cleaned = _FORBIDDEN_CHARS.sub("", unicodedata.normalize("NFC", name or ""))
    cleaned = cleaned.strip().strip(".").strip()
    cleaned = cleaned[:MAX_COMPONENT_CHARS].rstrip(" .")
    if not cleaned:
        return fallback
    if cleaned.split(".")[0].upper() in _WINDOWS_RESERVED:
        cleaned = f"_{cleaned}"
    return cleaned


def storage_dir_name(code: str, title: str) -> str:
    """``P-0042_support-camera-fx3`` — the code is the stable part, the slug a hint."""
    return f"{code}_{slugify(title)}"


def resolve_in_projects(*parts: str) -> Path:
    """Join ``parts`` under the projects root. Raises ``PathTraversalError`` on escape."""
    return safe_join_under(projects_root(), *parts, http=False)


def ensure_project_dir(project) -> Path:
    """The project's folder, created if missing.

    Projects created before phase 1 have no ``storage_dir`` (spec §7 step 1
    leaves it NULL); the name is fixed here, on first use, from the title the
    project has at that moment.
    """
    if not project.storage_dir:
        project.storage_dir = storage_dir_name(project.code or f"P-{project.id}", project.name)
    path = resolve_in_projects(project.storage_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


SECTION_DIRS: dict[str, str] = {
    "scan": "Scan",
    "modelisation": "Modélisation",
    "impression": "Impression",
    "usinage": "Usinage",
    "docs": "Docs",
}
TRASH_DIRNAME = "_trash"
_GCODE_3MF = ".gcode.3mf"


def item_dir(project, section: str, item_name: str) -> Path:
    """``{storage_dir}/{Section}/{Item}`` — not created. KeyError on an unknown section."""
    return resolve_in_projects(ensure_project_dir(project).name, SECTION_DIRS[section], sanitize_component(item_name))


def revision_dir(project, section: str, item_name: str, number: int) -> Path:
    """``…/{Item}/R{number}``, created on the way."""
    path = resolve_in_projects(
        ensure_project_dir(project).name, SECTION_DIRS[section], sanitize_component(item_name), f"R{number}"
    )
    path.mkdir(parents=True, exist_ok=True)
    return path


_EXTENSION = re.compile(r"\.[\w+-]{1,20}")


def _split_extension(name: str) -> tuple[str, str]:
    """``(stem, extension)``; ``.gcode.3mf`` is one extension. Odd suffixes count as no extension."""
    if name.lower().endswith(_GCODE_3MF) and len(name) > len(_GCODE_3MF):
        return name[: -len(_GCODE_3MF)], name[-len(_GCODE_3MF) :]
    stem, dot, ext = name.rpartition(".")
    if dot and stem and _EXTENSION.fullmatch(f".{ext}"):
        return stem, f".{ext}"
    return name, ""


def _fit_name(stem: str, suffix: str, ext: str) -> str:
    """``stem + suffix + ext`` with the stem trimmed so the whole stays within the component limit."""
    room = max(MAX_COMPONENT_CHARS - len(suffix) - len(ext), 1)
    return f"{stem[:room].rstrip(' .') or 'f'}{suffix}{ext}"


def unique_file_path(directory: Path, filename: str) -> Path:
    """A free path for ``filename`` inside ``directory``: ``a.step``, ``a (2).step``…

    The extension is split off first so truncating a long name never eats it."""
    raw_stem, ext = _split_extension(filename)
    stem = sanitize_component(raw_stem, fallback="fichier")
    candidate = safe_join_under(directory, _fit_name(stem, "", ext), http=False)
    counter = 2
    while candidate.exists():
        candidate = safe_join_under(directory, _fit_name(stem, f" ({counter})", ext), http=False)
        counter += 1
    return candidate


def move_to_trash(project, path: Path) -> Path | None:
    """Move a folder or file of the project into ``{storage_dir}/_trash/`` keeping
    its relative layout, suffixed with a timestamp. Nothing is deleted. Returns
    the new path, or None when ``path`` does not exist."""
    project_root = resolve_in_projects(ensure_project_dir(project).name)
    resolved = path.resolve()
    if resolved != project_root and project_root not in resolved.parents:
        raise PathTraversalError("Path is outside the project folder")
    relative = resolved.relative_to(project_root)
    if not relative.parts:
        raise PathTraversalError("Cannot trash the project folder itself")
    if relative.parts[0] == TRASH_DIRNAME:
        raise PathTraversalError("Path is already in the trash")
    if not resolved.exists():
        return None
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    target_parent = resolve_in_projects(project_root.name, TRASH_DIRNAME, *relative.parts[:-1])
    target_parent.mkdir(parents=True, exist_ok=True)
    leaf = relative.parts[-1]
    if resolved.is_dir():
        trashed = f"{leaf}-{stamp}"
    else:  # a file keeps its extension (``plate-<stamp>.gcode.3mf``)
        stem, ext = _split_extension(leaf)
        trashed = f"{stem}-{stamp}{ext}"
    target = unique_file_path(target_parent, trashed)
    shutil.move(str(resolved), str(target))
    return target
