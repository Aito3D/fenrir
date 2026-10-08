from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

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
    print_count: int = 0  # printed quantity from this revision's archives (phase 4)
    pipeline_name: str | None = None  # set by Re-trancher (phase 6)


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


# --- phase 5: File Manager bridge -------------------------------------------


class ImportLibraryFilesRequest(BaseModel):
    """Move File Manager files into a project (always the Impression section)."""

    model_config = ConfigDict(extra="forbid")

    file_ids: list[int] = Field(..., min_length=1, max_length=200)
    item_id: int | None = None
    new_item_name: str | None = Field(default=None, max_length=255)


class FiledFileOut(BaseModel):
    file_id: int
    filename: str
    section: str
    item_id: int
    item_name: str
    revision_id: int
    revision_number: int
    # Copied external files only: the untouched original row.
    source_file_id: int | None = None


class SkippedFileOut(BaseModel):
    file_id: int
    code: str
    reason: str


class ImportLibraryFilesResponse(BaseModel):
    moved: list[FiledFileOut]
    copied: list[FiledFileOut]
    skipped: list[SkippedFileOut]


class ProjectSuggestionForFile(BaseModel):
    project_id: int
    code: str | None
    name: str
    item_id: int | None = None
    item_name: str | None = None
    score: float
    reason: Literal["code", "item_name", "project_name"]


class LegacyMigrationCurrent(BaseModel):
    project_id: int
    code: str | None = None


class LegacyMigrationFailure(BaseModel):
    project_id: int
    code: str | None = None
    error: str


class LegacyMigrationLastRun(BaseModel):
    """The last finished run: projects migrated (failures not counted), managed
    files moved and external files copied, and when it ended."""

    projects: int
    files_moved: int
    files_copied: int
    finished_at: datetime


class LegacyMigrationStatus(BaseModel):
    """``GET /projects/legacy-migration/status``: ``pending`` is the number of
    projects still to migrate (the current candidate count when idle);
    ``last_run`` is the last finished run since the server started (None before)."""

    running: bool
    total: int
    done: int
    current: LegacyMigrationCurrent | None = None
    failures: list[LegacyMigrationFailure] = []
    pending: int
    last_run: LegacyMigrationLastRun | None = None


class ResliceBody(BaseModel):
    """``POST /projects/revisions/{id}/reslice``: one 3MF of the revision and a saved pipeline."""

    file_id: int
    pipeline_id: int


class ResliceStarted(BaseModel):
    """202 body: poll ``status_url`` (``GET /slice-jobs/{job_id}``) until completed or failed."""

    job_id: int
    status: str
    status_url: str
