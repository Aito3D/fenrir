import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { OrderItemHit } from '../../../api/client';
import type { NewOrderDraftLine } from '../../../hooks/useNewOrderDraft';
import { formatMoney } from '../../../utils/pricing';
import { NewOrderLines } from '../../../components/orders/NewOrderLines';

const hit = (id: string): OrderItemHit => ({ id, name: `Item ${id}`, sku: id, rate: 100, stock_on_hand: 9, product_type: 'goods' });

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../../components/orders/OrderItemSearch', () => ({
  OrderItemSearch: ({ onAdd }: { onAdd: (i: OrderItemHit) => void }) => <button onClick={() => onAdd(hit('B'))}>scan-B</button>,
}));
vi.mock('../../../components/aito/HoldButton', () => ({
  HoldButton: ({ onHold, label }: { onHold: () => void; label: string }) => <button onClick={onHold}>{label}</button>,
}));

// Like NewOrderDraftRow: onChange closes over the current draft and replaces it by value.
function Host() {
  const [draft, setDraft] = useState<{ lines: NewOrderDraftLine[] }>({ lines: [{ item: hit('A'), quantity: 1, discount: '' }] });
  return <NewOrderLines lines={draft.lines} currency="XPF" disabled={false} onChange={lines => setDraft({ ...draft, lines })} />;
}

afterEach(() => vi.useRealTimers());

describe('NewOrderLines', () => {
  it('keeps a line added during the leave window when the removed line goes', () => {
    vi.useFakeTimers();
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: /orders.edit.remove · Item A/ }));
    fireEvent.click(screen.getByText('scan-B'));
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getAllByTestId('draft-line-total')).toHaveLength(1);
    expect(screen.getByTitle('Item B')).toBeInTheDocument();
    expect(screen.queryByTitle('Item A')).not.toBeInTheDocument();
  });

  it('patches the line quantity, fractions included, and the line total follows', () => {
    render(<Host />);
    const total = () => screen.getByTestId('draft-line-total').textContent;
    const money = (n: number) => formatMoney(n, 'XPF');
    const qty = screen.getByLabelText('orders.col.qty · Item A');
    expect(total()).toBe(money(100));
    fireEvent.click(screen.getByRole('button', { name: /orders.parcel.more · Item A/ }));
    expect(qty).toHaveValue(2);
    expect(total()).toBe(money(200));
    fireEvent.change(qty, { target: { value: '2.5' } });
    expect(qty).toHaveValue(2.5);
    expect(total()).toBe(money(250));
  });

  it('drops the scan wash once its animation ends', () => {
    const { container } = render(<Host />);
    expect(container.querySelector('.order-line-wash')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('scan-B'));
    const wash = container.querySelector('.order-line-wash')!;
    expect(wash).toBeInTheDocument();
    fireEvent.animationEnd(wash);
    expect(container.querySelector('.order-line-wash')).not.toBeInTheDocument();
  });
});
