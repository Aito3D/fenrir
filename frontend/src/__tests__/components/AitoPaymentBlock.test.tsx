import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, render as rtlRender } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { render } from '../utils';
import { ToastProvider } from '../../contexts/ToastContext';
import { api } from '../../api/client';
import type { AitoPaymentLink, AitoProject, AitoTerminalPayment } from '../../api/client';
import { PaymentBlock } from '../../components/aito/payment/PaymentBlock';
import { makeProject } from '../fixtures/aitoProject';
import type { PaymentDocument } from '../../components/aito/payment/paymentDocument';
import { formatMoney } from '../../utils/pricing';
import { localDateKey } from '../../utils/date';

vi.mock('../../utils/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => true) }));
import { copyTextToClipboard } from '../../utils/clipboard';

/** Local date key `n` calendar days from today, so the fixture never goes stale. */
function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localDateKey(d);
}

/** `formatMoney`'s thin-space/NBSP output, collapsed to plain spaces — RTL's
 *  default text normalizer does the same to the DOM before comparing, but
 *  only to the DOM side, not to a literal string/regex matcher, so a
 *  matcher built straight from `formatMoney` never matches. */
function money(value: number, currency: string): string {
  return formatMoney(value, currency).replace(/\s/g, ' ');
}

const invoice: PaymentDocument = { kind: 'invoice', id: 'inv-1', number: 'FA-26-0001', due: 23000, currency: 'XPF' };
const link = (o: Partial<AitoPaymentLink> = {}): AitoPaymentLink => ({ id: 1, state: 'pending', amount: 23000, currency: 'XPF', url: 'https://pay/x', expires_on: inDays(13), paid_at: null, sync_error: null, minted: true, ...o });
const tpe = (o: Partial<AitoTerminalPayment> = {}): AitoTerminalPayment => ({ id: 7, document_kind: 'invoice', document_number: 'FA-26-0001', status: 'processing', amount: 23000, amount_confirmed: null, booking_status: 'pending', booking_error: null, sync_error: null, created_at: '2026-09-23T01:00:00', settled_at: null, ...o });

function block(over: Partial<Parameters<typeof PaymentBlock>[0]> = {}) {
  return render(<PaymentBlock project={makeProject({ id: 12 })} document={invoice} link={null} terminal={null} canUpdate heimdallConfigured {...over} />);
}

/** A second render helper, used only by the cache-settle test below, which
 *  needs a handle on the QueryClient to pre-seed `['aito-projects']` and to
 *  read/spy on it afterwards — the shared `render` in `../utils` keeps its
 *  client behind `useState`, unreachable from the test. `PaymentBlock` and
 *  its modals touch no context besides React Query, the router and toasts
 *  (see `AitoActivityRail.test.tsx` for the same pattern), so that is the
 *  full provider set needed here. */
function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const utils = rtlRender(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>{ui}</ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
  return { queryClient, ...utils };
}

describe('PaymentBlock', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders nothing with nothing due and no state', () => {
    block({ document: { ...invoice, due: null } });
    expect(screen.queryByTestId('payment-block')).toBeNull();
  });

  it('shows the amount due and three cells; TPE disabled when Heimdall is off', () => {
    block({ heimdallConfigured: false });
    expect(screen.getByText('Balance due')).toBeInTheDocument();
    expect(screen.getByText(money(23000, 'XPF'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Payment link' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Pay by card on the terminal' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Record a payment' })).toBeEnabled();
    expect(screen.getByText('No link')).toBeInTheDocument();
  });

  it('hides the cells without canUpdate and keeps the link tools', () => {
    block({ canUpdate: false, link: link() });
    expect(screen.queryByRole('button', { name: 'Record a payment' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open payment link' })).toBeInTheDocument();
    expect(screen.getByTestId('payment-block')).toHaveAttribute('data-state', 'link_pending');
  });

  it('polls a charge in flight and disables the cells meanwhile', async () => {
    vi.spyOn(api, 'getAitoTerminalPayment').mockResolvedValue(tpe({ status: 'paid', amount_confirmed: 23000, settled_at: '2026-09-23T01:01:00', booking_status: 'booked' }));
    block({ terminal: tpe() });
    expect(screen.getByText('Terminal · waiting for the card')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record a payment' })).toBeDisabled();
    expect(await screen.findByText(new RegExp(`Paid ${money(23000, 'XPF')} · terminal`))).toBeInTheDocument();
  });

  it('paid with a failed booking warns', () => {
    block({ document: { ...invoice, due: null }, terminal: tpe({ status: 'paid', settled_at: '2026-09-23T01:01:00', booking_status: 'failed' }) });
    expect(screen.getByText('Not recorded in Zoho Books — see Heimdall')).toBeInTheDocument();
  });

  it('opens the manual modal from its cell', async () => {
    block();
    await userEvent.click(screen.getByRole('button', { name: 'Record a payment' }));
    expect(screen.getByRole('dialog', { name: 'Record a payment' })).toBeInTheDocument();
  });

  // Carried over from PaymentLinkRow.tsx (retired): the link_pending line's
  // expiry wording, the copy button's rising "Copied" and its `data-state`.
  it('link_pending: expiry wording, open/copy markup and the copied flash', async () => {
    block({ link: link({ expires_on: inDays(13) }) });
    expect(screen.getByTestId('payment-block')).toHaveAttribute('data-state', 'link_pending');
    expect(screen.getByTestId('payment-link-row')).toBeInTheDocument();
    const expires = screen.getByText('Expires in 13 days');
    expect(expires).toBeInTheDocument();
    expect(expires).toHaveAttribute('title', expect.stringMatching(/\d{4}/));
    const open = screen.getByRole('link', { name: 'Open payment link' });
    expect(open).toHaveAttribute('href', 'https://pay/x');
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', expect.stringContaining('noopener'));
    await userEvent.click(screen.getByRole('button', { name: 'Copy payment link' }));
    expect(copyTextToClipboard).toHaveBeenCalledWith('https://pay/x');
    const copied = await screen.findByTestId('payment-link-copied');
    expect(copied).toHaveTextContent('Copied');
    expect(copied).toHaveClass('animate-rise-sm');
  });

  it('link_pending: reads "Expires today" today and "Expired" for a dead link', () => {
    const { unmount } = block({ link: link({ expires_on: inDays(0) }) });
    expect(screen.getByText('Expires today')).toBeInTheDocument();
    unmount();
    block({ link: link({ state: 'expired' }) });
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy payment link' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open payment link' })).not.toBeInTheDocument();
  });

  it('paid via the link shows the online channel and the paid amount', () => {
    block({ document: { ...invoice, due: null }, link: link({ state: 'paid', paid_at: '2026-09-13T10:00:00' }) });
    expect(screen.getByText(new RegExp(`Paid ${money(23000, 'XPF')} · online`))).toBeInTheDocument();
  });

  it('terminal_attention shows the amber warning', () => {
    block({ document: { ...invoice, due: null }, terminal: tpe({ status: 'needs_attention' }) });
    expect(screen.getByText('Unknown result · check the terminal')).toBeInTheDocument();
  });

  it('the state line reopens the terminal modal while processing', async () => {
    vi.spyOn(api, 'getAitoTerminalPayment').mockResolvedValue(tpe());
    block({ terminal: tpe() });
    await userEvent.click(screen.getByRole('button', { name: /Terminal · waiting for the card/ }));
    expect(screen.getByRole('dialog', { name: 'Pay by card' })).toBeInTheDocument();
  });

  // Ruling: a read-only viewer must never be offered a way back into the
  // terminal flow's modal — the reopen button is the only door to it.
  it('does not offer the reopen button to a read-only viewer while a charge is processing', () => {
    vi.spyOn(api, 'getAitoTerminalPayment').mockResolvedValue(tpe());
    block({ canUpdate: false, terminal: tpe() });
    expect(screen.getByText('Terminal · waiting for the card')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /waiting for the card/i })).toBeNull();
  });

  // FINDING 1: TerminalPaymentModal.tsx's settle effect only runs while the
  // modal is mounted — "Close, I will come back" is a designed way to leave
  // it before the charge settles. The block polls the same charge itself
  // (so its own state line moves), so it must also seed the board cache and
  // invalidate the same three queries once the poll lands on a fully
  // settled payment, or the head amount and the three cells stay stuck on
  // the pre-payment figures until an unrelated board fetch happens by.
  it('settles a charge it polls itself into the board cache, even with the modal never opened', async () => {
    vi.spyOn(api, 'getAitoTerminalPayment').mockResolvedValue(
      tpe({ status: 'paid', amount_confirmed: 23000, settled_at: '2026-09-23T01:01:00', booking_status: 'booked' }),
    );
    const processing = tpe();
    const row = makeProject({ id: 12, terminal_payment: processing });
    const { queryClient } = renderWithClient(
      <PaymentBlock project={row} document={invoice} link={null} terminal={processing} canUpdate heimdallConfigured />,
    );
    queryClient.setQueryData<AitoProject[]>(['aito-projects'], [row]);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    await screen.findByText(new RegExp(`Paid ${money(23000, 'XPF')} · terminal`));

    const rows = queryClient.getQueryData<AitoProject[]>(['aito-projects']);
    expect(rows?.[0].terminal_payment?.status).toBe('paid');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['aito-projects'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['aito-invoice', 12] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['aito-events', 12] });
  });

  it('opens the link modal from its cell', async () => {
    block({ link: link() });
    await userEvent.click(screen.getByRole('button', { name: 'Payment link' }));
    expect(screen.getByRole('dialog', { name: 'Payment link' })).toBeInTheDocument();
  });
});
