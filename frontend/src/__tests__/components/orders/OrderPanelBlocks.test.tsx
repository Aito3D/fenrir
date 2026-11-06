/** The blocks beside the lines of an opened order: payment, contact and reference chips. */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OrderContact, OrderPanelRow, OrderPayment } from '../../../api/client';
import { render } from '../../utils';
import { OrderPaymentBlock } from '../../../components/orders/OrderPaymentBlock';
import { OrderContactBlock } from '../../../components/orders/OrderContactBlock';
import { OrderRefChips } from '../../../components/orders/OrderRefChips';
import { PaymentPill } from '../../../components/orders/PaymentPill';
import { OrderLinesPanel } from '../../../components/orders/OrderLinesPanel';

const pay = (o: Partial<OrderPayment> = {}): OrderPayment => ({
  state: 'partial', pct: 40, paid: 250000, invoice_paid: 250000, advance: 0, due: 180000, overdue: 0, rest: 182000, left: 362000,
  next_due: '2026-11-11',
  invoices: [
    { id: 'i1', number: 'FAC-0001', date: '2026-10-01', due_date: '2026-10-01', total: 250000, balance: 0, status: 'paid', url: 'https://books.example/inv/i1' },
    { id: 'i2', number: 'FAC-0002', date: '2026-11-01', due_date: '2026-11-11', total: 180000, balance: 180000, status: 'sent', url: null },
  ],
  ...o,
});

const contact = (o: Partial<OrderContact> = {}): OrderContact => ({ name: 'Teva Marchand', email: 'teva@tahiti-nautic.example', phone: '40 50 22 10', mobile: '87 22 45 67', ...o });

const flat = (el: HTMLElement) => (el.textContent ?? '').replace(/\s/g, ' ');

describe('OrderPaymentBlock', () => {
  it('shows what is left to pay and each non-zero legend part; the invoices live in their own card', () => {
    render(<OrderPaymentBlock payment={pay()} currency="XPF" />);
    expect(screen.getByText('Left to pay')).toBeInTheDocument();
    expect(flat(screen.getByTestId('pay-left'))).toMatch(/362.000/);
    expect(screen.getAllByText('Paid').length).toBeGreaterThan(0); // legend
    expect(screen.getByText('Invoiced, awaiting payment')).toBeInTheDocument();
    expect(screen.getByText('Still to pay, not invoiced')).toBeInTheDocument();
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
    expect(screen.queryByText('FAC-0001')).not.toBeInTheDocument();
    expect(screen.queryByText('FAC-0002')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Due /)).not.toBeInTheDocument();
  });

  it('an advance renames the paid part and explains itself', () => {
    render(<OrderPaymentBlock payment={pay({ advance: 50000, paid: 300000 })} currency="XPF" />);
    expect(screen.getByText('Paid on invoice')).toBeInTheDocument();
    expect(screen.getByText('Paid in advance')).toBeInTheDocument();
    expect(screen.getByText(/the customer's unused credit in Zoho/)).toBeInTheDocument();
  });

  it('segments never exceed the bar', () => {
    render(<OrderPaymentBlock payment={pay({ invoice_paid: 20500, paid: 20500, due: 24439, rest: 0, left: 24439, invoices: [] })} currency="XPF" />);
    const widths = screen.getAllByTestId(/^pay-seg-/).map(s => parseFloat((s as HTMLElement).style.width));
    expect(widths.length).toBeGreaterThan(0);
    expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(100.0001);
  });

  it('says nothing is left to pay', () => {
    render(<OrderPaymentBlock payment={pay({ state: 'paid', pct: 100, due: 0, rest: 0, left: 0, invoices: [] })} currency="XPF" />);
    expect(screen.getByText('Nothing left to pay')).toBeInTheDocument();
    expect(screen.queryByText('No invoice yet for this order.')).not.toBeInTheDocument();
  });
});

describe('OrderContactBlock', () => {
  it('links the numbers and the address, with a copy button per value', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<OrderContactBlock contact={contact()} orderNumber="SO-00421" others={[]} onGoto={vi.fn()} />);
    expect(screen.getByText('Teva Marchand')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '87 22 45 67' })).toHaveAttribute('href', 'tel:87224567');
    expect(screen.getByRole('link', { name: '40 50 22 10' })).toHaveAttribute('href', 'tel:40502210');
    expect(screen.getByRole('link', { name: 'teva@tahiti-nautic.example' })).toHaveAttribute(
      'href', `mailto:teva@tahiti-nautic.example?subject=${encodeURIComponent('Order SO-00421')}`);
    await user.click(screen.getByRole('button', { name: 'Copy 87 22 45 67' }));
    expect(writeText).toHaveBeenCalledWith('87 22 45 67');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Copy / })).toHaveLength(2); // the other two values
  });

  it('says what is missing instead of linking nothing', () => {
    render(<OrderContactBlock contact={contact({ phone: '  ', mobile: '', email: '' })} orderNumber="SO-1" others={[]} onGoto={vi.fn()} />);
    expect(screen.getByText('No phone in Zoho')).toBeInTheDocument();
    expect(screen.getByText('No email in Zoho')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('says so when the order has no contact person', () => {
    render(<OrderContactBlock contact={null} orderNumber="SO-1" others={[]} onGoto={vi.fn()} />);
    expect(screen.getByText('No contact person on this order in Zoho.')).toBeInTheDocument();
  });

  it('other open orders call onGoto', async () => {
    const user = userEvent.setup();
    const onGoto = vi.fn();
    render(<OrderContactBlock contact={contact()} orderNumber="SO-1" others={[{ id: 'so9', number: 'SO-00436' }]} onGoto={onGoto} />);
    await user.click(screen.getByRole('button', { name: 'SO-00436' }));
    expect(onGoto).toHaveBeenCalledWith('so9');
  });
});

const panelRow = (o: Partial<OrderPanelRow['facts']> = {}, zoho_url: string | null = 'https://books.example/so/1'): OrderPanelRow =>
  ({ number: 'SO-00425', zoho_url, facts: { channel: '', reference: '', delivery_method: '', payment_terms: '', shopify_url: null, quote_url: null, ...o } }) as OrderPanelRow;

describe('OrderRefChips', () => {
  it('links a Shopify order to Shopify and a quote to Books; a bare reference is plain text', () => {
    const { unmount } = render(<OrderRefChips row={panelRow({ channel: 'Shopify', reference: '1038', shopify_url: 'https://shop.example/o/1', delivery_method: 'Pickup', payment_terms: 'Due on receipt' })} />);
    const zoho = screen.getByRole('link', { name: /Zoho Books · SO-00425/ });
    expect(zoho).toHaveAttribute('href', 'https://books.example/so/1');
    expect(zoho).toHaveAttribute('target', '_blank');
    expect(zoho).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('link', { name: /Shopify · #1038/ })).toHaveAttribute('href', 'https://shop.example/o/1');
    expect(screen.getByText('Pickup').closest('a')).toBeNull();
    expect(screen.getByText('Due on receipt')).toBeInTheDocument();
    unmount();

    const quote = render(<OrderRefChips row={panelRow({ reference: 'DEV26-2671', quote_url: 'https://books.example/q/1' })} />);
    expect(screen.getByRole('link', { name: /Quote · DEV26-2671/ })).toHaveAttribute('href', 'https://books.example/q/1');
    quote.unmount();

    const bare = render(<OrderRefChips row={panelRow({ reference: 'DEV26-2671' })} />);
    const chip = within(bare.container).getByText((_, el) => el?.textContent === 'Quote · DEV26-2671' && el.tagName === 'SPAN' && el.className.includes('rounded-full'));
    expect(chip.closest('a')).toBeNull();
  });
});

describe('PaymentPill', () => {
  it('the row pill keeps its label short; overdue is hidden text, the title and the full text content', () => {
    const { container } = render(<PaymentPill state="partial" pct={40} overdue fill />);
    const pill = container.firstElementChild as HTMLElement;
    expect(pill).toHaveAttribute('title', '40% paid · overdue');
    expect(pill).not.toHaveAttribute('aria-label');
    expect(pill.textContent).toBe('40% paid · overdue');
    expect(screen.getByText('40% paid')).toBeInTheDocument();
    expect(screen.getByText(/· overdue/)).toHaveClass('sr-only');
    expect((container.querySelector('[aria-hidden="true"].absolute') as HTMLElement).style.width).toBe('40%');
  });

  it('the block pill shows the overdue suffix', () => {
    render(<PaymentPill state="partial" pct={40} overdue />);
    expect(screen.getByText('40% paid · overdue')).toBeInTheDocument();
  });

  it('a paid row pill reads exactly Paid', () => {
    const { container } = render(<PaymentPill state="paid" pct={100} fill />);
    expect(container).toHaveTextContent(/^Paid$/);
  });
});

describe('PaymentPill row colours', () => {
  it('a partial row pill label is not muted, and an overdue one keeps a white label with a red ring', () => {
    render(<PaymentPill state="partial" pct={40} fill />);
    expect(screen.getByText('40% paid').className).not.toContain('text-bambu-gray');
    expect(screen.getByText('40% paid').parentElement!.className).toContain('text-white');
  });

  it('overdue partial: red ring, label not red; overdue unpaid keeps red text', () => {
    const { container } = render(
      <>
        <PaymentPill state="partial" pct={40} overdue fill />
        <PaymentPill state="unpaid" overdue fill />
      </>,
    );
    const [partial, unpaid] = Array.from(container.children) as HTMLElement[];
    expect(partial.className).toContain('ring-red-500/60');
    expect(partial.className).not.toContain('text-red');
    expect(unpaid.className).toContain('text-red-700');
    expect(unpaid.className).not.toContain('ring-red');
  });
});

describe('OrderLinesPanel layout', () => {
  it('the lines scroll in a focusable named region and the side column does not stick', () => {
    const row = {
      id: 'so1', number: 'SO-1', customer: 'X', date: '2026-09-12', total: 1, currency: 'XPF', age_days: 1, is_core: true,
      ready_ratio: 1, packed: 0, unbilled_units: 0, prep: null, customer_id: '', payment: pay(), contact: contact(),
      facts: { channel: '', reference: '', delivery_method: '', payment_terms: '', shopify_url: null, quote_url: null },
      units: { total: 0, shipped: 0, ready: 0, backordered: 0, to_order: 0 }, packages: [], lines: [], zoho_url: null,
    } as unknown as OrderPanelRow;
    render(<OrderLinesPanel row={row} />);
    const region = screen.getByRole('region', { name: 'Product' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region.className).toContain('lg:overflow-y-auto');
    const side = screen.getByText('Teva Marchand').closest('.space-y-3') as HTMLElement;
    expect(side.className).not.toContain('sticky');
  });
});
