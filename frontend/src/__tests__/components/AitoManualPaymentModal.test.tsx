import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { api, ApiError } from '../../api/client';
import { ManualPaymentModal } from '../../components/aito/payment/ManualPaymentModal';
import { makeProject } from '../fixtures/aitoProject';
import type { PaymentDocument } from '../../components/aito/payment/paymentDocument';

const invoice: PaymentDocument = { kind: 'invoice', id: 'inv-1', number: 'FA-26-0001', due: 23000, currency: 'XPF' };
const quote: PaymentDocument = { kind: 'quote', id: 'e1', number: 'DEV-1', due: 25000, currency: 'XPF' };

describe('ManualPaymentModal', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prefills the amount, needs a reference for a cheque, and posts', async () => {
    const spy = vi.spyOn(api, 'recordAitoManualPayment').mockResolvedValue(makeProject({ id: 12 }));
    const onClose = vi.fn();
    render(<ManualPaymentModal project={makeProject({ id: 12 })} document={invoice} onClose={onClose} />);
    expect(screen.getByLabelText('Amount')).toHaveValue('23000');
    await userEvent.click(screen.getByRole('radio', { name: 'Cheque' }));
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(screen.getByText('A cheque needs its number')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Reference'), '0004521');
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(12, {
      document_kind: 'invoice', document_id: 'inv-1', mode: 'cheque', amount: 23000, reference: '0004521',
    }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('rejects a non-integer or zero amount client-side', async () => {
    const spy = vi.spyOn(api, 'recordAitoManualPayment');
    render(<ManualPaymentModal project={makeProject()} document={quote} onClose={() => {}} />);
    const amount = screen.getByLabelText('Amount');
    await userEvent.clear(amount);
    await userEvent.type(amount, '12.5');
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(screen.getByText('Enter a whole amount above zero')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('shows the server message verbatim', async () => {
    vi.spyOn(api, 'recordAitoManualPayment').mockRejectedValue(new ApiError('Amount exceeds the invoice balance of 23000', 422, 'amount_above_balance'));
    render(<ManualPaymentModal project={makeProject()} document={invoice} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(await screen.findByText('Amount exceeds the invoice balance of 23000')).toBeInTheDocument();
  });

  it('explains what the quote path writes', () => {
    render(<ManualPaymentModal project={makeProject()} document={quote} onClose={() => {}} />);
    expect(screen.getByText(/retainer invoice on the quote/)).toBeInTheDocument();
  });
});
