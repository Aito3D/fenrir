import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { AlertTriangle, FileInput, Kanban, Plus, Trash2, X } from 'lucide-react';
import { Button } from '../components/Button';
import { CardView } from '../components/aito/CardView';
import { BoardColumn } from '../components/aito/BoardColumn';
import { COLUMNS } from '../components/aito/columns';
import { ImportQuoteModal } from '../components/aito/ImportQuoteModal';
import { NewProjectModal } from '../components/aito/NewProjectModal';
import { ProjectDetailPanel } from '../components/aito/ProjectDetailPanel';
import { api, ApiError, type AitoProject, type ZohoQuotePreview } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { formatElapsedTime } from '../utils/date';
import { formatPhone } from '../utils/clientDraft';
import type { ClientDraft } from '../utils/clientDraft';
import { taskDraftToTaskCreate } from '../utils/taskDraft';
import type { TaskDraft } from '../utils/taskDraft';
import { prefersReducedMotion } from '../utils/motion';
import { useCardMorph } from '../hooks/useCardMorph';
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

// Shape of the pre-Task-7 localStorage board, kept only for the one-time
// migration into the DB-backed board.
interface LegacyProject {
  id?: string;
  description: string;
  createdAt?: string;
}
type LegacyBoard = Partial<Record<ColumnId, LegacyProject[]>>;

const STORAGE_KEY = 'aito-board-v1';

// Shared with SortableCard so the dropped card and the neighbours closing
// the gap around it settle on the same curve.
const SORTABLE_TRANSITION = { duration: 250, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' };

const DROP_ANIMATION: DropAnimation = {
  duration: 250,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)', // var(--ease-signature)
  sideEffects: ({ dragOverlay, active }) => {
    dragOverlay.node.classList.add('aito-card-dropping');
    active.node.style.opacity = '0';
    return () => {
      active.node.style.opacity = '';
    };
  },
};

interface MoveVariables {
  id: number;
  column: ColumnId;
  position: number;
  previous: AitoProject[] | undefined;
}

function TrashModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const trashQuery = useQuery({ queryKey: ['aito-trash'], queryFn: api.getAitoTrash });

  const restoreMutation = useMutation({
    mutationFn: (id: number) => api.restoreAitoProject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      queryClient.invalidateQueries({ queryKey: ['aito-trash'] });
      showToast(t('aito.restored'));
    },
    onError: () => {
      showToast(t('aito.restoreFailed'), 'error');
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const projects = trashQuery.data ?? [];

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 animate-overlay-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-bambu-dark-secondary rounded-xl w-full max-w-lg border border-bambu-dark-tertiary flex flex-col max-h-[calc(100vh-2rem)] animate-modal-in">
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between flex-shrink-0">
          <h2 className="text-lg font-semibold text-white">{t('aito.trashTitle')}</h2>
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={onClose}
            className="p-1 -m-1 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          {projects.length === 0 ? (
            <div className="text-center py-8">
              <Trash2 className="w-8 h-8 text-bambu-gray mx-auto mb-2 opacity-40" />
              <p className="text-sm text-bambu-gray">{t('aito.trashEmpty')}</p>
            </div>
          ) : (
            <div className="space-y-2 stagger-children">
              {projects.map((project) => (
                <div
                  key={project.id}
                  className="animate-rise flex items-center gap-3 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary/60 p-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-bambu-gray tabular-nums">#{project.id}</span>
                      {project.client_name && (
                        <span className="text-sm font-medium text-white truncate">{project.client_name}</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm text-bambu-gray whitespace-pre-wrap break-words line-clamp-2">
                      {project.description}
                    </p>
                    <p className="mt-1 text-xs text-bambu-gray">
                      {t('aito.deletedOn', { date: formatElapsedTime(project.updated_at, t) })}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => restoreMutation.mutate(project.id)}
                    disabled={restoreMutation.isPending && restoreMutation.variables === project.id}
                  >
                    {t('aito.restore')}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function AitoPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const aitoQuery = useQuery({ queryKey: ['aito-projects'], queryFn: api.getAitoProjects });

  const [board, setBoard] = useState<Board>(emptyBoard);
  const [showModal, setShowModal] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [allowedDropColumns, setAllowedDropColumns] = useState<ColumnId[] | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const { open: openCard, close: closeCard } = useCardMorph(setExpandedId);

  const expandedProject = useMemo(
    () => (expandedId !== null ? (aitoQuery.data ?? []).find((p) => p.id === expandedId) ?? null : null),
    [expandedId, aitoQuery.data],
  );

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
    if (!aitoQuery.data) return;
    if (activeId !== null) return;
    if (pendingMoves.current > 0) return;
    setBoard(buildBoard(aitoQuery.data));
  }, [aitoQuery.data, activeId, syncGeneration]);

  // One-time migration of the pre-Task-7 localStorage board: only runs when
  // the backend board is confirmed empty, and only once per mount. Failures
  // (network, bad JSON) leave the localStorage key in place so the next
  // visit retries.
  const migrationAttempted = useRef(false);
  useEffect(() => {
    if (aitoQuery.isError) return;
    if (!aitoQuery.data || aitoQuery.data.length !== 0) return;
    if (migrationAttempted.current) return;
    migrationAttempted.current = true;

    (async () => {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as LegacyBoard;
        const projects: { description: string; column: ColumnId; position: number }[] = [];
        for (const col of COLUMN_IDS) {
          const items = parsed[col];
          if (!Array.isArray(items)) continue;
          items.forEach((item, index) => {
            if (item && typeof item.description === 'string') {
              projects.push({ description: item.description, column: col, position: index });
            }
          });
        }
        if (projects.length === 0) {
          localStorage.removeItem(STORAGE_KEY);
          return;
        }
        await api.importAitoProjects({ projects });
        localStorage.removeItem(STORAGE_KEY);
        queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      } catch (err) {
        // A 409 (board not empty — another device already migrated, or
        // everything is in the trash) is permanent: retrying forever is
        // wrong, so drop the key. Other failures (network, bad JSON) keep
        // it so the next visit retries.
        if (err instanceof ApiError && err.status === 409) {
          localStorage.removeItem(STORAGE_KEY);
        }
      }
    })();
  }, [aitoQuery.data, aitoQuery.isError, queryClient]);

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

  /** Push edited contact details back to Zoho after the card exists.
   *
   *  Deliberately not awaited by the create mutation: the board is the job and
   *  a Zoho outage must not cost the user their card. The default walk-in
   *  contact is skipped entirely — it is shared by every passing customer and
   *  carries live transaction history. Fields the user never edited are skipped
   *  too, so creating a project never silently reformats a stored number. */
  const syncClientToZoho = async (draft: ClientDraft) => {
    if (draft.isDefault) return;
    if (!draft.touched.phone && !draft.touched.email) return;
    try {
      await api.updateZohoContact(draft.id, {
        ...(draft.touched.phone
          ? { phone: formatPhone(draft), phone_field: draft.original.phoneField }
          : {}),
        ...(draft.touched.email ? { email: draft.email.trim() } : {}),
      });
    } catch {
      showToast(t('aito.clientSyncFailed'), 'warning');
    }
  };

  const createMutation = useMutation({
    mutationFn: ({ description, draft, tasks }: { description: string; draft: ClientDraft; tasks: TaskDraft[] }) =>
      api.createAitoProject({
        description,
        client_id: draft.id,
        client_name: draft.name,
        client_phone: formatPhone(draft) || null,
        client_email: draft.email.trim() || null,
        client_is_company: draft.isCompany,
        tasks: tasks.map(taskDraftToTaskCreate),
      }),
    onSuccess: (_data, { draft }) => {
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      setShowModal(false);
      void syncClientToZoho(draft);
    },
    onError: () => {
      showToast(t('aito.createFailed'), 'error');
    },
  });

  /** Import posts through the same create endpoint as a manual card, so the
   *  board's ordering, defaults and landing column all behave identically —
   *  the only difference is the quote snapshot riding along. Nothing is
   *  written back to Zoho. */
  const importMutation = useMutation({
    mutationFn: ({ description, preview }: { description: string; preview: ZohoQuotePreview }) =>
      api.createAitoProject({
        description,
        client_id: preview.client.id,
        client_name: preview.client.name,
        client_phone: preview.client.phone,
        client_email: preview.client.email,
        client_is_company: preview.client.is_company,
        tasks: preview.tasks,
        quote_id: preview.quote.id,
        quote_number: preview.quote.number,
        quote_date: preview.quote.date,
        quote_total: preview.quote.total,
        quote_url: preview.quote.url,
        quote_salesperson: preview.quote.salesperson,
        quote_status: preview.quote.status,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      setShowImport(false);
    },
    onError: () => {
      showToast(t('aito.createFailed'), 'error');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteAitoProject(id),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      queryClient.invalidateQueries({ queryKey: ['aito-trash'] });
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

  const totalCount = COLUMN_IDS.reduce((sum, col) => sum + board[col].length, 0);

  const activeProject = useMemo(
    () => (activeId !== null ? COLUMN_IDS.flatMap((col) => board[col]).find((p) => p.id === activeId) ?? null : null),
    [activeId, board],
  );

  const reducedMotion = useMemo(() => prefersReducedMotion(), []);

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

  const createProject = (description: string, draft: ClientDraft, tasks: TaskDraft[]) => {
    createMutation.mutate({ description, draft, tasks });
  };

  // While dragging, highlight the column currently holding the active card
  // (dragOver moves it live, so this is always the drop destination).
  const dropTarget = activeId !== null ? findColumn(board, activeId) : undefined;

  return (
    <div className="p-4 md:p-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 animate-rise-lg vt-page-title">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <Kanban className="w-7 h-7 text-bambu-green" />
            {t('aito.title')}
          </h1>
          <p className="text-bambu-gray mt-1">{t('aito.subtitle')}</p>
        </div>
        <div className="flex gap-2 sm:w-auto w-full">
          <Button variant="secondary" onClick={() => setShowTrash(true)} className="flex-1 sm:flex-none">
            <Trash2 className="w-4 h-4 mr-2" />
            {t('aito.trash')}
          </Button>
          <Button variant="secondary" onClick={() => setShowImport(true)} className="flex-1 sm:flex-none">
            <FileInput className="w-4 h-4 mr-2" />
            {t('aito.importQuote')}
          </Button>
          <Button onClick={() => setShowModal(true)} className="flex-1 sm:flex-none">
            <Plus className="w-4 h-4 mr-2" />
            {t('aito.newProject')}
          </Button>
        </div>
      </div>

      {/* Error state */}
      {aitoQuery.isError && (
        <div className="text-center py-8 animate-rise">
          <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <p className="text-white font-medium">{t('aito.loadFailed')}</p>
          <Button variant="secondary" onClick={() => aitoQuery.refetch()} className="mt-4 mx-auto">
            {t('common.retry')}
          </Button>
        </div>
      )}

      {/* Empty state */}
      {!aitoQuery.isError && totalCount === 0 && (
        <div className="text-center py-8 animate-rise">
          <Kanban className="w-10 h-10 text-bambu-gray mx-auto mb-3" />
          <p className="text-white font-medium">{t('aito.emptyTitle')}</p>
          <p className="text-sm text-bambu-gray mt-1">{t('aito.emptyHint')}</p>
        </div>
      )}

      {/* Board */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={() => {
          setActiveId(null);
          setAllowedDropColumns(null);
          dragOriginColumnRef.current = null;
          // A cancelled drag (e.g. Escape) can leave a cross-column dragOver
          // relocation applied locally with nothing persisted — resync.
          // Skipped while a move is pending — see onSettled for why.
          if (pendingMoves.current === 0) {
            queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
          }
        }}
      >
        <div className="flex gap-4 items-stretch overflow-x-auto pb-4 stagger-parents">
          {COLUMNS.map((column) => (
            <div key={column.id} className="animate-rise-lg flex flex-shrink-0">
              <BoardColumn
                column={column}
                projects={board[column.id]}
                isDropTarget={dropTarget === column.id}
                onDeleteCard={(id) => deleteMutation.mutate(id)}
                onExpandCard={openCard}
                transitionConfig={reducedMotion ? null : SORTABLE_TRANSITION}
                shouldAnimateIn={shouldAnimateIn}
                dropDisabled={allowedDropColumns !== null && !allowedDropColumns.includes(column.id)}
              />
            </div>
          ))}
        </div>

        <DragOverlay dropAnimation={reducedMotion ? null : DROP_ANIMATION}>
          {activeProject ? <CardView project={activeProject} overlay /> : null}
        </DragOverlay>
      </DndContext>

      {showModal && <NewProjectModal onClose={() => setShowModal(false)} onCreate={createProject} />}

      {showImport && (
        <ImportQuoteModal
          onClose={() => setShowImport(false)}
          onImport={(payload) => importMutation.mutate(payload)}
          submitting={importMutation.isPending}
        />
      )}

      {showTrash && <TrashModal onClose={() => setShowTrash(false)} />}

      {expandedProject && (
        <ProjectDetailPanel project={expandedProject} onClose={() => closeCard(expandedProject.id)} />
      )}
    </div>
  );
}
