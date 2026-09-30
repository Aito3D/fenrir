/**
 * Tests for useWebRTCStream ICE state handling, and (T-053) the SDP
 * negotiation timeout.
 *
 * ICE 'disconnected' is often transient and must NOT trigger the error/
 * reconnect path (the frame monitor catches genuinely dead streams);
 * 'failed' must error and schedule a reconnect, and reconnectAttempt must
 * be reflected as state (not a stale ref read).
 *
 * T-053 (2026-08-17, user-approved behavior change): `api.webrtcOffer` was
 * awaited with no timeout. If go2rtc accepted the POST and never answered,
 * that await never settled — isLoading stayed true forever, with no error
 * and no reconnect. The hook now races the offer against a bounded
 * NEGOTIATION_TIMEOUT_MS (15s, half the existing 30s post-answer connection
 * watchdog); a timeout routes into the same catch a network/negotiation
 * error already uses, so hasError flips and scheduleReconnect runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWebRTCStream } from '../../hooks/useWebRTCStream';
import { api } from '../../api/client';
import { RECONNECT_BASE_DELAY_MS, STREAM_STALE_MS, STREAM_DEGRADED_MS, STREAM_ERROR_MS } from '../../utils/streamConstants';

vi.mock('../../api/client', () => ({
  api: { webrtcOffer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'v=0' }) },
  withStreamToken: (url: string) => url,
}));

const NEGOTIATION_TIMEOUT_MS = 15_000;

let lastPc: FakePeerConnection | null = null;

class FakePeerConnection {
  iceConnectionState = 'new';
  ontrack: ((e: unknown) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  // ICE connects as soon as the answer lands, as it does on a LAN — the
  // no-connect MSE fallback has its own suite (useWebRTCStream.mseFallback).
  setRemoteDescription = vi.fn(async () => {
    this.iceConnectionState = 'connected';
    this.oniceconnectionstatechange?.();
  });
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- capture the instance for test assertions
    lastPc = this;
  }
  addTransceiver() {}
  async createOffer() {
    return { sdp: 'v=0' };
  }
  async setLocalDescription() {}
  async getStats() {
    return { forEach: () => {} };
  }
  close() {}
}

function renderStream() {
  const videoRef = { current: document.createElement('video') };
  // jsdom's HTMLMediaElement.play() is unimplemented and logs a console error;
  // stub it like the MSE-fallback suite does so pc.ontrack's video.play() call
  // (T-022 tests below) is silent and inert.
  videoRef.current.play = vi.fn().mockResolvedValue(undefined);
  const rendered = renderHook(() => useWebRTCStream({ printerId: 1, enabled: true, videoRef }));
  return { ...rendered, videoRef };
}

/**
 * Advance the fake clock in small steps, giving pending promise chains a
 * chance to flush between each step, until `predicate` is true.
 * `vi.advanceTimersByTimeAsync` interleaves a microtask flush with each
 * timer tick, so stepping repeatedly drains both without any real delay or
 * needing to know exactly when an async setup path armed its timer.
 */
async function pollUntil(predicate: () => boolean, { stepMs = 250, maxSteps = 200 } = {}) {
  for (let i = 0; i < maxSteps; i++) {
    if (predicate()) return;
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  throw new Error('pollUntil: condition was not met before maxSteps was reached');
}

describe('useWebRTCStream ICE handling', () => {
  beforeEach(() => {
    lastPc = null;
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ignores transient ICE "disconnected" (no error, no reconnect)', async () => {
    const { result, unmount } = renderStream();
    await waitFor(() => expect(lastPc?.oniceconnectionstatechange).toBeTruthy());

    act(() => {
      lastPc!.iceConnectionState = 'disconnected';
      lastPc!.oniceconnectionstatechange!();
    });

    expect(result.current.hasError).toBe(false);
    expect(result.current.isReconnecting).toBe(false);
    expect(result.current.reconnectAttempt).toBe(0);
    unmount();
  });

  it('errors and schedules a reconnect on ICE "failed" after having connected', async () => {
    const { result, unmount } = renderStream();
    await waitFor(() => expect(lastPc?.setRemoteDescription).toHaveBeenCalled());

    act(() => {
      lastPc!.iceConnectionState = 'failed';
      lastPc!.oniceconnectionstatechange!();
    });

    await waitFor(() => expect(result.current.hasError).toBe(true));
    expect(result.current.isReconnecting).toBe(true);
    expect(result.current.reconnectAttempt).toBe(1);
    unmount();
  });
});

describe('useWebRTCStream negotiation timeout (T-053)', () => {
  beforeEach(() => {
    lastPc = null;
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    vi.mocked(api.webrtcOffer).mockReset();
    vi.mocked(api.webrtcOffer).mockResolvedValue({ type: 'answer', sdp: 'v=0' });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('an offer that never settles times out, surfaces the error state, and schedules a reconnect that retries the offer', async () => {
    vi.mocked(api.webrtcOffer).mockImplementation(() => new Promise(() => {})); // never resolves — simulates go2rtc accepting the POST and never answering

    const { result, unmount } = renderStream();

    // Mutation proof: without the race/timeout, `await api.webrtcOffer(...)`
    // on a never-resolving promise means this predicate is never reached and
    // pollUntil throws instead of the assertions below ever running.
    await pollUntil(() => result.current.hasError === true);

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isConnected).toBe(false);
    expect(result.current.isReconnecting).toBe(true);
    expect(result.current.reconnectAttempt).toBe(1);
    expect(vi.mocked(api.webrtcOffer).mock.calls.length).toBe(1);

    // Backoff elapses -> the hook retries the offer on its own (spinner does
    // not just sit in the error state forever either — it re-attempts).
    await pollUntil(() => vi.mocked(api.webrtcOffer).mock.calls.length >= 2, { stepMs: RECONNECT_BASE_DELAY_MS });

    unmount();
  });

  it('an offer that resolves before the timeout clears the timer — no stray rejection, no error state once the timeout window elapses', async () => {
    // Resolves at 5s, well inside the 15s negotiation window.
    vi.mocked(api.webrtcOffer).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ type: 'answer', sdp: 'v=0' }), 5_000)),
    );
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const unhandledRejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandled);

    const { result, unmount } = renderStream();

    // Mutation proof: if the negotiation timer isn't cleared on the success
    // path, clearTimeout is never invoked for it and this assertion fails.
    await pollUntil(() => lastPc !== null && lastPc.setRemoteDescription.mock.calls.length > 0);
    expect(clearTimeoutSpy).toHaveBeenCalled();

    // Advance well past the full 15s negotiation window from mount.
    await vi.advanceTimersByTimeAsync(NEGOTIATION_TIMEOUT_MS);

    expect(result.current.hasError).toBe(false);
    expect(vi.mocked(api.webrtcOffer).mock.calls.length).toBe(1); // no reconnect triggered
    expect(unhandledRejections).toEqual([]);

    process.off('unhandledRejection', onUnhandled);
    clearTimeoutSpy.mockRestore();
    unmount();
  });

  it('unmounting during a hung offer prevents the negotiation timeout from firing any state update or reconnect', async () => {
    vi.mocked(api.webrtcOffer).mockImplementation(() => new Promise(() => {})); // never resolves

    const { result, unmount } = renderStream();
    // Wait for the initial (in-flight, hung) offer request to actually go
    // out before unmounting, so the assertion below is about whether a
    // *second* (reconnect) request fires — not an artifact of unmounting
    // before the first request's microtask chain even ran.
    await pollUntil(() => vi.mocked(api.webrtcOffer).mock.calls.length >= 1);

    const callsBeforeUnmount = vi.mocked(api.webrtcOffer).mock.calls.length;
    const stateBeforeUnmount = { ...result.current };

    unmount();

    // Advance well past both the negotiation timeout and a full reconnect
    // backoff cycle — had the timer not been torn down on unmount, this
    // would otherwise flip hasError and trigger a second offer.
    await vi.advanceTimersByTimeAsync(NEGOTIATION_TIMEOUT_MS + RECONNECT_BASE_DELAY_MS * 4);

    expect(vi.mocked(api.webrtcOffer).mock.calls.length).toBe(callsBeforeUnmount);
    expect(result.current).toEqual(stateBeforeUnmount);
  });
});

/**
 * T-022: pc.ontrack's success path and startFrameMonitor's stale/degraded/
 * error thresholds (STREAM_STALE_MS/STREAM_DEGRADED_MS/STREAM_ERROR_MS from
 * streamConstants.ts) had no coverage — every existing test above stops at
 * ICE/negotiation state changes and never fires ontrack, so isConnected,
 * isLoading, and the frame-staleness state machine were never exercised.
 */
describe('useWebRTCStream frame monitor thresholds and connection timeout (T-022)', () => {
  // Mirror the hook's own (unexported) internal constants — same convention
  // as NEGOTIATION_TIMEOUT_MS above.
  const FRAME_CHECK_INTERVAL_MS = 1_000;
  const CONNECTION_TIMEOUT_MS = 30_000;

  beforeEach(() => {
    lastPc = null;
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    vi.mocked(api.webrtcOffer).mockReset();
    vi.mocked(api.webrtcOffer).mockResolvedValue({ type: 'answer', sdp: 'v=0' });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // The frame monitor's state updates (onFirstFrame, the stale/degraded/error
  // evaluator, armConnectionTimeout's callback) run inside raw setInterval/
  // setTimeout callbacks fired by the fake-timer clock, not inside an
  // explicit `act()`. React applies them, but `result.current` (a snapshot
  // testing-library refreshes on render) only picks them up once React gets
  // a chance to flush — hence the trailing `act(async () => {})` after every
  // advance whose effect on `result.current` we assert on.
  async function advanceAndFlush(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    await act(async () => {});
  }

  it('pc.ontrack marks the stream connected, and the currentTime-poll fallback (jsdom has no requestVideoFrameCallback) clears isLoading once a frame decodes', async () => {
    const { result, videoRef, unmount } = renderStream();
    await pollUntil(() => lastPc?.ontrack != null);

    act(() => {
      lastPc!.ontrack!({ streams: [{} as MediaStream] });
    });

    expect(result.current.isConnected).toBe(true);
    expect(result.current.isLoading).toBe(true); // no decoded frame yet

    // A tick with no currentTime change: still loading (lastFrameTimeRef is
    // still 0, so the stale/degraded/error evaluator does not run yet).
    await advanceAndFlush(FRAME_CHECK_INTERVAL_MS);
    expect(result.current.isLoading).toBe(true);

    // Simulate a decoded frame via the currentTime poll.
    videoRef.current.currentTime = 1;
    await advanceAndFlush(FRAME_CHECK_INTERVAL_MS);

    expect(result.current.isLoading).toBe(false);
    expect(result.current.stale).toBe(false);
    expect(result.current.degraded).toBe(false);
    expect(result.current.reconnectAttempt).toBe(0);
    unmount();
  });

  it('uses requestVideoFrameCallback for frame detection when the video element exposes it, and re-arms itself on every frame', async () => {
    const video = document.createElement('video');
    video.play = vi.fn().mockResolvedValue(undefined);
    const frameCallbacks: Array<() => void> = [];
    let nextHandle = 1;
    (video as unknown as { requestVideoFrameCallback: (cb: () => void) => number }).requestVideoFrameCallback = vi.fn(
      (cb: () => void) => {
        frameCallbacks.push(cb);
        return nextHandle++;
      },
    );
    (video as unknown as { cancelVideoFrameCallback: (h: number) => void }).cancelVideoFrameCallback = vi.fn();
    const videoRef = { current: video };
    const { result, unmount } = renderHook(() => useWebRTCStream({ printerId: 1, enabled: true, videoRef }));
    await pollUntil(() => lastPc?.ontrack != null);

    act(() => {
      lastPc!.ontrack!({ streams: [{} as MediaStream] });
    });

    // Mutation proof: if startFrameMonitor did not branch on rVFC, this call
    // would never happen and the assertions below would see isLoading stuck.
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(1);
    expect(result.current.isLoading).toBe(true);

    act(() => {
      frameCallbacks[0]();
    });

    expect(result.current.isLoading).toBe(false);
    // onFrame re-requests itself so the next decoded frame is also caught.
    expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('armConnectionTimeout errors and schedules a reconnect if no frame ever arrives after the offer is answered', async () => {
    const { result, unmount } = renderStream();
    await pollUntil(() => lastPc !== null && lastPc.setRemoteDescription.mock.calls.length > 0);

    // Mutation proof: without the watchdog this predicate never flips and the
    // stream spins on isLoading forever.
    await advanceAndFlush(CONNECTION_TIMEOUT_MS);

    expect(result.current.isLoading).toBe(false);
    expect(result.current.hasError).toBe(true);
    expect(result.current.isConnected).toBe(false);
    expect(result.current.isReconnecting).toBe(true);
    expect(result.current.reconnectAttempt).toBe(1);
    unmount();
  });

  it('the frame monitor escalates stale -> degraded -> error at STREAM_STALE_MS / STREAM_DEGRADED_MS / STREAM_ERROR_MS, and the error threshold schedules a reconnect', async () => {
    const { result, videoRef, unmount } = renderStream();
    await pollUntil(() => lastPc?.ontrack != null);
    act(() => {
      lastPc!.ontrack!({ streams: [{} as MediaStream] });
    });
    videoRef.current.currentTime = 1;
    await advanceAndFlush(FRAME_CHECK_INTERVAL_MS);
    expect(result.current.isLoading).toBe(false); // frame decoded, staleness clock starts now

    await advanceAndFlush(STREAM_STALE_MS);
    expect(result.current.stale).toBe(true);
    expect(result.current.degraded).toBe(false);
    expect(result.current.hasError).toBe(false);

    await advanceAndFlush(STREAM_DEGRADED_MS - STREAM_STALE_MS);
    expect(result.current.stale).toBe(true);
    expect(result.current.degraded).toBe(true);
    expect(result.current.hasError).toBe(false);

    await advanceAndFlush(STREAM_ERROR_MS - STREAM_DEGRADED_MS);
    expect(result.current.hasError).toBe(true);
    expect(result.current.isConnected).toBe(false);
    expect(result.current.isReconnecting).toBe(true);
    expect(result.current.reconnectAttempt).toBe(1);
    unmount();
  });

  it('a fresh frame after staleness clears stale/degraded before the error threshold is reached', async () => {
    const { result, videoRef, unmount } = renderStream();
    await pollUntil(() => lastPc?.ontrack != null);
    act(() => {
      lastPc!.ontrack!({ streams: [{} as MediaStream] });
    });
    videoRef.current.currentTime = 1;
    await advanceAndFlush(FRAME_CHECK_INTERVAL_MS);

    await advanceAndFlush(STREAM_STALE_MS);
    expect(result.current.stale).toBe(true);

    videoRef.current.currentTime = 2;
    await advanceAndFlush(FRAME_CHECK_INTERVAL_MS);

    expect(result.current.stale).toBe(false);
    expect(result.current.degraded).toBe(false);
    expect(result.current.hasError).toBe(false);
    unmount();
  });
});
