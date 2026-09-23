import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { TodayStrip, type BriefInput } from '../../components/aito/stats/TodayStrip';
import { followups } from '../../utils/aitoFollowups';
import type { AitoProject } from '../../api/client';

const TODAY = '2026-09-19';
const NOW = new Date('2026-09-19T08:00:00Z').getTime();

function project(overrides: Partial<AitoProject> & { id: number }): AitoProject {
  return {
    description: 'Job', column: 'print', position: 0, status: 'active',
    client_id: 'z1', client_name: 'ACME', client_phone: '+689 87 00 00 01', client_email: null, client_is_company: null,
    client_social_network: null, client_social_handle: null, client_contact_person_id: null, client_contact_name: null,
    quote_id: null, quote_number: null, quote_date: null, quote_total: 1000, quote_url: null, quote_salesperson: null,
    quote_status: 'accepted', quote_accepted_at: '2026-08-01T10:00:00', quote_sent_at: '2026-07-30T10:00:00',
    invoice_status: null, invoice_balance: null, invoice_due_date: null, invoice_checked_at: null,
    quote_sync_state: 'idle', quote_invoiced: false, flag: null, client_contacted_at: '2026-08-01T10:00:00', due_date: null,
    quote_sync_error: null, quote_status_block: null, quote_status_remote: null, created_by: null,
    task_count: 0, tasks_total: 0, task_services: [], task_pending: [], steps_total: 0, steps_done: 0, print_minutes_pending: 0, task_steps: [],
    move_lock: null, shipping_island: null, shipping_service: null, shipping_first_name: null, shipping_last_name: null,
    shipping_phone: null, shipping_price: null, shipping_lta: null, shipping_service_name: null, tracking_configured: false,
    quote_expiry_date: null, retainer_paid_total: null, customer_credit_total: null, payment_link: null, version: 1,
    created_at: '2026-07-30T10:00:00', updated_at: '2026-07-30T10:00:00',
    ...overrides,
  } as AitoProject;
}

function brief(projects: AitoProject[], onOpenCard = vi.fn()): BriefInput {
  return {
    projects,
    buckets: followups(projects, { quoteDays: 5, pickupDays: 7, linkDays: 3 }, NOW, TODAY),
    now: NOW,
    today: TODAY,
    onOpenCard,
  };
}

describe('TodayStrip', () => {
  const quoteOut = project({ id: 1, client_name: 'Tehei Neuffer', description: 'Engrenage machine à laver\nsecond line', column: 'waiting', quote_status: 'sent', quote_sent_at: '2026-08-01T10:00:00', quote_total: 4200 });
  const quoteOut2 = project({ id: 2, client_name: 'Ludovic Hery', column: 'waiting', quote_status: 'sent', quote_sent_at: '2026-08-10T10:00:00', quote_total: 21000 });
  const notCollected = project({ id: 3, client_name: 'Manava', column: 'finish', client_contacted_at: '2026-07-30T10:00:00', quote_total: 6000 });
  const unpaid = project({ id: 4, client_name: 'SNP', invoice_balance: 21000, invoice_due_date: '2026-08-18', quote_invoiced: true });
  const unpaid2 = project({ id: 5, client_name: 'Ex Musik', invoice_balance: 33600, invoice_due_date: '2026-09-11', quote_invoiced: true });
  const dueSoon = project({ id: 6, client_name: 'Due', due_date: '2026-09-22' });
  const all = [quoteOut, quoteOut2, notCollected, unpaid, unpaid2, dueSoon];

  it('counts the cards, the money and the oldest wait in each stage', () => {
    render(<TodayStrip brief={brief(all)} />);
    // Waiting holds the two quotes out: 4 200 + 21 000, oldest sent 2026-07-30
    // (both cards are anchored on created_at, 50 days before NOW).
    const waiting = screen.getByTestId('aito-strip-waiting');
    expect(within(waiting).getByText('2')).toBeInTheDocument();
    expect(waiting).toHaveTextContent(/25\s?200/);
    expect(waiting).toHaveTextContent('oldest 50 d');
    // Printing holds the three accepted cards, aged from the acceptance
    // (2026-08-01T10:00 → 48 whole days before NOW, not the 50 of creation).
    const print = screen.getByTestId('aito-strip-print');
    expect(within(print).getByText('3')).toBeInTheDocument();
    expect(print).toHaveTextContent('oldest 48 d');
    // An empty stage shows a muted zero and no age.
    const scan = screen.getByTestId('aito-strip-scan');
    expect(within(scan).getByText('0')).toHaveClass('text-bambu-gray');
    expect(scan).not.toHaveTextContent('oldest');
    // Done is never a stage in the strip.
    expect(screen.queryByTestId('aito-strip-done')).toBeNull();
  });

  it('names the board’s single longest wait and paints only that stage amber', () => {
    render(<TodayStrip brief={brief(all)} />);
    const longest = screen.getByTestId('aito-strip-longest');
    expect(longest).toHaveTextContent('Tehei Neuffer, 50 d');
    expect(longest).toHaveTextContent('Waiting');
    // Exactly one stage cell carries the amber age.
    const amber = screen
      .getAllByTestId(/^aito-strip-(devis|waiting|scan|model|print|finish)$/)
      .filter((cell) => cell.querySelector('.text-amber-400') !== null);
    expect(amber).toHaveLength(1);
    expect(screen.getByTestId('aito-strip-waiting').querySelector('.text-amber-400')).not.toBeNull();
  });

  it('splits the money bar by stage and totals the board', () => {
    render(<TodayStrip brief={brief(all)} />);
    const bar = screen.getByTestId('aito-strip-money');
    // Waiting, Finish and Printing hold money; the three empty stages draw nothing.
    expect(bar.querySelectorAll('[data-segment]')).toHaveLength(3);
    expect(bar.querySelector('[data-segment="waiting"]')).toHaveAttribute('title', expect.stringContaining('Waiting'));
    expect(screen.getByTestId('aito-stats-strip')).toHaveTextContent(/34\s?200.*on the board/);
  });

  it('hangs each list under its stage, longest wait first, and a row opens its card', async () => {
    const onOpenCard = vi.fn();
    render(<TodayStrip brief={brief(all, onOpenCard)} />);

    const chase = screen.getByTestId('aito-brief-chase');
    expect(chase).toHaveClass('lg:col-start-2'); // under Waiting
    const rows = within(chase).getAllByRole('button');
    expect(rows[0]).toHaveTextContent('Tehei Neuffer');
    expect(rows[0]).toHaveTextContent('48 d');
    expect(rows[0]).toHaveTextContent('Engrenage machine à laver');
    expect(rows[0]).not.toHaveTextContent('second line');
    expect(rows[1]).toHaveTextContent('Ludovic Hery');

    const tell = screen.getByTestId('aito-brief-tell');
    expect(tell).toHaveClass('lg:col-start-6'); // under Finish
    expect(within(tell).getByRole('button')).toHaveTextContent('Ready for pickup');

    const collect = screen.getByTestId('aito-brief-collect');
    expect(collect).toHaveClass('lg:col-start-5'); // under Printing
    const late = within(collect).getAllByRole('button');
    expect(late[0]).toHaveTextContent('SNP');
    expect(late[0]).toHaveTextContent('32 d late');
    expect(late[1]).toHaveTextContent('8 d late');
    // The heading counts: a count for chase and tell, the amount for collect.
    expect(collect).toHaveTextContent(/54\s?600/);

    await userEvent.setup().click(rows[0]);
    expect(onOpenCard).toHaveBeenCalledWith(1);
  });

  it('says what is waiting in the day line, with the deliveries due this week', () => {
    render(<TodayStrip brief={brief(all)} />);
    const strip = screen.getByTestId('aito-stats-strip');
    expect(strip).toHaveTextContent('2 quotes to chase');
    expect(strip).toHaveTextContent('1 client to tell');
    expect(strip).toHaveTextContent(/54\s?600.*to collect/);
    expect(strip).toHaveTextContent('1 delivery due this week');
    expect(strip).toHaveTextContent('6 projects in production');
  });

  it('collapses to one line on a clear day, and the strip keeps its cells', () => {
    render(<TodayStrip brief={brief([project({ id: 9 })])} />);
    expect(screen.getByTestId('aito-stats-clear')).toHaveTextContent('Nothing to chase, no one to tell, nothing to collect.');
    expect(screen.queryByTestId('aito-brief-chase')).toBeNull();
    expect(screen.getByTestId('aito-strip-print')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^aito-strip-(devis|waiting|scan|model|print|finish)$/)).toHaveLength(6);
  });

  it('caps a list at five rows and says how many more', async () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      project({ id: 10 + i, client_name: `Client ${i}`, column: 'waiting', quote_status: 'sent', quote_sent_at: `2026-08-0${1 + i}T10:00:00` }),
    );
    render(<TodayStrip brief={brief(many)} />);
    const chase = screen.getByTestId('aito-brief-chase');
    expect(within(chase).getAllByRole('button')).toHaveLength(5);
    expect(chase).toHaveTextContent('and 2 more');
  });

  it('renders an empty strip before the board has loaded', () => {
    render(<TodayStrip brief={null} />);
    expect(screen.getByTestId('aito-stats-strip')).toBeInTheDocument();
    expect(screen.getByTestId('aito-stats-clear')).toBeInTheDocument();
    expect(screen.getByTestId('aito-strip-money').querySelectorAll('[data-segment]')).toHaveLength(0);
  });
});
