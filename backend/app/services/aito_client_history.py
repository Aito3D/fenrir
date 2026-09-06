"""A client's past cards for the new-project drawer's recall block.

Three read-only queries: the newest active cards for the contact id, their
tasks, and a one-row lookup of the latest social pair. Trashed cards are
excluded everywhere. Spec:
docs/superpowers/specs/2026-09-05-aito-client-history-design.md
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_project import AitoProject
from backend.app.models.aito_task import AitoTask
from backend.app.schemas.aito import (
    AitoClientHistoryCard,
    AitoClientHistoryResponse,
    AitoClientHistorySocial,
    AitoTaskResponse,
)
from backend.app.services.aito_board_rules import summarise
from backend.app.services.zoho import zoho_service

_EMPTY = AitoClientHistoryResponse(cards=[], latest_social=None)


async def _cards(db: AsyncSession, client_id: str, limit: int) -> list[AitoProject]:
    stmt = (
        select(AitoProject)
        .where(AitoProject.status == "active", AitoProject.client_id == client_id)
        .order_by(AitoProject.created_at.desc(), AitoProject.id.desc())
        .limit(limit)
    )
    return list((await db.execute(stmt)).scalars().all())


async def _tasks(db: AsyncSession, project_ids: list[int]) -> dict[int, list[AitoTask]]:
    if not project_ids:
        return {}
    stmt = select(AitoTask).where(AitoTask.project_id.in_(project_ids)).order_by(AitoTask.position, AitoTask.id)
    grouped: dict[int, list[AitoTask]] = {}
    for row in (await db.execute(stmt)).scalars().all():
        grouped.setdefault(row.project_id, []).append(row)
    return grouped


async def _latest_social(db: AsyncSession, client_id: str) -> AitoClientHistorySocial | None:
    # Its own scan, not a pass over the `limit` cards: a regular whose last
    # five jobs were phone-only still has a handle on the sixth.
    stmt = (
        select(AitoProject.client_social_network, AitoProject.client_social_handle)
        .where(
            AitoProject.status == "active",
            AitoProject.client_id == client_id,
            AitoProject.client_social_network.is_not(None),
            AitoProject.client_social_handle.is_not(None),
        )
        .order_by(AitoProject.created_at.desc(), AitoProject.id.desc())
        .limit(1)
    )
    row = (await db.execute(stmt)).first()
    if row is None:
        return None
    return AitoClientHistorySocial(network=row[0], handle=row[1])


async def compute_client_history(db: AsyncSession, client_id: str, limit: int) -> AitoClientHistoryResponse:
    default_id, _name = await zoho_service.get_default_contact(db)
    if client_id == default_id:
        # The walk-in contact's cards belong to everyone — nothing to recall.
        return _EMPTY
    cards = await _cards(db, client_id, limit)
    tasks = await _tasks(db, [c.id for c in cards])
    return AitoClientHistoryResponse(
        cards=[
            AitoClientHistoryCard(
                id=c.id,
                created_at=c.created_at,
                column=c.board_column,
                total=summarise(tasks.get(c.id, ())).total,
                tasks=[AitoTaskResponse.model_validate(t, from_attributes=True) for t in tasks.get(c.id, ())],
            )
            for c in cards
        ],
        latest_social=await _latest_social(db, client_id),
    )
