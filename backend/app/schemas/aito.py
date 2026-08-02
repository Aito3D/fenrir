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


class AitoTaskStepsResponse(BaseModel):
    """One task's steps, for the board card's per-task rows.

    Mirrors TaskSteps in services/aito_board_rules.py. Both lists are in
    canonical SERVICES order; `done` is a subset of `services`, and a service
    priced None appears in neither — it is absent from the job, not pending.
    `title` is the task's own name, "" when it has none — the frontend
    supplies the fallback name ("Task N") for that case.
    """

    services: list[str]
    done: list[str]
    title: str = ""


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
    # 'idle' | 'pending' | 'error' | 'locked' | 'unmanaged' — see the column
    # comment on AitoProject.quote_sync_state for what each means.
    quote_sync_state: str
    quote_sync_error: str | None
    # Why the status reconciler is blocked, if it is, and what Books read when
    # it was recorded — 'conflict' (both sides decided and differ) or
    # 'rejected' (Books refused our push). Independent of quote_sync_state:
    # the panel renders this whatever the sync state is, which is the point of
    # it being a stored fact rather than a sentence in quote_sync_error.
    quote_status_block: Literal["conflict", "rejected"] | None
    quote_status_remote: str | None
    # Aggregates over the project's tasks, so the board card can show a summary
    # without GET /aito/ shipping every task row. Required, never defaulted:
    # see _to_response in the routes module.
    task_count: int
    tasks_total: float
    task_services: list[str]
    # Steps, not services: two tasks each carrying a scan are two steps, where
    # task_services reports 'scan' once. The board card's progress bar is
    # steps_done / steps_total, and hides itself entirely when steps_total is
    # 0 — an unpriced project has nothing to measure.
    steps_total: int
    steps_done: int
    # One entry per task, in the same order the detail panel lists them, so
    # the card's pill rows and the panel's task rows line up. This is the only
    # per-task detail GET /aito/ ships; everything else stays an aggregate.
    task_steps: list[AitoTaskStepsResponse]
    # The services with at least one UNTICKED step, in canonical order —
    # exactly what evaluate() takes. task_services above is the union of
    # ENABLED services, a different set that cannot substitute for it: the
    # optimistic frontend predicts a card's column from this field.
    task_pending: list[str]
    # Why this card cannot be dragged between columns, or None when it can
    # (Finish <-> Done only). Derived, never stored — see
    # services/aito_board_rules.evaluate. The frontend renders its lock badge
    # and computes its allowed droppables from this and nothing else.
    move_lock: Literal["quote", "waiting", "declined", "steps"] | None
    created_at: datetime
    updated_at: datetime


class AitoQuoteStatusUpdate(BaseModel):
    """The three transitions the board can drive. Zoho has no /status/draft, and
    `viewed` and `expired` are things that happen TO a quote rather than
    decisions anyone makes — they only ever arrive from Zoho."""

    status: Literal["sent", "accepted", "declined"]


class AitoQuoteStatusResponse(BaseModel):
    """``zoho_synced`` is a transport detail, so it rides alongside the project
    rather than on it: the frontend writes ``project`` straight into the board
    cache with setQueryData, and a cached board row has no business carrying
    the outcome of one request."""

    project: AitoProjectResponse
    zoho_synced: bool


class AitoEventResponse(BaseModel):
    id: int
    occurred_at: datetime
    occurred_until: datetime | None
    kind: str
    actor_class: str
    actor_name: str | None
    subject_type: str | None
    subject_id: int | None
    subject_label: str | None
    changes: list[dict] | None
    detail: dict | None
    note: str | None

    model_config = {"from_attributes": True}


class AitoEventPage(BaseModel):
    events: list[AitoEventResponse]
    has_more: bool


class AitoNoteCreate(BaseModel):
    """The ONLY thing a client may append to the timeline.

    Deliberately carries no kind, actor or timestamp: the handler fixes all
    three. A body that could name its own kind could fabricate an acceptance.
    """

    note: str = Field(min_length=1, max_length=2000)

    @field_validator("note")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("note must not be blank")
        return stripped


class AitoSummarizeRequest(BaseModel):
    """Task drafts to summarize — the create-drawer sends its local drafts, so
    these are AitoTaskCreate shapes, not persisted rows."""

    tasks: list[AitoTaskCreate] = Field(min_length=1)


class AitoSummarizeResponse(BaseModel):
    summary: str
    model: str
