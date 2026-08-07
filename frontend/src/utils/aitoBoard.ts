import type { AitoColumnId, AitoProject } from '../api/client';

export type ColumnId = AitoColumnId;
export type Board = Record<ColumnId, AitoProject[]>;

export const COLUMN_IDS: ColumnId[] = ['devis', 'waiting', 'scan', 'model', 'print', 'finish', 'done'];

export const emptyBoard = (): Board => ({
  devis: [],
  waiting: [],
  scan: [],
  model: [],
  print: [],
  finish: [],
  done: [],
});

/** dnd-kit's arrayMove, inlined so this module stays dependency-free. */
function arrayMove<T>(items: T[], from: number, to: number): T[] {
  const next = items.slice();
  next.splice(to < 0 ? next.length + to : to, 0, next.splice(from, 1)[0]);
  return next;
}

/** Group the flat server list into drag-friendly columns, ordered by position. */
export function buildBoard(projects: AitoProject[]): Board {
  const board = emptyBoard();
  for (const project of projects) {
    if (COLUMN_IDS.includes(project.column)) board[project.column].push(project);
  }
  // Flagged first, then stored position. The server orders the same way
  // (routes/aito.py:list_projects), but this local sort is load-bearing, not
  // belt-and-braces: every optimistic write rebuilds the board from the
  // React Query cache without a refetch, so a flag would not move its card
  // until the next server round-trip if this only trusted `position`.
  // Urgent and SAV are peers — the comparator tests "flagged at all", never
  // which flag, so neither outranks the other.
  for (const col of COLUMN_IDS) {
    board[col].sort((a, b) => Number(!!b.flag) - Number(!!a.flag) || a.position - b.position);
  }
  return board;
}

/** `id` may be a column id (the droppable itself) or a card id. */
export function findColumn(board: Board, id: string | number): ColumnId | undefined {
  if (COLUMN_IDS.includes(id as ColumnId)) return id as ColumnId;
  return COLUMN_IDS.find((col) => board[col].some((p) => p.id === id));
}

/** Trello-style live relocation during dragOver, so the destination column opens
 *  a slot under the pointer. Returns `board` unchanged when nothing applies. */
export function applyCrossColumnMove(board: Board, activeId: number, overId: string | number): Board {
  const from = findColumn(board, activeId);
  const to = findColumn(board, overId);
  if (!from || !to || from === to) return board;

  const moving = board[from].find((p) => p.id === activeId);
  if (!moving) return board;

  const overIndex = board[to].findIndex((p) => p.id === overId);
  const insertAt = overIndex >= 0 ? overIndex : board[to].length;
  return {
    ...board,
    [from]: board[from].filter((p) => p.id !== activeId),
    [to]: [...board[to].slice(0, insertAt), moving, ...board[to].slice(insertAt)],
  };
}

export type MoveTarget =
  | { kind: 'move'; board: Board; column: ColumnId; position: number }
  | { kind: 'noop' }
  | { kind: 'resync' };

/** Decide what a drop means.
 *
 *  - `noop`   — released back into its own slot; firing a PATCH would be pointless
 *  - `resync` — the board and the drag disagree; refetch rather than guess
 *  - `move`   — carries the reordered board plus the column/position to persist
 *
 *  `originColumn` is the column the card started the drag in. A cross-column
 *  relocation was already applied live by dragOver, so its index in the
 *  destination can legitimately equal its old index — that is still a real move.
 */
export function computeMoveTarget(
  board: Board,
  activeId: number,
  overId: string | number,
  originColumn: ColumnId | null,
): MoveTarget {
  const column = findColumn(board, activeId);
  if (!column) return { kind: 'resync' };

  const items = board[column];
  const oldIndex = items.findIndex((p) => p.id === activeId);
  const overIndex = items.findIndex((p) => p.id === overId);
  const newIndex = overIndex >= 0 ? overIndex : items.length - 1;
  const movedColumns = originColumn !== null && originColumn !== column;

  if (!movedColumns && (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex)) {
    return { kind: 'noop' };
  }

  const reordered =
    oldIndex >= 0 && newIndex >= 0 && oldIndex !== newIndex ? arrayMove(items, oldIndex, newIndex) : items;
  const position = reordered.findIndex((p) => p.id === activeId);
  if (position < 0) return { kind: 'resync' };

  return {
    kind: 'move',
    board: reordered === items ? board : { ...board, [column]: reordered },
    column,
    position,
  };
}

/** Flatten the board back into the server's shape with contiguous positions,
 *  for the optimistic React Query cache write. */
export function toOptimisticProjects(board: Board): AitoProject[] {
  return COLUMN_IDS.flatMap((col) =>
    board[col].map((project, index) => ({ ...project, column: col, position: index })),
  );
}

/** Which columns this card may be dropped into: always, and only, its own.
 *
 *  Dragging is reordering now. It changes priority, not state, which is why a
 *  rule-locked card is still grabbable — and why a RELEASED one gets no extra
 *  destinations either: the one cross-column transition a user can make by
 *  hand (Finish <-> Done) rides the card's own hold buttons instead, since
 *  Done is no longer a rendered column and has no droppable to aim at. Listing
 *  `done` here would dim five columns mid-drag and offer nothing reachable in
 *  return.
 *
 *  Kept as a function returning a list, rather than collapsed into the caller,
 *  because `useBoardDrag` gates every drop on this — the server enforces the
 *  same rules with a 409, and this is what stops dnd-kit relocating the card
 *  visually before that refusal arrives. */
export function allowedColumns(project: AitoProject): ColumnId[] {
  return [project.column];
}
