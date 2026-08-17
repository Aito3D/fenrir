/**
 * Tests for getDefaultState() factory function in EmbeddedCameraViewer,
 * plus rendering tests for the EmbeddedCameraViewer component itself.
 *
 * The component's streaming hook (useMjpegStream) does real fetch/ReadableStream
 * work that isn't practical in jsdom, and useCameraControls pulls in printer
 * status/permission logic that has its own dedicated tests — both are mocked
 * here so these tests can exercise EmbeddedCameraViewer's own logic in
 * isolation: saved-position clamping (loadState), the chamber-light toggle,
 * and skip-objects modal gating.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { getDefaultState } from '../../components/cameraDefaults';
import { EmbeddedCameraViewer } from '../../components/EmbeddedCameraViewer';
import { useCameraControls } from '../../hooks/useCameraControls';
import { useMjpegStream } from '../../hooks/useMjpegStream';

describe('getDefaultState', () => {
  it('returns correct shape with x, y, width, height', () => {
    const state = getDefaultState();
    expect(typeof state.x).toBe('number');
    expect(typeof state.y).toBe('number');
    expect(typeof state.width).toBe('number');
    expect(typeof state.height).toBe('number');
  });

  it('returns width 400 and height 300', () => {
    const state = getDefaultState();
    expect(state.width).toBe(400);
    expect(state.height).toBe(300);
  });

  it('computes x from window.innerWidth', () => {
    const state = getDefaultState();
    expect(state.x).toBe(window.innerWidth - 420);
  });

  it('returns y of 20', () => {
    const state = getDefaultState();
    expect(state.y).toBe(20);
  });

  it('returns fresh object each call', () => {
    const a = getDefaultState();
    const b = getDefaultState();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

// ============================================================================
// EmbeddedCameraViewer component rendering
// ============================================================================

vi.mock('../../hooks/useMjpegStream', () => ({
  useMjpegStream: vi.fn(),
}));

vi.mock('../../hooks/useCameraControls', () => ({
  useCameraControls: vi.fn(),
}));

type CameraControlsReturn = ReturnType<typeof useCameraControls>;

function mockCameraControls(overrides: Partial<CameraControlsReturn> = {}) {
  vi.mocked(useCameraControls).mockReturnValue({
    status: { connected: true, chamber_light: false } as unknown as CameraControlsReturn['status'],
    chamberLightMutation: { mutate: vi.fn(), isPending: false } as unknown as CameraControlsReturn['chamberLightMutation'],
    isPrintingWithObjects: false,
    showSkipObjectsModal: false,
    setShowSkipObjectsModal: vi.fn(),
    checkStalled: vi.fn().mockResolvedValue(false),
    hasControlPermission: true,
    ...overrides,
  });
}

function mockMjpegStream(overrides: Partial<ReturnType<typeof useMjpegStream>> = {}) {
  vi.mocked(useMjpegStream).mockReturnValue({
    isLoading: false,
    hasError: false,
    isConnected: true,
    restart: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  });
}

// The panel root is the only element in the tree carrying the `fixed`
// class in both the normal and fullscreen render branches, so it's a
// reliable, test-id-free way to grab the draggable/resizable container.
function getPanel(container: HTMLElement): HTMLElement {
  const panel = container.querySelector('.fixed');
  if (!panel) throw new Error('panel root (.fixed) not found');
  return panel as HTMLElement;
}

describe('EmbeddedCameraViewer', () => {
  beforeEach(() => {
    mockCameraControls();
    mockMjpegStream();
    // Sent on unmount (useCameraStopHint) and on refresh(); keep it
    // deterministic instead of relying on onUnhandledRequest bypass.
    server.use(
      http.post('/api/v1/printers/:id/camera/stop', () => HttpResponse.json({})),
    );
  });

  describe('loadState() saved-position clamping', () => {
    it('clamps an out-of-bounds saved position/size down to the screen edges', () => {
      window.localStorage.setItem(
        'embeddedCameraState_101',
        JSON.stringify({ x: 999999, y: 999999, width: 999999, height: 999999 }),
      );

      const { container } = render(
        <EmbeddedCameraViewer printerId={101} printerName="Printer 101" onClose={vi.fn()} />
      );

      const panel = getPanel(container);
      expect(panel.style.left).toBe(`${window.innerWidth - 100}px`);
      expect(panel.style.top).toBe(`${window.innerHeight - 100}px`);
      expect(panel.style.width).toBe(`${window.innerWidth - 20}px`);
      expect(panel.style.height).toBe(`${window.innerHeight - 20}px`);
    });

    it('clamps a saved position/size below the minimum bounds back up to the floor', () => {
      window.localStorage.setItem(
        'embeddedCameraState_102',
        JSON.stringify({ x: -500, y: -500, width: 10, height: 10 }),
      );

      const { container } = render(
        <EmbeddedCameraViewer printerId={102} printerName="Printer 102" onClose={vi.fn()} />
      );

      const panel = getPanel(container);
      expect(panel.style.left).toBe('0px');
      expect(panel.style.top).toBe('0px');
      expect(panel.style.width).toBe('200px');
      expect(panel.style.height).toBe('150px');
    });

    it('offsets new viewers without any saved state by viewerIndex so they do not stack exactly on top of each other', () => {
      const defaults = getDefaultState();

      const { container } = render(
        <EmbeddedCameraViewer printerId={103} printerName="Printer 103" viewerIndex={2} onClose={vi.fn()} />
      );

      const panel = getPanel(container);
      expect(panel.style.left).toBe(`${Math.max(0, defaults.x - 60)}px`);
      expect(panel.style.top).toBe(`${Math.max(0, defaults.y + 60)}px`);
    });
  });

  describe('chamber light toggle', () => {
    it('mutates the chamber light on when it is currently off', async () => {
      const user = userEvent.setup();
      const mutate = vi.fn();
      mockCameraControls({
        status: { connected: true, chamber_light: false } as unknown as CameraControlsReturn['status'],
        chamberLightMutation: { mutate, isPending: false } as unknown as CameraControlsReturn['chamberLightMutation'],
      });

      render(<EmbeddedCameraViewer printerId={1} printerName="P1" onClose={vi.fn()} />);

      await user.click(screen.getByTitle('Toggle chamber light'));
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(mutate).toHaveBeenCalledWith(true);
    });

    it('mutates the chamber light off when it is currently on', async () => {
      const user = userEvent.setup();
      const mutate = vi.fn();
      mockCameraControls({
        status: { connected: true, chamber_light: true } as unknown as CameraControlsReturn['status'],
        chamberLightMutation: { mutate, isPending: false } as unknown as CameraControlsReturn['chamberLightMutation'],
      });

      render(<EmbeddedCameraViewer printerId={1} printerName="P1" onClose={vi.fn()} />);

      await user.click(screen.getByTitle('Toggle chamber light'));
      expect(mutate).toHaveBeenCalledWith(false);
    });

    it('disables the button and blocks the mutation while the printer is disconnected', async () => {
      const user = userEvent.setup();
      const mutate = vi.fn();
      mockCameraControls({
        status: { connected: false, chamber_light: false } as unknown as CameraControlsReturn['status'],
        chamberLightMutation: { mutate, isPending: false } as unknown as CameraControlsReturn['chamberLightMutation'],
      });

      render(<EmbeddedCameraViewer printerId={1} printerName="P1" onClose={vi.fn()} />);

      const button = screen.getByTitle('Toggle chamber light');
      expect(button).toBeDisabled();
      await user.click(button);
      expect(mutate).not.toHaveBeenCalled();
    });

    it('disables the button and shows the no-permission tooltip when the user lacks control permission', async () => {
      const user = userEvent.setup();
      const mutate = vi.fn();
      mockCameraControls({
        chamberLightMutation: { mutate, isPending: false } as unknown as CameraControlsReturn['chamberLightMutation'],
        hasControlPermission: false,
      });

      render(<EmbeddedCameraViewer printerId={1} printerName="P1" onClose={vi.fn()} />);

      // Both the chamber-light and skip-objects buttons fall back to the same
      // no-permission tooltip when hasControlPermission is false — the first
      // (chamber light, per header button order) is the one under test here.
      const [button] = screen.getAllByTitle('You do not have permission to control printers');
      expect(button).toBeDisabled();
      await user.click(button);
      expect(mutate).not.toHaveBeenCalled();
    });
  });

  describe('skip-objects modal gating', () => {
    it('disables the skip-objects button while not printing with multiple objects, and blocks opening the modal', async () => {
      const user = userEvent.setup();
      const setShowSkipObjectsModal = vi.fn();
      mockCameraControls({ isPrintingWithObjects: false, setShowSkipObjectsModal });

      render(<EmbeddedCameraViewer printerId={1} printerName="P1" onClose={vi.fn()} />);

      const button = screen.getByTitle('Skip objects (only while printing)');
      expect(button).toBeDisabled();
      await user.click(button);
      expect(setShowSkipObjectsModal).not.toHaveBeenCalled();
    });

    it('enables the skip-objects button and opens the modal when isPrintingWithObjects is true', async () => {
      const user = userEvent.setup();
      const setShowSkipObjectsModal = vi.fn();
      mockCameraControls({ isPrintingWithObjects: true, setShowSkipObjectsModal });

      render(<EmbeddedCameraViewer printerId={1} printerName="P1" onClose={vi.fn()} />);

      const button = screen.getByTitle('Skip objects');
      expect(button).not.toBeDisabled();
      await user.click(button);
      expect(setShowSkipObjectsModal).toHaveBeenCalledWith(true);
    });

    it('keeps the skip-objects button disabled when printing with objects but lacking control permission', () => {
      mockCameraControls({ isPrintingWithObjects: true, hasControlPermission: false });

      render(<EmbeddedCameraViewer printerId={1} printerName="P1" onClose={vi.fn()} />);

      // Both header buttons show this tooltip when permission is denied —
      // assert every match (chamber light + skip-objects) is disabled.
      for (const button of screen.getAllByTitle('You do not have permission to control printers')) {
        expect(button).toBeDisabled();
      }
    });

    it('renders the SkipObjectsModal only when showSkipObjectsModal is true, regardless of isPrintingWithObjects', async () => {
      server.use(
        http.get('/api/v1/printers/:id/print/objects', () =>
          HttpResponse.json({ objects: [], total: 0, skipped_count: 0, is_printing: false, bbox_all: null })
        ),
      );
      // Deliberately false here — the modal's own isOpen prop must be driven
      // by showSkipObjectsModal, not by isPrintingWithObjects.
      mockCameraControls({ isPrintingWithObjects: false, showSkipObjectsModal: true });

      render(<EmbeddedCameraViewer printerId={1} printerName="P1" onClose={vi.fn()} />);

      expect(await screen.findByRole('heading', { name: 'Skip Objects' })).toBeInTheDocument();
    });

    it('does not render the SkipObjectsModal when showSkipObjectsModal is false', () => {
      mockCameraControls({ showSkipObjectsModal: false });

      render(<EmbeddedCameraViewer printerId={1} printerName="P1" onClose={vi.fn()} />);

      expect(screen.queryByRole('heading', { name: 'Skip Objects' })).not.toBeInTheDocument();
    });
  });

  // refresh() defers mjpeg.restart() by 100ms (to let the in-flight
  // /camera/stop request land first). If the viewer unmounts inside that
  // window, the timer must be cancelled — otherwise it fires after
  // teardown and calls restart() on a stream whose read loop nothing can
  // ever abort again (see T-023).
  describe('refresh() restart timer', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('positive control: still-mounted refresh calls mjpeg.restart() once the 100ms delay elapses', () => {
      const restart = vi.fn();
      mockMjpegStream({ restart });

      render(<EmbeddedCameraViewer printerId={1} printerName="P1" onClose={vi.fn()} />);

      fireEvent.click(screen.getByTitle('Refresh stream'));
      expect(restart).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(restart).toHaveBeenCalledTimes(1);
    });

    it('unmounting within the 100ms window clears the pending timer so restart() never fires', () => {
      const restart = vi.fn();
      mockMjpegStream({ restart });

      const { unmount } = render(<EmbeddedCameraViewer printerId={1} printerName="P1" onClose={vi.fn()} />);

      fireEvent.click(screen.getByTitle('Refresh stream'));
      unmount();

      act(() => {
        vi.advanceTimersByTime(100);
      });

      expect(restart).not.toHaveBeenCalled();
    });
  });
});
