import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  DragOverlay,
  useDroppable,
  pointerWithin,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Plus, X, Building2, FileText, Pencil, Phone, Clock, Check, Camera, CircleCheck, FilePlus2 } from 'lucide-react';
import { kanbanApi, type KanbanCardResponse } from '../api/client';
import { formatRelativeTime } from '../utils/date';

// ── Data model ──────────────────────────────────────────────────────────────

interface CardFormData {
  title: string;
  quote_id: string;
  quote_name: string;
  client_id: string;
  client_name: string;
  client_phone: string;
  quantity: number;
  is_approved: boolean;
}

const COLUMNS = [
  'backlog',
  'scan',
  'todo',
  'to-print',
  'review',
  'pick-up',
  'to-ship',
  'done',
] as const;

type ColumnId = (typeof COLUMNS)[number];

const COLUMN_LABELS: Record<ColumnId, string> = {
  backlog: 'Backlog',
  scan: 'Scan',
  todo: 'Todo',
  'to-print': 'To Print',
  review: 'Check & Picture',
  'pick-up': 'To Pickup',
  'to-ship': 'To Ship',
  done: 'Done',
};

const EMPTY_FORM: CardFormData = {
  title: '',
  quote_id: '',
  quote_name: '',
  client_id: '',
  client_name: '',
  client_phone: '',
  quantity: 1,
  is_approved: false,
};

const INPUT_CLASS =
  'w-full rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:ring-2 focus:ring-[var(--accent)]';

const QUICK_ACTIONS: { column: ColumnId; target: ColumnId; label: string; icon: typeof Check }[] = [
  { column: 'to-print', target: 'review', label: 'Check & Picture', icon: Check },
  { column: 'review', target: 'pick-up', label: 'To Pickup', icon: Camera },
];

// ── Form fields (shared between add form & edit modal) ──────────────────────

interface FormFieldProps {
  form: CardFormData;
  onChange: (patch: Partial<CardFormData>) => void;
  onSubmit: () => void;
  onCancel: () => void;
  titleRef?: React.RefObject<HTMLInputElement | null>;
}

function CardFormFields({ form, onChange, onSubmit, onCancel, titleRef }: FormFieldProps) {
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onCancel();
  };

  const handleLastKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') onSubmit();
    if (e.key === 'Escape') onCancel();
  };

  return (
    <>
      <input ref={titleRef} type="text" value={form.title} onChange={(e) => onChange({ title: e.target.value })} onKeyDown={handleKey} placeholder="Card title…" className={INPUT_CLASS} />
      <input type="text" value={form.quote_name} onChange={(e) => onChange({ quote_name: e.target.value })} onKeyDown={handleKey} placeholder="Quote name (e.g. DEV26-1904)" className={INPUT_CLASS} />
      <input type="text" value={form.quote_id} onChange={(e) => onChange({ quote_id: e.target.value })} onKeyDown={handleKey} placeholder="Quote ID (e.g. 66407000007680202)" className={INPUT_CLASS} />
      <input type="text" value={form.client_name} onChange={(e) => onChange({ client_name: e.target.value })} onKeyDown={handleKey} placeholder="Client name (e.g. Tahiti Oil Factory)" className={INPUT_CLASS} />
      <input type="text" value={form.client_id} onChange={(e) => onChange({ client_id: e.target.value })} onKeyDown={handleKey} placeholder="Client ID (number)" className={INPUT_CLASS} />
      <input type="text" value={form.client_phone} onChange={(e) => onChange({ client_phone: e.target.value })} onKeyDown={handleKey} placeholder="Client phone (optional)" className={INPUT_CLASS} />
      <input type="number" min="1" value={form.quantity} onChange={(e) => onChange({ quantity: parseInt(e.target.value) || 1 })} onKeyDown={handleLastKey} placeholder="Quantity" className={INPUT_CLASS} />
    </>
  );
}

// ── Edit modal ──────────────────────────────────────────────────────────────

function EditCardModal({
  card,
  onSave,
  onClose,
}: {
  card: KanbanCardResponse;
  onSave: (id: number, data: CardFormData) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<CardFormData>({
    title: card.title,
    quote_name: card.quote_name,
    quote_id: card.quote_id,
    client_name: card.client_name,
    client_id: card.client_id,
    client_phone: card.client_phone,
    quantity: card.quantity,
    is_approved: card.is_approved,
  });

  const updateForm = (patch: Partial<CardFormData>) => setForm((f) => ({ ...f, ...patch }));

  const handleSave = () => {
    const t = form.title.trim();
    const qn = form.quote_name.trim();
    const qi = form.quote_id.trim();
    const cn = form.client_name.trim();
    const ci = form.client_id.trim();
    if (t && qn && qi && cn && ci) {
      onSave(card.id, {
        title: t,
        quote_name: qn,
        quote_id: qi,
        client_name: cn,
        client_id: ci,
        client_phone: form.client_phone.trim(),
        quantity: form.quantity,
        is_approved: form.is_approved,
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="mx-4 flex w-full max-w-md flex-col gap-3 rounded-xl bg-[var(--bg-secondary)] p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Edit card</h3>
        <CardFormFields form={form} onChange={updateForm} onSubmit={handleSave} onCancel={onClose} />
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.is_approved}
            onChange={(e) => updateForm({ is_approved: e.target.checked })}
            className="h-4 w-4 rounded border-[var(--text-muted)] accent-emerald-500"
          />
          <span className="text-xs font-medium text-[var(--text-muted)]">Approved</span>
        </label>
        <div className="flex gap-2">
          <button onClick={handleSave} className="flex-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-light)]">
            Save
          </button>
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)]">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Card content (shared between card & overlay) ────────────────────────────

function CardContent({ card }: { card: KanbanCardResponse }) {
  return (
    <>
      <p className="break-words text-sm font-medium text-[var(--text-primary)]">
        {card.title}
      </p>
      <div className="mt-2 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <FileText className="h-3 w-3 shrink-0" />
          <a
            href={`https://books.zoho.eu/app/20065959772#/quotes/${card.quote_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate font-medium text-[var(--accent)] hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {card.quote_name}
          </a>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <Building2 className="h-3 w-3 shrink-0" />
          <span className="truncate">{card.client_name}</span>
          {card.client_phone && (
            <>
              <span className="opacity-40">·</span>
              <Phone className="h-3 w-3 shrink-0" />
              <span className="truncate">{card.client_phone}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <Clock className="h-3 w-3 shrink-0" />
          <span className="truncate">Created {formatRelativeTime(card.created_at)}</span>
        </div>
      </div>
    </>
  );
}

// ── Sortable card ───────────────────────────────────────────────────────────

function SortableCard({
  card,
  onDelete,
  onEdit,
  onQuickMove,
  onFinish,
}: {
  card: KanbanCardResponse;
  onDelete: (id: number) => void;
  onEdit: (card: KanbanCardResponse) => void;
  onQuickMove: (id: number, targetColumn: ColumnId) => void;
  onFinish: (id: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const quickAction = QUICK_ACTIONS.find((a) => a.column === card.column);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative cursor-grab rounded-lg border p-3 shadow-sm transition-colors active:cursor-grabbing ${
        card.is_approved ? 'border-transparent hover:border-[var(--accent)]/30' : 'border-red-500/30'
      } bg-[var(--bg-tertiary)]`}
      {...attributes}
      {...listeners}
    >
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {card.state !== 'finished' && (
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(card); }}
            className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--accent)]"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(card.id); }}
          className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-red-400"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      <CardContent card={card} />

      {card.column === 'todo' && (
        <button
          onClick={(e) => { e.stopPropagation(); }}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-500"
        >
          <FilePlus2 className="h-4 w-4" />
          Add gcode
        </button>
      )}

      {quickAction && (
        <div className="mt-2 flex justify-end">
          <button
            onClick={(e) => { e.stopPropagation(); onQuickMove(card.id, quickAction.target); }}
            className="flex items-center gap-1 rounded-md bg-[var(--accent)] px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-light)]"
          >
            <quickAction.icon className="h-3 w-3" />
            {quickAction.label}
          </button>
        </div>
      )}

      {card.column === 'pick-up' && card.state !== 'finished' && (
        <div className="mt-2 flex justify-end">
          <button
            onClick={(e) => { e.stopPropagation(); onFinish(card.id); }}
            className="flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-500"
          >
            <CircleCheck className="h-3 w-3" />
            Finish
          </button>
        </div>
      )}

      {card.state === 'finished' && (
        <div className="mt-2 flex justify-end">
          <span className="flex items-center gap-1 rounded-md bg-emerald-600/20 px-2 py-1 text-xs font-medium text-emerald-400">
            <CircleCheck className="h-3 w-3" />
            Finished
          </span>
        </div>
      )}
    </div>
  );
}

function CardOverlay({ card }: { card: KanbanCardResponse }) {
  return (
    <div className="rounded-lg border border-[var(--accent)] bg-[var(--bg-tertiary)] p-3 shadow-xl">
      <CardContent card={card} />
    </div>
  );
}

// ── Column ──────────────────────────────────────────────────────────────────

function KanbanColumn({
  columnId,
  cards,
  onAdd,
  onDelete,
  onEdit,
  onQuickMove,
  onFinish,
}: {
  columnId: ColumnId;
  cards: KanbanCardResponse[];
  onAdd: (columnId: ColumnId, data: CardFormData) => void;
  onDelete: (id: number) => void;
  onEdit: (card: KanbanCardResponse) => void;
  onQuickMove: (id: number, targetColumn: ColumnId) => void;
  onFinish: (id: number) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnId });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<CardFormData>(EMPTY_FORM);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding) titleRef.current?.focus();
  }, [adding]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setAdding(false);
  };

  const handleSubmit = () => {
    const t = form.title.trim();
    const qi = form.quote_id.trim();
    const qn = form.quote_name.trim();
    const ci = form.client_id.trim();
    const cn = form.client_name.trim();
    if (t && qi && qn && ci && cn) {
      onAdd(columnId, {
        title: t,
        quote_id: qi,
        quote_name: qn,
        client_id: ci,
        client_name: cn,
        client_phone: form.client_phone.trim(),
        quantity: form.quantity,
        is_approved: form.is_approved,
      });
    }
    resetForm();
  };

  return (
    <div
      className={`flex w-[280px] shrink-0 flex-col rounded-xl bg-[var(--bg-secondary)] transition-colors ${
        isOver ? 'ring-2 ring-[var(--accent)]' : ''
      }`}
    >
      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            {COLUMN_LABELS[columnId]}
          </h3>
          <span className="rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
            {cards.length}
          </span>
        </div>
        <button
          onClick={() => setAdding(true)}
          className="rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <div ref={setNodeRef} className="flex min-h-[60px] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {cards.map((card) => (
            <SortableCard key={card.id} card={card} onDelete={onDelete} onEdit={onEdit} onQuickMove={onQuickMove} onFinish={onFinish} />
          ))}
        </SortableContext>
      </div>

      {adding && (
        <div className="flex flex-col gap-2 border-t border-[var(--bg-tertiary)] p-2">
          <CardFormFields form={form} onChange={(patch) => setForm((f) => ({ ...f, ...patch }))} onSubmit={handleSubmit} onCancel={resetForm} titleRef={titleRef} />
          <div className="flex gap-2">
            <button onClick={handleSubmit} className="flex-1 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-light)]">
              Add
            </button>
            <button onClick={resetForm} className="rounded-lg px-3 py-1.5 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)]">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

export function TodoPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // Local state for optimistic drag-and-drop
  const [localCards, setLocalCards] = useState<KanbanCardResponse[] | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [editingCard, setEditingCard] = useState<KanbanCardResponse | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const { data: serverCards = [] } = useQuery({
    queryKey: ['kanban-cards'],
    queryFn: kanbanApi.getCards,
  });

  // Use local cards during drag, server cards otherwise
  const cards = localCards ?? serverCards;

  const createMutation = useMutation({
    mutationFn: (data: { columnId: string } & CardFormData) =>
      kanbanApi.createCard({ ...data, column: data.columnId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['kanban-cards'] }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: { id: number } & Partial<CardFormData & { column: string; sort_order: number }>) =>
      kanbanApi.updateCard(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['kanban-cards'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: kanbanApi.deleteCard,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['kanban-cards'] }),
  });

  const reorderMutation = useMutation({
    mutationFn: kanbanApi.reorderCards,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['kanban-cards'] }),
  });

  const addCard = (columnId: ColumnId, data: CardFormData) => {
    createMutation.mutate({ columnId, ...data });
  };

  const deleteCard = (id: number) => {
    deleteMutation.mutate(id);
  };

  const editCard = (id: number, data: CardFormData) => {
    updateMutation.mutate({ id, ...data });
    setEditingCard(null);
  };

  const quickMove = (id: number, targetColumn: ColumnId) => {
    updateMutation.mutate({ id, column: targetColumn });
  };

  const finishCard = (id: number) => {
    updateMutation.mutate({ id, column: 'done' });
  };

  // Group and sort cards by column
  const cardsByColumn = COLUMNS.reduce(
    (acc, col) => {
      acc[col] = cards
        .filter((c) => c.column === col)
        .sort((a, b) => a.sort_order - b.sort_order);
      return acc;
    },
    {} as Record<ColumnId, KanbanCardResponse[]>,
  );

  const findColumn = (id: string | number): ColumnId | undefined => {
    const strId = String(id);
    if (COLUMNS.includes(strId as ColumnId)) return strId as ColumnId;
    const card = cards.find((c) => c.id === Number(id));
    return card?.column as ColumnId | undefined;
  };

  const handleDragStart = (event: DragStartEvent) => {
    setLocalCards([...cards]);
    setActiveId(event.active.id as number);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over || !localCards) return;

    const activeCol = findColumn(active.id);
    const overCol = findColumn(over.id);

    if (!activeCol || !overCol || activeCol === overCol) return;

    setLocalCards((prev) => {
      if (!prev) return prev;
      const activeCard = prev.find((c) => c.id === active.id);
      if (!activeCard) return prev;

      const overColCards = prev.filter((c) => c.column === overCol && c.id !== active.id);
      const overCardIndex = overColCards.findIndex((c) => c.id === over.id);

      let newOrder: number;
      if (String(over.id) === overCol) {
        newOrder = overColCards.length > 0 ? Math.max(...overColCards.map((c) => c.sort_order)) + 1 : 0;
      } else if (overCardIndex >= 0) {
        newOrder = overColCards[overCardIndex].sort_order;
      } else {
        newOrder = overColCards.length > 0 ? Math.max(...overColCards.map((c) => c.sort_order)) + 1 : 0;
      }

      return prev.map((c) => {
        if (c.id === active.id) {
          return { ...c, column: overCol, sort_order: newOrder };
        }
        if (c.column === overCol && c.id !== active.id && c.sort_order >= newOrder) {
          return { ...c, sort_order: c.sort_order + 1 };
        }
        return c;
      });
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);

    if (!over || !localCards) {
      setLocalCards(null);
      return;
    }

    const activeCol = findColumn(active.id);
    const overCol = findColumn(over.id);

    if (!activeCol || !overCol) {
      setLocalCards(null);
      return;
    }

    let finalCards = localCards;

    // Same column reorder
    if (activeCol === overCol && active.id !== over.id) {
      const colCards = localCards
        .filter((c) => c.column === activeCol)
        .sort((a, b) => a.sort_order - b.sort_order);

      const oldIndex = colCards.findIndex((c) => c.id === active.id);
      const newIndex = colCards.findIndex((c) => c.id === over.id);

      if (oldIndex !== -1 && newIndex !== -1) {
        const reordered = arrayMove(colCards, oldIndex, newIndex);
        const reorderedIds = new Map(reordered.map((c, i) => [c.id, i]));

        finalCards = localCards.map((c) => {
          if (c.column === activeCol && reorderedIds.has(c.id)) {
            return { ...c, sort_order: reorderedIds.get(c.id)! };
          }
          return c;
        });
        setLocalCards(finalCards);
      }
    }

    // Persist: find the card's new column and reorder the column
    const movedCard = finalCards.find((c) => c.id === active.id);
    if (movedCard) {
      const columnCards = finalCards
        .filter((c) => c.column === movedCard.column)
        .sort((a, b) => a.sort_order - b.sort_order);

      const originalCard = serverCards.find((c) => c.id === active.id);
      const columnChanged = originalCard && originalCard.column !== movedCard.column;
      const orderChanged = columnCards.map((c) => c.id).join(',') !==
        serverCards
          .filter((c) => c.column === movedCard.column)
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((c) => c.id)
          .join(',');

      if (columnChanged) {
        updateMutation.mutate(
          { id: movedCard.id, column: movedCard.column },
          { onSettled: () => {
            // After column change, reorder within the new column
            reorderMutation.mutate(columnCards.map((c) => c.id), {
              onSettled: () => setLocalCards(null),
            });
          }},
        );
      } else if (orderChanged) {
        reorderMutation.mutate(columnCards.map((c) => c.id), {
          onSettled: () => setLocalCards(null),
        });
      } else {
        setLocalCards(null);
      }
    } else {
      setLocalCards(null);
    }
  };

  const activeCard = activeId != null ? cards.find((c) => c.id === activeId) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-6 pt-6 pb-4">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">
          {t('nav.todo', 'Todo')}
        </h1>
      </div>

      <div className="flex-1 overflow-x-auto overflow-y-hidden px-6 pb-6">
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="flex h-full gap-4">
            {COLUMNS.map((col) => (
              <KanbanColumn
                key={col}
                columnId={col}
                cards={cardsByColumn[col]}
                onAdd={addCard}
                onDelete={deleteCard}
                onEdit={setEditingCard}
                onQuickMove={quickMove}
                onFinish={finishCard}
              />
            ))}
          </div>
          <DragOverlay>
            {activeCard ? <CardOverlay card={activeCard} /> : null}
          </DragOverlay>
        </DndContext>
      </div>

      {editingCard && (
        <EditCardModal
          card={editingCard}
          onSave={editCard}
          onClose={() => setEditingCard(null)}
        />
      )}
    </div>
  );
}
