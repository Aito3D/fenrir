"""Cards follow a client renamed directly in Zoho Books.

A card stores the client's name as a snapshot taken when the contact was
attached (``client_snapshot`` on import, the picker's row on creation). Two
things keep that snapshot fresh, and both only see edits made HERE: the
panel's client editor writes Books first and then re-snapshots the card and
its siblings (``update_client`` in routes/aito.py), and the quote sweep moves
a card whose ESTIMATE was re-assigned to another customer
(``_follow_customer``). A contact renamed in Books itself reached neither:
the board kept the old name, and — because the modal's client picker searches
Books live — typing the name on the card found nothing (the 2026-09-24 case:
card "Dam DH", contact renamed "Damien Ritter" in Books the day before).

This is the invoice poll's shape applied to contacts: one org-wide "which
customer contacts changed since I last looked" read a tick, attributed to
cards by ``client_id`` and nothing else, then the same name fan-out the client
editor does — every ACTIVE card on that contact, never the walk-in bucket
(every counter sale shares that id, so a rename there is not a rename of any
one client).

Deliberately narrow: only ``client_name`` is refreshed. Phone and email on a
card are person-level (the card's chosen contact person, not the contact) and
the company flag was decided at attach time; neither is a fact this pass can
settle from a contact list row. A rename is recorded on each card's history
as a system ``project.updated`` — the same event the client editor records,
shown with the "automatic" suffix — so "who changed the name" has an answer.
"""

import logging
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.websocket import ws_manager
from backend.app.models.aito_project import AitoProject
from backend.app.services.aito_events import diff_fields, record
from backend.app.services.aito_poll_watermark import (
    advance_watermark,
    format_books_time,
    parse_books_time,
    read_since,
)
from backend.app.services.zoho import zoho_service

logger = logging.getLogger(__name__)

# The watermark: the Books timestamp this poll last caught up to. Persisted in
# settings so a restart neither rescans the org nor skips its downtime.
POLL_SINCE_SETTING = "aito_contact_poll_since"

# How far back the very first pass looks, so cards that went stale before
# this feature existed catch up on the first tick (the live org's 90-day
# window read one page).
BACKFILL_DAYS = 90

# Rewind from the newest row seen, closing the same-second seam the invoice
# poll documents. Re-reading is free: an unchanged name writes nothing.
OVERLAP_SECONDS = 300

# The rewind on a pass the listing's page cap cut short: resume at the last
# row read (the invoice poll's TRUNCATED_OVERLAP_SECONDS, for the same
# reasons — a bulk edit can stamp more than a capped pass inside five
# minutes, and one second still re-reads the cut-off row's timestamp twins).
TRUNCATED_OVERLAP_SECONDS = 1

# Consecutive passes a contact's rename may fail while still holding the
# watermark (T-080, the invoice poll's MAX_ADOPT_FAILURES for the same
# reason): past that the row is poison, not transiently broken, and pinning
# the window at its timestamp would make every tick re-list a growing slice
# of the org — once that slice passes the listing's page cap, no rename made
# in Books after it would ever reach a card. Giving up costs the poison
# contact its retries (its cards keep the old name), not the future: a
# contact edited in Books again gets a fresh ``last_modified_time`` and
# re-enters the window, and its count is dropped once it leaves the window.
MAX_RENAME_FAILURES = 3

# Consecutive rename failures, per contact id. Module state, as the invoice
# poll's: a property of this process's conversation with Books, and a restart
# re-earning three attempts is the right behaviour.
_rename_failures: dict[str, int] = {}


def _reset_rename_failures() -> None:
    """Forget every counted failure — tests run this around each pass."""
    _rename_failures.clear()


# The shared Books-timestamp helpers (aito_poll_watermark), under the names
# this module and its tests have always used.
_format_books_time = format_books_time
_parse_books_time = parse_books_time


async def _since(db: AsyncSession) -> str:
    return await read_since(db, POLL_SINCE_SETTING, BACKFILL_DAYS)


async def _rename_cards(db: AsyncSession, contact_id: str, name: str) -> int:
    """Re-snapshot ``client_name`` on every active card of this contact.

    One commit for the whole contact: its cards change together or not at
    all, the same unit the client editor's fan-out commits.
    """
    cards = list(
        (
            await db.execute(
                select(AitoProject).where(AitoProject.client_id == contact_id, AitoProject.status == "active")
            )
        ).scalars()
    )
    renamed: list[int] = []
    for card in cards:
        changes = diff_fields(card, {"client_name": name})
        if not changes:
            continue
        card.client_name = name
        await record(
            db,
            card.id,
            "project.updated",
            actor_class="system",
            subject_type="project",
            subject_id=card.id,
            changes=changes,
        )
        renamed.append(card.id)
    if not renamed:
        return 0
    await db.commit()
    for project_id in renamed:
        try:
            await ws_manager.broadcast_aito(
                {"type": "aito_changed", "action": "contact-poll", "project_id": project_id, "actor": None}
            )
        except Exception:
            logger.warning("aito_changed broadcast failed for contact-poll", exc_info=True)
    return len(renamed)


async def poll_contacts(db: AsyncSession) -> int:
    """Rename every card whose contact Books has renamed since the last pass.

    Returns the number of cards written. Raises ``ZohoRateLimited`` (and any
    other listing failure) without advancing the watermark, so the window is
    re-read once Books answers again.
    """
    since = await _since(db)
    rows = await zoho_service.list_contacts_modified_since(db, since)
    walk_in_id, _walk_in_name = await zoho_service.get_default_contact(db)

    updated = 0
    newest: datetime | None = None
    # The oldest row this pass could not finish: the watermark must not pass
    # it, or the retry would never be offered — up to MAX_RENAME_FAILURES
    # passes, after which a contact that is never going to succeed stops
    # holding the window open for everyone else.
    oldest_failure: datetime | None = None
    seen: set[str] = set()

    for row in rows:
        moment = _parse_books_time(row.get("last_modified_time"))
        contact_id = str(row.get("id") or "")
        name = (row.get("name") or "").strip()
        seen.add(contact_id)
        try:
            # A blank name is a Books row this pass cannot trust; the walk-in
            # bucket is shared by every counter sale.
            if contact_id and name and contact_id != walk_in_id:
                updated += await _rename_cards(db, contact_id, name)
        except (SQLAlchemyError, ValueError, TypeError, KeyError) as exc:
            failures = _rename_failures.get(contact_id, 0) + 1
            _rename_failures[contact_id] = failures
            try:
                await db.rollback()
            except SQLAlchemyError:
                pass
            if failures < MAX_RENAME_FAILURES:
                logger.warning("Contact poll skipped contact %s: %s", contact_id, exc)
                if moment and (oldest_failure is None or moment < oldest_failure):
                    oldest_failure = moment
                continue
            if failures == MAX_RENAME_FAILURES:
                # Once, at ERROR — the count is kept so the next pass says it
                # again at debug rather than filling the log every tick.
                logger.error(
                    "Contact poll giving up on contact %s after %d consecutive failures; "
                    "the watermark will advance past it. Last error: %s",
                    contact_id,
                    failures,
                    exc,
                )
            else:
                logger.debug(
                    "Contact poll still failing on contact %s (%d consecutive): %s",
                    contact_id,
                    failures,
                    exc,
                )
            # Deliberately NOT fed into oldest_failure: a poison contact
            # counts as seen from here on, so the window stops growing.
            if moment and (newest is None or moment > newest):
                newest = moment
            continue
        _rename_failures.pop(contact_id, None)
        if moment and (newest is None or moment > newest):
            newest = moment

    # A counted contact no longer in the window cannot be retried anyway;
    # drop it so the dict stays the size of the current window's failures.
    for stale in [k for k in _rename_failures if k not in seen]:
        del _rename_failures[stale]

    await advance_watermark(
        db,
        POLL_SINCE_SETTING,
        since,
        rows,
        newest,
        oldest_failure,
        overlap_seconds=OVERLAP_SECONDS,
        truncated_overlap_seconds=TRUNCATED_OVERLAP_SECONDS,
    )
    return updated
