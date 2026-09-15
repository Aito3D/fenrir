import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../utils';
import { BillingCard } from '../../components/aito/BillingCard';
import type { AitoProject } from '../../api/client';

vi.mock('../../utils/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => true) }));

function project(overrides: Partial<AitoProject> = {}): AitoProject {
  return { id: 12, description: 'x', column: 'devis', position: 0, status: 'active', client_id: 'z1', client_name: 'ACME',
    client_phone: null, client_email: null, client_is_company: null, client_social_network: null, client_social_handle: null,
    quote_id: 'E1', quote_number: 'DEV-2026-1234', quote_date: '2026-09-12', quote_total: 110100, quote_url: null, quote_salesperson: null,
    quote_status: 'accepted', quote_accepted_at: null, quote_sent_at: null, invoice_status: null, invoice_balance: null,
    invoice_due_date: null, invoice_checked_at: null, quote_expiry_date: '2026-09-27', retainer_paid_total: null, payment_link: null,
    quote_sync_state: 'idle', quote_invoiced: false, flag: null, client_contacted_at: null, due_date: null, quote_sync_error: null,
    quote_status_block: null, quote_status_remote: null, created_by: null, task_count: 0, tasks_total: 0, task_services: [],
    task_pending: [], steps_total: 0, steps_done: 0, print_minutes_pending: 0, task_steps: [], move_lock: null, shipping_island: null,
    shipping_service: null, shipping_first_name: null, shipping_last_name: null, shipping_phone: null, shipping_price: null,
    shipping_lta: null, shipping_service_name: null, tracking_configured: false, version: 1,
    created_at: '2026-09-12T00:00:00', updated_at: '2026-09-12T00:00:00', ...overrides };
}

function renderCard(p: AitoProject) {
  return render(
    <BillingCard project={p} canUpdate onRetrySync={() => {}} retryPending={false} depositPct={0} currency="XPF" />,
  );
}

describe('BillingCard deposit row', () => {
  // The row is the CUSTOMER's unspent deposits (`customer_credit_total`),
  // not the estimate's own paid retainers (`retainer_paid_total`): a
  // retainer raised by hand in Books references no quote and only shows up
  // in the former, and a deposit spent on another invoice drops out of it.
  it('shows what the customer still has on account across every deposit', () => {
    renderCard(project({ customer_credit_total: 36700, retainer_paid_total: 10000 }));
    expect(screen.getByText('Deposit available')).toBeInTheDocument();
    // formatMoney renders XPF as "36 700 FCFP" (thin space + NBSP); match the digits.
    expect(screen.getByText(/36.700/)).toBeInTheDocument();
    expect(screen.queryByText(/10.000/)).not.toBeInTheDocument();
  });

  it('has no deposit row before the sweep has read the customer', () => {
    renderCard(project({ customer_credit_total: null, retainer_paid_total: 10000 }));
    expect(screen.queryByText('Deposit available')).not.toBeInTheDocument();
    expect(screen.queryByText('Deposit paid')).not.toBeInTheDocument();
  });

  it('has no deposit row once every deposit has been spent', () => {
    renderCard(project({ customer_credit_total: 0, retainer_paid_total: 10000 }));
    expect(screen.queryByText('Deposit available')).not.toBeInTheDocument();
  });
});
