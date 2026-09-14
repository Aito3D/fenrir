import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { PaymentLinkRow } from '../../components/aito/PaymentLinkRow';
import type { AitoPaymentLink, AitoProject } from '../../api/client';

vi.mock('../../utils/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => true) }));
import { copyTextToClipboard } from '../../utils/clipboard';

const link: AitoPaymentLink = {
  state: 'pending', amount: 12500, currency: 'XPF', url: 'https://osb/pay/L1', expires_on: '2026-09-27', paid_at: null, sync_error: null,
};

function project(overrides: Partial<AitoProject> = {}): AitoProject {
  return { id: 12, description: 'x', column: 'devis', position: 0, status: 'active', client_id: 'z1', client_name: 'ACME',
    client_phone: null, client_email: null, client_is_company: null, client_social_network: null, client_social_handle: null,
    quote_id: 'E1', quote_number: 'DEV-2026-1234', quote_date: '2026-09-12', quote_total: 12500, quote_url: null, quote_salesperson: null,
    quote_status: 'sent', quote_accepted_at: null, quote_sent_at: null, invoice_status: null, invoice_balance: null,
    invoice_due_date: null, invoice_checked_at: null, quote_expiry_date: '2026-09-27', retainer_paid_total: null, payment_link: link,
    quote_sync_state: 'idle', quote_invoiced: false, flag: null, client_contacted_at: null, due_date: null, quote_sync_error: null,
    quote_status_block: null, quote_status_remote: null, created_by: null, task_count: 0, tasks_total: 0, task_services: [],
    task_pending: [], steps_total: 0, steps_done: 0, print_minutes_pending: 0, task_steps: [], move_lock: null, shipping_island: null,
    shipping_service: null, shipping_first_name: null, shipping_last_name: null, shipping_phone: null, shipping_price: null,
    shipping_lta: null, shipping_service_name: null, tracking_configured: false, version: 1,
    created_at: '2026-09-12T00:00:00', updated_at: '2026-09-12T00:00:00', ...overrides };
}

describe('PaymentLinkRow', () => {
  beforeEach(() => vi.mocked(copyTextToClipboard).mockClear());

  it('renders nothing without a link', () => {
    render(<PaymentLinkRow project={project({ payment_link: null })} canUpdate />);
    // Not `toBeEmptyDOMElement` on the container: the shared render wrapper
    // always mounts a toast viewport (see AitoInvoiceCard.test.tsx), so the
    // container is never empty and that assertion would pass for the wrong
    // reason. The row's own testid is the thing that must be absent.
    expect(screen.queryByTestId('payment-link-row')).not.toBeInTheDocument();
  });

  it('pending: amount, expiry and a working copy button', async () => {
    render(<PaymentLinkRow project={project()} canUpdate />);
    expect(screen.getByText('Online payment')).toBeInTheDocument();
    // formatMoney renders XPF as "12 500 FCFP" (thin space + NBSP); match the digits.
    expect(screen.getByTestId('payment-link-amount')).toHaveTextContent(/12.500/);
    // `i18n.language` resolves to plain 'en' in tests, and Node's ICU formats
    // that as month-first ("September 27, 2026") — same convention already
    // pinned by DueDateControl.test.tsx's "Sep 12, 2026" assertions — not the
    // day-first order a locale like en-GB would use.
    expect(screen.getByText(/Expires September 27, 2026/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Copy payment link' }));
    expect(copyTextToClipboard).toHaveBeenCalledWith('https://osb/pay/L1');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('paid: the check, and a warning when the total has moved', () => {
    render(<PaymentLinkRow project={project({ payment_link: { ...link, state: 'paid', paid_at: '2026-09-13T10:00:00' }, quote_total: 14000 })} canUpdate />);
    expect(screen.getByTestId('payment-link-paid')).toHaveTextContent('Paid');
    expect(screen.getByText(/^Paid 12.500.*, quote now 14.000/)).toBeInTheDocument();
  });

  it('paid at the right amount shows no warning', () => {
    render(<PaymentLinkRow project={project({ payment_link: { ...link, state: 'paid', paid_at: '2026-09-13T10:00:00' } })} canUpdate />);
    expect(screen.queryByText(/quote now/)).not.toBeInTheDocument();
  });

  it('a sync error shows the text and a retry that hits the refresh route', async () => {
    let hits = 0;
    server.use(http.post('/api/v1/aito/12/payment-link/refresh', () => { hits += 1; return HttpResponse.json(project()); }));
    render(<PaymentLinkRow project={project({ payment_link: { ...link, sync_error: 'Heimdall HTTP 502 unavailable: OSB down' } })} canUpdate />);
    expect(screen.getByText('Heimdall HTTP 502 unavailable: OSB down')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(hits).toBe(1));
  });

  it('a sync error without canUpdate shows the text but no Retry', () => {
    render(<PaymentLinkRow project={project({ payment_link: { ...link, sync_error: 'Heimdall HTTP 502 unavailable: OSB down' } })} canUpdate={false} />);
    expect(screen.getByText('Heimdall HTTP 502 unavailable: OSB down')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('a dead link shows its state and no copy button', () => {
    render(<PaymentLinkRow project={project({ payment_link: { ...link, state: 'expired' } })} canUpdate />);
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy payment link' })).not.toBeInTheDocument();
  });
});
