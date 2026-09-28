import { useEffect, useRef, useState, useCallback } from 'react';
import { api, withStreamToken } from '../api/client';
import { mseSupported, startMseStream } from '../utils/mseStream';
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
// Half the post-answer connection watchdog — if go2rtc never answers the SDP
// offer, this bounds the hang so the tile surfaces an error and enters
// backoff retry instead of spinning forever.
const NEGOTIATION_TIMEOUT_MS = 15_000;
const FRAME_CHECK_INTERVAL = 1_000;
// On a LAN, ICE connects well under a second after the answer. go2rtc only
// offers host candidates (its LAN addresses on :8555), so a browser that
// reaches the app through an HTTP-only path — a Cloudflare tunnel — can never
// connect the media. After this long without ICE connecting, fall back to
// go2rtc's MSE stream relayed over the app's own origin.
export const ICE_CONNECT_TIMEOUT_MS = 5_000;

// Once one tile has had to fall back, the network path is the same for every
// other tile on the page — skip the WebRTC wait for the rest of the session.
let preferMse = false;

/** Forget the session's MSE fallback (tests). */
export function resetStreamTransport(): void {
  preferMse = false;
}

function mseUrl(printerId: number): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return withStreamToken(`${protocol}//${window.location.host}/api/v1/printers/${printerId}/camera/mse`);
}

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
  // Ref mirrors state so timers/callbacks read the current value without
  // stale closures; always write both through setAttempt.
  const setAttempt = useCallback((n: number) => {
    reconnectAttemptRef.current = n;
    setReconnectAttempt(n);
  }, []);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelCountdownRef = useRef<(() => void) | null>(null);
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevBytesRef = useRef(0);
  const mountedRef = useRef(true);
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;

  // Frame monitoring refs
  const lastFrameTimeRef = useRef(0);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const negotiationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopMseRef = useRef<(() => void) | null>(null);
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
    if (negotiationTimeoutRef.current) {
      clearTimeout(negotiationTimeoutRef.current);
      negotiationTimeoutRef.current = null;
    }
    if (iceTimeoutRef.current) {
      clearTimeout(iceTimeoutRef.current);
      iceTimeoutRef.current = null;
    }
    stopMseRef.current?.();
    stopMseRef.current = null;
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
      setAttempt(0);
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
  }, [videoRef, stopFrameMonitor, setAttempt]);

  // If no frame within 30s, reconnect.
  const armConnectionTimeout = useCallback(() => {
    connectionTimeoutRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      if (lastFrameTimeRef.current === 0) {
        setIsLoading(false);
        setHasError(true);
        setIsConnected(false);
        scheduleReconnectRef.current();
      }
    }, CONNECTION_TIMEOUT);
  }, []);

  // go2rtc's MSE stream over the app's origin (see ICE_CONNECT_TIMEOUT_MS).
  // Expects the attempt state already reset by connect().
  const connectMse = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    let bytes = 0;
    stopMseRef.current = startMseStream(video, mseUrl(printerId), {
      onOpen: () => {
        if (!mountedRef.current) return;
        setIsConnected(true);
        video.play().catch(() => {});
        startFrameMonitor();
      },
      onBytes: (n) => {
        bytes += n;
      },
      onError: () => {
        if (!mountedRef.current) return;
        setIsLoading(false);
        setHasError(true);
        setIsConnected(false);
        scheduleReconnectRef.current();
      },
    });
    statsIntervalRef.current = setInterval(() => {
      if (bytes > 0) onStatsRef.current?.(printerId, { bytesPerSecond: bytes, timestamp: performance.now() });
      bytes = 0;
    }, 1000);
    armConnectionTimeout();
  }, [printerId, videoRef, startFrameMonitor, armConnectionTimeout]);

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

    if (preferMse) {
      connectMse();
      return;
    }

    // An attempt whose ICE never connected moves to MSE; one that connected
    // and later failed is a real drop and reconnects over WebRTC.
    let iceConnected = false;
    const fallBackToMse = (pc: RTCPeerConnection): boolean => {
      if (iceConnected || pcRef.current !== pc || !mseSupported()) return false;
      preferMse = true;
      cleanup();
      connectMse();
      return true;
    };

    try {
      const pc = new RTCPeerConnection({
        iceServers: [], // host candidates only; off-LAN viewers fall back to MSE
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
        if (state === 'connected' || state === 'completed') {
          iceConnected = true;
        } else if (state === 'failed' || state === 'closed') {
          if (fallBackToMse(pc)) return;
          setIsConnected(false);
          setHasError(true);
          setIsLoading(false);
          scheduleReconnectRef.current();
        }
      };

      // Create and set local offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Send offer to backend, get answer from go2rtc — bounded by
      // NEGOTIATION_TIMEOUT_MS so a go2rtc that never answers surfaces an
      // error and enters backoff retry instead of hanging the tile forever.
      // The timer is cleared unconditionally by cleanup() at the top of the
      // next connect() call, so a superseded/stale attempt's timer can never
      // fire against a fresher connection (see T-054 for the catch block's
      // own generation-guard gap, which this does not touch).
      const answer = await Promise.race([
        api.webrtcOffer(printerId, offer.sdp!),
        new Promise<never>((_resolve, reject) => {
          negotiationTimeoutRef.current = setTimeout(() => {
            negotiationTimeoutRef.current = null;
            reject(new Error('WebRTC SDP negotiation timed out'));
          }, NEGOTIATION_TIMEOUT_MS);
        }),
      ]);
      if (negotiationTimeoutRef.current) {
        clearTimeout(negotiationTimeoutRef.current);
        negotiationTimeoutRef.current = null;
      }
      if (!mountedRef.current || pcRef.current !== pc) return;

      // Set remote answer (go2rtc uses ICE-lite, no trickle ICE)
      await pc.setRemoteDescription({
        type: answer.type as RTCSdpType,
        sdp: answer.sdp,
      });

      if (!iceConnected) {
        iceTimeoutRef.current = setTimeout(() => {
          iceTimeoutRef.current = null;
          if (mountedRef.current) fallBackToMse(pc);
        }, ICE_CONNECT_TIMEOUT_MS);
      }
      armConnectionTimeout();
    } catch {
      if (!mountedRef.current) return;
      setIsLoading(false);
      setHasError(true);
      setIsConnected(false);
      scheduleReconnectRef.current();
    }
  }, [printerId, enabled, videoRef, cleanup, cleanupCountdown, startFrameMonitor, connectMse, armConnectionTimeout]);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current || !enabled) return;
    if (reconnectScheduledRef.current) return; // Guard against double scheduling
    reconnectScheduledRef.current = true;

    const attempt = reconnectAttemptRef.current;
    setAttempt(attempt + 1);
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
  }, [enabled, connect, cleanupCountdown, setAttempt]);

  // Keep the ref in sync with the latest scheduleReconnect
  scheduleReconnectRef.current = scheduleReconnect;

  const restart = useCallback(() => {
    setAttempt(0);
    reconnectScheduledRef.current = false;
    setIsReconnecting(false);
    setReconnectCountdown(0);
    setStale(false);
    setDegraded(false);
    cleanupCountdown();
    connect();
  }, [connect, cleanupCountdown, setAttempt]);

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
