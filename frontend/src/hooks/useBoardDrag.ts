import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { api, type AitoProject } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import {
  COLUMN_IDS,
  allowedColumns,
  applyCrossColumnMove,
  buildBoard,
  computeMoveTarget,
  emptyBoard,
  findColumn,
  toOptimisticProjects,
  type Board,
  type ColumnId,
} from '../utils/aitoBoard';

interface MoveVariables {
  id: number;
  column: ColumnId;
  position: number;
  previous: AitoProject[] | undefined;
}

/** Drag-and-drop state and the move mutation for the Aito board.
 *
 *  Cache contract: `projects` is read-only input for building the local
 *  `board`, but every write this hook makes — the optimistic move, every
 *  rollback, and every settle-time refetch — targets the hard-coded
 *  `['aito-projects']` query key, not whatever `projects` was derived from.
 *  That is safe for AitoPage, the only caller today, because it passes the
 *  full, unfiltered board. A caller passing a filtered or derived list would
 *  have `setQueryData(['aito-projects'], ...)` overwrite the FULL cache entry
 *  with just the filtered subset — silently deleting every other card from
 *  the cache until the next settle-invalidate corrects it. This hook is not
 *  safe to reuse with a filtered `projects` without changing that. */
export function useBoardDrag(projects: AitoProject[] | undefined) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const [board, setBoard] = useState<Board>(emptyBoard);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [allowedDropColumns, setAllowedDropColumns] = useState<ColumnId[] | null>(null);

  // A move is "in flight" from the moment handleDragEnd fires until the PATCH
  // settles. The local board owns the ordering for that whole window — a ref so
  // the guard closes synchronously, plus a counter so the effect re-runs once
  // the server agrees even if the query data identity never changes.
  const pendingMoves = useRef(0);
  const [syncGeneration, setSyncGeneration] = useState(0);

  // Keeps the local drag-friendly board in sync with the server, but never
  // while a drag is in flight — a background refetch mid-drag would yank
  // the card out from under the pointer.
  useEffect(() => {
    if (!projects) return;
    if (activeId !== null) return;
    if (pendingMoves.current > 0) return;
    setBoard(buildBoard(projects));
  }, [projects, activeId, syncGeneration]);

  const moveMutation = useMutation({
    // Serializes overlapping moves in drop order: without a scope, two quick
    // drags race the endpoint concurrently and the second's position (computed
    // against a board that assumed the first had already landed) can land
    // first. Note this does not fix the rollback chain: each move's
    // `previous` snapshot is captured at drop time, so if two moves both fail
    // the second's rollback restores over the first's — self-corrected one
    // round trip later by the settle-invalidate.
    scope: { id: 'aito-move' },
    mutationFn: ({ id, column, position }: MoveVariables) => api.moveAitoProject(id, { column, position }),
    // The optimistic cache write happens synchronously in handleDragEnd, so all
    // this needs to do is stop in-flight refetches and carry the rollback
    // snapshot through. Doing the write here, behind an await, is what let the
    // sync effect rebuild from stale data and snap the card back.
    onMutate: async (variables: MoveVariables) => {
      await queryClient.cancelQueries({ queryKey: ['aito-projects'] });
      return { previous: variables.previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['aito-projects'], context.previous);
      }
      showToast(t('aito.moveFailed'), 'error');
    },
    onSettled: () => {
      // Must not throw: on the success path React Query runs onSettled inside the
      // same try as the mutationFn, so a throw here re-runs onError + onSettled
      // and double-decrements the counter.
      pendingMoves.current -= 1;
      setSyncGeneration((generation) => generation + 1);
      // Only the last move to settle refetches: invalidating while another
      // move is still queued or in flight lets the resulting GET — which
      // predates that move — overwrite its optimistic cache entry, which the
      // generation bump would then rebuild the board from. The last settle
      // always invalidates, so nothing is left stale.
      if (pendingMoves.current === 0) {
        queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      }
    },
  });

  const sensors = useSensors(
    // A small threshold still earns its keep with a dedicated grip: without any
    // constraint, a plain click on the grip starts and immediately ends a drag,
    // which flashes the card to opacity-30 and renders the DragOverlay for a
    // frame. `computeMoveTarget` returns 'noop' so nothing is persisted — the
    // cost is purely visual, and 4px removes it while still feeling immediate.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const activeProject = useMemo(
    () => (activeId !== null ? COLUMN_IDS.flatMap((col) => board[col]).find((p) => p.id === activeId) ?? null : null),
    [activeId, board],
  );

  // animate-rise is an entrance, not a move. Track which ids were on the board
  // as of the last commit: an id that was already there is relocating, so a
  // cross-column drag — which remounts the card under a new parent — must not
  // replay its entrance. A card restored from the trash left the board and
  // comes back, so it correctly animates again. Read-only during render;
  // updated post-commit so StrictMode's double-invoke cannot consume it.
  const presentIds = useRef<Set<number>>(new Set());
  const shouldAnimateIn = (id: number) => !presentIds.current.has(id);

  useEffect(() => {
    presentIds.current = new Set(COLUMN_IDS.flatMap((col) => board[col].map((project) => project.id)));
  }, [board]);

  // Tracks the column the card started in so dragEnd can tell a real
  // cross-column relocation (already applied live by dragOver) apart from a
  // plain click-drag-release back into the same slot — the latter must not
  // fire a PATCH.
  const dragOriginColumnRef = useRef<ColumnId | null>(null);

  const handleDragStart = ({ active }: DragStartEvent) => {
    setActiveId(active.id as number);
    const originColumn = findColumn(board, active.id) ?? null;
    dragOriginColumnRef.current = originColumn;
    const card = originColumn ? board[originColumn].find((p) => p.id === (active.id as number)) ?? null : null;
    setAllowedDropColumns(card ? allowedColumns(card) : null);
  };

  // BoardColumn's `dropDisabled` only disables the COLUMN's own droppable —
  // it opens a slot in an empty column, but every card is its own
  // `useSortable` droppable and stays collidable no matter which column it
  // sits in. `over.id` can therefore resolve to a card that lives in a
  // disallowed column just as easily as to a column background, so the gate
  // has to live here too, resolving the destination the same way the move
  // path (computeMoveTarget/applyCrossColumnMove) already does via
  // `findColumn`. A card's own column is always in `allowedDropColumns`
  // (allowedColumns() guarantees it), so reordering within it is never
  // blocked by this check.
  const isDropAllowed = (overId: string | number) => {
    if (allowedDropColumns === null) return true;
    const destination = findColumn(board, overId);
    return destination === undefined || allowedDropColumns.includes(destination);
  };

  // Cross-column moves happen live during dragOver so the destination column
  // opens a slot under the pointer (Trello-style), not only on drop.
  const handleDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    if (!isDropAllowed(over.id)) return;
    setBoard((prev) => applyCrossColumnMove(prev, active.id as number, over.id));
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    const originColumn = dragOriginColumnRef.current;
    dragOriginColumnRef.current = null;

    // Dropped outside any droppable: dragOver may already have relocated the
    // card locally with nothing to persist it, so resync rather than desync.
    // Skipped while a move is pending — see onSettled for why.
    if (!over) {
      setAllowedDropColumns(null);
      if (pendingMoves.current === 0) {
        queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      }
      return;
    }

    // dragOver already refused to relocate a disallowed drop, so the board
    // still holds the pre-drag layout here — nothing to persist and nothing
    // to resync. Checked against the CURRENT allowedDropColumns, still in
    // scope until the clear below takes effect on the next render.
    const dropAllowed = isDropAllowed(over.id);
    setAllowedDropColumns(null);
    if (!dropAllowed) return;

    const result = computeMoveTarget(board, active.id as number, over.id, originColumn);
    if (result.kind === 'resync') {
      // Skipped while a move is pending — see onSettled for why.
      if (pendingMoves.current === 0) {
        queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      }
      return;
    }
    if (result.kind === 'noop') return;

    setBoard(result.board);

    // Write the new ordering into the cache synchronously, before mutate(), so
    // the sync effect can never observe the pre-move layout.
    const previous = queryClient.getQueryData<AitoProject[]>(['aito-projects']);
    queryClient.setQueryData<AitoProject[]>(['aito-projects'], toOptimisticProjects(result.board));

    pendingMoves.current += 1;
    moveMutation.mutate({
      id: active.id as number,
      column: result.column,
      position: result.position,
      previous,
    });
  };

  // While dragging, highlight the column currently holding the active card
  // (dragOver moves it live, so this is always the drop destination).
  const dropTarget = activeId !== null ? findColumn(board, activeId) : undefined;

  return {
    board,
    activeProject,
    dropTarget,
    allowedDropColumns,
    shouldAnimateIn,
    sensors,
    dndHandlers: {
      onDragStart: handleDragStart,
      onDragOver: handleDragOver,
      onDragEnd: handleDragEnd,
      onDragCancel: () => {
        setActiveId(null);
        setAllowedDropColumns(null);
        dragOriginColumnRef.current = null;
        // A cancelled drag (e.g. Escape) can leave a cross-column dragOver
        // relocation applied locally with nothing persisted — resync.
        // Skipped while a move is pending — see onSettled for why.
        if (pendingMoves.current === 0) {
          queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
        }
      },
    },
  };
}
