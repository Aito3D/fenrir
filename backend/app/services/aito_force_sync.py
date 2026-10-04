"""The ⋯ menu's "Force Zoho sync": every Zoho-backed part of one card,
checked and repaired now, with a per-step report.

Nothing here writes to Books on its own authority. The quote push is the
worker's (marked pending by the route, then ``flush_and_wait``), the deposit
application is the sweep's ``settle_with_deposits``, the links are
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
    if after["state"] == "error" or (after["state"] == "locked" and not project.quote_invoiced and after["error"]):
        return StepResult("quote", "failed", {"reason": "refused", "message": after["error"] or ""})
    changed = {k: {"before": before[k], "after": after[k]} for k in ("total", "status") if before[k] != after[k]}
    return StepResult("quote", "fixed", changed) if changed else StepResult("quote", "in_sync")


async def _credit_step(db: AsyncSession, project: AitoProject) -> StepResult:
    client_id = project.client_id
    if not client_id:
        return StepResult("credit", "skipped", {"reason": "no_client"})
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
    fresh = newest
    remaining = None
    if float(newest.get("balance") or 0) > 0:
        fresh, remaining = await aito_invoice_sweep.settle_with_deposits(db, project_id, quote_id, newest, quote_number)
    await db.refresh(project)
    project.invoice_status = fresh.get("status") or None
    project.invoice_balance = float(fresh.get("balance") or 0)
    project.invoice_due_date = fresh.get("due_date") or None
    if remaining is not None:
        project.customer_credit_total = remaining
    await db.commit()
    before, after = float(newest.get("balance") or 0), float(fresh.get("balance") or 0)
    if after < before:
        return StepResult(
            "invoice",
            "fixed",
            {"number": str(newest.get("number") or ""), "balance_before": before, "balance_after": after},
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


async def _links_step(db: AsyncSession, project_id: int) -> StepResult:
    if not await heimdall_service.is_configured(db):
        return StepResult("payment_links", "skipped", {"reason": "not_configured"})
    before = await _link_rows(db, project_id)
    await aito_payment_links.reconcile_payment_links(db, only_project_id=project_id, force=True)
    after = await _link_rows(db, project_id)
    errors = [row[5] for row in after if row[5]]
    if errors:
        return StepResult("payment_links", "failed", {"reason": "upstream", "message": errors[0]})
    return StepResult("payment_links", "fixed" if after != before else "in_sync")


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
            results.append(await step())
        except ZohoRateLimited as e:
            aito_quote_sync._arm_rate_limit_throttle(e)
            throttled = True
            results.append(StepResult(key, "failed", {"reason": "rate_limited"}))
        except ZohoNotConfiguredError:
            results.append(StepResult(key, "skipped", {"reason": "not_configured"}))
        except ZohoUpstreamError as e:
            results.append(StepResult(key, "failed", {"reason": "upstream", "message": str(e)}))
    try:
        results.append(await _links_step(db, project_id))
    except Exception as e:  # noqa: BLE001 - a report, never a 500
        logger.warning("Force sync: payment links for project %s failed: %s", project_id, e)
        results.append(StepResult("payment_links", "failed", {"reason": "upstream", "message": str(e)}))
    return results
