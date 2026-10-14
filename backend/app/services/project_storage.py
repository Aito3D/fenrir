"""The projects space: where project files live, and how its paths are built.

A sibling of ``archive/`` under the data directory, so moving the whole data
directory to the NAS later moves projects with it (spec §2.1). Folder names are
human-readable on purpose — the tree is meant to be browsed from the share
once it lives there — and every path that reaches the filesystem goes through
``resolve_in_projects``, which refuses anything that would leave the root.
"""

from __future__ import annotations

import os
import re
import shutil
import unicodedata
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path

from backend.app.core.config import settings
from backend.app.utils.safe_path import PathTraversalError, safe_join_under

PROJECTS_DIRNAME = "projects"
MAX_COMPONENT_CHARS = 100
# NAME_MAX of ext4 and the other Linux filesystems the Docker image runs on, in UTF-8 bytes.
MAX_COMPONENT_BYTES = 255
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


def _utf8_size(text: str) -> int:
    """Bytes ``text`` takes on disk; never raises (a lone surrogate counts as its 3-byte form)."""
    return len(text.encode("utf-8", "surrogatepass"))


def _fit_bytes(text: str, max_bytes: int) -> str:
    """The longest prefix of ``text`` within ``max_bytes`` UTF-8 bytes; never splits a code point."""
    size = 0
    for index, char in enumerate(text):
        size += _utf8_size(char)
        if size > max_bytes:
            return text[:index]
    return text


def _sanitize_chars(name: str, fallback: str) -> str:
    """``sanitize_component`` without the byte cap: the folder name before T-323."""
    cleaned = _FORBIDDEN_CHARS.sub("", unicodedata.normalize("NFC", name or ""))
    cleaned = cleaned.strip().strip(".").strip()
    cleaned = cleaned[:MAX_COMPONENT_CHARS].rstrip(" .")
    if not cleaned:
        return fallback
    if cleaned.split(".")[0].upper() in _WINDOWS_RESERVED:
        cleaned = f"_{cleaned}"
    return cleaned


def sanitize_component(name: str, fallback: str = "sans-nom") -> str:
    """One safe path component: separators, control and Windows-reserved
    characters removed, no leading/trailing dots or spaces, at most 100
    characters and 255 UTF-8 bytes, and never a bare Windows device name (spec §2.2).

    The byte cap only ever shortens a name that was over 255 bytes, so every
    name that fit before keeps exactly the same component."""
    return _fit_bytes(_sanitize_chars(name, fallback), MAX_COMPONENT_BYTES).rstrip(" .")


def storage_dir_name(code: str, title: str) -> str:
    """``P-0042_support-camera-fx3`` — the code is the stable part, the slug a hint."""
    return f"{code}_{slugify(title)}"


def resolve_in_projects(*parts: str) -> Path:
    """Join ``parts`` under the projects root. Raises ``PathTraversalError`` on escape."""
    return safe_join_under(projects_root(), *parts, http=False)


def ensure_project_dir(project) -> Path:
    """The project's folder, created if missing.

    Projects created before phase 1 have no ``storage_dir`` (spec §7 step 1
    leaves it NULL). The startup migration fixes their name and the file
    service claims it in the database before building a path
    (``project_files._claim_storage_dir``); the fallback here, from the title
    the project has at that moment, only serves a caller that skipped both.
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

# Projects hold printing files only for now (phase 5 scope): every other
# section stays in the data model but is closed to new files. Re-enabling a
# section is a change to these two constants.
ENABLED_SECTIONS: tuple[str, ...] = ("impression",)
PRINTABLE_EXTENSIONS: tuple[str, ...] = (".3mf", ".gcode", ".bgcode")  # ``.gcode.3mf`` ends in ``.3mf``


def is_printable_filename(name: str) -> bool:
    """A file projects accept today: ``.3mf`` (incl. ``.gcode.3mf``), ``.gcode`` or ``.bgcode``, any case."""
    return (name or "").strip().lower().endswith(PRINTABLE_EXTENSIONS)


def _item_component(project_dirname: str, section_dirname: str, item_name: str) -> str:
    """The item's folder name. A folder made before the 255-byte cap under the
    longer, character-capped name (possible only on a filesystem that allows it,
    such as APFS) keeps being used, so its files stay where they are."""
    component = sanitize_component(item_name)
    legacy = _sanitize_chars(item_name, "sans-nom")
    if legacy != component:
        section_path = resolve_in_projects(project_dirname, section_dirname)
        if os.path.isdir(os.path.join(section_path, legacy)):
            return legacy
    return component


def item_dir(project, section: str, item_name: str) -> Path:
    """``{storage_dir}/{Section}/{Item}`` — not created. KeyError on an unknown section."""
    project_dirname, section_dirname = ensure_project_dir(project).name, SECTION_DIRS[section]
    return resolve_in_projects(
        project_dirname, section_dirname, _item_component(project_dirname, section_dirname, item_name)
    )


def revision_folder_name(number: int) -> str:
    """The folder name of revision ``number`` under its item dir: ``R{number}``. Creates nothing."""
    return f"R{number}"


def revision_dir(project, section: str, item_name: str, number: int) -> Path:
    """``…/{Item}/R{number}``, created on the way."""
    project_dirname, section_dirname = ensure_project_dir(project).name, SECTION_DIRS[section]
    path = resolve_in_projects(
        project_dirname,
        section_dirname,
        _item_component(project_dirname, section_dirname, item_name),
        revision_folder_name(number),
    )
    path.mkdir(parents=True, exist_ok=True)
    return path


_EXTENSION = re.compile(r"\.[\w+-]{1,20}")


def split_gcode_3mf(name: str) -> tuple[str, str]:
    """``(stem, suffix)`` when ``name`` ends in ``.gcode.3mf`` (any case, suffix as written), else ``(name, "")``.

    The stem may be empty (``name`` is exactly the suffix); callers decide what that means."""
    if name.lower().endswith(_GCODE_3MF):
        return name[: -len(_GCODE_3MF)], name[-len(_GCODE_3MF) :]
    return name, ""


def _split_extension(name: str) -> tuple[str, str]:
    """``(stem, extension)``; ``.gcode.3mf`` is one extension. Odd suffixes count as no extension."""
    gcode_stem, gcode_ext = split_gcode_3mf(name)
    if gcode_ext and gcode_stem:
        return gcode_stem, gcode_ext
    stem, dot, ext = name.rpartition(".")
    if dot and stem and _EXTENSION.fullmatch(f".{ext}"):
        return stem, f".{ext}"
    return name, ""


def _fit_name(stem: str, suffix: str, ext: str) -> str:
    """``stem + suffix + ext`` with the stem trimmed so the whole stays within the component
    limits (characters and UTF-8 bytes); a name that fit before keeps the same result."""
    room = max(MAX_COMPONENT_CHARS - len(suffix) - len(ext), 1)
    room_bytes = max(MAX_COMPONENT_BYTES - _utf8_size(suffix) - _utf8_size(ext), 1)
    return f"{_fit_bytes(stem[:room], room_bytes).rstrip(' .') or 'f'}{suffix}{ext}"


def _candidate_paths(directory: Path, filename: str) -> Iterator[Path]:
    """``a.step``, ``a (2).step``, ``a (3).step``… inside ``directory``.

    The extension is split off first so truncating a long name never eats it."""
    raw_stem, ext = _split_extension(filename)
    stem = sanitize_component(raw_stem, fallback="fichier")
    yield safe_join_under(directory, _fit_name(stem, "", ext), http=False)
    counter = 2
    while True:
        yield safe_join_under(directory, _fit_name(stem, f" ({counter})", ext), http=False)
        counter += 1


def unique_file_path(directory: Path, filename: str) -> Path:
    """A free path for ``filename`` inside ``directory``: ``a.step``, ``a (2).step``…

    Only checks existence: two concurrent writers can get the same answer. Use
    ``claim_unique_file_path`` when the name is about to be written."""
    return next(path for path in _candidate_paths(directory, filename) if not path.exists())


def claim_unique_file_path(directory: Path, filename: str) -> Path:
    """Like ``unique_file_path``, but the name is reserved atomically: an empty
    file is created with ``O_EXCL``, so a concurrent writer moves on to the next
    name. The caller replaces the placeholder (``os.replace``) or unlinks it."""
    for path in _candidate_paths(directory, filename):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o666)
        except FileExistsError:
            continue
        os.close(fd)
        return path
    raise AssertionError("unreachable: candidate paths never run out")  # pragma: no cover


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
