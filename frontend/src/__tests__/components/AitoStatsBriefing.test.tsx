import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { Briefing, type BriefInput } from '../../components/aito/stats/Briefing';
import { followups } from '../../utils/aitoFollowups';
import type { AitoProject, AitoStats } from '../../api/client';

const TODAY = '2026-09-19';
const NOW = new Date('2026-09-19T08:00:00Z').getTime();

function project(overrides: Partial<AitoProject> & { id: number }): AitoProject {
  return {
    description: 'Job', column: 'print', position: 0, status: 'active',
    client_id: 'z1', client_name: 'ACME', client_phone: '+689 87 00 00 01', client_email: null, client_is_company: null,
    client_social_network: null, client_social_handle: null,
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

const stats = {
  throughput: { created: 3, accepted: 2, done: 7, per_day: 0.1, lead_days: 19.8, lead_days_median: 22.6, production_days: 17.1, active: 17 },
  previous: { created: 2, accepted: 2, declined: 0, done: 6, lead_days: null },
} as unknown as AitoStats;

describe('Briefing', () => {
  const quoteOut = project({ id: 1, client_name: 'Tehei Neuffer', description: 'Engrenage machine à laver\nsecond line', column: 'waiting', quote_status: 'sent', quote_sent_at: '2026-08-01T10:00:00', quote_total: 4200 });
  const quoteOut2 = project({ id: 2, client_name: 'Ludovic Hery', column: 'waiting', quote_status: 'sent', quote_sent_at: '2026-08-10T10:00:00', quote_total: 21000 });
  const notCollected = project({ id: 3, client_name: 'Manava', column: 'finish', client_contacted_at: '2026-07-30T10:00:00', quote_total: 6000 });
  const unpaid = project({ id: 4, client_name: 'SNP', invoice_balance: 21000, invoice_due_date: '2026-08-18', quote_invoiced: true });
  const unpaid2 = project({ id: 5, client_name: 'Ex Musik', invoice_balance: 33600, invoice_due_date: '2026-09-11', quote_invoiced: true });
  const dueSoon = project({ id: 6, client_name: 'Due', due_date: '2026-09-22' });

  it('composes the sentence from the three lists and lists the longest wait first', () => {
    render(<Briefing brief={brief([quoteOut, quoteOut2, notCollected, unpaid, unpaid2, dueSoon])} stats={stats} />);
    const h = screen.getByRole('heading', { level: 2 });
    expect(h).toHaveTextContent(/2 quotes to chase, 1 client to tell, and .*54 600.* to collect\./);
    expect(screen.getByText(/1 delivery is due this week\./)).toBeInTheDocument();
    expect(screen.getByText(/7 projects finished in this period\. 1 more than the period before\./)).toBeInTheDocument();

    const chase = screen.getByTestId('aito-brief-chase');
    const rows = within(chase).getAllByRole('button');
    expect(rows[0]).toHaveTextContent('Tehei Neuffer');
    expect(rows[0]).toHaveTextContent('48 d');
    expect(rows[0]).toHaveTextContent('Engrenage machine à laver');
    expect(rows[0]).not.toHaveTextContent('second line');
    expect(rows[1]).toHaveTextContent('Ludovic Hery');

    const tell = screen.getByTestId('aito-brief-tell');
    expect(within(tell).getByRole('button')).toHaveTextContent('Ready for pickup');
    const collect = screen.getByTestId('aito-brief-collect');
    const late = within(collect).getAllByRole('button');
    expect(late[0]).toHaveTextContent('SNP');
    expect(late[0]).toHaveTextContent('32 d late');
    expect(late[1]).toHaveTextContent('8 d late');
  });

  it('reads all clear with no lists and the empty line per list otherwise', () => {
    const { rerender } = render(<Briefing brief={brief([project({ id: 9 })])} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Nothing to chase, no one to tell, nothing to collect.');
    expect(screen.queryByTestId('aito-brief-chase')).toBeNull();
    expect(screen.getByText('Nothing is due this week.')).toBeInTheDocument();

    rerender(<Briefing brief={brief([project({ id: 9 }), unpaid])} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/nothing to chase, no one to tell, and .*21 000.* to collect\./);
    expect(within(screen.getByTestId('aito-brief-chase')).getByText('Every quote has an answer.')).toBeInTheDocument();
  });

  it('caps a list at five rows and says how many more, and a row opens its card', async () => {
    const onOpenCard = vi.fn();
    const many = Array.from({ length: 7 }, (_, i) =>
      project({ id: 10 + i, client_name: `Client ${i}`, column: 'waiting', quote_status: 'sent', quote_sent_at: `2026-08-0${1 + i}T10:00:00` }),
    );
    render(<Briefing brief={brief(many, onOpenCard)} />);
    const chase = screen.getByTestId('aito-brief-chase');
    expect(within(chase).getAllByRole('button')).toHaveLength(5);
    expect(chase).toHaveTextContent('and 2 more');
    await userEvent.setup().click(within(chase).getAllByRole('button')[0]);
    expect(onOpenCard).toHaveBeenCalledWith(10);
  });
});
