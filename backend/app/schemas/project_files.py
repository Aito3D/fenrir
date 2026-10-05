from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

Section = Literal["scan", "modelisation", "impression", "usinage", "docs"]
RevisionStatus = Literal["wip", "valide", "obsolete"]


def _required_name(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("name must not be blank")
    return value


class DuplicateWarning(BaseModel):
    filename: str
    same_as: str


class RevisionRef(BaseModel):
    id: int
    item_id: int
    item_name: str
    section: str
    number: int
    status: str


class ProjectFileOut(BaseModel):
    id: int
    filename: str
    file_type: str
    file_size: int
    file_hash: str | None
    has_thumbnail: bool
    created_at: datetime


class ProjectRevisionOut(BaseModel):
    id: int
    number: int
    status: str
    note: str | None
    derived_from: RevisionRef | None
    outdated_by: RevisionRef | None
    print_profile: dict | None
    slicer_name: str | None
    slicer_version: str | None
    has_snapshot: bool
    used: bool
    files: list[ProjectFileOut]
    created_by: str | None
    created_at: datetime
    status_changed_at: datetime | None


class ProjectItemOut(BaseModel):
    id: int
    section: str
    name: str
    # Uniqueness key in its section (sanitised folder name, case-folded).
    name_key: str
    forked_from: RevisionRef | None
    revisions: list[ProjectRevisionOut]


class ProjectSectionOut(BaseModel):
    section: str
    items: list[ProjectItemOut]


class ProjectTreeResponse(BaseModel):
    project_id: int
    code: str | None
    sections: list[ProjectSectionOut]


class ProjectItemCreate(BaseModel):
    section: Section
    name: str = Field(..., max_length=255)

    _name = field_validator("name")(_required_name)


class ProjectItemRename(BaseModel):
    name: str = Field(..., max_length=255)

    _name = field_validator("name")(_required_name)


class ProjectItemFork(BaseModel):
    revision_id: int
    name: str = Field(..., max_length=255)

    _name = field_validator("name")(_required_name)


class ProjectRevisionUpdate(BaseModel):
    status: RevisionStatus | None = None
    note: str | None = Field(default=None, max_length=5000)
    derived_from_id: int | None = None


class RevisionUploadResponse(BaseModel):
    revision: ProjectRevisionOut
    warnings: list[DuplicateWarning]
