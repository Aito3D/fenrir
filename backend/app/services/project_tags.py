"""Project tags on the shared ``library_tags`` catalogue (spec §1.2).

``projects.tags`` (the legacy comma-separated column) is kept as a normalised
MIRROR of the rows — names sorted case-insensitively, joined with ", " — so the
upstream project responses that read ``project.tags`` keep showing the right
tags without each of them learning about ``project_tags``. Every write goes
through ``set_project_tags``, which rewrites rows and mirror together.
"""

from __future__ import annotations

MAX_TAG_CHARS = 64


def tag_name_key(name: str) -> str:
    """Same rule as ``library_tags.name_key``: LOWER(TRIM(name))."""
    return name.strip().lower()


def clean_tag_name(name: str) -> str:
    """A storable tag name: no commas (they separate the mirror), trimmed, ≤ 64 chars."""
    return name.replace(",", " ").strip()[:MAX_TAG_CHARS].strip()


def split_tag_string(value: str | None) -> list[str]:
    """``"drone,, Drone , pièce auto,"`` → ``["drone", "pièce auto"]`` (first spelling wins)."""
    seen: set[str] = set()
    names: list[str] = []
    for part in (value or "").split(","):
        name = clean_tag_name(part)
        key = tag_name_key(name)
        if not name or key in seen:
            continue
        seen.add(key)
        names.append(name)
    return names


def tag_mirror(names: list[str]) -> str | None:
    return ", ".join(sorted(names, key=tag_name_key)) or None
