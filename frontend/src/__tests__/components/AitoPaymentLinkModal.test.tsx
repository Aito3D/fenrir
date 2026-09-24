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
});
