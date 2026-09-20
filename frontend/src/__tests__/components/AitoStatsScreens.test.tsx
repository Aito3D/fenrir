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
    stage_days: COLUMNS.filter((c) => c !== 'done').map((column) => ({
      column,
      median_days: column === 'scan' ? 8.9 : column === 'devis' ? 3.7 : null,
      sample: column === 'scan' || column === 'devis' ? 2 : 0,
    })),
    invoicing: { invoiced_total: 1800, invoiced_count: 1, outstanding_balance: 300, outstanding_count: 1 },
    tracking: { views: 0, cards_viewed: 0, cards_with_link: 0 },
    throughput: { created: 3, accepted: 2, done: 1, per_day: 0.1, lead_days: 4.75, lead_days_median: 4.5, production_days: 2.04, active: 12 },
    previous: { created: 2, accepted: 1, declined: 3, done: 0, lead_days: null },
    daily: [
      { day: '2026-09-01', created: 0, accepted: 0, declined: 1, done: 0 },
      { day: '2026-09-02', created: 2, accepted: 2, declined: 0, done: 1 },
    ],
    quote_age: [
      { bucket: '0-3', count: 2, total: 1200 },
      { bucket: '4-7', count: 0, total: 0 },
      { bucket: '8-14', count: 1, total: 800 },
      { bucket: '15+', count: 1, total: 5000 },
    ],
    size_bands: [
      { min: 1000, max: 2000, accepted: 1, declined: 0, rate: 1 },
      { min: 3000, max: 8000, accepted: 1, declined: 1, rate: 0.5 },
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

const view = () => <StatsView range={{}} timeframe={{ preset: 'last-30', dateFrom: undefined, dateTo: undefined }} onTimeframeChange={vi.fn()} />;

/** Open one period screen and wait for it. */
async function open(screenName: 'Sales' | 'Time' | 'Money' | 'Clients', body = fixture()) {
  const user = userEvent.setup();
  serve(body);
  render(view());
  await screen.findByTestId('aito-stats-band');
  await user.click(screen.getByRole('tab', { name: screenName }));
  return user;
}

describe('StatsView period screens', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('Sales: the finding names the big lost tickets, the facts and the win-rate bars back it', async () => {
    await open('Sales');
    // 1 of the 2 decisions in the top band was declined, and that is the most
    // declines of any band, so the finding calls out the big tickets.
    expect(screen.getByTestId('aito-stats-finding')).toHaveTextContent('You win 67 % of quotes.');
    expect(screen.getByTestId('aito-stats-finding')).toHaveTextContent(/The ones you lose are the big ones: 1 of the 2 above/);

    const funnel = screen.getByTestId('aito-stats-funnel');
    expect(within(funnel).getByText('Sent').parentElement).toHaveTextContent('4');
    expect(within(funnel).getByText('Completed').parentElement).toHaveTextContent('50% of accepted');
    const waiting = screen.getByTestId('aito-stats-quote-age');
    expect(waiting).toHaveTextContent('Waiting 15+ days');
    expect(waiting).toHaveTextContent('1');
    expect(waiting.querySelector('.text-amber-400')).not.toBeNull();

    const win = within(screen.getByTestId('aito-stats-win-rate')).getAllByRole('listitem');
    expect(win).toHaveLength(2);
    expect(win[0]).toHaveTextContent('100%');
    expect(win[0].querySelectorAll('[data-segment="declined"]')).toHaveLength(0);
    expect(win[1]).toHaveTextContent('50%');
    expect(win[1].querySelectorAll('[data-segment]')).toHaveLength(2);
    expect(screen.getByTestId('aito-stats-decisions').querySelectorAll('.recharts-bar').length).toBe(2);
  });

  it('Sales: says so plainly when nothing was decided', async () => {
    await open(
      'Sales',
      fixture({
        conversion: { sent: { count: 0, total: 0 }, accepted: { count: 0, total: 0 }, declined: { count: 0, total: 0 }, acceptance_rate: null },
        size_bands: [],
      }),
    );
    expect(screen.getByTestId('aito-stats-finding')).toHaveTextContent('No quotes were decided in this period.');
    expect(screen.getByTestId('aito-stats-win-rate')).toHaveTextContent('Not enough decided quotes yet');
  });

  it('Time: the finding names the slow stage and the rework, the bars are longest first', async () => {
    await open('Time');
    const finding = screen.getByTestId('aito-stats-finding');
    expect(finding).toHaveTextContent('A project takes 4.8 d from quote to delivery.');
    expect(finding).toHaveTextContent('Scan is the slow stage at 8.9 d.');
    expect(finding).toHaveTextContent('2 moves went backwards on 1 card.');

    // The block's own legend is a list too, so read the bar rows by their id.
    const rows = within(screen.getByTestId('aito-stats-stage-rows')).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('ACME');
    expect(rows[0]).toHaveTextContent('5.0 d');
    expect(rows[1]).toHaveTextContent('Quick');
    expect(rows[1]).toHaveTextContent('1.0 d');
    // The journey bar keeps only the stages with a median.
    expect(screen.getByTestId('aito-stats-flow')).toHaveTextContent('8.9 Scan');
    expect(screen.getByTestId('aito-stats-rework')).toHaveTextContent('1 cards · 50% of cards that moved');
  });

  it('Money: the finding adds up what is out and how late, the mix and the overdue bars follow', async () => {
    await open('Money');
    const finding = screen.getByTestId('aito-stats-finding');
    expect(finding).toHaveTextContent(/2 500.*accepted and.*1 800.*invoiced\./);
    expect(finding).toHaveTextContent(/300.*is still out on 1 invoice\./);
    expect(finding).toHaveTextContent('2 of them are overdue, the oldest by 45 days.');

    const mix = within(screen.getByTestId('aito-stats-service-mix')).getAllByRole('listitem');
    expect(mix).toHaveLength(2); // zero-task services are not listed
    expect(mix[0]).toHaveTextContent('Printing'); // biggest earner first
    expect(mix[0]).toHaveTextContent('70%');
    expect(mix[1]).toHaveTextContent('Scan');

    const overdue = screen.getByTestId('aito-stats-overdue');
    expect(overdue).toHaveTextContent('As of today · oldest 45 d');
    expect(within(overdue).getAllByRole('listitem')[2]).toHaveTextContent('31+ days');
    expect(screen.getByTestId('aito-stats-money')).toHaveTextContent('Shipping billed');
  });

  it('Money: says nothing is outstanding when every invoice is paid', async () => {
    await open(
      'Money',
      fixture({
        invoicing: { invoiced_total: 1800, invoiced_count: 1, outstanding_balance: 0, outstanding_count: 0 },
        overdue: { buckets: [{ bucket: '1-7', count: 0, balance: 0 }, { bucket: '8-30', count: 0, balance: 0 }, { bucket: '31+', count: 0, balance: 0 }], oldest_days: null },
      }),
    );
    expect(screen.getByTestId('aito-stats-finding')).toHaveTextContent('Nothing is outstanding.');
    expect(screen.getByTestId('aito-stats-overdue')).toHaveTextContent('Nothing overdue');
  });

  it('Clients: the finding names the peak hour and the parcels, the grid and islands follow', async () => {
    await open('Clients');
    const finding = screen.getByTestId('aito-stats-finding');
    expect(finding).toHaveTextContent('1 new client and 1 returning.');
    expect(finding).toHaveTextContent('Requests land on Tuesday around 9:00.');
    expect(finding).toHaveTextContent('2 parcels went to the islands.');

    const arrivals = screen.getByTestId('aito-stats-arrivals');
    expect(arrivals.querySelectorAll('.bg-bambu-green').length).toBe(1);
    expect(arrivals.querySelectorAll('[title$="· 3"]').length).toBe(1);
    expect(screen.getByTestId('aito-stats-clients')).toHaveTextContent('75% of revenue from returning clients');
    const islands = within(screen.getByTestId('aito-stats-islands')).getAllByRole('listitem');
    expect(islands[0]).toHaveTextContent('moorea');
    expect(islands[1]).toHaveTextContent('Pickup');
  });

  it('degrades block by block on a backend that predates these blocks', async () => {
    const { quote_age: _q, size_bands: _s, stage_time: _t, services: _sv, islands: _i, arrivals: _a, ...older } = fixture();
    const user = await open('Sales', older as AitoStats);
    expect(screen.getByTestId('aito-stats-win-rate')).toHaveTextContent('Not enough decided quotes yet');
    expect(screen.getByTestId('aito-stats-quote-age')).toHaveTextContent('0');

    await user.click(screen.getByRole('tab', { name: 'Time' }));
    expect(within(screen.getByTestId('aito-stats-stage-time')).getByText('Nothing happened in this period')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Money' }));
    expect(screen.getByTestId('aito-stats-service-mix')).toHaveTextContent('Nothing happened in this period');

    await user.click(screen.getByRole('tab', { name: 'Clients' }));
    expect(within(screen.getByTestId('aito-stats-arrivals')).getByText('Nothing happened in this period')).toBeInTheDocument();
    // Blocks that still have data keep rendering.
    expect(screen.getByTestId('aito-stats-clients')).toHaveTextContent('Returning clients');
  });
});
