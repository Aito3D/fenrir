"""Void an order in Books."""

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.services.order_board_actions._common import (
    _best_effort_refresh,
    _log,
    _picklist,
    _write,
    confirm_stored_copy,
    writing,
)
from backend.app.services.zoho import zoho_service


async def cancel_order(db: AsyncSession, salesorder_id: str, *, by: str | None = None) -> None:
    """Mark the order void in Books; the re-read then takes it off the board. Books will not void an order that
    still has a package, so its unshipped parcels go first, then the picklists that hold only this order. A
    shipped parcel is left alone: Books then refuses the void, and its reason reaches the operator as it is."""
    with writing(salesorder_id):
        doc = await confirm_stored_copy(db, salesorder_id)
        number = doc.header.get("salesorder_number") or ""
        order = doc.detail or {}
        packages = order.get("packages") or []
        try:
            if all(p.get("status") == "not_shipped" for p in packages):
                for p in packages:
                    step = zoho_service.delete_package(db, p["package_id"])
                    await _write(salesorder_id, number, "delete_package", step)
                for p in order.get("picklists") or []:
                    picklist = await _picklist(db, order, p["picklist_id"])
                    if all(r.get("salesorder_id") == salesorder_id for r in picklist.get("line_items") or []):
                        step = zoho_service.delete_picklist(db, p["picklist_id"])
                        await _write(salesorder_id, number, "delete_picklist", step)
            await _write(salesorder_id, number, "void", zoho_service.void_salesorder(db, salesorder_id))
        except Exception:
            # A timeout can mean it went through, and a parcel already deleted must show up on the board.
            await _best_effort_refresh(db, salesorder_id, number)
            raise
        await _log(db, salesorder_id, "order.cancelled", by)
        await _best_effort_refresh(db, salesorder_id, number)
