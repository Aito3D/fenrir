/**
 * Tests for useWebRTCStream ICE state handling.
 *
 * ICE 'disconnected' is often transient and must NOT trigger the error/
 * reconnect path (the frame monitor catches genuinely dead streams);
 * 'failed' must error and schedule a reconnect, and reconnectAttempt must
 * be reflected as state (not a stale ref read).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWebRTCStream } from '../../hooks/useWebRTCStream';

vi.mock('../../api/client', () => ({
  api: { webrtcOffer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'v=0' }) },
}));

let lastPc: FakePeerConnection | null = null;

class FakePeerConnection {
  iceConnectionState = 'new';
  ontrack: ((e: unknown) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  constructor() {
    lastPc = this;
  }
  addTransceiver() {}
  async createOffer() {
    return { sdp: 'v=0' };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async getStats() {
    return { forEach: () => {} };
  }
  close() {}
}

function renderStream() {
  const videoRef = { current: document.createElement('video') };
  return renderHook(() => useWebRTCStream({ printerId: 1, enabled: true, videoRef }));
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
