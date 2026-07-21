import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, Video } from 'lucide-react';

import type { CameraQuality } from '../../api/client';
import type { GridStreamStats } from '../../hooks/useGridStream';

const QUALITY_OPTIONS = ['auto', 'low', 'medium', 'high'] as const;

/** GridStats — subscribes to stats changes without re-rendering CameraGrid */
function GridStats({ subscribeStats, getStatsSnapshot }: {
  subscribeStats: (cb: () => void) => () => void;
  getStatsSnapshot: () => GridStreamStats;
}) {
  const { t } = useTranslation();
  const stats = useSyncExternalStore(subscribeStats, getStatsSnapshot);
  return (
    <>
      <span
        className="flex items-center gap-1 text-xs text-bambu-gray/60 ml-auto cursor-default"
        title={t('printers.cameraGrid.stats.live')}
      >
        <Video className="w-3 h-3" />
        {stats.total > 0 ? `${stats.active}/${stats.total}` : '--'}
      </span>
      <span className="text-xs text-bambu-gray/60 w-20 text-right cursor-default" title={t('printers.cameraGrid.stats.bandwidth')}>
        {stats.bw || '--'}
      </span>
      <span className="text-xs text-bambu-gray/60 w-12 text-right cursor-default" title={t('printers.cameraGrid.stats.uptime')}>
        {stats.uptime || '--'}
      </span>
    </>
  );
}

export interface GridToolbarProps {
  canChangeQuality: boolean;
  quality: string;
  qualityPending: boolean;
  onQualityChange: (q: CameraQuality) => void;
  onRestart: () => void;
  subscribeStats: (cb: () => void) => () => void;
  getStatsSnapshot: () => GridStreamStats;
  /** Kiosk idle — fade the toolbar out (fullscreen wall, no recent input). */
  hidden?: boolean;
}

/** Quality preset picker + stream refresh + live stats row above the wall. */
export function GridToolbar({
  canChangeQuality,
  quality,
  qualityPending,
  onQualityChange,
  onRestart,
  subscribeStats,
  getStatsSnapshot,
  hidden,
}: GridToolbarProps) {
  const { t } = useTranslation();
  // The preset is a server-side setting: changing it restarts producers and
  // affects every connected viewer — the hint keeps that from surprising users.
  const qualityHint = `${t('printers.cameraGrid.quality')} — ${t('printers.cameraGrid.qualityGlobalHint')}`;
  return (
    <div className={`flex items-center justify-end gap-3 mb-2 tabular-nums transition-opacity duration-500 ${hidden ? 'opacity-0 pointer-events-none' : ''}`}>
      {canChangeQuality && (
        <div className="flex h-6 items-center bg-bambu-dark rounded-md border border-bambu-dark-tertiary overflow-hidden" role="group" aria-label={qualityHint}>
          {QUALITY_OPTIONS.map(q => {
            const label = t(`printers.cameraGrid.${q}`);
            const isActive = quality === q;
            return (
              <button
                key={q}
                onClick={() => !isActive && onQualityChange(q)}
                disabled={qualityPending}
                className={`h-full px-1.5 text-[10px] font-medium transition-colors disabled:opacity-50 ${
                  isActive ? 'bg-bambu-green text-white' : 'text-bambu-gray/60 hover:text-white hover:bg-bambu-dark-tertiary'
                }`}
                title={`${qualityHint}: ${label}`}
                aria-pressed={isActive}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      <button
        onClick={onRestart}
        className="text-bambu-gray/60 hover:text-white transition-colors"
        title={t('printers.cameraGrid.refresh')}
        aria-label={t('printers.cameraGrid.refresh')}
      >
        <RefreshCw className="w-3.5 h-3.5" />
      </button>
      <GridStats subscribeStats={subscribeStats} getStatsSnapshot={getStatsSnapshot} />
    </div>
  );
}
