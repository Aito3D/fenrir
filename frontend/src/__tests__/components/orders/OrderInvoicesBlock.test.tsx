/** The Invoices card of an opened order. */
process.env.TZ = 'Pacific/Tahiti';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import type { OrderBoardRow, OrderInvoice, OrderPayment } from '../../../api/client';
import { render } from '../../utils';
import { OrderInvoicesBlock } from '../../../components/orders/OrderInvoicesBlock';

const inv = (o: Partial<OrderInvoice> = {}): OrderInvoice => ({
  id: 'inv1', number: 'FAC-0001', date: '2026-10-01', due_date: '2099-01-01', total: 250000, balance: 250000, status: 'sent',
  url: 'https://books.example/inv/inv1', ...o,
});

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const pay = (invoices: OrderInvoice[]): OrderPayment => ({
  state: 'partial', pct: 40, paid: 0, invoice_paid: 0, advance: 0, due: 0, overdue: 0, rest: 0, left: 0, next_due: null, invoices,
});

const row = (invoices: OrderInvoice[] | null, o: Partial<OrderBoardRow> = {}) =>
  ({ id: 'so1', currency: 'XPF', unbilled_units: 0, payment: invoices ? pay(invoices) : null, ...o }) as OrderBoardRow;

describe('OrderInvoicesBlock', () => {
  beforeEach(() => {
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    server.resetHandlers();
  });

  it('lists each invoice with number, amount, status and its three actions', () => {
    render(<OrderInvoicesBlock row={row([inv(), inv({ id: 'inv2', number: 'FAC-0002', url: null, due_date: day(-5), balance: 100 })])} />);
    expect(screen.getByText('Invoices')).toBeInTheDocument();
    expect(screen.getByText('FAC-0001')).toBeInTheDocument();
    expect(screen.getByText('FAC-0002')).toBeInTheDocument();
    expect(screen.getAllByText(/250.000/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Download invoice' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Print invoice' })).toHaveLength(2);
    // The link is hidden when Books gave no url.
    expect(screen.getAllByRole('link', { name: 'Open in Zoho Books' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Open in Zoho Books' })).toHaveAttribute('href', 'https://books.example/inv/inv1');
    expect(screen.getByText(/^Due /)).toBeInTheDocument();
    expect(screen.getByText(/^Overdue 5 d/)).toBeInTheDocument();
  });

  it('a draft reads Draft and a paid invoice Paid', () => {
    render(<OrderInvoicesBlock row={row([inv({ status: 'draft', balance: 250000 }), inv({ id: 'inv2', number: 'FAC-0002', status: 'paid', balance: 0 })])} />);
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
  });

  it('an invoice with a balance but no due date reads as awaiting payment, never Invalid Date', () => {
    render(<OrderInvoicesBlock row={row([inv({ due_date: '' })])} />);
    expect(screen.getByText('Invoiced, awaiting payment')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
  });

  it('says no invoice yet when there is none, also without payment figures', () => {
    const { unmount } = render(<OrderInvoicesBlock row={row([])} />);
    expect(screen.getByText(/No invoice yet/)).toBeInTheDocument();
    unmount();
    render(<OrderInvoicesBlock row={row(null)} />);
    expect(screen.getByText(/No invoice yet/)).toBeInTheDocument();
  });

  it('offers Create invoice only when units were handed over without one and a handler is given', async () => {
    const user = userEvent.setup();
    const onCreateInvoice = vi.fn();
    const unbilled = row([], { unbilled_units: 3 });
    const { unmount } = render(<OrderInvoicesBlock row={unbilled} />);
    expect(screen.queryByRole('button', { name: 'Create invoice' })).not.toBeInTheDocument();
    unmount();
    const { unmount: u2 } = render(<OrderInvoicesBlock row={row([])} onCreateInvoice={onCreateInvoice} />);
    expect(screen.queryByRole('button', { name: 'Create invoice' })).not.toBeInTheDocument();
    u2();
    render(<OrderInvoicesBlock row={unbilled} onCreateInvoice={onCreateInvoice} />);
    expect(screen.getByText('3 units handed over without an invoice')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create invoice' }));
    expect(onCreateInvoice).toHaveBeenCalledTimes(1);
  });

  it('download asks the order-board invoice endpoint', async () => {
    const user = userEvent.setup();
    let hit = false;
    server.use(
      http.get('*/order-board/invoices/inv1/pdf', () => {
        hit = true;
        return new HttpResponse(new Blob(['%PDF-']), { headers: { 'Content-Type': 'application/pdf' } });
      }),
    );
    render(<OrderInvoicesBlock row={row([inv()])} />);
    await user.click(screen.getByRole('button', { name: 'Download invoice' }));
    await waitFor(() => expect(hit).toBe(true));
  });
});
