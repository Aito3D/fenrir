/**
 * Tests for CameraGrid layout constants and re-exports, plus rendering
 * tests for the CameraGrid component itself.
 *
 * The CameraGrid component's underlying streaming hooks (useGridStream,
 * useCombinedGridStats, useWebRTCStream) use Web Workers, fetch-based
 * ReadableStreams, and RTCPeerConnection which aren't available/practical
 * in jsdom — those are mocked below with deterministic stand-ins so the
 * rendering tests can exercise CameraGrid's own logic (mutations, HMS
 * dismissal, go2rtc stream-type routing) in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { CameraGrid } from '../../components/CameraGrid';
import type { GridPrinter } from '../../components/CameraGrid';
import { api } from '../../api/client';
import type { HMSError, PrintQueueItem } from '../../api/client';
import {
  GRID_LAYOUT_COLS,
  GRID_LAYOUT_ICONS,
  GRID_BLINK_PERIOD_MS,
  gridBlinkSyncStyle,
  gridCardHighlightClass,
} from '../../components/cameraGridLayout';
import type { GridLayout } from '../../components/cameraGridLayout';

// The MJPEG grid stream (fetch + ReadableStream + Web Worker) and the WebRTC
// stream (RTCPeerConnection) aren't available in jsdom. Mock them with
// deterministic, empty-state stand-ins so CameraGrid's own logic (mutations,
// dismissal, sorting/splitting) can be exercised without network/worker flake.
//
// getStatsSnapshot MUST return the same object reference across calls: it
// feeds useSyncExternalStore (in GridToolbar), which treats a new reference
// every render as "the store changed" and re-subscribes forever.
const EMPTY_GRID_STATS = { bw: '', active: 0, total: 0, uptime: '', rawBytesPerSecond: 0, droppedFrames: 0 };

vi.mock('../../hooks/useGridStream', () => ({
  useGridStream: () => ({
    canvasRefs: { current: new Map() },
    loadingSet: new Set(),
    errorSet: new Set(),
    degradedSet: new Set(),
    staleSet: new Set(),
    reconnectingSet: new Set(),
    reconnectCountdown: 0,
    reconnectAttempt: 0,
    getStatsSnapshot: () => EMPTY_GRID_STATS,
    handleVisibilityChange: vi.fn(),
  }),
}));

vi.mock('../../hooks/useCombinedGridStats', () => ({
  useCombinedGridStats: () => ({
    subscribeStats: () => () => {},
    getStatsSnapshot: () => EMPTY_GRID_STATS,
    handleWebRTCStats: vi.fn(),
  }),
}));

vi.mock('../../hooks/useWebRTCStream', () => ({
  useWebRTCStream: () => ({
    isLoading: false,
    hasError: false,
    isConnected: true,
    isReconnecting: false,
    reconnectCountdown: 0,
    reconnectAttempt: 0,
    stale: false,
    degraded: false,
    restart: vi.fn(),
  }),
}));

function makePrinter(overrides: Partial<GridPrinter> = {}): GridPrinter {
  return {
    id: 1,
    name: 'Printer 1',
    model: 'X1C',
    connected: true,
    state: 'IDLE',
    progress: 0,
    remainingTime: null,
    layerNum: null,
    totalLayers: null,
    plateCleared: false,
    ...overrides,
  };
}

describe('cameraGridLayout constants', () => {
  it('GRID_LAYOUT_COLS has all layout variants', () => {
    const keys: GridLayout[] = ['compact', 'default', 'large'];
    for (const key of keys) {
      expect(GRID_LAYOUT_COLS[key]).toBeDefined();
      expect(typeof GRID_LAYOUT_COLS[key]).toBe('string');
      expect(GRID_LAYOUT_COLS[key]).toContain('grid-cols');
    }
  });

  it('GRID_LAYOUT_ICONS has all layout variants', () => {
    const keys: GridLayout[] = ['compact', 'default', 'large'];
    for (const key of keys) {
      expect(GRID_LAYOUT_ICONS[key]).toBeDefined();
    }
  });

  it('compact has more columns than default', () => {
    // compact has 2xl:grid-cols-6 while default has 2xl:grid-cols-5
    expect(GRID_LAYOUT_COLS.compact).toContain('2xl:grid-cols-6');
    expect(GRID_LAYOUT_COLS.default).toContain('2xl:grid-cols-5');
  });

  it('large has fewer columns than default', () => {
    // large has 2xl:grid-cols-4 while default has 2xl:grid-cols-5
    expect(GRID_LAYOUT_COLS.large).toContain('2xl:grid-cols-4');
  });
});

describe('CameraGrid re-exports', () => {
  it('re-exports GridLayout type and constants from CameraGrid module', async () => {
    // Verify the re-exports work
    const mod = await import('../../components/cameraGridLayout');
    expect(mod.GRID_LAYOUT_COLS).toBeDefined();
    expect(mod.GRID_LAYOUT_ICONS).toBeDefined();
  });
});

describe('gridCardHighlightClass', () => {
  const base = { connected: true, plateCleared: false, hasQueuedJobs: false };

  it('running: steady green border with glow, no blink', () => {
    const cls = gridCardHighlightClass({ ...base, state: 'RUNNING' });
    expect(cls).toContain('!border-bambu-green');
    expect(cls).toContain('!shadow-');
    expect(cls).not.toContain('animate-grid-border-blink');
  });

  it('paused: blink with default (yellow) color', () => {
    const cls = gridCardHighlightClass({ ...base, state: 'PAUSE' });
    expect(cls).toBe('animate-grid-border-blink');
  });

  it('finished: blue blink with glow — ready for pickup, distinct from printing green', () => {
    const cls = gridCardHighlightClass({ ...base, state: 'FINISH' });
    expect(cls).toContain('animate-grid-border-blink');
    expect(cls).toContain('[--blink-color:rgb(96_165_250)]'); // blue-400, matches status legend
    expect(cls).toContain('!shadow-');
    expect(cls).not.toContain('--accent'); // green is reserved for printing
    // Blink branches must never carry !border-* (kills the animation)
    expect(cls).not.toContain('!border-');
  });

  it('finished but queue confirmed plate cleared: no highlight', () => {
    const cls = gridCardHighlightClass({ ...base, state: 'FINISH', plateCleared: true, hasQueuedJobs: true });
    expect(cls).toBe('!border-transparent');
  });

  it('finished with plateCleared default-true but no queue: still highlights', () => {
    // plateCleared defaults to true for non-queue users — must not suppress
    const cls = gridCardHighlightClass({ ...base, state: 'FINISH', plateCleared: true, hasQueuedJobs: false });
    expect(cls).toContain('animate-grid-border-blink');
  });

  it('failed: red blink without glow', () => {
    const cls = gridCardHighlightClass({ ...base, state: 'FAILED' });
    expect(cls).toContain('animate-grid-border-blink');
    expect(cls).toContain('[--blink-color:rgb(248_113_113)]');
    expect(cls).not.toContain('!shadow-');
    expect(cls).not.toContain('!border-');
  });

  it('disconnected: no highlight regardless of state', () => {
    for (const state of ['RUNNING', 'PAUSE', 'FINISH', 'FAILED']) {
      expect(gridCardHighlightClass({ ...base, connected: false, state })).toBe('!border-transparent');
    }
  });

  it('idle/unknown states: no highlight', () => {
    expect(gridCardHighlightClass({ ...base, state: 'IDLE' })).toBe('!border-transparent');
    expect(gridCardHighlightClass({ ...base, state: null })).toBe('!border-transparent');
  });
});

describe('gridBlinkSyncStyle', () => {
  it('returns undefined for non-blinking highlight classes', () => {
    expect(gridBlinkSyncStyle('!border-transparent')).toBeUndefined();
    expect(gridBlinkSyncStyle('!border-bambu-green !shadow-[...]')).toBeUndefined();
  });

  it('returns a negative delay within one blink period', () => {
    const style = gridBlinkSyncStyle('animate-grid-border-blink', 12_345);
    expect(style).toBeDefined();
    const delay = parseInt(style!.animationDelay, 10);
    expect(delay).toBeLessThanOrEqual(0);
    expect(delay).toBeGreaterThan(-GRID_BLINK_PERIOD_MS);
  });

  it('aligns cards mounted at different times to the same phase', () => {
    // Two mounts one full period apart share the exact same delay
    const a = gridBlinkSyncStyle('animate-grid-border-blink', 10_000);
    const b = gridBlinkSyncStyle('animate-grid-border-blink', 10_000 + GRID_BLINK_PERIOD_MS);
    expect(a!.animationDelay).toBe(b!.animationDelay);
    // A mount mid-period gets a delay that offsets it back to the epoch phase
    const c = gridBlinkSyncStyle('animate-grid-border-blink', 10_000 + 500);
    const delayA = parseInt(a!.animationDelay, 10);
    const delayC = parseInt(c!.animationDelay, 10);
    expect(delayA - delayC).toBe(500);
  });
});

describe('CameraGrid rendering', () => {
  beforeEach(() => {
    // camera/grid-stream is fetched by the (mocked-out) useGridStream hook in
    // real code, but jsdom's fetch is still reachable via other effects in
    // this tree; keep the settings endpoint deterministic per test.
    server.use(
      http.get('/api/v1/settings/', () => HttpResponse.json({ camera_quality: 'auto', camera_engine: 'ffmpeg' })),
    );
  });

  describe('print control mutations', () => {
    it('pause: confirm modal opens on click, and confirming calls api.pausePrint for that printer', async () => {
      const user = userEvent.setup();
      const pauseSpy = vi.spyOn(api, 'pausePrint').mockResolvedValue({ success: true, message: 'ok' });
      const printers = [makePrinter({ id: 7, name: 'Printer Seven', state: 'RUNNING', remainingTime: 30 })];
      const { container } = render(<CameraGrid printers={printers} layout="default" />);

      const card = container.querySelector('[data-flip-key="7"]') as HTMLElement;
      await waitFor(() => expect(within(card).getByRole('button', { name: 'Pause' })).toBeInTheDocument());
      await user.click(within(card).getByRole('button', { name: 'Pause' }));

      expect(await screen.findByRole('heading', { name: 'Pause Print' })).toBeInTheDocument();
      expect(pauseSpy).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Pause Print' }));

      await waitFor(() => expect(pauseSpy).toHaveBeenCalledWith(7));
      expect(await screen.findByText('Print paused')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole('heading', { name: 'Pause Print' })).not.toBeInTheDocument());
    });

    it('stop: confirm modal opens on click, and confirming calls api.stopPrint for that printer', async () => {
      const user = userEvent.setup();
      const stopSpy = vi.spyOn(api, 'stopPrint').mockResolvedValue({ success: true, message: 'ok' });
      const printers = [makePrinter({ id: 8, name: 'Printer Eight', state: 'RUNNING', remainingTime: 30 })];
      const { container } = render(<CameraGrid printers={printers} layout="default" />);

      const card = container.querySelector('[data-flip-key="8"]') as HTMLElement;
      await waitFor(() => expect(within(card).getByRole('button', { name: 'Stop' })).toBeInTheDocument());
      await user.click(within(card).getByRole('button', { name: 'Stop' }));

      expect(await screen.findByRole('heading', { name: 'Stop Print' })).toBeInTheDocument();
      expect(stopSpy).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Stop Print' }));

      await waitFor(() => expect(stopSpy).toHaveBeenCalledWith(8));
      expect(await screen.findByText('Print stopped')).toBeInTheDocument();
    });

    it('resume: confirm modal opens on click, and confirming calls api.resumePrint for that printer', async () => {
      const user = userEvent.setup();
      const resumeSpy = vi.spyOn(api, 'resumePrint').mockResolvedValue({ success: true, message: 'ok' });
      const printers = [makePrinter({ id: 9, name: 'Printer Nine', state: 'PAUSE', remainingTime: 30 })];
      const { container } = render(<CameraGrid printers={printers} layout="default" />);

      const card = container.querySelector('[data-flip-key="9"]') as HTMLElement;
      await waitFor(() => expect(within(card).getByRole('button', { name: 'Resume' })).toBeInTheDocument());
      await user.click(within(card).getByRole('button', { name: 'Resume' }));

      expect(await screen.findByRole('heading', { name: 'Resume Print' })).toBeInTheDocument();
      expect(resumeSpy).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Resume Print' }));

      await waitFor(() => expect(resumeSpy).toHaveBeenCalledWith(9));
      expect(await screen.findByText('Print resumed')).toBeInTheDocument();
    });

    it('canceling the confirm modal does not call any print-control mutation', async () => {
      const user = userEvent.setup();
      const pauseSpy = vi.spyOn(api, 'pausePrint').mockResolvedValue({ success: true, message: 'ok' });
      const printers = [makePrinter({ id: 10, name: 'Printer Ten', state: 'RUNNING', remainingTime: 30 })];
      const { container } = render(<CameraGrid printers={printers} layout="default" />);

      const card = container.querySelector('[data-flip-key="10"]') as HTMLElement;
      await waitFor(() => expect(within(card).getByRole('button', { name: 'Pause' })).toBeInTheDocument());
      await user.click(within(card).getByRole('button', { name: 'Pause' }));

      expect(await screen.findByRole('heading', { name: 'Pause Print' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByRole('heading', { name: 'Pause Print' })).not.toBeInTheDocument());
      expect(pauseSpy).not.toHaveBeenCalled();
    });
  });

  describe('clear plate mutation', () => {
    it('only offers Clear Plate for finished printers that actually have a pending queue item, and firing it targets that printer', async () => {
      const user = userEvent.setup();
      const getQueueSpy = vi.spyOn(api, 'getQueue').mockImplementation((printerId) =>
        Promise.resolve(printerId === 1 ? ([{ id: 555 }] as unknown as PrintQueueItem[]) : [])
      );
      const clearPlateSpy = vi.spyOn(api, 'clearPlate').mockResolvedValue({ success: true, message: 'ok' });

      const printers = [
        makePrinter({ id: 1, name: 'Has Queue', state: 'FINISH', plateCleared: false }),
        makePrinter({ id: 2, name: 'No Queue', state: 'FINISH', plateCleared: false }),
      ];
      const { container } = render(<CameraGrid printers={printers} layout="default" />);

      await waitFor(() => expect(getQueueSpy).toHaveBeenCalled());

      const card1 = container.querySelector('[data-flip-key="1"]') as HTMLElement;
      const card2 = container.querySelector('[data-flip-key="2"]') as HTMLElement;

      // Positive evidence first: printer 1 (has a queued job) gets the button.
      await waitFor(() => expect(within(card1).getByRole('button', { name: 'Clear Bed' })).toBeInTheDocument());
      // Only then assert the negative for printer 2 (no queued job).
      expect(within(card2).queryByRole('button', { name: 'Clear Bed' })).not.toBeInTheDocument();

      await user.click(within(card1).getByRole('button', { name: 'Clear Bed' }));
      await waitFor(() => expect(clearPlateSpy).toHaveBeenCalledWith(1));
      expect(clearPlateSpy).not.toHaveBeenCalledWith(2);
    });
  });

  describe('HMS error dismissal', () => {
    // Known HMS code from HMSErrorModal.test.tsx's fixtures — maps to a real
    // description string in the error database.
    const err: HMSError = { attr: 0x0300, code: '0x400C', severity: 2 };
    const desc = 'The task was canceled.';

    it('dismissing one printer\'s HMS error hides only that printer\'s banner', async () => {
      // Both printers surface the SAME error/description on purpose: a
      // per-printer dismissal that (bug-wise) leaked across printers would
      // still "coincidentally" pass if the two banners had different text,
      // since the wrongly-applied dismissal would just never match the
      // other card's own description. Using identical errors makes the
      // isolation guarantee load-bearing for the assertion.
      const user = userEvent.setup();
      const printers = [
        makePrinter({ id: 1, name: 'Printer 1', hmsErrors: [err] }),
        makePrinter({ id: 2, name: 'Printer 2', hmsErrors: [err] }),
      ];
      const { container } = render(<CameraGrid printers={printers} layout="default" />);

      const card1 = container.querySelector('[data-flip-key="1"]') as HTMLElement;
      const card2 = container.querySelector('[data-flip-key="2"]') as HTMLElement;

      await waitFor(() => expect(within(card1).getByText(desc)).toBeInTheDocument());
      expect(within(card2).getByText(desc)).toBeInTheDocument();

      await user.click(within(card1).getByText(desc));

      await waitFor(() => expect(within(card1).queryByText(desc)).not.toBeInTheDocument());
      // Printer 2's identical-looking banner must be untouched by printer 1's dismissal.
      expect(within(card2).getByText(desc)).toBeInTheDocument();
    });
  });

  describe('go2rtc stream-type split', () => {
    it('routes RTSP-capable printers to WebRTCGridCard (video) and chamber printers to CameraGridCard (canvas)', async () => {
      server.use(
        http.get('/api/v1/settings/', () => HttpResponse.json({ camera_quality: 'auto', camera_engine: 'go2rtc' })),
      );
      const printers = [
        makePrinter({ id: 1, name: 'RTSP Printer', supports_rtsp: true }),
        makePrinter({ id: 2, name: 'Chamber Printer', supports_rtsp: false }),
      ];
      const { container } = render(<CameraGrid printers={printers} layout="default" />);

      // Query fresh inside waitFor: switching stream type swaps the mounted
      // component (CameraGridCard <-> WebRTCGridCard) for that key, which
      // replaces the DOM node — a reference grabbed before the go2rtc
      // setting loads would go stale once React swaps the subtree.
      await waitFor(() => {
        const rtspCard = container.querySelector('[data-flip-key="1"]') as HTMLElement;
        expect(rtspCard.querySelector('video')).toBeInTheDocument();
      });
      const rtspCard = container.querySelector('[data-flip-key="1"]') as HTMLElement;
      expect(rtspCard.querySelector('canvas')).not.toBeInTheDocument();

      await waitFor(() => {
        const chamberCard = container.querySelector('[data-flip-key="2"]') as HTMLElement;
        expect(chamberCard.querySelector('canvas')).toBeInTheDocument();
      });
      const chamberCard = container.querySelector('[data-flip-key="2"]') as HTMLElement;
      expect(chamberCard.querySelector('video')).not.toBeInTheDocument();
    });
  });
});
