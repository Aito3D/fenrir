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

  const stopStream = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort();
      controllerRef.current = null;
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
          }
          return;
        }

        // Stream ended naturally (clean EOF) — don't treat as error
        if (mountedRef.current && gen === generationRef.current) {
          setIsLoading(false);
          setIsConnected(false);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (mountedRef.current && gen === generationRef.current) {
          setIsLoading(false);
          setHasError(true);
          setIsConnected(false);
          onErrorRef.current?.();
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
