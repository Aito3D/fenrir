/**
 * Tests for useMjpegStream.
 *
 * The hook does real fetch + ReadableStream + createImageBitmap work that
 * jsdom doesn't provide, so `global.fetch` and `global.createImageBitmap`
 * are stubbed per-test. Frames are hand-built MJPEG byte sequences
 * (`[0xFF 0xD8] ... [0xFF 0xD9]`, matching the SOI/EOI markers the hook's
 * own parser looks for — verified against
 * frontend/src/hooks/useMjpegStream.ts:104,126) fed through a ReadableStream
 * body, mirroring the pattern used in useGridStream.test.ts.
 *
 * `canvasRef.current` is left `null` throughout: the hook only touches the
 * canvas when a ref is attached (`if (canvas) {...}`), so tests can exercise
 * the full decode pipeline — including the T-028 consecutive-decode-failure
 * budget below — without needing a real 2D rendering context, which jsdom
 * doesn't implement.
 *
 * T-028 (2026-08-16, user-approved behavior change): previously, if every
 * frame in a stream failed to decode (wrong content type, a truncated/
 * corrupt producer, an HTML error page framed as bytes), the hook silently
 * skipped every failure forever — `isLoading` stayed true and `onError` was
 * never called, so the viewer spun forever with no reconnect attempt. The
 * hook now counts *consecutive* decode failures and, once
 * MAX_CONSECUTIVE_DECODE_FAILURES (20) is reached, reports an error via the
 * same path a fetch/network failure uses (`hasError` + `onError`). The
 * counter resets on every successful decode, so intermittent corruption in
 * an otherwise-healthy stream never trips it.
 *
 * T-052 (2026-08-17, user-approved behavior change): the T-028 budget above
 * was terminal for callers that wire no `onError` (e.g. StreamOverlayPage) —
 * once tripped, the canvas stayed frozen forever with no reconnect attempt.
 * The hook now self-restarts with a bounded, backed-off retry when (and only
 * when) no `onError` handler is supplied; callers that do supply `onError`
 * (EmbeddedCameraViewer, CameraPage via useStreamReconnect) keep the exact
 * prior behavior — abort + a single `onError` call, no internal restart —
 * since they own their own reconnect machinery. These tests use fake timers
 * to drive the backoff deterministically without any wall-clock sleep.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useMjpegStream } from '../../hooks/useMjpegStream';

const MAX_CONSECUTIVE_DECODE_FAILURES = 20;
const SELF_RESTART_INITIAL_DELAY_MS = 2000;

/**
 * Advance the fake clock in small steps, giving pending promise chains (the
 * hook's `await reader.read()` / `await createImageBitmap()` loop) a chance
 * to flush between each step, until `predicate` is true. Fake timers only
 * mock `setTimeout`/`setInterval`, not Promise microtasks, but
 * `vi.advanceTimersByTimeAsync` interleaves a microtask flush with each
 * timer tick, so stepping repeatedly drains both without any real delay.
 */
async function pollUntil(predicate: () => boolean, { stepMs = 10, maxSteps = 800 } = {}) {
  for (let i = 0; i < maxSteps; i++) {
    if (predicate()) return;
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  throw new Error('pollUntil: condition was not met before maxSteps was reached');
}

/** One MJPEG frame: SOI marker, one payload byte (the id), EOI marker. */
function encodeJpegFrame(id: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, id & 0xff, 0xff, 0xd9]);
}

function concatFrames(frames: Uint8Array[]): Uint8Array {
  const total = frames.reduce((sum, f) => sum + f.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

/** A ReadableStream that emits the given chunks once, then stays open (never closes) — mirrors the real long-lived MJPEG stream. */
function openStreamFromChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      }
      // Intentionally never closes.
    },
  });
}

function fakeResponse(body: ReadableStream<Uint8Array>): Response {
  return { ok: true, status: 200, body } as unknown as Response;
}

/** A fake decoded bitmap satisfying the subset of ImageBitmap the hook touches. */
function fakeBitmap() {
  return { width: 1, height: 1, close: vi.fn() } as unknown as ImageBitmap;
}

const nullCanvasRef = { current: null } as React.RefObject<HTMLCanvasElement | null>;

describe('useMjpegStream', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('clears isLoading and fires onFirstFrame once a frame decodes successfully', async () => {
    const stream = openStreamFromChunks([concatFrames([encodeJpegFrame(1)])]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(stream)));
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(fakeBitmap()));

    const onFirstFrame = vi.fn();
    const onError = vi.fn();
    const { result, unmount } = renderHook(() =>
      useMjpegStream({ url: '/printers/1/camera/stream', canvasRef: nullCanvasRef, onFirstFrame, onError }),
    );

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isConnected).toBe(true);
    expect(result.current.hasError).toBe(false);
    expect(onFirstFrame).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    unmount();
  });

  it('T-028: reports an error and calls onError once consecutive decode failures reach the threshold', async () => {
    const frames = Array.from({ length: MAX_CONSECUTIVE_DECODE_FAILURES }, (_, i) => encodeJpegFrame(i + 1));
    const stream = openStreamFromChunks([concatFrames(frames)]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(stream)));
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('not a JPEG')));

    const onFirstFrame = vi.fn();
    const onError = vi.fn();
    const { result, unmount } = renderHook(() =>
      useMjpegStream({ url: '/printers/1/camera/stream', canvasRef: nullCanvasRef, onFirstFrame, onError }),
    );

    await waitFor(() => {
      expect(result.current.hasError).toBe(true);
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isConnected).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    // Never decoded — the spinner-forever bug this fixes means onFirstFrame must never fire.
    expect(onFirstFrame).not.toHaveBeenCalled();

    unmount();
  });

  it('T-028: does not trip the budget on fewer than the threshold of consecutive failures', async () => {
    const frames = Array.from(
      { length: MAX_CONSECUTIVE_DECODE_FAILURES - 1 },
      (_, i) => encodeJpegFrame(i + 1),
    );
    const stream = openStreamFromChunks([concatFrames(frames)]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(stream)));
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('not a JPEG')));

    const onError = vi.fn();
    const { result, unmount } = renderHook(() =>
      useMjpegStream({ url: '/printers/1/camera/stream', canvasRef: nullCanvasRef, onError }),
    );

    // Let every one of the (threshold - 1) failing frames flush through the
    // async decode loop before asserting nothing tripped.
    await waitFor(() => {
      expect(vi.mocked(createImageBitmap).mock.calls.length).toBe(MAX_CONSECUTIVE_DECODE_FAILURES - 1);
    });

    expect(result.current.hasError).toBe(false);
    expect(onError).not.toHaveBeenCalled();

    unmount();
  });

  it('T-028: a successful decode resets the consecutive-failure counter, so failures before and after a success never combine to trip the budget', async () => {
    const beforeCount = MAX_CONSECUTIVE_DECODE_FAILURES - 1;
    const afterCount = MAX_CONSECUTIVE_DECODE_FAILURES - 1;
    const frames = [
      ...Array.from({ length: beforeCount }, (_, i) => encodeJpegFrame(i + 1)),
      encodeJpegFrame(200), // the one successful decode, in the middle
      ...Array.from({ length: afterCount }, (_, i) => encodeJpegFrame(i + 100)),
    ];
    const stream = openStreamFromChunks([concatFrames(frames)]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(stream)));

    let call = 0;
    const bitmap = fakeBitmap();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockImplementation(() => {
        call += 1;
        // The single frame right after the "before" batch decodes successfully;
        // every other frame fails.
        if (call === beforeCount + 1) return Promise.resolve(bitmap);
        return Promise.reject(new Error('not a JPEG'));
      }),
    );

    const onFirstFrame = vi.fn();
    const onError = vi.fn();
    const { result, unmount } = renderHook(() =>
      useMjpegStream({ url: '/printers/1/camera/stream', canvasRef: nullCanvasRef, onFirstFrame, onError }),
    );

    // Wait for every frame (before + the success + after) to have been
    // attempted, i.e. the whole chunk has flushed through the decode loop.
    await waitFor(() => {
      expect(vi.mocked(createImageBitmap).mock.calls.length).toBe(beforeCount + 1 + afterCount);
    });

    // Without a reset on success, the pre- and post-success failure runs
    // would combine (beforeCount + afterCount >= threshold) and trip early.
    expect(result.current.hasError).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    expect(onFirstFrame).toHaveBeenCalledTimes(1);
    expect(result.current.isLoading).toBe(false);

    unmount();
  });

  it('does not treat a naturally-ending stream (clean EOF) as an error', async () => {
    const closingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse(closingStream)));
    vi.stubGlobal('createImageBitmap', vi.fn());

    const onError = vi.fn();
    const { result, unmount } = renderHook(() =>
      useMjpegStream({ url: '/printers/1/camera/stream', canvasRef: nullCanvasRef, onError }),
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.hasError).toBe(false);
    expect(onError).not.toHaveBeenCalled();

    unmount();
  });

  it('T-052: self-restarts after a backoff when no onError handler is supplied, and resumes once the new stream decodes', async () => {
    vi.useFakeTimers();

    const failingFrames = Array.from({ length: MAX_CONSECUTIVE_DECODE_FAILURES }, (_, i) => encodeJpegFrame(i + 1));
    const goodFrame = encodeJpegFrame(200);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(openStreamFromChunks([concatFrames(failingFrames)])))
      .mockResolvedValueOnce(fakeResponse(openStreamFromChunks([concatFrames([goodFrame])])));
    vi.stubGlobal('fetch', fetchMock);

    const bitmap = fakeBitmap();
    let decodeCalls = 0;
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockImplementation(() => {
        decodeCalls += 1;
        // Every frame from the first (failing) attempt is undecodable; the
        // single frame from the second (post-restart) attempt decodes fine.
        if (decodeCalls <= MAX_CONSECUTIVE_DECODE_FAILURES) return Promise.reject(new Error('not a JPEG'));
        return Promise.resolve(bitmap);
      }),
    );

    const onFirstFrame = vi.fn();
    // No onError — this mirrors StreamOverlayPage's bare useMjpegStream call.
    const { result, unmount } = renderHook(() =>
      useMjpegStream({ url: '/printers/1/camera/stream', canvasRef: nullCanvasRef, onFirstFrame }),
    );

    // The first attempt trips the decode budget almost immediately (no real
    // timer involved yet — just the frame-by-frame decode loop flushing).
    await pollUntil(() => result.current.hasError === true, { maxSteps: 50 });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isConnected).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Nothing should happen before the backoff elapses.
    await vi.advanceTimersByTimeAsync(SELF_RESTART_INITIAL_DELAY_MS - 100);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Once the backoff elapses, the hook restarts on its own and the new
    // stream's single good frame clears loading/error and resumes the canvas.
    await pollUntil(
      () => result.current.isLoading === false && result.current.hasError === false && result.current.isConnected,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onFirstFrame).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('T-052: a caller that supplies onError keeps exclusive control — no internal self-restart fires', async () => {
    vi.useFakeTimers();

    const failingFrames = Array.from({ length: MAX_CONSECUTIVE_DECODE_FAILURES }, (_, i) => encodeJpegFrame(i + 1));
    // Every fetch (were the hook ever to call it again) returns the same
    // always-failing stream, so a stray internal restart would be visible as
    // a second decode-budget trip / second onError call.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(fakeResponse(openStreamFromChunks([concatFrames(failingFrames)])));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('not a JPEG')));

    const onError = vi.fn();
    const { result, unmount } = renderHook(() =>
      useMjpegStream({ url: '/printers/1/camera/stream', canvasRef: nullCanvasRef, onError }),
    );

    await pollUntil(() => result.current.hasError === true, { maxSteps: 50 });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance well past the backoff window (and its cap) the onError-less
    // path would use — behavior must stay exactly as before T-052: the
    // caller (e.g. useStreamReconnect) owns recovery, so the hook must not
    // fetch again on its own.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(result.current.hasError).toBe(true);

    unmount();
  });

  it('T-052: unmounting during the backoff window cancels the pending self-restart', async () => {
    vi.useFakeTimers();

    const failingFrames = Array.from({ length: MAX_CONSECUTIVE_DECODE_FAILURES }, (_, i) => encodeJpegFrame(i + 1));
    const fetchMock = vi
      .fn()
      .mockResolvedValue(fakeResponse(openStreamFromChunks([concatFrames(failingFrames)])));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('not a JPEG')));

    // No onError — the self-restart-eligible path.
    const { result, unmount } = renderHook(() =>
      useMjpegStream({ url: '/printers/1/camera/stream', canvasRef: nullCanvasRef }),
    );

    await pollUntil(() => result.current.hasError === true, { maxSteps: 50 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Unmount partway through the backoff window, before the scheduled
    // restart would otherwise fire.
    await vi.advanceTimersByTimeAsync(SELF_RESTART_INITIAL_DELAY_MS / 2);
    unmount();

    // Advance well past when the restart would have fired had it not been
    // cancelled on unmount.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
