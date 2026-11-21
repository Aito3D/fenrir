/** One quote: the collapsed row and the opened panel (lines with stock, customer, document, activity). */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { api } from '../../../api/client';
import type { QuoteLine, QuoteRow } from '../../../api/client';
import { render } from '../../utils';
import { QuoteCard } from '../../../components/orders/QuoteCard';

afterEach(() => vi.restoreAllMocks());

const qline = (o: Partial<QuoteLine> = {}): QuoteLine => ({
  id: 'ql1', item_id: 'A', name: 'PLA Basic Noir', sku: 'PLA-BK', quantity: 4, rate: 2500, discount: '10%', total: 9000, available: 14, ...o,
});
const quote = (o: Partial<QuoteRow> = {}): QuoteRow => ({
  id: 'e1', number: 'DEV-00412', customer: 'Nautic Service', customer_id: 'c1', date: '2026-11-10', expiry_date: '2026-12-10',
  state: 'sent', total: 248900, currency: 'XPF', reference: '', age_days: 2, is_core: true, editable: true,
  has_draft_order: false, modified: '', ...o,
  lines: o.lines === undefined ? [qline(), qline({ id: 'ql2', name: 'Bambu Lab H2D', sku: 'H2D', quantity: 1, discount: null, total: 239900, available: 0 })] : o.lines,
});

const stub = () => {
  vi.spyOn(api, 'getZohoContact').mockResolvedValue({ contact_id: 'c1', name: 'Yann', email: 'yann@example.com', phone: '', mobile: '', first_name: '', last_name: '' } as never);
  vi.spyOn(api, 'getQuoteEvents').mockResolvedValue({ events: [], has_more: false });
};

describe('QuoteCard', () => {
  it('shows the state, the validity of a sent quote and no payment pill', () => {
    render(<QuoteCard row={quote()} open={false} onToggle={vi.fn()} />);
    const row = screen.getByRole('button', { expanded: false });
    expect(row).toHaveTextContent('Sent');
    expect(row).toHaveTextContent(/valid until/);
    expect(screen.queryByTestId('order-pay')).not.toBeInTheDocument();
  });

  it('opened, says which lines are in stock and which must be ordered', async () => {
    stub();
    render(<QuoteCard row={quote()} open onToggle={vi.fn()} />);
    const lines = screen.getByRole('list', { name: 'Item' });
    const [pla, h2d] = within(lines).getAllByRole('listitem');
    expect(pla).toHaveTextContent('14 available');
    expect(pla).toHaveTextContent('10%');
    expect(h2d).toHaveTextContent('to order');
    expect(await screen.findByText('yann@example.com')).toBeInTheDocument();
    expect(screen.getByText('Document')).toBeInTheDocument();
  });

  it('shows no stock dot when the stock is unknown, and a skeleton while the lines are unread', () => {
    stub();
    const { unmount } = render(<QuoteCard row={quote({ lines: [qline({ available: null })] })} open onToggle={vi.fn()} />);
    const [only] = within(screen.getByRole('list', { name: 'Item' })).getAllByRole('listitem');
    expect(only).not.toHaveTextContent(/available|to order/);
    unmount();
    render(<QuoteCard row={quote({ lines: null })} open onToggle={vi.fn()} />);
    expect(screen.queryByRole('list', { name: 'Item' })).not.toBeInTheDocument();
    expect(screen.getByTestId('quote-lines-loading')).toBeInTheDocument();
  });

  it('renders the action footer only when given one', () => {
    stub();
    const { unmount } = render(<QuoteCard row={quote()} open onToggle={vi.fn()} />);
    expect(screen.queryByTestId('quote-actions')).not.toBeInTheDocument();
    unmount();
    render(<QuoteCard row={quote()} open onToggle={vi.fn()}><button type="button">Accept</button></QuoteCard>);
    expect(within(screen.getByTestId('quote-actions')).getByText('Accept')).toBeInTheDocument();
  });
});
