/**
 * T-019: the camera wall's error boundary used to be the shared
 * ErrorBoundary, which has no reset path, so one transient render error in
 * the wall (or any tile) left an unattended kiosk wall on static red text
 * until someone reloaded the page. The wall now shows the same error text
 * with a "Reconnecting in Ns (attempt N)" countdown and a Retry button, and remounts itself after
 * 20 s, or immediately on Retry.
 *
 * CameraGrid is mocked with a stand-in whose tile throws on demand, so the
 * test exercises the real PrintersPage boundary without any streaming.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';

const wall = vi.hoisted(() => ({ shouldThrow: false, mounts: 0 }));

vi.mock('../../components/CameraGrid', () => {
  function Tile() {
    if (wall.shouldThrow) throw new Error('malformed live status payload');
    return <div>camera tile ok</div>;
  }
  function CameraGrid() {
    useEffect(() => {
      wall.mounts += 1;
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

describe('PrintersPage — camera wall recovers from a render error (T-019)', () => {
  beforeEach(() => {
    // shouldAdvanceTime keeps msw/react-query/findBy* working on real time
    // while advanceTimersByTime can still jump straight to the auto-retry.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    wall.shouldThrow = false;
    wall.mounts = 0;
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

  it('falls back again with a fresh countdown if the remounted wall still throws', async () => {
    wall.shouldThrow = true;
    render(<PrintersPage />);
    expect(await screen.findByText(ERROR_TEXT)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByText(ERROR_TEXT)).toBeInTheDocument();
    expect(screen.getByText('Reconnecting in 20s (attempt 2)')).toBeInTheDocument();

    wall.shouldThrow = false;
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByText('camera tile ok')).toBeInTheDocument();
  });
});
