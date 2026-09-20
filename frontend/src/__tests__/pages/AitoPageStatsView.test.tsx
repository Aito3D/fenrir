import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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
    // The header's own count badge is gone (the strip's day line carries the phrase instead).
    expect(document.querySelector('.vt-aito-count')).toBeNull();
    // The timeframe selector lives inside the view now, beside its tabs, not
    // in the page toolbar: it only changes what sits under the tabs.
    const timeframe = screen.getByRole('button', { name: /Last 30 Days/ });
    expect(timeframe.closest('[data-testid="aito-stats-view"]')).not.toBeNull();
    expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to board' }));
    expect(screen.queryByTestId('aito-stats-view')).toBeNull();
    expect(await screen.findByRole('button', { name: /Support GoPro/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trash' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show done/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Last 30 Days/ })).toBeNull();
  });

  it('an archive keeps only its own toggle and a wider search box', async () => {
    const user = userEvent.setup();
    render(<AitoPage />);
    await screen.findByRole('button', { name: /Support GoPro/ });
    await user.click(screen.getByRole('button', { name: 'Trash' }));

    expect(screen.getByRole('button', { name: 'Back to board' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show done/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Statistics' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Project' })).toBeNull();
    const search = screen.getByPlaceholderText(/Search projects/);
    expect(search.closest('.lg\\:w-96')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Back to board' }));
    await user.click(await screen.findByRole('button', { name: /Show done/ }));
    expect(screen.queryByRole('button', { name: 'Trash' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Statistics' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to board' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to board' }));
    expect(await screen.findByRole('button', { name: 'Trash' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Statistics' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Project' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search projects/).closest('.lg\\:w-52')).not.toBeNull();
  });

  it('switches views through a scoped View Transition when the browser has one', async () => {
    const user = userEvent.setup();
    const doc = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };
    let scopeDuringUpdate: string | undefined;
    doc.startViewTransition = vi.fn((cb: () => void) => {
      scopeDuringUpdate = document.documentElement.dataset.vt;
      cb();
      return { finished: Promise.resolve() };
    });
    try {
      render(<AitoPage />);
      await screen.findByRole('button', { name: /Support GoPro/ });
      await user.click(screen.getByRole('button', { name: 'Statistics' }));
      expect(doc.startViewTransition).toHaveBeenCalledTimes(1);
      expect(scopeDuringUpdate).toBe('aito-view');
      expect(await screen.findByTestId('aito-stats-view')).toBeInTheDocument();
      await waitFor(() => expect(document.documentElement.dataset.vt).toBeUndefined());
      // The content wrapper and the toolbar carry the named groups the CSS animates.
      expect(document.querySelector('.vt-aito-view')).not.toBeNull();
      expect(document.querySelector('.vt-aito-toolbar')).not.toBeNull();
      // Pressing the active toggle again is a no-op, not a second transition.
      await user.click(screen.getByRole('button', { name: 'Back to board' }));
      expect(doc.startViewTransition).toHaveBeenCalledTimes(2);
      expect(await screen.findByRole('button', { name: /Support GoPro/ })).toBeInTheDocument();
    } finally {
      delete doc.startViewTransition;
      delete document.documentElement.dataset.vt;
    }
  });

  it('a hanging row returns to the board and opens that card', async () => {
    const user = userEvent.setup();
    const sent = { ...project, id: 77, description: 'Engrenage machine à laver', client_name: 'Tehei Neuffer', column: 'waiting', quote_status: 'sent', quote_sent_at: '2026-01-01T10:00:00', quote_total: 4200 };
    server.use(http.get('/api/v1/aito/', () => HttpResponse.json([project, sent])));
    render(<AitoPage />);
    await screen.findByRole('button', { name: /Tehei Neuffer/ });
    await user.click(screen.getByRole('button', { name: 'Statistics' }));
    const chase = await screen.findByTestId('aito-brief-chase');
    await user.click(within(chase).getByRole('button', { name: /Tehei Neuffer/ }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Engrenage machine à laver');
    expect(screen.queryByTestId('aito-stats-view')).toBeNull();
    expect(screen.getByRole('button', { name: 'Statistics' })).toBeInTheDocument();
  });
});
