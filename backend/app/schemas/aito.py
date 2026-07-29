"""Pydantic DTOs for the Aito production board."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

AitoColumn = Literal["devis", "waiting", "scan", "model", "print", "finish", "done"]


class AitoTaskBase(BaseModel):
    """A NULL cost means the service is disabled; 0 stays meaningful as free."""

    title: str | None = Field(default=None, max_length=200)
    description: str | None = None
    scan_cost: float | None = Field(default=None, ge=0)
    modelisation_cost: float | None = Field(default=None, ge=0)
    usinage_cost: float | None = Field(default=None, ge=0)
    impression_printer_id: int | None = None
    impression_filament_id: int | None = None
    impression_weight_g: float | None = Field(default=None, ge=0)
    impression_time_min: int | None = Field(default=None, ge=0)
    impression_quantity: int | None = Field(default=None, ge=1)
    impression_color: str | None = Field(default=None, max_length=100)
    impression_cost: float | None = Field(default=None, ge=0)
    scan_done: bool = False
    modelisation_done: bool = False
    impression_done: bool = False
    usinage_done: bool = False


class AitoTaskCreate(AitoTaskBase):
    pass


class AitoTaskUpdate(AitoTaskBase):
    """Only keys present in the body are written — an omitted key is left alone,
    an explicit null clears the field. That is what lets one service be
    disabled without disturbing its siblings."""


class AitoTaskResponse(AitoTaskBase):
    id: int
    project_id: int
    position: int
    created_at: datetime
    updated_at: datetime


class AitoProjectCreate(BaseModel):
    description: str = Field(min_length=1)
    client_id: str = Field(min_length=1)
    client_name: str = Field(min_length=1)
    client_phone: str | None = None
    client_email: str | None = None
    client_is_company: bool | None = None
    quote_id: str | None = Field(default=None, max_length=50)
    quote_number: str | None = Field(default=None, max_length=50)
    quote_date: str | None = Field(default=None, max_length=10)
    quote_total: float | None = Field(default=None, ge=0)
    quote_url: str | None = Field(default=None, max_length=300)
    quote_salesperson: str | None = Field(default=None, max_length=200)
    quote_status: str | None = Field(default=None, max_length=30)
    tasks: list[AitoTaskCreate] = Field(default_factory=list)

    @field_validator("quote_url")
    @classmethod
    def _quote_url_must_be_https(cls, value: str | None) -> str | None:
        """The board renders this as a trustworthy-looking link labelled with
        the quote number, so it must actually go where it looks like it goes.
        The app itself only ever generates `https://books.zoho.<region>/...`
        URLs, so restricting to https costs nothing legitimate while closing
        off `javascript:`, `data:`, bare `http://` and relative values."""
        if not value:
            return value
        if not value.startswith("https://"):
            raise ValueError("quote_url must use the https scheme")
        return value


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
    client_email: str | None = None
    client_is_company: bool | None = None

    @field_validator("description")
    @classmethod
    def _description_not_blank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("description must not be blank")
        return value


class AitoProjectResponse(BaseModel):
    id: int
    description: str
    column: AitoColumn
    position: int
    status: str
    client_id: str | None
    client_name: str | None
    client_phone: str | None
    client_email: str | None
    client_is_company: bool | None
    quote_id: str | None
    quote_number: str | None
    quote_date: str | None
    quote_total: float | None
    quote_url: str | None
    quote_salesperson: str | None
    quote_status: str | None
    created_by: str | None
    quote_sync_state: str
    quote_sync_error: str | None
    # Aggregates over the project's tasks, so the board card can show a summary
    # without GET /aito/ shipping every task row. Required, never defaulted:
    # see _to_response in the routes module.
    task_count: int
    tasks_total: float
    task_services: list[str]
    # Why this card cannot be dragged between columns, or None when it can
    # (Finish <-> Done only). Derived, never stored — see
    # services/aito_board_rules.evaluate. The frontend renders its lock badge
    # and computes its allowed droppables from this and nothing else.
    move_lock: Literal["quote", "waiting", "declined", "steps"] | None
    created_at: datetime
    updated_at: datetime
