"""Void an order in Books."""

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services.order_board_actions._common import (
    _best_effort_refresh,
    _log,
    _write,
    confirm_stored_copy,
    writing,
)
from backend.app.services.zoho import ZohoUpstreamError, zoho_service


async def cancel_order(db: AsyncSession, salesorder_id: str, *, by: str | None = None) -> None:
    """Mark the order void in Books; the re-read then takes it off the board. Books refuses an order it cannot
    void (shipped, invoiced), and its reason reaches the operator as it is."""
    with writing(salesorder_id):
        doc = await confirm_stored_copy(db, salesorder_id)
        number = doc.header.get("salesorder_number") or ""
        try:
            await _write(salesorder_id, number, "void", zoho_service.void_salesorder(db, salesorder_id))
        except ZohoUpstreamError:
            await _best_effort_refresh(db, salesorder_id, number)  # a timeout can mean it went through
            raise
        await _log(db, salesorder_id, "order.cancelled", by)
        await _best_effort_refresh(db, salesorder_id, number)
