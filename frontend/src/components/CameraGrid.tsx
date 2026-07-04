import { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore, memo } from 'react';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
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
  Video,
  Flame,
  Thermometer,
} from 'lucide-react';

import { api } from '../api/client';
import { formatDuration, formatETA, formatUptime } from '../utils/date';
import type { HMSError, CameraQuality } from '../api/client';
import { Card } from './Card';
import { ConfirmModal } from './ConfirmModal';
import { getTopHMSError } from './HMSErrorModal';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useGridStream } from '../hooks/useGridStream';
import { useFlipReorder } from '../hooks/useFlipReorder';
import type { GridStreamStats } from '../hooks/useGridStream';
import { useWebRTCStream } from '../hooks/useWebRTCStream';
import type { WebRTCPrinterStats } from '../hooks/useWebRTCStream';
import { formatFileSize } from '../utils/file';
import type { GridLayout } from './cameraGridLayout';
import { GRID_LAYOUT_COLS } from './cameraGridLayout';
export type { GridLayout } from './cameraGridLayout';
export { GRID_LAYOUT_COLS, GRID_LAYOUT_ICONS } from './cameraGridLayout';

/** How long the tab must stay hidden before camera streams are suspended. */
const HIDDEN_SUSPEND_DELAY_MS = 15_000;

/** State label color, keyed by the same stateKey used for the i18n label. */
const STATE_COLORS = {
  offline: 'text-bambu-gray/60',
  printing: 'text-bambu-green',
  paused: 'text-yellow-400',
  failed: 'text-red-400',
  finished: 'text-bambu-green',
  idle: 'text-bambu-green/60',
} as const;

/** Printer info consumed by the camera grid, derived from printer + live status. */
export interface GridPrinter {
  id: number;
  name: string;
  model: string | null;
  connected: boolean;
  state: string | null;
  progress: number;
  remainingTime: number | null;
  layerNum: number | null;
  totalLayers: number | null;
  plateCleared: boolean;
  hmsErrors?: HMSError[];
  jobName?: string;
  nozzleTemp?: number | null;
  bedTemp?: number | null;
  supports_rtsp?: boolean;
}

/** Props shared by both the MJPEG and WebRTC grid cards. */
interface GridCardBaseProps {
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
  bedTemp?: number | null;
  clearPlateLoading?: boolean;
  layout: GridLayout;
  timeFormat?: 'system' | '12h' | '24h';
  controlLoading?: 'pause' | 'stop' | 'resume' | null;
  hmsErrors?: HMSError[];
  hasQueuedJobs?: boolean;
  dismissedErrorDesc?: string;
  onPause?: (id: number, name: string) => void;
  onStop?: (id: number, name: string) => void;
  onResume?: (id: number, name: string) => void;
  onClearPlate?: (id: number) => void;
  onDismissError?: (id: number, description: string) => void;
  onExpand?: (id: number, name: string) => void;
}

interface CameraGridCardProps extends GridCardBaseProps {
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
 */
const CameraGridCard = memo(function CameraGridCard({
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
  onPause,
  onStop,
  onResume,
  onVisibilityChange,
  onClearPlate,
  onRestart,
  plateCleared,
  jobName,
  nozzleTemp,
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
  onDismissError,
  onExpand,
}: CameraGridCardProps) {
  const { t } = useTranslation();
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

  const stateKey = !connected ? 'offline' : state === 'RUNNING' ? 'printing' : state === 'PAUSE' ? 'paused' : state === 'FINISH' ? 'finished' : state === 'FAILED' ? 'failed' : 'idle';
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

  return (
    <Card
      data-flip-key={printerId}
      // Paused uses a keyframe animation for the border, so its branch must not
      // carry an !border-* class — !important declarations beat CSS animations
      className={`relative group transition-[border-color,box-shadow] duration-500 ${
        isRunning
          ? '!border-bambu-green !shadow-[0_0_10px_1px_color-mix(in_srgb,var(--accent)_35%,transparent)]'
          : isPaused
            ? 'animate-grid-border-blink'
            : '!border-transparent'
      }`}
      ref={cardRef}
    >
      <div
        className="relative w-full aspect-video bg-black overflow-hidden rounded-xl"
        onDoubleClick={connected && onExpand ? (e) => {
          // Ignore double-clicks on overlay buttons (pause/stop/dismiss) —
          // they bubble up from inside this container
          if ((e.target as HTMLElement).closest('button')) return;
          onExpand(printerId, printerName);
        } : undefined}
      >
        {videoRef ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`w-full h-full object-cover ${loading || error || reconnecting || !connected ? 'opacity-0' : 'opacity-100'}`}
            style={{
              filter: connected && stale && !loading && !error && !reconnecting ? 'blur(3px)' : 'none',
              transition: 'filter 0.6s ease-in-out, opacity 0.5s ease-in-out',
            }}
          />
        ) : (
          <canvas
            ref={canvasRef}
            className={`w-full h-full object-cover ${loading || error || reconnecting || !connected ? 'opacity-0' : 'opacity-100'}`}
            style={{
              filter: connected && stale && !loading && !error && !reconnecting ? 'blur(3px)' : 'none',
              transition: 'filter 0.6s ease-in-out, opacity 0.5s ease-in-out',
            }}
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
        {/* State overlay — paused only */}
        {isPaused && (
          <div className="absolute inset-0 flex items-center justify-center animate-grid-fade-in">
            <div className="absolute inset-0 bg-black/50" />
            <span className={`relative ${layout === 'compact' ? 'text-xl' : 'text-3xl'} font-bold text-yellow-400 uppercase tracking-widest drop-shadow-lg`}>{t('printers.status.paused')}</span>
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
                    <span className="flex items-center gap-0.5 cursor-default" title={t('printers.temperatures.nozzle')}>
                      <Flame className={`${iconSm} text-orange-400`} />
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
              <span className={`${textXs} font-medium drop-shadow-sm uppercase ${stateColor} ${state === 'FAILED' ? 'animate-pulse' : ''}`}>{t(`printers.status.${stateKey}`)}</span>
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

/** StatsDisplay — subscribes to stats changes without re-rendering CameraGrid */
function StatsDisplay({ subscribeStats, getStatsSnapshot }: {
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

interface WebRTCGridCardProps extends GridCardBaseProps {
  onStats?: (id: number, stats: WebRTCPrinterStats) => void;
  restartKey?: number;
  /** Tab hidden — tear down the WebRTC connection to save CPU/bandwidth. */
  suspended?: boolean;
}

/**
 * WebRTCGridCard — wraps CameraGridCard with an individual useWebRTCStream connection.
 * Used for RTSP-capable printers when camera_engine is 'go2rtc'.
 */
const WebRTCGridCard = memo(function WebRTCGridCard({ onStats, restartKey, suspended, ...cardProps }: WebRTCGridCardProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const {
    isLoading,
    hasError,
    isReconnecting,
    reconnectCountdown,
    reconnectAttempt,
    stale,
    degraded,
    restart,
  } = useWebRTCStream({
    printerId: cardProps.printerId,
    enabled: cardProps.connected && !suspended,
    videoRef,
    onStats,
    restartKey,
  });

  return (
    <CameraGridCard
      {...cardProps}
      videoRef={videoRef}
      loading={isLoading}
      error={hasError}
      reconnecting={isReconnecting}
      reconnectCountdown={reconnectCountdown}
      reconnectAttempt={reconnectAttempt}
      degraded={degraded}
      stale={stale}
      onRestart={restart}
    />
  );
});

/**
 * CameraGrid — manages a SINGLE multiplexed HTTP connection for all cameras.
 *
 * Uses `GET /camera/grid-stream?ids=1,2,3` (quality preset resolved
 * server-side from settings), which returns binary-framed JPEG data:
 * [4B printer_id LE][4B length LE][jpeg]
 *
 * When camera_engine is 'go2rtc', RTSP-capable printers (X1/H2/P2) use
 * individual WebRTC connections via go2rtc for zero-transcode streaming.
 * Chamber cameras (A1/P1) still use the MJPEG grid stream.
 *
 * Optimisations:
 *  - Web Worker: JPEG decoding (createImageBitmap) runs off the main thread;
 *    decoded ImageBitmaps are transferred back for cheap drawImage on main thread
 *  - IntersectionObserver: off-screen cards skip decoding entirely
 *  - Exponential-backoff reconnect: auto-retries on stream drop (2s -> 30s, no cap)
 */
export function CameraGrid({
  printers,
  layout,
  timeFormat,
  onExpand,
}: {
  printers: GridPrinter[];
  layout: GridLayout;
  timeFormat?: 'system' | '12h' | '24h';
  onExpand?: (id: number, name: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();

  // Dismissed HMS errors per printer
  const [dismissedErrors, setDismissedErrors] = useState<Map<number, string>>(new Map());

  // Print control — confirmation modal
  const [confirmAction, setConfirmAction] = useState<{ type: 'pause' | 'stop' | 'resume'; printerId: number; printerName: string } | null>(null);

  const pauseMutation = useMutation({
    mutationFn: (id: number) => api.pausePrint(id),
    onSuccess: (_, id) => { showToast(t('printers.toast.printPaused')); queryClient.invalidateQueries({ queryKey: ['printerStatus', id] }); },
    onError: (err: Error) => showToast(err.message || t('printers.toast.failedToPausePrint'), 'error'),
  });
  const stopMutation = useMutation({
    mutationFn: (id: number) => api.stopPrint(id),
    onSuccess: (_, id) => { showToast(t('printers.toast.printStopped')); queryClient.invalidateQueries({ queryKey: ['printerStatus', id] }); },
    onError: (err: Error) => showToast(err.message || t('printers.toast.failedToStopPrint'), 'error'),
  });
  const resumeMutation = useMutation({
    mutationFn: (id: number) => api.resumePrint(id),
    onSuccess: (_, id) => { showToast(t('printers.toast.printResumed')); queryClient.invalidateQueries({ queryKey: ['printerStatus', id] }); },
    onError: (err: Error) => showToast(err.message || t('printers.toast.failedToResumePrint'), 'error'),
  });
  const clearPlateMutation = useMutation({
    mutationFn: (id: number) => api.clearPlate(id),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['queue', id] });
      queryClient.invalidateQueries({ queryKey: ['printerStatus', id] });
      showToast(t('queue.clearPlateSuccess'), 'success');
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  });
  const handleConfirm = () => {
    if (!confirmAction) return;
    const { type, printerId } = confirmAction;
    if (type === 'pause') pauseMutation.mutate(printerId);
    else if (type === 'stop') stopMutation.mutate(printerId);
    else if (type === 'resume') resumeMutation.mutate(printerId);
    setConfirmAction(null);
  };

  // Stable callback props — setState setters are stable, so [] deps is correct
  const canControl = hasPermission('printers:control');
  const canClearPlate = hasPermission('printers:clear_plate');
  const handlePause = useCallback((id: number, name: string) => {
    setConfirmAction({ type: 'pause', printerId: id, printerName: name });
  }, []);
  const handleStop = useCallback((id: number, name: string) => {
    setConfirmAction({ type: 'stop', printerId: id, printerName: name });
  }, []);
  const handleResume = useCallback((id: number, name: string) => {
    setConfirmAction({ type: 'resume', printerId: id, printerName: name });
  }, []);
  const handleClearPlate = useCallback((id: number) => {
    clearPlateMutation.mutate(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const handleDismissError = useCallback((id: number, description: string) => {
    setDismissedErrors(prev => new Map(prev).set(id, description));
  }, []);

  // Fetch pending queue items only for printers that could show the "Clear Plate" button
  const finishedPrinterIds = useMemo(
    () => printers.filter(p => p.state === 'FINISH' || p.state === 'FAILED').map(p => p.id),
    [printers],
  );
  const queueQueries = useQueries({
    queries: finishedPrinterIds.map(id => ({
      queryKey: ['queue', id, 'pending'],
      queryFn: () => api.getQueue(id, 'pending'),
      staleTime: 30_000,
    })),
  });
  const printersWithQueue = useMemo(() => {
    const set = new Set<number>();
    queueQueries.forEach((q, i) => {
      if (q.data?.length) set.add(finishedPrinterIds[i]);
    });
    return set;
  }, [queueQueries, finishedPrinterIds]);

  // Grid stream quality — preset values are resolved server-side from settings
  const { data: cameraSettings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });
  const gridParamsKey = cameraSettings?.camera_quality ?? 'auto';
  const cameraEngine = cameraSettings?.camera_engine ?? 'ffmpeg';

  // Quality preset picker — persists the global setting; the backend stops all
  // producers on change and the gridParamsKey change restarts our stream
  const canChangeQuality = hasPermission('settings:update');
  const qualityMutation = useMutation({
    mutationFn: (value: CameraQuality) => api.updateSettings({ camera_quality: value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  // Suspend all streams when the tab has been hidden for a while — backend
  // producers auto-stop 30s after their last viewer, dropping ffmpeg CPU and
  // bandwidth to zero for backgrounded tabs. Resume is instant on return
  // (the '' → non-empty ids fast path below skips the debounce).
  const [suspended, setSuspended] = useState(false);
  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const onVisibilityChange = () => {
      if (document.hidden) {
        hideTimer = setTimeout(() => setSuspended(true), HIDDEN_SUSPEND_DELAY_MS);
      } else {
        if (hideTimer !== null) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
        setSuspended(false);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      if (hideTimer !== null) clearTimeout(hideTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  // When go2rtc is active, split printers: RTSP models → WebRTC, chamber models → MJPEG grid.
  // Stable-sort connected printers first so offline tiles sink to the end of the wall.
  // gridPrinters keeps the full sorted list for rendering — tiles interleave both
  // stream types so the ETA sort stays correct across mixed fleets.
  const { gridPrinters, mjpegPrinters, webrtcPrinters } = useMemo(() => {
    const sorted = [...printers].sort((a, b) => Number(b.connected) - Number(a.connected));
    if (cameraEngine !== 'go2rtc') {
      return { gridPrinters: sorted, mjpegPrinters: sorted, webrtcPrinters: [] as GridPrinter[] };
    }
    const mjpeg: GridPrinter[] = [];
    const webrtc: GridPrinter[] = [];
    for (const p of sorted) {
      if (p.supports_rtsp) {
        webrtc.push(p);
      } else {
        mjpeg.push(p);
      }
    }
    return { gridPrinters: sorted, mjpegPrinters: mjpeg, webrtcPrinters: webrtc };
  }, [printers, cameraEngine]);

  // Only stream connected printers — the backend would otherwise spawn ffmpeg
  // against unreachable printers and slow-retry them forever. Offline cards
  // still render (with the offline overlay); they join the stream once the
  // printer reconnects and the debounced ids key updates.
  const rawPrinterIdsKey = suspended
    ? ''
    : mjpegPrinters
        .filter(p => p.connected)
        .map(p => p.id)
        .sort((a, b) => a - b)
        .join(',');

  // Debounce printerIdsKey so transient printer list changes don't tear down the stream
  const [printerIdsKey, setPrinterIdsKey] = useState(rawPrinterIdsKey);
  useEffect(() => {
    if (printerIdsKey === '' && rawPrinterIdsKey !== '') {
      setPrinterIdsKey(rawPrinterIdsKey);
      return;
    }
    const timer = setTimeout(() => setPrinterIdsKey(rawPrinterIdsKey), 2000);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawPrinterIdsKey]);

  // Restart key — incrementing tears down and re-initializes all camera streams
  const [restartKey, setRestartKey] = useState(0);

  // Stream management via extracted hook
  const {
    canvasRefs,
    loadingSet,
    errorSet,
    degradedSet,
    staleSet,
    reconnectingSet,
    reconnectCountdown,
    reconnectAttempt,
    getStatsSnapshot: getMjpegStatsSnapshot,
    handleVisibilityChange,
  } = useGridStream({ printerIdsKey, gridParamsKey, restartKey });

  // WebRTC stats registry — each WebRTCGridCard reports its bandwidth here
  const webrtcStatsRegistry = useRef<Map<number, WebRTCPrinterStats>>(new Map());
  const handleWebRTCStats = useCallback((id: number, stats: WebRTCPrinterStats) => {
    webrtcStatsRegistry.current.set(id, stats);
  }, []);

  // Clean stale registry entries when webrtcPrinters changes
  const webrtcPrinterIdsKey = webrtcPrinters.map(p => p.id).sort((a, b) => a - b).join(',');
  useEffect(() => {
    const activeIds = new Set(webrtcPrinterIdsKey ? webrtcPrinterIdsKey.split(',').map(Number) : []);
    for (const id of webrtcStatsRegistry.current.keys()) {
      if (!activeIds.has(id)) webrtcStatsRegistry.current.delete(id);
    }
  }, [webrtcPrinterIdsKey]);

  // Combined stats (MJPEG + WebRTC) via ref + subscriber pattern
  const combinedStatsRef = useRef<GridStreamStats>({ bw: '', active: 0, total: 0, uptime: '', rawBytesPerSecond: 0, droppedFrames: 0 });
  const combinedSubscribers = useRef(new Set<() => void>());
  const subscribeCombinedStats = useCallback((cb: () => void) => {
    combinedSubscribers.current.add(cb);
    return () => { combinedSubscribers.current.delete(cb); };
  }, []);
  const getCombinedStatsSnapshot = useCallback(() => combinedStatsRef.current, []);

  // Track WebRTC-only uptime for when no MJPEG stream exists
  const webrtcStartRef = useRef<number>(0);
  useEffect(() => {
    if (webrtcPrinters.length > 0 && webrtcStartRef.current === 0) {
      webrtcStartRef.current = performance.now();
    } else if (webrtcPrinters.length === 0) {
      webrtcStartRef.current = 0;
    }
  }, [webrtcPrinters.length]);

  // Combined stats interval — merge MJPEG + WebRTC every 1s
  useEffect(() => {
    const interval = setInterval(() => {
      if (suspended) return;
      const mjpeg = getMjpegStatsSnapshot();
      const now = performance.now();
      const FRESHNESS = 3000;

      // Sum WebRTC bandwidth from fresh registry entries
      let webrtcBytes = 0;
      let webrtcActiveCount = 0;
      for (const [, stats] of webrtcStatsRegistry.current) {
        if (now - stats.timestamp < FRESHNESS) {
          webrtcBytes += stats.bytesPerSecond;
          webrtcActiveCount++;
        }
      }

      const totalBytes = mjpeg.rawBytesPerSecond + webrtcBytes;
      const hasMjpeg = mjpegPrinters.length > 0 && mjpeg.uptime !== '';
      const hasWebrtc = webrtcPrinters.length > 0;

      // Uptime: prefer MJPEG uptime if stream exists, else compute from WebRTC start
      let uptime = mjpeg.uptime;
      if (!hasMjpeg && hasWebrtc && webrtcStartRef.current > 0) {
        uptime = formatUptime(Math.floor((now - webrtcStartRef.current) / 1000));
      }

      combinedStatsRef.current = {
        bw: totalBytes > 0 ? `${formatFileSize(totalBytes)}/s` : (hasMjpeg || hasWebrtc ? '0 B/s' : ''),
        active: mjpeg.active + webrtcActiveCount,
        total: mjpegPrinters.length + webrtcPrinters.length,
        uptime,
        rawBytesPerSecond: totalBytes,
        droppedFrames: mjpeg.droppedFrames,
      };
      combinedSubscribers.current.forEach(cb => cb());
    }, 1000);

    return () => clearInterval(interval);
  }, [getMjpegStatsSnapshot, mjpegPrinters.length, webrtcPrinters.length, suspended]);

  // Slide tiles to their new slots when the sort order changes (ETA sort
  // reorders live as statuses update)
  const gridRef = useRef<HTMLDivElement>(null);
  const orderKey = gridPrinters.map(p => p.id).join(',');
  useFlipReorder(gridRef, orderKey);

  const getControlLoading = useCallback((id: number) =>
    (pauseMutation.isPending && pauseMutation.variables === id) ? 'pause' as const
    : (stopMutation.isPending && stopMutation.variables === id) ? 'stop' as const
    : (resumeMutation.isPending && resumeMutation.variables === id) ? 'resume' as const
    : null
  , [pauseMutation.isPending, pauseMutation.variables, stopMutation.isPending, stopMutation.variables, resumeMutation.isPending, resumeMutation.variables]);

  if (printers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-bambu-gray/60">
        <WifiOff className="w-8 h-8" />
        <p className="text-sm">{t('printers.camWall.noPrinters')}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-end gap-3 mb-2 tabular-nums">
        {canChangeQuality && (
          <div className="flex h-6 items-center bg-bambu-dark rounded-md border border-bambu-dark-tertiary overflow-hidden" role="group" aria-label={t('printers.cameraGrid.quality')}>
            {(['auto', 'low', 'medium', 'high'] as const).map(q => {
              const label = t(`printers.cameraGrid.${q}`);
              const isActive = gridParamsKey === q;
              return (
                <button
                  key={q}
                  onClick={() => !isActive && qualityMutation.mutate(q)}
                  disabled={qualityMutation.isPending}
                  className={`h-full px-1.5 text-[10px] font-medium transition-colors disabled:opacity-50 ${
                    isActive ? 'bg-bambu-green text-white' : 'text-bambu-gray/60 hover:text-white hover:bg-bambu-dark-tertiary'
                  }`}
                  title={`${t('printers.cameraGrid.quality')}: ${label}`}
                  aria-pressed={isActive}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
        <button
          onClick={() => setRestartKey(k => k + 1)}
          className="text-bambu-gray/60 hover:text-white transition-colors"
          title={t('printers.cameraGrid.refresh')}
          aria-label={t('printers.cameraGrid.refresh')}
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <StatsDisplay subscribeStats={subscribeCombinedStats} getStatsSnapshot={getCombinedStatsSnapshot} />
      </div>
      <div ref={gridRef} className={`grid ${layout === 'compact' ? 'gap-2' : 'gap-4'} ${GRID_LAYOUT_COLS[layout]}`}>
        {/* One interleaved list in sort order — each tile picks its stream type
            (go2rtc: RTSP models via WebRTC, chamber models via the MJPEG grid) */}
        {gridPrinters.map(p => {
          const shared = {
            printerId: p.id,
            printerName: p.name,
            connected: p.connected,
            state: p.state,
            progress: p.progress,
            remainingTime: p.remainingTime,
            layerNum: p.layerNum,
            totalLayers: p.totalLayers,
            onPause: canControl ? handlePause : undefined,
            onStop: canControl ? handleStop : undefined,
            onResume: canControl ? handleResume : undefined,
            controlLoading: getControlLoading(p.id),
            onClearPlate: canClearPlate ? handleClearPlate : undefined,
            plateCleared: p.plateCleared,
            jobName: p.jobName,
            nozzleTemp: p.nozzleTemp,
            bedTemp: p.bedTemp,
            clearPlateLoading: clearPlateMutation.isPending && clearPlateMutation.variables === p.id,
            layout,
            timeFormat,
            hmsErrors: p.hmsErrors,
            dismissedErrorDesc: dismissedErrors.get(p.id),
            hasQueuedJobs: printersWithQueue.has(p.id),
            onDismissError: handleDismissError,
            onExpand,
          };
          return cameraEngine === 'go2rtc' && p.supports_rtsp ? (
            <WebRTCGridCard
              key={p.id}
              {...shared}
              onStats={handleWebRTCStats}
              restartKey={restartKey}
              suspended={suspended}
            />
          ) : (
            <CameraGridCard
              key={p.id}
              {...shared}
              canvasRef={canvasRefs.current.get(p.id)}
              loading={loadingSet.has(p.id)}
              error={errorSet.has(p.id)}
              reconnecting={reconnectingSet.has(p.id)}
              reconnectCountdown={reconnectingSet.has(p.id) ? reconnectCountdown : 0}
              reconnectAttempt={reconnectingSet.has(p.id) ? reconnectAttempt : 0}
              onVisibilityChange={handleVisibilityChange}
              degraded={degradedSet.has(p.id)}
              stale={staleSet.has(p.id)}
            />
          );
        })}
      </div>

      {/* Print control confirmation modal */}
      {confirmAction && (
        <ConfirmModal
          title={t(`printers.confirm.${confirmAction.type}Title`)}
          message={t(`printers.confirm.${confirmAction.type}Message`, { name: confirmAction.printerName })}
          confirmText={t(`printers.confirm.${confirmAction.type}Button`)}
          variant={confirmAction.type === 'stop' ? 'danger' : 'default'}
          onConfirm={handleConfirm}
          onCancel={() => setConfirmAction(null)}
        />
      )}

    </div>
  );
}
