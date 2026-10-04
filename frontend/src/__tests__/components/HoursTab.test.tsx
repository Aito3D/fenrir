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

  it('form lists only Fenrir printers, defaults to the server date and shows counters as placeholders', async () => {
    serve();
    const user = userEvent.setup();
    render(<HoursTab />);
    await user.click(await screen.findByRole('button', { name: 'New reading' }));
    const dialog = await screen.findByTestId('hours-reading-form');
    expect(within(dialog).getByLabelText('Date')).toHaveValue('2026-10-04'); // server today, not the browser's
    const fields = within(dialog).getAllByRole('textbox');
    expect(fields.map((f) => f.getAttribute('name'))).toEqual(['H2S02', 'X1C04']); // no retired X1C01
    expect(within(dialog).getByRole('textbox', { name: 'X1C04' })).toHaveValue('');
    expect(within(dialog).getByRole('textbox', { name: 'X1C04' })).toHaveAttribute('placeholder', expect.stringContaining('3'));
    expect(within(dialog).getByText(/recalibrate/)).toBeInTheDocument();
  });

  it('flags a value lower than the previous reading and saves only filled fields', async () => {
    serve();
    let body: unknown = null;
    server.use(
      http.post('/api/v1/maintenance/hours/readings', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(overview);
      }),
    );
    const user = userEvent.setup();
    render(<HoursTab />);
    await user.click(await screen.findByRole('button', { name: 'New reading' }));
    const dialog = await screen.findByTestId('hours-reading-form');
    await user.type(within(dialog).getByRole('textbox', { name: 'X1C04' }), '3 700');
    expect(within(dialog).getByText('Lower than the previous reading (3,803 h)')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(body).toEqual({ reading_date: '2026-10-04', entries: [{ machine_id: 1, hours: 3700 }] }),
    );
  });

  it('edit prefills the date values and clearing a field sends null', async () => {
    serve();
    let body: unknown = null;
    server.use(
      http.post('/api/v1/maintenance/hours/readings', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(overview);
      }),
    );
    const user = userEvent.setup();
    render(<HoursTab />);
    const log = await screen.findByTestId('hours-reading-log');
    const row = within(log).getAllByTestId('hours-log-row').find((r) => r.dataset.date === '2026-04-25')!;
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByTestId('hours-reading-form');
    expect(within(dialog).getByText(/history only/)).toBeInTheDocument();
    const x1c04 = within(dialog).getByRole('textbox', { name: 'X1C04' });
    expect(x1c04).toHaveValue('3803');
    await user.clear(within(dialog).getByRole('textbox', { name: 'H2S02' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(body).toEqual({
        reading_date: '2026-04-25',
        entries: [{ machine_id: 2, hours: null }, { machine_id: 1, hours: 3803 }],
      }),
    );
  });

  it('disables save on an invalid number', async () => {
    serve();
    const user = userEvent.setup();
    render(<HoursTab />);
    await user.click(await screen.findByRole('button', { name: 'New reading' }));
    const dialog = await screen.findByTestId('hours-reading-form');
    await user.type(within(dialog).getByRole('textbox', { name: 'H2S02' }), '12a');
    expect(within(dialog).getByText('Not a number')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('previews a pasted sheet and imports matched + new retired columns', async () => {
    serve();
    let body: unknown = null;
    server.use(
      http.post('/api/v1/maintenance/hours/import', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ machines_created: 1, readings_written: 3 });
      }),
    );
    const user = userEvent.setup();
    render(<HoursTab />);
    await user.click(await screen.findByRole('button', { name: 'Paste from sheet' }));
    const dialog = await screen.findByTestId('hours-paste-import');
    const text = 'Date\tX1C04\tX1C02\tTotal\n19/07/2024\t243\t212\t455\n25/04/2026\t3803\t0\t3803\n';
    await user.click(within(dialog).getByRole('textbox'));
    await user.paste(text);
    expect(within(dialog).getByText('2 dates · 2 columns · 3 readings')).toBeInTheDocument(); // Total is ignored
    const x1c02 = within(dialog).getByTestId('paste-column-X1C02');
    expect(within(x1c02).getByRole('combobox')).toHaveValue('create');
    expect(within(within(dialog).getByTestId('paste-column-Total')).getByRole('combobox')).toHaveValue('ignore');
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(body).toEqual({
        new_machines: [{ key: 'X1C02', name: 'X1C02', model: 'X1C' }],
        readings: [
          { machine_id: 1, reading_date: '2024-07-19', hours: 243 },
          { key: 'X1C02', reading_date: '2024-07-19', hours: 212 },
          { machine_id: 1, reading_date: '2026-04-25', hours: 3803 },
        ],
      }),
    );
  });

  it('explains a paste without dated rows and keeps Import disabled', async () => {
    serve();
    const user = userEvent.setup();
    render(<HoursTab />);
    await user.click(await screen.findByRole('button', { name: 'Paste from sheet' }));
    const dialog = await screen.findByTestId('hours-paste-import');
    await user.click(within(dialog).getByRole('textbox'));
    await user.paste('X1C04\t3803');
    expect(within(dialog).getByText(/No row starts with a date/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Import' })).toBeDisabled();
  });

  it('shows the future-rows notice when every dated row is after today', async () => {
    serve();
    const user = userEvent.setup();
    render(<HoursTab />);
    await user.click(await screen.findByRole('button', { name: 'Paste from sheet' }));
    const dialog = await screen.findByTestId('hours-paste-import');
    await user.click(within(dialog).getByRole('textbox'));
    await user.paste('Date\tX1C04\n05/10/2099\t3900\n');
    expect(within(dialog).queryByText(/No row starts with a date/)).not.toBeInTheDocument();
    expect(within(dialog).getByText('Rows dated in the future are skipped: 1')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Import' })).toBeDisabled();
  });
});
