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
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useMjpegStream } from '../../hooks/useMjpegStream';

const MAX_CONSECUTIVE_DECODE_FAILURES = 20;

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
});
