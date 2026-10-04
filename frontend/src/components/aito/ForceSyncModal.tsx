import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, Minus, RefreshCw, X } from 'lucide-react';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';
import {
  api,
  ApiError,
  type AitoForceSyncOutcome,
  type AitoForceSyncStepKey,
  type AitoProject,
} from '../../api/client';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { focusRingCls } from '../formStyles';
import { forceSyncStepText } from './forceSyncText';

/** A beat past .animate-modal-out's 150ms — the margin MergeProjectModal gives. */
const MODAL_OUT_MS = 170;

const STEPS: { key: AitoForceSyncStepKey; label: string }[] = [
  { key: 'quote', label: 'aito.forceSyncStepQuote' },
  { key: 'credit', label: 'aito.forceSyncStepCredit' },
  { key: 'invoice', label: 'aito.forceSyncStepInvoice' },
  { key: 'payment_links', label: 'aito.forceSyncStepLinks' },
];

const OUTCOME_ICON: Record<AitoForceSyncOutcome, { Icon: typeof Check; cls: string }> = {
  in_sync: { Icon: Check, cls: 'text-bambu-green' },
  fixed: { Icon: RefreshCw, cls: 'text-bambu-green-light' },
  failed: { Icon: X, cls: 'text-red-400' },
  skipped: { Icon: Minus, cls: 'text-bambu-gray' },
};

/** Re-checks the card against Zoho and lists what each step found.
 *
 *  Runs once on open (the request is the report). Closing mid-run is fine: the
 *  server finishes either way. Like MergeProjectModal it stacks above the panel
 *  (z-[110]) and swallows Escape so one key does not close both. */
export function ForceSyncModal({
  project,
  currency,
  onClose,
}: {
  project: AitoProject;
  currency: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, { animationMs: MODAL_OUT_MS });
  const title = t('aito.forceSyncTitle');

  const run = useMutation({
    mutationFn: () => api.forceSyncAitoProject(project.id),
    onSuccess: () => {
      for (const key of ['aito-invoice', 'aito-invoice-deposits', 'aito-retainers', 'aito-events', 'aito-tasks']) {
        queryClient.invalidateQueries({ queryKey: [key, project.id] });
      }
      queryClient.invalidateQueries({ queryKey: ['aito-projects'] });
    },
  });
  // The mutation is idle until the effect below fires: no result yet still means running.
  const running = !run.data && !run.error;
  // Once per mount, StrictMode-safe: a ref, not the effect's own re-run.
  const started = useRef(false);
  const { mutate } = run;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutate();
  }, [mutate]);

  return (
    <div
      className={`fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[110] ${
        closing ? 'animate-overlay-out pointer-events-none' : 'animate-overlay-in'
      }`}
      onClick={() => !closing && requestClose()}
      // The panel's window-level Escape listener is still mounted: stop the
      // key here or one Escape closes both.
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        if (!closing) requestClose();
      }}
    >
      <Card
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="force-sync-modal"
        tabIndex={-1}
        className={`w-full max-w-[480px] max-h-[88vh] flex flex-col focus:outline-none ${
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
              <RefreshCw className="h-[18px] w-[18px]" />
            </span>
            <h2 className="min-w-0 text-[1.05rem] font-semibold leading-tight text-white truncate">{title}</h2>
            <button
              type="button"
              onClick={requestClose}
              aria-label={t('common.close')}
              className={`grid h-8 w-8 place-items-center rounded-md text-bambu-gray transition-colors hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide px-6 pb-4">
            {run.error ? (
              <p role="alert" className="text-sm text-red-400">
                {run.error instanceof ApiError ? run.error.message : t('aito.forceSyncFailed')}
              </p>
            ) : (
              <ul className="space-y-2.5">
                {STEPS.map(({ key, label }) => {
                  const step = run.data?.steps.find((s) => s.key === key);
                  const text = step ? forceSyncStepText(t, step, currency) : null;
                  const icon = step ? OUTCOME_ICON[step.outcome] : null;
                  return (
                    <li key={key} className="flex items-start gap-3 text-sm">
                      <span className="mt-0.5 grid h-4 w-4 flex-none place-items-center" aria-hidden="true">
                        {icon ? (
                          <icon.Icon className={`h-4 w-4 ${icon.cls}`} />
                        ) : running ? (
                          <Loader2 className="h-4 w-4 animate-spin text-bambu-gray" />
                        ) : null}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-white">{t(label)}</span>
                          <span className="flex-none text-xs text-bambu-gray-light">
                            {text ? text.label : running ? t('aito.forceSyncRunning') : null}
                          </span>
                        </div>
                        {text?.detail ? <p className="mt-0.5 break-words text-xs text-bambu-gray">{text.detail}</p> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <footer className="flex items-center justify-end gap-2 border-t border-bambu-dark-tertiary px-6 py-3">
            <Button variant="secondary" size="sm" onClick={requestClose}>
              {t('common.close')}
            </Button>
          </footer>
        </CardContent>
      </Card>
    </div>
  );
}
