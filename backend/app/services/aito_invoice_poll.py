"""One org-wide "what changed in Books?" read a tick, attributed to cards.

Every other invoice surface in this app is a per-project PULL keyed on
``GET /invoices?estimate_id=`` — the Invoice card, the hourly balance sweep,
``_is_locked``, the duplicate-invoice guard. That shape has two consequences
an operator experiences as "Zoho and Fenrir disagree":

- **Latency.** A quote invoiced in Books is noticed by the quote sweep within
  one tick (it re-reads the estimate anyway), but the figures behind the
  board's UNPAID chip, the follow-up strip and Stats come from
  ``sweep_invoices``, which is gated to once an hour AND only selects projects
  already flagged ``quote_invoiced``. Worst case the board was ~65 minutes
  behind Books.
- **Blindness.** An invoice raised in Books *without converting the estimate*
  carries no ``estimate_id``, so the estimate-filtered read that every surface
  above depends on returns nothing — at any latency, forever.

This module answers the other question instead, and one call answers it for
the whole board: "which invoices has Books touched since I last looked?"
(``last_modified_time`` is a real server-side filter — verified on the live
org: a one-day window returned 2 rows out of ~4000.) An invoice found this way
is attributed to a card by its **reference number** and nothing else, then
cached, locked, and — if it turns out to be an orphan — linked back to its
estimate so that every pull-shaped surface above starts working for it too.

Attribution is deliberately narrow. Two references count:

- ``AITO-{project.id}``, which ``create_estimate`` stamps on every estimate
  this app raises and which Books copies onto the invoice when the estimate
  is converted (verified: FA-26-4367 carries AITO-151; 50 of the ~600 most
  recent invoices in the live org carry an AITO- reference);
- the project's own ``quote_number``, the convention ``linked_credits``
  already trusts for Heimdall's retainers and the natural thing for an
  operator to type by hand.

There is deliberately NO customer-only fallback. A client with two open jobs
would make it a coin flip, and the cost of losing that flip is a card marked
billed — and locked against further quote edits — for a bill belonging to
another job. Same reasoning as ``ZohoAmbiguousReferenceError``: fail closed,
never guess. A reference that matches two cards is skipped for the same
reason.

This does NOT replace ``sweep_invoices``. That pass still runs hourly and
still owns ``settle_with_deposits`` — spending a quote's paid retainers on its
open invoice — which this module deliberately does not do: a poll that reacts
to every change in Books must stay a read plus, at most, the one idempotent
repair below.
"""

import logging
import re
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.services.aito_events import record
from backend.app.services.aito_quote_sync import _lock_project
from backend.app.services.zoho import (
    ZohoNotConfiguredError,
    ZohoRateLimited,
    ZohoUpstreamError,
    _normalize_reference_number,
    zoho_service,
)

logger = logging.getLogger(__name__)

# The watermark: the Books timestamp this poll last caught up to. Persisted in
# settings rather than held in module state so a restart neither rescans the
# org nor skips the window it was down for.
POLL_SINCE_SETTING = "aito_invoice_poll_since"

# How far back the very first pass looks, to adopt invoices that were raised
# before this feature existed — including the orphans nothing could see. A
# one-off cost of a few pages (the live org's 90-day window read ~4).
BACKFILL_DAYS = 90

# How far the watermark is rewound from the newest row seen. Books stamps
# ``last_modified_time`` when it commits a change, so two changes in the same
# second can straddle a pass boundary; re-reading a five-minute overlap costs
# nothing (adoption is idempotent — see ``_adopt``) and closes that seam.
OVERLAP_SECONDS = 300

# Books' own spelling: offset as ±HHMM, never 'Z'. `...Z` is rejected outright
# with "Invalid value passed for last_modified_time" (verified live), so this
# is not interchangeable with datetime.isoformat().
_BOOKS_TIME = "%Y-%m-%dT%H:%M:%S%z"

_AITO_REFERENCE = re.compile(r"^aito-(\d+)$")


def _format_books_time(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime(_BOOKS_TIME)


def _parse_books_time(value: str | None) -> datetime | None:
    """Books' timestamp, or None when it is absent or unparseable.

    Never raises: this feeds the watermark, and a single row with a mangled
    timestamp must cost that row's contribution to the watermark, not the
    pass.
    """
    try:
        return datetime.strptime((value or "").strip(), _BOOKS_TIME)
    except ValueError:
        return None


async def _since(db: AsyncSession) -> str:
    from backend.app.api.routes.settings import get_setting

    stored = (await get_setting(db, POLL_SINCE_SETTING) or "").strip()
    if _parse_books_time(stored) is not None:
        return stored
    # No watermark, or one written by something that did not speak Books'
    # dialect: open the backfill window rather than starting from "now" — the
    # orphans this module exists to find are, by definition, already there.
    return _format_books_time(datetime.now(timezone.utc) - timedelta(days=BACKFILL_DAYS))


async def _match(db: AsyncSession, reference: str, customer_id: str) -> AitoProject | None:
    """The one active project this invoice's reference names, or None.

    None covers every ambiguity as well as every miss — see the module
    docstring on why guessing is not an option here.
    """
    normalized = _normalize_reference_number(reference)
    if not normalized:
        return None

    aito = _AITO_REFERENCE.match(normalized)
    if aito:
        project = await db.get(AitoProject, int(aito.group(1)))
        candidates = [project] if project is not None else []
    else:
        # ``quote_number`` is not unique in the schema, so this really can
        # return two rows — a duplicated card, most often. Read both and let
        # the ambiguity check below refuse, rather than taking .first().
        stmt = select(AitoProject).where(func.lower(AitoProject.quote_number) == normalized).limit(2)
        candidates = list((await db.execute(stmt)).scalars().all())

    candidates = [p for p in candidates if p.status == "active"]
    if len(candidates) != 1:
        if len(candidates) > 1:
            logger.warning("Invoice poll: reference %r names %d projects; skipped", reference, len(candidates))
        return None

    project = candidates[0]
    # Books resolved nothing here — the reference was matched locally — so a
    # customer mismatch is a genuine signal that the reference is stale (a
    # card duplicated in Books, say), not a paranoid check. Mirrors
    # ``list_project_invoices``, which drops and warns for the same reason.
    if customer_id and project.client_id and customer_id != project.client_id:
        logger.warning(
            "Invoice poll: reference %r names project %s but the invoice belongs to another customer; skipped",
            reference,
            project.id,
        )
        return None
    return project


async def _repair_link(db: AsyncSession, invoice_id: str, project: AitoProject) -> None:
    """Attach an orphan invoice to the estimate it should have been billed from.

    The one write this module makes, and only on first adoption. It is what
    turns a card that merely *displays* an invoice into one where the Invoice
    card's own live fetch, ``_is_locked``, the hourly balance sweep and the
    duplicate-invoice guard all work — every one of them reads
    ``GET /invoices?estimate_id=``, so without the link they each answer
    "no invoice" forever.

    Idempotent by construction: an invoice that already carries an
    ``estimate_id`` is left alone, so a later pass never re-links it.
    """
    if not project.quote_id:
        return
    invoice = await zoho_service.get_invoice_raw(db, invoice_id)
    if invoice.get("estimate_id"):
        return
    await zoho_service.link_invoice_to_estimate(db, invoice_id, project.quote_id)
    logger.info("Invoice poll linked orphan invoice %s to estimate %s", invoice_id, project.quote_id)


async def _adopt(db: AsyncSession, row: dict, project: AitoProject) -> bool:
    """Cache one invoice onto its card. Returns whether anything was written.

    Ordered so a failure is never half-applied: every figure is parsed into a
    local and the orphan repair is attempted BEFORE a single column is
    assigned. A project adopted with its link unrepaired would be flagged
    billed and locked while the panel's own estimate-filtered fetch still
    showed nothing — strictly worse than staying untouched and being retried
    on the next tick, which the watermark rule in ``poll_invoices``
    guarantees.
    """
    status = str(row.get("status") or "") or None
    balance = float(row.get("balance") or 0)
    due = str(row.get("due_date") or "") or None
    invoice_id = str(row.get("id") or "")
    project_id = project.id
    newly_invoiced = not project.quote_invoiced

    # 'unmanaged' is a standing instruction never to touch this project's
    # quote. Linking the invoice would flip the estimate to 'invoiced' in
    # Books, and locking would overwrite the state that carries the
    # instruction — so an unmanaged card gets the cached figures (the UNPAID
    # chip reads them, and its panel already fetches the invoice live) and
    # nothing else.
    managed = project.quote_sync_state != "unmanaged"
    if newly_invoiced and managed:
        await _repair_link(db, invoice_id, project)

    project.invoice_status = status
    project.invoice_balance = balance
    project.invoice_due_date = due
    project.invoice_checked_at = datetime.now(timezone.utc).replace(tzinfo=None)
    if managed:
        # Same helper, same invariants as the quote sweep's own invoiced
        # branch: 'locked' leaves the sweep for good, a stale block is cleared
        # because no push will ever be attempted again, and the failure budget
        # is reset. Its ``was_already_locked`` debounce is what keeps this and
        # the quote sweep — which may reach the same conclusion on the same
        # tick — from recording two ``sync.locked`` events.
        await _lock_project(db, project, project_id, invoiced=True, clear_block=True, reset_failures=True)
    else:
        project.quote_invoiced = True

    if newly_invoiced:
        # Distinct from ``invoice.created``, which means "raised from Aito".
        # This is the only local record that a bill appeared in Books by some
        # other route, which is exactly the fact an operator reading the
        # timeline later will want.
        await record(
            db,
            project_id,
            "invoice.detected",
            actor_class="system",
            subject_type="project",
            subject_id=project_id,
            detail={"invoice_number": str(row.get("number") or ""), "status": status or ""},
        )
    return True


async def poll_invoices(db: AsyncSession) -> int:
    """Adopt every invoice Books has touched since the last pass.

    Returns the number of projects written. Raises ``ZohoRateLimited`` on a
    429 without advancing the watermark, so ``run_sync_loop`` arms the same
    shared throttle window it arms for the quote sweep and this pass simply
    resumes, unchanged, once the window clears.
    """
    from backend.app.api.routes.settings import set_setting

    since = await _since(db)
    # Before any watermark write, so a 429 (or an outage) leaves the window
    # exactly where it was.
    rows = await zoho_service.list_invoices_modified_since(db, since)

    updated = 0
    newest: datetime | None = None
    # The oldest row this pass could not finish. The watermark must not
    # advance past it, or the retry the per-invoice recovery below counts on
    # would never be offered another look at it.
    oldest_failure: datetime | None = None

    for row in rows:
        moment = _parse_books_time(row.get("last_modified_time"))
        try:
            project = await _match(db, str(row.get("reference_number") or ""), str(row.get("customer_id") or ""))
            if project is None:
                # Not ours — most invoices in the org are not. Still counts as
                # seen, so it advances the watermark with everything else.
                if moment and (newest is None or moment > newest):
                    newest = moment
                continue
            if await _adopt(db, row, project):
                await db.commit()
                updated += 1
        except ZohoRateLimited:
            raise
        except (ZohoNotConfiguredError, ZohoUpstreamError, SQLAlchemyError, ValueError, TypeError, KeyError) as exc:
            logger.warning("Invoice poll skipped invoice %s: %s", row.get("number") or row.get("id"), exc)
            try:
                await db.rollback()
            except SQLAlchemyError:
                # Best-effort, same as the hourly sweep's: a failed rollback
                # must not stop the pass from trying the next invoice.
                pass
            if moment and (oldest_failure is None or moment < oldest_failure):
                oldest_failure = moment
            continue
        if moment and (newest is None or moment > newest):
            newest = moment

    watermark = min(x for x in (newest, oldest_failure) if x is not None) if (newest or oldest_failure) else None
    if watermark is not None:
        await set_setting(db, POLL_SINCE_SETTING, _format_books_time(watermark - timedelta(seconds=OVERLAP_SECONDS)))
        await db.commit()
    return updated
