/**
 * Tests for the camera grid decoder worker logic.
 *
 * Tests the actual worker message handler by simulating the worker
 * global scope (`self`) and exercising the real onmessage handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the worker's protocol behaviour by simulating the DedicatedWorkerGlobalScope.
// The worker sets `self.onmessage`, so we capture that handler after evaluating the module.

describe('cameraGridDecoder worker', () => {
  let handler: (e: MessageEvent) => void;
  let posted: Array<{ msg: unknown; transfer: Transferable[] }>;

  beforeEach(async () => {
    posted = [];

    // Stub `self.postMessage` and `createImageBitmap` before importing the worker module.
    // Vitest runs workers in the same thread so we can mock globals.
    const mockBitmap = { close: vi.fn(), width: 100, height: 100 } as unknown as ImageBitmap;
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(mockBitmap));
    vi.stubGlobal('postMessage', (msg: unknown, transfer: Transferable[]) => {
      posted.push({ msg, transfer });
    });

    // Dynamic import so stubs are in place before module evaluation
    vi.resetModules();
    await import('../../workers/cameraGridDecoder.worker');

    // The worker assigns `self.onmessage` — capture it
    handler = (self as unknown as { onmessage: typeof handler }).onmessage;
  });

  function send(data: Record<string, unknown>) {
    handler(new MessageEvent('message', { data }));
  }

  it('processes frame for visible printer', async () => {
    send({ type: 'visibility', printerId: 1, visible: true });
    send({ type: 'frame', printerId: 1, jpeg: new ArrayBuffer(100) });

    // createImageBitmap is async — flush microtasks
    await vi.waitFor(() => expect(posted.length).toBe(1));
    expect((posted[0].msg as { type: string }).type).toBe('frame');
    expect((posted[0].msg as { printerId: number }).printerId).toBe(1);
  });

  it('skips frame for non-visible printer', async () => {
    send({ type: 'frame', printerId: 2, jpeg: new ArrayBuffer(100) });
    // Give any promises a chance to resolve
    await new Promise(r => setTimeout(r, 10));
    expect(posted.length).toBe(0);
  });

  it('clear resets visibility', async () => {
    send({ type: 'visibility', printerId: 1, visible: true });
    send({ type: 'clear' });
    send({ type: 'frame', printerId: 1, jpeg: new ArrayBuffer(100) });

    await new Promise(r => setTimeout(r, 10));
    expect(posted.length).toBe(0);
  });

  it('visibility toggle removes printer from visible set', async () => {
    send({ type: 'visibility', printerId: 1, visible: true });
    send({ type: 'visibility', printerId: 1, visible: false });
    send({ type: 'frame', printerId: 1, jpeg: new ArrayBuffer(100) });

    await new Promise(r => setTimeout(r, 10));
    expect(posted.length).toBe(0);
  });

  it('handles multiple printers independently', async () => {
    send({ type: 'visibility', printerId: 1, visible: true });
    send({ type: 'visibility', printerId: 3, visible: true });

    send({ type: 'frame', printerId: 1, jpeg: new ArrayBuffer(50) });
    send({ type: 'frame', printerId: 2, jpeg: new ArrayBuffer(50) });
    send({ type: 'frame', printerId: 3, jpeg: new ArrayBuffer(50) });

    await vi.waitFor(() => expect(posted.length).toBe(2));
    const ids = posted.map(p => (p.msg as { printerId: number }).printerId);
    expect(ids).toContain(1);
    expect(ids).toContain(3);
    expect(ids).not.toContain(2);
  });

  it('responds to ping with worker state', async () => {
    send({ type: 'visibility', printerId: 1, visible: true });
    send({ type: 'frame', printerId: 1, jpeg: new ArrayBuffer(100) });

    await vi.waitFor(() => expect(posted.length).toBe(1));

    send({ type: 'ping' });

    expect(posted.length).toBe(2);
    const pong = posted[1].msg as {
      type: string;
      visibleCount: number;
      totalDecodeSuccess: number;
      totalDecodeErrors: number;
    };
    expect(pong.type).toBe('pong');
    expect(pong.visibleCount).toBe(1);
    expect(pong.totalDecodeSuccess).toBe(1);
    expect(pong.totalDecodeErrors).toBe(0);
  });

  it('reports decode errors', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('bad jpeg')));
    vi.resetModules();
    await import('../../workers/cameraGridDecoder.worker');
    handler = (self as unknown as { onmessage: typeof handler }).onmessage;
    posted = [];

    send({ type: 'visibility', printerId: 1, visible: true });
    send({ type: 'frame', printerId: 1, jpeg: new ArrayBuffer(100) });

    await vi.waitFor(() => expect(posted.length).toBe(1));
    const errMsg = posted[0].msg as { type: string; totalErrors: number };
    expect(errMsg.type).toBe('decodeError');
    expect(errMsg.totalErrors).toBe(1);
  });

  it('clear resets decode counters', async () => {
    send({ type: 'visibility', printerId: 1, visible: true });
    send({ type: 'frame', printerId: 1, jpeg: new ArrayBuffer(100) });

    await vi.waitFor(() => expect(posted.length).toBe(1));

    send({ type: 'clear' });
    send({ type: 'visibility', printerId: 1, visible: true });
    send({ type: 'ping' });

    const pong = posted[posted.length - 1].msg as {
      type: string;
      totalDecodeErrors: number;
      totalDecodeSuccess: number;
    };
    expect(pong.type).toBe('pong');
    expect(pong.totalDecodeErrors).toBe(0);
    expect(pong.totalDecodeSuccess).toBe(0);
  });
});
