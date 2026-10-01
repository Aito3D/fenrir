import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, MoveRight, Search, Split, X } from 'lucide-react';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';
import { api, ApiError, type AitoProject } from '../../api/client';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { useCurrency } from '../../hooks/useCurrency';
import { useToast } from '../../contexts/ToastContext';
import { formatMoney } from '../../utils/pricing';
import { replaceProject } from '../../utils/aitoOptimistic';
import { taskTotal, type TaskDraft } from '../../utils/taskDraft';
import { focusRingCls } from '../formStyles';
import { CandidateList } from './CandidateList';
import { AITO_SERVICE_LABEL_KEYS, serviceDotCls, taskSteps } from './services';

/** A beat past .animate-modal-out's 150ms — the margin ClientHistoryModal gives. */
const MODAL_OUT_MS = 170;

export type TransferResult = { source: AitoProject; target: AitoProject };

/** Send some of this card's tasks elsewhere — one request
 *  (POST /{id}/tasks/transfer) either way.
 *
 *  `split`: the ticked tasks go to a NEW card for the same client; at least
 *  one task has to stay (the server refuses an every-task split too).
 *  `move`: the ticked tasks go to another board card, picked on a second
 *  step with the merge dialog's list; moving all of them is allowed.
 *
 *  Only saved rows can travel: a row still being typed (`id === null`) has
 *  nothing on the server to move, so it is listed but disabled. While the
 *  panel still has task saves in flight (`savesPending`) the confirm is held:
 *  a row mid-POST has no id yet and would be left behind silently.
 *
 *  Same shell as MergeProjectModal: z-[110] over the panel, Escape stopped
 *  at the overlay so one key press does not close the panel as well. */
export function TaskTransferModal({
  project,
  tasks,
  mode,
  savesPending = false,
  onClose,
  onDone,
}: {
  project: AitoProject;
  tasks: TaskDraft[];
  mode: 'split' | 'move';
  savesPending?: boolean;
  onClose: () => void;
  onDone: (result: TransferResult) => void;
}) {
  const { t } = useTranslation();
  const currency = useCurrency();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, { animationMs: MODAL_OUT_MS });
  const [step, setStep] = useState<'pick-tasks' | 'pick-target'>('pick-tasks');
  const [ticked, setTicked] = useState<ReadonlySet<number>>(() => new Set());
  const [query, setQuery] = useState('');
  const [targetId, setTargetId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const savedIds = tasks.flatMap((task) => (task.id === null ? [] : [task.id]));
  // In list order, not tick order: the server appends them in the order given.
  const pickedIds = savedIds.filter((id) => ticked.has(id));
  const allTicked = savedIds.length > 0 && pickedIds.length === savedIds.length;
  // "Left without tasks" only when nothing at all stays — an unsaved draft
  // row is still on the card after the move.
  const leavesNone = allTicked && savedIds.length === tasks.length;

  const title = mode === 'split' ? t('aito.transferTitleSplit') : t('aito.transferTitleMove');
  const Icon = mode === 'split' ? Split : MoveRight;

  const transfer = useMutation({
    mutationFn: (target: number | null) =>
      api.transferAitoTasks(project.id, { task_ids: pickedIds, target_project_id: target }),
    onSuccess: (result) => {
      // Seed the board cache BEFORE anything else: the host resolves the
      // panel's card from `['aito-projects']`, so swapping to a just-split
      // card the board has never seen would find nothing and close the panel.
      queryClient.setQueryData<AitoProject[]>(['aito-projects'], (prev) => {
        const rows = replaceProject(prev, result.source);
        if (!rows) return rows;
        return rows.some((p) => p.id === result.target.id)
          ? replaceProject(rows, result.target)
          : [...rows, result.target];
      });
      queryClient.invalidateQueries({ queryKey: ['aito-tasks', result.source.id] });
      queryClient.invalidateQueries({ queryKey: ['aito-events', result.source.id] });
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
      if (mode === 'move') {
        queryClient.invalidateQueries({ queryKey: ['aito-tasks', result.target.id] });
        queryClient.invalidateQueries({ queryKey: ['aito-events', result.target.id] });
      }
      const key = mode === 'split' ? 'aito.splitDone' : 'aito.moveTasksDone';
      showToast(t(key, { count: pickedIds.length, id: result.target.id }), 'success');
      onDone(result);
      onClose();
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : t('aito.transferError'));
    },
  });

  const toggle = (id: number) => {
    setError(null);
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const note =
    mode === 'split'
      ? t('aito.transferNoteSplit', { client: project.client_name ?? t('aito.noClient') })
      : leavesNone
        ? t('aito.transferNoteMoveAll')
        : null;

  return (
    <div
      className={`fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[110] ${
        closing ? 'animate-overlay-out pointer-events-none' : 'animate-overlay-in'
      }`}
      onClick={requestClose}
      // The panel's window-level Escape listener is still mounted — stop the
      // key here or one Escape closes both (see MergeProjectModal).
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        if (!closing && !transfer.isPending) requestClose();
      }}
    >
      <Card
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="task-transfer-modal"
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
              <Icon className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[1.05rem] font-semibold leading-tight text-white truncate">{title}</h2>
              <p className="mt-0.5 text-xs text-bambu-gray leading-snug truncate">
                #{project.id} · {project.description}
              </p>
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

          {step === 'pick-tasks' ? (
            <>
              <div className="flex justify-end px-6 pb-2">
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setTicked(new Set(savedIds));
                  }}
                  className={`text-xs text-bambu-green hover:text-bambu-green/80 rounded ${focusRingCls}`}
                >
                  {t('aito.transferSelectAll')}
                </button>
              </div>
              <ul className="min-h-0 flex-1 overflow-y-auto scrollbar-hide px-6 pb-2 flex flex-col gap-1">
                {tasks.map((task, index) => {
                  const saved = task.id !== null;
                  const checked = saved && ticked.has(task.id as number);
                  const steps = taskSteps(task);
                  return (
                    <li key={saved ? `persisted:${task.id}` : `draft:${task.uid}`}>
                      <label
                        className={`flex items-start gap-3 rounded-lg border px-3 py-2 transition-[background-color,border-color] duration-150 ${
                          !saved
                            ? 'border-transparent opacity-50 cursor-not-allowed'
                            : checked
                              ? 'border-bambu-green/50 bg-bambu-green/[0.08] cursor-pointer'
                              : 'border-transparent hover:border-bambu-dark-tertiary hover:bg-bambu-dark cursor-pointer'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!saved || transfer.isPending}
                          onChange={() => saved && toggle(task.id as number)}
                          className="mt-0.5 h-4 w-4 flex-none accent-bambu-green"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-3">
                            <span className="min-w-0 truncate text-sm text-white">
                              {task.title || t('aito.taskFallbackName', { n: index + 1 })}
                            </span>
                            <span className="flex-none text-sm tabular-nums text-bambu-gray-light">
                              {formatMoney(taskTotal(task), currency)}
                            </span>
                          </span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-bambu-gray">
                            {steps.map(({ service, done }) => (
                              <span key={service} className="inline-flex items-center gap-1.5">
                                <span
                                  aria-hidden="true"
                                  className={`h-1.5 w-1.5 rounded-full ${serviceDotCls(service)} ${done ? 'opacity-30' : ''}`}
                                />
                                {t(AITO_SERVICE_LABEL_KEYS[service])}
                              </span>
                            ))}
                            {!saved && <span className="italic">{t('aito.transferUnsavedHint')}</span>}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {note && <p className="px-6 pb-3 text-xs text-bambu-gray leading-snug">{note}</p>}
            </>
          ) : (
            <>
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
                aria-label={title}
                className="min-h-0 flex-1 overflow-y-auto scrollbar-hide px-6 pb-2"
              >
                <CandidateList
                  project={project}
                  selectedId={targetId}
                  query={query}
                  onSelect={(id) => {
                    setTargetId(id);
                    setError(null);
                  }}
                />
              </div>
            </>
          )}

          <footer className="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3">
            <div className="min-w-0">
              <p role="alert" className="truncate text-xs text-red-400">
                {error}
              </p>
              {savesPending && !error && <p className="truncate text-xs text-bambu-gray">{t('aito.transferSavingHint')}</p>}
            </div>
            <div className="flex flex-none items-center gap-2">
              {step === 'pick-target' ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setError(null);
                    setStep('pick-tasks');
                  }}
                  disabled={transfer.isPending}
                >
                  {t('aito.transferBack')}
                </Button>
              ) : (
                <Button variant="secondary" size="sm" onClick={requestClose} disabled={transfer.isPending}>
                  {t('common.cancel')}
                </Button>
              )}
              {mode === 'split' ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={pickedIds.length === 0 || allTicked || savesPending || transfer.isPending}
                  onClick={() => transfer.mutate(null)}
                >
                  {transfer.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                  {t('aito.splitConfirm')}
                </Button>
              ) : step === 'pick-tasks' ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={pickedIds.length === 0 || savesPending}
                  onClick={() => {
                    setError(null);
                    setStep('pick-target');
                  }}
                >
                  {t('aito.transferPickTarget')}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={targetId === null || savesPending || transfer.isPending}
                  onClick={() => targetId !== null && transfer.mutate(targetId)}
                >
                  {transfer.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                  {t('aito.moveConfirm')}
                </Button>
              )}
            </div>
          </footer>
        </CardContent>
      </Card>
    </div>
  );
}
