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
 * targeted by queued fixes (see PLAN.md T-007): no fetch connect-phase
 * timeout, worker restart re-marking all printers visible, no worker.onerror
 * handler. Tests below stick to the stable surface: first-frame loading
 * clear, frame parse+dispatch, stream-failure reconnect + startup timeout,
 * visibility forwarding, and unmount teardown.
 *
 * T-022 (2026-08-16, user-approved behavior change) fixed two related
 * health-tracking gaps and both are now pinned below: (1) stale/degraded/
 * error was previously derived from frame-*parse* time (network arrival),
 * so a dead decode worker still read as healthy forever — it's now derived
 * solely from frame-*decode* time (handleWorkerMessage); (2) once
 * MAX_WORKER_RESTARTS was exhausted the health monitor silently gave up —
 * it now surfaces a terminal error overlay on every tile.
 *
 * T-026 (2026-08-16, user-approved behavior change): the `active` count in
 * getStatsSnapshot() used to accumulate into a Set that only ever grew —
 * once a printer's first frame decoded it stayed "active" for the rest of
 * the session even if the camera died. It's now recomputed every stats tick
 * from the same last-decoded-frame gaps that drive staleSet, so a printer
 * drops out of the active count as soon as it goes stale, and rejoins once
 * frames resume.
 *
 * T-049 (2026-08-16, user-approved behavior change): the decode worker drops
 * frames for off-screen printers before decoding them (visibleSet check in
 * cameraGridDecoder.worker.ts), so lastFrameTime freezes for a scrolled-past
 * tile even though the underlying stream is still alive. The health pass now
 * reads the same visibility the hook forwards to the worker
 * (handleVisibilityChange) and exempts invisible printers from stale/
 * degraded/error classification, counting them as active instead — so the
 * toolbar reads N/N on a scrolled wall and a tile never comes back showing a
 * stale "Camera unavailable" overlay. On visible:false -> true it resets
 * that printer's lastFrameTime to now, giving it a fresh grace window rather
 * than instantly reading as stale/degraded/error against the old frozen
 * timestamp.
 *
 * T-050 (2026-08-16, user-approved behavior change): a successful reconnect
 * clears loadedPrinters but previously left lastFrameTime holding pre-drop
 * timestamps, and the health loop skips any id absent from loadedPrinters
 * (`if (!last || !loadedPrinters.has(id)) continue;`). A printer that
 * reconnected at the network level but never delivered another decoded
 * frame therefore sat in NO state set at all — no spinner, no stale/
 * degraded badge, no error overlay, just frozen on its last frame forever.
 * lastFrameTime is now cleared alongside loadedPrinters on every successful
 * reconnect, and a startup-style grace window (STREAM_ERROR_MS) is re-armed
 * per reconnect: a printer that redelivers within it is fine (re-added to
 * loadedPrinters by handleWorkerMessage before the timer fires); one that
 * never does surfaces in errorSet once the window elapses — unless it's
 * currently off-screen, composing with T-049's invisible exemption.
 *
 * T-057+T-062 (2026-08-16, user-approved behavior change): the mount-time
 * startupTimeout used to classify "still missing" (`!loadedPrinters.has(id)`)
 * with no visibility check at all — unlike its sibling timers (the periodic
 * health loop and armReconnectGraceTimer, both already exempting invisible
 * ids per T-049/T-050) — so an off-screen tile whose IntersectionObserver
 * fires before it ever decodes a frame got errored 45s after mount for no
 * reason. All three sites now share one `markStillMissing`/`isVisible`
 * helper pair so the exemption can't drift again. Separately, both
 * still-missing timers are one-shot and never re-arm: an id they skipped for
 * invisibility could sit unresolved forever (no spinner, no overlay, frozen)
 * even after scrolling back into view. Such ids are now recorded in a
 * pendingOffscreenRef set; handleVisibilityChange's false->true transition
 * arms a fresh one-shot STREAM_ERROR_MS grace timer for any id it finds
 * there — still missing when it elapses -> errored; resumes decoding first
 * (handleWorkerMessage) -> the pending entry and timer are cancelled, no
 * overlay (T-049 semantics preserved for a healthy resumed tile).
 *
 * T-051 (2026-08-16, user-approved behavior change): pipeline.workerRestarts
 * (the MAX_WORKER_RESTARTS=3 lifetime budget backing the terminal-error
 * latch above) was previously never replenished — on a wall left running
 * for days, three worker stalls that each successfully recovered would
 * permanently exhaust the budget, so a later fourth stall skipped
 * restarting and went straight to the terminal errorSet latch even though
 * the worker had been healthy in between. It's now reset to 0 (a) in
 * handleWorkerMessage once a restarted worker delivers a decoded frame
 * again, and (b) alongside workerExhausted on every successful network
 * reconnect — so only *consecutive, unrecovered* stalls still exhaust the
 * budget and latch the terminal state, exactly as before.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useGridReconnect } from '../../hooks/useGridReconnect';
import { useGridStream, type GridStreamStats } from '../../hooks/useGridStream';
import { STREAM_STALE_MS, STREAM_DEGRADED_MS, STREAM_ERROR_MS, RECONNECT_BASE_DELAY_MS } from '../../utils/streamConstants';

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

/**
 * A ReadableStream the test can push chunks into on demand (unlike
 * openStreamFromChunks, which drains a fixed list). Used where a test needs
 * to control exactly when frames arrive relative to fake-timer advances
 * (e.g. spreading network frames across several health-check intervals).
 * `error()` rejects the pending `reader.read()`, simulating a dropped
 * connection so the hook's catch block schedules a reconnect.
 */
function openPushableStream(): { stream: ReadableStream<Uint8Array>; push: (chunk: Uint8Array) => void; error: (err: unknown) => void } {
  let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
  });
  return {
    stream,
    push: chunk => controllerRef.enqueue(chunk),
    error: err => controllerRef.error(err),
  };
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

  it('derives stale/degraded/error from decoded-frame time, not from frames merely parsed off the network', async () => {
    vi.useFakeTimers();
    const jpeg = new Uint8Array([9, 9, 9]);
    const { stream, push } = openPushableStream();
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(stream));
    vi.stubGlobal('fetch', fetchMock);

    const { result, unmount } = renderHook(() =>
      useGridStream({ printerIdsKey: '1', gridParamsKey: '', restartKey: 0 }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Nudge the fake clock off exactly 0 first — performance.now() === 0 would
    // make the hook's `!last` falsy-timestamp guard treat this decoded frame
    // as if none had arrived yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    // A single decoded frame establishes the "last seen" baseline and clears loading.
    const worker = workerInstances[0];
    const bitmap = { close: vi.fn(), width: 1, height: 1 };
    act(() => {
      worker.onmessage?.({ data: { type: 'frame', printerId: 1, bitmap } } as MessageEvent);
    });
    expect(result.current.loadingSet.has(1)).toBe(false);

    // Keep raw network frames flowing every second — the worker never decodes
    // any of them again. If lastFrameTime were still written at parse time,
    // these would keep resetting the staleness clock and none of the
    // checkpoints below would ever fire.
    let elapsed = 0;
    while (elapsed < STREAM_ERROR_MS + 1000) {
      push(encodeGridFrame(1, jpeg));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      elapsed += 1000;

      if (elapsed === STREAM_STALE_MS + 1000) {
        expect(result.current.staleSet.has(1)).toBe(true);
        expect(result.current.degradedSet.has(1)).toBe(false);
        expect(result.current.errorSet.has(1)).toBe(false);
      }
      if (elapsed === STREAM_DEGRADED_MS + 1000) {
        expect(result.current.staleSet.has(1)).toBe(true);
        expect(result.current.degradedSet.has(1)).toBe(true);
        expect(result.current.errorSet.has(1)).toBe(false);
      }
    }
    expect(result.current.errorSet.has(1)).toBe(true);

    unmount();
  });

  it('drops a printer from the active count once its decoded frames go stale, and the printer rejoins once frames resume (T-026)', async () => {
    vi.useFakeTimers();
    // fetch never resolves — isolates the active-count math from the
    // network/parse pipeline; decoded frames are delivered directly via
    // worker.onmessage, same as the "clears loadingSet" test above.
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    const { result, unmount } = renderHook(() =>
      useGridStream({ printerIdsKey: '1,2', gridParamsKey: '', restartKey: 0 }),
    );

    const worker = workerInstances[0];
    const decode = (printerId: number) => {
      const bitmap = { close: vi.fn(), width: 1, height: 1 };
      act(() => {
        worker.onmessage?.({ data: { type: 'frame', printerId, bitmap } } as MessageEvent);
      });
    };

    // Nudge the clock off exactly 0 first (performance.now() === 0 would make
    // the hook's `!last` falsy-timestamp guard treat the decoded frame as if
    // none had arrived yet — same caveat as the T-022 test above).
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    decode(1);
    decode(2);

    // t=1000 (1st stats tick): both printers decoded ~1s ago — both active.
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(result.current.getStatsSnapshot().active).toBe(2);
    expect(result.current.getStatsSnapshot().total).toBe(2);

    // Keep printer 2 fresh every tick from here; printer 1 goes silent.
    decode(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); // t=2000
    expect(result.current.getStatsSnapshot().active).toBe(2);

    decode(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); // t=3000 — printer 1's gap (2999ms) is still within STREAM_STALE_MS
    expect(result.current.getStatsSnapshot().active).toBe(2);

    decode(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); // t=4000 — printer 1's gap (3999ms) now exceeds STREAM_STALE_MS
    const staleSnapshot = result.current.getStatsSnapshot();
    expect(staleSnapshot.active).toBe(1);
    expect(staleSnapshot.total).toBe(2);
    expect(result.current.staleSet.has(1)).toBe(true);
    expect(result.current.staleSet.has(2)).toBe(false);

    // Printer 1 resumes decoding — the active count recovers without a remount.
    decode(1);
    decode(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); // t=5000
    expect(result.current.getStatsSnapshot().active).toBe(2);
    expect(result.current.staleSet.has(1)).toBe(false);

    unmount();
  });

  it('exempts an off-screen printer from stale/degraded/error classification and keeps counting it active (T-049)', async () => {
    vi.useFakeTimers();
    // fetch never resolves — isolates the health-pass math from the network/parse pipeline.
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    const { result, unmount } = renderHook(() =>
      useGridStream({ printerIdsKey: '1,2', gridParamsKey: '', restartKey: 0 }),
    );

    const worker = workerInstances[0];
    const decode = (printerId: number) => {
      const bitmap = { close: vi.fn(), width: 1, height: 1 };
      act(() => {
        worker.onmessage?.({ data: { type: 'frame', printerId, bitmap } } as MessageEvent);
      });
    };

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    decode(1);
    decode(2);

    // Printer 1 scrolls off-screen — from now on the worker drops its frames
    // before decoding them, so its lastFrameTime is frozen going forward.
    act(() => {
      result.current.handleVisibilityChange(1, false);
    });

    // Keep printer 2 fresh every tick; printer 1 never decodes again — well
    // past STREAM_ERROR_MS, which would normally push it into errorSet.
    let elapsed = 0;
    while (elapsed < STREAM_ERROR_MS + 5000) {
      decode(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      elapsed += 1000;
    }

    // Mutation proof: removing the visibility exemption in the health pass
    // makes this fail (printer 1 would land in errorSet and drop out of
    // "active", same as the regression-pin test below shows for a visible
    // printer under an identical silence).
    expect(result.current.staleSet.has(1)).toBe(false);
    expect(result.current.degradedSet.has(1)).toBe(false);
    expect(result.current.errorSet.has(1)).toBe(false);
    expect(result.current.getStatsSnapshot().active).toBe(2);
    expect(result.current.getStatsSnapshot().total).toBe(2);

    unmount();
  });

  it('gives a printer a fresh grace window on becoming visible again, instead of reading stale against its frozen off-screen timestamp (T-049)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    const { result, unmount } = renderHook(() =>
      useGridStream({ printerIdsKey: '1', gridParamsKey: '', restartKey: 0 }),
    );

    const worker = workerInstances[0];
    const decode = (printerId: number) => {
      const bitmap = { close: vi.fn(), width: 1, height: 1 };
      act(() => {
        worker.onmessage?.({ data: { type: 'frame', printerId, bitmap } } as MessageEvent);
      });
    };

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    decode(1);

    act(() => {
      result.current.handleVisibilityChange(1, false);
    });

    // Sit off-screen well past STREAM_ERROR_MS — its lastFrameTime is frozen
    // at the moment it went invisible and would read as errored if visible.
    await act(async () => { await vi.advanceTimersByTimeAsync(STREAM_ERROR_MS + 1000); });
    expect(result.current.errorSet.has(1)).toBe(false); // exempt while invisible

    // Scroll back into view — handleVisibilityChange resets lastFrameTime to now.
    act(() => {
      result.current.handleVisibilityChange(1, true);
    });

    // One stats tick later, before any new decoded frame arrives: must NOT
    // instantly read as stale/degraded/errored against the old frozen
    // timestamp. Mutation proof: removing the reset-on-reentry makes this
    // fail (errorSet would immediately contain 1, since the frozen gap is
    // already ~46s).
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current.staleSet.has(1)).toBe(false);
    expect(result.current.degradedSet.has(1)).toBe(false);
    expect(result.current.errorSet.has(1)).toBe(false);
    expect(result.current.getStatsSnapshot().active).toBe(1);

    unmount();
  });

  it('a visible printer that stops decoding still stales/degrades/errors exactly as before, unaffected by the invisible exemption (T-049 regression pin for T-022/T-026)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    const { result, unmount } = renderHook(() =>
      useGridStream({ printerIdsKey: '1,2', gridParamsKey: '', restartKey: 0 }),
    );

    const worker = workerInstances[0];
    const decode = (printerId: number) => {
      const bitmap = { close: vi.fn(), width: 1, height: 1 };
      act(() => {
        worker.onmessage?.({ data: { type: 'frame', printerId, bitmap } } as MessageEvent);
      });
    };

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    decode(1);
    decode(2);

    // Neither printer's visibility is ever touched — both stay at the
    // default visible=true, exercising the exact pre-T-049 code path.
    let elapsed = 0;
    while (elapsed < STREAM_ERROR_MS + 1000) {
      decode(2); // printer 2 stays fresh; printer 1 goes silent
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      elapsed += 1000;

      if (elapsed === STREAM_STALE_MS + 1000) {
        expect(result.current.staleSet.has(1)).toBe(true);
        expect(result.current.degradedSet.has(1)).toBe(false);
      }
      if (elapsed === STREAM_DEGRADED_MS + 1000) {
        expect(result.current.degradedSet.has(1)).toBe(true);
      }
    }
    expect(result.current.errorSet.has(1)).toBe(true);
    expect(result.current.getStatsSnapshot().active).toBe(1);

    unmount();
  });

  it('after a reconnect, a printer that never resumes decoding lands in errorSet instead of freezing in no state at all (T-050)', async () => {
    vi.useFakeTimers();
    const jpeg = new Uint8Array([1, 2, 3]);
    const { stream: stream1, push: push1, error: dropStream1 } = openPushableStream();
    const { stream: stream2, push: push2 } = openPushableStream();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fakeResponse(stream1))
      .mockResolvedValueOnce(fakeResponse(stream2));
    vi.stubGlobal('fetch', fetchMock);

    const { result, unmount } = renderHook(() =>
      useGridStream({ printerIdsKey: '1,2', gridParamsKey: '', restartKey: 0 }),
    );

    const decode = (printerId: number) => {
      const worker = workerInstances[0];
      const bitmap = { close: vi.fn(), width: 1, height: 1 };
      act(() => {
        worker.onmessage?.({ data: { type: 'frame', printerId, bitmap } } as MessageEvent);
      });
    };

    // Initial connect: both printers decode successfully.
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    decode(1);
    decode(2);
    expect(result.current.loadingSet.size).toBe(0);

    // Survive well past the mount-time startupTimeout (a one-shot timer
    // that fires once, STREAM_ERROR_MS after mount, and separately marks
    // any still-not-loaded printer errored) with keep-alive network chunks
    // on stream1 so it fires as a no-op — both printers are already loaded.
    // This isolates the *reconnect* grace timer below as the only
    // mechanism that can classify printer 2 after the later drop: without
    // this, the drop+reconnect below would happen to land inside the
    // mount timer's own window and the test couldn't tell the two timers
    // apart.
    let pre = 0;
    while (pre < STREAM_ERROR_MS + 5000) {
      push1(encodeGridFrame(1, jpeg));
      decode(1);
      decode(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      pre += 1000;
    }
    expect(result.current.errorSet.size).toBe(0);

    // Stream drops — the catch block schedules a reconnect.
    await act(async () => {
      dropStream1(new Error('network drop'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.reconnectingSet).toEqual(new Set([1, 2]));

    // Advance past the reconnect backoff so the retry fetch (stream2) fires
    // and succeeds.
    await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS + 100); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.reconnectingSet.size).toBe(0);

    // Printer 1 resumes decoding every tick from here; printer 2 never
    // decodes again after the reconnect. Keep-alive chunks on stream2 keep
    // the connection itself alive throughout (a printer that "reconnects
    // at the network level but never resumes decoding" is exactly the
    // scenario this fix targets).
    let elapsed = 0;
    while (elapsed < STREAM_ERROR_MS - 1000) {
      push2(encodeGridFrame(1, jpeg));
      decode(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      elapsed += 1000;
    }
    // Just before the reconnect grace window elapses: printer 2 must not
    // yet be flagged, and printer 1 (resumed) must show no spurious state.
    expect(result.current.errorSet.has(2)).toBe(false);
    expect(result.current.staleSet.has(2)).toBe(false);
    expect(result.current.errorSet.has(1)).toBe(false);
    expect(result.current.staleSet.has(1)).toBe(false);

    // Cross the grace window (STREAM_ERROR_MS since the reconnect
    // succeeded): printer 2 — never redelivered — must now be flagged
    // errored instead of sitting frozen with no state at all. Mutation
    // proof: reverting the lastFrameTime.clear()/armReconnectGraceTimer
    // fix leaves printer 2 permanently absent from loadedPrinters with a
    // stale-but-present lastFrameTime entry, which the health loop's
    // `!loadedPrinters.has(id)` guard skips forever — verified by
    // temporarily reverting the fix, which leaves errorSet empty for the
    // rest of this test.
    push2(encodeGridFrame(1, jpeg));
    decode(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current.errorSet.has(2)).toBe(true);
    expect(result.current.errorSet.has(1)).toBe(false);
    expect(result.current.staleSet.has(1)).toBe(false);
    expect(result.current.degradedSet.has(1)).toBe(false);

    unmount();
  });

  it('a normal reconnect where every printer resumes shows no spurious stale/degraded/error state (T-050 regression pin)', async () => {
    vi.useFakeTimers();
    const jpeg = new Uint8Array([1, 2, 3]);
    const { stream: stream1, error: dropStream1 } = openPushableStream();
    const { stream: stream2, push: push2 } = openPushableStream();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fakeResponse(stream1))
      .mockResolvedValueOnce(fakeResponse(stream2));
    vi.stubGlobal('fetch', fetchMock);

    const { result, unmount } = renderHook(() =>
      useGridStream({ printerIdsKey: '1,2', gridParamsKey: '', restartKey: 0 }),
    );

    const decode = (printerId: number) => {
      const worker = workerInstances[0];
      const bitmap = { close: vi.fn(), width: 1, height: 1 };
      act(() => {
        worker.onmessage?.({ data: { type: 'frame', printerId, bitmap } } as MessageEvent);
      });
    };

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    decode(1);
    decode(2);

    await act(async () => {
      dropStream1(new Error('network drop'));
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS + 100); });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Both printers resume decoding every tick — well past the reconnect
    // grace window (STREAM_ERROR_MS) — and neither should ever show a
    // stale/degraded/error overlay. Keep-alive chunks on stream2 prevent an
    // unrelated natural stall-timeout reconnect from confusing the result.
    let elapsed = 0;
    while (elapsed < STREAM_ERROR_MS + 2000) {
      push2(encodeGridFrame(1, jpeg));
      decode(1);
      decode(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      elapsed += 1000;
    }

    expect(result.current.errorSet.size).toBe(0);
    expect(result.current.staleSet.size).toBe(0);
    expect(result.current.degradedSet.size).toBe(0);
    expect(result.current.loadingSet.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    unmount();
  });

  it('a printer that never resumes after reconnect stays exempt from errorSet while off-screen (T-050 composes with T-049)', async () => {
    vi.useFakeTimers();
    const jpeg = new Uint8Array([1, 2, 3]);
    const { stream: stream1, push: push1, error: dropStream1 } = openPushableStream();
    const { stream: stream2, push: push2 } = openPushableStream();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fakeResponse(stream1))
      .mockResolvedValueOnce(fakeResponse(stream2));
    vi.stubGlobal('fetch', fetchMock);

    const { result, unmount } = renderHook(() =>
      useGridStream({ printerIdsKey: '1,2', gridParamsKey: '', restartKey: 0 }),
    );

    const decode = (printerId: number) => {
      const worker = workerInstances[0];
      const bitmap = { close: vi.fn(), width: 1, height: 1 };
      act(() => {
        worker.onmessage?.({ data: { type: 'frame', printerId, bitmap } } as MessageEvent);
      });
    };

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    decode(1);
    decode(2);

    // Survive well past the mount-time startupTimeout with keep-alive
    // network chunks — its own `!loadedPrinters.has(id)` check has no
    // visibility exemption, so without this the mount timer (not the
    // reconnect grace timer under test) would be the one marking printer 2
    // errored below regardless of its off-screen state.
    let pre = 0;
    while (pre < STREAM_ERROR_MS + 5000) {
      push1(encodeGridFrame(1, jpeg));
      decode(1);
      decode(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      pre += 1000;
    }
    expect(result.current.errorSet.size).toBe(0);

    await act(async () => {
      dropStream1(new Error('network drop'));
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS + 100); });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Printer 2 scrolls off-screen right after the reconnect succeeds and
    // never resumes decoding; printer 1 resumes decoding every tick.
    act(() => {
      result.current.handleVisibilityChange(2, false);
    });

    let elapsed = 0;
    while (elapsed < STREAM_ERROR_MS + 5000) {
      push2(encodeGridFrame(1, jpeg));
      decode(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      elapsed += 1000;
    }

    // Mutation proof: removing the visibility check inside
    // armReconnectGraceTimer's stillMissing filter makes this fail —
    // printer 2 would land in errorSet exactly like the unconditional-bug
    // test above, even while off-screen.
    expect(result.current.errorSet.has(2)).toBe(false);
    expect(result.current.staleSet.has(2)).toBe(false);
    expect(result.current.degradedSet.has(2)).toBe(false);
    expect(result.current.errorSet.has(1)).toBe(false);

    unmount();
  });

  it('an off-screen printer that never decodes is NOT errored by the mount-time startup timeout while invisible (T-057)', async () => {
    vi.useFakeTimers();
    // fetch never resolves — isolates the startup timeout from the
    // network/parse pipeline, same isolation strategy as the T-049 tests above.
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    const { result, unmount } = renderHook(() =>
      useGridStream({ printerIdsKey: '1', gridParamsKey: '', restartKey: 0 }),
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    // Off-screen before it ever delivers a single decoded frame — mirrors a
    // CameraGridCard whose IntersectionObserver fires immediately on mount
    // for a tile below the fold on a scrolled multi-page camera wall.
    act(() => {
      result.current.handleVisibilityChange(1, false);
    });

    // Mutation proof: removing the visibility check from startupTimeout's
    // still-missing filter (i.e. reverting to the pre-T-057
    // `ids.filter(id => !loadedPrinters.has(id))`) makes this fail — printer
    // 1 would land in errorSet 45s after mount purely because it's
    // off-screen, exactly the bug T-050 already fixed for the sibling
    // reconnect-grace timer.
    await act(async () => { await vi.advanceTimersByTimeAsync(STREAM_ERROR_MS); });
    expect(result.current.errorSet.has(1)).toBe(false);
    expect(result.current.loadingSet.size).toBe(0);

    unmount();
  });

  it('a printer skipped by the startup timeout while off-screen errors after its own re-entry grace window elapses without decoding (T-062)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    const { result, unmount } = renderHook(() =>
      useGridStream({ printerIdsKey: '1', gridParamsKey: '', restartKey: 0 }),
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    act(() => {
      result.current.handleVisibilityChange(1, false);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(STREAM_ERROR_MS); });
    expect(result.current.errorSet.has(1)).toBe(false); // still exempt while invisible (T-057)

    // Scrolls back into view but the stream never resumes decoding for it —
    // neither the startup timeout nor the reconnect grace timer re-arms
    // itself, so without a re-entry check this id would sit frozen with no
    // spinner and no overlay forever, even after coming back on-screen.
    act(() => {
      result.current.handleVisibilityChange(1, true);
    });

    // Just before the fresh re-entry grace window elapses: still exempt — it
    // gets the *full* STREAM_ERROR_MS window from re-entry, not an instant
    // verdict against however long it happened to sit off-screen before.
    await act(async () => { await vi.advanceTimersByTimeAsync(STREAM_ERROR_MS - 1000); });
    expect(result.current.errorSet.has(1)).toBe(false);

    // Mutation proof: removing the re-entry re-evaluation in
    // handleVisibilityChange (the pendingOffscreenRef check that arms this
    // timer on the false->true transition) makes this fail — printer 1
    // would never enter errorSet at all, sitting unresolved indefinitely
    // instead of surfacing here.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current.errorSet.has(1)).toBe(true);

    unmount();
  });

  it('an off-screen printer that scrolls back into view and decodes before its re-entry grace window elapses shows no overlay and counts active (T-057/T-062 recovery)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    const { result, unmount } = renderHook(() =>
      useGridStream({ printerIdsKey: '1', gridParamsKey: '', restartKey: 0 }),
    );

    const worker = workerInstances[0];
    const decode = (printerId: number) => {
      const bitmap = { close: vi.fn(), width: 1, height: 1 };
      act(() => {
        worker.onmessage?.({ data: { type: 'frame', printerId, bitmap } } as MessageEvent);
      });
    };

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    // Invisible from the very start — never delivers a decoded frame before
    // the mount-time startup timeout fires.
    act(() => {
      result.current.handleVisibilityChange(1, false);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(STREAM_ERROR_MS); });
    expect(result.current.errorSet.has(1)).toBe(false);

    // Scrolls back into view and decodes shortly after — well within the
    // fresh re-entry grace window — so it must read exactly like a tile
    // that had never gone missing: no overlay at all, counted active.
    act(() => {
      result.current.handleVisibilityChange(1, true);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    decode(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    expect(result.current.errorSet.has(1)).toBe(false);
    expect(result.current.staleSet.has(1)).toBe(false);
    expect(result.current.degradedSet.has(1)).toBe(false);
    expect(result.current.loadingSet.has(1)).toBe(false);
    expect(result.current.getStatsSnapshot().active).toBe(1);

    unmount();
  });

  it('a visible printer that never decodes is still errored by the startup timeout exactly as before (regression pin for the T-057 shared-helper refactor)', async () => {
    vi.useFakeTimers();
    // fetch never resolves — isolates the startup timeout from the
    // reconnect-scheduling path exercised by the earlier "on stream
    // failure..." test, so this pins the timer's own classification logic
    // in isolation for a printer whose visibility is never touched (stays
    // at the default visible=true).
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    const { result, unmount } = renderHook(() =>
      useGridStream({ printerIdsKey: '1', gridParamsKey: '', restartKey: 0 }),
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(STREAM_ERROR_MS); });
    expect(result.current.errorSet.has(1)).toBe(true);
    expect(result.current.loadingSet.size).toBe(0);

    unmount();
  });

  it('marks every tile with a terminal error once worker restarts are exhausted, even while frames keep arriving off the network (also T-051 regression pin: consecutive unrecovered stalls still latch)', async () => {
    vi.useFakeTimers();
    const jpeg = new Uint8Array([1, 2, 3]);
    const { stream, push } = openPushableStream();
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(stream));
    vi.stubGlobal('fetch', fetchMock);

    const { result, unmount } = renderHook(() =>
      useGridStream({ printerIdsKey: '1', gridParamsKey: '', restartKey: 0 }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // The worker never responds to any 'frame' postMessage — decode is
    // permanently stalled — while raw network frames keep arriving fast
    // enough (a burst every 1s, well under the 5s health-check window) to
    // keep the health monitor's "data flowing" check satisfied and to push
    // framesSentToWorker back over its restart-trigger threshold (20) well
    // within each 5s window after every reset. The health monitor pings,
    // then restarts the worker, 3 times (MAX_WORKER_RESTARTS) — each
    // restart/ping pair spans two 5s ticks — then gives up on the 8th tick
    // (t=40s) and must mark every tile with a terminal error instead of
    // leaving it silently stalled.
    let elapsed = 0;
    while (elapsed < 40_000) {
      for (let i = 0; i < 10; i++) push(encodeGridFrame(1, jpeg));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      elapsed += 1000;
    }

    expect(result.current.errorSet).toEqual(new Set([1]));
    expect(result.current.degradedSet.size).toBe(0);
    expect(result.current.staleSet.size).toBe(0);
    expect(result.current.loadingSet.size).toBe(0);
    // Original worker + one replacement per restart (MAX_WORKER_RESTARTS = 3).
    expect(workerInstances.length).toBe(4);
    expect(workerInstances[0].terminate).toHaveBeenCalledTimes(1);
    expect(workerInstances[1].terminate).toHaveBeenCalledTimes(1);
    expect(workerInstances[2].terminate).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('replenishes the worker-restart budget once a restarted worker delivers a decoded frame again, so a 4th stall still restarts instead of latching a terminal error (T-051)', async () => {
    vi.useFakeTimers();
    const jpeg = new Uint8Array([1, 2, 3]);
    const { stream, push } = openPushableStream();
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(stream));
    vi.stubGlobal('fetch', fetchMock);

    const { result, unmount } = renderHook(() =>
      useGridStream({ printerIdsKey: '1', gridParamsKey: '', restartKey: 0 }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Deliver one decoded frame from whichever worker is currently active —
    // this is the "restarted worker recovers" signal the fix listens for.
    const decodeOnLatestWorker = () => {
      const worker = workerInstances[workerInstances.length - 1];
      const bitmap = { close: vi.fn(), width: 1, height: 1 };
      act(() => {
        worker.onmessage?.({ data: { type: 'frame', printerId: 1, bitmap } } as MessageEvent);
      });
    };

    // Keep raw network frames flowing 1s at a time (satisfies the health
    // monitor's "data flowing" check) until a new worker instance appears
    // (a restart happened). Capped well above the known cadence so a
    // regression that stops restarting fails loudly instead of hanging.
    const driveUntilRestart = async (previousCount: number) => {
      let elapsed = 0;
      while (workerInstances.length === previousCount && elapsed < 60_000) {
        for (let i = 0; i < 10; i++) push(encodeGridFrame(1, jpeg));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        elapsed += 1000;
      }
      expect(workerInstances.length).toBeGreaterThan(previousCount);
    };

    // Three stall -> restart -> recover cycles. Each one burns a restart,
    // but recovering (a decoded frame from the replacement worker) resets
    // the budget back to 0, so it never accumulates toward
    // MAX_WORKER_RESTARTS (3) across cycles.
    for (let cycle = 0; cycle < 3; cycle++) {
      await driveUntilRestart(workerInstances.length);
      decodeOnLatestWorker();
      expect(result.current.errorSet.size).toBe(0);
    }

    // A 4th stall: without the fix, workerRestarts would already sit at 3
    // (MAX_WORKER_RESTARTS) here, so the health monitor would skip
    // restarting entirely and go straight to the terminal errorSet latch
    // instead of spinning up a 5th worker instance.
    const before4th = workerInstances.length;
    await driveUntilRestart(before4th);

    expect(result.current.errorSet.size).toBe(0);
    expect(workerInstances.length).toBe(before4th + 1);

    unmount();
  });

  it('resets the worker-restart budget on a successful network reconnect, so a stalled worker gets the full restart budget again afterward (T-051)', async () => {
    vi.useFakeTimers();
    const jpeg = new Uint8Array([1, 2, 3]);
    const { stream: stream1, push: push1, error: dropStream1 } = openPushableStream();
    const { stream: stream2, push: push2 } = openPushableStream();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(fakeResponse(stream1))
      .mockResolvedValueOnce(fakeResponse(stream2));
    vi.stubGlobal('fetch', fetchMock);

    const { result, unmount } = renderHook(() =>
      useGridStream({ printerIdsKey: '1', gridParamsKey: '', restartKey: 0 }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Never decoding a frame for printer 1 anywhere in this test means it
    // never joins loadedPrinters, so it stays inside the mount-time startup
    // timeout's and the post-reconnect grace timer's STREAM_ERROR_MS (45s)
    // windows the whole time — bound the total time this test spends
    // driving stalls well under 45s so neither of those unrelated timers
    // fires and pollutes errorSet independently of the restart-budget logic
    // under test here.
    const driveUntilRestart = async (push: (c: Uint8Array) => void, previousCount: number) => {
      let elapsed = 0;
      while (workerInstances.length === previousCount && elapsed < 20_000) {
        for (let i = 0; i < 10; i++) push(encodeGridFrame(1, jpeg));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        elapsed += 1000;
      }
      expect(workerInstances.length).toBeGreaterThan(previousCount);
    };

    // Burn 1 of the 3 lifetime restarts before ever reconnecting. The
    // worker never decodes a frame in this phase, so nothing here would
    // reset the budget on its own — only the reconnect below should.
    await driveUntilRestart(push1, workerInstances.length);

    // Drop the connection and let it reconnect at the network level.
    await act(async () => {
      dropStream1(new Error('network drop'));
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_BASE_DELAY_MS + 100);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Post-reconnect, the worker still never decodes. Mutation proof:
    // without resetting workerRestarts alongside workerExhausted on
    // reconnect, the budget would already sit at 1/3 here, so only 2 more
    // restarts would be available and the 3rd driveUntilRestart call below
    // would fail its own "a new worker instance appeared" assertion — the
    // health monitor would skip straight to the terminal errorSet latch
    // instead of restarting a 3rd time. With the fix the full 3-restart
    // budget is available again post-reconnect.
    await driveUntilRestart(push2, workerInstances.length); // 1st post-reconnect restart
    expect(result.current.errorSet.size).toBe(0);
    await driveUntilRestart(push2, workerInstances.length); // 2nd post-reconnect restart
    expect(result.current.errorSet.size).toBe(0);
    await driveUntilRestart(push2, workerInstances.length); // 3rd post-reconnect restart
    expect(result.current.errorSet.size).toBe(0);

    // A 4th consecutive stall post-reconnect (no recovery in between)
    // finally exhausts the replenished budget — pinning that the reset is
    // bounded, not a way to dodge the terminal state forever. Also assert
    // no further worker instance is spun up: this test's printer never
    // joins loadedPrinters (it never decodes), so the unrelated mount-time
    // startup-timeout / reconnect-grace-timer (both STREAM_ERROR_MS-based,
    // see file-header T-050 note) would independently populate errorSet
    // around the same wall-clock point — checking that no 4th post-reconnect
    // worker was created is what actually pins the exhaustion path here,
    // not just an errorSet size coincidence.
    const instancesBeforeFinalStall = workerInstances.length;
    let elapsed = 0;
    while (result.current.errorSet.size === 0 && elapsed < 20_000) {
      for (let i = 0; i < 10; i++) push2(encodeGridFrame(1, jpeg));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      elapsed += 1000;
    }
    expect(result.current.errorSet).toEqual(new Set([1]));
    expect(workerInstances.length).toBe(instancesBeforeFinalStall);

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
