# SURFACE.md — Aito feature public contract (frozen at setup)

Regenerate each section with the exact commands shown. ANY diff vs this file = surface change = FAIL.

## HTTP routes
```regen: ./venv/bin/python3 -c "from backend.app.main import app; [print(r.path, sorted(r.methods)) for r in sorted(app.routes, key=lambda r: r.path) if hasattr(r, \"methods\") and \"/aito\" in r.path]" 2>/dev/null```
```
/api/v1/aito/ ['GET']
/api/v1/aito/ ['POST']
/api/v1/aito/import ['POST']
/api/v1/aito/shipping/services ['GET']
/api/v1/aito/summarize ['POST']
/api/v1/aito/tasks/{task_id} ['PATCH']
/api/v1/aito/tasks/{task_id} ['DELETE']
/api/v1/aito/trash ['GET']
/api/v1/aito/{project_id} ['PATCH']
/api/v1/aito/{project_id} ['DELETE']
/api/v1/aito/{project_id}/events ['GET']
/api/v1/aito/{project_id}/events ['POST']
/api/v1/aito/{project_id}/flag ['PATCH']
/api/v1/aito/{project_id}/move ['PATCH']
/api/v1/aito/{project_id}/quote-email ['GET']
/api/v1/aito/{project_id}/quote-email ['POST']
/api/v1/aito/{project_id}/quote-status ['POST']
/api/v1/aito/{project_id}/quote.pdf ['GET']
/api/v1/aito/{project_id}/restore ['POST']
/api/v1/aito/{project_id}/tasks ['GET']
/api/v1/aito/{project_id}/tasks ['POST']
```

## Frontend exported symbols (utils + hooks)
```regen: grep -hoE "^export (const|function|type|interface|class|enum) [A-Za-z0-9_]+" frontend/src/utils/aito*.ts frontend/src/hooks/useAito*.ts | sort```
```
export const AWAY_STATUSES
export const COLUMN_IDS
export const COLUMN_ORDER
export const emptyBoard
export const SERVICES
export const SHIPPING_PHONE_RE
export const STAGES
export function __resetAitoPresence
export function ageAnchor
export function agingColorCls
export function agingLevel
export function agingTextCls
export function allowedColumns
export function applyClientSocial
export function applyColumnMove
export function applyCreate
export function applyCrossColumnMove
export function applyDelete
export function applyDescription
export function applyQuoteStatus
export function applyRestore
export function applyShipping
export function applySyncState
export function applyTaskSummary
export function buildBoard
export function buildFallbackSummary
export function computeMoveTarget
export function evaluate
export function findColumn
export function flagRank
export function isPlaceholder
export function matchesSearch
export function nextPlaceholderId
export function placeholderProject
export function rankBySourceColumn
export function registerPresenceSender
export function sendAitoPresence
export function setAitoPresenceState
export function sortByRecencyDesc
export function summariseTasks
export function taskCost
export function tasksSignature
export function toOptimisticProjects
export function useAitoPageMutations
export function useAitoViewers
export interface TaskLike
export interface TaskSteps
export interface TaskSummary
export type AgeAnchor
export type AgingLevel
export type Board
export type ColumnId
export type MoveLock
export type MoveTarget
export type ServiceId
```

## Frontend component exports
```regen: grep -loE "export (default|function|const)" frontend/src/components/aito/*.tsx | sort  # file list; plus AitoPage.tsx```
```
AiSummaryPanel.tsx
BoardColumn.tsx
BoardSearch.tsx
CardView.tsx
ClientCombobox.tsx
ClientSection.tsx
columns.ts
CreateChecklist.tsx
DeleteHoldButton.tsx
DoneGrid.tsx
DurationInput.tsx
FieldError.tsx
FlagControl.tsx
history
HoldButton.tsx
ImportQuoteDrawer.tsx
ImpressionFields.tsx
IslandCombobox.tsx
NewContactForm.tsx
NewProjectDrawer.tsx
PanelAgeStat.tsx
panelTypography.ts
PhoneInput.tsx
ProjectDetailPanel.tsx
ProjectDoneAction.tsx
ProjectProgress.tsx
QuoteEmailPreview.tsx
QuotePrintButton.tsx
QuoteResultList.tsx
quoteStatus.ts
QuoteStatusActions.tsx
SendQuoteButton.tsx
SendQuoteModal.tsx
ServiceBadges.tsx
services.ts
ShippingCard.tsx
ShippingFields.tsx
SocialInput.tsx
StageRail.tsx
TaskEditor.tsx
TaskMiniRows.tsx
TaskRow.tsx
TaskStepFields.tsx
TaskStepList.tsx
TrashGrid.tsx
versionConflictToast.ts
ViewToggleButton.tsx
```

## Backend service/module public functions
```regen: grep -hE "^(def|class|async def) [a-zA-Z]" backend/app/services/aito_*.py backend/app/api/routes/aito.py | grep -v "^def _\|^async def _" | sort```
```
async def add_note(
async def add_task(
async def create_project(
async def delete_project(
async def delete_task(
async def get_quote_email(
async def get_quote_pdf(
async def import_legacy_projects(
async def list_events(
async def list_projects(
async def list_shipping_services(
async def list_tasks(
async def list_trash(
async def load_export_tasks(db: AsyncSession, project_id: int) -> list[ExportTask]:
async def mirror_comments(db: AsyncSession, project: AitoProject, comments: list[dict]) -> int:
async def move_project(
async def reconcile_quote_status(db: AsyncSession, project: AitoProject, estimate: dict) -> None:
async def record(
async def restore_project(
async def run_sync_loop() -> None:
async def run_sync_once(db: AsyncSession, pending_only: bool = False) -> int:
async def send_quote_email(
async def set_project_flag(
async def set_quote_status(
async def summarize_project(
async def sync_enabled(db: AsyncSession) -> bool:
async def sync_interval_seconds(db: AsyncSession) -> int:
async def sync_project(db: AsyncSession, project: AitoProject) -> None:
async def update_project(
async def update_task(
class Catalogue:
class ExportShipping:
class ExportTask:
class ParsedLine:
class ParsedShipping:
class ShippingCatalogueUnavailable(Exception):
class ShippingItem:
class TaskSteps:
class TaskSummary:
def adopt_quote_status(project: AitoProject, new_status: str | None) -> None:
def build_description(service: str, task: ExportTask) -> str:
def build_line_items(
def build_preview(
def build_shipping_description(shipping: ExportShipping) -> str:
def cost_of(task: ExportTask, service: str) -> float | None:
def description_of(task: ExportTask, service: str) -> str | None:
def diff_fields(obj: Any, patch: dict) -> list[dict]:
def enabled_services(task: ExportTask) -> tuple[str, ...]:
def evaluate(quote_status: str | None, stored_column: str, pending: Collection[str]) -> tuple[str, str | None]:
def format_time(minutes: int | None) -> str | None:
def format_weight(grams: float | None) -> str | None:
def group_lines(lines: list[ParsedLine]) -> list[list[ParsedLine]]:
def grouped_islands() -> list[tuple[str, list[tuple[str, str]]]]:
def impression_rate_quantity(task: ExportTask) -> tuple[float, int]:
def is_foreign(line: dict, catalogue: Catalogue) -> bool:
def island_for_label(label: str | None) -> str | None:
def island_label(island: str | None) -> str | None:
def kinds_for_depth(depth: str) -> list[str]:
def load_export_shipping(project: AitoProject, catalogue: Catalogue) -> ExportShipping | None:
def map_comment(comment: dict) -> dict:
def merge_shipping_catalogue(cached: dict[str, dict], items: list[dict]) -> dict[str, dict]:
def parse_description(
def parse_lines(
def parse_shipping_line(line: dict, shipping_ids: dict[str, str]) -> ParsedShipping | None:
def parse_time_min(value: str | None) -> int | None:
def parse_weight_g(value: str | None) -> float | None:
def request_debounced_sync() -> None:
def request_immediate_sync() -> None:
def service_for_island(island: str | None) -> str | None:
def service_for_sku(sku: str | None) -> str | None:
def should_pull_comments(project: AitoProject, estimate: dict, now: datetime) -> bool:
def start_aito_quote_sync() -> None:
def summarise(tasks: Iterable[Any]) -> TaskSummary:
```

## Settings/env keys referenced by aito modules
```regen: grep -hoE "settings\.[a-z_]+" backend/app/api/routes/aito.py backend/app/services/aito_*.py | sort -u```
```
```
