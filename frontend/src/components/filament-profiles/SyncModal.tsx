import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '../Button';
import type { FilamentSyncStats } from '../../api/client';

export interface SyncModalProps {
  state: 'syncing' | 'preview' | 'done';
  stats?: FilamentSyncStats;
  onCancel: () => void;
  onConfirm: () => void;
  onClose: () => void;
  /** T-026: the confirm step runs the destructive non-dry-run sync, which the
   *  backend now also gates on filaments:delete (it removes on-disk presets
   *  not in the incoming list). Defaults to true so callers that don't pass
   *  it keep today's behaviour. */
  canConfirm?: boolean;
}

function StatRow({ label, value, valueClassName }: { label: string; value: number; valueClassName: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-bambu-gray">{label}</span>
      <span className={`font-semibold tabular-nums ${valueClassName}`}>{value}</span>
    </div>
  );
}

/**
 * Two-phase sync-to-PC modal (spec §5.8). Not dismissible (no backdrop
 * click, no Escape) while `state === 'syncing'` — the caller drives the
 * spinner-only state both before the dry-run preview and again during the
 * real, destructive execute call.
 */
export function SyncModal({ state, stats, onCancel, onConfirm, onClose, canConfirm = true }: SyncModalProps) {
  const { t } = useTranslation();
  const dismissible = state !== 'syncing';
  const dismiss = state === 'preview' ? onCancel : onClose;

  useEffect(() => {
    if (!dismissible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dismissible, dismiss]);

  const zeroChanges = state === 'preview' && !!stats && stats.added + stats.updated + stats.removed === 0;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 animate-overlay-in"
      onClick={dismissible ? dismiss : undefined}
    >
      <div
        data-testid="sync-modal"
        className="w-full max-w-md rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-6 animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        {state === 'syncing' && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-bambu-green" />
            <p className="text-white">{t('filamentProfiles.syncTitle')}</p>
          </div>
        )}

        {state === 'preview' && (
          <>
            <h3 className="text-lg font-semibold text-white">{t('filamentProfiles.syncTitle')}</h3>
            <p className="mt-1 text-sm text-bambu-gray">{t('filamentProfiles.syncSubtitle')}</p>
            {stats && (
              zeroChanges ? (
                <p className="mt-4 text-sm text-bambu-gray">{t('filamentProfiles.upToDate')}</p>
              ) : (
                <div className="mt-4 space-y-1.5">
                  <StatRow label={t('filamentProfiles.statNew')} value={stats.added} valueClassName="text-green-400" />
                  <StatRow label={t('filamentProfiles.statUpdated')} value={stats.updated} valueClassName="text-sky-400" />
                  <StatRow label={t('filamentProfiles.statRemoved')} value={stats.removed} valueClassName="text-red-400" />
                  <StatRow label={t('filamentProfiles.statUnchanged')} value={stats.unchanged} valueClassName="text-bambu-gray" />
                </div>
              )
            )}
            {!canConfirm && (
              <p className="mt-3 text-sm text-amber-400">{t('filamentProfiles.syncConfirmNeedsDelete')}</p>
            )}
            <div className="mt-6 flex gap-3">
              <Button variant="secondary" onClick={onCancel} className="flex-1">
                {t('filamentProfiles.cancel')}
              </Button>
              <Button onClick={onConfirm} disabled={!stats || zeroChanges || !canConfirm} className="flex-1">
                {t('filamentProfiles.syncConfirm')}
              </Button>
            </div>
          </>
        )}

        {state === 'done' && (
          <>
            <div className="flex flex-col items-center gap-2 text-center">
              <CheckCircle2 className="h-8 w-8 text-green-400" />
              <h3 className="text-lg font-semibold text-white">{t('filamentProfiles.syncDoneTitle')}</h3>
            </div>
            {stats && (
              <div className="mt-4 space-y-1.5">
                <StatRow label={t('filamentProfiles.statAdded')} value={stats.added} valueClassName="text-green-400" />
                <StatRow label={t('filamentProfiles.statUpdated')} value={stats.updated} valueClassName="text-sky-400" />
                <StatRow label={t('filamentProfiles.statRemoved')} value={stats.removed} valueClassName="text-red-400" />
              </div>
            )}
            <Button onClick={onClose} className="mt-6 w-full">
              {t('filamentProfiles.close')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
