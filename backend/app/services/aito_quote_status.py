"""The one write-path for adopting a quote status onto a project.

Every site where a status change is NEWS — a human clicking Accept in the
panel, the sync worker adopting what Books reports — goes through
``adopt_quote_status`` so the acceptance timestamp cannot drift out of sync
with the status. The two writers that deliberately bypass it are in
``aito_quote_sync``: the trash-decline (not an acceptance) and the
restore-from-trash (returns the pre-trash state; the job was accepted long
ago and the old stamp must survive).
"""

import logging
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.schemas.aito import QUOTE_STATUS_VALUES
from backend.app.services.aito_board_rules import AWAY_STATUSES
from backend.app.services.aito_events import record

logger = logging.getLogger(__name__)


def adopt_quote_status(project: AitoProject, new_status: str | None) -> None:
    """Set ``project.quote_status``, stamping ``quote_accepted_at`` on a
    transition into 'accepted' and ``quote_sent_at`` on the first transition
    into an away status. Re-acceptance after a decline overwrites — the
    latest go-ahead wins; leaving 'accepted' keeps the stamp (it is simply
    ignored while the status is something else). Naive UTC, matching every
    other datetime on the row.

    A status outside the board's own vocabulary is refused rather than stored.
    Books' status set is not ours: it also contains 'invoiced', which reaches
    this function from the sync worker's copy-back paths and means nothing to
    `aito_board_rules.evaluate` — which reads any non-'accepted' value as "not
    authorised yet" and drops the card into Devis. Because `_apply_rules` then
    PERSISTS the derived column, that write also destroyed the operator's
    manual Finish/Done choice, the stored column being its only record.

    This is the second line, not the first: the sites that adopt a remote
    status already refuse to overwrite a DECIDED local one (see
    `_apply_estimate` and `_lock_project` in aito_quote_sync). This guard
    catches the same class of value arriving through any other adopt site,
    present or future, and mirrors the degrade-don't-reject precedent
    `_degrade_unknown_quote_status` set for the import path. Refusing leaves
    the previous status in place, which is always a value the rules
    understand; a warning keeps a genuinely new Books status from being
    swallowed silently.
    """
    if new_status is not None and new_status not in QUOTE_STATUS_VALUES:
        logger.warning(
            "Refusing to adopt unknown quote status %r on project %s (keeping %r)",
            new_status,
            project.id,
            project.quote_status,
        )
        return
    if new_status == "accepted" and project.quote_status != "accepted":
        project.quote_accepted_at = datetime.now(timezone.utc).replace(tzinfo=None)
    # First departure only: the "quotes out" follow-up counts from the first
    # time the quote left the shop, so a re-send, a view, or an unaccept
    # (accepted -> sent) never moves it. A decided status adopted straight
    # from None (a Books-side decision we never saw as sent) leaves it NULL —
    # nothing is out any more, so no clock is needed.
    if new_status in AWAY_STATUSES and project.quote_sent_at is None:
        project.quote_sent_at = datetime.now(timezone.utc).replace(tzinfo=None)
    project.quote_status = new_status


async def apply_quote_decision(
    db: AsyncSession,
    project: AitoProject,
    status: str,
    *,
    actor_class: str,
    actor_name: str | None,
    source: str,
    detail: dict | None = None,
) -> None:
    """The local half of a quote decision, shared by the panel's buttons
    (routes/aito.py:set_quote_status) and the automatic acceptances (a paid
    payment link, a covering paid retainer — services/aito_payment_links.py
    and aito_quote_sync). Writes FIRST and always: the board must be right
    with Books unreachable. Books is pushed separately by push_quote_status.

    Imports from routes/aito.py are function-level to dodge the routes ->
    services import cycle, exactly as aito_quote_sync.run_sync_once does.
    """
    from backend.app.api.routes.aito import _apply_rules, _broadcast_changed, _summary_for

    # Decided before adopt overwrites the old status: a revoked acceptance is
    # its own kind so the timeline never passes it off as an ordinary send.
    unaccepting = project.quote_status == "accepted" and status == "sent"
    adopt_quote_status(project, status)
    # Our side just moved, so any recorded block describes an attempt that
    # no longer exists; and a fresh local decision is by definition not yet
    # observed to agree with Books (see AitoProject.quote_status_confirmed).
    project.quote_status_block = None
    project.quote_status_remote = None
    project.quote_status_confirmed = False
    summary = await _summary_for(db, project.id)
    await _apply_rules(db, project, summary, actor=actor_name)
    await record(
        db,
        project.id,
        "quote.unaccepted" if unaccepting else f"quote.{status}",
        actor_class=actor_class,
        actor_name=actor_name,
        subject_type="project",
        subject_id=project.id,
        detail={"source": source, **(detail or {})},
    )
    await db.commit()
    await _broadcast_changed("quote-status", project.id, actor_name)
    await db.refresh(project)


async def push_quote_status(db: AsyncSession, project: AitoProject, status: str) -> bool:
    """Best-effort Books push of a decision already written locally. True
    when Books took it (and quote_status_confirmed is set); False after a
    failure, with the session rolled back so the caller's later commit does
    not raise PendingRollbackError. After a False the ORM row is expired —
    read what you need off it BEFORE calling this."""
    from backend.app.services.zoho import zoho_service

    if not project.quote_id:
        return False
    try:
        # No `current`: pays for one read rather than trusting the snapshot.
        await zoho_service.advance_estimate_status(db, project.quote_id, status)
        project.quote_status_confirmed = True
        await db.commit()
        return True
    except Exception:
        logger.warning(
            "Could not set Zoho estimate %s to %s for project %s", project.quote_id, status, project.id, exc_info=True
        )
        await db.rollback()
        return False


async def accept_quote(
    db: AsyncSession,
    project: AitoProject,
    *,
    source: str,
    detail: dict | None = None,
    actor_name: str | None = None,
) -> bool:
    """Accept the quote from an automatic trigger. False (nothing done) when
    it is already accepted. 'Money wins': a declined or expired quote is
    reopened, the same latest-go-ahead-wins path the panel's Accept button
    offers on a declined card.

    Fires ``aito_payment_received`` for any non-'user' source (a paid link,
    a covering retainer) — never for a human's own Accept click, which goes
    through ``apply_quote_decision`` directly (routes/aito.py) and never
    reaches here anyway; the check is a second line, not the first. Variables
    are captured BEFORE the Books push below: a failed push rolls the session
    back and expires this ORM row, so anything read off ``project`` after
    that point would be a fresh (and possibly different) read.
    """
    if project.quote_status == "accepted":
        return False
    await apply_quote_decision(
        db,
        project,
        "accepted",
        actor_class="system" if actor_name is None else "user",
        actor_name=actor_name,
        source=source,
        detail=detail,
    )
    notify = None
    if source != "user":
        notify = {
            "project_id": project.id,
            "client_name": project.client_name,
            "reference": (detail or {}).get("reference") or project.quote_number,
            "amount": (detail or {}).get("amount") or 0,
            "currency": "XPF",
            "source": source,
        }
    await push_quote_status(db, project, "accepted")
    if notify is not None:
        try:
            from backend.app.services.notification_service import notification_service

            await notification_service.on_aito_payment_received(db, **notify)
        except Exception:  # noqa: BLE001 — a notification must never undo an acceptance
            logger.warning("payment notification failed for project %s", notify["project_id"], exc_info=True)
    return True
