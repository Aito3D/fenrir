import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { api, ApiError } from '../../api/client';
import type { AitoTerminalPayment } from '../../api/client';
import { TerminalPaymentModal } from '../../components/aito/payment/TerminalPaymentModal';
import { makeProject } from '../fixtures/aitoProject';
import type { PaymentDocument } from '../../components/aito/payment/paymentDocument';

const invoice: PaymentDocument = { kind: 'invoice', id: 'inv-1', number: 'FA-26-0001', due: 23000, currency: 'XPF' };
const tpe = (o: Partial<AitoTerminalPayment> = {}): AitoTerminalPayment => ({
  id: 7, document_kind: 'invoice', document_number: 'FA-26-0001', status: 'processing', amount: 23000, amount_confirmed: null,
  booking_status: 'pending', booking_error: null, sync_error: null, created_at: '2026-09-23T01:00:00', settled_at: null, ...o,
});

describe('TerminalPaymentModal', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('starts, polls every 3 s, and lands on paid', async () => {
    vi.spyOn(api, 'startAitoTerminalPayment').mockResolvedValue(tpe());
    const get = vi.spyOn(api, 'getAitoTerminalPayment')
      .mockResolvedValueOnce(tpe({ status: 'processing', sync_error: null }))
      .mockResolvedValue(tpe({ status: 'paid', amount_confirmed: 23000, settled_at: '2026-09-23T01:01:00', booking_status: 'booked' }));
    render(<TerminalPaymentModal project={makeProject({ id: 12 })} document={invoice} initialPayment={null} onClose={() => {}} />);
    expect(screen.getByLabelText('Amount')).toHaveValue('23000');
    await userEvent.click(screen.getByRole('button', { name: 'Start the terminal' }));
    expect(await screen.findByText('Waiting for the card on the terminal…')).toBeInTheDocument();
    expect(api.startAitoTerminalPayment).toHaveBeenCalledWith(12, { document_kind: 'invoice', document_id: 'inv-1', amount: 23000 });
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(await screen.findByText('Payment accepted')).toBeInTheDocument();
    expect(screen.getByText('Recorded in Zoho Books')).toBeInTheDocument();
    expect(get).toHaveBeenCalled();
  });

  it('survives a transient poll failure: keeps the waiting screen, shows no error copy, and resumes polling to eventually settle', async () => {
    vi.spyOn(api, 'startAitoTerminalPayment').mockResolvedValue(tpe({ status: 'pending' }));
    const get = vi.spyOn(api, 'getAitoTerminalPayment')
      // Mount-triggered refetch (staleTime: 0) — consumed while awaiting
      // the initial waiting screen below, matching the cache the mutation
      // already seeded; still open.
      .mockResolvedValueOnce(tpe({ status: 'pending' }))
      // First interval tick: a transient network blip. `retry: false`
      // means this settles straight into an error state instead of being
      // retried internally — but `state.data` (still 'pending') is
      // untouched, so `refetchInterval` must keep polling regardless.
      .mockRejectedValueOnce(new Error('network blip'))
      // Second interval tick: back up, still open — proves the poll was
      // not stopped or frozen by the earlier failure.
      .mockResolvedValueOnce(tpe({ status: 'pending' }))
      // Third interval tick: the card is finally accepted.
      .mockResolvedValue(tpe({ status: 'paid', amount_confirmed: 23000, settled_at: '2026-09-23T01:01:00', booking_status: 'booked' }));
    render(<TerminalPaymentModal project={makeProject({ id: 12 })} document={invoice} initialPayment={null} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start the terminal' }));
    expect(await screen.findByText('Waiting for the card on the terminal…')).toBeInTheDocument();

    // The poll tick that rejects: the waiting screen must not flip to any
    // error state, and no error copy must appear anywhere in the modal.
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(screen.getByText('Waiting for the card on the terminal…')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('network blip')).toBeNull();

    // The next tick after the failure: the API is called again (the poll
    // was not frozen or stopped) and still reports the open status.
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(screen.getByText('Waiting for the card on the terminal…')).toBeInTheDocument();
    expect(get.mock.calls.length).toBeGreaterThanOrEqual(3);

    // And the poll keeps running to a normal settle afterward.
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(await screen.findByText('Payment accepted')).toBeInTheDocument();
    expect(screen.getByText('Recorded in Zoho Books')).toBeInTheDocument();
  });

  it('paid but booking_status failed flags the Zoho gap in warning styling', async () => {
    vi.spyOn(api, 'startAitoTerminalPayment').mockResolvedValue(tpe());
    vi.spyOn(api, 'getAitoTerminalPayment').mockResolvedValue(
      tpe({ status: 'paid', amount_confirmed: 23000, settled_at: '2026-09-23T01:01:00', booking_status: 'failed' })
    );
    render(<TerminalPaymentModal project={makeProject({ id: 12 })} document={invoice} initialPayment={null} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start the terminal' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    const bookingLine = await screen.findByText('Not recorded in Zoho Books — see Heimdall');
    expect(bookingLine).toHaveClass('text-status-warning');
    expect(bookingLine).not.toHaveClass('text-bambu-gray');
  });

  it('paid with booking_status booked shows the neutral confirmation, not the warning', async () => {
    vi.spyOn(api, 'startAitoTerminalPayment').mockResolvedValue(tpe());
    vi.spyOn(api, 'getAitoTerminalPayment').mockResolvedValue(
      tpe({ status: 'paid', amount_confirmed: 23000, settled_at: '2026-09-23T01:01:00', booking_status: 'booked' })
    );
    render(<TerminalPaymentModal project={makeProject({ id: 12 })} document={invoice} initialPayment={null} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start the terminal' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    const bookingLine = await screen.findByText('Recorded in Zoho Books');
    expect(bookingLine).toHaveClass('text-bambu-gray');
    expect(bookingLine).not.toHaveClass('text-status-warning');
  });

  it('declined offers a retry back to the form', async () => {
    vi.spyOn(api, 'startAitoTerminalPayment').mockResolvedValue(tpe());
    vi.spyOn(api, 'getAitoTerminalPayment').mockResolvedValue(tpe({ status: 'failed', settled_at: '2026-09-23T01:01:00' }));
    render(<TerminalPaymentModal project={makeProject({ id: 12 })} document={invoice} initialPayment={null} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start the terminal' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
    expect(await screen.findByText('Declined')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('button', { name: 'Start the terminal' })).toBeInTheDocument();
  });

  it('needs_attention has no retry', async () => {
    render(<TerminalPaymentModal project={makeProject({ id: 12 })} document={invoice}
      initialPayment={tpe({ status: 'needs_attention', settled_at: '2026-09-23T01:01:00' })} onClose={() => {}} />);
    expect(await screen.findByText('Unknown result')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('reopens on a charge in flight and shows the server message on a refused start', async () => {
    vi.spyOn(api, 'getAitoTerminalPayment').mockResolvedValue(tpe());
    const { unmount } = render(<TerminalPaymentModal project={makeProject({ id: 12 })} document={invoice} initialPayment={tpe()} onClose={() => {}} />);
    expect(await screen.findByText('Waiting for the card on the terminal…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
    unmount();
    vi.spyOn(api, 'startAitoTerminalPayment').mockRejectedValue(new ApiError('Heimdall HTTP 409 terminal_busy: busy', 409, 'terminal_busy'));
    render(<TerminalPaymentModal project={makeProject({ id: 12 })} document={invoice} initialPayment={null} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Start the terminal' }));
    expect(await screen.findByText('Heimdall HTTP 409 terminal_busy: busy')).toBeInTheDocument();
  });
});
