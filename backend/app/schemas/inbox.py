"""Pydantic DTOs for the notification inbox (routes/inbox.py)."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class InboxItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    family: str
    # The kind again today: the frontend resolves `inbox.kind.*` itself.
    title: str
    body: str
    target_type: str | None
    target_id: int | None
    created_at: datetime
    read_at: datetime | None


class InboxPage(BaseModel):
    items: list[InboxItem]
    # Unread rows in the whole inbox, not just this page: the bell's badge.
    unread: int


class InboxKindInfo(BaseModel):
    kind: str
    family: str
    default_on: bool
    # False while nothing produces the kind yet (the printer family), so
    # Settings can show it as "coming later".
    available: bool


class InboxPreferencesUpdate(BaseModel):
    kinds: list[str] = Field(max_length=50)
    sound_kinds: list[str] = Field(max_length=50)
    auto_watch: bool


class InboxPreferences(InboxPreferencesUpdate):
    available: list[InboxKindInfo]
