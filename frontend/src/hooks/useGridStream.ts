import { useState, useEffect, useRef, useCallback } from 'react';
import CameraGridDecoderWorker from '../workers/cameraGridDecoder.worker?worker';
import { getAuthToken } from '../api/client';
import { formatFileSize } from '../utils/file';
import { formatUptime } from '../utils/date';
import { GrowingBuffer } from '../utils/streamBuffer';
import { STREAM_STALE_MS, STREAM_DEGRADED_MS, STREAM_ERROR_MS } from '../utils/streamConstants';
import { useGridReconnect } from './useGridReconnect';

const MAX_WORKER_RESTARTS = 3;

// Grid stream constants
const GRID_FRAME_HEADER_SIZE = 8;          // [4B printer_id LE][4B length LE]

export interface ParsedFrame {
  printerId: number;
  jpeg: ArrayBuffer;
}

/**
 * Parse binary-framed grid stream data: [4B printer_id LE][4B length LE][jpeg_data]
 * Returns parsed frames and the new offset into the buffer.
 */
export function parseGridFrames(buffer: ArrayBuffer, byteOffset: number, length: number): { frames: ParsedFrame[]; bytesConsumed: number } {
  const frames: ParsedFrame[] = [];
  let offset = 0;
  while (offset + GRID_FRAME_HEADER_SIZE <= length) {
    const view = new DataView(buffer, byteOffset + offset, GRID_FRAME_HEADER_SIZE);
    const printerId = view.getUint32(0, true);
    const jpegLen = view.getUint32(4, true);

    // Sanity check: cap at 10 MB to prevent corrupt headers from growing the buffer unboundedly
    if (jpegLen > 10_000_000) {
      return { frames, bytesConsumed: -1 }; // signal corruption
    }

    if (offset + GRID_FRAME_HEADER_SIZE + jpegLen > length) break; // incomplete frame

    // Copy JPEG bytes into a standalone ArrayBuffer for transfer to worker
    const jpeg = new Uint8Array(buffer, byteOffset + offset + GRID_FRAME_HEADER_SIZE, jpegLen).slice().buffer;
    frames.push({ printerId, jpeg });
    offset += GRID_FRAME_HEADER_SIZE + jpegLen;
  }
  return { frames, bytesConsumed: offset };
}

export interface GridStreamStats {
  bw: string;
  active: number;
  total: number;
  uptime: string;
  rawBytesPerSecond: number;
  /** Frames the decode worker replaced before decoding (decoder fell behind). */
  droppedFrames: number;
}

const EMPTY_STATS: GridStreamStats = { bw: '', active: 0, total: 0, uptime: '', rawBytesPerSecond: 0, droppedFrames: 0 };

interface UseGridStreamOptions {
  printerIdsKey: string;
  gridParamsKey: string;
  restartKey: number;
}

interface UseGridStreamReturn {
  canvasRefs: React.MutableRefObject<Map<number, React.RefObject<HTMLCanvasElement | null>>>;
  loadingSet: Set<number>;
  errorSet: Set<number>;
  degradedSet: Set<number>;
  staleSet: Set<number>;
  reconnectingSet: Set<number>;
  reconnectCountdown: number;
  reconnectAttempt: number;
  subscribeStats: (cb: () => void) => () => void;
  getStatsSnapshot: () => GridStreamStats;
  handleVisibilityChange: (printerId: number, visible: boolean) => void;
}

export function useGridStream({ printerIdsKey, gridParamsKey, restartKey }: UseGridStreamOptions): UseGridStreamReturn {
  const canvasRefs = useRef<Map<number, React.RefObject<HTMLCanvasElement | null>>>(new Map());

  // Visibility (IntersectionObserver, forwarded via handleVisibilityChange) and
  // last-decoded-frame-time tracking live in refs at hook scope (not inside the
  // main effect below) so handleVisibilityChange — a stable callback used by
  // every card regardless of effect re-runs — can read/update them directly.
  // Missing entries default to visible=true: the worker seeds every id as
  // visible on connect/restart, and IntersectionObserver only fires on change,
  // so an already-visible card never explicitly notifies.
  const visibilityRef = useRef<Map<number, boolean>>(new Map());
  const lastFrameTimeRef = useRef<Map<number, number>>(new Map());
  // Which printers have delivered at least one decoded frame since the last
  // connect/reconnect. Hoisted to hook scope (alongside visibilityRef/
  // lastFrameTimeRef above) — same rationale: handleVisibilityChange is a
  // stable callback that outlives any single run of the main effect below,
  // so it needs to read the *same* live Set the effect's health timers use
  // rather than a local variable it can't see (T-057/T-062 re-entry check).
  const loadedPrintersRef = useRef<Set<number>>(new Set());
  // Ids that the startup timeout or the reconnect grace timer skipped for
  // "still missing" purposes solely because they were invisible at fire
  // time (T-049 exemption). Neither timer re-arms itself, so without this
  // record such an id would sit unresolved forever — no spinner, no error
  // overlay, nothing — even after it scrolls back into view. Read (and
  // cleared) by handleVisibilityChange on re-entry: see reentryTimersRef.
  const pendingOffscreenRef = useRef<Set<number>>(new Set());
  // Per-id one-shot grace timers armed by handleVisibilityChange when a
  // pendingOffscreenRef id re-enters the viewport (T-057/T-062): gives it
  // exactly one fresh STREAM_ERROR_MS window to resume decoding before
  // erroring, mirroring the mount/reconnect timers it substitutes for.
  const reentryTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const [loadingSet, setLoadingSet] = useState<Set<number>>(new Set());
  const [errorSet, setErrorSet] = useState<Set<number>>(new Set());
  const [degradedSet, setDegradedSet] = useState<Set<number>>(new Set());
  const [staleSet, setStaleSet] = useState<Set<number>>(new Set());
  // Stats via ref + subscriber pattern (avoids re-rendering entire tree every 1s)
  const statsRef = useRef<GridStreamStats>(EMPTY_STATS);
  const statsSubscribers = useRef(new Set<() => void>());
  const subscribeStats = useCallback((cb: () => void) => {
    statsSubscribers.current.add(cb);
    return () => { statsSubscribers.current.delete(cb); };
  }, []);
  const getStatsSnapshot = useCallback(() => statsRef.current, []);

  // Reconnect — delegated to sub-hook
  const {
    reconnectingSet,
    reconnectCountdown,
    reconnectAttempt,
    reconnectAttemptsRef,
    setReconnectingSet,
    scheduleReconnect,
    resetReconnect,
    cleanupReconnect,
  } = useGridReconnect();

  // Mutable counters — updated in the stream loop, read by the stats interval
  const bytesRef = useRef(0);

  // Worker ref — one worker per grid stream lifetime (mutable for restart)
  const workerRef = useRef<Worker | null>(null);

  // Pipeline diagnostics — tracks frame flow through each stage
  const pipelineRef = useRef({
    chunksReceived: 0,
    framesParsed: 0,
    framesSentToWorker: 0,
    framesFromWorker: 0,
    framesDrawn: 0,
    workerDecodeErrors: 0,
    workerDroppedFrames: 0,
    lastChunkTime: 0,
    lastWorkerFrameTime: 0,
    lastParseTime: 0,
    workerRestarts: 0,
    stallPingPending: false,
    workerExhausted: false,
  });

  // Ensure refs exist for all connected printers, clean up stale ones
  useEffect(() => {
    const ids = printerIdsKey ? printerIdsKey.split(',').map(Number) : [];
    const connectedIds = new Set(ids);
    for (const id of ids) {
      if (!canvasRefs.current.has(id)) {
        canvasRefs.current.set(id, { current: null });
      }
    }
    for (const id of canvasRefs.current.keys()) {
      if (!connectedIds.has(id)) {
        canvasRefs.current.delete(id);
      }
    }
  }, [printerIdsKey]);

  // Visibility callback — track locally (for the health pass below) and forward to worker
  const handleVisibilityChange = useCallback((printerId: number, visible: boolean) => {
    const wasVisible = visibilityRef.current.get(printerId) ?? true;
    visibilityRef.current.set(printerId, visible);
    if (visible && !wasVisible) {
      // Re-entering the viewport: lastFrameTime was frozen while off-screen
      // (the worker drops undecoded frames for invisible printers), not
      // because the stream died. Reset it to now so the tile gets a fresh
      // grace window instead of immediately reading as stale/degraded/error
      // before the next real decoded frame lands.
      lastFrameTimeRef.current.set(printerId, performance.now());

      // T-057/T-062: this id was skipped as "still missing" by the startup
      // timeout or the reconnect grace timer while invisible, and neither
      // one-shot timer re-arms itself. Give it exactly one fresh grace
      // window from re-entry: still missing when it elapses -> errored;
      // resumes decoding first -> handleWorkerMessage clears the pending
      // entry and cancels this timer, so a healthy resumed tile shows no
      // overlay (T-049 semantics preserved).
      if (pendingOffscreenRef.current.delete(printerId)) {
        const existingTimer = reentryTimersRef.current.get(printerId);
        if (existingTimer !== undefined) clearTimeout(existingTimer);
        const timer = setTimeout(() => {
          reentryTimersRef.current.delete(printerId);
          if (!loadedPrintersRef.current.has(printerId)) {
            setErrorSet(prev => {
              if (prev.has(printerId)) return prev;
              const next = new Set(prev);
              next.add(printerId);
              return next;
            });
          }
        }, STREAM_ERROR_MS);
        reentryTimersRef.current.set(printerId, timer);
      }
    }
    workerRef.current?.postMessage({ type: 'visibility', printerId, visible });
  }, []);

  useEffect(() => {
    const ids = printerIdsKey ? printerIdsKey.split(',').map(Number) : [];
    if (ids.length === 0) return;

    setLoadingSet(new Set(ids));
    setErrorSet(new Set());
    resetReconnect();

    bytesRef.current = 0;
    let t0 = performance.now();

    // Spin up worker for off-thread JPEG decoding
    let worker = new CameraGridDecoderWorker();
    workerRef.current = worker;

    // Seed worker with all printer IDs as visible — IntersectionObserver only
    // fires on changes, so already-visible cards won't re-notify a new worker.
    for (const id of ids) {
      worker.postMessage({ type: 'visibility', printerId: id, visible: true });
    }

    // Cache canvas 2D contexts — getContext is expensive to call per-frame
    const ctxCache = new Map<number, CanvasRenderingContext2D>();
    // Track canvas dimensions to avoid resetting every frame
    const dimCache = new Map<number, string>();
    // Track which printers have delivered at least one frame — a ref shared
    // with handleVisibilityChange (see hook-scope declaration above), so its
    // T-057/T-062 re-entry check reads the same live Set the health timers
    // below read/write.
    const loadedPrinters = loadedPrintersRef.current;
    loadedPrinters.clear();
    // Track last frame time per printer for stale camera detection — a ref
    // shared with handleVisibilityChange (see hook-scope declaration above),
    // reset here since every id starts seeded visible=true on connect.
    const lastFrameTime = lastFrameTimeRef.current;
    lastFrameTime.clear();
    visibilityRef.current.clear();
    pendingOffscreenRef.current.clear();
    const clearReentryTimers = () => {
      for (const timer of reentryTimersRef.current.values()) clearTimeout(timer);
      reentryTimersRef.current.clear();
    };
    clearReentryTimers();
    // Throttle "canvas ref null" logging — once per printer per 5s
    const nullCanvasLogTime = new Map<number, number>();

    const pipeline = pipelineRef.current;

    // Shared by the periodic health loop, armReconnectGraceTimer, and
    // startupTimeout (T-057): a printer counts as visible unless explicitly
    // marked otherwise — IntersectionObserver only fires on change, so an
    // already-visible card never explicitly notifies (see hook-scope
    // visibilityRef comment above).
    const isVisible = (id: number) => visibilityRef.current.get(id) ?? true;

    // Shared by armReconnectGraceTimer and startupTimeout (T-057): both fire
    // once, STREAM_ERROR_MS after arming, and need to classify every id that
    // still hasn't delivered a decoded frame (absent from loadedPrinters).
    // A missing-and-visible id genuinely never came up — error it now. A
    // missing-and-invisible one proves nothing yet (T-049: the worker never
    // decodes for invisible printers, so "missing" is expected, not a
    // failure) — record it in pendingOffscreenRef instead so
    // handleVisibilityChange gives it a fresh grace window once it scrolls
    // back into view (T-057/T-062), rather than leaving it unresolved
    // forever since neither timer re-arms itself.
    const markStillMissing = (candidateIds: number[]) => {
      const missingVisible: number[] = [];
      for (const id of candidateIds) {
        if (loadedPrinters.has(id)) continue;
        if (isVisible(id)) {
          missingVisible.push(id);
        } else {
          pendingOffscreenRef.current.add(id);
        }
      }
      if (missingVisible.length > 0) {
        setErrorSet(prev => {
          const next = new Set(prev);
          for (const id of missingVisible) next.add(id);
          return next;
        });
      }
    };

    // Grace-window timer re-armed on each successful reconnect (mirrors the
    // mount-time startupTimeout below, but per-reconnect): on reconnect both
    // loadedPrinters and lastFrameTime are cleared (see the reconnect-success
    // branch further down), so the health loop's `!loadedPrinters.has(id)`
    // guard skips any id that hasn't redelivered a decoded frame since —
    // indefinitely, if it never does. Without this timer a printer that
    // reconnects at the network level but never resumes decoding would sit
    // in NO state set at all: no spinner, no stale/degraded badge, no error
    // overlay, just frozen on its last frame forever. This surfaces the same
    // terminal error state once STREAM_ERROR_MS elapses with still no
    // decoded frame — unless the printer is currently off-screen, in which
    // case it stays exempt exactly like the ongoing health loop (T-049): a
    // frozen frame on an invisible tile proves nothing about the stream.
    let reconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
    const clearReconnectGraceTimer = () => {
      if (reconnectGraceTimer !== null) {
        clearTimeout(reconnectGraceTimer);
        reconnectGraceTimer = null;
      }
    };
    const armReconnectGraceTimer = () => {
      clearReconnectGraceTimer();
      reconnectGraceTimer = setTimeout(() => {
        reconnectGraceTimer = null;
        markStillMissing(ids);
      }, STREAM_ERROR_MS);
    };

    // Named handler so we can reattach after worker restart
    function handleWorkerMessage(e: MessageEvent): void {
      const { type } = e.data;

      if (type === 'decodeError') {
        pipeline.workerDecodeErrors++;
        console.debug(
          `[grid] Worker decode error: printerId=${e.data.printerId} totalErrors=${e.data.totalErrors} totalSuccess=${e.data.totalSuccess} visible=${e.data.visibleCount}`,
        );
        return;
      }

      if (type === 'pong') {
        pipeline.stallPingPending = false;
        pipeline.workerDroppedFrames = e.data.totalDroppedFrames ?? pipeline.workerDroppedFrames;
        console.debug(
          `[grid] Worker pong: visible=${e.data.visibleCount} pending=${e.data.pendingCount} decoding=${e.data.decodingCount} errors=${e.data.totalDecodeErrors} success=${e.data.totalDecodeSuccess} dropped=${e.data.totalDroppedFrames}`,
        );
        return;
      }

      if (type !== 'frame') return;
      const pid = e.data.printerId as number;
      const bitmap = e.data.bitmap as ImageBitmap;
      pipeline.framesFromWorker++;
      pipeline.lastWorkerFrameTime = performance.now();

      // A decoded frame proves the current worker (restarted or not) is
      // actually delivering again — replenish the restart budget so a wall
      // left running for days can survive more than MAX_WORKER_RESTARTS
      // stalls total, as long as each restart is followed by recovery. A
      // worker that stalls again immediately after restart without ever
      // delivering a frame never reaches this branch, so consecutive
      // unrecovered stalls still exhaust the budget exactly as before.
      if (pipeline.workerRestarts > 0) {
        pipeline.workerRestarts = 0;
      }

      // A decoded frame proves this printer is alive — always update tracking
      // and clear error/reconnecting/loading state, even if canvas isn't mounted.
      // The stats interval recomputes the "active" count from this timestamp
      // each tick rather than accumulating into a set, so a printer that stops
      // decoding drops back out of the live-camera count instead of being
      // counted forever.
      lastFrameTime.set(pid, performance.now());

      // T-057/T-062: a decoded frame resolves any pending re-entry check —
      // cancel its grace timer so it doesn't later error a tile that's
      // already delivering again.
      if (pendingOffscreenRef.current.delete(pid)) {
        const timer = reentryTimersRef.current.get(pid);
        if (timer !== undefined) {
          clearTimeout(timer);
          reentryTimersRef.current.delete(pid);
        }
      }

      setErrorSet(prev => {
        if (!prev.has(pid)) return prev;
        const next = new Set(prev);
        next.delete(pid);
        return next;
      });
      setReconnectingSet(prev => {
        if (!prev.has(pid)) return prev;
        const next = new Set(prev);
        next.delete(pid);
        return next;
      });
      if (!loadedPrinters.has(pid)) {
        loadedPrinters.add(pid);
        setLoadingSet(prev => {
          if (!prev.has(pid)) return prev;
          const next = new Set(prev);
          next.delete(pid);
          return next;
        });
      }

      // Draw to canvas if ref is available — otherwise just drop the bitmap
      const ref = canvasRefs.current.get(pid);
      const canvas = ref?.current;
      if (!canvas) {
        const now = performance.now();
        const lastLog = nullCanvasLogTime.get(pid) ?? 0;
        if (now - lastLog > 5000) {
          console.debug(`[grid] Canvas ref null for printer ${pid}`);
          nullCanvasLogTime.set(pid, now);
        }
        bitmap.close();
        return;
      }

      // Only reset canvas dimensions when they actually change
      const dimKey = `${bitmap.width}x${bitmap.height}`;
      if (dimCache.get(pid) !== dimKey) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        dimCache.set(pid, dimKey);
        ctxCache.delete(pid); // context invalidated
      }
      let ctx = ctxCache.get(pid);
      if (!ctx) {
        ctx = canvas.getContext('2d')!;
        ctxCache.set(pid, ctx);
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      pipeline.framesDrawn++;
    }

    worker.onmessage = handleWorkerMessage;

    let active = true;
    const controllerRef = { current: new AbortController() };
    let readerRef: ReadableStreamDefaultReader<Uint8Array> | null = null;

    // Compute stats every second
    const statsInterval = setInterval(() => {
      if (!active) return;
      const bytes = bytesRef.current;
      bytesRef.current = 0;
      const elapsed = Math.floor((performance.now() - t0) / 1000);

      // Detect degraded / stale / error cameras from last DECODED-frame time,
      // and derive the "active" count from the same data in the same pass —
      // a printer whose last decoded frame is stale no longer counts as live,
      // so the toolbar's live-camera count drops when a camera stops
      // delivering frames instead of only ever growing, and recovers on its
      // own once frames resume (lastFrameTime advances again).
      const now = performance.now();
      const errorIds: number[] = [];
      const newDegraded = new Set<number>();
      const newStale = new Set<number>();
      let activeCount = 0;
      for (const id of ids) {
        const last = lastFrameTime.get(id);
        if (!last || !loadedPrinters.has(id)) continue;
        if (!isVisible(id)) {
          // Off-screen: the worker deliberately drops this printer's frames
          // before decoding (workers/cameraGridDecoder.worker.ts), so
          // lastFrameTime is frozen by design — that's not evidence the
          // stream died. Exempt it from stale/degraded/error classification
          // and keep counting it toward "active" (it already delivered at
          // least one frame and its underlying stream is presumed alive,
          // just not decoded) so the toolbar reads N/N on a scrolled wall.
          activeCount++;
          continue;
        }
        const gap = now - last;
        if (gap > STREAM_ERROR_MS) {
          errorIds.push(id);
          loadedPrinters.delete(id); // allow first-frame detection to recover it
        } else if (gap > STREAM_DEGRADED_MS) {
          newDegraded.add(id);
          newStale.add(id);
        } else if (gap > STREAM_STALE_MS) {
          newStale.add(id);
        } else {
          activeCount++;
        }
      }

      statsRef.current = {
        bw: `${formatFileSize(bytes)}/s`,
        active: activeCount,
        total: ids.length,
        uptime: formatUptime(elapsed),
        rawBytesPerSecond: bytes,
        droppedFrames: pipeline.workerDroppedFrames,
      };
      statsSubscribers.current.forEach(cb => cb());

      if (errorIds.length > 0) {
        setErrorSet(prev => {
          const hasAll = errorIds.every(id => prev.has(id));
          if (hasAll && prev.size === errorIds.length) return prev;
          const next = new Set(prev);
          for (const id of errorIds) next.add(id);
          return next;
        });
      }
      setDegradedSet(prev => {
        if (prev.size === newDegraded.size && [...prev].every(id => newDegraded.has(id))) return prev;
        return newDegraded;
      });
      setStaleSet(prev => {
        if (prev.size === newStale.size && [...prev].every(id => newStale.has(id))) return prev;
        return newStale;
      });
    }, 1000);

    // Pipeline stats logging — directly every 10s.  The routine ping keeps
    // worker-side counters (dropped frames) flowing back via pong; any pong
    // also proves the worker is alive to the stall detector.
    const pipelineStatsInterval = setInterval(() => {
      if (!active) return;
      workerRef.current?.postMessage({ type: 'ping' });
      console.debug(
        `[grid] Pipeline: chunks=${pipeline.chunksReceived} parsed=${pipeline.framesParsed} →worker=${pipeline.framesSentToWorker} ←worker=${pipeline.framesFromWorker} drawn=${pipeline.framesDrawn} dropped=${pipeline.workerDroppedFrames} errors=${pipeline.workerDecodeErrors} restarts=${pipeline.workerRestarts}`,
      );
    }, 10_000);

    // Worker health monitor — detect and recover from stalled worker
    const healthInterval = setInterval(() => {
      if (!active) return;
      const now = performance.now();
      const dataFlowing = pipeline.lastParseTime > 0 && (now - pipeline.lastParseTime) < 5000;
      const workerSilent =
        (pipeline.lastWorkerFrameTime > 0 && (now - pipeline.lastWorkerFrameTime) > 15000) ||
        (pipeline.framesSentToWorker > 20 && pipeline.framesFromWorker === 0);

      if (dataFlowing && workerSilent) {
        if (!pipeline.stallPingPending) {
          // First detection: ping the worker to check if it's alive
          pipeline.stallPingPending = true;
          console.debug(
            `[grid] Worker stall detected — pinging. sent=${pipeline.framesSentToWorker} received=${pipeline.framesFromWorker} lastWorkerFrame=${pipeline.lastWorkerFrameTime > 0 ? Math.round(now - pipeline.lastWorkerFrameTime) + 'ms ago' : 'never'}`,
          );
          workerRef.current?.postMessage({ type: 'ping' });
        } else if (pipeline.workerRestarts < MAX_WORKER_RESTARTS) {
          // Ping was sent but stall persists — restart the worker
          pipeline.workerRestarts++;
          console.debug(`[grid] Restarting worker (attempt ${pipeline.workerRestarts}/${MAX_WORKER_RESTARTS})`);

          worker.terminate();
          worker = new CameraGridDecoderWorker();
          workerRef.current = worker;
          worker.onmessage = handleWorkerMessage;

          // Re-seed visibility for all printer IDs — mirror that reset in our
          // own tracking so the health pass doesn't keep treating ids as
          // invisible against a worker that now considers everything visible.
          visibilityRef.current.clear();
          for (const id of ids) {
            worker.postMessage({ type: 'visibility', printerId: id, visible: true });
          }

          // Reset worker-related pipeline counters
          pipeline.framesFromWorker = 0;
          pipeline.framesSentToWorker = 0;
          pipeline.workerDecodeErrors = 0;
          pipeline.lastWorkerFrameTime = 0;
          pipeline.stallPingPending = false;
        } else if (!pipeline.workerExhausted) {
          // Restarts exhausted and the worker is still not decoding — give up
          // restarting and surface a terminal error state for every tile instead
          // of silently leaving frozen frames on screen with no indication.
          pipeline.workerExhausted = true;
          console.debug(
            `[grid] Worker restarts exhausted (${MAX_WORKER_RESTARTS}) — marking all printers as unavailable`,
          );
          setErrorSet(new Set(ids));
          setDegradedSet(new Set());
          setStaleSet(new Set());
          setLoadingSet(new Set());
        }
      } else {
        // Worker is healthy or no data flowing — reset stall tracking
        pipeline.stallPingPending = false;
      }
    }, 5000);

    async function startMultiplexedStream() {
      while (active) {
      const gbuf = new GrowingBuffer(256 * 1024, 10 * 1024 * 1024);

      // Single resettable stall timer — cancels the reader if no data arrives in 45s.
      // Declared outside try so catch can clear it on error (prevents leaked timers
      // from cancelling a new connection's reader after reconnect).
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      const resetStallTimer = () => {
        if (stallTimer !== null) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          readerRef?.cancel().catch(() => {});
        }, 45_000);
      };

      try {
        const gridHeaders: Record<string, string> = {};
        const token = getAuthToken();
        if (token) gridHeaders['Authorization'] = `Bearer ${token}`;
        const streamUrl = `/api/v1/printers/camera/grid-stream?ids=${ids.join(',')}`;
        const res = await fetch(streamUrl, { signal: controllerRef.current.signal, headers: gridHeaders });
        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }

        // Connection successful — reset reconnect state, uptime, and first-frame tracker
        const wasReconnecting = reconnectAttemptsRef.current > 0;
        resetReconnect();
        t0 = performance.now();
        loadedPrinters.clear();
        // Clear together with loadedPrinters: the health loop only
        // classifies ids present in loadedPrinters, so leaving stale
        // pre-drop timestamps here would just move the "printer sits in no
        // state set at all" gap forward without closing it — see
        // armReconnectGraceTimer above for how a non-resuming printer is
        // now caught instead.
        lastFrameTime.clear();
        if (!wasReconnecting) {
          // Only show per-camera loading spinners on initial connect
          setLoadingSet(new Set(ids));
        } else {
          // Give reconnected printers the same bounded grace window as a
          // fresh connect: one that resumes decoding within it is re-added
          // to loadedPrinters by handleWorkerMessage before the timer
          // fires (so it's excluded from the timer's target set); one that
          // never resumes surfaces as errored instead of freezing silently
          // on its last frame forever.
          armReconnectGraceTimer();
        }
        setErrorSet(new Set());
        setDegradedSet(new Set());
        setStaleSet(new Set());

        // Reset pipeline counters on reconnect
        pipeline.chunksReceived = 0;
        pipeline.framesParsed = 0;
        pipeline.framesSentToWorker = 0;
        pipeline.framesFromWorker = 0;
        pipeline.framesDrawn = 0;
        pipeline.workerDecodeErrors = 0;
        pipeline.lastChunkTime = 0;
        pipeline.lastWorkerFrameTime = 0;
        pipeline.lastParseTime = 0;
        pipeline.stallPingPending = false;
        pipeline.workerExhausted = false;
        // Reconnecting at the network level also earns a fresh restart
        // budget — a wall that survived to reconnect shouldn't carry over
        // restart counts from before the outage.
        pipeline.workerRestarts = 0;

        const reader = res.body.getReader();
        readerRef = reader;
        resetStallTimer();

        while (active) {
          const { done, value } = await reader.read();
          if (!active) break;
          resetStallTimer();
          if (done) break;

          try {
            gbuf.append(value);
          } catch {
            console.error('Grid stream: buffer exceeded limit, resetting');
            gbuf.reset();
            break;
          }
          bytesRef.current += value.length;

          // Pipeline: track chunks and detect data gaps
          const chunkNow = performance.now();
          if (pipeline.lastChunkTime > 0 && (chunkNow - pipeline.lastChunkTime) > 3000) {
            console.debug(
              `[grid] Data gap: ${Math.round(chunkNow - pipeline.lastChunkTime)}ms since last chunk`,
            );
          }
          pipeline.chunksReceived++;
          pipeline.lastChunkTime = chunkNow;

          // Parse binary frames using extracted parser
          const { frames: parsedFrames, bytesConsumed } = parseGridFrames(gbuf.buffer, gbuf.byteOffset, gbuf.length);

          // Deliver frames parsed before any corruption point — they're intact.
          // NOTE: lastFrameTime (the map health/stale/error detection reads) is
          // deliberately NOT touched here — a frame arriving off the network only
          // proves the network is alive, not that it's been decoded and drawn.
          // It's written in handleWorkerMessage once the worker actually decodes
          // the frame, so a stalled decode worker correctly shows as stale/error
          // instead of reading as healthy forever.
          for (const frame of parsedFrames) {
            pipeline.framesParsed++;
            pipeline.framesSentToWorker++;
            pipeline.lastParseTime = performance.now();
            workerRef.current!.postMessage(
              { type: 'frame', printerId: frame.printerId, jpeg: frame.jpeg },
              [frame.jpeg],
            );
          }

          if (bytesConsumed === -1) {
            console.error('Grid stream: corrupt frame header, resetting buffer');
            gbuf.reset();
          } else if (bytesConsumed > 0) {
            // Compact: shift remaining bytes to front, release oversized buffers
            gbuf.compact(bytesConsumed);
            gbuf.shrinkIfSparse();
          }
        }

        if (stallTimer !== null) clearTimeout(stallTimer);

        // Stream ended cleanly (server closed) — treat as recoverable
        if (active) throw new Error('Stream ended');
      } catch (e: unknown) {
        if (stallTimer !== null) clearTimeout(stallTimer);

        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (!active) return;

        // Exponential backoff reconnect via sub-hook
        await scheduleReconnect(ids);

        if (!active) return;
        loadedPrinters.clear();
        clearReconnectGraceTimer();
        // Don't reset loadingSet here — the reconnect overlay already shows
        // the user we're reconnecting. Individual loading spinners would flicker.
        controllerRef.current = new AbortController();
        readerRef = null;
      }
      } // end while(active)
    }

    startMultiplexedStream();

    const startupTimeout = setTimeout(() => {
      markStillMissing(ids);
      setLoadingSet(new Set());
    }, STREAM_ERROR_MS);

    const onBeforeUnload = () => controllerRef.current.abort();
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      active = false;
      readerRef?.cancel().catch(() => {});
      controllerRef.current.abort();
      clearInterval(statsInterval);
      clearInterval(pipelineStatsInterval);
      clearInterval(healthInterval);
      clearTimeout(startupTimeout);
      clearReconnectGraceTimer();
      clearReentryTimers();
      cleanupReconnect();
      window.removeEventListener('beforeunload', onBeforeUnload);
      workerRef.current?.postMessage({ type: 'clear' });
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printerIdsKey, gridParamsKey, restartKey]);

  return {
    canvasRefs,
    loadingSet,
    errorSet,
    degradedSet,
    staleSet,
    reconnectingSet,
    reconnectCountdown,
    reconnectAttempt,
    subscribeStats,
    getStatsSnapshot,
    handleVisibilityChange,
  };
}
