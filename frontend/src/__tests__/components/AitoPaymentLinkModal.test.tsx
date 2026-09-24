import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { api } from '../../api/client';
import type { AitoPaymentLink } from '../../api/client';
import { PaymentLinkModal } from '../../components/aito/payment/PaymentLinkModal';
import { makeProject } from '../fixtures/aitoProject';
import type { PaymentDocument } from '../../components/aito/payment/paymentDocument';

vi.mock('../../utils/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => true) }));

const invoice: PaymentDocument = { kind: 'invoice', id: 'inv-1', number: 'FA-26-0001', due: 23000, currency: 'XPF' };
const quote: PaymentDocument = { kind: 'quote', id: 'e1', number: 'DEV-1', due: 25000, currency: 'XPF' };
const live: AitoPaymentLink = { id: 3, state: 'pending', amount: 23000, currency: 'XPF', url: 'https://pay/x', expires_on: '2099-01-01', paid_at: null, sync_error: null, minted: true };
const reservation: AitoPaymentLink = { id: 4, state: 'pending', amount: 23000, currency: 'XPF', url: null, expires_on: '2099-01-01', paid_at: null, sync_error: null, minted: false };

describe('PaymentLinkModal', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates a link for an invoice without one', async () => {
    const spy = vi.spyOn(api, 'createAitoInvoicePaymentLink').mockResolvedValue(makeProject({ id: 12 }));
    render(<PaymentLinkModal project={makeProject({ id: 12 })} document={invoice} link={null} onClose={() => {}} />);
    expect(screen.getByLabelText('Amount')).toHaveValue('23000');
    await userEvent.click(screen.getByRole('button', { name: 'Create the link' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, { document_id: 'inv-1', amount: 23000 }));
  });

  it('shows open / copy and a two-step cancel on a live invoice link', async () => {
    const spy = vi.spyOn(api, 'cancelAitoPaymentLink').mockResolvedValue(makeProject({ id: 12 }));
    render(<PaymentLinkModal project={makeProject({ id: 12 })} document={invoice} link={live} onClose={() => {}} />);
    expect(screen.getByRole('link', { name: 'Open payment link' })).toHaveAttribute('href', 'https://pay/x');
    expect(screen.getByRole('button', { name: 'Copy payment link' })).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
    expect(screen.getByText('Expires')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the link' }));
    expect(spy).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel this link?' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, 3));
  });

  it('a quote link is read-only', () => {
    render(<PaymentLinkModal project={makeProject({ id: 12 })} document={quote} link={live} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Cancel the link' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Create/ })).toBeNull();
  });

  it('a dead invoice link offers a new one', () => {
    render(<PaymentLinkModal project={makeProject({ id: 12 })} document={invoice} link={{ ...live, state: 'expired' }} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Create a new link' })).toBeInTheDocument();
  });

  it('a paid quote link reads Paid, read-only', () => {
    render(<PaymentLinkModal project={makeProject({ id: 12 })} document={quote} link={{ ...live, state: 'paid' }} onClose={() => {}} />);
    expect(screen.getByText(/Paid/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel the link' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Create/ })).toBeNull();
  });

  it('a pending unminted quote link reads "being created", no actions', () => {
    render(
      <PaymentLinkModal
        project={makeProject({ id: 12 })}
        document={quote}
        link={{ ...live, minted: false, url: null }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Link being created…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
  });

  // Final review, Important 1: "Link being created…" with no button was a
  // dead end — the reconciler never mints an invoice link, so a create that
  // died before storing its error left the invoice with no link and no way
  // to ask for one. The create view is always offered; the backend replays
  // that same reservation under its own key.
  it('an invoice reservation offers to create the link rather than a dead end', async () => {
    const spy = vi.spyOn(api, 'createAitoInvoicePaymentLink').mockResolvedValue(makeProject({ id: 12 }));
    render(<PaymentLinkModal project={makeProject({ id: 12 })} document={invoice} link={reservation} onClose={() => {}} />);
    expect(screen.queryByText('Link being created…')).toBeNull();
    expect(screen.getByLabelText('Amount')).toHaveValue('23000');
    await userEvent.click(screen.getByRole('button', { name: 'Create the link' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, { document_id: 'inv-1', amount: 23000 }));
  });

  it('a stuck invoice reservation with a sync error offers to create the link, showing the error', async () => {
    const spy = vi.spyOn(api, 'createAitoInvoicePaymentLink').mockResolvedValue(makeProject({ id: 12 }));
    const stuck = { ...reservation, sync_error: 'Heimdall timed out' };
    render(<PaymentLinkModal project={makeProject({ id: 12 })} document={invoice} link={stuck} onClose={() => {}} />);
    expect(screen.getByText('Heimdall timed out')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Create the link' });
    expect(button).toBeInTheDocument();
    await userEvent.click(button);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, { document_id: 'inv-1', amount: 23000 }));
  });

  // Final review, Important 3: the quote link's manual Retry was dropped when
  // PaymentLinkRow was retired, leaving `POST …/payment-link/refresh` and
  // `api.refreshAitoPaymentLink` with no caller and a stuck quote link with
  // no way out but the 5-minute tick.
  it('a live quote link with a sync error shows it and retries on demand', async () => {
    const spy = vi.spyOn(api, 'refreshAitoPaymentLink').mockResolvedValue(makeProject({ id: 12 }));
    const stuck = { ...live, sync_error: 'Heimdall HTTP 503' };
    render(<PaymentLinkModal project={makeProject({ id: 12 })} document={quote} link={stuck} onClose={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent('Heimdall HTTP 503');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12));
  });

  it('an unminted quote link with a sync error keeps "being created" and offers Retry', async () => {
    const spy = vi.spyOn(api, 'refreshAitoPaymentLink').mockResolvedValue(makeProject({ id: 12 }));
    const stuck = { ...reservation, sync_error: 'Heimdall HTTP 503' };
    render(<PaymentLinkModal project={makeProject({ id: 12 })} document={quote} link={stuck} onClose={() => {}} />);
    expect(screen.getByText('Link being created…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12));
  });

  it('an invoice link never offers the quote-only Retry', () => {
    render(
      <PaymentLinkModal
        project={makeProject({ id: 12 })}
        document={invoice}
        link={{ ...live, sync_error: 'Heimdall HTTP 503' }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
