import { evaluate } from './aitoBoardRules';
import type { TaskSummary } from './aitoBoardRules';
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
 *  but getting it right is what stops the card visibly jumping twice. */

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
): AitoProject[] {
  if (!projects) return [];
  const target = projects.find((p) => p.id === id);
  if (!target) return projects;
  const updated = { ...target, quote_status: status };
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
): AitoProject[] {
  if (!projects) return [];
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
  };
  return reevaluate(projects, updated, summary.pending);
}

export function applyDescription(
  projects: AitoProject[] | undefined,
  id: number,
  description: string,
): AitoProject[] {
  if (!projects) return [];
  return projects.map((p) => (p.id === id ? { ...p, description } : p));
}

export function applySyncState(
  projects: AitoProject[] | undefined,
  id: number,
  state: AitoProject['quote_sync_state'],
): AitoProject[] {
  if (!projects) return [];
  return projects.map((p) => (p.id === id ? { ...p, quote_sync_state: state } : p));
}

/** Remove the project without renumbering survivors in its column. Mirrors the
 *  server's soft delete (backend/app/api/routes/aito.py:delete_project), which
 *  only sets `status = "deleted"` and never touches other rows' positions. The
 *  gap left behind (e.g., positions 0, 2, 3 after deleting position 1) is
 *  invisible to the UI — `buildBoard` sorts each column by position, so relative
 *  order is preserved and the gap does not render. Predicting a renumber the
 *  server never performs would put the cache out of step with the next fetch. */
export function applyDelete(projects: AitoProject[] | undefined, id: number): AitoProject[] {
  if (!projects) return [];
  return projects.filter((p) => p.id !== id);
}

/** Mirrors `create_project` (`POST /api/v1/aito/`, backend/app/api/routes/aito.py
 *  around line 377): board create AND quote import both go through that one
 *  endpoint, and it does the opposite of appending — every existing Devis
 *  card is shifted down a position and the new row is inserted at Devis
 *  position 0. A placeholder from either surface must land on TOP of the
 *  quote column, not the bottom, which is why this is not `applyRestore`
 *  below with a different column argument. */
export function applyCreate(projects: AitoProject[] | undefined, placeholder: AitoProject): AitoProject[] {
  const list = projects ?? [];
  const shifted = list.map((p) => (p.column === 'devis' ? { ...p, position: p.position + 1 } : p));
  return [...shifted, { ...placeholder, column: 'devis', position: 0 }];
}

/** Mirrors `restore_project` (`POST /api/v1/aito/{id}/restore`,
 *  backend/app/api/routes/aito.py): un-deleting a card puts it back at the
 *  END of whatever column it last lived in — the trash restore path has no
 *  reason to jump the queue the way a freshly created quote does, so unlike
 *  `applyCreate` above it genuinely appends. */
export function applyRestore(projects: AitoProject[] | undefined, project: AitoProject): AitoProject[] {
  const list = projects ?? [];
  const count = list.filter((p) => p.column === project.column).length;
  return [...list, { ...project, position: count }];
}
