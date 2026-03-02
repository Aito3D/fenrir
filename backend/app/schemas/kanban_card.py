from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

CardState = Literal["progress", "finished"]


class KanbanCardBase(BaseModel):
    """Base schema for kanban cards."""

    title: str = Field(..., min_length=1, max_length=200)
    quote_id: str = Field(..., min_length=1, max_length=50)
    quote_name: str = Field(..., min_length=1, max_length=100)
    client_id: str = Field(..., min_length=1, max_length=50)
    client_name: str = Field(..., min_length=1, max_length=200)
    client_phone: str = Field(default="", max_length=50)
    quantity: int = Field(default=1, ge=1)
    is_approved: bool = False
    file_id: int | None = None
    archive_id: int | None = None


class KanbanCardCreate(KanbanCardBase):
    """Schema for creating a kanban card."""

    column: str = Field(default="backlog", max_length=20)


class KanbanCardUpdate(BaseModel):
    """Schema for updating a kanban card (all fields optional)."""

    title: str | None = Field(default=None, min_length=1, max_length=200)
    quote_id: str | None = Field(default=None, min_length=1, max_length=50)
    quote_name: str | None = Field(default=None, min_length=1, max_length=100)
    client_id: str | None = Field(default=None, min_length=1, max_length=50)
    client_name: str | None = Field(default=None, min_length=1, max_length=200)
    client_phone: str | None = Field(default=None, max_length=50)
    quantity: int | None = Field(default=None, ge=1)
    is_approved: bool | None = None
    file_id: int | None = None
    archive_id: int | None = None
    column: str | None = Field(default=None, max_length=20)
    sort_order: float | None = None


class KanbanCardResponse(KanbanCardBase):
    """Response schema for kanban cards."""

    id: int
    column: str
    state: CardState
    sort_order: float
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class KanbanCardReorder(BaseModel):
    """Schema for reordering cards within a column."""

    ids: list[int] = Field(..., description="Card IDs in desired order")
