import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { render } from '../../utils';
import { OrderDepositAvailable } from '../../../components/orders/OrderDepositAvailable';
import { formatMoney } from '../../../utils/pricing';

const stub = (id: string, respond: () => Response) => {
  const hits = { n: 0 };
  server.use(http.get(`/api/v1/order-board/orders/${id}/customer-credit`, () => { hits.n++; return respond(); }));
  return hits;
};

describe('OrderDepositAvailable', () => {
  it('shows the formatted credit in customer-credit', async () => {
    stub('o1', () => HttpResponse.json({ credit: 7000 }));
    render(<OrderDepositAvailable orderId="o1" currency="XPF" />);
    expect((await screen.findByTestId('customer-credit')).textContent).toContain(formatMoney(7000, 'XPF'));
  });

  it('renders nothing at zero credit, once the positive case is known to render', async () => {
    stub('o1', () => HttpResponse.json({ credit: 7000 }));
    const zero = stub('o0', () => HttpResponse.json({ credit: 0 }));
    const { rerender } = render(<OrderDepositAvailable orderId="o1" currency="XPF" />);
    await screen.findByTestId('customer-credit');
    rerender(<OrderDepositAvailable orderId="o0" currency="XPF" />);
    await waitFor(() => expect(zero.n).toBe(1));
    await waitFor(() => expect(screen.queryByTestId('customer-credit')).not.toBeInTheDocument());
  });

  it('renders nothing when the request fails, once the positive case is known to render', async () => {
    stub('o1', () => HttpResponse.json({ credit: 7000 }));
    const bad = stub('oe', () => HttpResponse.json({ detail: 'boom' }, { status: 500 }));
    const { rerender } = render(<OrderDepositAvailable orderId="o1" currency="XPF" />);
    await screen.findByTestId('customer-credit');
    rerender(<OrderDepositAvailable orderId="oe" currency="XPF" />);
    await waitFor(() => expect(bad.n).toBe(1));
    await waitFor(() => expect(screen.queryByTestId('customer-credit')).not.toBeInTheDocument());
  });

  it('reads the credit by customer when no order exists yet', async () => {
    server.use(http.get('/api/v1/order-board/customers/c9/credit', () => HttpResponse.json({ credit: 1895 })));
    render(<OrderDepositAvailable customerId="c9" currency="XPF" />);
    expect((await screen.findByTestId('customer-credit')).textContent).toContain(formatMoney(1895, 'XPF'));
  });
});
