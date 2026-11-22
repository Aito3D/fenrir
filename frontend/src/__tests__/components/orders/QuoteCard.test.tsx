/** One quote: the collapsed row and the opened panel (lines with stock, customer, document, activity). */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import { api } from '../../../api/client';
import type { QuoteLine, QuoteRow, QuoteState } from '../../../api/client';
import i18n from '../../../i18n';
import { render } from '../../utils';
import { QuoteCard } from '../../../components/orders/QuoteCard';
import { QuoteStatePill } from '../../../components/orders/QuoteStatePill';
import { parseDay } from '../../../components/orders/orderBoard';
import { formatMoney } from '../../../utils/pricing';

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

  it('opens the quote in Books from the row\'s own link, and shows no link without one', () => {
    stub();
    const { unmount } = render(<QuoteCard row={quote({ zoho_url: 'https://books.example/app/1#/quotes/e1' })} open onToggle={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Open in Zoho Books' })).toHaveAttribute('href', 'https://books.example/app/1#/quotes/e1');
    unmount();
    render(<QuoteCard row={quote({ zoho_url: null })} open onToggle={vi.fn()} />);
    expect(screen.queryByRole('link', { name: 'Open in Zoho Books' })).not.toBeInTheDocument();
  });

  it('an editable quote offers Edit; one this screen cannot edit links to Books instead', async () => {
    stub();
    const onEdit = vi.fn();
    const { unmount } = render(<QuoteCard row={quote({ zoho_url: 'https://books.example/q/e1' })} open onToggle={vi.fn()} onEdit={onEdit} />);
    screen.getByRole('button', { name: 'Edit' }).click();
    expect(onEdit).toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Edit in Zoho' })).not.toBeInTheDocument();
    unmount();
    const { unmount: u2 } = render(<QuoteCard row={quote({ editable: false, zoho_url: 'https://books.example/q/e1' })} open onToggle={vi.fn()} onEdit={onEdit} />);
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit in Zoho' })).toHaveAttribute('href', 'https://books.example/q/e1');
    u2();
    render(<QuoteCard row={quote({ editable: false, zoho_url: null })} open onToggle={vi.fn()} onEdit={onEdit} />);
    expect(screen.queryByTestId('quote-actions')).not.toBeInTheDocument();
  });

  it('a fixed-amount discount reads as money, a percentage as written, on both layouts', () => {
    stub();
    render(<QuoteCard row={quote({ lines: [qline({ discount: '500' }), qline({ id: 'ql2', discount: '10.00%' })] })} open onToggle={vi.fn()} />);
    const [amount, pct] = within(screen.getByRole('list', { name: 'Item' })).getAllByRole('listitem');
    const money = formatMoney(500, 'XPF');
    const cells = (li: HTMLElement) => Array.from(li.querySelectorAll('span'), s => s.textContent);
    expect(cells(amount)).toContain(money); // the desktop column
    expect(amount.textContent).toContain(`−${money}`); // the phone line
    expect(cells(pct)).toContain('10.00%');
    expect(pct.textContent).toContain('−10.00%');
  });

  it('writes its dates in the app\'s language', async () => {
    const previous = i18n.language;
    try {
      await act(async () => {
        await i18n.changeLanguage('fr');
      });
      render(<QuoteCard row={quote()} open={false} onToggle={vi.fn()} />);
      const fr = parseDay('2026-11-10').toLocaleDateString('fr', { year: 'numeric', month: 'short', day: 'numeric' });
      expect(fr).not.toBe(parseDay('2026-11-10').toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' }));
      expect(screen.getByRole('button', { expanded: false })).toHaveTextContent(fr);
    } finally {
      await act(async () => {
        await i18n.changeLanguage(previous);
      });
    }
  });

  it('the state pill renders nothing for a state it does not know', () => {
    render(<div data-testid="pill-host"><QuoteStatePill state={'invoiced' as QuoteState} /></div>);
    expect(screen.getByTestId('pill-host')).toBeEmptyDOMElement();
  });

  it('a quote this screen cannot edit links to Zoho even for a viewer without the update right', () => {
    stub();
    render(<QuoteCard row={quote({ editable: false, zoho_url: 'https://books.example/estimates/e1' })} open onToggle={vi.fn()} />);
    expect(screen.getByRole('link', { name: /Edit in Zoho/ })).toHaveAttribute('href', 'https://books.example/estimates/e1');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});
