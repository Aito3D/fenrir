/**
 * NotificationLogViewer against msw: rows, expand, filter request params,
 * clear-old DELETE and its toast, loading and empty states.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { NotificationLogViewer } from '../../components/NotificationLogViewer';
import type { NotificationLogEntry } from '../../api/client';

afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

function entry(overrides: Partial<NotificationLogEntry> = {}): NotificationLogEntry {
  return {
    id: 1,
    provider_id: 3,
    provider_name: 'Shop ntfy',
    provider_type: 'ntfy',
    event_type: 'print_complete',
    title: 'Benchy done',
    message: 'The print finished',
    success: true,
    error_message: null,
    printer_id: 1,
    printer_name: 'Printer One',
    created_at: '2020-01-01T00:00:00Z',
    ...overrides,
  };
}

const STATS = { total: 5, success_count: 4, failure_count: 1, by_event_type: {}, by_provider: {} };

/** Serves logs/stats and records every query string seen. */
function serve(logs: NotificationLogEntry[], stats = STATS) {
  const logQueries: URLSearchParams[] = [];
  const statQueries: URLSearchParams[] = [];
  server.use(
    http.get('*/api/v1/notifications/logs/stats', ({ request }) => {
      statQueries.push(new URL(request.url).searchParams);
      return HttpResponse.json(stats);
    }),
    http.get('*/api/v1/notifications/logs', ({ request }) => {
      logQueries.push(new URL(request.url).searchParams);
      return HttpResponse.json(logs);
    }),
  );
  return { logQueries, statQueries };
}

describe('NotificationLogViewer', () => {
  it('renders rows with provider, event label, printer and the stats bar', async () => {
    serve([
      entry(),
      entry({ id: 2, provider_name: null, event_type: 'print_failed', success: false, error_message: 'boom' }),
    ]);
    render(<NotificationLogViewer onClose={vi.fn()} />);

    expect(await screen.findByText('Shop ntfy')).toBeInTheDocument();
    expect(screen.getByText('Print Complete')).toBeInTheDocument();
    expect(screen.getAllByText('Printer One')).toHaveLength(2);
    expect(screen.getByText('Unknown Provider')).toBeInTheDocument();
    expect(screen.getByText('Print Failed')).toBeInTheDocument();
    expect(await screen.findByText('4 sent')).toBeInTheDocument();
    expect(screen.getByText('1 failed')).toBeInTheDocument();
  });

  it('expands a failed row to show message and error, and collapses again', async () => {
    const user = userEvent.setup();
    serve([entry({ success: false, error_message: 'connection refused' })]);
    render(<NotificationLogViewer onClose={vi.fn()} />);

    await user.click(await screen.findByText('Shop ntfy'));
    expect(screen.getByText('Benchy done')).toBeInTheDocument();
    expect(screen.getByText('The print finished')).toBeInTheDocument();
    expect(screen.getByText('connection refused')).toBeInTheDocument();
    expect(screen.getByText('Provider: ntfy')).toBeInTheDocument();

    await user.click(screen.getByText('Shop ntfy'));
    expect(screen.queryByText('connection refused')).not.toBeInTheDocument();
  });

  it('requests 7 days by default and re-requests when the range changes', async () => {
    const user = userEvent.setup();
    const { logQueries, statQueries } = serve([entry()]);
    render(<NotificationLogViewer onClose={vi.fn()} />);

    await screen.findByText('Shop ntfy');
    expect(logQueries[0].get('days')).toBe('7');
    expect(logQueries[0].get('limit')).toBe('100');
    expect(logQueries[0].has('success')).toBe(false);
    expect(statQueries[0].get('days')).toBe('7');

    await user.selectOptions(screen.getByRole('combobox'), '30');
    await waitFor(() => expect(logQueries.at(-1)?.get('days')).toBe('30'));
    await waitFor(() => expect(statQueries.at(-1)?.get('days')).toBe('30'));
  });

  it('failed-only sends success=false and shows its own empty state', async () => {
    const user = userEvent.setup();
    const { logQueries } = serve([entry()]);
    render(<NotificationLogViewer onClose={vi.fn()} />);
    await screen.findByText('Shop ntfy');

    server.use(
      http.get('*/api/v1/notifications/logs', ({ request }) => {
        logQueries.push(new URL(request.url).searchParams);
        return HttpResponse.json([]);
      }),
    );
    await user.click(screen.getByLabelText('Failed only'));

    expect(await screen.findByText('No failed notifications')).toBeInTheDocument();
    expect(logQueries.at(-1)?.get('success')).toBe('false');
  });

  it('shows the empty state when nothing is logged', async () => {
    serve([]);
    render(<NotificationLogViewer onClose={vi.fn()} />);
    expect(await screen.findByText('No notifications logged')).toBeInTheDocument();
  });

  it('shows a spinner (no empty state) while the logs load', async () => {
    server.use(
      http.get('*/api/v1/notifications/logs/stats', () => HttpResponse.json(STATS)),
      http.get('*/api/v1/notifications/logs', async () => {
        await delay(150);
        return HttpResponse.json([entry()]);
      }),
    );
    render(<NotificationLogViewer onClose={vi.fn()} />);
    expect(screen.queryByText('No notifications logged')).not.toBeInTheDocument();
    expect(await screen.findByText('Shop ntfy')).toBeInTheDocument();
  });

  it('Clear Old sends DELETE with older_than_days=30 and toasts the message', async () => {
    const user = userEvent.setup();
    serve([entry()]);
    const deletes: URLSearchParams[] = [];
    server.use(
      http.delete('*/api/v1/notifications/logs', ({ request }) => {
        deletes.push(new URL(request.url).searchParams);
        return HttpResponse.json({ deleted: 3, message: 'Deleted 3 old logs' });
      }),
    );
    render(<NotificationLogViewer onClose={vi.fn()} />);
    await screen.findByText('Shop ntfy');

    await user.click(screen.getByRole('button', { name: /Clear Old/ }));

    expect(await screen.findByText('Deleted 3 old logs')).toBeInTheDocument();
    expect(deletes).toHaveLength(1);
    expect(deletes[0].get('older_than_days')).toBe('30');
  });

  it('Clear Old failure shows an error toast', async () => {
    const user = userEvent.setup();
    serve([entry()]);
    server.use(
      http.delete('*/api/v1/notifications/logs', () =>
        HttpResponse.json({ detail: 'nope' }, { status: 500 }),
      ),
    );
    render(<NotificationLogViewer onClose={vi.fn()} />);
    await screen.findByText('Shop ntfy');

    await user.click(screen.getByRole('button', { name: /Clear Old/ }));
    expect(await screen.findByText(/Failed to clear logs: nope/)).toBeInTheDocument();
  });

  it('Refresh refetches the logs and the close button calls onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { logQueries } = serve([entry()]);
    render(<NotificationLogViewer onClose={onClose} />);
    await screen.findByText('Shop ntfy');
    const before = logQueries.length;

    await user.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(logQueries.length).toBeGreaterThan(before));

    await user.click(screen.getByRole('button', { name: '×' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
