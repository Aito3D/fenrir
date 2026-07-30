import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, DragOverlay, MeasuringStrategy, closestCorners, type DropAnimation } from '@dnd-kit/core';
import { AlertTriangle, FileInput, Kanban, Plus, Trash2 } from 'lucide-react';
import { Button } from '../components/Button';
import { CardView } from '../components/aito/CardView';
import { BoardColumn } from '../components/aito/BoardColumn';
import { COLUMNS } from '../components/aito/columns';
import { ImportQuoteModal } from '../components/aito/ImportQuoteModal';
import { NewProjectModal } from '../components/aito/NewProjectModal';
import { ProjectDetailPanel } from '../components/aito/ProjectDetailPanel';
import { TrashModal } from '../components/aito/TrashModal';
import { api, type ZohoQuotePreview } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { formatPhone } from '../utils/clientDraft';
import type { ClientDraft } from '../utils/clientDraft';
import { taskDraftToTaskCreate } from '../utils/taskDraft';
import type { TaskDraft } from '../utils/taskDraft';
import { prefersReducedMotion } from '../utils/motion';
import { useCardMorph } from '../hooks/useCardMorph';
import { useBoardDrag } from '../hooks/useBoardDrag';
import { COLUMN_IDS } from '../utils/aitoBoard';

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

// The board poll exists for exactly one visible thing: CardView's
// "Creating quote…" placeholder (aito.quotePending), which only renders when
// `!quote_number && quote_sync_state === 'pending'` — see CardView.tsx. A
// card that already has a quote number has nothing left for this poll to
// reveal, even if an ordinary task edit re-marks it pending (see
// `_mark_pending_if_ours` in aito.py); polling for it would just be six extra
// full-board GETs after every editing session for a card whose screen never
// changes.
const QUOTE_POLL_INTERVAL_MS = 10_000;
// `pending` is cleared only by the Zoho sync worker, and the worker is
// gated behind `aito_quote_sync_enabled` — a supported operator setting that
// can be off, or Zoho credentials can be pulled entirely. In either case
// nothing will ever clear `pending`, so "it will resolve eventually" is not
// guaranteed and this poll must not run forever. Five minutes is comfortably
// past the worker's own ~60s cadence when it IS running, so a healthy worker
// is never cut off before it resolves.
const QUOTE_POLL_MAX_MS = 5 * 60 * 1000;

export function AitoPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  // Wall-clock deadline for the current poll run, set the moment the
  // predicate first becomes true and cleared the instant it goes false — so a
  // later card that starts a fresh import gets its own full run at the poll
  // rather than inheriting a budget an earlier card already spent. Deadline
  // rather than a tick counter: React Query can re-evaluate `refetchInterval`
  // more than once per actual fetch, which would burn a fixed tick budget
  // faster than real time actually elapses.
  const pollDeadlineRef = useRef<number | null>(null);
  const aitoQuery = useQuery({
    queryKey: ['aito-projects'],
    queryFn: api.getAitoProjects,
    refetchInterval: (query) => {
      const pending = query.state.data?.some(
        (p) => !p.quote_number && p.quote_sync_state === 'pending',
      );
      if (!pending) {
        pollDeadlineRef.current = null;
        return false;
      }
      const now = Date.now();
      pollDeadlineRef.current ??= now + QUOTE_POLL_MAX_MS;
      if (now >= pollDeadlineRef.current) return false;
      return QUOTE_POLL_INTERVAL_MS;
    },
  });

  const [showModal, setShowModal] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const { open: openCard, close: closeCard } = useCardMorph(setExpandedId);

  const expandedProject = useMemo(
    () => (expandedId !== null ? (aitoQuery.data ?? []).find((p) => p.id === expandedId) ?? null : null),
    [expandedId, aitoQuery.data],
  );

  const { board, activeProject, dropTarget, allowedDropColumns, shouldAnimateIn, sensors, dndHandlers } =
    useBoardDrag(aitoQuery.data);

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

  const totalCount = COLUMN_IDS.reduce((sum, col) => sum + board[col].length, 0);

  const reducedMotion = useMemo(() => prefersReducedMotion(), []);

  const createProject = (description: string, draft: ClientDraft, tasks: TaskDraft[]) => {
    createMutation.mutate({ description, draft, tasks });
  };

  return (
    // Full-height page so the columns run the height of the screen and each
    // one scrolls its own cards, instead of every column being as tall as
    // whichever holds the most. Same shape FileManagerPage uses: a hard height
    // from `lg` up, a min-height below it, so a narrow screen still scrolls the
    // page normally rather than squeezing seven columns into a phone.
    <div className="p-4 md:p-8 flex flex-col gap-6 min-h-[calc(100vh-64px)] lg:h-[calc(100vh-64px)]">
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
        {...dndHandlers}
      >
        {/* min-h-0 is what lets this shrink inside the flex column: without it
            a tall column would push the board past the viewport instead of
            scrolling inside itself. */}
        <div className="flex gap-4 items-stretch overflow-x-auto pb-4 stagger-parents flex-1 min-h-0">
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
