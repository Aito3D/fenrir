/**
 * T-025: CamWallClock (the fullscreen camera-wall clock) shows HH:MM only, so
 * commit 940dc9f37 changed it from a 1 s setInterval to a self-rescheduling
 * setTimeout that fires just after the next minute boundary (+20 ms slop).
 * The component is not exported, so it is reached through the real page:
 * camwall view + persisted fullscreen. CameraGrid is stubbed (no streaming).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';

vi.mock('../../components/CameraGrid', () => ({
  CameraGrid: () => <div data-testid="camera-grid" />,
}));

import { PrintersPage } from '../../pages/PrintersPage';

let store: Record<string, string>;

/** The lit layer of the seven-segment readout (the aria-hidden "88:88" is the unlit one). */
const readout = () => {
  const lit = document.querySelector('.font-seven-seg span:not([aria-hidden])');
  return lit?.textContent ?? null;
};

const startAt = (h: number, m: number, s: number, ms: number) => {
  vi.setSystemTime(new Date(2026, 8, 30, h, m, s, ms));
};

describe('PrintersPage — CamWallClock minute-boundary scheduling (T-025)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    store = { printerPageView: 'camwall', printersFullscreen: 'true' };
    vi.mocked(localStorage.getItem).mockImplementation((key: string) => store[key] ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key: string, value: string) => {
      store[key] = String(value);
    });
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json([])),
      http.get('/api/v1/queue/', () => HttpResponse.json([])),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
  });

  it('only renders the clock in fullscreen on the camera wall', () => {
    store.printersFullscreen = 'false';
    startAt(10, 41, 57, 500);
    const { unmount } = render(<PrintersPage />);
    expect(readout()).toBeNull();
    unmount();
  });

  it('shows HH:MM, updates exactly once just after the minute boundary, and not again until the next', async () => {
    startAt(10, 41, 57, 500);
    const { unmount } = render(<PrintersPage />);
    expect(readout()).toBe('10:41');

    // Boundary is 2.5 s away; the timer is armed for 2.5 s + 20 ms slop.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_499);
    });
    expect(readout()).toBe('10:41');
    // Exactly on the boundary: still inside the +20 ms slop.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(readout()).toBe('10:41');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(readout()).toBe('10:42');

    // Re-armed for the following boundary (~59.98 s away): no tick in between.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000);
    });
    expect(readout()).toBe('10:42');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(readout()).toBe('10:43');
    unmount();
  });

  it('waits a full minute plus slop when mounted exactly on a boundary (no per-second ticking)', async () => {
    startAt(10, 41, 0, 0);
    const { unmount } = render(<PrintersPage />);
    expect(readout()).toBe('10:41');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_019);
    });
    expect(readout()).toBe('10:41');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(readout()).toBe('10:42');
    unmount();
  });

  it('clears its pending timer on unmount', async () => {
    startAt(10, 41, 57, 500);
    const { unmount } = render(<PrintersPage />);
    expect(readout()).toBe('10:41');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    unmount();
    // The clock's pending timeout (due in 2520 ms) was cleared: nothing fires after unmount.
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(readout()).toBeNull();
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
