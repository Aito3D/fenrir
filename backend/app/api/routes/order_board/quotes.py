"""Product quotes (Zoho Books estimates) on the Order Board."""

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.order_board._common import router
from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.user import User
from backend.app.services import order_board_sync


@router.get("/quotes")
async def get_quotes(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    """The quote rows from the local copy (no Zoho call)."""
    return await order_board_sync.read_quotes(db)
