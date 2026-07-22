import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { WifiOff } from 'lucide-react';

import { api } from '../api/client';
import type { HMSError, CameraQuality } from '../api/client';
import type { TimeFormat } from '../utils/date';
import { ConfirmModal } from './ConfirmModal';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useGridStream } from '../hooks/useGridStream';
import { useCombinedGridStats } from '../hooks/useCombinedGridStats';
import { useFlipReorder } from '../hooks/useFlipReorder';
import { useIdleHide } from '../hooks/useIdleHide';
import { useStaggeredEntrance } from '../hooks/useStaggeredEntrance';
import type { GridLayout } from './cameraGridLayout';
import { GRID_LAYOUT_COLS } from './cameraGridLayout';
import { CameraGridCard } from './cameraGrid/CameraGridCard';
import type { GridCardHandlers } from './cameraGrid/CameraGridCard';
import { WebRTCGridCard } from './cameraGrid/WebRTCGridCard';
import { GridToolbar } from './cameraGrid/GridToolbar';

/** How long the tab must stay hidden before camera streams are suspended. */
const HIDDEN_SUSPEND_DELAY_MS = 15_000;
/** Debounce on the streamed printer-id set — transient list changes must not tear down the stream. */
const IDS_DEBOUNCE_MS = 2_000;
/** Fullscreen wall: hide cursor + toolbar after this much input silence. */
const KIOSK_IDLE_MS = 4_000;

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
  /** Dual-nozzle printers: which nozzle the shown temp belongs to. */
  activeNozzle?: 'L' | 'R';
  bedTemp?: number | null;
  supports_rtsp?: boolean;
}

/**
 * Wall order: active prints float to the front sorted by soonest ETA, then
 * failed tiles needing attention, then finished/idle, then offline last.
 * ETA → Failed → Finish/Idle → Offline. Paused jobs keep their ETA so they
 * sort alongside running prints (and render double-size, see spotlight below).
 */
function etaTier(p: GridPrinter): number {
  if (!p.connected) return 3; // offline last
  const active = p.state === 'RUNNING' || p.state === 'PAUSE';
  if (active && p.remainingTime != null && p.remainingTime > 0) return 0; // active with ETA
  if (p.state === 'FAILED') return 1; // failed
  return 2; // finish / idle (incl. active without an ETA yet)
}

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
  fullscreen,
}: {
  printers: GridPrinter[];
  layout: GridLayout;
  timeFormat?: TimeFormat;
  onExpand?: (id: number, name: string) => void;
  /** Fullscreen wall mode — enables kiosk idle-hide of cursor and toolbar. */
  fullscreen?: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();

  // Dismissed HMS errors per printer
  const [dismissedErrors, setDismissedErrors] = useState<Map<number, string>>(new Map());

  // A dismissal only mutes the CURRENT occurrence: once a printer's error list
  // clears (or the printer leaves the wall), drop it so the next occurrence of
  // the same error surfaces again.
  useEffect(() => {
    setDismissedErrors(prev => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Map(prev);
      for (const id of prev.keys()) {
        const p = printers.find(pp => pp.id === id);
        if (!p || !p.hmsErrors?.length) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [printers]);

  // In-grid spotlight — the clicked tile spans 2×2 in place
  const [spotlightId, setSpotlightId] = useState<number | null>(null);

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
  const handleSpotlight = useCallback((id: number) => {
    setSpotlightId(prev => (prev === id ? null : id));
  }, []);

  // One stable bundle for every tile — halves the per-card prop surface while
  // data props stay flat primitives so memo comparisons remain cheap.
  const handlers = useMemo<GridCardHandlers>(() => ({
    onPause: canControl ? handlePause : undefined,
    onStop: canControl ? handleStop : undefined,
    onResume: canControl ? handleResume : undefined,
    onClearPlate: canClearPlate ? handleClearPlate : undefined,
    onDismissError: handleDismissError,
    onExpand,
    onSpotlight: handleSpotlight,
  }), [canControl, canClearPlate, handlePause, handleStop, handleResume, handleClearPlate, handleDismissError, onExpand, handleSpotlight]);

  // Fetch pending queue items only for printers that could show the "Clear Plate" button
  const finishedPrinterIds = useMemo(
    () => printers.filter(p => p.state === 'FINISH' || p.state === 'FAILED').map(p => p.id),
    [printers],
  );
  // combine returns a primitive key (stable by value) rather than a Set —
  // structural sharing doesn't cover Sets, so a Set here would be a fresh
  // reference every render and churn the triage-sort memo below.
  const printersWithQueueKey = useQueries({
    queries: finishedPrinterIds.map(id => ({
      queryKey: ['queue', id, 'pending'],
      queryFn: () => api.getQueue(id, 'pending'),
      staleTime: 30_000,
    })),
    combine: (results) =>
      results
        .map((q, i) => (q.data?.length ? finishedPrinterIds[i] : null))
        .filter((id): id is number => id !== null)
        .join(','),
  });
  const printersWithQueue = useMemo(
    () => new Set(printersWithQueueKey ? printersWithQueueKey.split(',').map(Number) : []),
    [printersWithQueueKey],
  );

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
  const handleQualityChange = useCallback((q: CameraQuality) => qualityMutation.mutate(q),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  []);

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

  // Kiosk mode: on the fullscreen wall, hide cursor + toolbar after idle input
  const kioskIdle = useIdleHide(!!fullscreen, KIOSK_IDLE_MS);

  // Order the wall ETA-first (active prints by soonest ETA), then failed,
  // finished/idle, and offline last; ties within a tier fall back to name.
  // When go2rtc is active, split printers: RTSP models → WebRTC, chamber
  // models → MJPEG grid. gridPrinters keeps the full sorted list for rendering
  // — tiles interleave both stream types so the order stays correct across
  // mixed fleets.
  const { gridPrinters, mjpegPrinters, webrtcPrinters } = useMemo(() => {
    const sorted = [...printers].sort((a, b) => {
      const ta = etaTier(a);
      const tb = etaTier(b);
      if (ta !== tb) return ta - tb;
      if (ta === 0) {
        const diff = (a.remainingTime ?? 0) - (b.remainingTime ?? 0);
        if (diff !== 0) return diff;
      }
      return a.name.localeCompare(b.name);
    });
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
    const timer = setTimeout(() => setPrinterIdsKey(rawPrinterIdsKey), IDS_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawPrinterIdsKey]);

  // Restart key — incrementing tears down and re-initializes all camera streams
  const [restartKey, setRestartKey] = useState(0);
  const handleRestart = useCallback(() => setRestartKey(k => k + 1), []);

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

  // Combined stats (MJPEG + WebRTC) via ref + subscriber pattern
  const webrtcPrinterIdsKey = webrtcPrinters.map(p => p.id).sort((a, b) => a - b).join(',');
  const { subscribeStats, getStatsSnapshot, handleWebRTCStats } = useCombinedGridStats({
    getMjpegStatsSnapshot,
    mjpegCount: mjpegPrinters.length,
    webrtcCount: webrtcPrinters.length,
    webrtcPrinterIdsKey,
    suspended,
  });

  // Slide tiles to their new slots when the triage order changes (statuses
  // update live) or the spotlight moves — spanning a tile reflows the wall.
  const gridRef = useRef<HTMLDivElement>(null);
  // Include paused ids: a pause flips the tile to 2×2, which reflows the wall
  // and must animate even when the tile's slot order is unchanged.
  const pausedKey = gridPrinters.filter(p => p.state === 'PAUSE').map(p => p.id).join(',');
  const orderKey = `${gridPrinters.map(p => p.id).join(',')}|${spotlightId ?? ''}|${pausedKey}`;
  useFlipReorder(gridRef, orderKey);

  // Staggered entrance — tiles cascade in one after another when the wall
  // first renders (page arrival or refresh)
  useStaggeredEntrance(gridRef);

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

  const kioskHidden = !!fullscreen && kioskIdle;

  return (
    <div className={kioskHidden ? 'cursor-none' : undefined}>
      <GridToolbar
        canChangeQuality={canChangeQuality}
        quality={gridParamsKey}
        qualityPending={qualityMutation.isPending}
        onQualityChange={handleQualityChange}
        onRestart={handleRestart}
        subscribeStats={subscribeStats}
        getStatsSnapshot={getStatsSnapshot}
        hidden={kioskHidden}
      />
      <div ref={gridRef} className={`grid ${layout === 'compact' ? 'gap-2' : 'gap-4'} ${GRID_LAYOUT_COLS[layout]}`}>
        {/* One interleaved list in triage order — each tile picks its stream type
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
            controlLoading: getControlLoading(p.id),
            plateCleared: p.plateCleared,
            jobName: p.jobName,
            nozzleTemp: p.nozzleTemp,
            activeNozzle: p.activeNozzle,
            bedTemp: p.bedTemp,
            clearPlateLoading: clearPlateMutation.isPending && clearPlateMutation.variables === p.id,
            layout,
            timeFormat,
            hmsErrors: p.hmsErrors,
            dismissedErrorDesc: dismissedErrors.get(p.id),
            hasQueuedJobs: printersWithQueue.has(p.id),
            // Paused prints auto-expand to a 2×2 tile so a stalled job is
            // impossible to miss on the wall — same span as a manual spotlight.
            spotlighted: spotlightId === p.id || p.state === 'PAUSE',
            handlers,
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
