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
import { RECONNECT_BASE_DELAY_MS } from '../../utils/streamConstants';

vi.mock('../../api/client', () => ({
  api: { webrtcOffer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'v=0' }) },
}));

const NEGOTIATION_TIMEOUT_MS = 15_000;

let lastPc: FakePeerConnection | null = null;

class FakePeerConnection {
  iceConnectionState = 'new';
  ontrack: ((e: unknown) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  setRemoteDescription = vi.fn(async () => {});
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
  return renderHook(() => useWebRTCStream({ printerId: 1, enabled: true, videoRef }));
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

  it('errors and schedules a reconnect on ICE "failed"', async () => {
    const { result, unmount } = renderStream();
    await waitFor(() => expect(lastPc?.oniceconnectionstatechange).toBeTruthy());

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
