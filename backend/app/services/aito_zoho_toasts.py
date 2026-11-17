"""Board toasts for what Fenrir just did in Zoho ("Quote DEV26-3038 created").

``aito_events.record()`` calls ``note`` for the kinds below; the payload waits
on ``session.info`` and goes out as an ``aito_zoho`` WebSocket message only
once the outermost transaction commits, so a rolled-back event never toasts.
A session listener does the sending rather than each commit site, because
the Zoho work commits in dozens of places (sync worker, sweeps, routes).
"""

import asyncio
import logging

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from backend.app.core.tasks import spawn_background_task
from backend.app.core.websocket import ws_manager
from backend.app.models.aito_project import AitoProject

logger = logging.getLogger(__name__)

_PENDING_KEY = "aito_zoho_toasts"

# Only results of work done in Books. sync.pushed (every edit) and the paid
# kinds (the inbox bell already rings) stay out on purpose.
TOAST_KINDS: frozenset[str] = frozenset(
    {
        "quote.created",
        "invoice.created",
        "quote.emailed",
        "invoice.emailed",
        "retainer.emailed",
        "payment_link.created",
        "payment_link.replaced",
        "invoice.deposit_applied",
        "payment.manual.recorded",
        "payment.manual.partial",
        "sync.failed",
        "sync.conflict",
    }
)

# Most specific first: a deposit applied names both, and the invoice is the
# document it landed on.
_DOC_KEYS = ("invoice_number", "retainer_number", "document_number", "quote_number")


def _doc(detail: dict, project: AitoProject | None, project_id: int) -> str:
    for key in _DOC_KEYS:
        if detail.get(key):
            return str(detail[key])
    return (project.quote_number if project else None) or f"#{project_id}"


async def note(db: AsyncSession, project_id: int, kind: str, actor: str | None, detail: dict | None) -> None:
    """Queue one toast for after commit. Never commits, never raises."""
    if kind not in TOAST_KINDS:
        return
    try:
        detail = detail or {}
        project = await db.get(AitoProject, project_id)
        db.info.setdefault(_PENDING_KEY, []).append(
            {
                "type": "aito_zoho",
                "kind": kind,
                "project_id": project_id,
                "actor": actor,
                "doc": _doc(detail, project, project_id),
                "client": project.client_name if project else None,
                "has_retainer": bool(detail.get("retainer_number")),
                "outcome": detail.get("outcome"),
                "error": str(detail["error"])[:200] if detail.get("error") else None,
            }
        )
    except Exception:
        logger.warning("could not queue Aito Zoho toast %s for project %s", kind, project_id, exc_info=True)


async def _send(messages: list[dict]) -> None:
    for message in messages:
        try:
            await ws_manager.broadcast_aito(message)
        except Exception:
            logger.warning("aito_zoho broadcast failed for %s", message.get("kind"), exc_info=True)


@event.listens_for(Session, "after_commit")
def _send_after_commit(session: Session) -> None:
    messages = session.info.pop(_PENDING_KEY, None)
    if not messages:
        return
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return  # sync-only caller (scripts): nobody is listening
    spawn_background_task(_send(messages), name="aito-zoho-toasts")


@event.listens_for(Session, "after_rollback")
def _forget_on_rollback(session: Session) -> None:
    # A savepoint rollback leaves the outer transaction (and toasts noted
    # before the savepoint) alive; same rule as inbox._forget_pending_on_rollback.
    if session.in_nested_transaction():
        return
    session.info.pop(_PENDING_KEY, None)
