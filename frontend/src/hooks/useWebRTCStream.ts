import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../api/client';
import { STREAM_STALE_MS, STREAM_DEGRADED_MS, STREAM_ERROR_MS, RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS } from '../utils/streamConstants';
import { startCountdown } from '../utils/countdown';

export interface WebRTCPrinterStats {
  bytesPerSecond: number;
  timestamp: number;
}

interface UseWebRTCStreamOptions {
  printerId: number;
  enabled: boolean;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onStats?: (id: number, stats: WebRTCPrinterStats) => void;
  restartKey?: number;
}

interface UseWebRTCStreamReturn {
  isLoading: boolean;
  hasError: boolean;
  isConnected: boolean;
  isReconnecting: boolean;
  reconnectCountdown: number;
  reconnectAttempt: number;
  stale: boolean;
  degraded: boolean;
  restart: () => void;
}

const CONNECTION_TIMEOUT = 30_000;
const FRAME_CHECK_INTERVAL = 1_000;

export function useWebRTCStream({ printerId, enabled, videoRef, onStats, restartKey }: UseWebRTCStreamOptions): UseWebRTCStreamReturn {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectCountdown, setReconnectCountdown] = useState(0);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [stale, setStale] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelCountdownRef = useRef<(() => void) | null>(null);
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevBytesRef = useRef(0);
  const mountedRef = useRef(true);
  const restartKeyRef = useRef(0);
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;

  // Frame monitoring refs
  const lastFrameTimeRef = useRef(0);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameMonitorRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rvfcHandleRef = useRef<number | null>(null);
  const reconnectScheduledRef = useRef(false);

  const cleanupCountdown = useCallback(() => {
    cancelCountdownRef.current?.();
    cancelCountdownRef.current = null;
  }, []);

  const stopFrameMonitor = useCallback(() => {
    if (frameMonitorRef.current) {
      clearInterval(frameMonitorRef.current);
      frameMonitorRef.current = null;
    }
    if (rvfcHandleRef.current !== null && videoRef.current) {
      const video = videoRef.current as HTMLVideoElement;
      video.cancelVideoFrameCallback?.(rvfcHandleRef.current);
      rvfcHandleRef.current = null;
    }
  }, [videoRef]);

  const cleanup = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    stopFrameMonitor();
    cleanupCountdown();
    prevBytesRef.current = 0;
    lastFrameTimeRef.current = 0;
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, [videoRef, cleanupCountdown, stopFrameMonitor]);

  // scheduleReconnect is called from callbacks/timers — use ref to avoid circular deps
  const scheduleReconnectRef = useRef<() => void>(() => {});

  const startFrameMonitor = useCallback(() => {
    stopFrameMonitor();
    const video = videoRef.current as HTMLVideoElement | null;
    if (!video) return;

    const hasRVFC = typeof video.requestVideoFrameCallback === 'function';

    const onFirstFrame = () => {
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
      setIsLoading(false);
      setStale(false);
      setDegraded(false);
      reconnectAttemptRef.current = 0;
      setReconnectAttempt(0);
    };

    if (hasRVFC) {
      // Use requestVideoFrameCallback for zero-polling frame detection
      const onFrame = () => {
        if (lastFrameTimeRef.current === 0) onFirstFrame();
        lastFrameTimeRef.current = performance.now();
        if (videoRef.current) {
          const v = videoRef.current as HTMLVideoElement;
          rvfcHandleRef.current = v.requestVideoFrameCallback?.(onFrame) ?? null;
        }
      };
      rvfcHandleRef.current = video.requestVideoFrameCallback!(onFrame);
    }

    // Single interval: poll currentTime as fallback (when no rVFC) + evaluate thresholds
    let lastCurrentTime = video.currentTime;
    frameMonitorRef.current = setInterval(() => {
      if (!mountedRef.current) return;

      // Fallback frame detection via currentTime polling
      if (!hasRVFC && videoRef.current) {
        const ct = videoRef.current.currentTime;
        if (ct !== lastCurrentTime) {
          if (lastFrameTimeRef.current === 0) onFirstFrame();
          lastFrameTimeRef.current = performance.now();
          lastCurrentTime = ct;
        }
      }

      // Evaluate stale/degraded/error thresholds
      const last = lastFrameTimeRef.current;
      if (last === 0) return; // No frame yet — connection timeout handles this
      const elapsed = performance.now() - last;

      if (elapsed >= STREAM_ERROR_MS) {
        setHasError(true);
        setIsConnected(false);
        scheduleReconnectRef.current();
      } else if (elapsed >= STREAM_DEGRADED_MS) {
        setStale(true);
        setDegraded(true);
      } else if (elapsed >= STREAM_STALE_MS) {
        setStale(true);
        setDegraded(false);
      } else {
        setStale(false);
        setDegraded(false);
      }
    }, FRAME_CHECK_INTERVAL);
  }, [videoRef, stopFrameMonitor]);

  const connect = useCallback(async () => {
    if (!mountedRef.current || !enabled) return;

    cleanup();
    reconnectScheduledRef.current = false;
    setIsLoading(true);
    setHasError(false);
    setIsReconnecting(false);
    setReconnectCountdown(0);
    setStale(false);
    setDegraded(false);

    try {
      const pc = new RTCPeerConnection({
        iceServers: [], // LAN — no STUN/TURN needed
      });
      pcRef.current = pc;

      // Add recvonly video transceiver
      pc.addTransceiver('video', { direction: 'recvonly' });

      // Attach stream on track
      pc.ontrack = (event) => {
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
          setIsConnected(true);
          setIsReconnecting(false);
          setReconnectCountdown(0);
          reconnectScheduledRef.current = false;
          cleanupCountdown();

          // Start frame monitoring — loading spinner stays until first decoded frame
          startFrameMonitor();
        }
      };

      // Poll WebRTC stats every 1s to report bandwidth
      if (statsIntervalRef.current) clearInterval(statsIntervalRef.current);
      prevBytesRef.current = 0;
      statsIntervalRef.current = setInterval(async () => {
        if (!pcRef.current || pcRef.current !== pc) return;
        try {
          const report = await pc.getStats();
          let totalBytes = 0;
          report.forEach((stat) => {
            if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
              totalBytes += stat.bytesReceived ?? 0;
            }
          });
          const delta = totalBytes - prevBytesRef.current;
          prevBytesRef.current = totalBytes;
          // Skip first tick (delta would be the entire cumulative total)
          if (delta > 0 && totalBytes !== delta) {
            onStatsRef.current?.(printerId, { bytesPerSecond: delta, timestamp: performance.now() });
          }
        } catch {
          // pc may be closed — ignore
        }
      }, 1000);

      // Handle ICE failure — reconnect with backoff. 'disconnected' is
      // intentionally NOT treated as fatal: it is often transient and
      // self-heals; the frame monitor's stale/degraded/error thresholds
      // catch genuinely dead streams.
      pc.oniceconnectionstatechange = () => {
        if (!mountedRef.current) return;
        const state = pc.iceConnectionState;
        if (state === 'failed' || state === 'closed') {
          setIsConnected(false);
          setHasError(true);
          setIsLoading(false);
          scheduleReconnectRef.current();
        }
      };

      // Create and set local offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Send offer to backend, get answer from go2rtc
      const answer = await api.webrtcOffer(printerId, offer.sdp!);
      if (!mountedRef.current || pcRef.current !== pc) return;

      // Set remote answer (go2rtc uses ICE-lite, no trickle ICE)
      await pc.setRemoteDescription({
        type: answer.type as RTCSdpType,
        sdp: answer.sdp,
      });

      // Start connection timeout — if no frame within 30s, reconnect
      connectionTimeoutRef.current = setTimeout(() => {
        if (!mountedRef.current) return;
        if (lastFrameTimeRef.current === 0) {
          setIsLoading(false);
          setHasError(true);
          setIsConnected(false);
          scheduleReconnectRef.current();
        }
      }, CONNECTION_TIMEOUT);
    } catch {
      if (!mountedRef.current) return;
      setIsLoading(false);
      setHasError(true);
      setIsConnected(false);
      scheduleReconnectRef.current();
    }
  }, [printerId, enabled, videoRef, cleanup, cleanupCountdown, startFrameMonitor]);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current || !enabled) return;
    if (reconnectScheduledRef.current) return; // Guard against double scheduling
    reconnectScheduledRef.current = true;

    const attempt = reconnectAttemptRef.current++;
    setReconnectAttempt(reconnectAttemptRef.current);
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt), RECONNECT_MAX_DELAY_MS);
    setIsReconnecting(true);

    // Countdown timer
    cleanupCountdown();
    cancelCountdownRef.current = startCountdown(delay, setReconnectCountdown);

    reconnectTimerRef.current = setTimeout(() => {
      if (mountedRef.current && enabled) {
        connect();
      }
    }, delay);
  }, [enabled, connect, cleanupCountdown]);

  // Keep the ref in sync with the latest scheduleReconnect
  scheduleReconnectRef.current = scheduleReconnect;

  const restart = useCallback(() => {
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    restartKeyRef.current++;
    reconnectScheduledRef.current = false;
    setIsReconnecting(false);
    setReconnectCountdown(0);
    setStale(false);
    setDegraded(false);
    cleanupCountdown();
    connect();
  }, [connect, cleanupCountdown]);

  useEffect(() => {
    mountedRef.current = true;

    if (enabled) {
      connect();
    } else {
      cleanup();
      setIsLoading(false);
      setHasError(false);
      setIsConnected(false);
      setIsReconnecting(false);
      setReconnectCountdown(0);
      setStale(false);
      setDegraded(false);
    }

    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [enabled, connect, cleanup, restartKey]);

  return {
    isLoading,
    hasError,
    isConnected,
    isReconnecting,
    reconnectCountdown,
    reconnectAttempt,
    stale,
    degraded,
    restart,
  };
}
