/**
 * useWebRTCStream → MSE fallback.
 *
 * go2rtc's WebRTC answer carries host candidates only (its LAN addresses on
 * :8555). A browser that reaches the app through an HTTP-only path — a
 * Cloudflare tunnel — gets the answer and then ICE never connects, so every
 * go2rtc tile spun forever. When ICE fails or does not connect within
 * ICE_CONNECT_TIMEOUT_MS on an attempt that never connected, the hook now
 * switches to go2rtc's MSE stream relayed over /printers/{id}/camera/mse, and
 * remembers that for the rest of the page session so the other tiles skip the
 * wait.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWebRTCStream, resetStreamTransport, ICE_CONNECT_TIMEOUT_MS } from '../../hooks/useWebRTCStream';

vi.mock('../../api/client', () => ({
  api: { webrtcOffer: vi.fn().mockResolvedValue({ type: 'answer', sdp: 'v=0' }) },
  withStreamToken: (url: string) => `${url}?token=tok`,
}));

let peerConnections: FakePeerConnection[] = [];

class FakePeerConnection {
  iceConnectionState = 'new';
  ontrack: ((e: unknown) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  setRemoteDescription = vi.fn(async () => {});
  constructor() {
    peerConnections.push(this);
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

let sockets: FakeSocket[] = [];

class FakeSocket {
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(public url: string) {
    sockets.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

let sourceBuffers: FakeSourceBuffer[] = [];

class FakeSourceBuffer {
  updating = false;
  mode = 'sequence';
  buffered = { length: 0, start: () => 0, end: () => 0 };
  appended: ArrayBuffer[] = [];
  constructor(public mime: string) {
    sourceBuffers.push(this);
  }
  addEventListener() {}
  appendBuffer(data: ArrayBuffer) {
    this.appended.push(data);
  }
  remove() {}
}

class FakeMediaSource {
  static isTypeSupported = () => true;
  readyState = 'closed';
  private listeners: Record<string, () => void> = {};
  addEventListener(type: string, cb: () => void) {
    this.listeners[type] = cb;
    if (type === 'sourceopen') {
      queueMicrotask(() => {
        this.readyState = 'open';
        cb();
      });
    }
  }
  addSourceBuffer(mime: string) {
    return new FakeSourceBuffer(mime);
  }
  endOfStream() {}
  setLiveSeekableRange() {}
}

function renderStream(printerId = 1) {
  const video = document.createElement('video');
  video.play = vi.fn().mockResolvedValue(undefined);
  const videoRef = { current: video };
  return renderHook(() => useWebRTCStream({ printerId, enabled: true, videoRef }));
}

function lastPc() {
  return peerConnections[peerConnections.length - 1];
}

beforeEach(() => {
  resetStreamTransport();
  peerConnections = [];
  sockets = [];
  sourceBuffers = [];
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('MediaSource', FakeMediaSource);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:mse', revokeObjectURL: () => {} }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useWebRTCStream MSE fallback', () => {
  it('switches to the MSE relay when ICE fails before ever connecting', async () => {
    const { result, unmount } = renderStream(7);
    await waitFor(() => expect(lastPc()?.setRemoteDescription).toHaveBeenCalled());

    act(() => {
      lastPc().iceConnectionState = 'failed';
      lastPc().oniceconnectionstatechange!();
    });

    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0].url).toBe(`ws://${window.location.host}/api/v1/printers/7/camera/mse?token=tok`);
    expect(result.current.hasError).toBe(false);
    expect(result.current.isReconnecting).toBe(false);
    unmount();
  });

  it('switches to the MSE relay when ICE does not connect in time', async () => {
    vi.useFakeTimers();
    const { unmount } = renderStream();
    for (let i = 0; i < 20 && !lastPc()?.setRemoteDescription.mock.calls.length; i++) {
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(sockets).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(ICE_CONNECT_TIMEOUT_MS);

    expect(sockets).toHaveLength(1);
    unmount();
  });

  it('keeps WebRTC when ICE connects in time', async () => {
    vi.useFakeTimers();
    const { unmount } = renderStream();
    for (let i = 0; i < 20 && !lastPc()?.setRemoteDescription.mock.calls.length; i++) {
      await vi.advanceTimersByTimeAsync(10);
    }
    act(() => {
      lastPc().iceConnectionState = 'connected';
      lastPc().oniceconnectionstatechange!();
    });

    await vi.advanceTimersByTimeAsync(ICE_CONNECT_TIMEOUT_MS * 2);

    expect(sockets).toHaveLength(0);
    unmount();
  });

  it('a tile mounted after the fallback goes straight to MSE', async () => {
    const first = renderStream(1);
    await waitFor(() => expect(lastPc()?.setRemoteDescription).toHaveBeenCalled());
    act(() => {
      lastPc().iceConnectionState = 'failed';
      lastPc().oniceconnectionstatechange!();
    });
    await waitFor(() => expect(sockets).toHaveLength(1));
    const pcsBefore = peerConnections.length;

    const second = renderStream(2);

    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[1].url).toContain('/printers/2/camera/mse');
    expect(peerConnections).toHaveLength(pcsBefore);
    first.unmount();
    second.unmount();
  });

  it('asks go2rtc for MSE, opens the source buffer it names and appends the frames', async () => {
    const { unmount } = renderStream();
    await waitFor(() => expect(lastPc()?.setRemoteDescription).toHaveBeenCalled());
    act(() => {
      lastPc().iceConnectionState = 'failed';
      lastPc().oniceconnectionstatechange!();
    });
    await waitFor(() => expect(sockets).toHaveLength(1));
    const ws = sockets[0];
    expect(ws.binaryType).toBe('arraybuffer');

    act(() => ws.onopen!());
    expect(JSON.parse(ws.sent[0])).toMatchObject({ type: 'mse' });

    const mime = 'video/mp4; codecs="avc1.640029"';
    act(() => ws.onmessage!({ data: JSON.stringify({ type: 'mse', value: mime }) }));
    expect(sourceBuffers).toHaveLength(1);
    expect(sourceBuffers[0].mime).toBe(mime);

    const frame = new Uint8Array([0, 1, 2]).buffer;
    act(() => ws.onmessage!({ data: frame }));
    expect(sourceBuffers[0].appended).toHaveLength(1);
    unmount();
  });

  it('a dropped MSE socket errors and schedules a reconnect over MSE', async () => {
    const { result, unmount } = renderStream();
    await waitFor(() => expect(lastPc()?.setRemoteDescription).toHaveBeenCalled());
    act(() => {
      lastPc().iceConnectionState = 'failed';
      lastPc().oniceconnectionstatechange!();
    });
    await waitFor(() => expect(sockets).toHaveLength(1));

    act(() => sockets[0].onclose!());

    await waitFor(() => expect(result.current.hasError).toBe(true));
    expect(result.current.isReconnecting).toBe(true);
    unmount();
  });

  it('unmounting closes the MSE socket', async () => {
    const { unmount } = renderStream();
    await waitFor(() => expect(lastPc()?.setRemoteDescription).toHaveBeenCalled());
    act(() => {
      lastPc().iceConnectionState = 'failed';
      lastPc().oniceconnectionstatechange!();
    });
    await waitFor(() => expect(sockets).toHaveLength(1));

    unmount();

    expect(sockets[0].closed).toBe(true);
  });

  it('without MediaSource support an ICE failure still errors and reconnects', async () => {
    vi.stubGlobal('MediaSource', undefined);
    const { result, unmount } = renderStream();
    await waitFor(() => expect(lastPc()?.setRemoteDescription).toHaveBeenCalled());
    act(() => {
      lastPc().iceConnectionState = 'failed';
      lastPc().oniceconnectionstatechange!();
    });

    await waitFor(() => expect(result.current.hasError).toBe(true));
    expect(sockets).toHaveLength(0);
    unmount();
  });
});
