import { useEffect, useMemo, useRef, memo } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Clock,
  Loader2,
  Square,
  Pause,
  Play,
  RefreshCw,
  Signal,
  WifiOff,
  AlertTriangle,
  AlertCircle,
  Layers,
  Maximize2,
  Flame,
  Thermometer,
} from 'lucide-react';

import { formatDuration, formatETA } from '../../utils/date';
import type { TimeFormat } from '../../utils/date';
import type { HMSError } from '../../api/client';
import { Card } from '../Card';
import { getTopHMSError } from '../HMSErrorModal';
import type { GridLayout } from '../cameraGridLayout';
import { gridBlinkSyncStyle, gridCardHighlightClass } from '../cameraGridLayout';

/** State label color, keyed by the same stateKey used for the i18n label. */
const STATE_COLORS = {
  offline: 'text-bambu-gray/60',
  printing: 'text-bambu-green',
  paused: 'text-yellow-400',
  failed: 'text-red-400',
  // Blue matches the PrintersPage status legend and the pickup-ready border —
  // green is reserved for printing
  finished: 'text-blue-400',
  idle: 'text-bambu-green/60',
} as const;

/** MQTT state → i18n/status key; anything unknown reads as idle. */
const STATE_KEYS: Record<string, keyof typeof STATE_COLORS> = {
  RUNNING: 'printing',
  PAUSE: 'paused',
  FINISH: 'finished',
  FAILED: 'failed',
};

/** Video/canvas share the same fade + stale-blur presentation. */
const mediaClass = (hidden: boolean) => `w-full h-full object-cover ${hidden ? 'opacity-0' : 'opacity-100'}`;
const mediaStyle = (blurred: boolean): CSSProperties => ({
  filter: blurred ? 'blur(3px)' : 'none',
  transition: 'filter 0.6s ease-in-out, opacity 0.5s ease-in-out',
});

/** Stable callback bundle shared by every tile — one prop instead of seven. */
export interface GridCardHandlers {
  onPause?: (id: number, name: string) => void;
  onStop?: (id: number, name: string) => void;
  onResume?: (id: number, name: string) => void;
  onClearPlate?: (id: number) => void;
  onDismissError?: (id: number, description: string) => void;
  onExpand?: (id: number, name: string) => void;
  /** Toggle the in-grid 2×2 spotlight for this tile. */
  onSpotlight?: (id: number) => void;
}

/** Props shared by both the MJPEG and WebRTC grid cards. */
export interface GridCardBaseProps {
  printerId: number;
  printerName: string;
  connected: boolean;
  state: string | null;
  progress: number;
  remainingTime: number | null;
  layerNum: number | null;
  totalLayers: number | null;
  plateCleared: boolean;
  jobName?: string;
  nozzleTemp?: number | null;
  /** Dual-nozzle printers: which nozzle the shown temp belongs to. */
  activeNozzle?: 'L' | 'R';
  bedTemp?: number | null;
  clearPlateLoading?: boolean;
  layout: GridLayout;
  timeFormat?: TimeFormat;
  controlLoading?: 'pause' | 'stop' | 'resume' | null;
  hmsErrors?: HMSError[];
  hasQueuedJobs?: boolean;
  dismissedErrorDesc?: string;
  /** This tile is the wall's spotlight — spans 2×2 in the grid. */
  spotlighted?: boolean;
  handlers: GridCardHandlers;
}

export interface CameraGridCardProps extends GridCardBaseProps {
  canvasRef?: React.RefObject<HTMLCanvasElement | null>;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  loading: boolean;
  error: boolean;
  reconnecting: boolean;
  reconnectCountdown: number;
  reconnectAttempt: number;
  degraded?: boolean;
  stale?: boolean;
  onVisibilityChange?: (printerId: number, visible: boolean) => void;
  onRestart?: () => void;
}

/**
 * CameraGridCard — pure display component.
 * Receives a canvas ref from the parent CameraGrid.
 * Registers an IntersectionObserver to report visibility to the worker
 * so off-screen cards skip JPEG decoding entirely.
 *
 * Interactions: click toggles the in-grid spotlight (tile spans 2×2 in
 * place), double-click / Enter opens the full camera viewer.
 */
export const CameraGridCard = memo(function CameraGridCard({
  printerId,
  printerName,
  connected,
  state,
  progress,
  remainingTime,
  layerNum,
  totalLayers,
  canvasRef,
  videoRef,
  loading,
  error,
  reconnecting,
  reconnectCountdown,
  reconnectAttempt,
  onVisibilityChange,
  onRestart,
  plateCleared,
  jobName,
  nozzleTemp,
  activeNozzle,
  bedTemp,
  clearPlateLoading,
  layout,
  timeFormat,
  controlLoading,
  degraded,
  stale,
  hmsErrors,
  hasQueuedJobs,
  dismissedErrorDesc,
  spotlighted,
  handlers,
}: CameraGridCardProps) {
  const { t } = useTranslation();
  const { onPause, onStop, onResume, onClearPlate, onDismissError, onExpand, onSpotlight } = handlers;
  const cardRef = useRef<HTMLDivElement>(null);
  // IntersectionObserver for visibility tracking
  useEffect(() => {
    const el = cardRef.current;
    if (!el || !onVisibilityChange) return;
    const observer = new IntersectionObserver(
      ([entry]) => onVisibilityChange(printerId, entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [printerId, onVisibilityChange]);

  const stateKey = !connected ? 'offline' : (state && STATE_KEYS[state]) || 'idle';
  const stateColor = STATE_COLORS[stateKey];
  const isRunning = state === 'RUNNING';
  const isPaused = state === 'PAUSE';
  const textName = layout === 'compact' ? 'text-[11px]' : 'text-base';
  const textXs = layout === 'compact' ? 'text-[9px]' : 'text-[11px]';
  const iconSm = layout === 'compact' ? 'w-2.5 h-2.5' : 'w-3 h-3';
  const iconCtrl = layout === 'compact' ? 'w-3 h-3' : 'w-3.5 h-3.5';
  const barH = layout === 'compact' ? 'h-1' : 'h-1.5';
  const rawTopError = hmsErrors?.length ? getTopHMSError(hmsErrors) : null;
  const topError = rawTopError && dismissedErrorDesc === rawTopError.description ? null : rawTopError;

  // Border/glow per state (blinking border = operator action needed: paused,
  // pickup ready, failed); blink phase synced across all cards via epoch clock
  const highlightClass = gridCardHighlightClass({
    connected,
    state,
    plateCleared,
    hasQueuedJobs: hasQueuedJobs ?? false,
  });
  // Compute the epoch-sync delay once per blink stretch: writing a new
  // animation-delay to a running animation re-phases it, so a fresh
  // Date.now() on every status re-render would make the border jump.
  const isBlinking = highlightClass.includes('animate-grid-border-blink');
  const blinkSyncStyle = useMemo(
    () => (isBlinking ? gridBlinkSyncStyle('animate-grid-border-blink') : undefined),
    [isBlinking],
  );

  // Spotlight span — every layout has ≥2 columns from `sm` up; compact
  // already has 2 at base, so it can span everywhere.
  const spotlightClass = spotlighted
    ? layout === 'compact' ? 'col-span-2 row-span-2' : 'sm:col-span-2 sm:row-span-2'
    : '';

  return (
    <Card
      data-flip-key={printerId}
      className={`relative group transition-[border-color,box-shadow] duration-500 ${highlightClass} ${spotlightClass}`}
      style={blinkSyncStyle}
      ref={cardRef}
    >
      <div
        className="relative w-full aspect-video bg-black overflow-hidden rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-bambu-green"
        tabIndex={0}
        aria-label={printerName}
        onClick={onSpotlight ? (e) => {
          // Ignore clicks bubbling from overlay buttons (pause/stop/dismiss)
          if ((e.target as HTMLElement).closest('button')) return;
          onSpotlight(printerId);
        } : undefined}
        onDoubleClick={connected && onExpand ? (e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          onExpand(printerId, printerName);
        } : undefined}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' && connected && onExpand) {
            e.preventDefault();
            onExpand(printerId, printerName);
          } else if (e.key === ' ' && onSpotlight) {
            e.preventDefault();
            onSpotlight(printerId);
          }
        }}
      >
        {videoRef ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={mediaClass(loading || error || reconnecting || !connected)}
            style={mediaStyle(!!(connected && stale && !loading && !error && !reconnecting))}
          />
        ) : (
          <canvas
            ref={canvasRef}
            className={mediaClass(loading || error || reconnecting || !connected)}
            style={mediaStyle(!!(connected && stale && !loading && !error && !reconnecting))}
          />
        )}
        {connected && loading && !reconnecting && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-8 h-8 text-white/60 animate-spin" />
          </div>
        )}
        {connected && reconnecting && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-10">
            <div className="text-center">
              <WifiOff className="w-6 h-6 text-white/50 mx-auto mb-1.5" />
              <p className="text-xs text-white/70 mb-0.5">{t('printers.cameraGrid.connectionLost')}</p>
              <p className="text-[10px] text-white/40">
                {t('printers.cameraGrid.reconnecting', { countdown: reconnectCountdown, attempt: reconnectAttempt })}
              </p>
            </div>
          </div>
        )}
        {connected && error && !reconnecting && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
            <AlertCircle className="w-8 h-8 text-red-400" />
            <span className="text-xs text-white/50">{t('printers.cameraGrid.cameraUnavailable')}</span>
            {onRestart && (
              <button
                onClick={onRestart}
                className="mt-1 flex items-center gap-1 px-2 py-1 rounded bg-white/10 hover:bg-white/20 transition-colors text-xs text-white/70 hover:text-white"
              >
                <RefreshCw className="w-3 h-3" />
                {t('printers.cameraGrid.retry')}
              </button>
            )}
          </div>
        )}
        {!connected && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
            <WifiOff className="w-6 h-6 text-bambu-gray/40" />
            <span className={`${textXs} text-bambu-gray/40`}>{t('printers.status.offline')}</span>
          </div>
        )}
        {/* Paused: corner badge, not a full-screen cover — when a print pauses
            (runout, inspection) the operator needs to SEE the plate. The
            blinking yellow border already carries the at-a-distance signal. */}
        {isPaused && (
          <div className="absolute bottom-2 left-2 z-10 animate-grid-fade-in">
            <span className={`px-2 py-0.5 rounded bg-black/60 backdrop-blur-sm ${layout === 'compact' ? 'text-[10px]' : 'text-xs'} font-bold text-yellow-400 uppercase tracking-widest`}>
              {t('printers.status.paused')}
            </span>
          </div>
        )}
        {/* Printer name (top left) + temps while printing / status + controls (top right) */}
        <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/70 to-transparent px-3 py-1.5 flex items-center justify-between">
          <span className={`${textName} text-white font-medium drop-shadow-sm flex items-center gap-1 min-w-0`}>
            {printerName}
            {degraded && <span title={t('printers.cameraGrid.connectionLost')}><Signal className={`${iconSm} text-yellow-400 animate-pulse`} /></span>}
          </span>
          <div className="flex items-center gap-1">
            {/* Action buttons fade in on hover; always visible on touch devices */}
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 transition-opacity">
              {connected && onExpand && (
                <button
                  onClick={() => onExpand(printerId, printerName)}
                  className="p-1 rounded bg-white/10 hover:bg-white/40 transition-colors"
                  title={t('printers.cameraGrid.expand')}
                  aria-label={t('printers.cameraGrid.expand')}
                >
                  <Maximize2 className={`${iconCtrl} text-white/60 hover:text-white transition-colors`} />
                </button>
              )}
              {isRunning && onPause && (
                <button
                  onClick={() => onPause(printerId, printerName)}
                  disabled={!!controlLoading}
                  className="p-1 rounded bg-white/10 hover:bg-white/40 transition-colors disabled:opacity-40"
                  title={t('printers.pause')}
                  aria-label={t('printers.pause')}
                >
                  {controlLoading === 'pause'
                    ? <Loader2 className={`${iconCtrl} text-white animate-spin`} />
                    : <Pause className={`${iconCtrl} text-white/60 hover:text-white transition-colors`} />}
                </button>
              )}
              {isPaused && onResume && (
                <button
                  onClick={() => onResume(printerId, printerName)}
                  disabled={!!controlLoading}
                  className="p-1 rounded bg-white/10 hover:bg-white/40 transition-colors disabled:opacity-40"
                  title={t('printers.resume')}
                  aria-label={t('printers.resume')}
                >
                  {controlLoading === 'resume'
                    ? <Loader2 className={`${iconCtrl} text-white animate-spin`} />
                    : <Play className={`${iconCtrl} text-white/60 hover:text-white transition-colors`} />}
                </button>
              )}
              {(isRunning || isPaused) && onStop && (
                <button
                  onClick={() => onStop(printerId, printerName)}
                  disabled={!!controlLoading}
                  className="p-1 rounded bg-white/10 hover:bg-red-500/60 transition-colors disabled:opacity-40"
                  title={t('printers.stop')}
                  aria-label={t('printers.stop')}
                >
                  {controlLoading === 'stop'
                    ? <Loader2 className={`${iconCtrl} text-white animate-spin`} />
                    : <Square className={`${iconCtrl} text-white/60 hover:text-white transition-colors`} />}
                </button>
              )}
            </div>
            {(isRunning || isPaused) ? (
              connected && layout !== 'compact' && (nozzleTemp != null || bedTemp != null) && (
                <div className="flex items-center gap-2 text-[10px] text-white/70 tabular-nums drop-shadow-sm">
                  {nozzleTemp != null && (
                    <span
                      className="flex items-center gap-0.5 cursor-default"
                      title={activeNozzle ? `${t('printers.temperatures.nozzle')} (${activeNozzle})` : t('printers.temperatures.nozzle')}
                    >
                      <Flame className={`${iconSm} text-orange-400`} />
                      {activeNozzle && <span className="text-white/50">{activeNozzle}</span>}
                      {Math.round(nozzleTemp)}°
                    </span>
                  )}
                  {bedTemp != null && (
                    <span className="flex items-center gap-0.5 cursor-default" title={t('printers.temperatures.bed')}>
                      <Thermometer className={`${iconSm} text-blue-400`} />
                      {Math.round(bedTemp)}°
                    </span>
                  )}
                </div>
              )
            ) : (
              <span className={`${textXs} font-medium drop-shadow-sm uppercase ${stateColor} ${state === 'FAILED' ? 'animate-grid-opacity-blink' : ''}`} style={state === 'FAILED' ? blinkSyncStyle : undefined}>{t(`printers.status.${stateKey}`)}</span>
            )}
          </div>
        </div>
        {/* HMS Error notification — click to dismiss */}
        {topError && (
          <button
            onClick={() => onDismissError?.(printerId, topError.description)}
            className={`absolute left-2 right-2 ${layout === 'compact' ? 'top-7' : 'top-8'} z-20 flex items-start gap-1.5 px-2 py-1.5 rounded-md shadow-lg border backdrop-blur-sm cursor-pointer hover:opacity-80 transition-opacity text-left animate-grid-slide-in-top ${
              topError.severity <= 2
                ? 'bg-red-900/90 border-red-500/50 text-red-100'
                : 'bg-red-900/80 border-red-500/40 text-red-200'
            }`}
            title={t('printers.clickToDismiss')}
          >
            <AlertTriangle className={`w-4 h-4 shrink-0 mt-0.5 ${topError.severity <= 2 ? 'text-red-300' : 'text-red-400'}`} />
            <span className={`${textXs} leading-tight line-clamp-2 text-red-200`}>{topError.description}</span>
          </button>
        )}
      </div>
      {/* Progress bar + details — bottom (outside overflow-hidden so tooltip can escape) */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-3 py-2 rounded-b-xl">
        {(state === 'RUNNING' || state === 'PAUSE') && (
          <>
            {jobName && layout !== 'compact' && (
              <div className={`${textXs} text-white/70 truncate mb-0.5`} title={jobName}>{jobName}</div>
            )}
            <div className={`flex items-center justify-between ${textXs} text-white/80 mb-1 tabular-nums`}>
              <div className="flex items-center gap-2">
                {remainingTime != null && (
                  <span className="relative flex items-center gap-0.5 group/eta cursor-default">
                    <Clock className={iconSm} />
                    {remainingTime > 0 ? formatDuration(remainingTime * 60) : '--'}
                    {remainingTime > 0 && (
                      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 rounded-md bg-bambu-dark-tertiary text-white text-[10px] font-medium whitespace-nowrap opacity-0 scale-95 group-hover/eta:opacity-100 group-hover/eta:scale-100 transition-all duration-150 shadow-lg border border-white/10 z-50">
                        ETA {formatETA(remainingTime, timeFormat, t)}
                        <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-bambu-dark-tertiary" />
                      </span>
                    )}
                  </span>
                )}
                {layerNum != null && totalLayers != null && totalLayers > 0 && (
                  <span className="flex items-center gap-0.5">
                    <Layers className={iconSm} />
                    {layerNum}/{totalLayers}
                  </span>
                )}
              </div>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className={`bg-white/20 rounded-full ${barH}`}>
              <div
                className={`${state === 'PAUSE' ? 'bg-yellow-400' : 'bg-bambu-green'} ${barH} rounded-full transition-all`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </>
        )}
        {(state === 'FINISH' || state === 'FAILED') && !plateCleared && hasQueuedJobs && onClearPlate && (
          <button
            onClick={() => onClearPlate(printerId)}
            disabled={clearPlateLoading}
            className="w-full py-1.5 rounded-lg bg-bambu-green text-white text-xs font-semibold hover:bg-bambu-green/80 transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50 animate-grid-slide-in-bottom"
          >
            {clearPlateLoading ? (
              <Loader2 className={`${iconSm} animate-spin`} />
            ) : null}
            {t('queue.clearPlate')}
          </button>
        )}
      </div>
    </Card>
  );
});
