/**
 * The Printers page's `?focus=` deep link: the named card is scrolled to and
 * ringed for two seconds; an unknown printer toasts. Either way the parameter
 * leaves the URL. Setup mirrors PrintersPageCardScale.test.tsx.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { PrintersPage } from '../../pages/PrintersPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const mockPrinter = {
  id: 7,
  name: 'X1C',
  ip_address: '192.168.1.100',
  serial_number: '01P00A000000007',
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

const card = () => document.getElementById('printer-card-7');

describe('PrintersPage ?focus= deep link', () => {
  const original = window.location.href;

  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReturnValue(null);
    Element.prototype.scrollIntoView = vi.fn();
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json([mockPrinter])),
      http.get('/api/v1/printers/:id/status', () => HttpResponse.json({ connected: false, state: 'IDLE' })),
      http.get('/api/v1/queue/', () => HttpResponse.json([])),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState({}, '', original);
    vi.mocked(localStorage.getItem).mockReset();
  });

  it('scrolls to the card and rings it for two seconds, then strips the parameter', async () => {
    // Fake from the start (the ring's timer is armed as the card focuses),
    // with the clock still running so msw and waitFor behave as usual.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.pushState({}, '', '/printers?focus=7');
    render(<PrintersPage />);

    await waitFor(() => expect(card()?.className).toContain('ring-bambu-green'));
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toContain(card());
    expect(vi.mocked(Element.prototype.scrollIntoView)).toHaveBeenCalledWith({ block: 'center' });
    expect(window.location.search).not.toContain('focus=');

    act(() => vi.advanceTimersByTime(1500));
    expect(card()?.className).toContain('ring-bambu-green');
    act(() => vi.advanceTimersByTime(600));
    expect(card()?.className).not.toContain('ring-bambu-green');
  });

  it('toasts when the printer does not exist', async () => {
    window.history.pushState({}, '', '/printers?focus=99');
    render(<PrintersPage />);

    expect(await screen.findByText('This printer no longer exists')).toBeInTheDocument();
    expect(window.location.search).not.toContain('focus=');
    expect(card()?.className).not.toContain('ring-bambu-green');
  });
});
