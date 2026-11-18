import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { render } from '../../utils';
import { OrderClientHistory } from '../../../components/orders/OrderClientHistory';
import type { FinishedOrderRow, OrderBoardRow } from '../../../api/client';

const open = (o: Partial<OrderBoardRow>): OrderBoardRow =>
  ({ id: 'o', number: 'SO-1', customer_id: 'c1', date: '2026-11-01', total: 100, currency: 'XPF', payment: null, lines: [], ...o }) as OrderBoardRow;
const fin = (o: Partial<FinishedOrderRow>): FinishedOrderRow =>
  ({ id: 'f', number: 'SO-F', customer_id: 'c1', date: '2026-10-01', total: 50, currency: 'XPF', payment: null, paid_flag: 'paid', ...o }) as FinishedOrderRow;

const numbers = () => screen.getAllByTestId('history-order-number').map((n) => n.textContent);

describe('OrderClientHistory', () => {
  it("lists only this customer's orders, newest first", () => {
    render(
      <OrderClientHistory
        customerId="c1"
        currency="XPF"
        open={[open({ id: 'a', number: 'SO-A', date: '2026-11-01' }), open({ id: 'x', number: 'SO-X', customer_id: 'c2' })]}
        finished={[fin({ id: 'b', number: 'SO-B', date: '2026-11-05' }), fin({ id: 'c', number: 'SO-C', date: '2026-09-01' })]}
      />,
    );
    expect(numbers()).toEqual(['SO-B', 'SO-A', 'SO-C']);
  });

  it('shows five then all', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => fin({ id: `f${i}`, number: `SO-${i}`, date: `2026-10-0${i + 1}` }));
    render(<OrderClientHistory customerId="c1" currency="XPF" open={[]} finished={rows} />);
    expect(numbers()).toHaveLength(5);
    await userEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(numbers()).toHaveLength(7);
    expect(screen.queryByRole('button', { name: 'Show all' })).not.toBeInTheDocument();
  });

  it("expands an open order's lines without a request", async () => {
    let calls = 0;
    server.use(http.get('/api/v1/order-board/finished/*', () => { calls++; return HttpResponse.json({}); }));
    const lines = [{ id: 'l1', name: 'PLA Basic', quantity: 3 }] as OrderBoardRow['lines'];
    render(<OrderClientHistory customerId="c1" currency="XPF" open={[open({ lines })]} finished={[]} />);
    await userEvent.click(screen.getByRole('button', { name: /SO-1/ }));
    expect(screen.getByText('PLA Basic')).toBeInTheDocument();
    expect(calls).toBe(0);
  });

  it('expands a finished order via getFinishedOrder', async () => {
    let hit = '';
    server.use(
      http.get(/\/api\/v1\/order-board\/.*finished.*/, ({ request }) => {
        hit = request.url;
        return HttpResponse.json({ id: 'f', lines: [{ id: 'l1', name: 'PETG Red', quantity: 2 }] });
      }),
    );
    render(<OrderClientHistory customerId="c1" currency="XPF" open={[]} finished={[fin({})]} />);
    await userEvent.click(screen.getByRole('button', { name: /SO-F/ }));
    expect(await screen.findByText('PETG Red')).toBeInTheDocument();
    expect(hit).toContain('/f');
  });

  it('renders nothing without a customer', () => {
    render(<OrderClientHistory customerId="" currency="XPF" open={[open({})]} finished={[fin({})]} />);
    expect(screen.queryByTestId('order-client-history')).toBeNull();
  });
});
