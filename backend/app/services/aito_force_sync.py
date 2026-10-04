"""The ⋯ menu's "Force Zoho sync": every Zoho-backed part of one card,
checked and repaired now, with a per-step report.

Nothing here writes to Books on its own authority. The quote push is the
worker's (marked pending by the route, then ``flush_and_wait``), the deposit
application is the sweep's ``settle_deposits``, the links are
``reconcile_payment_links`` — so every guard those already own still applies.
Each step is isolated; a Zoho 429 stops the remaining ZOHO steps (no point
deepening the shared throttle) but not Heimdall's.

The ``credit`` step refreshes ``customer_credit_total`` only. The
``retainer_paid_total`` figure is the quote worker's (computed inside
``sync_project``); the ``quote`` step already refreshes it."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_payment_link import AitoPaymentLink
from backend.app.models.aito_project import AitoProject
from backend.app.services import aito_invoice_sweep, aito_payment_links, aito_quote_sync
from backend.app.services.aito_customer_credit import read_customer_credit
from backend.app.services.aito_search import remember_document_numbers
from backend.app.services.heimdall import heimdall_service
from backend.app.services.zoho import ZohoNotConfiguredError, ZohoRateLimited, ZohoUpstreamError, zoho_service

logger = logging.getLogger(__name__)


@dataclass
class StepResult:
    key: str
    outcome: str  # "in_sync" | "fixed" | "failed" | "skipped"
    detail: dict = field(default_factory=dict)


def quote_snapshot(project: AitoProject) -> dict:
    return {
        "total": project.quote_total,
        "status": project.quote_status,
        "state": project.quote_sync_state,
        "error": project.quote_sync_error,
    }


async def _quote_step(db: AsyncSession, project: AitoProject, *, queued: bool, before: dict) -> StepResult:
    project_id = project.id
    if not project.quote_id and not queued:
        return StepResult("quote", "skipped", {"reason": "no_quote"})
    if before["state"] == "unmanaged":
        return StepResult("quote", "skipped", {"reason": "unmanaged"})
    if not aito_quote_sync.can_flush():
        return StepResult("quote", "failed", {"reason": "worker_unavailable"})
    if not await aito_quote_sync.flush_and_wait(project_id):
        return StepResult("quote", "failed", {"reason": "timeout"})
    await db.refresh(project)  # the worker committed in its own session
    after = quote_snapshot(project)
    if after["state"] == "pending":
        # The worker's attempt did not land: a 429 leaves the card pending with
        # no error (the worker already armed the throttle), a transient upstream
        # failure below the failure budget leaves it pending with the error set.
        if after["error"]:
            return StepResult("quote", "failed", {"reason": "upstream", "message": after["error"]})
        return StepResult("quote", "failed", {"reason": "rate_limited"})
    if after["state"] == "error" or (after["state"] == "locked" and not project.quote_invoiced and after["error"]):
        return StepResult("quote", "failed", {"reason": "refused", "message": after["error"] or ""})
    changed = {k: {"before": before[k], "after": after[k]} for k in ("total", "status") if before[k] != after[k]}
    if (before["state"] == "error" or before["error"]) and not after["error"]:
        changed["error_cleared"] = True
    return StepResult("quote", "fixed", changed) if changed else StepResult("quote", "in_sync")


async def _credit_step(db: AsyncSession, project: AitoProject) -> StepResult:
    client_id = project.client_id
    if not client_id:
        return StepResult("credit", "skipped", {"reason": "no_client"})
    if not await zoho_service.is_configured(db):
        return StepResult("credit", "skipped", {"reason": "not_configured"})
    before = project.customer_credit_total
    after = await read_customer_credit(db, client_id)
    if after is None:
        return StepResult("credit", "failed", {"reason": "unreachable"})
    if before is not None and abs(before - after) < 0.005:
        return StepResult("credit", "in_sync")
    project.customer_credit_total = after
    await db.commit()
    await db.refresh(project)
    return StepResult("credit", "fixed", {"before": before, "after": after})


async def _invoice_step(db: AsyncSession, project: AitoProject) -> StepResult:
    project_id, quote_id = project.id, project.quote_id
    client_id, quote_number = project.client_id, project.quote_number
    if not quote_id or not project.quote_invoiced:
        return StepResult("invoice", "skipped", {"reason": "not_invoiced"})
    invoices = await zoho_service.list_project_invoices(db, quote_id, client_id or "")
    if not invoices:
        return StepResult("invoice", "in_sync")
    newest = invoices[0]
    before = float(newest.get("balance") or 0)
    settlement = None
    if before > 0:
        settlement = await aito_invoice_sweep.settle_deposits(db, project_id, quote_id, newest, quote_number)
        if settlement.remaining is None:
            # The deposit reads failed (settle swallows them); nothing was applied.
            return StepResult("invoice", "failed", {"reason": "unreachable"})
    fresh = settlement.invoice if settlement is not None else newest
    after = float(fresh.get("balance") or 0)
    await db.refresh(project)
    project.invoice_status = fresh.get("status") or None
    project.invoice_balance = after
    project.invoice_due_date = fresh.get("due_date") or None
    remember_document_numbers(project, fresh.get("number"))
    if settlement is not None and settlement.remaining is not None:
        project.customer_credit_total = settlement.remaining
    await db.commit()
    if settlement is not None and settlement.refused and after > 0:
        # A linked deposit had a share to spend and Books did not take it:
        # the balance stays open while the money sits unused. Not in sync.
        return StepResult("invoice", "failed", {"reason": "refused"})
    if after < before:
        return StepResult(
            "invoice",
            "fixed",
            {
                "number": str(newest.get("number") or ""),
                "balance_before": before,
                "balance_after": after,
                "currency_code": str(fresh.get("currency_code") or newest.get("currency_code") or ""),
            },
        )
    return StepResult("invoice", "in_sync")


async def _link_rows(db: AsyncSession, project_id: int) -> list[tuple]:
    rows = (
        await db.execute(
            select(AitoPaymentLink).where(
                AitoPaymentLink.project_id == project_id, AitoPaymentLink.superseded_at.is_(None)
            )
        )
    ).scalars()
    return sorted((r.id, r.document_kind, r.status, r.amount, r.heimdall_id or "", r.sync_error or "") for r in rows)


async def _links_step(db: AsyncSession, project: AitoProject) -> StepResult:
    project_id = project.id
    visitable = bool(project.quote_number) and project.quote_sync_state != "unmanaged"
    if not await heimdall_service.is_configured(db):
        return StepResult("payment_links", "skipped", {"reason": "not_configured"})
    before = await _link_rows(db, project_id)
    visited = await aito_payment_links.reconcile_payment_links(db, only_project_id=project_id, force=True)
    if visited == 0 and visitable:
        # Heimdall is configured and the card has a quote, so a pass that
        # visited nothing stood down for the links throttle.
        return StepResult("payment_links", "skipped", {"reason": "rate_limited"})
    after = await _link_rows(db, project_id)
    errors = [row[5] for row in after if row[5]]
    if errors:
        return StepResult("payment_links", "failed", {"reason": "upstream", "message": errors[0]})
    return StepResult("payment_links", "fixed" if after != before else "in_sync")


async def _keep_what_landed(db: AsyncSession, project: AitoProject) -> None:
    """After a step raised: commit what it recorded (a settle can raise a 429
    on its re-read AFTER Books took the money and its events were recorded —
    no write to Books without its event), and leave the session usable for
    the steps after it. A session a failed commit poisoned is rolled back,
    and the project reloaded, since a rollback expires it."""
    if db.is_active:
        try:
            await db.commit()
            return
        except Exception as exc:  # noqa: BLE001 - fall through to the rollback
            logger.warning("Force sync: committing after a failed step on project %s failed: %s", project.id, exc)
    try:
        await db.rollback()
        await db.refresh(project)
    except Exception as exc:  # noqa: BLE001 - the later steps report their own failures
        logger.warning("Force sync: could not recover the session after a failed step: %s", exc)


async def run_force_sync(
    db: AsyncSession, project: AitoProject, *, quote_queued: bool, quote_before: dict
) -> list[StepResult]:
    project_id = project.id
    results: list[StepResult] = []
    throttled = False
    zoho_steps: list[tuple[str, Callable[[], Awaitable[StepResult]]]] = [
        ("quote", lambda: _quote_step(db, project, queued=quote_queued, before=quote_before)),
        ("credit", lambda: _credit_step(db, project)),
        ("invoice", lambda: _invoice_step(db, project)),
    ]
    for key, step in zoho_steps:
        if throttled:
            results.append(StepResult(key, "skipped", {"reason": "rate_limited"}))
            continue
        try:
            result = await step()
            results.append(result)
            if result.outcome == "failed" and result.detail.get("reason") == "rate_limited":
                throttled = True  # the quote worker already armed the throttle
        except ZohoRateLimited as e:
            aito_quote_sync._arm_rate_limit_throttle(e)
            throttled = True
            await _keep_what_landed(db, project)
            results.append(StepResult(key, "failed", {"reason": "rate_limited"}))
        except ZohoNotConfiguredError:
            await _keep_what_landed(db, project)
            results.append(StepResult(key, "skipped", {"reason": "not_configured"}))
        except ZohoUpstreamError as e:
            await _keep_what_landed(db, project)
            results.append(StepResult(key, "failed", {"reason": "upstream", "message": str(e)}))
        except Exception as e:  # noqa: BLE001 - a report, never a 500
            logger.warning("Force sync: %s step for project %s failed: %s", key, project_id, e, exc_info=True)
            await _keep_what_landed(db, project)
            results.append(StepResult(key, "failed", {"reason": "internal"}))
    try:
        results.append(await _links_step(db, project))
    except Exception as e:  # noqa: BLE001 - a report, never a 500
        logger.warning("Force sync: payment links for project %s failed: %s", project_id, e)
        await _keep_what_landed(db, project)
        results.append(StepResult("payment_links", "failed", {"reason": "upstream", "message": str(e)}))
    return results
