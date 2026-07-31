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

  let sourceIndex = 0;
  return projects.map((project) => {
    if (project.id === moved.id) return relocated;
    if (project.column !== source) return project;
    const position = sourceIndex;
    sourceIndex += 1;
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

export function applyDelete(projects: AitoProject[] | undefined, id: number): AitoProject[] {
  if (!projects) return [];
  const target = projects.find((p) => p.id === id);
  if (!target) return projects;
  let position = 0;
  return projects
    .filter((p) => p.id !== id)
    .map((project) => {
      if (project.column !== target.column) return project;
      const next = position;
      position += 1;
      return project.position === next ? project : { ...project, position: next };
    });
}

/** Append a card to the end of its own column. Used by create, import and
 *  restore, all of which land a row the list has never seen. */
export function applyInsert(projects: AitoProject[] | undefined, project: AitoProject): AitoProject[] {
  const list = projects ?? [];
  const count = list.filter((p) => p.column === project.column).length;
  return [...list, { ...project, position: count }];
}
