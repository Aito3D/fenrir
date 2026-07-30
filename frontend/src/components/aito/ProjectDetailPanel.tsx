import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, Loader2, X } from 'lucide-react';
import { COLUMNS } from './columns';
import { QuoteStatusActions } from './QuoteStatusActions';
import { quoteStatusLabelKey } from './quoteStatus';
import { TaskEditor } from './TaskEditor';
import { AITO_CARD_VT_NAME } from '../../hooks/useCardMorph';
import { useProjectTasks } from '../../hooks/useProjectTasks';
import { api, type AitoProject, type AitoProjectUpdate } from '../../api/client';
import { parseUTCDate } from '../../utils/date';
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
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

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
export function ProjectDetailPanel({ project, onClose }: ProjectDetailPanelProps) {
  const { t, i18n } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  const column = COLUMNS.find((c) => c.id === project.column);
  const created = parseUTCDate(project.created_at);
  const updated = parseUTCDate(project.updated_at);

  // "28 Jul 2026 · 5 600 XPF" — the QUOTE's own date and total, which can
  // exceed the project total when non-AITO lines were skipped at import.
  const quoteDate = project.quote_date ? new Date(project.quote_date + 'T00:00:00') : null;
  const quoteDetail = [
    quoteDate && !Number.isNaN(quoteDate.getTime()) ? quoteDate.toLocaleDateString(i18n.language) : '',
    project.quote_total != null ? project.quote_total.toLocaleString(i18n.language) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  // A status rendered through the shared quote-status labels, so the two sides
  // of a block message are localised too rather than raw Zoho English. An
  // untranslated status falls back to the raw string, the same rule the board
  // card follows — Zoho can add statuses.
  const statusLabel = (status: string | null): string => {
    if (!status) return '—';
    const key = quoteStatusLabelKey(status);
    return key ? t(key) : status;
  };
  const blockKey = project.quote_status_block ? BLOCK_MESSAGE_KEY[project.quote_status_block] : null;

  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const updateMutation = useMutation({
    mutationFn: (patch: AitoProjectUpdate) => api.updateAitoProject(project.id, patch),
    onSuccess: (updatedProject) => {
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) =>
        prev?.map((p) => (p.id === updatedProject.id ? updatedProject : p)) ?? prev,
      );
    },
    onError: () => showToast(t('aito.saveFailed'), 'error'),
  });

  const { tasks, onTasksChange, onRemoveTask, onRowBlur } = useProjectTasks(project.id);

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
        className="bg-bambu-dark-secondary rounded-xl w-full max-w-7xl border border-bambu-dark-tertiary flex flex-col max-h-[calc(100vh-2rem)]"
      >
        <div className="p-4 border-b border-bambu-dark-tertiary flex items-start justify-between gap-3 flex-shrink-0">
          <h2 className="text-lg font-semibold text-white truncate min-w-0">
            {t('aito.projectRef', { id: project.id })}
          </h2>
          <button
            type="button"
            ref={closeRef}
            aria-label={t('common.close')}
            onClick={onClose}
            className="p-1 -m-1 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] gap-4 lg:gap-6">
            <div className="space-y-4 min-w-0">
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
                    <dd className="min-w-0 truncate text-right">
                      <a href={`tel:${project.client_phone}`} className="text-white hover:text-bambu-green">
                        {project.client_phone}
                      </a>
                    </dd>
                  </div>
                )}
                {project.client_email && (
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-bambu-gray flex-shrink-0">{t('aito.emailLabel')}:</dt>
                    <dd className="min-w-0 truncate text-right">
                      <a href={`mailto:${project.client_email}`} className="text-white hover:text-bambu-green">
                        {project.client_email}
                      </a>
                    </dd>
                  </div>
                )}

                {/* Imported projects only. The quote is a snapshot, so this row
                    renders with Zoho unreachable; only the link needs Zoho. */}
                {project.quote_number && (
                  <div className="flex items-baseline justify-between gap-2 border-t border-bambu-dark-tertiary pt-2 mt-2">
                    <dt className="text-bambu-gray flex-shrink-0">{t('aito.quoteSearchLabel')}:</dt>
                    <dd className="text-white min-w-0 truncate text-right">
                      {project.quote_url ? (
                        <a
                          href={project.quote_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={t('aito.quoteOpenInZoho')}
                          className="text-white hover:text-bambu-green inline-flex items-center gap-1"
                        >
                          {project.quote_number}
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      ) : (
                        project.quote_number
                      )}
                      {quoteDetail && <span className="text-bambu-gray"> · {quoteDetail}</span>}
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
                      {project.quote_status === 'declined' && (
                        <span className="block text-xs text-bambu-gray">{t('aito.quoteDeclinedNoDraft')}</span>
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

                {/* Rendered for ANY quote_sync_state, unlike the sync row
                    above: the reconciler records a block as a fact of its
                    own, and a card can be perfectly 'idle' for the line-item
                    sync while its STATUS is stuck against Books. */}
                {blockKey && (
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-bambu-gray flex-shrink-0">{t('aito.sync')}:</dt>
                    <dd className="text-white min-w-0 text-right">
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

            <div className="min-w-0 border-t border-bambu-dark-tertiary pt-4 lg:border-t-0 lg:pt-0">
              <TaskEditor
                value={tasks}
                onChange={onTasksChange}
                onRemove={onRemoveTask}
                onRowBlur={(task) => {
                  if (task.id !== null) onRowBlur(task.id);
                }}
                canTick={project.quote_status === 'accepted'}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
