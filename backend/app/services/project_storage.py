"""The projects space: where project files live, and how its paths are built.

A sibling of ``archive/`` under the data directory, so moving the whole data
directory to the NAS later moves projects with it (spec §2.1). Folder names are
human-readable on purpose — the tree is meant to be browsed from the share
once it lives there — and every path that reaches the filesystem goes through
``resolve_in_projects``, which refuses anything that would leave the root.
"""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path

from backend.app.core.config import settings
from backend.app.utils.safe_path import safe_join_under

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
    root = settings.base_dir / PROJECTS_DIRNAME
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
