/** The counter sale with the REAL card dialog (the sibling file stubs it): the start request, the poll and the settle. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { render } from '../../utils';
import { CounterPayFlow } from '../../../components/orders/CounterPayFlow';
import type { useCounterPay } from '../../../components/orders/useCounterPay';

vi.mock('../../../components/aito/usePrintBlob', () => ({ usePrintBlob: () => ({ print: vi.fn(), busy: false }) }));

const TERMINAL = '/api/v1/order-board/orders/so1/terminal-payment';
const charge = (status: string, booking_status: string | null) => ({
  id: 7, document_kind: 'invoice', document_number: 'SO-9', status, amount: 12400, amount_confirmed: 12400, booking_status,
  booking_error: null, sync_error: null, created_at: '', settled_at: null,
});

afterEach(() => server.resetHandlers());

describe('CounterPayFlow with the real terminal dialog', () => {
  it('starts the charge with the due amount, polls it and settles once it is paid and booked', async () => {
    const posted: unknown[] = [];
    let current: unknown = null;
    server.use(
      http.get('/api/v1/order-board/orders/so1/payment-target', () =>
        HttpResponse.json({ kind: 'salesorder', document_id: 'so1', number: 'SO-9', max_amount: 12400, left: 12400, link: null })),
      http.post(TERMINAL, async ({ request }) => {
        posted.push(await request.json());
        current = charge('pending', null);
        return HttpResponse.json(current);
      }),
      http.get(TERMINAL, () => HttpResponse.json(current)),
    );
    const pay = {
      step: 'payment', busy: false, wait: 'payment', error: null, row: { id: 'so1', number: 'SO-9', currency: 'XPF' }, paid: 0, later: false,
      invoice: null, question: null, handedLate: [], forced: [], active: true,
      start: vi.fn(), settle: vi.fn(), payLater: vi.fn(), cancelPayment: vi.fn(), answer: vi.fn(), handOver: vi.fn(), retry: vi.fn(), reset: vi.fn(),
    } as unknown as ReturnType<typeof useCounterPay>;
    render(<CounterPayFlow pay={pay} currency="XPF" total={12400} email={null} isDefaultClient onNewSale={vi.fn()} onOpenOrder={vi.fn()} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Card (terminal)' }));
    await user.click(await screen.findByRole('button', { name: 'Start the terminal' }));
    expect(await screen.findByText('Waiting for the card on the terminal…')).toBeInTheDocument();
    expect(posted).toEqual([{ amount: 12400 }]);
    expect(pay.settle).not.toHaveBeenCalled();

    // The next 3 s poll (and the flow's own) read the charge paid and booked.
    current = charge('paid', 'booked');
    await vi.waitFor(() => expect(pay.settle).toHaveBeenCalledWith(12400), { timeout: 8000 });
    expect(pay.settle).toHaveBeenCalledTimes(1);
  }, 15000);
});
