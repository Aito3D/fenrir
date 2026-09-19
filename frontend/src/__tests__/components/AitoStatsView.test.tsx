import type { ComponentProps } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, delay } from 'msw';
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

    const band = await screen.findByTestId('aito-stats-band');
    const figure = (label: RegExp) => within(band).getByText(label).parentElement!;
    expect(figure(/^Added$/)).toHaveTextContent('3');
    expect(figure(/^Added$/)).toHaveTextContent('▲ 50%');
    expect(figure(/^Accepted · 67% accepted$/)).toHaveTextContent('2');
    expect(figure(/^Accepted · 67% accepted$/)).toHaveTextContent('—'); // flat against 2
    expect(figure(/^Completed$/)).toHaveTextContent('1'); // previous 0 → no badge
    expect(within(figure(/^Completed$/)).queryByText(/%/)).toBeNull();
    expect(figure(/^Quote to delivery$/)).toHaveTextContent('4.8 d');
    expect(figure(/^Quote to delivery$/)).toHaveTextContent('▼ 21%');
    expect(figure(/^Accepted quotes$/)).toHaveTextContent('2 500');
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
    const { rerender } = render(<StatsView range={{ dateFrom: '2026-09-01', dateTo: '2026-09-10' }} />);
    const band = await screen.findByTestId('aito-stats-band');
    expect(within(band).getByText(/^Added$/).parentElement).toHaveTextContent('3');

    rerender(<StatsView range={{ dateFrom: '2026-08-01', dateTo: '2026-09-10' }} />);
    // Still the old numbers, dimmed and marked busy — no spinner, no unmount.
    const body = screen.getByTestId('aito-stats-body');
    expect(body).toHaveAttribute('aria-busy', 'true');
    expect(body).toHaveClass('opacity-60');
    expect(within(band).getByText(/^Added$/).parentElement).toHaveTextContent('3');
    expect(document.querySelector('.animate-spin')).toBeNull();

    await waitFor(() => expect(screen.getByTestId('aito-stats-body')).not.toHaveAttribute('aria-busy'));
    expect(screen.getByTestId('aito-stats-body')).toHaveClass('opacity-100');
    expect(within(screen.getByTestId('aito-stats-band')).getByText(/^Added$/).parentElement).toHaveTextContent('9');
  });
});
