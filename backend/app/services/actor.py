"""Who did it: the user id, the actor name and the actor class recorded on
PDM revisions, Aito link events and print-trace events."""

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.aito_event import AitoEvent
from backend.app.models.user import User
from backend.app.services import aito_events


def actor_user_id(user: User | None) -> int | None:
    """The acting user's id, ``None`` when auth is off."""
    return user.id if user else None


def actor_name(user: User | None) -> str | None:
    """The acting user's username, ``None`` when auth is off."""
    return user.username if user is not None else None


def actor_class(actor: str | None) -> str:
    """``"user"`` for a named actor, ``"system"`` for none (or an empty name)."""
    return "user" if actor else "system"


async def record_as(db: AsyncSession, order_id: int, kind: str, actor: str | None, **kwargs) -> AitoEvent | None:
    """``aito_events.record`` with the actor class derived from ``actor`` and ``actor`` as its name."""
    return await aito_events.record(db, order_id, kind, actor_class=actor_class(actor), actor_name=actor, **kwargs)
