/**
 * Direct-render tests for CameraGridCard — the pure display component
 * mounted (indirectly, via mocked streaming hooks) by CameraGrid.test.tsx.
 * Those parent tests never reach the card's own branches for the
 * stale/degraded health overlays, the highlight-class-per-state wiring, or
 * the click-vs-spotlight bubbling guard, since the parent always renders
 * with loading/error/stale/degraded all false. This file exercises the
 * card's own contract in isolation: no canvas/video refs, no worker, no
 * network — everything the card needs is a plain prop.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils';
import { CameraGridCard } from '../../../components/cameraGrid/CameraGridCard';
import type { CameraGridCardProps, GridCardHandlers } from '../../../components/cameraGrid/CameraGridCard';
import type { HMSError } from '../../../api/client';

// vi.spyOn isn't used directly in this file, but restoreAllMocks here keeps
// this file's mocks from leaking into files that run after it in the same
// worker (setup.ts only does clearAllMocks between tests).
afterEach(() => {
  vi.restoreAllMocks();
});

function makeHandlers(overrides: Partial<GridCardHandlers> = {}): GridCardHandlers {
  return {
    onPause: vi.fn(),
    onStop: vi.fn(),
    onResume: vi.fn(),
    onClearPlate: vi.fn(),
    onDismissError: vi.fn(),
    onExpand: vi.fn(),
    onSpotlight: vi.fn(),
    ...overrides,
  };
}

function baseProps(overrides: Partial<CameraGridCardProps> = {}): CameraGridCardProps {
  return {
    printerId: 1,
    printerName: 'Printer One',
    connected: true,
    state: 'RUNNING',
    progress: 42,
    remainingTime: 30,
    layerNum: 5,
    totalLayers: 100,
    plateCleared: false,
    layout: 'default',
    loading: false,
    error: false,
    reconnecting: false,
    reconnectCountdown: 0,
    reconnectAttempt: 0,
    handlers: makeHandlers(),
    ...overrides,
  };
}

describe('CameraGridCard', () => {
  describe('print control buttons', () => {
    it('pause button calls onPause with (printerId, printerName) while running', async () => {
      const user = userEvent.setup();
      const handlers = makeHandlers();
      render(<CameraGridCard {...baseProps({ printerId: 7, printerName: 'Printer Seven', state: 'RUNNING', handlers })} />);

      await user.click(screen.getByRole('button', { name: 'Pause' }));

      expect(handlers.onPause).toHaveBeenCalledWith(7, 'Printer Seven');
      expect(handlers.onStop).not.toHaveBeenCalled();
      expect(handlers.onResume).not.toHaveBeenCalled();
    });

    it('stop button calls onStop with (printerId, printerName) while running', async () => {
      const user = userEvent.setup();
      const handlers = makeHandlers();
      render(<CameraGridCard {...baseProps({ printerId: 8, printerName: 'Printer Eight', state: 'RUNNING', handlers })} />);

      await user.click(screen.getByRole('button', { name: 'Stop' }));

      expect(handlers.onStop).toHaveBeenCalledWith(8, 'Printer Eight');
      expect(handlers.onPause).not.toHaveBeenCalled();
    });

    it('resume and stop buttons appear (not pause) while paused; resume calls onResume with (printerId, printerName)', async () => {
      const user = userEvent.setup();
      const handlers = makeHandlers();
      render(<CameraGridCard {...baseProps({ printerId: 9, printerName: 'Printer Nine', state: 'PAUSE', handlers })} />);

      // Positive evidence first: the buttons that SHOULD exist while paused.
      expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
      // Only then assert the negative: pause doesn't make sense on an
      // already-paused print.
      expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Resume' }));

      expect(handlers.onResume).toHaveBeenCalledWith(9, 'Printer Nine');
      expect(handlers.onStop).not.toHaveBeenCalled();
    });

    it('no pause/stop/resume controls while idle', () => {
      render(<CameraGridCard {...baseProps({ state: 'IDLE' })} />);

      expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    });

    it('clicking a control button does not also fire onSpotlight (bubble is filtered by the outer click handler)', async () => {
      const user = userEvent.setup();
      const handlers = makeHandlers();
      render(<CameraGridCard {...baseProps({ state: 'RUNNING', handlers })} />);

      await user.click(screen.getByRole('button', { name: 'Pause' }));

      expect(handlers.onPause).toHaveBeenCalled();
      expect(handlers.onSpotlight).not.toHaveBeenCalled();
    });

    it('clicking the tile body (not a button) fires onSpotlight with printerId', async () => {
      const user = userEvent.setup();
      const handlers = makeHandlers();
      render(<CameraGridCard {...baseProps({ printerId: 11, printerName: 'Printer Eleven', state: 'IDLE', handlers })} />);

      await user.click(screen.getByLabelText('Printer Eleven'));

      expect(handlers.onSpotlight).toHaveBeenCalledWith(11);
    });
  });

  describe('clear-plate gating', () => {
    it('appears for a finished print with a queued job and pending plate, and calls onClearPlate(printerId)', async () => {
      const user = userEvent.setup();
      const handlers = makeHandlers();
      render(<CameraGridCard {...baseProps({
        printerId: 3,
        state: 'FINISH',
        plateCleared: false,
        hasQueuedJobs: true,
        handlers,
      })} />);

      const button = await screen.findByRole('button', { name: 'Clear Bed' });
      await user.click(button);

      expect(handlers.onClearPlate).toHaveBeenCalledWith(3);
    });

    it('does not appear when there is no queued job, even if the print is finished and unclear', () => {
      render(<CameraGridCard {...baseProps({
        state: 'FINISH',
        plateCleared: false,
        hasQueuedJobs: false,
      })} />);

      expect(screen.queryByRole('button', { name: 'Clear Bed' })).not.toBeInTheDocument();
    });

    it('does not appear once the plate is already marked cleared, even with a queued job', () => {
      render(<CameraGridCard {...baseProps({
        state: 'FINISH',
        plateCleared: true,
        hasQueuedJobs: true,
      })} />);

      expect(screen.queryByRole('button', { name: 'Clear Bed' })).not.toBeInTheDocument();
    });

    it('also appears for a failed print with a queued job and pending plate', async () => {
      render(<CameraGridCard {...baseProps({
        state: 'FAILED',
        plateCleared: false,
        hasQueuedJobs: true,
      })} />);

      expect(await screen.findByRole('button', { name: 'Clear Bed' })).toBeInTheDocument();
    });
  });

  describe('highlight class per state (gridCardHighlightClass wiring)', () => {
    it('running + connected: steady green border, no blink', () => {
      const { container } = render(<CameraGridCard {...baseProps({ printerId: 21, connected: true, state: 'RUNNING' })} />);
      const card = container.querySelector('[data-flip-key="21"]') as HTMLElement;

      expect(card.className).toContain('!border-bambu-green');
      expect(card.className).not.toContain('animate-grid-border-blink');
    });

    it('paused + connected: blinking border', () => {
      const { container } = render(<CameraGridCard {...baseProps({ printerId: 22, connected: true, state: 'PAUSE' })} />);
      const card = container.querySelector('[data-flip-key="22"]') as HTMLElement;

      expect(card.className).toContain('animate-grid-border-blink');
      expect(card.className).not.toContain('!border-bambu-green');
    });

    it('disconnected: no highlight regardless of state', () => {
      const { container } = render(<CameraGridCard {...baseProps({ printerId: 23, connected: false, state: 'RUNNING' })} />);
      const card = container.querySelector('[data-flip-key="23"]') as HTMLElement;

      expect(card.className).toContain('!border-transparent');
      expect(card.className).not.toContain('!border-bambu-green');
    });
  });

  describe('degraded overlay', () => {
    it('shows the connection-degraded signal icon when degraded is true', () => {
      render(<CameraGridCard {...baseProps({ connected: true, degraded: true, reconnecting: false })} />);

      expect(screen.getByTitle('Connection lost')).toBeInTheDocument();
    });

    it('does not show the degraded icon when degraded is false', () => {
      render(<CameraGridCard {...baseProps({ connected: true, degraded: false, reconnecting: false })} />);

      expect(screen.queryByTitle('Connection lost')).not.toBeInTheDocument();
    });
  });

  describe('stale overlay (media blur)', () => {
    it('blurs the canvas when connected, stale, and not loading/error/reconnecting', () => {
      const { container } = render(<CameraGridCard {...baseProps({
        connected: true,
        stale: true,
        loading: false,
        error: false,
        reconnecting: false,
      })} />);
      const canvas = container.querySelector('canvas') as HTMLCanvasElement;

      expect(canvas.style.filter).toBe('blur(3px)');
    });

    it('does not blur the canvas when stale is false', () => {
      const { container } = render(<CameraGridCard {...baseProps({
        connected: true,
        stale: false,
        loading: false,
        error: false,
        reconnecting: false,
      })} />);
      const canvas = container.querySelector('canvas') as HTMLCanvasElement;

      expect(canvas.style.filter).toBe('none');
    });

    it('does not blur the canvas while reconnecting even if stale is true (reconnect overlay takes over)', () => {
      const { container } = render(<CameraGridCard {...baseProps({
        connected: true,
        stale: true,
        loading: false,
        error: false,
        reconnecting: true,
      })} />);
      const canvas = container.querySelector('canvas') as HTMLCanvasElement;

      expect(canvas.style.filter).toBe('none');
    });
  });

  describe('HMS error banner', () => {
    const err: HMSError = { attr: 0x0300, code: '0x400C', module: 0, severity: 2 };
    const desc = 'The task was canceled.';

    it('shows the top HMS error and dismissing it calls onDismissError with (printerId, description)', async () => {
      const user = userEvent.setup();
      const handlers = makeHandlers();
      render(<CameraGridCard {...baseProps({ printerId: 4, hmsErrors: [err], handlers })} />);

      const banner = screen.getByText(desc);
      expect(banner).toBeInTheDocument();

      await user.click(banner);

      expect(handlers.onDismissError).toHaveBeenCalledWith(4, desc);
    });

    it('hides the banner once its description matches dismissedErrorDesc', () => {
      render(<CameraGridCard {...baseProps({ hmsErrors: [err], dismissedErrorDesc: desc })} />);

      expect(screen.queryByText(desc)).not.toBeInTheDocument();
    });
  });
});
