"""Recording what happened to an Aito project.

Every mutation site calls ``record`` explicitly. Deliberately NOT SQLAlchemy
``before_update`` hooks: the ORM layer cannot see who the actor is, and the
same models are written by both HTTP routes (a user) and the background sync
worker (the system), so a hook would have to reconstruct that from ambient
state. Ten greppable call sites beat one clever hook.
"""

import logging
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_event import AitoEvent

logger = logging.getLogger(__name__)

# kind -> depth. THE ONLY definition of the depth ladder; the API turns a
# requested depth into a `kind IN (...)` filter from this, and the frontend
# derives nothing of its own. Adding a kind means adding it here, or the read
# path silently never returns it.
KINDS: dict[str, str] = {
    # story: the project's narrative. Sparse enough that the UI can render the
    # elapsed time between consecutive entries, which is the whole point.
    "project.created": "story",
    "quote.created": "story",
    "quote.sent": "story",
    # An email actually left the building — a harder fact than quote.sent,
    # which is also set by a human clicking "Mark as sent" for a quote handed
    # over in person. Story depth: it belongs to the project's narrative.
    "quote.emailed": "story",
    "quote.viewed": "story",
    "quote.accepted": "story",
    "quote.declined": "story",
    "quote.expired": "story",
    "stage.changed": "story",
    "project.trashed": "story",
    "project.restored": "story",
    "project.urgent.set": "story",
    "project.urgent.cleared": "story",
    "project.sav.set": "story",
    "project.sav.cleared": "story",
    "project.pause.set": "story",
    "project.pause.cleared": "story",
    # detail: everything a person did by hand.
    "task.added": "detail",
    "task.updated": "detail",
    "task.removed": "detail",
    "task.step.ticked": "detail",
    "task.step.unticked": "detail",
    "project.updated": "detail",
    "note.added": "detail",
    "zoho.comment": "detail",
    # trace: machine traffic. Even debounced to transitions (see
    # aito_quote_sync.reconcile_quote_status), it is still noisier and less
    # legible than anything a person did by hand, which is why it is a
    # separate depth rather than part of detail.
    "sync.queued": "trace",
    "sync.pushed": "trace",
    "sync.failed": "trace",
    "sync.locked": "trace",
    "sync.conflict": "trace",
    "sync.status_rejected": "trace",
    "poll.reconciled": "trace",
}

# Cumulative: asking for detail includes story, asking for everything includes
# both. A client accepting a quote must never be something the user has to
# change depth to discover.
_DEPTH_ORDER: tuple[str, ...] = ("story", "detail", "trace")
_DEPTH_ALIASES = {"story": 1, "detail": 2, "everything": 3}

# How long an actor has to keep editing the same thing before it counts as a
# separate act. TaskEditor saves on row blur, so a single sitting spent on one
# task is several PATCHes and would otherwise be several rows.
COALESCE_WINDOW = timedelta(minutes=5)

# Only edits coalesce. Ticks do not: each is a discrete decision, and the one
# thing an audit is most likely to be asked about.
COALESCING_KINDS: frozenset[str] = frozenset({"task.updated", "project.updated"})


def kinds_for_depth(depth: str) -> list[str]:
    """Every kind visible at ``depth``, cumulatively."""
    limit = _DEPTH_ALIASES.get(depth, _DEPTH_ALIASES["detail"])
    allowed = set(_DEPTH_ORDER[:limit])
    return [kind for kind, level in KINDS.items() if level in allowed]


def diff_fields(obj: Any, patch: dict) -> list[dict]:
    """The fields in ``patch`` whose value actually differs from ``obj``.

    Must be called BEFORE the patch is applied. Returning ``[]`` is the normal
    case and is what keeps a no-op PATCH silent.
    """
    changes = []
    for field, new in patch.items():
        old = getattr(obj, field, None)
        if old != new:
            changes.append({"field": field, "from": old, "to": new})
    return changes


def _merge_changes(existing: list[dict], incoming: list[dict]) -> list[dict]:
    """Fold ``incoming`` into ``existing``, keeping the earliest ``from`` and
    the latest ``to`` per field, and dropping any field that has ended up back
    where it started.

    That last rule is the point: 4200 -> 5600 -> 4200 in one sitting is not a
    change, and a timeline claiming otherwise misreports the record.
    """
    merged = {change["field"]: dict(change) for change in existing}
    for change in incoming:
        field = change["field"]
        if field in merged:
            merged[field]["to"] = change["to"]  # keep the original "from"
        else:
            merged[field] = dict(change)
    return [change for change in merged.values() if change["from"] != change["to"]]


async def record(
    db: AsyncSession,
    project_id: int,
    kind: str,
    *,
    actor_class: str,
    actor_name: str | None = None,
    subject_type: str | None = None,
    subject_id: int | None = None,
    subject_label: str | None = None,
    changes: list[dict] | None = None,
    detail: dict | None = None,
    note: str | None = None,
    occurred_at: datetime | None = None,
    zoho_comment_id: str | None = None,
) -> AitoEvent | None:
    """Append one event, or fold it into a recent one, or decide it is nothing.

    Returns ``None`` when nothing was recorded — an empty diff, or a merge that
    cancelled the event out entirely. Callers must not assume a row exists.

    Does NOT commit: the caller's transaction owns that, so an event and the
    change it describes land together or not at all.
    """
    if kind not in KINDS:
        # Loud, because the read path filters by kind and an unregistered one
        # would be written and then never returned by any depth.
        logger.error("Refusing to record unregistered Aito event kind %r", kind)
        return None

    # An edit that changed nothing is not an event.
    if changes is not None and not changes and kind in COALESCING_KINDS:
        return None

    now = occurred_at or datetime.utcnow()

    if kind in COALESCING_KINDS:
        cutoff = now - COALESCE_WINDOW
        recent = (
            await db.execute(
                select(AitoEvent)
                .where(
                    AitoEvent.project_id == project_id,
                    AitoEvent.kind == kind,
                    AitoEvent.subject_id.is_(subject_id) if subject_id is None else AitoEvent.subject_id == subject_id,
                    AitoEvent.actor_name.is_(actor_name) if actor_name is None else AitoEvent.actor_name == actor_name,
                    # The window ends at occurred_until once something has
                    # coalesced in, and at occurred_at before that.
                    func.coalesce(AitoEvent.occurred_until, AitoEvent.occurred_at) >= cutoff,
                )
                .order_by(AitoEvent.id.desc())
                .limit(1)
            )
        ).scalar_one_or_none()

        if recent is not None:
            merged = _merge_changes(recent.changes or [], changes or [])
            if not merged:
                # Everything cancelled out. The event no longer describes
                # anything, so it should not survive as an empty row. Flushed
                # (not committed) so the delete is visible to callers in the
                # same transaction — a raw Core select does not autoflush the
                # way an ORM select does.
                await db.delete(recent)
                await db.flush()
                return None
            recent.changes = merged
            recent.occurred_until = now
            if subject_label:
                recent.subject_label = subject_label
            return recent

    event = AitoEvent(
        project_id=project_id,
        occurred_at=now,
        kind=kind,
        actor_class=actor_class,
        actor_name=actor_name,
        subject_type=subject_type,
        subject_id=subject_id,
        subject_label=subject_label,
        changes=changes or None,
        detail=detail,
        note=note,
        zoho_comment_id=zoho_comment_id,
    )
    db.add(event)
    await db.flush()  # so callers get an id without committing
    return event
