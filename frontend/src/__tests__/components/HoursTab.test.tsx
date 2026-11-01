import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
  today: '2031-02-14',
  machines: [
    { id: 1, printer_id: 6, name: 'X1C04', model: 'X1C', retired: false, current_hours: 3900,
      trust: 'uncalibrated', last_drift_hours: null, calibrated_at: null, counter_raw_hours: null, next_service_hours: null, purchase_price: null, purchase_date: null, added_on: null },
    { id: 2, printer_id: 3, name: 'H2S02', model: 'H2S', retired: false, current_hours: 1200,
      trust: 'uncalibrated', last_drift_hours: null, calibrated_at: null, counter_raw_hours: null, next_service_hours: null, purchase_price: null, purchase_date: null, added_on: null },
    { id: 3, printer_id: null, name: 'X1C01', model: 'X1C', retired: true, current_hours: null,
      trust: 'uncalibrated', last_drift_hours: null, calibrated_at: null, counter_raw_hours: null, next_service_hours: null, purchase_price: null, purchase_date: null, added_on: null },
  ],
  readings: [
    { id: 1, machine_id: 1, reading_date: '2026-01-01', hours: 3297, source: 'manual', raw_hours: null },
    { id: 2, machine_id: 1, reading_date: '2026-04-25', hours: 3803, source: 'manual', raw_hours: null },
    { id: 3, machine_id: 2, reading_date: '2026-04-25', hours: 906, source: 'manual', raw_hours: null },
    { id: 4, machine_id: 3, reading_date: '2026-04-25', hours: 4102, source: 'manual', raw_hours: null },
    { id: 5, machine_id: 1, reading_date: '2031-02-14', hours: 3900, source: 'auto', raw_hours: null },
    { id: 6, machine_id: 2, reading_date: '2031-02-14', hours: 1200, source: 'auto', raw_hours: null },
  ],
  events: [],
  reading_interval_days: 90,
  due_machine_ids: [],
};

function serve(data: HoursOverview = overview) {
  server.use(http.get('/api/v1/maintenance/hours', () => HttpResponse.json(data)));
}

describe('HoursTab', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('lists active machines by family and retired ones last', async () => {
    serve();
    render(<HoursTab />);
    const list = await screen.findByTestId('hours-machine-list');
    const names = within(list).getAllByTestId('hours-machine-row').map((r) => r.dataset.name);
    expect(names).toEqual(['H2S02', 'X1C04', 'X1C01']);
    expect(within(list).getByText('Retired')).toBeInTheDocument();
  });

  it('renders the fleet strip above the chart', async () => {
    serve();
    render(<HoursTab />);
    expect(await screen.findByText('Fleet lifetime')).toBeInTheDocument();
  });

  it('logs manual dates newest first plus one auto row for today', async () => {
    serve();
    const user = userEvent.setup();
    render(<HoursTab />);
    await user.click(await screen.findByRole('button', { name: '1 older dates' }));
    const log = await screen.findByTestId('hours-reading-log');
    const rows = within(log).getAllByTestId('hours-log-row').map((r) => r.dataset.date + ':' + r.dataset.source);
    expect(rows).toEqual(['2031-02-14:auto', '2026-04-25:manual', '2026-01-01:manual']);
  });

  it('log shows two rows then expands', async () => {
    serve();
    const user = userEvent.setup();
    render(<HoursTab />);
    const log = await screen.findByTestId('hours-reading-log');
    expect(within(log).getAllByTestId('hours-log-row')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: '1 older dates' }));
    expect(within(log).getAllByTestId('hours-log-row')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: '1 older dates' })).not.toBeInTheDocument();
  });

  it('changing the interval calls the settings endpoint', async () => {
    serve();
    const bodies: number[] = [];
    server.use(
      http.patch('/api/v1/maintenance/hours/settings', async ({ request }) => {
        const body = (await request.json()) as { reading_interval_days: number };
        bodies.push(body.reading_interval_days);
        return HttpResponse.json({ ...overview, reading_interval_days: body.reading_interval_days });
      }),
    );
    const user = userEvent.setup();
    render(<HoursTab />);
    const input = await screen.findByRole('spinbutton', { name: 'Readings every' });
    expect(input).toHaveValue(90);
    await user.clear(input);
    await user.type(input, '120');
    await user.tab();
    await waitFor(() => expect(bodies).toEqual([120]));
    expect(input).toHaveValue(120);
    await user.clear(input);
    await user.type(input, '3');
    await user.tab();
    await waitFor(() => expect(input).toHaveValue(120));
    expect(bodies).toEqual([120]);
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
    await user.click(screen.getByRole('button', { name: 'Same age' }));
    expect(screen.getByRole('button', { name: 'Same age' })).toBeInTheDocument();
    expect(document.querySelector('.hours-forecast')).toBeNull();
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

  it('rail rows show a sparkline and no per-month rate', async () => {
    serve();
    render(<HoursTab />);
    const list = await screen.findByTestId('hours-machine-list');
    const rows = within(list).getAllByTestId('hours-machine-row');
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.closest('[role=group]')?.querySelector('svg[data-testid=sparkline]')).not.toBeNull();
    expect(within(list).queryByText(/h\/month/)).toBeNull();
    expect(within(list).getByRole('button', { name: 'Open X1C04' })).toBeInTheDocument();
  });

  it('the toggle is named after the machine and the name button opens without toggling', async () => {
    serve();
    render(<HoursTab />);
    const toggle = await screen.findByRole('button', { name: 'X1C04', pressed: true });
    await userEvent.click(screen.getByRole('button', { name: 'Open X1C04' }));
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(document.querySelector('[data-panel-id="1"]')).not.toBeNull();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking a rail name opens the panel and mirrors ?machine=', async () => {
    serve();
    render(<HoursTab />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open X1C04' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'X1C04' })).toBeInTheDocument();
    expect(window.location.search).toContain('machine=1');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.search).not.toContain('machine=');
  });

  it('range segment switches and focus header shows the hovered machine', async () => {
    serve();
    const user = userEvent.setup();
    render(<HoursTab />);
    const list = await screen.findByTestId('hours-machine-list');
    const range = screen.getByRole('group', { name: 'Range' });
    expect(within(range).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(range).getByRole('button', { name: '12 m' }));
    expect(within(range).getByRole('button', { name: '12 m' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(range).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('hours-focus-header')).toHaveTextContent('3 machines');
    await user.hover(within(list).getAllByTestId('hours-machine-row')[1]);
    expect(screen.getByTestId('hours-focus-header')).toHaveTextContent('X1C04');
  });

  it('shows the empty state', async () => {
    serve({ ...overview, machines: overview.machines.slice(0, 1), readings: [] });
    render(<HoursTab />);
    // once in the chart area, once under the reading log
    expect(await screen.findAllByText('No readings yet. Add one or paste your sheet.')).toHaveLength(2);
    expect(screen.queryByTestId('hours-chart-empty')).toBeInTheDocument();
  });

  it('shows the last manual value, not an uncalibrated counter below it', async () => {
    serve({
      ...overview,
      machines: [{ id: 1, printer_id: 6, name: 'X1C04', model: 'X1C', retired: false, current_hours: 124,
        trust: 'uncalibrated', last_drift_hours: null, calibrated_at: null, counter_raw_hours: null, next_service_hours: null, purchase_price: null, purchase_date: null, added_on: null }],
      readings: [
        { id: 2, machine_id: 1, reading_date: '2026-04-25', hours: 3803, source: 'manual', raw_hours: null },
        { id: 5, machine_id: 1, reading_date: '2031-02-14', hours: 124, source: 'auto', raw_hours: null },
      ],
    });
    render(<HoursTab />);
    const list = await screen.findByTestId('hours-machine-list');
    expect(within(list).getByText('3,803 h')).toBeInTheDocument();
    expect(within(list).queryByText('124 h')).not.toBeInTheDocument();
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
    await user.click(await screen.findByRole('button', { name: '1 older dates' }));
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
    expect(within(dialog).getByLabelText('Date')).toHaveValue('2031-02-14'); // server today, not the browser's
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
    expect(
      within(dialog).getByText('Lower than the 3,803 h read on 4/25/2026. Lifetime hours never go down.'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(body).toEqual({ reading_date: '2031-02-14', entries: [{ machine_id: 1, hours: 3700 }] }),
    );
  });

  it('questions a jump far from the counter in the form and still saves it', async () => {
    serve({
      ...overview,
      machines: overview.machines.map((m) => (m.id === 1 ? { ...m, counter_raw_hours: 1612 } : m)),
      readings: [
        ...overview.readings,
        { id: 7, machine_id: 1, reading_date: '2026-04-25', hours: 3803, source: 'auto', raw_hours: 1000 },
      ],
    });
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
    await user.type(within(dialog).getByRole('textbox', { name: 'X1C04' }), '4800');
    expect(
      within(dialog).getByText('+997 h typed, but Fenrir counted +612 h since 4/25/2026. Expected about 4,415 h.'),
    ).toBeInTheDocument();
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(body).toEqual({ reading_date: '2031-02-14', entries: [{ machine_id: 1, hours: 4800 }] }));
  });

  it('only questions going backwards when the form is backdated', async () => {
    serve({
      ...overview,
      machines: overview.machines.map((m) => (m.id === 1 ? { ...m, counter_raw_hours: 1612 } : m)),
      readings: [
        ...overview.readings,
        { id: 7, machine_id: 1, reading_date: '2026-01-01', hours: 3297, source: 'auto', raw_hours: 400 },
      ],
    });
    const user = userEvent.setup();
    render(<HoursTab />);
    const log = await screen.findByTestId('hours-reading-log');
    const row = within(log).getAllByTestId('hours-log-row').find((r) => r.dataset.date === '2026-04-25')!;
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByTestId('hours-reading-form');
    const field = within(dialog).getByRole('textbox', { name: 'X1C04' });
    await user.clear(field);
    await user.type(field, '9000');
    expect(within(dialog).queryByText(/Expected about/)).not.toBeInTheDocument();
    expect(within(dialog).getAllByText('no counter reference for this period').length).toBeGreaterThan(0);
    await user.clear(field);
    await user.type(field, '3000');
    expect(within(dialog).getByText(/Lifetime hours never go down/)).toBeInTheDocument();
  });

  it("editing today's own reading compares with the previous date, not itself", async () => {
    serve({
      ...overview,
      machines: overview.machines.map((m) => (m.id === 1 ? { ...m, counter_raw_hours: 1612 } : m)),
      readings: [
        ...overview.readings,
        { id: 7, machine_id: 1, reading_date: '2026-04-25', hours: 3803, source: 'auto', raw_hours: 1000 },
        { id: 8, machine_id: 1, reading_date: '2031-02-14', hours: 3900, source: 'manual', raw_hours: null },
      ],
    });
    const user = userEvent.setup();
    render(<HoursTab />);
    await user.click(await screen.findByRole('button', { name: 'New reading' })); // today's date, prefilled with its own 3,900
    const dialog = await screen.findByTestId('hours-reading-form');
    const field = within(dialog).getByRole('textbox', { name: 'X1C04' });
    await user.clear(field);
    await user.type(field, '3850');
    expect(within(dialog).queryByText(/Lifetime hours never go down/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/\+47 h typed, but Fenrir counted \+612 h since 4\/25\/2026/)).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, '3700');
    expect(
      within(dialog).getByText('Lower than the 3,803 h read on 4/25/2026. Lifetime hours never go down.'),
    ).toBeInTheDocument();
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
        entries: [{ machine_id: 2, hours: null }],
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

  it('pass saves with the refetched today', async () => {
    serve();
    let body: { reading_date?: string } | null = null;
    server.use(
      http.post('/api/v1/maintenance/hours/readings', async ({ request }) => {
        body = (await request.json()) as { reading_date?: string };
        return HttpResponse.json(overview);
      }),
    );
    const user = userEvent.setup();
    // Same default as App.tsx: an overview fetched under a minute ago is fresh, so only staleTime: 0 forces the refetch.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    render(<QueryClientProvider client={qc}><HoursTab /></QueryClientProvider>);
    await user.click((await screen.findAllByRole('button', { name: 'Take readings' }))[0]);
    const dialog = await screen.findByTestId('hours-reading-pass');
    // The pass was open across midnight: the server's today has moved on.
    serve({ ...overview, today: '2031-02-15' });
    await user.type(within(dialog).getByRole('textbox', { name: 'H2S02' }), '1300{Enter}{Enter}');
    await user.click(within(dialog).getByRole('button', { name: 'Save 1 readings' }));
    await waitFor(() => expect(body).toEqual({ reading_date: '2031-02-15', entries: [{ machine_id: 2, hours: 1300 }] }));
    await waitFor(() => expect(screen.queryByTestId('hours-reading-pass')).not.toBeInTheDocument());
  });

  it('?pass=1 opens the pass on load', async () => {
    serve();
    window.history.pushState({}, '', '/maintenance?tab=hours&pass=1');
    try {
      render(<HoursTab />);
      expect(await screen.findByTestId('hours-reading-pass')).toBeInTheDocument();
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(window.location.search).toBe('?tab=hours'));
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});
