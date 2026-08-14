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

from backend.app.models.aito_project import AitoProject
from backend.app.schemas.aito import QUOTE_STATUS_VALUES

logger = logging.getLogger(__name__)


def adopt_quote_status(project: AitoProject, new_status: str | None) -> None:
    """Set ``project.quote_status``, stamping ``quote_accepted_at`` on a
    transition into 'accepted' from any other value. Re-acceptance after a
    decline overwrites — the latest go-ahead wins; leaving 'accepted' keeps
    the stamp (it is simply ignored while the status is something else).
    Naive UTC, matching every other datetime on the row.

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
    project.quote_status = new_status
