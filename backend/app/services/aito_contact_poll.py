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
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.websocket import ws_manager
from backend.app.models.aito_project import AitoProject
from backend.app.services.aito_events import diff_fields, record
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

# Books' own spelling: offset as ±HHMM, never 'Z' (rejected outright).
_BOOKS_TIME = "%Y-%m-%dT%H:%M:%S%z"


def _format_books_time(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime(_BOOKS_TIME)


def _parse_books_time(value: str | None) -> datetime | None:
    try:
        return datetime.strptime((value or "").strip(), _BOOKS_TIME)
    except ValueError:
        return None


async def _since(db: AsyncSession) -> str:
    from backend.app.api.routes.settings import get_setting

    stored = (await get_setting(db, POLL_SINCE_SETTING) or "").strip()
    if _parse_books_time(stored) is not None:
        return stored
    return _format_books_time(datetime.now(timezone.utc) - timedelta(days=BACKFILL_DAYS))


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
    from backend.app.api.routes.settings import set_setting

    since = await _since(db)
    rows = await zoho_service.list_contacts_modified_since(db, since)
    walk_in_id, _walk_in_name = await zoho_service.get_default_contact(db)

    updated = 0
    newest: datetime | None = None
    # The oldest row this pass could not finish: the watermark must not pass
    # it, or the retry would never be offered.
    oldest_failure: datetime | None = None

    for row in rows:
        moment = _parse_books_time(row.get("last_modified_time"))
        contact_id = str(row.get("id") or "")
        name = (row.get("name") or "").strip()
        try:
            # A blank name is a Books row this pass cannot trust; the walk-in
            # bucket is shared by every counter sale.
            if contact_id and name and contact_id != walk_in_id:
                updated += await _rename_cards(db, contact_id, name)
        except (SQLAlchemyError, ValueError, TypeError, KeyError) as exc:
            logger.warning("Contact poll skipped contact %s: %s", contact_id, exc)
            try:
                await db.rollback()
            except SQLAlchemyError:
                pass
            if moment and (oldest_failure is None or moment < oldest_failure):
                oldest_failure = moment
            continue
        if moment and (newest is None or moment > newest):
            newest = moment

    watermark = min(x for x in (newest, oldest_failure) if x is not None) if (newest or oldest_failure) else None
    if watermark is not None:
        # Rows arrive oldest first: on a truncated pass ``newest`` is the last
        # row read and the rest of the window is still unread, so resume there.
        rewind = TRUNCATED_OVERLAP_SECONDS if getattr(rows, "truncated", False) else OVERLAP_SECONDS
        resume = watermark - timedelta(seconds=rewind)
        # Never before where this pass started: those rows were just read, and
        # the overlap would otherwise reach back into a window walked in
        # capped passes and start the walk over.
        started = _parse_books_time(since)
        if started is not None and resume < started:
            resume = started
        await set_setting(db, POLL_SINCE_SETTING, _format_books_time(resume))
        await db.commit()
    return updated
