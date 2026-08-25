import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Button } from '../Button';
import type { FilamentBaseSyncResult } from '../../api/client';

export interface SyncBaseResultModalProps {
  result?: FilamentBaseSyncResult;
  error?: string;
  onClose: () => void;
}

function StatRow({ label, value, valueClassName }: { label: string; value: number; valueClassName: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-bambu-gray">{label}</span>
      <span className={`font-semibold tabular-nums ${valueClassName}`}>{value}</span>
    </div>
  );
}

/** Small result modal for the header's "Sync base" action (spec §5.2). */
export function SyncBaseResultModal({ result, error, onClose }: SyncBaseResultModalProps) {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 animate-overlay-in" onClick={onClose}>
      <div
        data-testid="sync-base-result-modal"
        className="w-full max-w-md rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-6 animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        {error ? (
          <>
            <div className="flex flex-col items-center gap-2 text-center">
              <AlertTriangle className="h-8 w-8 text-red-400" />
              <h3 className="text-lg font-semibold text-white">{t('filamentProfiles.baseSyncFailedTitle')}</h3>
            </div>
            <p className="mt-2 text-center text-sm text-bambu-gray">{error}</p>
          </>
        ) : result ? (
          <>
            <div className="flex flex-col items-center gap-2 text-center">
              <CheckCircle2 className="h-8 w-8 text-green-400" />
              <h3 className="text-lg font-semibold text-white">{t('filamentProfiles.baseSyncedTitle')}</h3>
              <p className="text-sm text-bambu-gray">{t('filamentProfiles.filesScanned', { n: result.total })}</p>
            </div>
            <div className="mt-4 space-y-1.5">
              <StatRow label={t('filamentProfiles.statNew')} value={result.added} valueClassName="text-green-400" />
              <StatRow label={t('filamentProfiles.statUpdated')} value={result.updated} valueClassName="text-sky-400" />
              <StatRow label={t('filamentProfiles.statUnchanged')} value={result.unchanged} valueClassName="text-bambu-gray" />
            </div>
          </>
        ) : null}
        <Button onClick={onClose} className="mt-6 w-full">
          {t('filamentProfiles.close')}
        </Button>
      </div>
    </div>
  );
}
