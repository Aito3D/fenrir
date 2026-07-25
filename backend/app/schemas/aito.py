"""Pydantic DTOs for the Aito production board."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

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
