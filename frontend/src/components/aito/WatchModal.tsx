import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Loader2, X } from 'lucide-react';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';
import { api, type AitoProject, type AitoWatch } from '../../api/client';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { useToast } from '../../contexts/ToastContext';
import { focusRingCls } from '../formStyles';
import { NOTIFICATION_KINDS, UNKNOWN_KIND } from '../notificationKinds';

/** A beat past .animate-modal-out's 150ms — the margin MergeProjectModal gives. */
const MODAL_OUT_MS = 170;

/** Watch this card (spec B6): one checkbox per Aito inbox kind, Save / Stop
 *  watching, one PUT either way. A kind switched off in the user's Settings
 *  is listed but greyed — the server refuses it, and the way to get it back
 *  is Settings, not this dialog.
 *
 *  Rendered by the panel over itself (z-[110]), like MergeProjectModal. The
 *  answer goes straight into `['aito-watch', id]`, which is what the panel's
 *  eye and the menu's label read. */
export function WatchModal({ project, onClose }: { project: AitoProject; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, { animationMs: MODAL_OUT_MS });
  const watchKey = ['aito-watch', project.id];
  // Shared keys: the panel already holds the watch, Settings and the bell the preferences.
  const watchQuery = useQuery({ queryKey: watchKey, queryFn: () => api.getAitoWatch(project.id) });
  const prefsQuery = useQuery({ queryKey: ['inbox-preferences'], queryFn: api.getInboxPreferences });
  // null until the user touches a box: the starting ticks derive from both queries.
  const [edited, setEdited] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const watch = watchQuery.data;
  const prefs = prefsQuery.data;
  const kinds = prefs?.available.filter((k) => k.family === 'aito') ?? [];
  const enabled = new Set(prefs?.kinds ?? []);
  const usable = kinds.filter((k) => k.available && enabled.has(k.kind)).map((k) => k.kind);
  // A watched card shows what it is watched for (minus anything since switched
  // off, which the server would now refuse); a first open offers the defaults.
  const initial = watch?.watching ? usable.filter((k) => watch.kinds.includes(k)) : usable;
  const ticked = edited ?? initial;
  const watching = watch?.watching ?? false;

  const toggle = (kind: string) => {
    setError(null);
    setEdited(ticked.includes(kind) ? ticked.filter((k) => k !== kind) : [...ticked, kind]);
  };

  const save = useMutation({
    mutationFn: (next: string[]) => api.setAitoWatch(project.id, next),
    onSuccess: (answer: AitoWatch) => {
      queryClient.setQueryData(watchKey, answer);
      showToast(t(answer.watching ? 'inbox.watchSaved' : 'inbox.watchStopped'), 'success');
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const ready = watch !== undefined && prefs !== undefined;
  // Either read failing leaves nothing to tick: say so rather than spin.
  const loadFailed = !ready && (watchQuery.isError || prefsQuery.isError);
  // In `available` order, so the server stores the same list whatever order the boxes were ticked in.
  const toSend = usable.filter((k) => ticked.includes(k));

  return (
    <div
      className={`fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[110] ${
        closing ? 'animate-overlay-out pointer-events-none' : 'animate-overlay-in'
      }`}
      onClick={requestClose}
      // The panel's window-level Escape listener is still mounted under this
      // dialog — stop the key here or one Escape closes both.
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        if (!closing && !save.isPending) requestClose();
      }}
    >
      <Card
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('inbox.watchTitle')}
        data-testid="watch-modal"
        tabIndex={-1}
        className={`w-full max-w-[460px] flex flex-col focus:outline-none ${
          closing ? 'animate-modal-out' : 'animate-modal-in'
        }`}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <CardContent className="p-0 flex flex-col">
          <header className="grid grid-cols-[36px_1fr_auto] items-center gap-x-3 px-6 pt-5 pb-4">
            <span
              aria-hidden="true"
              className="grid h-9 w-9 place-items-center rounded-[9px] bg-bambu-dark-tertiary text-bambu-gray-light"
            >
              <Eye className="h-[18px] w-[18px]" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[1.05rem] font-semibold leading-tight text-white truncate">
                {t('inbox.watchTitle')}
              </h2>
              <p className="mt-0.5 text-xs text-bambu-gray leading-snug">{t('inbox.watchBody')}</p>
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

          <div className="px-6 pb-4">
            {loadFailed ? (
              <p role="alert" className="py-6 text-center text-sm text-red-400">
                {t('inbox.watchLoadFailed')}
              </p>
            ) : !ready ? (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-bambu-gray" aria-hidden="true" />
              </div>
            ) : (
              <ul className="space-y-1">
                {kinds.map((info) => {
                  const on = usable.includes(info.kind);
                  const checked = on && ticked.includes(info.kind);
                  const meta = NOTIFICATION_KINDS[info.kind];
                  const Icon = (meta ?? UNKNOWN_KIND).icon;
                  const tone = (meta ?? UNKNOWN_KIND).tone;
                  return (
                    <li key={info.kind}>
                      <label
                        className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition-[background-color,border-color] duration-150 ${
                          !on
                            ? 'border-transparent opacity-50 cursor-not-allowed'
                            : checked
                              ? 'border-bambu-green/50 bg-bambu-green/[0.08] cursor-pointer'
                              : 'border-transparent hover:border-bambu-dark-tertiary hover:bg-bambu-dark cursor-pointer'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!on || save.isPending}
                          onChange={() => toggle(info.kind)}
                          className="h-4 w-4 flex-none accent-bambu-green"
                        />
                        <span className={`p-1 rounded-md ${tone}`} aria-hidden="true">
                          <Icon className="w-3.5 h-3.5" />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm text-white">
                          {meta ? t(`inbox.kind.${meta.titleKey}`) : info.kind}
                        </span>
                        {!on && <span className="flex-none text-xs text-bambu-gray">{t('inbox.offInSettings')}</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary px-6 py-3">
            <p role="alert" className="min-w-0 truncate text-xs text-red-400" title={error ?? undefined}>
              {error}
            </p>
            <div className="flex flex-none items-center gap-2">
              {watching && (
                <Button variant="secondary" size="sm" onClick={() => save.mutate([])} disabled={save.isPending}>
                  {t('inbox.watchStop')}
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                // Unticking everything on a watched card is a stop, and Save says so by sending [].
                disabled={!ready || save.isPending || (toSend.length === 0 && !watching)}
                onClick={() => save.mutate(toSend)}
              >
                {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {t('inbox.watchSave')}
              </Button>
            </div>
          </footer>
        </CardContent>
      </Card>
    </div>
  );
}
