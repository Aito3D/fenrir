/**
 * T-019: the camera wall's error boundary used to be the shared
 * ErrorBoundary, which has no reset path, so one transient render error in
 * the wall (or any tile) left an unattended kiosk wall on static red text
 * until someone reloaded the page. The wall now shows the same error text
 * with a "Reconnecting in Ns (attempt N)" countdown and a Retry button, and remounts itself after
 * 20 s, or immediately on Retry.
 *
 * T-055: the automatic delay backs off while remounts keep failing (20 s,
 * 40 s, 80 s, 160 s, capped at 300 s) and resets to 20 s once a remounted
 * wall has stayed up for 60 s.
 *
 * CameraGrid is mocked with a stand-in whose tile throws on demand, so the
 * test exercises the real PrintersPage boundary without any streaming.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { useEffect, useReducer } from 'react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';

const wall = vi.hoisted(() => ({
  shouldThrow: false,
  mounts: 0,
  // Set by the mounted stand-in: forces a re-render so a healthy wall can be
  // made to throw again without remounting it.
  rerender: null as null | (() => void),
}));

vi.mock('../../components/CameraGrid', () => {
  function Tile() {
    if (wall.shouldThrow) throw new Error('malformed live status payload');
    return <div>camera tile ok</div>;
  }
  function CameraGrid() {
    const [, bump] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
      wall.mounts += 1;
      wall.rerender = bump;
      return () => {
        if (wall.rerender === bump) wall.rerender = null;
      };
    }, []);
    return (
      <div data-testid="camera-grid">
        <Tile />
      </div>
    );
  }
  return { CameraGrid };
});

import { PrintersPage } from '../../pages/PrintersPage';

const ERROR_TEXT = 'Camera grid failed to load. Please refresh the page.';

const mockPrinter = {
  id: 1,
  name: 'X1C',
  ip_address: '192.168.1.100',
  serial_number: '01P00A000000001',
  access_code: '12345678',
  model: 'X1C',
  enabled: true,
  nozzle_diameter: 0.4,
  nozzle_type: 'stainless_steel',
  location: 'Workshop',
  auto_archive: true,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

let store: Record<string, string>;
let timerSpies: { mockRestore: () => void }[] = [];

/* Makes the currently healthy wall re-render with the given throw flag. */
function crashHealthyWall() {
  wall.shouldThrow = true;
  act(() => {
    wall.rerender?.();
  });
}

describe('PrintersPage — camera wall recovers from a render error (T-019)', () => {
  beforeEach(() => {
    // shouldAdvanceTime keeps msw/react-query/findBy* working on real time
    // while advanceTimersByTime can still jump straight to the auto-retry.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    wall.shouldThrow = false;
    wall.mounts = 0;
    wall.rerender = null;
    store = { printerPageView: 'camwall' };
    vi.mocked(localStorage.getItem).mockImplementation((key: string) => store[key] ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key: string, value: string) => {
      store[key] = String(value);
    });
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json([mockPrinter])),
      http.get('/api/v1/queue/', () => HttpResponse.json([])),
    );
    // React logs every caught render error; keep the output readable.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore timer spies before the real timers come back, so the fake
    // functions they wrap are not reinstalled over the real ones.
    timerSpies.forEach((spy) => spy.mockRestore());
    timerSpies = [];
    vi.useRealTimers();
    vi.mocked(console.error).mockRestore();
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
  });

  it('renders the wall normally when nothing throws', async () => {
    render(<PrintersPage />);
    expect(await screen.findByText('camera tile ok')).toBeInTheDocument();
    expect(screen.queryByText(ERROR_TEXT)).not.toBeInTheDocument();
  });

  it('shows the error text with a countdown, then remounts the wall on its own after 20 s', async () => {
    wall.shouldThrow = true;
    render(<PrintersPage />);

    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();
    expect(screen.getByText('Reconnecting in 20s (attempt 1)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('camera tile ok')).not.toBeInTheDocument();

    // The transient fault clears; the wall waits out the delay first.
    wall.shouldThrow = false;
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText(ERROR_TEXT)).toBeInTheDocument();
    expect(screen.getByText('Reconnecting in 15s (attempt 1)')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(screen.queryByText(ERROR_TEXT)).not.toBeInTheDocument();
    expect(screen.getByText('camera tile ok')).toBeInTheDocument();
    expect(wall.mounts).toBe(1);
  });

  it('remounts the wall immediately when Retry is pressed, and the pending auto-retry is cancelled', async () => {
    wall.shouldThrow = true;
    render(<PrintersPage />);
    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();

    wall.shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.queryByText(ERROR_TEXT)).not.toBeInTheDocument();
    expect(screen.getByText('camera tile ok')).toBeInTheDocument();
    expect(wall.mounts).toBe(1);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    // No second remount from the old timer.
    expect(wall.mounts).toBe(1);
    expect(screen.getByText('camera tile ok')).toBeInTheDocument();
  });

  it('falls back again with a fresh, longer countdown if the remounted wall still throws', async () => {
    wall.shouldThrow = true;
    render(<PrintersPage />);
    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByText(ERROR_TEXT)).toBeInTheDocument();
    expect(screen.getByText('Reconnecting in 40s (attempt 2)')).toBeInTheDocument();

    wall.shouldThrow = false;
    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    expect(screen.getByText('camera tile ok')).toBeInTheDocument();
  });

  it('backs off 20 s, 40 s, 80 s between remounts while the wall keeps failing (T-055)', async () => {
    wall.shouldThrow = true;
    render(<PrintersPage />);
    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();

    const steps: [number, number][] = [
      [20, 1],
      [40, 2],
      [80, 3],
    ];
    for (const [seconds, attempt] of steps) {
      expect(screen.getByText(`Reconnecting in ${seconds}s (attempt ${attempt})`)).toBeInTheDocument();
      // No remount one second before the delay...
      act(() => {
        vi.advanceTimersByTime(seconds * 1000 - 1000);
      });
      expect(screen.getByText(`Reconnecting in 1s (attempt ${attempt})`)).toBeInTheDocument();
      // ...and exactly one at it (it throws again, so the next attempt shows).
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.queryByText(`Reconnecting in 1s (attempt ${attempt})`)).not.toBeInTheDocument();
      expect(screen.getByText(ERROR_TEXT)).toBeInTheDocument();
    }
    expect(screen.getByText('Reconnecting in 160s (attempt 4)')).toBeInTheDocument();

    // The fault clears: the 160 s remount brings the wall back.
    wall.shouldThrow = false;
    act(() => {
      vi.advanceTimersByTime(159_000);
    });
    expect(wall.mounts).toBe(0);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText('camera tile ok')).toBeInTheDocument();
    expect(wall.mounts).toBe(1);
  });

  it('caps the automatic retry delay at 300 s (T-055)', async () => {
    wall.shouldThrow = true;
    render(<PrintersPage />);
    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();

    for (const seconds of [20, 40, 80, 160]) {
      act(() => {
        vi.advanceTimersByTime(seconds * 1000);
      });
    }
    // 20 * 2^4 = 320 s, capped to 300 s.
    expect(screen.getByText('Reconnecting in 300s (attempt 5)')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(300_000);
    });
    // Still failing: the delay stays at the cap.
    expect(screen.getByText('Reconnecting in 300s (attempt 6)')).toBeInTheDocument();

    wall.shouldThrow = false;
    act(() => {
      vi.advanceTimersByTime(299_000);
    });
    expect(screen.queryByText('camera tile ok')).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText('camera tile ok')).toBeInTheDocument();
  });

  it('resets the backoff once a remounted wall has stayed up for 60 s (T-055)', async () => {
    wall.shouldThrow = true;
    render(<PrintersPage />);
    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();

    // Two failed remounts: the next delay would be 80 s.
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    expect(screen.getByText('Reconnecting in 80s (attempt 3)')).toBeInTheDocument();

    // The wall comes back but crashes again before it has settled: still backing off.
    wall.shouldThrow = false;
    act(() => {
      vi.advanceTimersByTime(80_000);
    });
    expect(screen.getByText('camera tile ok')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    crashHealthyWall();
    expect(screen.getByText('Reconnecting in 160s (attempt 4)')).toBeInTheDocument();

    // This time it stays up for the full 60 s settle period.
    wall.shouldThrow = false;
    act(() => {
      vi.advanceTimersByTime(160_000);
    });
    expect(screen.getByText('camera tile ok')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    crashHealthyWall();
    expect(screen.getByText('Reconnecting in 20s (attempt 5)')).toBeInTheDocument();

    wall.shouldThrow = false;
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByText('camera tile ok')).toBeInTheDocument();
  });

  it('Retry remounts immediately even when the automatic delay has grown (T-055)', async () => {
    wall.shouldThrow = true;
    render(<PrintersPage />);
    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();

    for (const seconds of [20, 40, 80, 160]) {
      act(() => {
        vi.advanceTimersByTime(seconds * 1000);
      });
    }
    expect(screen.getByText('Reconnecting in 300s (attempt 5)')).toBeInTheDocument();

    wall.shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.queryByText(ERROR_TEXT)).not.toBeInTheDocument();
    expect(screen.getByText('camera tile ok')).toBeInTheDocument();
    expect(wall.mounts).toBe(1);
  });

  it('clears the pending retry timer when unmounted during the countdown (T-055)', async () => {
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    timerSpies.push(setSpy, clearSpy);

    wall.shouldThrow = true;
    const { unmount } = render(<PrintersPage />);
    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByText('Reconnecting in 40s (attempt 2)')).toBeInTheDocument();

    const retryIdx = setSpy.mock.calls.findLastIndex((call) => call[1] === 40_000);
    expect(retryIdx).toBeGreaterThanOrEqual(0);
    const retryTimer = setSpy.mock.results[retryIdx].value;

    vi.mocked(console.error).mockClear();
    unmount();
    expect(clearSpy).toHaveBeenCalledWith(retryTimer);

    wall.shouldThrow = false;
    act(() => {
      vi.advanceTimersByTime(300_000);
    });
    expect(wall.mounts).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('clears the pending settle timer when unmounted while the remounted wall settles (T-055)', async () => {
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    timerSpies.push(setSpy, clearSpy);

    wall.shouldThrow = true;
    const { unmount } = render(<PrintersPage />);
    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();
    wall.shouldThrow = false;
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByText('camera tile ok')).toBeInTheDocument();

    const settleIdx = setSpy.mock.calls.findLastIndex((call) => call[1] === 60_000);
    expect(settleIdx).toBeGreaterThanOrEqual(0);
    const settleTimer = setSpy.mock.results[settleIdx].value;

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    vi.mocked(console.error).mockClear();
    unmount();
    expect(clearSpy).toHaveBeenCalledWith(settleTimer);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(console.error).not.toHaveBeenCalled();
  });
});
