import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Merge, Search, X } from 'lucide-react';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';
import { api, ApiError, type AitoProject } from '../../api/client';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { useCurrency } from '../../hooks/useCurrency';
import { useToast } from '../../contexts/ToastContext';
import { formatMoney } from '../../utils/pricing';
import { focusRingCls } from '../formStyles';
import { ALL_COLUMNS } from './columns';
import { matchesCandidate, mergeCandidates } from './mergeCandidates';

/** A beat past .animate-modal-out's 150ms — the margin ClientHistoryModal gives. */
const MODAL_OUT_MS = 170;

/** Pick another card; its tasks and steps are copied onto this one and it
 *  goes to the trash — one request (POST /{id}/merge), one timeline story.
 *
 *  Rendered by the panel, so it stacks above it (z-[110] against the panel's
 *  z-50 backdrop). The panel stays open underneath: on success the task
 *  list and board are invalidated, and `useProjectTasks`' own resync adopts
 *  the copies the moment they land, so the operator is still on the card,
 *  now with everything in one place. */
export function MergeProjectModal({ project, onClose }: { project: AitoProject; onClose: () => void }) {
  const { t } = useTranslation();
  const currency = useCurrency();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, { animationMs: MODAL_OUT_MS });
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Same key as the board, so this is served from its cache and costs no
  // request while the panel is open on top of it.
  const board = useQuery({ queryKey: ['aito-projects'], queryFn: api.getAitoProjects });
  const candidates = useMemo(() => mergeCandidates(board.data ?? [], project), [board.data, project]);
  const needle = query.trim().toLowerCase();
  const visible = candidates.filter((p) => matchesCandidate(p, needle));
  const selected = candidates.find((p) => p.id === selectedId) ?? null;

  const merge = useMutation({
    mutationFn: (sourceId: number) => api.mergeAitoProject(project.id, sourceId),
    onSuccess: (_, sourceId) => {
      const source = candidates.find((p) => p.id === sourceId);
      queryClient.invalidateQueries({ queryKey: ['aito-tasks', project.id] });
      queryClient.invalidateQueries({ queryKey: ['aito-events', project.id] });
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      queryClient.invalidateQueries({ queryKey: ['aito-trash'] });
      showToast(t('aito.mergeDone', { count: source?.task_count ?? 0, id: sourceId }), 'success');
      onClose();
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : t('aito.mergeError'));
    },
  });

  const stage = (p: AitoProject) => ALL_COLUMNS.find((column) => column.id === p.column);

  return (
    <div
      className={`fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[110] ${
        closing ? 'animate-overlay-out pointer-events-none' : 'animate-overlay-in'
      }`}
      onClick={requestClose}
      // The panel's own window-level Escape listener is still mounted while
      // this dialog is open — stop the key here or one Escape closes both.
      // Same trick as ClientHistoryModal, for the same reason.
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        if (!closing && !merge.isPending) requestClose();
      }}
    >
      <Card
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('aito.mergeTitle')}
        aria-busy={board.isPending ? 'true' : undefined}
        data-testid="merge-project-modal"
        tabIndex={-1}
        className={`w-full max-w-[560px] max-h-[88vh] flex flex-col focus:outline-none ${
          closing ? 'animate-modal-out' : 'animate-modal-in'
        }`}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <CardContent className="p-0 flex flex-col min-h-0">
          <header className="grid grid-cols-[36px_1fr_auto] items-center gap-x-3 px-6 pt-5 pb-4">
            <span
              aria-hidden="true"
              className="grid h-9 w-9 place-items-center rounded-[9px] bg-bambu-dark-tertiary text-bambu-gray-light"
            >
              <Merge className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[1.05rem] font-semibold leading-tight text-white truncate">{t('aito.mergeTitle')}</h2>
              <p className="mt-0.5 text-xs text-bambu-gray leading-snug">{t('aito.mergeBody')}</p>
            </div>
            <button
              type="button"
              onClick={requestClose}
              aria-label={t('common.close')}
              className={`grid h-8 w-8 place-items-center rounded-md text-bambu-gray transition-colors hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </header>

          <div className="px-6 pb-3">
            <label className="flex h-9 items-center gap-2 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark pl-3 pr-2 focus-within:border-bambu-green/50">
              <Search className="h-4 w-4 flex-none text-bambu-gray" aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('aito.mergeSearch')}
                aria-label={t('aito.mergeSearch')}
                autoFocus
                className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-bambu-gray focus:outline-none"
              />
            </label>
          </div>

          <div
            role="radiogroup"
            aria-label={t('aito.mergeTitle')}
            className="min-h-0 flex-1 overflow-y-auto scrollbar-hide px-6 pb-2"
          >
            {board.isPending ? (
              <div className="flex items-center justify-center py-10 text-bambu-gray">
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
              </div>
            ) : candidates.length === 0 ? (
              <p className="py-8 text-center text-sm text-bambu-gray">{t('aito.mergeEmpty')}</p>
            ) : visible.length === 0 ? (
              <p className="py-8 text-center text-sm text-bambu-gray">{t('aito.mergeNoMatch')}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {visible.map((p) => {
                  const meta = stage(p);
                  const checked = p.id === selectedId;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        data-testid="merge-candidate"
                        onClick={() => {
                          setSelectedId(p.id);
                          setError(null);
                        }}
                        className={`w-full rounded-lg border px-3 py-2 text-left transition-[background-color,border-color] duration-150 ${focusRingCls} ${
                          checked
                            ? 'border-bambu-green/50 bg-bambu-green/[0.08]'
                            : 'border-transparent hover:border-bambu-dark-tertiary hover:bg-bambu-dark'
                        }`}
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="min-w-0 truncate text-sm text-white">{p.description}</span>
                          <span className="flex-none text-sm tabular-nums text-bambu-gray-light">
                            {formatMoney(p.tasks_total, currency)}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-bambu-gray">
                          <span className="min-w-0 truncate">{p.client_name ?? t('aito.noClient')}</span>
                          <span aria-hidden="true">·</span>
                          <span className="flex-none tabular-nums">#{p.id}</span>
                          {p.quote_number && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="flex-none tabular-nums">{p.quote_number}</span>
                            </>
                          )}
                          <span className="flex-1" />
                          {meta && (
                            <span className="inline-flex flex-none items-center gap-1.5">
                              <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                              {t(meta.labelKey)}
                            </span>
                          )}
                          <span className="flex-none tabular-nums">{t('aito.mergeTaskCount', { count: p.task_count })}</span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3">
            <p role="alert" className="min-w-0 truncate text-xs text-red-400">
              {error}
            </p>
            <div className="flex flex-none items-center gap-2">
              <Button variant="secondary" size="sm" onClick={requestClose} disabled={merge.isPending}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={selected === null || merge.isPending}
                onClick={() => selected && merge.mutate(selected.id)}
              >
                {merge.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {t('aito.mergeConfirm')}
              </Button>
            </div>
          </footer>
        </CardContent>
      </Card>
    </div>
  );
}
