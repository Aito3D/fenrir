"""Aito task ↔ project links (spec §1.6, §4)."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from backend.app.schemas.project_files import RevisionRef, _required_name


class LinkedProjectRef(BaseModel):
    id: int
    code: str | None
    name: str


class SectionRevisionSummary(BaseModel):
    item_id: int
    item_name: str
    number: int
    status: str


class TaskProjectLink(BaseModel):
    task_id: int
    task_title: str | None = None
    project: LinkedProjectRef | None
    # section -> newest revision of up to three items, newest activity first.
    sections: dict[str, list[SectionRevisionSummary]]
    deliveries: list[int]
    # Production traceability (phase 4): quantities from the task's archives / queue.
    printed: int = 0
    rejected: int = 0
    queued: int = 0
    target: int | None = None  # the task's impression_quantity


class OrderProjectLinks(BaseModel):
    order_id: int
    tasks: list[TaskProjectLink]


class ProjectSuggestion(BaseModel):
    id: int
    code: str | None
    name: str
    reason: Literal["same_client", "similar_title"]


class TaskLinkRequest(BaseModel):
    project_id: int | None


class TaskCreateProjectRequest(BaseModel):
    name: str = Field(..., max_length=255)
    description: str | None = None
    tag_ids: list[int] | None = Field(default=None, max_length=200)
    new_tag_names: list[str] | None = Field(default=None, max_length=20)

    _name = field_validator("name")(_required_name)


class TaskDeliveriesRequest(BaseModel):
    revision_ids: list[int] = Field(..., max_length=200)


class ProjectOrderTask(BaseModel):
    task_id: int
    task_title: str | None
    order_id: int
    order_description: str
    client_name: str | None
    board_column: str
    # The order's creation time (the "commande" date shown on the project page).
    created_at: datetime | None
    deliveries: list[RevisionRef]


class ProjectOrdersResponse(BaseModel):
    orders: list[ProjectOrderTask]


class DroppedFileResult(BaseModel):
    filename: str
    section: str
    item_id: int
    item_name: str
    revision_number: int


class DropFilesResponse(BaseModel):
    project_id: int
    code: str | None = None  # the project the files actually went to (the client's cached link may be stale)
    results: list[DroppedFileResult]
