"""Pydantic schemas for library (File Manager) functionality."""

from datetime import datetime

from pydantic import BaseModel, Field, field_validator

# ============ Folder Schemas ============


class FolderCreate(BaseModel):
    """Schema for creating a new folder."""

    name: str = Field(..., min_length=1, max_length=255)
    parent_id: int | None = None
    project_id: int | None = None
    archive_id: int | None = None


class ExternalFolderCreate(BaseModel):
    """Schema for linking an external folder."""

    name: str = Field(..., min_length=1, max_length=255)
    external_path: str = Field(..., min_length=1, max_length=500)
    readonly: bool = True
    show_hidden: bool = False
    parent_id: int | None = None


class FolderUpdate(BaseModel):
    """Schema for updating a folder."""

    name: str | None = Field(None, min_length=1, max_length=255)
    parent_id: int | None = None
    project_id: int | None = None  # 0 to unlink
    archive_id: int | None = None  # 0 to unlink


class FolderResponse(BaseModel):
    """Schema for folder response."""

    id: int
    name: str
    parent_id: int | None
    project_id: int | None = None
    archive_id: int | None = None
    project_name: str | None = None
    archive_name: str | None = None
    is_external: bool = False
    external_path: str | None = None
    external_readonly: bool = False
    external_show_hidden: bool = False
    file_count: int = 0  # Computed field
    # max(folder.updated_at, max(immediate-child file.updated_at)). Used by the
    # File Manager folder tree's "sort by recent activity" mode (#1770) so that
    # adding a file inside a folder bubbles it up — folder.updated_at alone only
    # tracks rename/move events. Recursion across subfolders is intentionally
    # left out to keep the route a single GROUP BY rather than a recursive CTE.
    latest_activity_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class FolderReadmeResponse(BaseModel):
    """Markdown sidebar payload for a folder (#1268).

    ``filename`` is the on-disk name (so the UI can show "README.md") and
    ``content`` is the raw markdown — the FE renders it. ``truncated`` is
    True when the source file was clipped at the size cap.
    """

    filename: str
    content: str
    truncated: bool


class FolderTreeItem(BaseModel):
    """Schema for folder tree item (includes children)."""

    id: int
    name: str
    parent_id: int | None
    project_id: int | None = None
    archive_id: int | None = None
    project_name: str | None = None
    archive_name: str | None = None
    is_external: bool = False
    external_path: str | None = None
    external_readonly: bool = False
    file_count: int = 0
    # See FolderResponse.latest_activity_at — #1770 folder sort source.
    latest_activity_at: datetime | None = None
    children: list["FolderTreeItem"] = []

    class Config:
        from_attributes = True


# ============ File Schemas ============


class FileCreate(BaseModel):
    """Schema for creating a file entry (internal use after upload)."""

    filename: str
    file_path: str
    file_type: str
    file_size: int
    file_hash: str | None = None
    thumbnail_path: str | None = None
    metadata: dict | None = None
    folder_id: int | None = None
    project_id: int | None = None


class FileUpdate(BaseModel):
    """Schema for updating a file."""

    filename: str | None = Field(None, min_length=1, max_length=255)
    folder_id: int | None = None
    project_id: int | None = None
    notes: str | None = None


class FileDuplicate(BaseModel):
    """Reference to a duplicate file."""

    id: int
    filename: str
    folder_id: int | None
    folder_name: str | None
    created_at: datetime


class FileResponse(BaseModel):
    """Schema for file response."""

    id: int
    folder_id: int | None
    folder_name: str | None = None
    project_id: int | None
    project_name: str | None = None
    is_external: bool = False

    filename: str
    file_path: str
    file_type: str
    file_size: int
    file_hash: str | None
    thumbnail_path: str | None

    metadata: dict | None

    print_count: int
    last_printed_at: datetime | None

    notes: str | None

    # Duplicate detection
    duplicates: list[FileDuplicate] | None = None
    duplicate_count: int = 0

    # User tracking (Issue #206)
    created_by_id: int | None = None
    created_by_username: str | None = None

    created_at: datetime
    updated_at: datetime

    # Metadata fields
    print_name: str | None = None
    print_time_seconds: int | None = None
    filament_used_grams: float | None = None
    filament_type: str | None = None
    sliced_for_model: str | None = None

    class Config:
        from_attributes = True


class TagSummary(BaseModel):
    """Compact tag projection — embedded in file listings (#1268)."""

    id: int
    name: str

    class Config:
        from_attributes = True


class FileListResponse(BaseModel):
    """Schema for file list item (lighter than full response)."""

    id: int
    folder_id: int | None
    is_external: bool = False
    filename: str
    file_type: str
    file_size: int
    thumbnail_path: str | None
    print_count: int
    duplicate_count: int = 0
    # User tracking (Issue #206)
    created_by_id: int | None = None
    created_by_username: str | None = None
    created_at: datetime
    # Real on-disk modification time (#2680). Populated for external files from
    # their filesystem mtime; null for managed uploads. The file pane's date sort
    # and the "Modified" column use ``fs_modified_at ?? created_at``.
    fs_modified_at: datetime | None = None

    # Key metadata fields for display
    print_name: str | None = None
    print_time_seconds: int | None = None
    filament_used_grams: float | None = None
    filament_type: str | None = None
    sliced_for_model: str | None = None

    # Tags assigned to this file (#1268). Empty list when the file has none —
    # never null, so the FE can iterate without a guard.
    tags: list[TagSummary] = []

    class Config:
        from_attributes = True


# ============ Tag Schemas (#1268) ============


class TagResponse(BaseModel):
    """Tag with the count of files currently using it."""

    id: int
    name: str
    file_count: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


def _validate_tag_name(v: str) -> str:
    # min_length runs on the RAW string, so "   " would pass and end up
    # stored as name="" / name_key="" — strip here and reject empties.
    v = v.strip()
    if not v:
        raise ValueError("Tag name cannot be empty or whitespace-only")
    return v


class TagCreate(BaseModel):
    """Create a new tag (catalog row)."""

    name: str = Field(..., min_length=1, max_length=64)

    _strip_name = field_validator("name")(_validate_tag_name)


class TagUpdate(BaseModel):
    """Rename a tag. ``name`` is required — there's nothing else to update."""

    name: str = Field(..., min_length=1, max_length=64)

    _strip_name = field_validator("name")(_validate_tag_name)


class TagBulkAssignRequest(BaseModel):
    """Bulk tag assignment payload.

    ``action='add'``      → append tags to every listed file (idempotent on dup).
    ``action='remove'``   → strip the listed tags from every listed file.
    ``action='replace'``  → REPLACE the tag set on every listed file with the
                            exact set in ``tag_ids`` (omitting tag_ids clears
                            them all).

    List sizes are capped so a buggy or malicious client can't build an
    unbounded cross-product in memory (files × tags pairs are generated
    server-side for the insert).
    """

    file_ids: list[int] = Field(..., min_length=1, max_length=1000)
    tag_ids: list[int] = Field(default_factory=list, max_length=100)
    action: str = Field("add", pattern="^(add|remove|replace)$")


class TagBulkAssignResponse(BaseModel):
    """Result of a bulk-assign call."""

    files_updated: int
    associations_added: int
    associations_removed: int


class FileMoveRequest(BaseModel):
    """Schema for moving files to a folder."""

    file_ids: list[int]
    folder_id: int | None = None  # None = move to root


class FileUploadResponse(BaseModel):
    """Schema for file upload response."""

    id: int
    filename: str
    file_type: str
    file_size: int
    thumbnail_path: str | None
    duplicate_of: int | None = None  # ID of existing file with same hash
    metadata: dict | None = None


class DuplicateCheckItem(BaseModel):
    """Info about an existing file that matches an uploaded file's hash."""

    id: int
    filename: str
    folder_id: int | None
    folder_name: str | None


class CheckDuplicatesRequest(BaseModel):
    """Request body for the duplicate-check endpoint."""

    hashes: list[str] = Field(default_factory=list, max_length=100)


class CheckDuplicatesResponse(BaseModel):
    """Maps each submitted hash to the first matching library file, if any."""

    duplicates: dict[str, DuplicateCheckItem]


# ============ Bulk Operations ============


class BulkDeleteRequest(BaseModel):
    """Schema for bulk delete operations."""

    file_ids: list[int] = []
    folder_ids: list[int] = []


class BulkDeleteResponse(BaseModel):
    """Schema for bulk delete response."""

    deleted_files: int
    deleted_folders: int


# ============ Queue Operations ============


class AddToQueueRequest(BaseModel):
    """Schema for adding library files to the print queue."""

    file_ids: list[int] = Field(..., min_length=1)


class AddToQueueResult(BaseModel):
    """Result for a single file added to queue."""

    file_id: int
    filename: str
    queue_item_id: int


class AddToQueueError(BaseModel):
    """Error for a file that couldn't be added to queue."""

    file_id: int
    filename: str
    error: str


class AddToQueueResponse(BaseModel):
    """Schema for add-to-queue response."""

    added: list[AddToQueueResult]
    errors: list[AddToQueueError]


# ============ ZIP Extraction ============


class ZipExtractResult(BaseModel):
    """Result for a single file extracted from ZIP."""

    filename: str
    file_id: int
    folder_id: int | None = None


class ZipExtractError(BaseModel):
    """Error for a file that couldn't be extracted."""

    filename: str
    error: str


class ZipExtractResponse(BaseModel):
    """Schema for ZIP extraction response."""

    extracted: int
    folders_created: int
    files: list[ZipExtractResult]
    errors: list[ZipExtractError]


# ============ STL Thumbnail Generation ============


class BatchThumbnailRequest(BaseModel):
    """Schema for batch STL thumbnail generation request."""

    file_ids: list[int] | None = None
    folder_id: int | None = None
    all_missing: bool = False


class BatchThumbnailResult(BaseModel):
    """Result for a single file thumbnail generation."""

    file_id: int
    filename: str
    success: bool
    error: str | None = None


class BatchThumbnailResponse(BaseModel):
    """Schema for batch thumbnail generation response."""

    processed: int
    succeeded: int
    failed: int
    results: list[BatchThumbnailResult]


# ============ File History (#file-history) ============


class FileHistoryEvent(BaseModel):
    """One row in a library file's history timeline.

    ``type`` is "print" for finished runs (from the print log, falling back to
    the archive itself when no log entry exists) and "queued" for pending or
    currently-printing queue items referencing the file.
    """

    type: str  # "print" | "queued"
    status: str  # print: completed/failed/stopped/cancelled/skipped — queued: pending/printing
    archive_id: int | None = None  # None when the archive is gone/trashed (no dead-end links)
    printer_name: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    duration_seconds: int | None = None
    filament_used_grams: float | None = None
    cost: float | None = None
    failure_reason: str | None = None
    created_by_username: str | None = None
    event_at: datetime | None = None  # timestamp used for ordering/display


class FileHistoryResponse(BaseModel):
    """Full history of a library file: provenance plus every known print run."""

    file_id: int
    filename: str
    added_at: datetime
    added_by_username: str | None = None
    source_type: str | None = None
    source_url: str | None = None
    # False when the file has no content hash (external files) — print
    # matching is impossible, only the "added" provenance is meaningful.
    history_available: bool
    total_prints: int
    success_count: int
    total_filament_grams: float | None = None
    last_printed_at: datetime | None = None
    events: list[FileHistoryEvent]  # newest first; queued entries first
