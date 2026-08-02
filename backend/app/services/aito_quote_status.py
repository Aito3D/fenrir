"""The one write-path for adopting a quote status onto a project.

Every site where a status change is NEWS — a human clicking Accept in the
panel, the sync worker adopting what Books reports — goes through
``adopt_quote_status`` so the acceptance timestamp cannot drift out of sync
with the status. The two writers that deliberately bypass it are in
``aito_quote_sync``: the trash-decline (not an acceptance) and the
restore-from-trash (returns the pre-trash state; the job was accepted long
ago and the old stamp must survive).
"""

from datetime import datetime, timezone

from backend.app.models.aito_project import AitoProject


def adopt_quote_status(project: AitoProject, new_status: str | None) -> None:
    """Set ``project.quote_status``, stamping ``quote_accepted_at`` on a
    transition into 'accepted' from any other value. Re-acceptance after a
    decline overwrites — the latest go-ahead wins; leaving 'accepted' keeps
    the stamp (it is simply ignored while the status is something else).
    Naive UTC, matching every other datetime on the row."""
    if new_status == "accepted" and project.quote_status != "accepted":
        project.quote_accepted_at = datetime.now(timezone.utc).replace(tzinfo=None)
    project.quote_status = new_status
