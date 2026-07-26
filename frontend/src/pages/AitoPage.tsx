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
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { AlertTriangle, Kanban, Plus, Trash2, X } from 'lucide-react';
import { Button } from '../components/Button';
import { inputCls, labelCls } from '../components/formStyles';
import { CardView } from '../components/aito/CardView';
import { BoardColumn } from '../components/aito/BoardColumn';
import { COLUMNS } from '../components/aito/columns';
import { ClientCombobox, type SelectedClient } from '../components/aito/ClientCombobox';
import { api, ApiError, type AitoProject } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { formatElapsedTime } from '../utils/date';
import {
  COLUMN_IDS,
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

interface MoveVariables {
  id: number;
  column: ColumnId;
  position: number;
  previous: AitoProject[] | undefined;
}

function NewProjectModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (description: string, client: SelectedClient) => void;
}) {
  const { t } = useTranslation();
  const [description, setDescription] = useState('');
  const [client, setClient] = useState<SelectedClient | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSubmit = description.trim().length > 0 && client !== null;

  useEffect(() => {
    textareaRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = () => {
    if (!canSubmit || !client) return;
    onCreate(description.trim(), client);
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 animate-overlay-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-bambu-dark-secondary rounded-xl w-full max-w-md border border-bambu-dark-tertiary flex flex-col max-h-[calc(100vh-2rem)] animate-modal-in">
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-center justify-between flex-shrink-0">
          <h2 className="text-lg font-semibold text-white">{t('aito.modalTitle')}</h2>
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={onClose}
            className="p-1 -m-1 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col flex-1 min-h-0"
        >
          <div className="p-4 overflow-y-auto flex-1 space-y-4">
            <ClientCombobox value={client} onChange={setClient} />
            <div>
              <label htmlFor="aito-description" className={labelCls}>
                {t('aito.productDescription')}
              </label>
              <textarea
                id="aito-description"
                ref={textareaRef}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
                }}
                placeholder={t('aito.descriptionPlaceholder')}
                rows={4}
                required
                className={`${inputCls} resize-none`}
              />
            </div>
          </div>

          <div className="p-4 border-t border-bambu-dark-tertiary flex justify-end gap-2 flex-shrink-0">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              <Plus className="w-4 h-4 mr-2" />
              {t('aito.create')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
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
  const [showTrash, setShowTrash] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);

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
      pendingMoves.current -= 1;
      setSyncGeneration((generation) => generation + 1);
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: { description: string; client_id: string; client_name: string; client_phone?: string | null }) =>
      api.createAitoProject(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      setShowModal(false);
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
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const totalCount = COLUMN_IDS.reduce((sum, col) => sum + board[col].length, 0);

  const activeProject = useMemo(
    () => (activeId !== null ? COLUMN_IDS.flatMap((col) => board[col]).find((p) => p.id === activeId) ?? null : null),
    [activeId, board],
  );

  // Tracks the column the card started in so dragEnd can tell a real
  // cross-column relocation (already applied live by dragOver) apart from a
  // plain click-drag-release back into the same slot — the latter must not
  // fire a PATCH.
  const dragOriginColumnRef = useRef<ColumnId | null>(null);

  const handleDragStart = ({ active }: DragStartEvent) => {
    setActiveId(active.id as number);
    dragOriginColumnRef.current = findColumn(board, active.id) ?? null;
  };

  // Cross-column moves happen live during dragOver so the destination column
  // opens a slot under the pointer (Trello-style), not only on drop.
  const handleDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    setBoard((prev) => applyCrossColumnMove(prev, active.id as number, over.id));
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    const originColumn = dragOriginColumnRef.current;
    dragOriginColumnRef.current = null;

    // Dropped outside any droppable: dragOver may already have relocated the
    // card locally with nothing to persist it, so resync rather than desync.
    if (!over) {
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      return;
    }

    const result = computeMoveTarget(board, active.id as number, over.id, originColumn);
    if (result.kind === 'resync') {
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
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

  const createProject = (description: string, client: SelectedClient) => {
    createMutation.mutate({
      description,
      client_id: client.id,
      client_name: client.name,
      client_phone: client.phone,
    });
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
          dragOriginColumnRef.current = null;
          // A cancelled drag (e.g. Escape) can leave a cross-column dragOver
          // relocation applied locally with nothing persisted — resync.
          queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
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
              />
            </div>
          ))}
        </div>

        <DragOverlay>{activeProject ? <CardView project={activeProject} overlay /> : null}</DragOverlay>
      </DndContext>

      {showModal && <NewProjectModal onClose={() => setShowModal(false)} onCreate={createProject} />}

      {showTrash && <TrashModal onClose={() => setShowTrash(false)} />}
    </div>
  );
}
