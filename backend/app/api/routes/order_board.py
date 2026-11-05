"""The Order Board: which open sales orders can ship today.

Reading is one local read of the stored board. Refresh runs one bounded sync
pass against Zoho Books (GETs only). The settings routes are their own
endpoints, not the general settings API, because Operators hold
``settings:read`` only and must still be able to tune the board.
"""

from dataclasses import asdict
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.user import User
from backend.app.services import order_board_sync

router = APIRouter(prefix="/order-board", tags=["order-board"])


class OrderBoardSettingsBody(BaseModel):
    sync_enabled: bool
    sync_minutes: Literal[5, 15, 60]
    max_age_days: int = Field(ge=0, le=3650)
    core_brands: list[str] = Field(max_length=30)

    @field_validator("core_brands")
    @classmethod
    def _clean_brands(cls, brands: list[str]) -> list[str]:
        cleaned: list[str] = []
        for brand in (b.strip() for b in brands):
            if not 1 <= len(brand) <= 60:
                raise ValueError("a brand must be 1 to 60 characters")
            if brand.casefold() not in {c.casefold() for c in cleaned}:
                cleaned.append(brand)
        return cleaned


@router.get("")
async def get_order_board(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_READ),
) -> dict:
    """The stored board, when it was computed, and the sync status."""
    return await order_board_sync.read_board(db)


@router.post("/refresh")
async def refresh_order_board(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    """One bounded sync pass, then the board. A pass already running is left
    to finish; the caller gets the board as it stands."""
    await order_board_sync.run_pass(db)
    return await order_board_sync.read_board(db)


@router.get("/settings", response_model=OrderBoardSettingsBody)
async def get_order_board_settings(
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    return asdict(await order_board_sync.load_settings(db))


@router.put("/settings", response_model=OrderBoardSettingsBody)
async def update_order_board_settings(
    body: OrderBoardSettingsBody,
    db: AsyncSession = Depends(get_db, scope="function"),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.ORDERS_UPDATE),
) -> dict:
    """Save the settings and rebuild the board from the local copy."""
    await order_board_sync.save_settings(db, order_board_sync.OrderBoardSettings(**body.model_dump()))
    return asdict(await order_board_sync.load_settings(db))
