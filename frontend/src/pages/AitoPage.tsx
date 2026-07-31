import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, DragOverlay, MeasuringStrategy, closestCorners, type DropAnimation } from '@dnd-kit/core';
import { AlertTriangle, Archive, ArrowLeft, FileInput, Kanban, Plus, Trash2 } from 'lucide-react';
import { Button } from '../components/Button';
import { CardView } from '../components/aito/CardView';
import { BoardColumn } from '../components/aito/BoardColumn';
import { COLUMNS } from '../components/aito/columns';
import { DoneGrid } from '../components/aito/DoneGrid';
import { ImportQuoteModal } from '../components/aito/ImportQuoteModal';
import { NewProjectModal } from '../components/aito/NewProjectModal';
import { ProjectDetailPanel } from '../components/aito/ProjectDetailPanel';
import { TrashModal } from '../components/aito/TrashModal';
import { api, ApiError, type AitoProject, type ZohoQuotePreview } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { formatPhone } from '../utils/clientDraft';
import type { ClientDraft } from '../utils/clientDraft';
import { taskDraftToTaskCreate } from '../utils/taskDraft';
import type { TaskDraft } from '../utils/taskDraft';
import { prefersReducedMotion } from '../utils/motion';
import { useCardMorph } from '../hooks/useCardMorph';
import { useBoardDrag } from '../hooks/useBoardDrag';
import { useBoardSync } from '../hooks/useBoardSync';
import { useOptimisticBoardMutation } from '../hooks/useOptimisticBoardMutation';
import { applyCreate, applyDelete, placeholderProject } from '../utils/aitoOptimistic';
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
// `_mark_pending_if_ours` in aito.py); polling for it would just be up to
// thirty extra full-board GETs (the ~5 minute bound below, at one fetch per
// QUOTE_POLL_INTERVAL_MS) for a card whose screen never changes.
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
  // Wall-clock deadline for the current poll run, cleared the instant no
  // card matches and (re)set whenever a card starts matching that was not
  // matching on the previous evaluation — so a later card that starts a
  // fresh import gets its own full run at the poll rather than being cut off
  // by a budget an earlier, still-stuck card already spent (the deadline is
  // shared, not per-card: a new match resets it for whatever else is still
  // pending too, which is fine — it just means a genuinely new event gives
  // the whole poll another chance). Deadline rather than a tick counter:
  // React Query can re-evaluate `refetchInterval` more than once per actual
  // fetch, which would burn a fixed tick budget faster than real time
  // actually elapses.
  const pollDeadlineRef = useRef<number | null>(null);
  // The matching id set as of the previous `refetchInterval` evaluation —
  // what "not matching on the previous evaluation" above is compared
  // against. Keying off ids (not just a boolean) is what lets a new card
  // reset the deadline even while an old one is still matching too; a plain
  // boolean can only ever go true -> true across that transition and would
  // never notice the new arrival.
  const pollMatchingIdsRef = useRef<Set<number>>(new Set());
  // Shares the module-level counters every optimistic board mutation feeds —
  // see that hook's own doc for why there are two. Only `isIdle` (the
  // `pendingWrites` one) is used here.
  const boardSync = useBoardSync();
  const aitoQuery = useQuery({
    queryKey: ['aito-projects'],
    queryFn: api.getAitoProjects,
    refetchInterval: (query) => {
      // A board write's `onMutate` writes its optimistic value into this
      // same cache entry BEFORE this function is asked to run again (writing
      // to the cache is itself what re-triggers this evaluation — see
      // QueryObserver.onQueryUpdate). A poll tick landing inside that
      // write's [onMutate, onSettled] window would issue a fresh GET that
      // overwrites the optimistic entry with data that predates the write,
      // with no ring and no toast — silent, not merely stale. Skipping here,
      // rather than after computing `matchingIds`, is deliberate: it must
      // leave `pollDeadlineRef`/`pollMatchingIdsRef` exactly as they were, so
      // a skipped tick neither consumes the deadline's budget nor loses the
      // "was this id already matching" state that `hasNewMatch` depends on.
      // The write's own `settle()` invalidates once it finishes, which
      // re-triggers this function and lets the poll resume exactly where it
      // left off.
      if (!boardSync.isIdle()) return false;
      const matchingIds = new Set(
        (query.state.data ?? [])
          .filter((p) => !p.quote_number && p.quote_sync_state === 'pending')
          .map((p) => p.id),
      );
      if (matchingIds.size === 0) {
        pollDeadlineRef.current = null;
        pollMatchingIdsRef.current = matchingIds;
        return false;
      }
      const now = Date.now();
      const hasNewMatch = [...matchingIds].some((id) => !pollMatchingIdsRef.current.has(id));
      if (pollDeadlineRef.current === null || hasNewMatch) {
        pollDeadlineRef.current = now + QUOTE_POLL_MAX_MS;
      }
      pollMatchingIdsRef.current = matchingIds;
      if (now >= pollDeadlineRef.current) return false;
      return QUOTE_POLL_INTERVAL_MS;
    },
  });

  const [showModal, setShowModal] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  // Deliberately not persisted — not in the URL, not in storage. The board is
  // the working view; landing on the archive after a reload would be wrong
  // every time but the one you asked for it.
  const [showDone, setShowDone] = useState(false);
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

  const createMutation = useOptimisticBoardMutation<
    AitoProject,
    { description: string; draft: ClientDraft; tasks: TaskDraft[]; placeholder: AitoProject }
  >({
    mutationFn: ({ description, draft, tasks }) =>
      api.createAitoProject({
        description,
        client_id: draft.id,
        client_name: draft.name,
        client_phone: formatPhone(draft) || null,
        client_email: draft.email.trim() || null,
        client_is_company: draft.isCompany,
        tasks: tasks.map(taskDraftToTaskCreate),
      }),
    transform: (previous, { placeholder }) => applyCreate(previous, placeholder),
    // No flash: the placeholder is REMOVED on failure rather than reverted in
    // place, so there is no card left to ring.
    onSuccess: (created, { placeholder, draft }) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === placeholder.id ? created : p)) ?? prev,
      );
      void syncClientToZoho(draft);
    },
    onError: (_error, { placeholder }) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.filter((p) => p.id !== placeholder.id) ?? prev,
      );
      showToast(t('aito.createFailed'), 'error');
    },
  });

  /** Import posts through the same create endpoint as a manual card, so the
   *  board's ordering, defaults and landing column all behave identically —
   *  the only difference is the quote snapshot riding along. Nothing is
   *  written back to Zoho. */
  const importMutation = useOptimisticBoardMutation<
    AitoProject,
    { description: string; preview: ZohoQuotePreview; placeholder: AitoProject }
  >({
    mutationFn: ({ description, preview }) =>
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
    transform: (previous, { placeholder }) => applyCreate(previous, placeholder),
    onSuccess: (created, { placeholder }) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === placeholder.id ? created : p)) ?? prev,
      );
    },
    onError: (error, { placeholder }) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.filter((p) => p.id !== placeholder.id) ?? prev,
      );
      const conflict = error instanceof ApiError && error.status === 409;
      showToast(t(conflict ? 'aito.quoteAlreadyHasProject' : 'aito.createFailed'), 'error');
    },
  });

  const deleteMutation = useOptimisticBoardMutation<void, number>({
    mutationFn: (id) => api.deleteAitoProject(id),
    transform: (previous, id) => applyDelete(previous, id),
    flashId: (id) => id,
    onSuccess: () => {
      // The board is handled by the wrapper's settle-invalidate; the trash is
      // a separate query with a new row in it.
      queryClient.invalidateQueries({ queryKey: ['aito-trash'] });
    },
    onError: () => showToast(t('aito.deleteFailed'), 'error'),
  });

  const totalCount = COLUMN_IDS.reduce((sum, col) => sum + board[col].length, 0);

  const reducedMotion = useMemo(() => prefersReducedMotion(), []);

  const createProject = (description: string, draft: ClientDraft, tasks: TaskDraft[]) => {
    // Closed here, not in onSuccess: the whole point is that the modal does
    // not sit open through a round trip. The placeholder is what tells the
    // user their card exists.
    setShowModal(false);
    createMutation.mutate({
      description,
      draft,
      tasks,
      placeholder: placeholderProject({
        description,
        client_id: draft.id,
        client_name: draft.name,
        client_phone: formatPhone(draft) || null,
        client_email: draft.email.trim() || null,
        client_is_company: draft.isCompany,
        // No quote_status: a manual create posts none (see the mutationFn
        // above), so it defaults to null — the same "waits for Accept" state
        // a draft import has. `TaskDraft` already structurally matches
        // `TaskLike` (see aitoBoardRules.ts), so no conversion is needed.
        tasks,
      }),
    });
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

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 animate-rise">
        <div className="flex-1" />
        <Button variant="secondary" onClick={() => setShowDone((shown) => !shown)}>
          {showDone ? (
            <>
              <ArrowLeft className="w-4 h-4 mr-2" />
              {t('aito.backToBoard')}
            </>
          ) : (
            <>
              <Archive className="w-4 h-4 mr-2" />
              {t('aito.showDone')} ({board.done.length})
            </>
          )}
        </Button>
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
      {!aitoQuery.isError && !showDone && totalCount === 0 && (
        <div className="text-center py-8 animate-rise">
          <Kanban className="w-10 h-10 text-bambu-gray mx-auto mb-3" />
          <p className="text-white font-medium">{t('aito.emptyTitle')}</p>
          <p className="text-sm text-bambu-gray mt-1">{t('aito.emptyHint')}</p>
        </div>
      )}

      {/* Board */}
      {showDone ? (
        <DoneGrid projects={board.done} query="" onExpandCard={openCard} />
      ) : (
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
      )}

      {showModal && <NewProjectModal onClose={() => setShowModal(false)} onCreate={createProject} />}

      {showImport && (
        <ImportQuoteModal
          onClose={() => setShowImport(false)}
          onImport={({ description, preview }) => {
            // Closed here, not in onSuccess — same reasoning as createProject.
            setShowImport(false);
            importMutation.mutate({
              description,
              preview,
              placeholder: placeholderProject({
                description,
                client_id: preview.client.id,
                client_name: preview.client.name,
                client_phone: preview.client.phone,
                client_email: preview.client.email,
                client_is_company: preview.client.is_company,
                quote_number: preview.quote.number,
                quote_total: preview.quote.total,
                // A non-draft quote (sent/accepted/declined — the normal
                // import case) must not park on Quote for one round trip;
                // `placeholderProject` evaluates the same rules the server
                // does from this status and the tasks below.
                quote_status: preview.quote.status,
                // Wire shape (what `preview.tasks` already is — see
                // ZohoQuotePreview) -> `TaskLike`, the shape `summariseTasks`
                // reads everywhere else in the mirror.
                tasks: preview.tasks.map((task) => ({
                  scanCost: task.scan_cost,
                  modelisationCost: task.modelisation_cost,
                  impressionCost: task.impression_cost,
                  usinageCost: task.usinage_cost,
                  done: {
                    scan: task.scan_done ?? false,
                    modelisation: task.modelisation_done ?? false,
                    impression: task.impression_done ?? false,
                    usinage: task.usinage_done ?? false,
                  },
                })),
              }),
            });
          }}
          submitting={importMutation.isPending}
        />
      )}

      {showTrash && <TrashModal onClose={() => setShowTrash(false)} />}

      {expandedProject && (
        <ProjectDetailPanel
          project={expandedProject}
          onClose={() => closeCard(expandedProject.id)}
          onDelete={() => {
            // Close first, then delete. The panel is rendered from
            // `expandedProject`, which is derived from the projects query — so
            // letting the delete land first would unmount the panel out from
            // under its own click via a cache invalidation, losing the card
            // morph. Closing first keeps the morph and the mutation ordered.
            closeCard(expandedProject.id);
            deleteMutation.mutate(expandedProject.id);
          }}
        />
      )}
    </div>
  );
}
