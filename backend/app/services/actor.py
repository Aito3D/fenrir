"""Who did it: the user id, the actor name and the actor class recorded on
PDM revisions, Aito link events and print-trace events."""

from backend.app.models.user import User


def actor_user_id(user: User | None) -> int | None:
    """The acting user's id, ``None`` when auth is off."""
    return user.id if user else None


def actor_name(user: User | None) -> str | None:
    """The acting user's username, ``None`` when auth is off."""
    return user.username if user is not None else None


def actor_class(actor: str | None) -> str:
    """``"user"`` for a named actor, ``"system"`` for none (or an empty name)."""
    return "user" if actor else "system"
