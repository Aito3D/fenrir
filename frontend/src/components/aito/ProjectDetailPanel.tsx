import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, Loader2, X } from 'lucide-react';
import { ALL_COLUMNS } from './columns';
import { DeleteHoldButton } from './DeleteHoldButton';
import { ActivityRail } from './history/ActivityRail';
import { QuotePrintButton } from './QuotePrintButton';
import { QuoteStatusActions } from './QuoteStatusActions';
import { quoteStatusLabelKey } from './quoteStatus';
import { TaskEditor } from './TaskEditor';
import { AITO_CARD_VT_NAME } from '../../hooks/useCardMorph';
import { useOptimisticBoardMutation } from '../../hooks/useOptimisticBoardMutation';
import { useProjectTasks } from '../../hooks/useProjectTasks';
import { api, type AitoProject, type AitoProjectUpdate } from '../../api/client';
import { copyTextToClipboard } from '../../utils/clipboard';
import { parseUTCDate } from '../../utils/date';
import { applyDescription, applySyncState } from '../../utils/aitoOptimistic';
import { inputCls, labelCls } from '../formStyles';
import { useToast } from '../../contexts/ToastContext';

/** Explicit map rather than a template literal key: the i18n gate scans for
 *  literal `t('...')` calls, and a dynamic key is invisible to it. */
const SYNC_LABEL_KEY: Record<string, string> = {
  pending: 'aito.syncPendingLabel',
  error: 'aito.syncError',
  locked: 'aito.quoteLocked',
};

/** Why the backend's status reconciler is stuck, keyed by the stored fact it
 *  records — same explicit-map reason as SYNC_LABEL_KEY above.
 *
 *  Deliberately NOT folded into the sync row: a block is recorded whatever
 *  `quote_sync_state` happens to be, and the sync row only renders for three
 *  of its five values. A conflict written into a field the UI renders in one
 *  state only is a conflict that reaches nobody, which is exactly how the
 *  previous design lost them. */
const BLOCK_MESSAGE_KEY: Record<string, string> = {
  conflict: 'aito.quoteConflict',
  rejected: 'aito.quoteRejected',
};

interface ProjectDetailPanelProps {
  project: AitoProject;
  onClose: () => void;
  /** Omitted for a project that is already in the trash — see AitoPage. The
   *  delete button is then not rendered at all. */
  onDelete?: () => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** A contact detail that copies itself.
 *
 *  It used to be a `tel:` / `mailto:` link, which on a desktop workshop machine
 *  is a way to hand the number to whatever application once claimed the
 *  protocol — usually nothing, sometimes something unwanted. What the value is
 *  actually FOR is pasting: into a phone, into a mail client that is already
 *  open, into the shop's own paperwork. So the click copies, and does only
 *  that.
 *
 *  `copyTextToClipboard`, not `navigator.clipboard` directly: Bambuddy is
 *  normally reached over plain HTTP on a LAN address, where the async clipboard
 *  API does not exist and the helper's textarea fallback is the only path that
 *  works.
 *
 *  The acknowledgement is a check mark for 1.5s — the same dwell
 *  `SaveIndicator` uses below, so the two transient confirmations in this panel
 *  behave alike. A copy that fails leaves the icon alone rather than raising a
 *  toast, which is what `PrinterInfoModal` does with the same helper: the check
 *  mark IS the claim that it worked, so withholding it is the honest report. */
function CopyableValue({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  return (
    <button
      type="button"
      // The value alone is the name a screen reader would read; this says what
      // pressing it does, which is the part that is not obvious.
      aria-label={`${label}: ${value} — ${t('common.copy')}`}
      title={copied ? t('common.copied') : t('common.copy')}
      onClick={async () => {
        if (await copyTextToClipboard(value)) setCopied(true);
      }}
      className="group inline-flex items-center gap-1.5 max-w-full min-w-0 rounded-md text-white hover:text-bambu-green transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
    >
      <span className="truncate">{value}</span>
      {copied ? (
        <Check className="w-3.5 h-3.5 flex-shrink-0 text-bambu-green animate-tick-in" />
      ) : (
        // Hinted rather than announced: the row is a definition list of facts,
        // and a permanent icon on two of them would read as two buttons in a
        // list of text. It surfaces when the pointer is on the value it
        // belongs to.
        <Copy className="w-3.5 h-3.5 flex-shrink-0 opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60 transition-opacity" />
      )}
    </button>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const { t } = useTranslation();
  if (state === 'saving') return <Loader2 className="w-3.5 h-3.5 text-bambu-gray animate-spin" />;
  if (state === 'saved') {
    return (
      <span className="flex items-center gap-1 text-xs text-bambu-green animate-fade-in">
        <Check className="w-3.5 h-3.5" />
        {t('aito.saved')}
      </span>
    );
  }
  return null;
}

/** Everything a card cannot fit: the untruncated description, the timestamps
 *  and the stage. Shares AITO_CARD_VT_NAME with the card it grew out of, so the
 *  browser morphs one into the other (see useCardMorph). */
export function ProjectDetailPanel({ project, onClose, onDelete }: ProjectDetailPanelProps) {
  const { t, i18n } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  const column = ALL_COLUMNS.find((c) => c.id === project.column);
  const created = parseUTCDate(project.created_at);
  const updated = parseUTCDate(project.updated_at);

  // A status rendered through the shared quote-status labels, so the two sides
  // of a block message are localised too rather than raw Zoho English. An
  // untranslated status falls back to the raw string — Zoho can add statuses,
  // and this is the only surface left that shows the exact one.
  const statusLabel = (status: string | null): string => {
    if (!status) return '—';
    const key = quoteStatusLabelKey(status);
    return key ? t(key) : status;
  };
  const blockKey = project.quote_status_block ? BLOCK_MESSAGE_KEY[project.quote_status_block] : null;

  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const updateMutation = useOptimisticBoardMutation<AitoProject, AitoProjectUpdate>({
    mutationFn: (patch) => api.updateAitoProject(project.id, patch),
    // A description edit shows immediately; the retry-sync button sends the
    // description UNCHANGED (its only job is to re-mark the project pending
    // for the worker), so it writes the sync state instead. One transform,
    // branching on which of the two this is.
    transform: (previous, patch) => {
      if (patch.description !== undefined && patch.description !== project.description) {
        return applyDescription(previous, project.id, patch.description);
      }
      return applySyncState(previous, project.id, 'pending');
    },
    flashId: () => project.id,
    onSuccess: (updatedProject) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === updatedProject.id ? updatedProject : p)) ?? prev,
      );
      queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });
    },
    onError: () => showToast(t('aito.saveFailed'), 'error'),
  });

  const { tasks, onTasksChange, onRemoveTask, onRowBlur, pendingTaskUids } = useProjectTasks(project.id);

  const [editingDesc, setEditingDesc] = useState(false);
  const [draft, setDraft] = useState(project.description);
  const [descState, setDescState] = useState<SaveState>('idle');

  // Follow the server value while idle; never clobber text being typed.
  useEffect(() => {
    if (!editingDesc) setDraft(project.description);
  }, [project.description, editingDesc]);

  // 'saved' is a transient acknowledgement, not a state to sit in.
  useEffect(() => {
    if (descState !== 'saved') return;
    const id = setTimeout(() => setDescState('idle'), 1500);
    return () => clearTimeout(id);
  }, [descState]);

  const saveDescription = () => {
    setEditingDesc(false);
    const next = draft.trim();
    // Blank is rejected by the backend (min_length=1) and is almost always an
    // accidental select-all-delete, so revert rather than round-trip an error.
    if (!next || next === project.description) {
      setDraft(project.description);
      return;
    }
    setDescState('saving');
    updateMutation.mutate(
      { description: next },
      {
        onSuccess: () => setDescState('saved'),
        onError: () => {
          setDescState('error');
          setDraft(project.description);
        },
      },
    );
  };

  const editingRef = useRef(false);
  editingRef.current = editingDesc;

  // onClose is a fresh inline closure on every AitoPage render, so it cannot be
  // an effect dependency: the effect would re-run on every re-render and steal
  // focus back from whatever the user is editing.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editingRef.current) onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 [view-transition-name:aito-backdrop]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={project.client_name ?? t('aito.noClient')}
        style={{ viewTransitionName: AITO_CARD_VT_NAME }}
        className="bg-bambu-dark-secondary rounded-xl w-full max-w-[100rem] border border-bambu-dark-tertiary flex flex-col max-h-[calc(100vh-2rem)]"
      >
        <div className="group p-4 border-b border-bambu-dark-tertiary flex items-start justify-between gap-3 flex-shrink-0">
          <h2 className="text-lg font-semibold text-white truncate min-w-0">
            {t('aito.projectRef', { id: project.id })}
          </h2>
          <span className="flex items-center gap-3 flex-shrink-0">
            {onDelete && (
              <DeleteHoldButton onDelete={onDelete} label={t('aito.deleteTitle')} hint={t('aito.holdToDelete')} />
            )}
            <button
              type="button"
              ref={closeRef}
              aria-label={t('common.close')}
              onClick={onClose}
              className="p-1 -m-1 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
            >
              <X className="w-5 h-5" />
            </button>
          </span>
        </div>

        <div className="p-4 overflow-y-auto scrollbar-hide flex-1 min-h-0 lg:flex lg:flex-col lg:overflow-hidden">
          {/* Three columns, three scrollers — but only from `lg` up, where the
              grid is actually side by side. Below that the columns stack and
              the body's own scroller is the right one.

              The history rail is an infinite query with no height of its own,
              so with a single shared scroller every "load more" pushed the
              description, the client and the tasks off the top of the screen.
              Capping the row at the panel's available height and letting each
              column scroll inside it is what keeps the header and the left
              column where the user left them.

              `lg:h-full` was tried first and silently did nothing: a percentage
              height only resolves against a parent whose height is definite,
              and this body's height comes out of the flex algorithm (`flex-1
              min-h-0` above), not an explicit value, so `h-full` fell back to
              `auto` — the content height — and never capped anything. The body
              itself has to become the definite-height parent instead, so at
              `lg` it turns into a non-scrolling flex column (`lg:flex
              lg:flex-col lg:overflow-hidden`) and the grid below takes
              `lg:flex-1` to get a real, definite height from it.

              `lg:min-h-0` is still required on the row and on every column,
              here and below: a flex/grid item defaults to `min-height: auto`
              and refuses to shrink below its content, so without it the
              definite height above is still ignored. Same reason AitoPage's
              board row carries it. */}
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)_minmax(0,26rem)] gap-4 lg:gap-6 lg:flex-1 lg:min-h-0">
            <div className="space-y-4 min-w-0 lg:min-h-0 lg:overflow-y-auto scrollbar-hide">
              <div>
                {/* The same name the create modal gives this field, so the
                    create surface and the edit surface agree on what it is.
                    Not a <dt>: the description sits above the <dl>, and the
                    <p>/<textarea> swap below is not a <dd>. */}
                <p className={labelCls}>{t('aito.productDescription')}</p>
                <div className="flex items-start justify-between gap-2">
                  {editingDesc ? (
                    <textarea
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={saveDescription}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          // Stop the panel's window-level Escape handler: the first
                          // Escape abandons the edit, it does not close the panel.
                          e.stopPropagation();
                          setDraft(project.description);
                          setEditingDesc(false);
                        }
                        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveDescription();
                      }}
                      rows={5}
                      className={`${inputCls} resize-none flex-1`}
                    />
                  ) : (
                    <p
                      role="button"
                      tabIndex={0}
                      aria-label={t('aito.editDescription')}
                      onClick={() => setEditingDesc(true)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setEditingDesc(true);
                        }
                      }}
                      className="flex-1 text-sm text-white whitespace-pre-wrap break-words cursor-text rounded-md -m-1 p-1 hover:bg-bambu-dark-tertiary/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
                    >
                      {project.description}
                    </p>
                  )}
                  <SaveIndicator state={descState} />
                </div>
              </div>

              {/* One description list for the whole record. <dt>/<dd> gives
                  assistive technology the label-to-value association for free; the
                  colon is markup, so no locale string carries punctuation. Client
                  rows with no value are omitted entirely — an empty "Email:" is
                  noise, not information. The mid-list border separates the client
                  group from the project metadata. Rows are `justify-between` with
                  right-aligned <dd>s, turning the block into a spec sheet: labels
                  flush left, values flush right. */}
              <dl className="border-t border-bambu-dark-tertiary pt-4 space-y-2 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-bambu-gray flex-shrink-0">
                    {project.client_is_company ? t('aito.companyNameLabel') : t('aito.clientNameLabel')}:
                  </dt>
                  <dd
                    className={`min-w-0 truncate text-right ${
                      project.client_name ? 'text-white' : 'text-bambu-gray'
                    }`}
                  >
                    {project.client_name ?? t('aito.noClient')}
                  </dd>
                </div>
                {project.client_phone && (
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-bambu-gray flex-shrink-0">{t('aito.phoneLabel')}:</dt>
                    <dd className="min-w-0 text-right">
                      <CopyableValue value={project.client_phone} label={t('aito.phoneLabel')} />
                    </dd>
                  </div>
                )}
                {project.client_email && (
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-bambu-gray flex-shrink-0">{t('aito.emailLabel')}:</dt>
                    <dd className="min-w-0 text-right">
                      <CopyableValue value={project.client_email} label={t('aito.emailLabel')} />
                    </dd>
                  </div>
                )}

                {/* Imported projects only. The quote is a snapshot, so this row
                    renders with Zoho unreachable; only the link needs Zoho. */}
                {project.quote_number && (
                  <div className="flex items-baseline justify-between gap-2 border-t border-bambu-dark-tertiary pt-2 mt-2">
                    <dt className="text-bambu-gray flex-shrink-0">{t('aito.quoteSearchLabel')}:</dt>
                    <dd className="text-white min-w-0 truncate text-right flex items-center justify-end gap-2">
                      {project.quote_url ? (
                        <a
                          href={project.quote_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={t('aito.quoteOpenInZoho')}
                          className="text-white hover:text-bambu-green inline-flex items-center gap-1 min-w-0 truncate"
                        >
                          {project.quote_number}
                          <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
                        </a>
                      ) : (
                        <span className="min-w-0 truncate">{project.quote_number}</span>
                      )}
                      {/* Replaces the quote's date and total, which said less
                          than the one thing an operator actually does with a
                          quote at this point in the job. */}
                      <QuotePrintButton project={project} />
                    </dd>
                  </div>
                )}
                {project.quote_salesperson && (
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-bambu-gray flex-shrink-0">{t('aito.sellerLabel')}:</dt>
                    <dd className="text-white min-w-0 truncate text-right">{project.quote_salesperson}</dd>
                  </div>
                )}

                {/* Only when there is something to say. An idle project is the
                    normal case and a row reading "up to date" on every card
                    would be noise. */}
                {SYNC_LABEL_KEY[project.quote_sync_state] && (
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-bambu-gray flex-shrink-0">{t('aito.sync')}:</dt>
                    <dd className="text-white min-w-0 text-right">
                      {t(SYNC_LABEL_KEY[project.quote_sync_state])}
                      {project.quote_sync_error && (
                        <span className="block text-xs text-bambu-gray">{project.quote_sync_error}</span>
                      )}
                      {project.quote_sync_state === 'locked' && (
                        <span className="block text-xs text-bambu-gray">{t('aito.quoteLockedHelp')}</span>
                      )}
                      {project.quote_sync_state === 'error' && (
                        <button
                          type="button"
                          onClick={() => updateMutation.mutate({ description: project.description })}
                          disabled={updateMutation.isPending}
                          className="block ml-auto mt-1 text-xs text-bambu-green hover:text-bambu-green/80 disabled:opacity-50"
                        >
                          {t('aito.retrySync')}
                        </button>
                      )}
                    </dd>
                  </div>
                )}

                {/* Also independent of the sync row above, and for the same
                    reason it had to be moved out of it: the sync row only
                    renders for pending/error/locked, and a card left declined
                    — restored from the trash, or re-imported from a declined
                    quote — is normally 'idle', so the one sentence explaining
                    why it is stuck rendered exactly never. */}
                {project.quote_status === 'declined' && (
                  <div className="flex items-baseline gap-2">
                    <dd className="ml-0 w-full text-xs text-bambu-gray">{t('aito.quoteDeclinedNoDraft')}</dd>
                  </div>
                )}

                {/* Rendered for ANY quote_sync_state, unlike the sync row
                    above: the reconciler records a block as a fact of its
                    own, and a card can be perfectly 'idle' for the line-item
                    sync while its STATUS is stuck against Books. */}
                {blockKey && (
                  <div className="flex items-baseline gap-2">
                    {/* No <dt>: the sync row above already uses the only label
                        that would fit ("Sync"), and two consecutive rows under
                        one identical term reads as a mistake. The sentence
                        names both sides itself, so it needs no term — it spans
                        the row instead. */}
                    <dd className="ml-0 w-full text-status-error">
                      {t(blockKey, {
                        ours: statusLabel(project.quote_status),
                        theirs: statusLabel(project.quote_status_remote),
                      })}
                    </dd>
                  </div>
                )}

                <div className="flex items-baseline justify-between gap-2 border-t border-bambu-dark-tertiary pt-2 mt-2">
                  <dt className="text-bambu-gray flex-shrink-0">{t('aito.createdLabel')}:</dt>
                  <dd className="text-white min-w-0 text-right">
                    {created ? created.toLocaleString(i18n.language) : '—'}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-bambu-gray flex-shrink-0">{t('aito.createdByLabel')}:</dt>
                  {/* An em dash rather than an omitted row: a card created
                      with auth disabled, by an API key, or before this column
                      existed has no creator, and saying so is information. */}
                  <dd className="text-white min-w-0 truncate text-right">{project.created_by ?? '—'}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-bambu-gray flex-shrink-0">{t('aito.lastActivity')}:</dt>
                  <dd className="text-white min-w-0 text-right">
                    {updated ? updated.toLocaleString(i18n.language) : '—'}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-bambu-gray flex-shrink-0">{t('aito.stage')}:</dt>
                  {/* The dot lives inside the <dd> so it travels right with its
                      label text instead of stranding mid-row. */}
                  <dd className="text-white flex items-center justify-end gap-2 text-right">
                    {column && <span className={`w-2 h-2 rounded-full ${column.dot}`} />}
                    {column ? t(column.labelKey) : project.column}
                  </dd>
                </div>
              </dl>

              <QuoteStatusActions project={project} />
            </div>

            <div className="min-w-0 lg:min-h-0 lg:overflow-y-auto scrollbar-hide border-t border-bambu-dark-tertiary pt-4 lg:border-t-0 lg:pt-0 lg:border-l lg:border-bambu-dark-tertiary lg:pl-6">
              <TaskEditor
                value={tasks}
                onChange={onTasksChange}
                onRemove={onRemoveTask}
                onRowBlur={(task) => {
                  if (task.id !== null) onRowBlur(task.id);
                }}
                canTick={project.quote_status === 'accepted'}
                pendingUids={pendingTaskUids}
              />
            </div>

            <div className="min-w-0 lg:min-h-0 lg:overflow-y-auto scrollbar-hide border-t border-bambu-dark-tertiary pt-4 lg:border-t-0 lg:pt-0 lg:border-l lg:pl-6">
              <ActivityRail projectId={project.id} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
