import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { OrderBoardLine } from '../../../api/client';
import { render } from '../../utils';
import { OrderLineRow } from '../../../components/orders/OrderLineRow';

const line = (o: Partial<OrderBoardLine> = {}): OrderBoardLine => ({
  id: 'l1', item_id: 'A', name: 'PLA', sku: 'P', state: 'ready', quantity: 1, shipped: 0, cancelled: 0, remaining: 1, invoiced: 0,
  packed_waiting: 0, stock_available: 1, covered: 1, packable: 1, shortfall: 0, rate: 3400, floor: 0, covered_by_po: 0, po_numbers: [], ...o,
});
const show = (o: Partial<OrderBoardLine>) =>
  render(
    <table><tbody>
      <OrderLineRow groupId="todo" line={line(o)} currency="XPF" qty={1} ofQty={null} index={0} edit={null} check={null} checkLabel={null}
        saving={false} pending={false} editQty={vi.fn()} setGone={vi.fn()} setCheck={vi.fn()} />
    </tbody></table>,
  );

describe('the price warning', () => {
  it('flags a line sold at another price than the Zoho item and explains the gap', () => {
    show({ item_rate: 3600 });
    expect(screen.getByRole('img', { name: 'Price differs from Zoho' })).toBeInTheDocument();
    const tip = screen.getByRole('tooltip').textContent ?? '';
    expect(tip).toMatch(/3.?400/);
    expect(tip).toMatch(/3.?600/);
    expect(tip).toMatch(/−200/);
  });

  it.each([{ item_rate: 3400 }, { item_rate: null }, { item_rate: 0 }, {}])('stays quiet for %o', o => {
    show(o);
    expect(screen.queryByRole('img', { name: 'Price differs from Zoho' })).not.toBeInTheDocument();
  });
});

describe('the phone labels', () => {
  it('shows phone labels for available and short cells', () => {
    show({ state: 'backorder', stock_available: 47, shortfall: 1 });
    expect(screen.getByText(/Available/).className).toContain('md:hidden');
    expect(screen.getByText(/Short/).className).toContain('md:hidden');
  });
});
