import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { useClientRating } from '../../components/aito/useClientRating';
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

  it('re-asks the client rating once the payment is recorded', async () => {
    vi.spyOn(api, 'recordAitoManualPayment').mockResolvedValue(makeProject({ id: 12, client_id: 'z1' }));
    const seen: string[] = [];
    server.use(
      http.get('/api/v1/aito/clients/:clientId/rating', ({ params }) => {
        seen.push(String(params.clientId));
        return HttpResponse.json({ tier: 'unavailable' });
      }),
    );
    function Rated() {
      useClientRating('z1');
      return <ManualPaymentModal project={makeProject({ id: 12, client_id: 'z1' })} document={invoice} onClose={vi.fn()} />;
    }
    render(<Rated />);
    await waitFor(() => expect(seen).toEqual(['z1']));
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(seen).toEqual(['z1', 'z1']));
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

  it('translates a refusal by its code and keeps the server message for a code it has no string for', async () => {
    const spy = vi.spyOn(api, 'recordAitoManualPayment').mockRejectedValue(new ApiError('Amount exceeds the invoice balance of 23000', 422, 'amount_above_balance'));
    render(<ManualPaymentModal project={makeProject()} document={invoice} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(await screen.findByText('The amount is higher than the balance due.')).toBeInTheDocument();
    expect(screen.queryByText('Amount exceeds the invoice balance of 23000')).not.toBeInTheDocument();

    spy.mockRejectedValue(new ApiError('The payment P-9 was recorded in Zoho Books but the local record failed: boom', 502, 'manual_unrecorded'));
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(await screen.findByText('The payment P-9 was recorded in Zoho Books but the local record failed: boom')).toBeInTheDocument();
  });

  it('explains what the quote path writes', () => {
    render(<ManualPaymentModal project={makeProject()} document={quote} onClose={() => {}} />);
    expect(screen.getByText(/retainer invoice on the quote/)).toBeInTheDocument();
  });
});
