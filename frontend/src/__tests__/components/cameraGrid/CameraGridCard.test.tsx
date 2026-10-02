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
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils';
import { CameraGridCard, SPOTLIGHT_CLICK_DELAY_MS } from '../../../components/cameraGrid/CameraGridCard';
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

    it('clicking the tile body (not a button) fires onSpotlight with printerId once the double-click window has passed', async () => {
      const user = userEvent.setup();
      const handlers = makeHandlers();
      render(<CameraGridCard {...baseProps({ printerId: 11, printerName: 'Printer Eleven', state: 'IDLE', handlers })} />);

      await user.click(screen.getByLabelText('Printer Eleven'));

      // Deferred by SPOTLIGHT_CLICK_DELAY_MS so a double-click can cancel it.
      expect(handlers.onSpotlight).not.toHaveBeenCalled();
      await waitFor(() => expect(handlers.onSpotlight).toHaveBeenCalledWith(11));
      expect(handlers.onSpotlight).toHaveBeenCalledTimes(1);
    });

    it('double-clicking the tile expands it without ever toggling the spotlight', async () => {
      const user = userEvent.setup();
      const handlers = makeHandlers();
      render(<CameraGridCard {...baseProps({ printerId: 11, printerName: 'Printer Eleven', state: 'IDLE', handlers })} />);

      await user.dblClick(screen.getByLabelText('Printer Eleven'));

      expect(handlers.onExpand).toHaveBeenCalledTimes(1);
      expect(handlers.onExpand).toHaveBeenCalledWith(11, 'Printer Eleven');
      // Wait out the single-click window: the pending toggle must have been cancelled.
      await new Promise(r => setTimeout(r, SPOTLIGHT_CLICK_DELAY_MS + 50));
      expect(handlers.onSpotlight).not.toHaveBeenCalled();
    });

    it('toggles the spotlight immediately when the tile cannot expand (no competing double-click)', async () => {
      const user = userEvent.setup();
      const handlers = makeHandlers({ onExpand: undefined });
      render(<CameraGridCard {...baseProps({ printerId: 11, printerName: 'Printer Eleven', state: 'IDLE', handlers })} />);

      await user.click(screen.getByLabelText('Printer Eleven'));

      expect(handlers.onSpotlight).toHaveBeenCalledWith(11);
    });
  });

  describe('capped overlay', () => {
    it('shows the wall-limit message and suppresses the loading spinner', () => {
      const { container } = render(<CameraGridCard {...baseProps({ loading: true, capped: true })} />);
      expect(screen.getByText('Beyond the 30-camera wall limit')).toBeInTheDocument();
      expect(container.querySelector('.animate-spin')).toBeNull();
    });

    it('is absent for a streamed tile', () => {
      render(<CameraGridCard {...baseProps({ loading: true, capped: false })} />);
      expect(screen.queryByText('Beyond the 30-camera wall limit')).not.toBeInTheDocument();
    });
  });

  describe('spotlight span per layout', () => {
    it('spans 2×2 only from the breakpoint where the layout has ≥2 columns (large: lg, not sm)', () => {
      const { container, rerender } = render(<CameraGridCard {...baseProps({ layout: 'large', spotlighted: true })} />);
      const tile = () => container.querySelector('[data-flip-key]') as HTMLElement;
      // A sm: span on large's 1-column sm grid would add an implicit column
      // and squeeze every other tile between 640px and 1024px.
      expect(tile().className).toContain('lg:col-span-2 lg:row-span-2');
      expect(tile().className).not.toContain('sm:col-span-2');

      rerender(<CameraGridCard {...baseProps({ layout: 'default', spotlighted: true })} />);
      expect(tile().className).toContain('sm:col-span-2 sm:row-span-2');

      rerender(<CameraGridCard {...baseProps({ layout: 'compact', spotlighted: true })} />);
      expect(tile().className).toContain('col-span-2 row-span-2');
      expect(tile().className).not.toMatch(/\b(sm|lg):col-span-2/);

      rerender(<CameraGridCard {...baseProps({ layout: 'large', spotlighted: false })} />);
      expect(tile().className).not.toContain('col-span-2');
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

  describe('error overlay', () => {
    it('shows the generic "camera unavailable" text when error is true with no terminal error status', () => {
      render(<CameraGridCard {...baseProps({ connected: true, error: true, reconnecting: false })} />);

      expect(screen.getByText('Camera unavailable')).toBeInTheDocument();
      expect(screen.queryByText(/Stream rejected/)).not.toBeInTheDocument();
    });

    it('shows the terminal-error status text instead of the generic message when terminalErrorStatus is set (T-138)', () => {
      render(<CameraGridCard {...baseProps({
        connected: true,
        error: true,
        reconnecting: false,
        terminalErrorStatus: 403,
      })} />);

      expect(screen.getByText('Stream rejected by server (HTTP 403)')).toBeInTheDocument();
      expect(screen.queryByText('Camera unavailable')).not.toBeInTheDocument();
    });

    it('still offers the retry button when a terminal error is shown, so a manual restart can clear it', async () => {
      const user = userEvent.setup();
      const onRestart = vi.fn();
      render(<CameraGridCard {...baseProps({
        connected: true,
        error: true,
        reconnecting: false,
        terminalErrorStatus: 401,
        onRestart,
      })} />);

      await user.click(screen.getByRole('button', { name: /retry/i }));

      expect(onRestart).toHaveBeenCalled();
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
    const desc = 'The task was canceled.';
    // The text is the backend's catalogue sentence (#2728); the frontend keeps no table.
    const err: HMSError = { attr: 0x0300, code: '0x400C', module: 0, severity: 2, full_code: '0300400C', description: desc };

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
  describe('keyboard activation (T-047)', () => {
    const tile = () => screen.getByLabelText('Printer Twelve');
    const props = (o: Partial<CameraGridCardProps> = {}) =>
      baseProps({ printerId: 12, printerName: 'Printer Twelve', state: 'IDLE', ...o });

    it('Enter on a connected tile expands it with (printerId, printerName) and prevents the default', () => {
      const handlers = makeHandlers();
      render(<CameraGridCard {...props({ handlers })} />);

      // fireEvent returns false when the event was default-prevented.
      expect(fireEvent.keyDown(tile(), { key: 'Enter' })).toBe(false);

      expect(handlers.onExpand).toHaveBeenCalledTimes(1);
      expect(handlers.onExpand).toHaveBeenCalledWith(12, 'Printer Twelve');
      expect(handlers.onSpotlight).not.toHaveBeenCalled();
    });

    it('Enter on a disconnected tile does nothing and is not default-prevented', () => {
      const handlers = makeHandlers();
      render(<CameraGridCard {...props({ connected: false, handlers })} />);

      expect(fireEvent.keyDown(tile(), { key: 'Enter' })).toBe(true);

      expect(handlers.onExpand).not.toHaveBeenCalled();
      expect(handlers.onSpotlight).not.toHaveBeenCalled();
    });

    it('Enter without an onExpand handler does nothing', () => {
      const handlers = makeHandlers({ onExpand: undefined });
      render(<CameraGridCard {...props({ handlers })} />);

      expect(fireEvent.keyDown(tile(), { key: 'Enter' })).toBe(true);

      expect(handlers.onSpotlight).not.toHaveBeenCalled();
    });

    it('Space toggles the spotlight immediately with printerId and prevents the default (page scroll)', () => {
      const handlers = makeHandlers();
      render(<CameraGridCard {...props({ handlers })} />);

      expect(fireEvent.keyDown(tile(), { key: ' ' })).toBe(false);

      expect(handlers.onSpotlight).toHaveBeenCalledTimes(1);
      expect(handlers.onSpotlight).toHaveBeenCalledWith(12);
      expect(handlers.onExpand).not.toHaveBeenCalled();
    });

    it('Space still spotlights a disconnected tile', () => {
      const handlers = makeHandlers();
      render(<CameraGridCard {...props({ connected: false, handlers })} />);

      fireEvent.keyDown(tile(), { key: ' ' });

      expect(handlers.onSpotlight).toHaveBeenCalledWith(12);
    });

    it('Space without an onSpotlight handler does nothing and is not default-prevented', () => {
      const handlers = makeHandlers({ onSpotlight: undefined });
      render(<CameraGridCard {...props({ handlers })} />);

      expect(fireEvent.keyDown(tile(), { key: ' ' })).toBe(true);

      expect(handlers.onExpand).not.toHaveBeenCalled();
    });

    it('ignores other keys', () => {
      const handlers = makeHandlers();
      render(<CameraGridCard {...props({ handlers })} />);

      expect(fireEvent.keyDown(tile(), { key: 'a' })).toBe(true);

      expect(handlers.onExpand).not.toHaveBeenCalled();
      expect(handlers.onSpotlight).not.toHaveBeenCalled();
    });

    it('ignores a keydown that bubbles up from a child control', () => {
      const handlers = makeHandlers();
      render(<CameraGridCard {...props({ state: 'RUNNING', handlers })} />);
      const pause = screen.getByRole('button', { name: 'Pause' });

      expect(fireEvent.keyDown(pause, { key: 'Enter' })).toBe(true);
      expect(fireEvent.keyDown(pause, { key: ' ' })).toBe(true);

      expect(handlers.onExpand).not.toHaveBeenCalled();
      expect(handlers.onSpotlight).not.toHaveBeenCalled();
    });
  });

  describe('visibility observer (T-047)', () => {
    it('reports intersection changes with the printerId and disconnects on unmount', () => {
      const observe = vi.fn();
      const disconnect = vi.fn();
      let callback: (entries: Array<{ isIntersecting: boolean }>) => void = () => {};
      class FakeObserver {
        constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void, public options: unknown) {
          callback = cb;
        }
        observe = observe;
        disconnect = disconnect;
      }
      vi.stubGlobal('IntersectionObserver', FakeObserver);
      const onVisibilityChange = vi.fn();

      const { unmount } = render(<CameraGridCard {...baseProps({ printerId: 31, onVisibilityChange })} />);

      expect(observe).toHaveBeenCalledTimes(1);
      callback([{ isIntersecting: true }]);
      expect(onVisibilityChange).toHaveBeenLastCalledWith(31, true);
      callback([{ isIntersecting: false }]);
      expect(onVisibilityChange).toHaveBeenLastCalledWith(31, false);

      unmount();
      expect(disconnect).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    });

    it('does not create an observer without an onVisibilityChange callback', () => {
      const ctor = vi.fn();
      vi.stubGlobal('IntersectionObserver', ctor);

      render(<CameraGridCard {...baseProps()} />);

      expect(ctor).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });

  describe('media and status overlays (T-047)', () => {
    it('renders a video element instead of a canvas when a videoRef is supplied, hidden while loading', () => {
      const videoRef = { current: null } as React.RefObject<HTMLVideoElement | null>;
      const { container, rerender } = render(<CameraGridCard {...baseProps({ videoRef, loading: true })} />);

      const video = container.querySelector('video') as HTMLVideoElement;
      expect(video).not.toBeNull();
      expect(container.querySelector('canvas')).toBeNull();
      expect(video.className).toContain('opacity-0');

      rerender(<CameraGridCard {...baseProps({ videoRef, loading: false })} />);
      expect(container.querySelector('video')!.className).toContain('opacity-100');
    });

    it('blurs the video when stale, and hides the canvas while disconnected', () => {
      const videoRef = { current: null } as React.RefObject<HTMLVideoElement | null>;
      const { container, rerender } = render(<CameraGridCard {...baseProps({ videoRef, stale: true })} />);
      expect((container.querySelector('video') as HTMLVideoElement).style.filter).toBe('blur(3px)');

      rerender(<CameraGridCard {...baseProps({ connected: false })} />);
      expect((container.querySelector('canvas') as HTMLCanvasElement).className).toContain('opacity-0');
    });

    it('shows the loading spinner while connected and loading', () => {
      const { container } = render(<CameraGridCard {...baseProps({ loading: true })} />);
      expect(container.querySelector('.animate-spin')).not.toBeNull();
    });

    it('shows the reconnect overlay with countdown and attempt, and no spinner or error text', () => {
      const { container } = render(<CameraGridCard {...baseProps({
        loading: true,
        error: true,
        reconnecting: true,
        reconnectCountdown: 4,
        reconnectAttempt: 2,
      })} />);

      expect(screen.getAllByText('Connection lost').length).toBeGreaterThan(0);
      expect(screen.getByText('Reconnecting in 4s (attempt 2)')).toBeInTheDocument();
      expect(container.querySelector('.animate-spin')).toBeNull();
      expect(screen.queryByText('Camera unavailable')).not.toBeInTheDocument();
    });

    it('shows the offline overlay only when disconnected, and no stream overlays then', () => {
      const { rerender } = render(<CameraGridCard {...baseProps({ connected: false, loading: true, error: true })} />);
      expect(screen.getAllByText('Offline').length).toBeGreaterThan(0);
      expect(screen.queryByText('Camera unavailable')).not.toBeInTheDocument();

      rerender(<CameraGridCard {...baseProps({ connected: true })} />);
      expect(screen.queryByText('Offline')).not.toBeInTheDocument();
    });

    it('shows the paused badge only while paused', () => {
      const { rerender } = render(<CameraGridCard {...baseProps({ state: 'PAUSE' })} />);
      expect(screen.getAllByText(/paused/i).length).toBeGreaterThan(0);

      rerender(<CameraGridCard {...baseProps({ state: 'RUNNING' })} />);
      expect(screen.queryByText(/^paused$/i)).not.toBeInTheDocument();
    });

    it('the expand button calls onExpand only when connected, and is absent without a handler', async () => {
      const user = userEvent.setup();
      const handlers = makeHandlers();
      const { rerender } = render(<CameraGridCard {...baseProps({ printerId: 5, printerName: 'Five', handlers })} />);

      await user.click(screen.getByRole('button', { name: 'Expand' }));
      expect(handlers.onExpand).toHaveBeenCalledWith(5, 'Five');
      expect(handlers.onSpotlight).not.toHaveBeenCalled();

      rerender(<CameraGridCard {...baseProps({ connected: false, handlers })} />);
      expect(screen.queryByRole('button', { name: 'Expand' })).not.toBeInTheDocument();

      rerender(<CameraGridCard {...baseProps({ handlers: makeHandlers({ onExpand: undefined }) })} />);
      expect(screen.queryByRole('button', { name: 'Expand' })).not.toBeInTheDocument();
    });

    it('compact layout uses the smaller name text', () => {
      render(<CameraGridCard {...baseProps({ layout: 'compact', printerName: 'Tiny' })} />);
      expect(screen.getAllByText('Tiny').some((el) => el.className.includes('text-[11px]'))).toBe(true);
    });
  });
});
