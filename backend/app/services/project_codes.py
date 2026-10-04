"""Project codes — ``P-0001``, ``P-0002``… (spec §1.1).

Allocated from a counter in the settings table that only ever moves forward,
so a deleted project's code is never handed out again. The counter is also
pushed past the highest code already in the table, which covers codes written
by an import or by hand.

``allocate_code_number`` takes a SYNC connection because it runs inside the
``Project`` ``before_insert`` mapper event, which is how every creation path
(create, template, import) gets a code without each route having to ask.
"""

from __future__ import annotations

import re

from sqlalchemy import text
from sqlalchemy.engine import Connection

CODE_COUNTER_KEY = "project_code_counter"
_CODE_RE = re.compile(r"^P-(\d+)$")


def format_project_code(number: int) -> str:
    return f"P-{number:04d}"


def parse_project_code(code: str | None) -> int | None:
    if not code:
        return None
    match = _CODE_RE.match(code.strip().upper())
    return int(match.group(1)) if match else None


def _stored_counter(value: object) -> int:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return 0


def allocate_code_number(connection: Connection) -> int:
    """Next code number; persists the counter in the same transaction.

    On PostgreSQL the counter row is locked (``FOR UPDATE``) so two concurrent
    creates serialise; SQLite already serialises writers. The startup
    migration always writes the counter row, so the unlocked first-insert
    path only runs on a database that has never started this build.
    """
    lock = " FOR UPDATE" if connection.dialect.name == "postgresql" else ""
    row = connection.execute(
        text(f"SELECT value FROM settings WHERE key = :key{lock}"), {"key": CODE_COUNTER_KEY}
    ).first()
    stored = _stored_counter(row[0]) if row else 0
    highest = 0
    for (code,) in connection.execute(text("SELECT code FROM projects WHERE code IS NOT NULL")):
        number = parse_project_code(code)
        if number and number > highest:
            highest = number
    number = max(stored, highest) + 1
    params = {"key": CODE_COUNTER_KEY, "value": str(number)}
    if row is None:
        connection.execute(text("INSERT INTO settings (key, value) VALUES (:key, :value)"), params)
    else:
        connection.execute(text("UPDATE settings SET value = :value WHERE key = :key"), params)
    return number
