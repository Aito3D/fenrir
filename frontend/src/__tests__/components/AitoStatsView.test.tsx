import type { ComponentProps } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { StatsView } from '../../components/aito/StatsView';
import type { AitoStats } from '../../api/client';

// ActivityChart's weekly fold has no other observable surface once there are
// dozens of bars (no visible numbers, and the x-axis labels aren't guaranteed
// to render as ticks) -- capturing the `data` actually handed to recharts'
// ComposedChart lets the weekly-fold test assert the real per-week
// created/accepted/done sums instead of just the "Activity per week" title.
//
// `composedDataSets` collects every *distinct* data array seen (re-renders
// reuse the same array reference via useMemo, so settling on one value does
// not grow this list) rather than overwriting a single field with whatever
// rendered last. ActivityChart is the only ComposedChart in this tree today,
// but if a second one is ever added, its data would show up as a second,
// different array here -- the test asserts `toHaveLength(1)` before indexing
// so a future second chart fails loudly instead of silently swapping in its
// data under this chart's assertions.
const chartCapture = vi.hoisted(() => ({
  composedDataSets: [] as unknown[][],
}));

// jsdom has no layout, so Recharts' ResponsiveContainer measures 0×0 and
// renders nothing. Pin a width and let the real chart machinery run.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: (props: ComponentProps<typeof actual.ResponsiveContainer>) => (
      <actual.ResponsiveContainer {...props} width={600} />
    ),
    ComposedChart: (props: ComponentProps<typeof actual.ComposedChart>) => {
      const data = props.data as unknown[];
      if (!chartCapture.composedDataSets.includes(data)) {
        chartCapture.composedDataSets.push(data);
      }
      return <actual.ComposedChart {...props} />;
    },
  };
});

const COLUMNS = ['devis', 'waiting', 'scan', 'model', 'print', 'finish', 'done'] as const;

export function fixture(overrides: Partial<AitoStats> = {}): AitoStats {
  return {
    board: COLUMNS.map((column) => ({ column, count: column === 'done' ? 6 : 2, total: 100 })),
    conversion: {
      sent: { count: 4, total: 4000 },
      accepted: { count: 2, total: 2500 },
      declined: { count: 1, total: 500 },
      acceptance_rate: 0.667,
    },
    stage_days: COLUMNS.filter((c) => c !== 'done').map((column) => ({
      column,
      median_days: column === 'print' ? 1.5 : null,
      sample: column === 'print' ? 3 : 0,
    })),
    invoicing: { invoiced_total: 1800, invoiced_count: 1, outstanding_balance: 300, outstanding_count: 1 },
    tracking: { views: 0, cards_viewed: 0, cards_with_link: 0 },
    throughput: {
      created: 3,
      accepted: 2,
      done: 1,
      per_day: 0.1,
      lead_days: 4.75,
      lead_days_median: 4.5,
      production_days: 2.04,
      active: 12,
    },
    previous: { created: 2, accepted: 2, declined: 1, done: 0, lead_days: 6 },
    daily: [
      { day: '2026-09-01', created: 1, accepted: 0, declined: 0, done: 0 },
      { day: '2026-09-02', created: 2, accepted: 2, declined: 1, done: 1 },
      { day: '2026-09-03', created: 0, accepted: 0, declined: 0, done: 0 },
    ],
    date_from: '2026-09-01',
    date_to: '2026-09-03',
    ...overrides,
  };
}

function serve(body: AitoStats) {
  server.use(http.get('/api/v1/aito/stats', () => HttpResponse.json(body)));
}

const view = () => <StatsView range={{}} timeframe={{ preset: 'last-30', dateFrom: undefined, dateTo: undefined }} onTimeframeChange={vi.fn()} />;

describe('StatsView', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    chartCapture.composedDataSets = [];
  });

  it('opens on the Overview: its finding, the activity chart, the figures with deltas', async () => {
    serve(fixture());
    render(view());
    expect(await screen.findByTestId('aito-stats-view')).toBeInTheDocument();

    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('aito-stats-finding')).toHaveTextContent(
      '3 projects came in, 2 were accepted and 1 was delivered.',
    );

    const band = await screen.findByTestId('aito-stats-band');
    // Each figure is a card: the label sits in its own row above the value.
    const figure = (label: RegExp) => within(band).getByText(label).closest('div.rounded-lg')!;
    expect(figure(/^Added/)).toHaveTextContent('3');
    expect(figure(/^Added/)).toHaveTextContent('▲ 50%');
    expect(figure(/^Accepted · 67% accepted$/)).toHaveTextContent('2');
    expect(figure(/^Accepted · 67% accepted$/)).toHaveTextContent('—'); // flat against 2
    expect(figure(/^Completed$/)).toHaveTextContent('1'); // previous 0 → no badge
    expect(within(figure(/^Completed$/)).queryByText(/%/)).toBeNull();
    expect(figure(/^Quote to delivery/)).toHaveTextContent('4.8 d');
    expect(figure(/^Quote to delivery/)).toHaveTextContent('▼ 21%');
    expect(figure(/^Accepted quotes$/)).toHaveTextContent('2 500');
  });

  it('draws one bar per series, the legend names them, and the range is spelled out', async () => {
    serve(fixture());
    render(view());
    const activity = await screen.findByTestId('aito-stats-activity');
    expect(within(activity).getByText('Activity per day')).toBeInTheDocument();
    expect(within(activity).getByText('7-day average of completed')).toBeInTheDocument();
    expect(activity.querySelectorAll('.recharts-bar').length).toBe(3);
    expect(activity.querySelectorAll('.recharts-line').length).toBe(1);
    expect(screen.getByText('September 1 – September 3')).toBeInTheDocument();
  });

  it('folds days into weeks past 45 days and the finding names the busiest week', async () => {
    const daily = Array.from({ length: 70 }, (_, i) => {
      const d = new Date(2026, 6, 1 + i); // 2026-07-01 is a Wednesday
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      // Days 1, 3, 4 (Jul 2, 4, 5) fall in the Monday-start week of 29 June;
      // days 5, 8, 10 (Jul 6, 9, 11) fall in the very next week, starting
      // Jul 6 (a Monday). A naive "chunk every 7 array elements from the
      // start" grouping would instead lump index 5 in with indices 0-6 and
      // split indices 8/10 into a separate chunk from index 5 -- only real
      // calendar weeks put 1/3/4 together and 5/8/10 together. Each week
      // also gives created/accepted/done different, non-zero sums so that
      // swapping which series a day's count lands in (e.g. folding `created`
      // into `accepted`) changes the asserted numbers, not just the total.
      if (i === 1) return { day: key, created: 3, accepted: 0, declined: 0, done: 0 };
      if (i === 3) return { day: key, created: 0, accepted: 2, declined: 0, done: 0 };
      if (i === 4) return { day: key, created: 0, accepted: 0, declined: 0, done: 4 };
      if (i === 5) return { day: key, created: 8, accepted: 0, declined: 0, done: 0 };
      if (i === 8) return { day: key, created: 0, accepted: 7, declined: 0, done: 0 };
      if (i === 10) return { day: key, created: 0, accepted: 0, declined: 0, done: 2 };
      return { day: key, created: 0, accepted: 0, declined: 0, done: 0 };
    });
    serve(fixture({ daily }));
    render(view());
    const activity = await screen.findByTestId('aito-stats-activity');
    expect(within(activity).getByText('Activity per week')).toBeInTheDocument();
    expect(within(activity).queryByText('7-day average of completed')).toBeNull();
    expect(activity.querySelectorAll('.recharts-line').length).toBe(0);
    // 2026-07-11 falls in the Monday-start week of 6 July (en-US formatting);
    // that week's total (8 + 7 + 2 = 17) beats the week of 29 June's
    // (3 + 2 + 4 = 9), so it is still the busiest week reported.
    expect(screen.getByTestId('aito-stats-finding')).toHaveTextContent('The busiest week was the week of July 6.');

    // Exactly one ComposedChart rendered (ActivityChart is the only user of
    // it) -- asserted before indexing so a future second chart fails this
    // assertion loudly instead of silently pointing the rows below at the
    // wrong chart's data.
    expect(chartCapture.composedDataSets).toHaveLength(1);
    const rows = chartCapture.composedDataSets[0] as { day: string; label: string; created: number; accepted: number; done: number }[];
    const weekOfJune29 = rows.find((r) => r.label === 'Jun 29');
    const weekOfJuly6 = rows.find((r) => r.label === 'Jul 6');
    expect(weekOfJune29).toEqual({ day: '2026-06-29', label: 'Jun 29', created: 3, accepted: 2, done: 4 });
    expect(weekOfJuly6).toEqual({ day: '2026-07-06', label: 'Jul 6', created: 8, accepted: 7, done: 2 });
    // Every other week is untouched -- confirms the six seeded days landed in
    // only their own two buckets rather than being smeared across weeks.
    const otherWeeks = rows.filter((r) => r !== weekOfJune29 && r !== weekOfJuly6);
    expect(otherWeeks.every((r) => r.created === 0 && r.accepted === 0 && r.done === 0)).toBe(true);
  });

  it('switches screens through the tabs and remembers the choice for the session', async () => {
    const user = userEvent.setup();
    serve(fixture());
    const { unmount } = render(view());
    await screen.findByTestId('aito-stats-band');

    await user.click(screen.getByRole('tab', { name: 'Money' }));
    expect(screen.getByRole('tab', { name: 'Money' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('aito-stats-band')).toBeNull();
    expect(screen.getByTestId('aito-stats-money')).toBeInTheDocument();

    // Arrow keys move and select, wrapping at the ends; Home/End jump to the first/last tab.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Clients' })).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Clients' }));
    expect(await screen.findByTestId('aito-stats-arrivals')).toBeInTheDocument();

    // Clients is the last tab, so ArrowLeft steps back to Money (no wrap needed here).
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Money' })).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Money' }));
    expect(await screen.findByTestId('aito-stats-money')).toBeInTheDocument();

    // Home returns to the first screen regardless of the current tab.
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Overview' }));
    expect(await screen.findByTestId('aito-stats-band')).toBeInTheDocument();

    // End jumps to the last screen, back to Clients.
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Clients' })).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Clients' }));
    expect(await screen.findByTestId('aito-stats-arrivals')).toBeInTheDocument();

    unmount();
    render(view());
    // sessionStorage kept the last screen, so the view comes back on Clients.
    expect(await screen.findByTestId('aito-stats-arrivals')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Clients' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the empty line instead of a blank chart when nothing happened', async () => {
    serve(
      fixture({
        daily: [{ day: '2026-09-01', created: 0, accepted: 0, declined: 0, done: 0 }],
        throughput: { created: 0, accepted: 0, done: 0, per_day: 0, lead_days: null, lead_days_median: null, production_days: null, active: 0 },
        conversion: {
          sent: { count: 0, total: 0 },
          accepted: { count: 0, total: 0 },
          declined: { count: 0, total: 0 },
          acceptance_rate: null,
        },
      }),
    );
    render(view());
    const activity = await screen.findByTestId('aito-stats-activity');
    expect(within(activity).getByText('Nothing happened in this period')).toBeInTheDocument();
    expect(screen.getByTestId('aito-stats-finding')).toHaveTextContent('0 projects came in');

    // No card completed this period (lead_days: null), even though the previous
    // period's lead_days (6) would otherwise diff against it: no badge, no
    // fabricated "-100%" improvement.
    const band = await screen.findByTestId('aito-stats-band');
    const leadTile = within(band).getByText(/^Quote to delivery/).closest('div.rounded-lg')!;
    expect(leadTile).toHaveTextContent('—');
    expect(within(leadTile).queryByText(/%/)).toBeNull();
  });

  it('degrades to the empty line on a backend that predates the throughput block', async () => {
    const { throughput: _t, previous: _p, daily: _d, ...older } = fixture();
    serve(older as AitoStats);
    render(view());
    expect(await screen.findByText('Nothing happened in this period')).toBeInTheDocument();
  });

  it('shows the generic error state with a retry on a 500', async () => {
    server.use(http.get('/api/v1/aito/stats', () => HttpResponse.json({ detail: 'nope' }, { status: 500 })));
    render(view());
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByText('Error loading data')).toBeInTheDocument();
  });

  it('shows the generic error state with a retry on a network failure', async () => {
    server.use(http.get('/api/v1/aito/stats', () => HttpResponse.error()));
    render(view());
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByText('Error loading data')).toBeInTheDocument();
  });

  it('names the rejected range on a 422 and offers no retry, since one would only resend it', async () => {
    server.use(
      http.get('/api/v1/aito/stats', () =>
        HttpResponse.json({ detail: 'date_from/date_to must not span more than 1827 days' }, { status: 422 }),
      ),
    );
    render(view());
    expect(await screen.findByText('date_from/date_to must not span more than 1827 days')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByText('Error loading data')).toBeNull();
  });

  it('holds the previous numbers, dimmed, while a new range loads instead of showing a spinner', async () => {
    server.use(
      http.get('/api/v1/aito/stats', async ({ request }) => {
        const from = new URL(request.url).searchParams.get('date_from');
        if (from === '2026-08-01') {
          await delay(150);
          return HttpResponse.json(fixture({ throughput: { ...fixture().throughput!, created: 9 } }));
        }
        return HttpResponse.json(fixture());
      }),
    );
    const tf = { preset: 'custom', dateFrom: '2026-09-01', dateTo: '2026-09-10' } as const;
    const { rerender } = render(
      <StatsView range={{ dateFrom: '2026-09-01', dateTo: '2026-09-10' }} timeframe={tf} onTimeframeChange={vi.fn()} />,
    );
    await screen.findByTestId('aito-stats-band');
    // Re-queried each time: the hold keeps the node, the assertions must not
    // hold a stale reference to it.
    const added = () => within(screen.getByTestId('aito-stats-band')).getByText(/^Added/).closest('div.rounded-lg')!;
    expect(added()).toHaveTextContent('3');

    rerender(
      <StatsView range={{ dateFrom: '2026-08-01', dateTo: '2026-09-10' }} timeframe={tf} onTimeframeChange={vi.fn()} />,
    );
    // Still the old numbers, dimmed and marked busy — no spinner, no unmount.
    const body = screen.getByTestId('aito-stats-body');
    expect(body).toHaveAttribute('aria-busy', 'true');
    expect(body).toHaveClass('opacity-60');
    expect(added()).toHaveTextContent('3');
    expect(document.querySelector('.animate-spin')).toBeNull();

    await waitFor(() => expect(screen.getByTestId('aito-stats-body')).not.toHaveAttribute('aria-busy'));
    expect(screen.getByTestId('aito-stats-body')).toHaveClass('opacity-100');
    expect(added()).toHaveTextContent('9');
  });

  it('renders the strip above the period, and the timeframe selector beside the tabs', async () => {
    serve(fixture());
    render(view());
    expect(await screen.findByTestId('aito-stats-strip')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Last 30 Days/ })).toBeInTheDocument();
  });

  it('hangs the timeframe menu from the trigger’s left edge, where there is room for it', async () => {
    const user = userEvent.setup();
    serve(fixture());
    render(view());
    await screen.findByTestId('aito-stats-band');
    await user.click(screen.getByRole('button', { name: /Last 30 Days/ }));
    // This trigger leads its row: a right-hung menu opens leftwards off the
    // content and under the sidebar.
    const menu = document.querySelector('.aito-tf-menu')!;
    expect(menu).not.toHaveAttribute('hidden');
    expect(menu).toHaveAttribute('data-align', 'start');
    expect(menu).toHaveClass('left-0');
    expect(menu).not.toHaveClass('right-0');
  });
});
