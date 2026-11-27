import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../../api/client';
import { OrderClientHistoryButton } from '../../../components/orders/OrderClientHistoryModal';
import type { FinishedOrderRow, OrderBoardRow } from '../../../api/client';

const open = (o: Partial<OrderBoardRow>): OrderBoardRow =>
  ({ id: 'o', number: 'SO-1', customer_id: 'c1', date: '2026-11-01', total: 100, currency: 'XPF', status: 'to_ship', payment: null, lines: [], ...o }) as OrderBoardRow;
const fin = (o: Partial<FinishedOrderRow>): FinishedOrderRow =>
  ({ id: 'f', number: 'SO-F', customer_id: 'c1', date: '2026-10-01', total: 50, currency: 'XPF', payment: null, paid_flag: 'paid', ...o }) as FinishedOrderRow;

const spies = () => ({
  board: vi.spyOn(api, 'getOrderBoard'),
  finished: vi.spyOn(api, 'getFinishedOrders'),
  zoho: vi.spyOn(api, 'getZohoStatus'),
});

const setup = (props: Partial<Parameters<typeof OrderClientHistoryButton>[0]> = {}, rows: { open?: OrderBoardRow[]; finished?: FinishedOrderRow[] } = {}) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['order-board'], { rows: rows.open ?? [] });
  client.setQueryData(['order-board', 'finished'], { rows: rows.finished ?? [] });
  client.setQueryData(['zoho-status', { probe: false }], { default_contact_id: 'walkin' });
  const s = spies();
  const ui = render(
    <QueryClientProvider client={client}>
      <OrderClientHistoryButton customerId="c1" name="Ana" className="pill" {...props} />
    </QueryClientProvider>,
  );
  return { ...ui, ...s };
};

afterEach(() => vi.restoreAllMocks());

describe('OrderClientHistoryButton', () => {
  it.each([['the default contact', 'walkin'], ['an empty customer id', '']])('renders nothing for %s', (_n, customerId) => {
    const { container } = setup({ customerId });
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the order count only when the client has orders', () => {
    const none = setup();
    expect(screen.getByRole('button', { name: 'Client history' })).not.toHaveTextContent('·');
    none.unmount();
    setup({}, { open: [open({ id: 'a' }), open({ id: 'x', customer_id: 'c2' })], finished: [fin({})] });
    expect(screen.getByRole('button', { name: 'Client history' })).toHaveTextContent('· 2');
  });

  it('opens the dialog on click and sends no request', async () => {
    const s = setup({}, { open: [open({ id: 'a', number: 'SO-A' })] });
    expect(screen.queryByTestId('order-client-history-modal')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Client history' }));
    expect(screen.getByTestId('order-client-history-modal')).toBeInTheDocument();
    expect(screen.getByTestId('order-client-history-summary')).toBeInTheDocument();
    expect(screen.getAllByTestId('order-client-history-row')).toHaveLength(1);
    expect(s.board).not.toHaveBeenCalled();
    expect(s.finished).not.toHaveBeenCalled();
  });

  it('closes on Escape and on the X', async () => {
    setup({}, { open: [open({})] });
    await userEvent.click(screen.getByRole('button', { name: 'Client history' }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('order-client-history-modal')).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Client history' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('order-client-history-modal')).not.toBeInTheDocument());
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('marks the current order and offers a jump only to the others, and it closes the dialog', async () => {
    const onGoto = vi.fn();
    setup({ currentId: 'a', onGoto }, { open: [open({ id: 'a', number: 'SO-A', date: '2026-11-02' }), open({ id: 'b', number: 'SO-B', date: '2026-11-01' })] });
    await userEvent.click(screen.getByRole('button', { name: 'Client history' }));
    const rows = screen.getAllByTestId('order-client-history-row');
    expect(rows[0]).toHaveAttribute('aria-current', 'true');
    expect(rows[1]).not.toHaveAttribute('aria-current');
    await userEvent.click(screen.getByRole('button', { name: /SO-A/ }));
    expect(screen.queryByRole('button', { name: /Open order/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /SO-B/ }));
    await userEvent.click(screen.getByRole('button', { name: /Open order/ }));
    expect(onGoto).toHaveBeenCalledWith('b');
    expect(onGoto).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('order-client-history-modal')).not.toBeInTheDocument();
  });

  it('offers no jump without onGoto, nor to a shipped order', async () => {
    setup({}, { open: [open({ id: 'a', number: 'SO-A', date: '2026-11-02' })], finished: [fin({ id: 'f', number: 'SO-F', lines: undefined })] });
    await userEvent.click(screen.getByRole('button', { name: 'Client history' }));
    await userEvent.click(screen.getByRole('button', { name: /SO-A/ }));
    expect(screen.queryByRole('button', { name: /Open order/ })).not.toBeInTheDocument();
  });

  it('shows the empty state when the client has no order', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Client history' }));
    expect(screen.queryByTestId('order-client-history-summary')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('order-client-history-row')).toHaveLength(0);
  });
});
