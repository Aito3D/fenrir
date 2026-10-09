import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Loader2 } from 'lucide-react';
import { Button } from '../Button';
import { api, type AitoProject, type AitoWatch } from '../../api/client';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { useToast } from '../../contexts/ToastContext';
import { NOTIFICATION_KINDS, UNKNOWN_KIND } from '../notificationKinds';
import { AitoDialogShell } from './AitoDialogShell';
import { AitoDialogFooter } from './AitoDialogFooter';

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
  // An auto-watch follows Settings until the user saves a selection of their own.
  const followsSettings = watching && watch?.follows_settings === true && edited === null;

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
    <AitoDialogShell
      label={t('inbox.watchTitle')}
      testId="watch-modal"
      icon={Eye}
      subtitle={t('inbox.watchBody')}
      closing={closing}
      requestClose={requestClose}
      dialogRef={dialogRef}
      busy={save.isPending}
      maxWidthCls="max-w-[460px]"
    >

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
        {ready && followsSettings && (
          <p className="mt-3 text-xs text-bambu-gray">{t('inbox.watchFollowsSettings')}</p>
        )}
      </div>

      <AitoDialogFooter
        error={error}
        errorTitle
        pending={save.isPending}
        secondary={
          watching && (
            <Button variant="secondary" size="sm" onClick={() => save.mutate([])} disabled={save.isPending}>
              {t('inbox.watchStop')}
            </Button>
          )
        }
        confirmLabel={t('inbox.watchSave')}
        // Unticking everything on a watched card is a stop, and Save says so by sending [].
        confirmDisabled={!ready || save.isPending || (toSend.length === 0 && !watching)}
        // An untouched auto-watch already delivers what Settings enables:
        // saving it as a list would freeze it, so Save just closes.
        onConfirm={() => (followsSettings ? requestClose() : save.mutate(toSend))}
      />
    </AitoDialogShell>
  );
}
