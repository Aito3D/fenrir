import { useState, useRef, useCallback, useEffect } from 'react';
import { getAuthToken } from '../api/client';
import { GrowingBuffer } from '../utils/streamBuffer';

const API_BASE = '/api/v1';
const JPEG_SOI_HI = 0xff;
const JPEG_SOI_LO = 0xd8;
const JPEG_EOI_LO = 0xd9;
// If this many frames in a row fail to decode (e.g. the response body isn't a
// real MJPEG stream at all — wrong content type, a truncated/corrupt producer,
// an HTML error page framed as bytes), give up and report an error instead of
// spinning forever. Kept small since a genuine decode desync should surface
// quickly, but larger than 1 so an occasional bad frame in an otherwise-healthy
// stream doesn't trip it — the counter resets on every successful decode.
const MAX_CONSECUTIVE_DECODE_FAILURES = 20;
// T-052/T-065: when a caller wires no `onError` handler, nobody else will
// retry — the hook self-heals instead of leaving the canvas frozen after any
// of the three ways a stream can terminate: the decode-budget trip above, a
// network/fetch failure, or the server closing the connection cleanly (EOF).
// Callers that *do* supply `onError` own their own reconnect machinery (e.g.
// useStreamReconnect); this backoff only ever runs for the onError-less case,
// so it never races an external retry loop. Delay grows from a few seconds to
// a cap, then holds there — acceptable for a kiosk overlay that should keep
// trying indefinitely. All three trigger kinds share one attempt counter,
// reset on every successful decode, so an overlay that alternates between
// e.g. decode failures and dropped connections still backs off smoothly
// instead of resetting the delay each time the failure mode changes.
const SELF_RESTART_INITIAL_DELAY_MS = 2000;
const SELF_RESTART_MAX_DELAY_MS = 15000;

interface UseMjpegStreamOptions {
  /** Stream URL path (relative to API_BASE, e.g. `/printers/1/camera/stream?fps=15`) */
  url: string;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  enabled?: boolean;
  onFirstFrame?: () => void;
  onError?: () => void;
}

interface UseMjpegStreamReturn {
  isLoading: boolean;
  hasError: boolean;
  isConnected: boolean;
  restart: () => void;
  stop: () => void;
}

export function useMjpegStream({
  url,
  canvasRef,
  enabled = true,
  onFirstFrame,
  onError,
}: UseMjpegStreamOptions): UseMjpegStreamReturn {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const generationRef = useRef(0);
  const onFirstFrameRef = useRef(onFirstFrame);
  const onErrorRef = useRef(onError);
  onFirstFrameRef.current = onFirstFrame;
  onErrorRef.current = onError;

  // T-052/T-065 self-restart bookkeeping — see SELF_RESTART_* constants above.
  const selfRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selfRestartAttemptRef = useRef(0);

  const stopStream = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort();
      controllerRef.current = null;
    }
    // Cancel any pending self-restart — covers restart()/stop()/unmount/the
    // enabled-or-url effect cleanup, all of which route through here, so a
    // scheduled retry from a stale generation never fires (T-023 was this
    // exact class of leaked-timer bug).
    if (selfRestartTimerRef.current) {
      clearTimeout(selfRestartTimerRef.current);
      selfRestartTimerRef.current = null;
    }
  }, []);

  const startStream = useCallback((gen: number) => {
    stopStream();

    if (!enabled) return;

    const controller = new AbortController();
    controllerRef.current = controller;

    setIsLoading(true);
    setHasError(false);

    const fullUrl = `${API_BASE}${url}`;
    const headers: Record<string, string> = {};
    const token = getAuthToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    // T-052/T-065: shared by all three termination paths below (decode
    // budget, network-failure catch, clean EOF). No-ops when the caller
    // supplied its own `onError` — those callers own recovery and this must
    // never race their retry loop (see SELF_RESTART_* comment above).
    // Cancellation lives entirely in stopStream() (unmount/restart/stop/the
    // enabled-or-url effect cleanup all route through it), so by the time a
    // scheduled restart fires, if any of those happened, clearTimeout already
    // prevented it from running at all — no extra generation guard needed
    // here beyond the one already gating the call site.
    const scheduleSelfRestart = () => {
      if (onErrorRef.current) return;
      const attempt = selfRestartAttemptRef.current;
      selfRestartAttemptRef.current = attempt + 1;
      const delay = Math.min(
        SELF_RESTART_INITIAL_DELAY_MS * Math.pow(2, attempt),
        SELF_RESTART_MAX_DELAY_MS,
      );
      selfRestartTimerRef.current = setTimeout(() => {
        selfRestartTimerRef.current = null;
        generationRef.current += 1;
        startStream(generationRef.current);
      }, delay);
    };

    (async () => {
      try {
        const response = await fetch(fullUrl, {
          headers,
          signal: controller.signal,
          cache: 'no-store',
        });

        if (!response.ok || !response.body) {
          throw new Error(`Stream failed: ${response.status}`);
        }

        const reader = response.body.getReader();
        const gbuf = new GrowingBuffer(256 * 1024, 5 * 1024 * 1024);
        let firstFrameDelivered = false;
        let cachedCtx: CanvasRenderingContext2D | null = null;
        let consecutiveDecodeFailures = 0;
        let decodeBudgetExceeded = false;

        while (true) {
          if (gen !== generationRef.current) break;

          const { done, value } = await reader.read();
          if (done) break;

          gbuf.append(value);

          // Extract complete JPEG frames
          while (gbuf.length >= 4) {
            const view = gbuf.data;
            // Find SOI marker (0xFF 0xD8)
            let soiIdx = -1;
            for (let i = 0; i < gbuf.length - 1; i++) {
              if (view[i] === JPEG_SOI_HI && view[i + 1] === JPEG_SOI_LO) {
                soiIdx = i;
                break;
              }
            }
            if (soiIdx === -1) {
              // Keep last byte (could be 0xFF)
              if (gbuf.length > 1) {
                gbuf.compact(gbuf.length - 1);
              }
              break;
            }

            // Trim before SOI
            if (soiIdx > 0) {
              gbuf.compact(soiIdx);
            }

            // Find EOI marker (0xFF 0xD9)
            const data = gbuf.data;
            let eoiIdx = -1;
            for (let i = 2; i < gbuf.length - 1; i++) {
              if (data[i] === JPEG_SOI_HI && data[i + 1] === JPEG_EOI_LO) {
                eoiIdx = i;
                break;
              }
            }
            if (eoiIdx === -1) break; // Incomplete frame

            // Extract JPEG frame
            const frame = gbuf.data.slice(0, eoiIdx + 2);
            gbuf.compact(eoiIdx + 2);
            gbuf.shrinkIfSparse();

            // Draw to canvas
            if (gen !== generationRef.current) break;
            try {
              const blob = new Blob([frame], { type: 'image/jpeg' });
              const bitmap = await createImageBitmap(blob);

              if (gen !== generationRef.current) {
                bitmap.close();
                break;
              }

              const canvas = canvasRef.current;
              if (canvas) {
                if (!cachedCtx || cachedCtx.canvas !== canvas) {
                  cachedCtx = canvas.getContext('2d');
                }
                if (cachedCtx) {
                  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                    canvas.width = bitmap.width;
                    canvas.height = bitmap.height;
                  }
                  cachedCtx.drawImage(bitmap, 0, 0);
                }
              }
              bitmap.close();
              consecutiveDecodeFailures = 0;
              // A frame actually decoded — the stream is healthy again, so a
              // future budget trip should back off from scratch rather than
              // continuing to grow off a now-stale attempt count.
              selfRestartAttemptRef.current = 0;

              if (!firstFrameDelivered && mountedRef.current) {
                firstFrameDelivered = true;
                setIsLoading(false);
                setIsConnected(true);
                onFirstFrameRef.current?.();
              }
            } catch {
              // Invalid JPEG — skip, but track consecutive failures so a
              // fully-undecodable stream doesn't spin forever (see
              // MAX_CONSECUTIVE_DECODE_FAILURES above).
              consecutiveDecodeFailures += 1;
              if (consecutiveDecodeFailures >= MAX_CONSECUTIVE_DECODE_FAILURES) {
                decodeBudgetExceeded = true;
                break;
              }
            }
          }

          if (decodeBudgetExceeded) break;
        }

        if (decodeBudgetExceeded) {
          controller.abort();
          if (mountedRef.current && gen === generationRef.current) {
            setIsLoading(false);
            setHasError(true);
            setIsConnected(false);
            onErrorRef.current?.();
            scheduleSelfRestart();
          }
          return;
        }

        // Stream ended naturally (clean EOF) — don't treat as error. A
        // server-side no-viewer close is routine (not a fault), so this
        // stays silent: no hasError, no onError — but an onError-less caller
        // (T-065) still gets the same backed-off self-restart as the other
        // two termination paths, so it doesn't sit frozen until the page is
        // reloaded.
        if (mountedRef.current && gen === generationRef.current) {
          setIsLoading(false);
          setIsConnected(false);
          scheduleSelfRestart();
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (mountedRef.current && gen === generationRef.current) {
          setIsLoading(false);
          setHasError(true);
          setIsConnected(false);
          onErrorRef.current?.();
          scheduleSelfRestart();
        }
      }
    })();
  }, [url, enabled, canvasRef, stopStream]);

  const restart = useCallback(() => {
    generationRef.current += 1;
    startStream(generationRef.current);
  }, [startStream]);

  // Start/stop based on enabled
  useEffect(() => {
    if (enabled) {
      generationRef.current += 1;
      startStream(generationRef.current);
    } else {
      stopStream();
      setIsConnected(false);
    }
    return () => {
      stopStream();
    };
  }, [enabled, url, startStream, stopStream]);

  return { isLoading, hasError, isConnected, restart, stop: stopStream };
}
