import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { HoursTab } from '../../components/maintenance/hours/HoursTab';
import type { HoursOverview } from '../../api/client';

// jsdom has no layout, so ResponsiveContainer renders nothing; pin a size.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: (props: ComponentProps<typeof actual.ResponsiveContainer>) => (
      <actual.ResponsiveContainer {...props} width={800} height={300} />
    ),
  };
});

const overview: HoursOverview = {
  today: '2026-10-04',
  machines: [
    { id: 1, printer_id: 6, name: 'X1C04', model: 'X1C', retired: false, current_hours: 3900 },
    { id: 2, printer_id: 3, name: 'H2S02', model: 'H2S', retired: false, current_hours: 1200 },
    { id: 3, printer_id: null, name: 'X1C01', model: 'X1C', retired: true, current_hours: null },
  ],
  readings: [
    { id: 1, machine_id: 1, reading_date: '2026-01-01', hours: 3297, source: 'manual' },
    { id: 2, machine_id: 1, reading_date: '2026-04-25', hours: 3803, source: 'manual' },
    { id: 3, machine_id: 2, reading_date: '2026-04-25', hours: 906, source: 'manual' },
    { id: 4, machine_id: 3, reading_date: '2026-04-25', hours: 4102, source: 'manual' },
    { id: 5, machine_id: 1, reading_date: '2026-10-04', hours: 3900, source: 'auto' },
    { id: 6, machine_id: 2, reading_date: '2026-10-04', hours: 1200, source: 'auto' },
  ],
};

function serve(data: HoursOverview = overview) {
  server.use(http.get('/api/v1/maintenance/hours', () => HttpResponse.json(data)));
}

describe('HoursTab', () => {
  it('lists active machines by family and retired ones last', async () => {
    serve();
    render(<HoursTab />);
    const list = await screen.findByTestId('hours-machine-list');
    const names = within(list).getAllByTestId('hours-machine-row').map((r) => r.dataset.name);
    expect(names).toEqual(['H2S02', 'X1C04', 'X1C01']);
    expect(within(list).getByText('Retired')).toBeInTheDocument();
  });

  it('logs manual dates newest first plus one auto row for today', async () => {
    serve();
    render(<HoursTab />);
    const log = await screen.findByTestId('hours-reading-log');
    const rows = within(log).getAllByTestId('hours-log-row').map((r) => r.dataset.date + ':' + r.dataset.source);
    expect(rows).toEqual(['2026-10-04:auto', '2026-04-25:manual', '2026-01-01:manual']);
  });

  it('switches chart modes', async () => {
    serve();
    const user = userEvent.setup();
    render(<HoursTab />);
    await screen.findByTestId('hours-machine-list');
    await user.click(screen.getByRole('button', { name: 'Hours / month' }));
    expect(await screen.findByText('The current month is still in progress.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fleet total' }));
    expect(screen.queryByText('The current month is still in progress.')).not.toBeInTheDocument();
  });

  it('toggles a machine off and back on', async () => {
    serve();
    const user = userEvent.setup();
    render(<HoursTab />);
    const row = (await screen.findAllByTestId('hours-machine-row')).find((r) => r.dataset.name === 'X1C04')!;
    await user.click(row);
    expect(row).toHaveAttribute('aria-pressed', 'false');
    await user.click(row);
    expect(row).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the empty state', async () => {
    serve({ today: '2026-10-04', machines: overview.machines.slice(0, 1), readings: [] });
    render(<HoursTab />);
    expect(await screen.findByText('No readings yet. Add one or paste your sheet.')).toBeInTheDocument();
  });

  it('deletes a manual date after confirmation', async () => {
    serve();
    let deleted: string | null = null;
    server.use(
      http.delete('/api/v1/maintenance/hours/readings', ({ request }) => {
        deleted = new URL(request.url).searchParams.get('reading_date');
        return HttpResponse.json(overview);
      }),
    );
    const user = userEvent.setup();
    render(<HoursTab />);
    const log = await screen.findByTestId('hours-reading-log');
    const row = within(log).getAllByTestId('hours-log-row').find((r) => r.dataset.date === '2026-01-01')!;
    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    await screen.findByText('Delete readings');
    // ConfirmModal has no dialog role; it renders after the log, so its confirm is the last "Delete".
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    await user.click(deleteButtons[deleteButtons.length - 1]);
    await waitFor(() => expect(deleted).toBe('2026-01-01'));
  });
});
