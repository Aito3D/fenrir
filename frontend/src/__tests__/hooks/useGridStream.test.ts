/**
 * Tests for useGridStream constants, types, and the hook itself.
 *
 * The decode worker is imported via a Vite `?worker` specifier
 * (`../workers/cameraGridDecoder.worker?worker`), so it's replaced below
 * with a deterministic in-test double via `vi.mock` — jsdom has no real
 * Worker constructor. `global.fetch` is stubbed per-test to hand back a
 * `ReadableStream` body in the real `[4B printerId LE][4B length LE][jpeg]`
 * binary frame format the hook's own `parseGridFrames` expects (verified
 * against frontend/src/hooks/useGridStream.ts:13,24-45).
 *
 * Worker-internal decode behavior is covered by cameraGridDecoder.test.ts.
 * Reconnect backoff internals are covered by useGridReconnect tests below;
 * here we only assert that a stream failure schedules a reconnect.
 *
 * NOTE: several behaviors are intentionally NOT pinned here because they're
 * targeted by queued fixes (see PLAN.md T-007): health/stale derived from
 * parse-time (not decode-time) timestamps, no fetch connect-phase timeout,
 * worker restart re-marking all printers visible, activeCamsRef only
 * growing, no worker.onerror handler, and MAX_WORKER_RESTARTS giving up
 * silently. Tests below stick to the stable surface: first-frame loading
 * clear, frame parse+dispatch, stream-failure reconnect + startup timeout,
 * visibility forwarding, and unmount teardown.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useGridReconnect } from '../../hooks/useGridReconnect';
import { useGridStream, type GridStreamStats } from '../../hooks/useGridStream';

// --- Fake decode worker -----------------------------------------------
//
// The hook imports the worker as `new CameraGridDecoderWorker()` from a
// Vite `?worker` specifier. vi.mock replaces that module entirely, so the
// real worker file (and Vite's worker transform) is never touched.
const { workerInstances, FakeWorker } = vi.hoisted(() => {
  const instances: FakeWorkerInstance[] = [];
  interface FakeWorkerInstance {
    onmessage: ((e: MessageEvent) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  }
  class FakeWorker implements FakeWorkerInstance {
    onmessage: ((e: MessageEvent) => void) | null = null;
    postMessage = vi.fn();
    terminate = vi.fn();
    constructor() {
      instances.push(this);
    }
  }
  return { workerInstances: instances, FakeWorker };
});

vi.mock('../../workers/cameraGridDecoder.worker?worker', () => ({
  default: FakeWorker,
}));

/** Encode one grid-stream frame: [4B printerId LE][4B length LE][jpeg]. */
function encodeGridFrame(printerId: number, jpeg: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + jpeg.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, printerId, true);
  view.setUint32(4, jpeg.length, true);
  out.set(jpeg, 8);
  return out;
}

/** A ReadableStream that emits the given chunks once, then stays open (never closes). */
function openStreamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      }
      // Intentionally never closes — mirrors the real long-lived grid stream
      // and avoids tests racing the "stream ended -> reconnect" path.
    },
  });
}

function fakeResponse(body: ReadableStream<Uint8Array>): Response {
  return { ok: true, status: 200, body } as unknown as Response;
}

describe('GridStreamStats type', () => {
  it('has the expected shape', () => {
    const stats: GridStreamStats = {
      bw: '1.2 MB/s',
      active: 3,
      total: 5,
      uptime: '02:30',
      rawBytesPerSecond: 1258291,
      droppedFrames: 0,
    };
    expect(stats.bw).toBe('1.2 MB/s');
    expect(stats.active).toBe(3);
    expect(stats.total).toBe(5);
    expect(stats.uptime).toBe('02:30');
    expect(stats.rawBytesPerSecond).toBe(1258291);
    expect(stats.droppedFrames).toBe(0);
  });
});

describe('useGridReconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with zero state', () => {
    const { result } = renderHook(() => useGridReconnect());
    expect(result.current.reconnectAttempt).toBe(0);
    expect(result.current.reconnectCountdown).toBe(0);
    expect(result.current.reconnectingSet.size).toBe(0);
  });

  it('scheduleReconnect increments attempt and sets reconnectingSet', async () => {
    const { result } = renderHook(() => useGridReconnect());

    // Start reconnect (don't await — it waits for the delay)
    let resolved = false;
    act(() => {
      result.current.scheduleReconnect([1, 2]).then(() => { resolved = true; });
    });

    expect(result.current.reconnectAttempt).toBe(1);
    expect(result.current.reconnectingSet).toEqual(new Set([1, 2]));
    expect(result.current.reconnectCountdown).toBeGreaterThan(0);

    // Advance past the delay
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(resolved).toBe(true);
  });

  it('resetReconnect clears all state', () => {
    const { result } = renderHook(() => useGridReconnect());

    act(() => {
      result.current.scheduleReconnect([1]);
    });
    expect(result.current.reconnectAttempt).toBe(1);

    act(() => {
      result.current.resetReconnect();
    });
    expect(result.current.reconnectAttempt).toBe(0);
    expect(result.current.reconnectCountdown).toBe(0);
    expect(result.current.reconnectingSet.size).toBe(0);
  });

  it('exponential backoff increases delay', async () => {
    const { result } = renderHook(() => useGridReconnect());

    // First reconnect: countdown should be ~2s (ceil(2000/1000))
    act(() => {
      result.current.scheduleReconnect([1]);
    });
    const firstCountdown = result.current.reconnectCountdown;

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    // Second reconnect: countdown should be ~4s (ceil(4000/1000))
    act(() => {
      result.current.scheduleReconnect([1]);
    });
    const secondCountdown = result.current.reconnectCountdown;

    expect(secondCountdown).toBeGreaterThan(firstCountdown);
  });
});

describe('useGridStream', () => {
  beforeEach(() => {
    workerInstances.length = 0;
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('dispatches a parsed frame from the binary stream to the worker with the right printerId/payload', async () => {
    const jpeg = new Uint8Array([1, 2, 3, 4, 5]);
    const stream = openStreamFromChunks([encodeGridFrame(7, jpeg)]);
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(stream));
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() =>
      useGridStream({ printerIdsKey: '7', gridParamsKey: '', restartKey: 0 }),
    );

    const worker = workerInstances[0];
    await waitFor(() => {
      const frameCall = worker.postMessage.mock.calls.find((c: unknown[]) => (c[0] as { type?: string }).type === 'frame');
      expect(frameCall).toBeDefined();
    });

    const frameCall = worker.postMessage.mock.calls.find((c: unknown[]) => (c[0] as { type?: string }).type === 'frame')!;
    const [message, transfer] = frameCall as [{ type: string; printerId: number; jpeg: ArrayBuffer }, Transferable[]];
    expect(message.printerId).toBe(7);
    expect(new Uint8Array(message.jpeg)).toEqual(jpeg);
    expect(transfer).toEqual([message.jpeg]);

    unmount();
  });

  it('clears loadingSet for a printer once the worker delivers its first decoded frame, leaving others loading', () => {
    // fetch never resolves — isolates worker-message handling from the fetch/parse pipeline.
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    const { result } = renderHook(() =>
      useGridStream({ printerIdsKey: '1,2', gridParamsKey: '', restartKey: 0 }),
    );

    expect(result.current.loadingSet).toEqual(new Set([1, 2]));

    const worker = workerInstances[0];
    const bitmap = { close: vi.fn(), width: 10, height: 10 };
    act(() => {
      worker.onmessage?.({ data: { type: 'frame', printerId: 1, bitmap } } as MessageEvent);
    });

    expect(result.current.loadingSet.has(1)).toBe(false);
    expect(result.current.loadingSet.has(2)).toBe(true);
    expect(bitmap.close).toHaveBeenCalled();
  });

  it('on stream failure, schedules a reconnect immediately and marks printers errored if nothing loads within the startup timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const { result, unmount } = renderHook(() =>
      useGridStream({ printerIdsKey: '1', gridParamsKey: '', restartKey: 0 }),
    );

    // Flush the rejected fetch through the catch block into scheduleReconnect's
    // synchronous state updates (reconnectingSet is set before its internal delay).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.reconnectingSet.has(1)).toBe(true);
    expect(result.current.reconnectAttempt).toBeGreaterThanOrEqual(1);

    // Advance to the 45s startup timeout (STREAM_ERROR_MS) — independent of the
    // gap-based health/stale interval, this fires once from mount regardless of
    // whether any frame ever parsed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(result.current.errorSet.has(1)).toBe(true);
    expect(result.current.loadingSet.size).toBe(0);

    unmount();
  });

  it('handleVisibilityChange forwards a visibility message to the worker without re-fetching or restarting the worker', () => {
    const stream = openStreamFromChunks([]);
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(stream));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() =>
      useGridStream({ printerIdsKey: '1', gridParamsKey: '', restartKey: 0 }),
    );

    act(() => {
      result.current.handleVisibilityChange(1, false);
    });

    const worker = workerInstances[0];
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'visibility', printerId: 1, visible: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(workerInstances.length).toBe(1);
  });

  it('tears down the fetch and worker on unmount', async () => {
    const stream = openStreamFromChunks([]);
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(stream));
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = renderHook(() =>
      useGridStream({ printerIdsKey: '1', gridParamsKey: '', restartKey: 0 }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    const worker = workerInstances[0];
    unmount();

    expect(signal.aborted).toBe(true);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'clear' });
  });
});
