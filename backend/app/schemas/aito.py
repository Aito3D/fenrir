"""Pydantic DTOs for the Aito production board."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

AitoColumn = Literal["devis", "model", "print", "finish"]


class AitoProjectCreate(BaseModel):
    description: str = Field(min_length=1)
    client_id: str = Field(min_length=1)
    client_name: str = Field(min_length=1)
    client_phone: str | None = None


class AitoProjectImportItem(BaseModel):
    description: str = Field(min_length=1)
    column: AitoColumn
    position: int = Field(ge=0)


class AitoProjectImport(BaseModel):
    projects: list[AitoProjectImportItem]


class AitoProjectMove(BaseModel):
    column: AitoColumn
    position: int = Field(ge=0)


class AitoProjectUpdate(BaseModel):
    """Content edits from the card detail panel. Ordering (column/position) is
    owned by the /move endpoint and deliberately not accepted here."""

    description: str | None = Field(default=None, min_length=1)
    client_id: str | None = None
    client_name: str | None = None
    client_phone: str | None = None

    @field_validator("description")
    @classmethod
    def _description_not_blank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("description must not be blank")
        return value

    @model_validator(mode="after")
    def _client_snapshot_is_consistent(self):
        # The client fields are a snapshot; an id without a name would render as
        # an anonymous card that still claims to be linked to a Zoho contact.
        if self.client_id is not None and not self.client_name:
            raise ValueError("client_name is required when client_id is set")
        return self


class AitoProjectResponse(BaseModel):
    id: int
    description: str
    column: AitoColumn
    position: int
    status: str
    client_id: str | None
    client_name: str | None
    client_phone: str | None
    created_at: datetime
    updated_at: datetime
