"""API routes for kanban board cards."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.database import get_db
from backend.app.models.kanban_card import KanbanCard
from backend.app.schemas.kanban_card import (
    KanbanCardCreate,
    KanbanCardReorder,
    KanbanCardResponse,
    KanbanCardUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/kanban", tags=["kanban"])


def _resolve_state(column: str) -> str:
    """Auto-set state based on column: finished only in done, progress elsewhere."""
    return "finished" if column == "done" else "progress"


@router.get("/cards", response_model=list[KanbanCardResponse])
async def list_cards(
    db: AsyncSession = Depends(get_db),
):
    """List all kanban cards ordered by sort_order."""
    result = await db.execute(select(KanbanCard).order_by(KanbanCard.sort_order))
    return list(result.scalars().all())


@router.post("/cards", response_model=KanbanCardResponse)
async def create_card(
    card_data: KanbanCardCreate,
    db: AsyncSession = Depends(get_db),
):
    """Create a new kanban card."""
    # Place at end of target column
    result = await db.execute(
        select(KanbanCard)
        .where(KanbanCard.column == card_data.column)
        .order_by(KanbanCard.sort_order.desc())
        .limit(1)
    )
    last_card = result.scalar_one_or_none()
    next_order = (last_card.sort_order + 1) if last_card else 0

    card = KanbanCard(
        title=card_data.title,
        quote_id=card_data.quote_id,
        quote_name=card_data.quote_name,
        client_id=card_data.client_id,
        client_name=card_data.client_name,
        client_phone=card_data.client_phone,
        quantity=card_data.quantity,
        column=card_data.column,
        state=_resolve_state(card_data.column),
        sort_order=next_order,
    )
    db.add(card)
    await db.commit()
    await db.refresh(card)

    logger.info("Created kanban card: %s (column=%s)", card.title, card.column)
    return card


@router.get("/cards/{card_id}", response_model=KanbanCardResponse)
async def get_card(
    card_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Get a specific kanban card."""
    result = await db.execute(select(KanbanCard).where(KanbanCard.id == card_id))
    card = result.scalar_one_or_none()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")
    return card


@router.patch("/cards/{card_id}", response_model=KanbanCardResponse)
async def update_card(
    card_id: int,
    update_data: KanbanCardUpdate,
    db: AsyncSession = Depends(get_db),
):
    """Update a kanban card."""
    result = await db.execute(select(KanbanCard).where(KanbanCard.id == card_id))
    card = result.scalar_one_or_none()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")

    # Finished cards can only be moved (column change), not edited
    update_dict = update_data.model_dump(exclude_unset=True)
    if card.state == "finished":
        allowed = {"column", "sort_order"}
        disallowed = set(update_dict.keys()) - allowed
        if disallowed:
            raise HTTPException(status_code=400, detail="Finished cards cannot be edited")

    for key, value in update_dict.items():
        setattr(card, key, value)

    # Auto-set state based on column
    card.state = _resolve_state(card.column)

    await db.commit()
    await db.refresh(card)

    logger.info("Updated kanban card: %s (column=%s, state=%s)", card.title, card.column, card.state)
    return card


@router.delete("/cards/{card_id}")
async def delete_card(
    card_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Delete a kanban card."""
    result = await db.execute(select(KanbanCard).where(KanbanCard.id == card_id))
    card = result.scalar_one_or_none()
    if not card:
        raise HTTPException(status_code=404, detail="Card not found")

    title = card.title
    await db.delete(card)
    await db.commit()

    logger.info("Deleted kanban card: %s", title)
    return {"message": f"Card '{title}' deleted"}


@router.put("/cards/reorder", response_model=list[KanbanCardResponse])
async def reorder_cards(
    reorder_data: KanbanCardReorder,
    db: AsyncSession = Depends(get_db),
):
    """Update the sort order of cards."""
    for index, card_id in enumerate(reorder_data.ids):
        result = await db.execute(select(KanbanCard).where(KanbanCard.id == card_id))
        card = result.scalar_one_or_none()
        if card:
            card.sort_order = index

    await db.commit()

    result = await db.execute(select(KanbanCard).order_by(KanbanCard.sort_order))
    cards = result.scalars().all()

    logger.info("Reordered %d kanban cards", len(reorder_data.ids))
    return list(cards)
