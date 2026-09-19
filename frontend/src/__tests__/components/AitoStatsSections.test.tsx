import type { ComponentProps } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { StatsView } from '../../components/aito/StatsView';
import type { AitoStats } from '../../api/client';

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
  const arrivals = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  arrivals[1][9] = 3;
  arrivals[4][15] = 1;
  return {
    board: COLUMNS.map((column) => ({ column, count: column === 'done' ? 6 : 2, total: 100 })),
    conversion: {
      sent: { count: 4, total: 4000 },
      accepted: { count: 2, total: 2500 },
      declined: { count: 1, total: 500 },
      acceptance_rate: 0.667,
    },
    stage_days: COLUMNS.filter((c) => c !== 'done').map((column) => ({ column, median_days: null, sample: 0 })),
    invoicing: { invoiced_total: 1800, invoiced_count: 1, outstanding_balance: 300, outstanding_count: 1 },
    tracking: { views: 0, cards_viewed: 0, cards_with_link: 0 },
    throughput: { created: 3, accepted: 2, done: 1, per_day: 0.1, lead_days: 4.75, lead_days_median: 4.5, production_days: 2.04, active: 12 },
    previous: null,
    daily: [{ day: '2026-09-02', created: 2, accepted: 2, done: 1 }],
    quote_age: [
      { bucket: '0-3', count: 2, total: 1200 },
      { bucket: '4-7', count: 0, total: 0 },
      { bucket: '8-14', count: 1, total: 800 },
      { bucket: '15+', count: 1, total: 5000 },
    ],
    size_bands: [
      { min: 1000, max: 2000, accepted: 1, declined: 1, rate: 0.5 },
      { min: 3000, max: 8000, accepted: 2, declined: 0, rate: 1 },
    ],
    overdue: {
      buckets: [
        { bucket: '1-7', count: 1, balance: 100 },
        { bucket: '8-30', count: 0, balance: 0 },
        { bucket: '31+', count: 1, balance: 250 },
      ],
      oldest_days: 45,
    },
    stage_time: [
      { project_id: 7, client_name: 'ACME', description: 'Long one', done_at: '2026-09-06T10:00:00', stages: { devis: 2, waiting: 0, scan: 0, model: 0, print: 3, finish: 0 } },
      { project_id: 8, client_name: null, description: 'Quick', done_at: '2026-09-07T10:00:00', stages: { devis: 1, waiting: 0, scan: 0, model: 0, print: 0, finish: 0 } },
    ],
    rework: { moves: 2, cards: 1, share: 0.5 },
    services: [
      { service: 'scan', tasks: 1, revenue: 900 },
      { service: 'modelisation', tasks: 0, revenue: 0 },
      { service: 'impression', tasks: 2, revenue: 2100 },
      { service: 'usinage', tasks: 0, revenue: 0 },
    ],
    clients: { new: 1, returning: 1, new_total: 50, returning_total: 150 },
    arrivals,
    islands: [
      { island: 'moorea', count: 2, shipping_total: 3000 },
      { island: null, count: 1, shipping_total: 0 },
    ],
    date_from: '2026-09-01',
    date_to: '2026-09-10',
    ...overrides,
  };
}

function serve(body: AitoStats) {
  server.use(http.get('/api/v1/aito/stats', () => HttpResponse.json(body)));
}

describe('StatsView sections', () => {
  beforeEach(() => {
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('renders the four sections under a jump strip that scrolls to them', async () => {
    serve(fixture());
    render(<StatsView />);
    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    const pills = within(nav).getAllByRole('button');
    expect(pills.map((b) => b.textContent)).toEqual(['Sales', 'Time', 'Money', 'Clients']);
    expect(pills[0]).toHaveAttribute('aria-current', 'true');
    for (const id of ['sales', 'time', 'money', 'clients']) {
      expect(screen.getByTestId(`aito-stats-section-${id}`)).toHaveAttribute('id', `aito-stats-${id}`);
    }
    await userEvent.setup().click(pills[2]);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(pills[2]).toHaveAttribute('aria-current', 'true');
    expect(pills[0]).not.toHaveAttribute('aria-current');
  });

  it('Sales: lost line, quote age tiles with the 15+ alert, win rate bars', async () => {
    serve(fixture());
    render(<StatsView />);
    const funnel = await screen.findByTestId('aito-stats-funnel');
    expect(funnel).toHaveTextContent('Lost: 1 ·');
    const age = screen.getByTestId('aito-stats-quote-age');
    expect(age).toHaveTextContent('As of today');
    expect(within(age).getByText('15+ days').parentElement).toHaveTextContent('1');
    expect(within(age).getByText('15+ days').nextElementSibling).toHaveClass('text-status-error');
    expect(within(age).getByText('4–7 days').nextElementSibling).not.toHaveClass('text-status-error');
    const win = screen.getByTestId('aito-stats-win-rate');
    expect(within(win).getAllByRole('listitem')).toHaveLength(2);
    expect(win).toHaveTextContent('50%');
    expect(win).toHaveTextContent('2 decided');
    expect(win).toHaveTextContent('100%');
  });

  it('Time: one stacked bar per completed card, longest first, and the rework tile', async () => {
    serve(fixture());
    render(<StatsView />);
    const st = await screen.findByTestId('aito-stats-stage-time');
    const rows = within(st).getAllByRole('listitem').filter((li) => li.textContent?.includes(' d'));
    expect(rows[0]).toHaveTextContent('ACME');
    expect(rows[0]).toHaveTextContent('5.0 d');
    expect(rows[1]).toHaveTextContent('Quick');
    expect(rows[1]).toHaveTextContent('1.0 d');
    const rework = screen.getByTestId('aito-stats-rework');
    expect(rework).toHaveTextContent('2');
    expect(rework).toHaveTextContent('1 cards · 50% of cards that moved');
  });

  it('Money: overdue buckets with oldest, and the service mix legend with shares', async () => {
    serve(fixture());
    render(<StatsView />);
    const od = await screen.findByTestId('aito-stats-overdue');
    expect(od).toHaveTextContent('As of today · oldest 45 d');
    expect(within(od).getByText('31+ days').parentElement).toHaveTextContent('1');
    const mix = screen.getByTestId('aito-stats-service-mix');
    expect(within(mix).getAllByRole('listitem')).toHaveLength(2); // zero-task services are not listed
    expect(mix).toHaveTextContent('Printing');
    expect(mix).toHaveTextContent('2 tasks');
    expect(mix).toHaveTextContent('70%');
    expect(mix).toHaveTextContent('30%');
  });

  it('Clients: new vs returning with revenue share, the arrivals grid, islands with pickup last', async () => {
    serve(fixture());
    render(<StatsView />);
    const clients = await screen.findByTestId('aito-stats-clients');
    expect(clients).toHaveTextContent('75% of revenue from returning clients');
    const arrivals = screen.getByTestId('aito-stats-arrivals');
    expect(arrivals.querySelectorAll('.bg-bambu-green').length).toBe(1);
    expect(arrivals.querySelectorAll('[title$="· 3"]').length).toBe(1);
    const islands = screen.getByTestId('aito-stats-islands');
    const rows = within(islands).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('moorea');
    expect(rows[0]).toHaveTextContent('2');
    expect(rows[1]).toHaveTextContent('Pickup');
  });

  it('says nothing is overdue when every bucket is empty, and degrades block by block on an older backend', async () => {
    const { quote_age: _q, size_bands: _s, stage_time: _t, ...older } = fixture({
      overdue: { buckets: [{ bucket: '1-7', count: 0, balance: 0 }, { bucket: '8-30', count: 0, balance: 0 }, { bucket: '31+', count: 0, balance: 0 }], oldest_days: null },
    });
    serve(older as AitoStats);
    render(<StatsView />);
    expect(await screen.findByText('Nothing overdue')).toBeInTheDocument();
    expect(within(screen.getByTestId('aito-stats-win-rate')).getByText('Not enough decided quotes yet')).toBeInTheDocument();
    expect(within(screen.getByTestId('aito-stats-quote-age')).getByText('Nothing happened in this period')).toBeInTheDocument();
    expect(within(screen.getByTestId('aito-stats-stage-time')).getByText('Nothing happened in this period')).toBeInTheDocument();
    // Blocks that still have data keep rendering.
    expect(screen.getByTestId('aito-stats-clients')).toHaveTextContent('Returning clients');
  });
});
