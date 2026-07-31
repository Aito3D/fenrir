import { evaluate, summariseTasks } from './aitoBoardRules';
import type { TaskLike, TaskSummary } from './aitoBoardRules';
import type { AitoProject } from '../api/client';

/** Pure optimistic transforms over the `['aito-projects']` cache.
 *
 *  Every function here is `AitoProject[] -> AitoProject[]`: no React, no query
 *  client, no network. That is deliberate and load-bearing — it is what makes
 *  the whole optimistic layer unit-testable without mounting a modal, which
 *  the previous generation of this code (see useProjectTasks' docstring) was
 *  not.
 *
 *  Each transform reproduces what the SERVER does, `_apply_rules` in
 *  backend/app/api/routes/aito.py included: recompute the column, and when it
 *  changes, append the project to the END of its destination column and
 *  renumber the source contiguously. Getting the relocation wrong is not a
 *  correctness risk — the settle-invalidate corrects it one round trip later —
 *  but getting it right is what stops the card visibly jumping twice.
 *
 *  One deliberate exception: `applyColumnMove` below. Its endpoint is not
 *  rule-driven — the caller supplies the destination slot outright — so there
 *  is no "append" for it to reproduce; see its own doc comment for why that
 *  makes it a HEAD insert instead. */

// Module-level, not per-hook: board create, quote import and trash restore can
// all have placeholders outstanding at once, and a per-surface counter would
// hand two of them the same id. Negative is a space real ids never occupy.
let placeholderCounter = 0;

export function nextPlaceholderId(): number {
  placeholderCounter -= 1;
  return placeholderCounter;
}

/** A row the server has not acknowledged yet. Such a card renders inert — no
 *  grip, no expand, no actions — because its id does not exist yet, and
 *  letting a user edit against it is the one way optimistic creates actually
 *  corrupt state. */
export function isPlaceholder(project: AitoProject): boolean {
  return project.id < 0;
}

/** `_apply_rules`, in TypeScript: relocate `moved` into `column` and renumber
 *  both affected columns. Returns the full list, order-insensitive — the board
 *  is grouped and sorted by `buildBoard` downstream. */
function relocate(projects: AitoProject[], moved: AitoProject, column: AitoProject['column']): AitoProject[] {
  if (moved.column === column) return projects;

  const source = moved.column;
  const destinationCount = projects.filter((p) => p.column === column && p.id !== moved.id).length;
  const relocated = { ...moved, column, position: destinationCount };

  // Rank the remainder by `position, id` — exactly `_active_in_column`'s
  // `ORDER BY position, id` — NOT by array traversal order. The two agree
  // only while a column's array order happens to match its position order,
  // and `relocate` itself breaks that invariant: it gives the moved card the
  // highest position in its DESTINATION column while leaving it at its
  // original array index, so the next card to leave that column would be
  // renumbered wrongly by array order alone. `.filter` above already copies,
  // so sorting it in place does not mutate the `projects` argument.
  const sourceRank = new Map<number, number>();
  projects
    .filter((p) => p.column === source && p.id !== moved.id)
    .sort((a, b) => a.position - b.position || a.id - b.id)
    .forEach((project, index) => sourceRank.set(project.id, index));

  return projects.map((project) => {
    if (project.id === moved.id) return relocated;
    if (project.column !== source) return project;
    const position = sourceRank.get(project.id)!;
    return project.position === position ? project : { ...project, position };
  });
}

/** Recompute a project's column and lock from the rules, then relocate.
 *  `pending` comes from the caller because only it knows whether the tasks
 *  changed; passing the card's own state through unchanged is correct for
 *  transforms that touch nothing task-shaped. */
function reevaluate(projects: AitoProject[], updated: AitoProject, pending: readonly string[]): AitoProject[] {
  const [column, lock] = evaluate(updated.quote_status, updated.column, pending);
  const withLock = { ...updated, move_lock: lock };
  const next = projects.map((p) => (p.id === withLock.id ? withLock : p));
  return relocate(next, withLock, column);
}

export function applyQuoteStatus(
  projects: AitoProject[] | undefined,
  id: number,
  status: string,
): AitoProject[] | undefined {
  if (!projects) return undefined;
  const target = projects.find((p) => p.id === id);
  if (!target) return projects;
  const updated = {
    ...target,
    quote_status: status,
    // Mirrors `set_quote_status`: our side just moved, so any recorded
    // Zoho conflict/rejection describes an attempt that no longer exists.
    // Leaving these stale would keep the panel's red "we say X, Zoho says
    // Y" sentence on screen for one round trip, describing a conflict that
    // is already resolved — with the NEW status interpolated into it.
    quote_status_block: null,
    quote_status_remote: null,
  };
  // `task_pending`, never `task_services`: the rules take the set of services
  // with unticked work, and `task_services` is the set of ENABLED ones. On a
  // project whose scan is done but whose printing is not, the two differ and
  // only the former lands the card in the right stage.
  return reevaluate(projects, updated, updated.task_pending);
}

export function applyTaskSummary(
  projects: AitoProject[] | undefined,
  id: number,
  summary: TaskSummary,
): AitoProject[] | undefined {
  if (!projects) return undefined;
  const target = projects.find((p) => p.id === id);
  if (!target) return projects;
  const updated: AitoProject = {
    ...target,
    task_count: summary.count,
    tasks_total: summary.total,
    task_services: [...summary.services],
    task_pending: [...summary.pending],
    steps_total: summary.stepsTotal,
    steps_done: summary.stepsDone,
    task_steps: summary.stepsByTask.map((steps) => ({ ...steps })),
  };
  return reevaluate(projects, updated, summary.pending);
}

export function applyDescription(
  projects: AitoProject[] | undefined,
  id: number,
  description: string,
): AitoProject[] | undefined {
  if (!projects) return undefined;
  return projects.map((p) => (p.id === id ? { ...p, description } : p));
}

export function applySyncState(
  projects: AitoProject[] | undefined,
  id: number,
  state: AitoProject['quote_sync_state'],
): AitoProject[] | undefined {
  if (!projects) return undefined;
  return projects.map((p) => (p.id === id ? { ...p, quote_sync_state: state } : p));
}

/** Remove the project without renumbering survivors in its column. Mirrors the
 *  server's soft delete (backend/app/api/routes/aito.py:delete_project), which
 *  only sets `status = "deleted"` and never touches other rows' positions. The
 *  gap left behind (e.g., positions 0, 2, 3 after deleting position 1) is
 *  invisible to the UI — `buildBoard` sorts each column by position, so relative
 *  order is preserved and the gap does not render. Predicting a renumber the
 *  server never performs would put the cache out of step with the next fetch. */
export function applyDelete(projects: AitoProject[] | undefined, id: number): AitoProject[] | undefined {
  if (!projects) return undefined;
  return projects.filter((p) => p.id !== id);
}

/** Mirrors `PATCH /aito/{id}/move` called with `position: 0` — the board's one
 *  remaining manual transition, now that Done is off the board and finish <->
 *  done rides the card's own hold buttons instead of a drag.
 *
 *  Deliberately NOT `relocate` above. That mirrors `_apply_rules`, which
 *  APPENDS to the destination because the rules choose the column and the
 *  server picks the slot. Here the caller supplies the slot explicitly, and it
 *  always supplies 0 — a restored card belongs at the top of Finish, where the
 *  user can see the thing they just un-archived. Predicting an append would
 *  park it at the far end of the column for one round trip.
 *
 *  The source column is renumbered contiguously, ranked by `position, id` to
 *  match `_active_in_column`'s `ORDER BY position, id`. Ranking by array order
 *  instead only agrees while a column's array order happens to match its
 *  position order, which nothing guarantees. */
export function applyColumnMove(
  projects: AitoProject[] | undefined,
  id: number,
  column: AitoProject['column'],
): AitoProject[] {
  if (!projects) return [];
  const moved = projects.find((p) => p.id === id);
  if (!moved || moved.column === column) return projects;

  const source = moved.column;
  const sourceRank = new Map<number, number>();
  projects
    .filter((p) => p.column === source && p.id !== id)
    .sort((a, b) => a.position - b.position || a.id - b.id)
    .forEach((project, index) => sourceRank.set(project.id, index));

  return projects.map((project) => {
    if (project.id === id) return { ...project, column, position: 0 };
    if (project.column === column) return { ...project, position: project.position + 1 };
    if (project.column === source) {
      const position = sourceRank.get(project.id)!;
      return project.position === position ? project : { ...project, position };
    }
    return project;
  });
}

/** Mirrors `create_project` (`POST /api/v1/aito/`, backend/app/api/routes/aito.py
 *  around line 377): board create AND quote import both go through that one
 *  endpoint, which inserts the new row at Devis position 0 (shifting every
 *  existing Devis card down a position) and THEN runs `_apply_rules` against
 *  the posted `quote_status` and tasks — so a card imported already `sent`,
 *  `accepted` or `declined` relocates before the create even returns, never
 *  visibly parking on Quote first. `placeholderProject` below evaluates the
 *  same rules up front so the placeholder is already honest, but this
 *  transform re-derives the destination itself (via `reevaluate`, the same
 *  helper every other transform uses) rather than trusting the placeholder's
 *  own fields — a placeholder built any other way still lands correctly.
 *  When the rules agree with a plain Devis landing (every status this
 *  endpoint's manual-create path ever posts, and an imported `draft` quote),
 *  `reevaluate`'s `relocate` is a same-column no-op and this is exactly the
 *  old prepend-and-shift behaviour. */
export function applyCreate(
  projects: AitoProject[] | undefined,
  placeholder: AitoProject,
): AitoProject[] | undefined {
  if (!projects) return undefined;
  const shifted = projects.map((p) => (p.column === 'devis' ? { ...p, position: p.position + 1 } : p));
  const seeded: AitoProject = { ...placeholder, column: 'devis', position: 0 };
  return reevaluate([...shifted, seeded], seeded, placeholder.task_pending);
}

/** A card that exists on screen but not yet on the server.
 *
 *  Every field the board renders must be present and honest, including the
 *  ones `create_project` would only learn from the posted body: `quote_status`
 *  (a manual create posts none, so it defaults to null — the same "waits for
 *  Accept" state a draft import has) and the task summary, derived from
 *  `tasks` with the same `summariseTasks` the server-mirrored rules use
 *  everywhere else. Without this, an import of a non-draft quote — the normal
 *  case — showed an empty, quote-less placeholder that jumped columns AND
 *  filled in its badges/total one round trip later, the exact double-jump
 *  this whole optimistic layer exists to prevent.
 *
 *  `column`/`move_lock` are evaluated here too, so the placeholder alone is
 *  self-consistent even before `applyCreate` runs its own `reevaluate` over
 *  it — nothing here guesses beyond what the rules already say from the
 *  fields the caller posts. The server's own row replaces this wholesale on
 *  success either way. */
export function placeholderProject(fields: {
  description: string;
  client_id: string | null;
  client_name: string | null;
  client_phone: string | null;
  client_email: string | null;
  client_is_company: boolean | null;
  quote_number?: string | null;
  quote_total?: number | null;
  quote_status?: string | null;
  tasks?: readonly TaskLike[];
}): AitoProject {
  const quoteStatus = fields.quote_status ?? null;
  const summary = summariseTasks(fields.tasks ?? []);
  const [column, lock] = evaluate(quoteStatus, 'devis', summary.pending);
  const now = new Date().toISOString();
  return {
    id: nextPlaceholderId(),
    description: fields.description,
    column,
    position: 0,
    status: 'active',
    client_id: fields.client_id,
    client_name: fields.client_name,
    client_phone: fields.client_phone,
    client_email: fields.client_email,
    client_is_company: fields.client_is_company,
    quote_id: null,
    quote_number: fields.quote_number ?? null,
    quote_date: null,
    quote_total: fields.quote_total ?? null,
    quote_url: null,
    quote_salesperson: null,
    quote_status: quoteStatus,
    quote_sync_state: 'pending',
    quote_sync_error: null,
    quote_status_block: null,
    quote_status_remote: null,
    created_by: null,
    task_count: summary.count,
    tasks_total: summary.total,
    task_services: [...summary.services],
    task_pending: [...summary.pending],
    steps_total: summary.stepsTotal,
    steps_done: summary.stepsDone,
    task_steps: summary.stepsByTask.map((steps) => ({ ...steps })),
    move_lock: lock,
    created_at: now,
    updated_at: now,
  };
}

/** Mirrors `restore_project` (`POST /api/v1/aito/{id}/restore`,
 *  backend/app/api/routes/aito.py): un-deleting a card puts it back at the
 *  END of whatever column it last lived in — the trash restore path has no
 *  reason to jump the queue the way a freshly created quote does, so unlike
 *  `applyCreate` above it genuinely appends. */
export function applyRestore(projects: AitoProject[] | undefined, project: AitoProject): AitoProject[] | undefined {
  if (!projects) return undefined;
  const count = projects.filter((p) => p.column === project.column).length;
  return [...projects, { ...project, position: count }];
}
