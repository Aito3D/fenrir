import type { ComponentProps } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { StatsView } from '../../components/aito/StatsView';
import type { AitoStats } from '../../api/client';

// jsdom has no layout, so Recharts' ResponsiveContainer measures 0×0 and
// renders nothing. Pin a width and let the real chart machinery run.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: (props: ComponentProps<typeof actual.ResponsiveContainer>) => (
      <actual.ResponsiveContainer {...props} width={600} />
    ),
  };
});

const COLUMNS = ['devis', 'waiting', 'scan', 'model', 'print', 'finish', 'done'] as const;

function fixture(overrides: Partial<AitoStats> = {}): AitoStats {
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
    previous: { created: 2, accepted: 2, done: 0, lead_days: 6 },
    daily: [
      { day: '2026-09-01', created: 1, accepted: 0, done: 0 },
      { day: '2026-09-02', created: 2, accepted: 2, done: 1 },
      { day: '2026-09-03', created: 0, accepted: 0, done: 0 },
    ],
    date_from: '2026-09-01',
    date_to: '2026-09-03',
    ...overrides,
  };
}

function serve(body: AitoStats) {
  server.use(http.get('/api/v1/aito/stats', () => HttpResponse.json(body)));
}

describe('StatsView', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the headline tiles with deltas against the previous period', async () => {
    serve(fixture());
    render(<StatsView range={{}} />);
    expect(await screen.findByTestId('aito-stats-view')).toBeInTheDocument();
    expect(await screen.findByText('12 in production · 6 completed overall')).toBeInTheDocument();

    const kpis = screen.getByTestId('aito-stats-kpis');
    const tile = (label: string) => within(kpis).getByText(label).closest('div')!.parentElement!;
    expect(tile('Added')).toHaveTextContent('3');
    expect(tile('Added')).toHaveTextContent('▲ 50%');
    expect(tile('Accepted')).toHaveTextContent('2');
    expect(tile('Accepted')).toHaveTextContent('—'); // flat against 2
    expect(tile('Completed')).toHaveTextContent('1'); // previous 0 → no badge
    expect(within(tile('Completed')).queryByText(/%/)).toBeNull();
    expect(tile('Added per day')).toHaveTextContent('0.10');
    expect(tile('Added per day')).toHaveTextContent('≈ 0.7 per week');
    expect(tile('Quote to delivery')).toHaveTextContent('4.8 d');
    expect(tile('Quote to delivery')).toHaveTextContent('median 4.5 d');
    expect(tile('Quote to delivery')).toHaveTextContent('▼ 21%');
    expect(tile('Acceptance to delivery')).toHaveTextContent('2.0 d');
  });

  it('renders the flow, the funnel and the money strip', async () => {
    serve(fixture());
    render(<StatsView range={{}} />);
    const flow = await screen.findByTestId('aito-stats-flow');
    expect(within(flow).getByText(/^Printing/).parentElement!.parentElement).toHaveTextContent('1.5 d');
    const funnel = screen.getByTestId('aito-stats-funnel');
    expect(funnel).toHaveTextContent('Sent4');
    expect(funnel).toHaveTextContent('50% of sent');
    expect(funnel).toHaveTextContent('50% of accepted');
    const money = screen.getByTestId('aito-stats-money');
    expect(money).toHaveTextContent('Accepted quotes');
    expect(money).toHaveTextContent('Invoiced');
    expect(money).toHaveTextContent('Outstanding');
  });

  it('draws one bar per series and the legend names them', async () => {
    serve(fixture());
    render(<StatsView range={{}} />);
    const activity = await screen.findByTestId('aito-stats-activity');
    expect(within(activity).getByText('Activity per day')).toBeInTheDocument();
    expect(within(activity).getByText('7-day average of completed')).toBeInTheDocument();
    expect(activity.querySelectorAll('.recharts-bar').length).toBe(3);
    expect(activity.querySelectorAll('.recharts-line').length).toBe(1);
  });

  it('folds days into weeks past 45 days: no rolling line, one bar group per week', async () => {
    const daily = Array.from({ length: 70 }, (_, i) => {
      const d = new Date(2026, 6, 1 + i); // 2026-07-01 is a Wednesday
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return { day: key, created: i % 7 === 0 ? 1 : 0, accepted: 0, done: i % 10 === 0 ? 1 : 0 };
    });
    serve(fixture({ daily }));
    render(<StatsView range={{}} />);
    const activity = await screen.findByTestId('aito-stats-activity');
    expect(within(activity).queryByText('7-day average of completed')).toBeNull();
    expect(activity.querySelectorAll('.recharts-line').length).toBe(0);
    expect(activity.querySelectorAll('.recharts-bar').length).toBe(3);
    // 70 days from a Wednesday span 11 Monday-start weeks: the x axis has at most that many categories.
    expect(activity.querySelectorAll('.recharts-xAxis .recharts-cartesian-axis-tick').length).toBeLessThanOrEqual(11);
  });

  it('shows the empty line instead of a blank chart when nothing happened, and hides the money strip at zero', async () => {
    serve(
      fixture({
        daily: [{ day: '2026-09-01', created: 0, accepted: 0, done: 0 }],
        conversion: {
          sent: { count: 0, total: 0 },
          accepted: { count: 0, total: 0 },
          declined: { count: 0, total: 0 },
          acceptance_rate: null,
        },
        invoicing: { invoiced_total: 0, invoiced_count: 0, outstanding_balance: 0, outstanding_count: 0 },
      }),
    );
    render(<StatsView range={{}} />);
    const activity = await screen.findByTestId('aito-stats-activity');
    expect(within(activity).getByText('Nothing happened in this period')).toBeInTheDocument();
    expect(screen.queryByTestId('aito-stats-money')).toBeNull();
  });

  it('degrades to the empty line on a backend that predates the throughput block', async () => {
    const { throughput: _t, previous: _p, daily: _d, ...older } = fixture();
    serve(older as AitoStats);
    render(<StatsView range={{}} />);
    expect(await screen.findByText('Nothing happened in this period')).toBeInTheDocument();
  });

  it('shows the error state with a retry', async () => {
    server.use(http.get('/api/v1/aito/stats', () => HttpResponse.json({ detail: 'nope' }, { status: 500 })));
    render(<StatsView range={{}} />);
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
