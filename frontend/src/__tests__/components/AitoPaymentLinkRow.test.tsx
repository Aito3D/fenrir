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
import { localDateKey } from '../../utils/date';

/** Local date key `n` calendar days from today, so the fixture never goes stale. */
function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localDateKey(d);
}

const link: AitoPaymentLink = {
  state: 'pending', amount: 12500, currency: 'XPF', url: 'https://osb/pay/L1', expires_on: inDays(13), paid_at: null, sync_error: null,
  minted: true,
};

function project(overrides: Partial<AitoProject> = {}): AitoProject {
  return { id: 12, description: 'x', column: 'devis', position: 0, status: 'active', client_id: 'z1', client_name: 'ACME',
    client_phone: null, client_email: null, client_is_company: null, client_social_network: null, client_social_handle: null,
    client_contact_person_id: null, client_contact_name: null,
    quote_id: 'E1', quote_number: 'DEV-2026-1234', quote_date: '2026-09-12', quote_total: 12500, quote_url: null, quote_salesperson: null,
    quote_status: 'sent', quote_accepted_at: null, quote_sent_at: null, invoice_status: null, invoice_balance: null,
    invoice_due_date: null, invoice_checked_at: null, quote_expiry_date: '2026-09-27', retainer_paid_total: null, customer_credit_total: null, payment_link: link,
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
    // The expiry reads as a countdown; the exact date stays available as a tooltip.
    const expires = screen.getByText('Expires in 13 days');
    expect(expires).toBeInTheDocument();
    expect(expires).toHaveAttribute('title', expect.stringMatching(/\d{4}/));
    // Open is a real anchor to a new tab, beside Copy, in the tracking row's
    // vocabulary (see linkActions.tsx): the URL is already in hand, so no
    // window.open dance is needed.
    const open = screen.getByRole('link', { name: 'Open payment link' });
    expect(open).toHaveAttribute('href', 'https://osb/pay/L1');
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', expect.stringContaining('noopener'));
    await userEvent.click(screen.getByRole('button', { name: 'Copy payment link' }));
    expect(copyTextToClipboard).toHaveBeenCalledWith('https://osb/pay/L1');
    const copied = await screen.findByTestId('payment-link-copied');
    expect(copied).toHaveTextContent('Copied');
    expect(copied).toHaveClass('animate-rise-sm');
    expect(screen.getByRole('button', { name: 'Copy payment link' }).querySelector('svg')).toHaveClass('animate-tick-in');
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

  it('a reservation that never minted (no url) shows its error and Retry, never a payable link', async () => {
    // T-010: a row stuck with heimdall_id null (a permanent Heimdall refusal)
    // still has a real amount/expiry — only `url` is null — so the panel
    // must show the error and offer Retry without ever rendering it as live.
    let hits = 0;
    server.use(http.post('/api/v1/aito/12/payment-link/refresh', () => { hits += 1; return HttpResponse.json(project()); }));
    render(
      <PaymentLinkRow
        project={project({
          payment_link: {
            ...link,
            minted: false,
            url: null,
            sync_error: 'Heimdall HTTP 422 invalid_request: reference matches no document',
          },
        })}
        canUpdate
      />,
    );
    expect(screen.getByTestId('payment-link-row')).toHaveAttribute('data-state', 'pending');
    // The amount still shows (it is real — the reservation's own terms) but
    // there is nothing to open or copy: no url means no payable link.
    expect(screen.getByTestId('payment-link-amount')).toHaveTextContent(/12.500/);
    expect(screen.queryByRole('link', { name: 'Open payment link' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy payment link' })).not.toBeInTheDocument();
    expect(
      screen.getByText('Heimdall HTTP 422 invalid_request: reference matches no document'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(hits).toBe(1));
  });

  it('counts down to the expiry date: singular day, today, and a pending link past its date', () => {
    const { unmount } = render(<PaymentLinkRow project={project({ payment_link: { ...link, expires_on: inDays(1) } })} canUpdate />);
    expect(screen.getByText('Expires in 1 day')).toBeInTheDocument();
    unmount();
    const today = render(<PaymentLinkRow project={project({ payment_link: { ...link, expires_on: inDays(0) } })} canUpdate />);
    expect(screen.getByText('Expires today')).toBeInTheDocument();
    today.unmount();
    render(<PaymentLinkRow project={project({ payment_link: { ...link, expires_on: inDays(-2) } })} canUpdate />);
    expect(screen.getByText('Expired')).toBeInTheDocument();
  });

  it('a dead link shows its state and no copy button', () => {
    render(<PaymentLinkRow project={project({ payment_link: { ...link, state: 'expired' } })} canUpdate />);
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy payment link' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open payment link' })).not.toBeInTheDocument();
  });
});
