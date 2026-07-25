import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, Kanban, Plus, Trash2, X } from 'lucide-react';
import { Button } from '../components/Button';
import { inputCls, labelCls } from '../components/formStyles';
import { ClientCombobox, type SelectedClient } from '../components/aito/ClientCombobox';
import { api, ApiError, type AitoColumnId, type AitoProject } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { formatElapsedTime, parseUTCDate } from '../utils/date';

type ColumnId = AitoColumnId;

type Board = Record<ColumnId, AitoProject[]>;

// Shape of the pre-Task-7 localStorage board, kept only for the one-time
// migration into the DB-backed board.
interface LegacyProject {
  id?: string;
  description: string;
  createdAt?: string;
}
type LegacyBoard = Partial<Record<ColumnId, LegacyProject[]>>;

// Stage accents follow the pipeline temperature: quote (cool) → modeling →
// printing (hot) → finished (brand green, the app's "done" color).
const COLUMNS: { id: ColumnId; labelKey: string; dot: string; ring: string }[] = [
  { id: 'devis', labelKey: 'aito.columns.devis', dot: 'bg-sky-400', ring: 'ring-sky-400/30' },
  { id: 'model', labelKey: 'aito.columns.model', dot: 'bg-violet-400', ring: 'ring-violet-400/30' },
  { id: 'print', labelKey: 'aito.columns.print', dot: 'bg-orange-400', ring: 'ring-orange-400/30' },
  { id: 'finish', labelKey: 'aito.columns.finish', dot: 'bg-bambu-green', ring: 'ring-bambu-green/30' },
];

const COLUMN_IDS = COLUMNS.map((c) => c.id);
const STORAGE_KEY = 'aito-board-v1';

const emptyBoard = (): Board => ({ devis: [], model: [], print: [], finish: [] });

interface CardViewProps {
  project: AitoProject;
  overlay?: boolean;
  onDelete?: () => void;
}

// Hold-to-delete progress ring geometry: a small circle traced around the
// trash icon, animated via stroke-dashoffset instead of requestAnimationFrame
// so the browser's own CSS transition timeline drives the fill.
const HOLD_RADIUS = 9;
const HOLD_CIRCUMFERENCE = 2 * Math.PI * HOLD_RADIUS;
const HOLD_DURATION_MS = 2000;
// A press released before this threshold counts as a "tap" and surfaces the
// hold hint; anything longer (but still short of completing) is treated as
// an intentional-but-abandoned hold and cancels silently.
const HOLD_HINT_THRESHOLD_MS = 400;
const HOLD_HINT_VISIBLE_MS = 1600;

// Trash2 button that requires a 2s pointer/keyboard hold to fire delete,
// replacing the old ConfirmModal flow. A short press instead shows a
// "hold to delete" hint popover. See task-14-brief.md for the full spec.
function DeleteHoldButton({
  onDelete,
  label,
  hint,
}: {
  onDelete: () => void;
  label: string;
  hint: string;
}) {
  const [holding, setHolding] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStartRef = useRef(0);

  const clearHoldTimer = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const startHold = () => {
    if (holdTimerRef.current) return; // already holding (e.g. key repeat before guard)
    pressStartRef.current = Date.now();
    setHolding(true);
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      setHolding(false);
      onDelete();
    }, HOLD_DURATION_MS);
  };

  const cancelHold = () => {
    if (!holdTimerRef.current && !holding) return;
    clearHoldTimer();
    setHolding(false);
    if (Date.now() - pressStartRef.current < HOLD_HINT_THRESHOLD_MS) {
      setShowHint(true);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      hintTimerRef.current = setTimeout(() => setShowHint(false), HOLD_HINT_VISIBLE_MS);
    }
  };

  useEffect(
    () => () => {
      clearHoldTimer();
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    },
    [],
  );

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={label}
        title={hint}
        onPointerDown={(e) => {
          e.stopPropagation();
          startHold();
        }}
        onPointerUp={(e) => {
          e.stopPropagation();
          cancelHold();
        }}
        onPointerLeave={(e) => {
          e.stopPropagation();
          cancelHold();
        }}
        onPointerCancel={(e) => {
          e.stopPropagation();
          cancelHold();
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.stopPropagation();
          if (!e.repeat) {
            e.preventDefault();
            startHold();
          }
        }}
        onKeyUp={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.stopPropagation();
          cancelHold();
        }}
        className={`relative p-1 -m-1 rounded-md text-bambu-gray hover:text-red-400 hover:bg-red-400/10 transition-[color,background-color,opacity] duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/40 ${
          holding ? 'opacity-100 text-red-400' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
        }`}
      >
        <svg className="absolute inset-0 -rotate-90 w-full h-full" viewBox="0 0 24 24" aria-hidden="true">
          <circle
            cx="12"
            cy="12"
            r={HOLD_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray={HOLD_CIRCUMFERENCE}
            strokeDashoffset={holding ? 0 : HOLD_CIRCUMFERENCE}
            className={
              holding
                ? 'transition-[stroke-dashoffset] duration-[2000ms] ease-linear motion-reduce:duration-200'
                : 'transition-none'
            }
          />
        </svg>
        <Trash2 className="relative w-3.5 h-3.5" />
      </button>
      {showHint && (
        <div className="absolute bottom-full right-0 mb-1 whitespace-nowrap rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1 text-xs text-white shadow-lg animate-fade-in">
          {hint}
        </div>
      )}
    </div>
  );
}

// Presentational card, shared by the in-column sortable wrapper and the
// DragOverlay clone (which must not carry sortable listeners/transform).
function CardView({ project, overlay = false, onDelete }: CardViewProps) {
  const { t, i18n } = useTranslation();
  const created = parseUTCDate(project.created_at);
  const updated = parseUTCDate(project.updated_at);
  const elapsed = formatElapsedTime(project.created_at, t);
  const dateTitle = [
    created && t('aito.created', { date: created.toLocaleString(i18n.language) }),
    updated && t('aito.updated', { date: updated.toLocaleString(i18n.language) }),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      className={`group relative rounded-xl border bg-bambu-dark-secondary p-3 select-none ${
        overlay
          ? 'rotate-2 scale-[1.03] border-bambu-green/40 shadow-2xl cursor-grabbing'
          : 'border-bambu-dark-tertiary card-shadow cursor-grab active:cursor-grabbing transition-[border-color,box-shadow] duration-100 hover:border-bambu-green/40 hover:shadow-lg'
      }`}
    >
      <span className="text-xs text-bambu-gray tabular-nums">#{project.id}</span>
      {project.client_name && (
        <div className="mt-1">
          <p className="text-sm font-medium text-white truncate">{project.client_name}</p>
          {project.client_phone && (
            <a
              href={`tel:${project.client_phone}`}
              onPointerDown={(e) => e.stopPropagation()}
              className="text-xs text-bambu-gray hover:text-bambu-green"
            >
              {project.client_phone}
            </a>
          )}
        </div>
      )}
      <p className="mt-1 text-sm text-white whitespace-pre-wrap break-words line-clamp-5">{project.description}</p>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-bambu-gray" title={dateTitle}>
          {elapsed}
        </span>
        {onDelete && (
          <DeleteHoldButton onDelete={onDelete} label={t('aito.deleteTitle')} hint={t('aito.holdToDelete')} />
        )}
      </div>
    </div>
  );
}

function SortableCard({ project, onDelete }: { project: AitoProject; onDelete: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      className={`touch-none animate-rise ${isDragging ? 'opacity-30' : ''}`}
    >
      <CardView project={project} onDelete={onDelete} />
    </div>
  );
}

interface ColumnProps {
  column: (typeof COLUMNS)[number];
  projects: AitoProject[];
  isDropTarget: boolean;
  onDeleteCard: (id: number) => void;
}

function BoardColumn({ column, projects, isDropTarget, onDeleteCard }: ColumnProps) {
  const { t } = useTranslation();
  const { setNodeRef } = useDroppable({ id: column.id });

  return (
    <div
      className={`w-72 sm:w-80 flex-shrink-0 flex flex-col rounded-xl bg-bambu-dark-secondary/40 border transition-[border-color,box-shadow] duration-150 ${
        isDropTarget ? `border-transparent ring-2 ${column.ring}` : 'border-bambu-dark-tertiary'
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-bambu-dark-tertiary/60">
        <span className={`w-2 h-2 rounded-full ${column.dot}`} />
        <h2 className="text-sm font-semibold text-white flex-1 truncate">{t(column.labelKey)}</h2>
        <span className="min-w-[1.5rem] px-1.5 py-0.5 text-center text-xs font-medium text-bambu-gray-light bg-bambu-dark-tertiary rounded-full tabular-nums">
          {projects.length}
        </span>
      </div>

      <SortableContext items={projects.map((p) => p.id)} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="flex-1 flex flex-col gap-2 p-2 min-h-[10rem] overflow-y-auto">
          {projects.map((project) => (
            <SortableCard key={project.id} project={project} onDelete={() => onDeleteCard(project.id)} />
          ))}
          {projects.length === 0 && (
            <div className="flex-1 min-h-[8rem] rounded-lg border border-dashed border-bambu-dark-tertiary/80" />
          )}
        </div>
      </SortableContext>
    </div>
  );
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

  // Keeps the local drag-friendly board in sync with the server, but never
  // while a drag is in flight — a background refetch mid-drag would yank
  // the card out from under the pointer.
  useEffect(() => {
    if (!aitoQuery.data) return;
    if (activeId !== null) return;
    const next = emptyBoard();
    for (const project of aitoQuery.data) {
      if (COLUMN_IDS.includes(project.column)) next[project.column].push(project);
    }
    for (const col of COLUMN_IDS) next[col].sort((a, b) => a.position - b.position);
    setBoard(next);
  }, [aitoQuery.data, activeId]);

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
    mutationFn: ({ id, column, position }: { id: number; column: ColumnId; position: number; board: Board }) =>
      api.moveAitoProject(id, { column, position }),
    // Optimistically write the already-applied local board state into the
    // query cache so the sync effect's post-drop re-run (triggered by
    // handleDragEnd clearing activeId) rebuilds from the NEW layout instead
    // of the stale pre-move cache — otherwise the dropped card snaps back
    // until the PATCH + refetch land. The board snapshot travels in the
    // mutation variables (not the outer `board` closure) because setBoard()
    // and mutate() are both called synchronously in handleDragEnd, before
    // React re-renders with the reordered state.
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: ['aito-projects'] });
      const previous = queryClient.getQueryData<AitoProject[]>(['aito-projects']);
      const optimistic = COLUMN_IDS.flatMap((col) =>
        variables.board[col].map((project, index) => ({ ...project, column: col, position: index })),
      );
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], optimistic);
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['aito-projects'], context.previous);
      }
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      showToast(t('aito.moveFailed'), 'error');
    },
    onSettled: () => {
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

  const findColumn = (id: string | number): ColumnId | undefined => {
    if (COLUMN_IDS.includes(id as ColumnId)) return id as ColumnId;
    return COLUMN_IDS.find((col) => board[col].some((p) => p.id === id));
  };

  // Tracks the column the card started in so dragEnd can tell a real
  // cross-column relocation (already applied live by dragOver) apart from a
  // plain click-drag-release back into the same slot — the latter must not
  // fire a PATCH.
  const dragOriginColumnRef = useRef<ColumnId | null>(null);

  const handleDragStart = ({ active }: DragStartEvent) => {
    setActiveId(active.id as number);
    dragOriginColumnRef.current = findColumn(active.id) ?? null;
  };

  // Cross-column moves happen live during dragOver so the destination column
  // opens a slot under the pointer (Trello-style), not only on drop.
  const handleDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    const from = findColumn(active.id);
    const to = findColumn(over.id);
    if (!from || !to || from === to) return;

    setBoard((prev) => {
      const moving = prev[from].find((p) => p.id === active.id);
      if (!moving) return prev;
      const overIndex = prev[to].findIndex((p) => p.id === over.id);
      const insertAt = overIndex >= 0 ? overIndex : prev[to].length;
      const next = { ...prev };
      next[from] = prev[from].filter((p) => p.id !== active.id);
      next[to] = [...prev[to].slice(0, insertAt), moving, ...prev[to].slice(insertAt)];
      return next;
    });
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    const originColumn = dragOriginColumnRef.current;
    dragOriginColumnRef.current = null;

    // Dropped outside any droppable: dragOver may already have relocated the
    // card locally with nothing to persist it, so resync from the server
    // instead of leaving the board desynced.
    if (!over) {
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      return;
    }
    const column = findColumn(active.id);
    if (!column) {
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      return;
    }

    const oldIndex = board[column].findIndex((p) => p.id === active.id);
    const overIndex = board[column].findIndex((p) => p.id === over.id);
    const newIndex = overIndex >= 0 ? overIndex : board[column].length - 1;
    const movedColumns = originColumn !== null && originColumn !== column;

    // Plain click-drag-release back into the same slot: nothing changed, so
    // don't fire a redundant PATCH. A real cross-column relocation (already
    // applied live by dragOver) must still persist even if the index in the
    // destination column happens to match.
    if (!movedColumns && (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex)) {
      return;
    }

    const reordered =
      oldIndex >= 0 && newIndex >= 0 && oldIndex !== newIndex
        ? arrayMove(board[column], oldIndex, newIndex)
        : board[column];
    const nextBoard: Board = reordered !== board[column] ? { ...board, [column]: reordered } : board;
    if (nextBoard !== board) {
      setBoard(nextBoard);
    }

    const position = reordered.findIndex((p) => p.id === active.id);
    if (position < 0) return;
    moveMutation.mutate({ id: active.id as number, column, position, board: nextBoard });
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
  const dropTarget = activeId !== null ? findColumn(activeId) : undefined;

  return (
    <div className="p-4 md:p-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 animate-rise-lg">
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
