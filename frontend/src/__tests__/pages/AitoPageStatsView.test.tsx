import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { AitoPage } from '../../pages/AitoPage';
import { __resetBoardSync } from '../../hooks/useBoardSync';

vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return { ...actual, ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div> };
});

const project = {
  id: 12, description: 'Support GoPro', column: 'devis', position: 0, status: 'active',
  client_id: 'z1', client_name: 'ACME SARL', client_phone: '+33 6 12 34 56 78',
  task_count: 0, tasks_total: 0, task_services: [], task_pending: [], steps_total: 0, steps_done: 0, print_minutes_pending: 0, task_steps: [],
  move_lock: null,
  shipping_island: null, shipping_service: null, shipping_first_name: null, shipping_last_name: null,
  shipping_phone: null, shipping_price: null, shipping_service_name: null,
  tracking_configured: false, quote_expiry_date: null, retainer_paid_total: null, customer_credit_total: null,
  payment_link: null, version: 1,
  created_at: '2026-07-01T10:00:00Z', updated_at: '2026-07-02T10:00:00Z',
};

beforeEach(() => {
  vi.mocked(localStorage.getItem).mockReset();
  vi.mocked(localStorage.setItem).mockReset();
  vi.mocked(localStorage.getItem).mockReturnValue(null);
  Element.prototype.scrollIntoView = vi.fn();
  __resetBoardSync();
  server.use(
    http.get('/api/v1/aito/', () => HttpResponse.json([project])),
    http.get('/api/v1/zoho/status', () =>
      HttpResponse.json({ configured: true, reachable: true, default_contact_id: 'walk-in', default_contact_name: 'Client de passage' }),
    ),
  );
});

describe('AitoPage statistics view', () => {
  it('opens from the icon-only toolbar toggle and returns to the board', async () => {
    const user = userEvent.setup();
    render(<AitoPage />);
    await screen.findByRole('button', { name: /Support GoPro/ });

    // Trash and Statistics are icons only: named, not captioned.
    const trash = screen.getByRole('button', { name: 'Trash' });
    expect(trash).not.toHaveTextContent('Trash');
    const stats = screen.getByRole('button', { name: 'Statistics' });
    expect(stats).not.toHaveTextContent('Statistics');
    expect(stats).toHaveAttribute('aria-pressed', 'false');

    await user.click(stats);
    expect(await screen.findByTestId('aito-stats-view')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Support GoPro/ })).toBeNull();
    // The active toggle is the way back. Everything about the live board —
    // search, the archives, creation, the count and the print backlog — is
    // gone; the timeframe selector takes the creation buttons' slot.
    expect(screen.getByRole('button', { name: 'Back to board' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Trash' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Show done/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Project' })).toBeNull();
    expect(screen.queryByPlaceholderText(/Search projects/)).toBeNull();
    expect(screen.queryByText(/in production$/)).toBeNull();
    expect(screen.getByRole('button', { name: /Last 30 Days/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to board' }));
    expect(screen.queryByTestId('aito-stats-view')).toBeNull();
    expect(await screen.findByRole('button', { name: /Support GoPro/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trash' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show done/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Last 30 Days/ })).toBeNull();
  });
});
