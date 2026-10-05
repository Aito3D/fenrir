"""Searchable extras for the Aito board's client-side search.

The board card already carries every client and shipping field the search
box reads. Two things it did not: the text of its tasks, derived per
response by `task_search_text`, and the Zoho document numbers a customer may
quote back, stored by `remember_document_numbers` wherever an invoice or
retainer is already in hand. Neither costs a Zoho call.
"""

import json
from collections.abc import Iterable
from typing import Any

from backend.app.services.aito_board_rules import SERVICES

SEARCH_TEXT_LIMIT = 2000
DOCUMENT_NUMBERS_LIMIT = 20

_TASK_FIELDS = ("title", "impression_color", *(f"{service}_description" for service in SERVICES))


def task_search_text(tasks: Iterable[Any]) -> str:
    """Every task's title, colour and step notes, in panel order, one per
    line. Capped so a card with pages of notes cannot bloat the board."""
    parts: list[str] = []
    for task in tasks:
        for name in _TASK_FIELDS:
            value = (getattr(task, name, None) or "").strip()
            if value:
                parts.append(value)
    return "\n".join(parts)[:SEARCH_TEXT_LIMIT]


def document_numbers_of(project: Any) -> list[str]:
    """The stored numbers, or [] for a NULL or unreadable column."""
    raw = getattr(project, "document_numbers", None)
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(value, list):
        return []
    return [entry for entry in value if isinstance(entry, str) and entry]


def remember_document_numbers(project: Any, *numbers: object) -> None:
    """Add numbers the customer may quote back. Sticky: a voided invoice's
    number still finds the card. Writes only when something is new, so a
    sweep pass over an unchanged card does not dirty the row."""
    current = document_numbers_of(project)
    changed = False
    for number in numbers:
        text = str(number or "").strip()
        if text and text not in current:
            current.append(text)
            changed = True
    if changed:
        project.document_numbers = json.dumps(current[-DOCUMENT_NUMBERS_LIMIT:])
