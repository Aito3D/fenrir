/**
 * Plays go2rtc's MSE stream (fragmented MP4 over WebSocket) in a <video>.
 *
 * Follows go2rtc's own player (www/video-rtc.js): ask for the codecs the
 * browser can decode, open the SourceBuffer go2rtc names, append frames as
 * they arrive, and keep a short live window so latency does not creep up.
 */

// Codecs go2rtc can remux into fMP4 (video only — the printers send no audio).
const CODECS = ['avc1.640029', 'avc1.64002A', 'avc1.640033', 'hvc1.1.6.L153.B0'];
// Seconds of media kept behind the live edge.
const LIVE_WINDOW_S = 5;
const PENDING_BYTES = 2 * 1024 * 1024;

type MediaSourceCtor = typeof MediaSource;

function mediaSourceCtor(): MediaSourceCtor | null {
  // iOS Safari 17.1+ only has ManagedMediaSource.
  const w = window as unknown as { ManagedMediaSource?: MediaSourceCtor; MediaSource?: MediaSourceCtor };
  return w.ManagedMediaSource ?? w.MediaSource ?? null;
}

export function mseSupported(): boolean {
  return mediaSourceCtor() !== null && typeof WebSocket !== 'undefined';
}

export interface MseStreamHandlers {
  /** The socket is open and the MSE request is sent. */
  onOpen: () => void;
  /** Bytes received, for bandwidth stats. */
  onBytes: (n: number) => void;
  /** The stream ended or broke; not called after close(). */
  onError: () => void;
}

/** Start streaming; returns a function that stops it and detaches the video. */
export function startMseStream(video: HTMLVideoElement, url: string, handlers: MseStreamHandlers): () => void {
  const MS = mediaSourceCtor()!;
  const managed = MS !== (window as unknown as { MediaSource?: MediaSourceCtor }).MediaSource;
  const ms = new MS();
  let ws: WebSocket | null = null;
  let sb: SourceBuffer | null = null;
  let closed = false;
  const pending = new Uint8Array(PENDING_BYTES);
  let pendingLen = 0;

  const fail = () => {
    if (closed) return;
    closed = true;
    ws?.close();
    handlers.onError();
  };

  const trimToLiveEdge = () => {
    if (!sb || sb.updating || !sb.buffered.length) return;
    const end = sb.buffered.end(sb.buffered.length - 1);
    const start = end - LIVE_WINDOW_S;
    if (start > sb.buffered.start(0)) {
      sb.remove(sb.buffered.start(0), start);
      ms.setLiveSeekableRange?.(start, end);
    }
    if (video.currentTime < start) video.currentTime = start;
    // Speed up slightly when behind so the picture stays live.
    const gap = end - video.currentTime;
    video.playbackRate = gap > 0.5 ? Math.min(gap, 2) : 1;
  };

  const append = (data: ArrayBuffer) => {
    if (!sb) return;
    try {
      if (sb.updating || pendingLen > 0) {
        if (pendingLen + data.byteLength > PENDING_BYTES) return fail();
        pending.set(new Uint8Array(data), pendingLen);
        pendingLen += data.byteLength;
      } else {
        sb.appendBuffer(data);
      }
    } catch {
      fail();
    }
  };

  const openSourceBuffer = (mime: string) => {
    try {
      sb = ms.addSourceBuffer(mime);
      sb.mode = 'segments';
      sb.addEventListener('updateend', () => {
        if (!sb || closed) return;
        if (!sb.updating && pendingLen > 0) {
          try {
            sb.appendBuffer(pending.slice(0, pendingLen));
            pendingLen = 0;
          } catch {
            return fail();
          }
        }
        trimToLiveEdge();
      });
    } catch {
      fail();
    }
  };

  ms.addEventListener(
    'sourceopen',
    () => {
      if (!managed) URL.revokeObjectURL(video.src);
      if (closed) return;
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        const codecs = CODECS.filter((c) => MS.isTypeSupported(`video/mp4; codecs="${c}"`));
        ws?.send(JSON.stringify({ type: 'mse', value: codecs.join(',') }));
        handlers.onOpen();
      };
      ws.onmessage = (event: MessageEvent) => {
        if (closed) return;
        if (typeof event.data === 'string') {
          let msg: { type?: string; value?: string };
          try {
            msg = JSON.parse(event.data);
          } catch {
            return;
          }
          if (msg.type === 'mse' && msg.value) openSourceBuffer(msg.value);
          else if (msg.type === 'error') fail();
          return;
        }
        const data = event.data as ArrayBuffer;
        handlers.onBytes(data.byteLength);
        append(data);
      };
      ws.onclose = fail;
      ws.onerror = fail;
    },
    { once: true },
  );

  if (managed) {
    // ManagedMediaSource only plays with remote playback disabled.
    video.disableRemotePlayback = true;
    video.srcObject = ms as unknown as MediaStream;
  } else {
    video.srcObject = null;
    video.src = URL.createObjectURL(ms);
  }

  return () => {
    closed = true;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    }
    if (ms.readyState === 'open') {
      try {
        ms.endOfStream();
      } catch {
        // already ended
      }
    }
    video.removeAttribute('src');
    video.srcObject = null;
  };
}
