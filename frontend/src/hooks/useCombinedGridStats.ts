import { useCallback, useEffect, useRef } from 'react';

import type { GridStreamStats } from './useGridStream';
import type { WebRTCPrinterStats } from './useWebRTCStream';
import { formatUptime } from '../utils/date';
import { formatFileSize } from '../utils/file';

/** WebRTC per-printer stats older than this are treated as gone. */
const WEBRTC_STATS_FRESHNESS_MS = 3000;
/** How often MJPEG + WebRTC stats are merged and pushed to subscribers. */
const STATS_MERGE_INTERVAL_MS = 1000;

const EMPTY_STATS: GridStreamStats = { bw: '', active: 0, total: 0, uptime: '', rawBytesPerSecond: 0, droppedFrames: 0 };

/**
 * Merges MJPEG grid-stream stats with per-card WebRTC stats into one
 * subscribable snapshot (ref + subscriber pattern) so the stats row can
 * update every second via useSyncExternalStore without re-rendering the wall.
 */
export function useCombinedGridStats({
  getMjpegStatsSnapshot,
  mjpegCount,
  webrtcCount,
  webrtcPrinterIdsKey,
  suspended,
}: {
  getMjpegStatsSnapshot: () => GridStreamStats;
  mjpegCount: number;
  webrtcCount: number;
  /** Sorted, comma-joined WebRTC printer ids — stale registry entries are pruned on change. */
  webrtcPrinterIdsKey: string;
  suspended: boolean;
}) {
  // WebRTC stats registry — each WebRTCGridCard reports its bandwidth here
  const registry = useRef<Map<number, WebRTCPrinterStats>>(new Map());
  const handleWebRTCStats = useCallback((id: number, stats: WebRTCPrinterStats) => {
    registry.current.set(id, stats);
  }, []);

  // Clean stale registry entries when the WebRTC printer set changes
  useEffect(() => {
    const activeIds = new Set(webrtcPrinterIdsKey ? webrtcPrinterIdsKey.split(',').map(Number) : []);
    for (const id of registry.current.keys()) {
      if (!activeIds.has(id)) registry.current.delete(id);
    }
  }, [webrtcPrinterIdsKey]);

  const combinedRef = useRef<GridStreamStats>(EMPTY_STATS);
  const subscribers = useRef(new Set<() => void>());
  const subscribeStats = useCallback((cb: () => void) => {
    subscribers.current.add(cb);
    return () => { subscribers.current.delete(cb); };
  }, []);
  const getStatsSnapshot = useCallback(() => combinedRef.current, []);

  // Track WebRTC-only uptime for when no MJPEG stream exists
  const webrtcStartRef = useRef<number>(0);
  useEffect(() => {
    if (webrtcCount > 0 && webrtcStartRef.current === 0) {
      webrtcStartRef.current = performance.now();
    } else if (webrtcCount === 0) {
      webrtcStartRef.current = 0;
    }
  }, [webrtcCount]);

  // Merge interval — MJPEG + fresh WebRTC entries, pushed to subscribers
  useEffect(() => {
    const interval = setInterval(() => {
      if (suspended) return;
      const mjpeg = getMjpegStatsSnapshot();
      const now = performance.now();

      let webrtcBytes = 0;
      let webrtcActiveCount = 0;
      for (const [, stats] of registry.current) {
        if (now - stats.timestamp < WEBRTC_STATS_FRESHNESS_MS) {
          webrtcBytes += stats.bytesPerSecond;
          webrtcActiveCount++;
        }
      }

      const totalBytes = mjpeg.rawBytesPerSecond + webrtcBytes;
      const hasMjpeg = mjpegCount > 0 && mjpeg.uptime !== '';
      const hasWebrtc = webrtcCount > 0;

      // Uptime: prefer MJPEG uptime if stream exists, else compute from WebRTC start
      let uptime = mjpeg.uptime;
      if (!hasMjpeg && hasWebrtc && webrtcStartRef.current > 0) {
        uptime = formatUptime(Math.floor((now - webrtcStartRef.current) / 1000));
      }

      combinedRef.current = {
        bw: totalBytes > 0 ? `${formatFileSize(totalBytes)}/s` : (hasMjpeg || hasWebrtc ? '0 B/s' : ''),
        active: mjpeg.active + webrtcActiveCount,
        total: mjpegCount + webrtcCount,
        uptime,
        rawBytesPerSecond: totalBytes,
        droppedFrames: mjpeg.droppedFrames,
      };
      subscribers.current.forEach(cb => cb());
    }, STATS_MERGE_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [getMjpegStatsSnapshot, mjpegCount, webrtcCount, suspended]);

  return { subscribeStats, getStatsSnapshot, handleWebRTCStats };
}
