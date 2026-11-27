import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { useQuery } from '@tanstack/react-query';
import { render } from '../../utils';
import { quotesQuery } from '../../../components/orders/quotes';
import { NewOrderDraftRow } from '../../../components/orders/NewOrderDraftRow';
import type { OrderItemHit, QuoteLine, QuoteRow } from '../../../api/client';
import { formatMoney } from '../../../utils/pricing';

const DRAFT_KEY = 'orders.newOrderDraft.v1';
const DEFAULT_ID = 'walk-in';
const item = (o: Partial<OrderItemHit> = {}): OrderItemHit => ({
  id: 'A', name: 'Bambu Lab PLA Basic Noir', sku: 'BL-PLA-BK', rate: 1000, stock_on_hand: 9, product_type: 'goods', ...o,
});
const seed = (lines: { item: OrderItemHit; quantity: number; discount: string }[]) =>
  localStorage.setItem(DRAFT_KEY, JSON.stringify({ lines, client: null, clientRef: '11111111-1111-4111-8111-111111111111' }));

const boardResult = { board: { rows: [], computed_at: null, stock_loaded_at: null, sync: {} }, row: null, salesorder_id: '9' };

beforeEach(() => {
  server.use(
    http.get('/api/v1/zoho/status', () =>
      HttpResponse.json({ configured: true, reachable: true, default_contact_id: DEFAULT_ID, default_contact_name: 'Client de passage' })),
    http.get('/api/v1/order-board/items', () => HttpResponse.json({ items: [item()] })),
  );
});

afterEach(() => {
  server.resetHandlers();
  localStorage.clear();
});

const renderRow = (onCreated = vi.fn(), onClose = vi.fn()) => {
  render(<NewOrderDraftRow currency="XPF" open={[]} finished={[]} onCreated={onCreated} onClose={onClose} />);
  return { onCreated, onClose };
};
const payBtn = () => screen.getByRole('button', { name: /^Pay\s\d/ });
// "Create the order" lives in the menu of the Pay button's arrow.
const createOrder = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Other options' }));
  await user.click(screen.getByRole('menuitem', { name: /^Create order/ }));
};
const lineTotal = () => screen.getByTestId('draft-line-total');

describe('NewOrderDraftRow', () => {
  it('starts on the client de passage', async () => {
    renderRow();
    expect(await screen.findByDisplayValue('Client de passage')).toBeInTheDocument();
    expect(screen.queryByTestId('order-client-history')).not.toBeInTheDocument();
  });

  it('adding the same item twice bumps quantity', async () => {
    const user = userEvent.setup();
    renderRow();
    const search = screen.getByLabelText('Scan or search: name, SKU, EAN, reference…');
    await user.type(search, 'pla');
    await user.click(await screen.findByRole('button', { name: /^Bambu Lab PLA Basic Noir/ }, { timeout: 3000 }));
    await user.type(search, 'pla');
    await user.click(await screen.findByRole('button', { name: /^Bambu Lab PLA Basic Noir/ }, { timeout: 3000 }));
    expect(screen.getByLabelText('Qty · Bambu Lab PLA Basic Noir')).toHaveValue(2);
    expect(screen.getAllByTestId('draft-line-total')).toHaveLength(1);
  });

  it('a scanned barcode adds the line once the search answers, and a second scan bumps it', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/v1/order-board/items', ({ request }) => HttpResponse.json({
      items: new URL(request.url).searchParams.get('q') === '3760123456789'
        ? [item({ id: 'B', name: 'PLA Silk Or', sku: 'PLA-SILK' }), item({ ean: '3760123456789' })]
        : [],
    })));
    renderRow();
    const search = screen.getByLabelText('Scan or search: name, SKU, EAN, reference…');
    await user.type(search, '3760123456789{Enter}'); // Enter lands before the search has answered
    await waitFor(() => expect(screen.getByLabelText('Qty · Bambu Lab PLA Basic Noir')).toHaveValue(1));
    expect(search).toHaveValue('');
    expect(screen.queryByLabelText('Qty · PLA Silk Or')).not.toBeInTheDocument();
    await user.type(search, '3760123456789{Enter}');
    await waitFor(() => expect(screen.getByLabelText('Qty · Bambu Lab PLA Basic Noir')).toHaveValue(2));
    expect(search).toHaveValue('');
  });

  it('starts ready to scan, and the results take the place of the lines while typing', async () => {
    const user = userEvent.setup();
    renderRow();
    expect(screen.getByText('Ready to scan')).toBeInTheDocument();
    const search = screen.getByLabelText('Scan or search: name, SKU, EAN, reference…');
    await user.type(search, 'pla');
    expect(screen.queryByText('Ready to scan')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /^Bambu Lab PLA Basic Noir/ }, { timeout: 3000 }));
    expect(screen.getByLabelText('Qty · Bambu Lab PLA Basic Noir')).toHaveValue(1);
    await user.type(search, 'pl');
    expect(screen.queryByLabelText('Qty · Bambu Lab PLA Basic Noir')).not.toBeInTheDocument(); // hidden under the results
    await user.clear(search);
    expect(screen.getByLabelText('Qty · Bambu Lab PLA Basic Noir')).toHaveValue(1);
  });

  it('a picked client shows their Books contact, and phone and email can be edited', async () => {
    const user = userEvent.setup();
    let patched: unknown = null;
    let contact = { id: 'c1', name: 'Heimana PUTOA', company_name: '', customer_sub_type: 'individual', phone: '', mobile: '87 12 34 56', email: '', first_name: 'Heimana', last_name: 'PUTOA' };
    server.use(
      http.get('/api/v1/zoho/contacts/c1', () => HttpResponse.json(contact)),
      http.patch('/api/v1/zoho/contacts/c1', async ({ request }) => {
        patched = await request.json();
        contact = { ...contact, email: 'heimana@example.pf' };
        return new HttpResponse(null, { status: 204 });
      }),
    );
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ lines: [], client: { id: 'c1', name: 'Heimana PUTOA', isDefault: false }, clientRef: '11111111-1111-4111-8111-111111111111' }));
    renderRow();
    expect(await screen.findByRole('link', { name: '87 12 34 56' })).toHaveAttribute('href', 'tel:87123456');
    expect(screen.getByText('No email in Zoho')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit the client' }));
    await user.type(screen.getByLabelText('Email'), 'heimana@example.pf');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('link', { name: 'heimana@example.pf' })).toHaveAttribute('href', 'mailto:heimana@example.pf');
    expect(patched).toEqual({ email: 'heimana@example.pf', phone: '87 12 34 56', phone_field: 'mobile' });
  });

  it('a filament gets a square swatch, anything else a dot', () => {
    seed([
      { item: item({ filament: true }), quantity: 1, discount: '' },
      { item: item({ id: 'N', name: 'Buse 0.4', filament: false }), quantity: 1, discount: '' },
    ]);
    renderRow();
    expect(screen.getAllByTestId('swatch-filament')).toHaveLength(1);
    expect(screen.getAllByTestId('swatch-dot')).toHaveLength(1);
  });

  it('shows a spinner while it waits, then ↓ and Enter add the second hit', async () => {
    const user = userEvent.setup();
    server.use(http.get('/api/v1/order-board/items', () =>
      HttpResponse.json({ items: [item(), item({ id: 'B', name: 'PLA Silk Or', sku: 'PLA-SILK' })] })));
    renderRow();
    const search = screen.getByLabelText('Scan or search: name, SKU, EAN, reference…');
    await user.type(search, 'pla');
    expect(screen.getByTestId('item-search-waiting')).toBeInTheDocument();
    await screen.findByRole('button', { name: /^PLA Silk Or/ }, { timeout: 3000 });
    expect(screen.queryByTestId('item-search-waiting')).not.toBeInTheDocument();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: /^PLA Silk Or/ })).toHaveAttribute('data-active', 'true');
    await user.keyboard('{Enter}');
    expect(screen.getByLabelText('Qty · PLA Silk Or')).toHaveValue(1);
    expect(screen.queryByLabelText('Qty · Bambu Lab PLA Basic Noir')).not.toBeInTheDocument();
  });

  it('a scanned code nothing matches adds nothing', async () => {
    const user = userEvent.setup();
    let answered = 0;
    server.use(http.get('/api/v1/order-board/items', () => {
      answered += 1;
      return HttpResponse.json({ items: [item(), item({ id: 'B', name: 'PLA Silk Or', sku: 'PLA-SILK' })] });
    }));
    renderRow();
    const search = screen.getByLabelText('Scan or search: name, SKU, EAN, reference…');
    await user.type(search, '99999999{Enter}');
    await waitFor(() => expect(answered).toBe(1));
    await screen.findByRole('button', { name: /^PLA Silk Or/ }); // the hits show, none was picked
    expect(screen.queryByTestId('draft-line-total')).not.toBeInTheDocument();
    expect(search).toHaveValue('99999999');
  });

  it('discount 10% and 5 change the line total; 120% blocks create', async () => {
    const user = userEvent.setup();
    let posted = 0;
    server.use(http.post('/api/v1/order-board/orders', () => { posted += 1; return HttpResponse.json(boardResult); }));
    seed([{ item: item(), quantity: 2, discount: '' }]);
    renderRow();
    expect(lineTotal().textContent).toBe(formatMoney(2000, 'XPF'));
    const discount = screen.getByLabelText('Discount · Bambu Lab PLA Basic Noir');
    await user.type(discount, '10%');
    expect(lineTotal().textContent).toBe(formatMoney(1800, 'XPF'));
    await user.clear(discount);
    await user.type(discount, '5');
    expect(lineTotal().textContent).toBe(formatMoney(1995, 'XPF'));
    await user.clear(discount);
    await user.type(discount, '120%');
    expect(discount).toHaveAttribute('aria-invalid', 'true');
    expect(payBtn()).toHaveAttribute('aria-disabled', 'true');
    await createOrder(user);
    expect(await screen.findByText(/a percentage up to 100%/)).toBeInTheDocument();
    expect(posted).toBe(0);
  });

  it('shows "2 to order" when quantity exceeds stock but still creates', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    server.use(http.post('/api/v1/order-board/orders', () => HttpResponse.json(boardResult)));
    seed([{ item: item({ stock_on_hand: 3 }), quantity: 5, discount: '' }]);
    renderRow(onCreated);
    expect(screen.getByText('2 to order')).toBeInTheDocument();
    await screen.findByDisplayValue('Client de passage');
    await createOrder(user);
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it('create sends customer, client_ref and lines then clears the draft', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    let body: unknown = null;
    server.use(http.post('/api/v1/order-board/orders', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(boardResult);
    }));
    seed([{ item: item(), quantity: 2, discount: '10 %' }, { item: item({ id: 'B', name: 'PLA Silk Or' }), quantity: 1, discount: '' }]);
    renderRow(onCreated);
    await screen.findByDisplayValue('Client de passage');
    await createOrder(user);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(boardResult));
    expect(body).toEqual({
      customer_id: DEFAULT_ID,
      client_ref: '11111111-1111-4111-8111-111111111111',
      lines: [{ item_id: 'A', quantity: 2, discount: '10%' }, { item_id: 'B', quantity: 1 }],
    });
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('keeps the draft when create fails', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    server.use(http.post('/api/v1/order-board/orders', () => HttpResponse.json({ detail: 'create_failed' }, { status: 400 })));
    seed([{ item: item(), quantity: 2, discount: '' }]);
    renderRow(onCreated);
    await screen.findByDisplayValue('Client de passage');
    await createOrder(user);
    expect(await screen.findByText(/Order not created: Zoho Books did not confirm/)).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!).lines).toHaveLength(1);
    expect(lineTotal()).toBeInTheDocument();
  });

  it('reset needs a hold and clears lines', async () => {
    seed([{ item: item(), quantity: 2, discount: '' }]);
    renderRow();
    const reset = screen.getByRole('button', { name: /Reset draft/ });
    fireEvent.click(reset);
    expect(lineTotal()).toBeInTheDocument();
    fireEvent.pointerDown(reset);
    await waitFor(() => expect(screen.queryByTestId('draft-line-total')).not.toBeInTheDocument(), { timeout: 2000 });
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('removing a line needs a hold', async () => {
    seed([{ item: item(), quantity: 2, discount: '' }]);
    renderRow();
    const remove = screen.getByRole('button', { name: /^Remove.*Bambu Lab PLA Basic Noir/ });
    fireEvent.click(remove);
    expect(lineTotal()).toBeInTheDocument();
    fireEvent.pointerDown(remove);
    await waitFor(() => expect(screen.queryByTestId('draft-line-total')).not.toBeInTheDocument(), { timeout: 2500 });
  });

  it('abandon closes and keeps the draft', async () => {
    const user = userEvent.setup();
    seed([{ item: item(), quantity: 2, discount: '' }]);
    const { onClose } = renderRow();
    await user.click(screen.getByRole('button', { name: 'Abandon' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull();
  });

  it('escape and the backdrop close the modal', async () => {
    const { onClose } = renderRow();
    const dialog = screen.getByRole('dialog', { name: 'New order' });
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  describe('client picker', () => {
    const contact = (id: string, name: string) => ({
      id, name, company_name: '', customer_sub_type: 'individual', phone: '', mobile: '87 12 34 56', email: '', first_name: 'Tehei', last_name: 'TAIRUA',
    });
    const stubContacts = (found: ReturnType<typeof contact>[]) => {
      for (const c of found) {
        server.use(http.get(`/api/v1/zoho/contacts/${c.id}`, () => HttpResponse.json(c)));
      }
      server.use(http.get('/api/v1/zoho/contacts', () => HttpResponse.json(found)));
    };
    const captureCreate = () => {
      const box: { body: unknown } = { body: null };
      server.use(http.post('/api/v1/order-board/orders', async ({ request }) => {
        box.body = await request.json();
        return HttpResponse.json(boardResult);
      }));
      return box;
    };
    const search = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
      await user.click(screen.getByLabelText('Client'));
      await user.clear(screen.getByLabelText('Client'));
      await user.type(screen.getByLabelText('Client'), text);
    };

    it('picking a search hit sets the client and the order is created for them', async () => {
      const user = userEvent.setup();
      const box = captureCreate();
      stubContacts([contact('c2', 'Tehei TAIRUA')]);
      seed([{ item: item(), quantity: 1, discount: '' }]);
      const { onCreated } = renderRow();
      await screen.findByDisplayValue('Client de passage');
      await search(user, 'teh');
      await user.click(await screen.findByRole('option', { name: /Tehei TAIRUA/ }, { timeout: 3000 }));
      expect(await screen.findByDisplayValue('Tehei TAIRUA')).toBeInTheDocument();
      await waitFor(() => expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!).client).toEqual({ id: 'c2', name: 'Tehei TAIRUA', isDefault: false }));
      await createOrder(user);
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect((box.body as { customer_id: string }).customer_id).toBe('c2');
    });

    it('picking the default contact marks the draft client as the default', async () => {
      const user = userEvent.setup();
      stubContacts([contact(DEFAULT_ID, 'Client de passage')]);
      renderRow();
      await screen.findByDisplayValue('Client de passage');
      await search(user, 'cli');
      await user.click(await screen.findByRole('option', { name: /Client de passage/ }, { timeout: 3000 }));
      await waitFor(() => expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!).client).toEqual({ id: DEFAULT_ID, name: 'Client de passage', isDefault: true }));
      expect(screen.queryByTestId('order-client-history')).not.toBeInTheDocument();
    });

    it('New client opens the form; Back closes it and keeps the client', async () => {
      const user = userEvent.setup();
      renderRow();
      await screen.findByDisplayValue('Client de passage');
      await search(user, 'zz');
      await user.click(await screen.findByRole('button', { name: 'Create new client' }, { timeout: 3000 }));
      expect(screen.getByLabelText(/company name/i)).toBeInTheDocument();
      expect(screen.queryByLabelText('Client')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Back' }));
      expect(screen.queryByLabelText(/company name/i)).not.toBeInTheDocument();
      expect(screen.getByDisplayValue('Client de passage')).toBeInTheDocument();
      expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    });

    it('a client created inline becomes the draft client and receives the order', async () => {
      const user = userEvent.setup();
      const box = captureCreate();
      const created = contact('n1', 'Teva TEMARII');
      server.use(
        http.post('/api/v1/zoho/contacts', () => HttpResponse.json(created, { status: 201 })),
        http.get('/api/v1/zoho/contacts/n1', () => HttpResponse.json(created)),
      );
      seed([{ item: item(), quantity: 1, discount: '' }]);
      const { onCreated } = renderRow();
      await screen.findByDisplayValue('Client de passage');
      await search(user, 'zz');
      await user.click(await screen.findByRole('button', { name: 'Create new client' }, { timeout: 3000 }));
      await user.type(screen.getByLabelText(/first name/i), 'teva');
      await user.type(screen.getByLabelText(/last name/i), 'temarii');
      await user.type(screen.getByLabelText(/^phone/i), '87123456');
      await user.click(screen.getByRole('button', { name: 'Create client' }));
      expect(await screen.findByDisplayValue('Teva TEMARII')).toBeInTheDocument();
      expect(screen.queryByLabelText(/company name/i)).not.toBeInTheDocument();
      await waitFor(() => expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!).client).toEqual({ id: 'n1', name: 'Teva TEMARII', isDefault: false }));
      await createOrder(user);
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect((box.body as { customer_id: string }).customer_id).toBe('n1');
    });

    it('Escape in the form closes the form, not the modal', async () => {
      const user = userEvent.setup();
      const { onClose } = renderRow();
      await screen.findByDisplayValue('Client de passage');
      await search(user, 'zz');
      await user.click(await screen.findByRole('button', { name: 'Create new client' }, { timeout: 3000 }));
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByLabelText(/company name/i)).not.toBeInTheDocument());
      expect(onClose).not.toHaveBeenCalled();
    });

    it('the reset control returns to the client de passage and the order goes to them', async () => {
      const user = userEvent.setup();
      const box = captureCreate();
      stubContacts([contact('c1', 'Heimana PUTOA')]);
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        lines: [{ item: item(), quantity: 1, discount: '' }],
        client: { id: 'c1', name: 'Heimana PUTOA', isDefault: false },
        clientRef: '11111111-1111-4111-8111-111111111111',
      }));
      const { onCreated } = renderRow();
      expect(await screen.findByDisplayValue('Heimana PUTOA')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Reset to the default client' }));
      expect(await screen.findByDisplayValue('Client de passage')).toBeInTheDocument();
      await waitFor(() => expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!).client).toBeNull());
      await createOrder(user);
      await waitFor(() => expect(onCreated).toHaveBeenCalled());
      expect((box.body as { customer_id: string }).customer_id).toBe(DEFAULT_ID);
    });
  });

  describe('quote mode', () => {
    const QUOTE_KEY = 'orders.newQuoteDraft.v1';
    const REF = '22222222-2222-4222-8222-222222222222';
    const qline = (o: Partial<QuoteLine> = {}): QuoteLine => ({
      id: 'ql1', item_id: 'A', name: 'Bambu Lab PLA Basic Noir', sku: 'BL-PLA-BK', quantity: 4, rate: 2500, discount: '10%', total: 9000, available: 14, ...o,
    });
    const quote = (o: Partial<QuoteRow> = {}): QuoteRow => ({
      id: 'e1', number: 'DEV-00412', customer: 'Nautic Service', customer_id: 'c1', date: '2026-11-10', expiry_date: '2026-12-10',
      state: 'sent', total: 248900, currency: 'XPF', reference: '', age_days: 2, is_core: true, editable: true, has_draft_order: false, modified: '',
      lines: [qline(), qline({ id: 'ql2', item_id: 'H', name: 'Bambu Lab H2D', sku: 'H2D', quantity: 1, rate: 239900, discount: null, total: 239900, available: 0 })],
      ...o,
    });
    const quotesResult = { quotes: { rows: [], loading: 0, ready: true }, estimate_id: 'e9' };

    it('a quote draft and an order draft never show each other', () => {
      seed([{ item: item(), quantity: 3, discount: '' }]);
      const { unmount } = render(<NewOrderDraftRow mode="quote" currency="XPF" open={[]} finished={[]} onCreated={vi.fn()} onClose={vi.fn()} />);
      expect(screen.getByRole('dialog', { name: 'New quote' })).toBeInTheDocument();
      expect(screen.getByText('Ready to scan')).toBeInTheDocument();
      unmount();
      localStorage.removeItem(DRAFT_KEY);
      localStorage.setItem(QUOTE_KEY, JSON.stringify({ lines: [{ item: item(), quantity: 3, discount: '' }], client: null, clientRef: REF }));
      renderRow();
      expect(screen.getByText('Ready to scan')).toBeInTheDocument();
      expect(localStorage.getItem(QUOTE_KEY)).toContain(REF);
    });

    it('create sends client_ref and lines to createQuote, reports the new id and clears only the quote draft', async () => {
      const user = userEvent.setup();
      const onCreated = vi.fn();
      let body: unknown = null;
      server.use(http.post('/api/v1/order-board/quotes', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(quotesResult);
      }));
      seed([{ item: item({ id: 'Z', name: 'Other' }), quantity: 1, discount: '' }]);
      localStorage.setItem(QUOTE_KEY, JSON.stringify({ lines: [{ item: item(), quantity: 2, discount: '5%' }], client: null, clientRef: REF }));
      render(<NewOrderDraftRow mode="quote" currency="XPF" open={[]} finished={[]} onCreated={onCreated} onClose={vi.fn()} />);
      await screen.findByDisplayValue('Client de passage');
      await user.click(screen.getByRole('button', { name: 'Create quote' }));
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ estimate_id: 'e9' })));
      expect(body).toEqual({ customer_id: DEFAULT_ID, client_ref: REF, lines: [{ item_id: 'A', quantity: 2, discount: '5%' }] });
      expect(localStorage.getItem(QUOTE_KEY)).toBeNull();
      expect(localStorage.getItem(DRAFT_KEY)).toContain('Other');
    });

    it('edit starts from the quote, keeps line_id on a changed line, sends a new line without one, and never touches storage', async () => {
      const user = userEvent.setup();
      const onCreated = vi.fn();
      let body: unknown = null;
      server.use(
        http.get('/api/v1/order-board/items', () => HttpResponse.json({ items: [item({ id: 'B', name: 'PLA Silk Or', sku: 'PLA-SILK' })] })),
        http.get('/api/v1/zoho/contacts/c1', () => HttpResponse.json({ id: 'c1', name: 'Nautic Service', phone: '', mobile: '', email: '' })),
        http.put('/api/v1/order-board/quotes/e1', async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ ...quotesResult, estimate_id: 'e1' });
        }),
      );
      seed([{ item: item({ id: 'Z', name: 'Other' }), quantity: 1, discount: '' }]);
      const getItem = vi.spyOn(Storage.prototype, 'getItem');
      const setItem = vi.spyOn(Storage.prototype, 'setItem');
      const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
      render(<NewOrderDraftRow mode="quote" quote={quote()} currency="XPF" open={[]} finished={[]} onCreated={onCreated} onClose={vi.fn()} />);
      expect(screen.getByDisplayValue('Nautic Service')).toBeInTheDocument();
      expect(screen.getByLabelText('Qty · Bambu Lab PLA Basic Noir')).toHaveValue(4);
      expect(screen.getByLabelText('Discount · Bambu Lab PLA Basic Noir')).toHaveValue('10%');
      // The quote's own unit price, not the catalogue's.
      expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === formatMoney(2500, 'XPF'))).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reset draft' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'One more · Bambu Lab PLA Basic Noir' }));
      const search = screen.getByLabelText('Scan or search: name, SKU, EAN, reference…');
      await user.type(search, 'silk');
      await user.click(await screen.findByRole('button', { name: /^PLA Silk Or/ }, { timeout: 3000 }));
      await user.click(screen.getByRole('button', { name: 'Save quote' }));
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ estimate_id: 'e1' })));
      expect(body).toEqual({
        customer_id: 'c1',
        lines: [
          { line_id: 'ql1', item_id: 'A', quantity: 5, discount: '10%' },
          { line_id: 'ql2', item_id: 'H', quantity: 1 },
          { item_id: 'B', quantity: 1 },
        ],
      });
      const touched = (spy: typeof getItem | typeof setItem | typeof removeItem) =>
        spy.mock.calls.some(([k]) => k === QUOTE_KEY || k === DRAFT_KEY);
      expect(touched(getItem) || touched(setItem) || touched(removeItem)).toBe(false);
      expect(localStorage.getItem(DRAFT_KEY)).toContain('Other');
    });

    it('a refused quote save speaks of the quote, not of an order', async () => {
      const user = userEvent.setup();
      server.use(http.post('/api/v1/order-board/quotes', () => HttpResponse.json({ detail: 'create_failed' }, { status: 400 })));
      localStorage.setItem(QUOTE_KEY, JSON.stringify({ lines: [{ item: item(), quantity: 1, discount: '' }], client: null, clientRef: REF }));
      render(<NewOrderDraftRow mode="quote" currency="XPF" open={[]} finished={[]} onCreated={vi.fn()} onClose={vi.fn()} />);
      await screen.findByDisplayValue('Client de passage');
      await user.click(screen.getByRole('button', { name: 'Create quote' }));
      expect(await screen.findByText('Quote not saved: Zoho Books did not confirm the quote, nothing was saved')).toBeInTheDocument();
    });

    it('a refused quote edit refetches the quotes list', async () => {
      const user = userEvent.setup();
      let gets = 0;
      server.use(
        http.get('/api/v1/order-board/quotes', () => {
          gets += 1;
          return HttpResponse.json({ rows: [], loading: 0, ready: true });
        }),
        http.get('/api/v1/zoho/contacts/c1', () => HttpResponse.json({ id: 'c1', name: 'Nautic Service', phone: '', mobile: '', email: '' })),
        http.put('/api/v1/order-board/quotes/e1', () => HttpResponse.json({ detail: 'quote_converted' }, { status: 400 })),
      );
      const Probe = () => {
        useQuery(quotesQuery);
        return null;
      };
      render(<><Probe /><NewOrderDraftRow mode="quote" quote={quote()} currency="XPF" open={[]} finished={[]} onCreated={vi.fn()} onClose={vi.fn()} /></>);
      await waitFor(() => expect(gets).toBe(1));
      await user.click(screen.getByRole('button', { name: 'Save quote' }));
      expect(await screen.findByText(/Quote not saved/)).toBeInTheDocument();
      await waitFor(() => expect(gets).toBe(2));
    });

    it('edits a quote whose discounts are an amount ("500") and a percentage ("10.00%"), with the right total', () => {
      const lines = [
        qline({ discount: '500' }), // 4 × 2 500 − 500
        qline({ id: 'ql2', item_id: 'H', name: 'Bambu Lab H2D', sku: 'H2D', quantity: 1, rate: 239900, discount: '10.00%', total: 215910 }),
      ];
      render(<NewOrderDraftRow mode="quote" quote={quote({ lines })} currency="XPF" open={[]} finished={[]} onCreated={vi.fn()} onClose={vi.fn()} />);
      expect(screen.getByLabelText('Discount · Bambu Lab PLA Basic Noir')).toHaveValue('500');
      expect(screen.getByLabelText('Discount · Bambu Lab H2D')).toHaveValue('10.00%');
      expect(screen.getByTestId('draft-total').textContent).toBe(formatMoney(9500 + 215910, 'XPF'));
    });

    it('an expired quote says saving re-dates it to today', () => {
      render(<NewOrderDraftRow mode="quote" quote={quote({ state: 'expired' })} currency="XPF" open={[]} finished={[]} onCreated={vi.fn()} onClose={vi.fn()} />);
      expect(screen.getByText('This quote has expired: saving re-dates it to today.')).toBeInTheDocument();
    });
  });

  describe('counter pay', () => {
    const row = { id: '9', number: 'SO-9', currency: 'XPF', lines: [], payment: { invoices: [] }, packages: [] };
    const payOrder = () => server.use(http.post('/api/v1/order-board/orders', () =>
      HttpResponse.json({ board: { rows: [row], computed_at: null, stock_loaded_at: null, sync: {} }, row, salesorder_id: '9' })));

    it('order mode shows Pay with Create in the menu; quote mode keeps its single button', async () => {
      const user = userEvent.setup();
      seed([{ item: item(), quantity: 2, discount: '' }]);
      renderRow();
      expect(payBtn()).toHaveTextContent(/^Pay\s+2\s*000/);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Other options' }));
      expect(screen.getByRole('menuitem', { name: /^Create order/ })).toHaveTextContent('Prepare and collect later');
    });

    it('quote mode keeps its single button', () => {
      render(<NewOrderDraftRow currency="XPF" open={[]} finished={[]} mode="quote" onCreated={vi.fn()} onClose={vi.fn()} />);
      expect(screen.queryByRole('button', { name: 'Other options' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Pay\s\d/ })).not.toBeInTheDocument();
    });

    it('after Pay the total, reset and Pay buttons are gone and the cart is inert', async () => {
      const user = userEvent.setup();
      payOrder();
      seed([{ item: item(), quantity: 2, discount: '' }]);
      renderRow();
      await user.click(payBtn());
      expect(await screen.findByTestId('counter-pay')).toBeInTheDocument();
      expect(screen.queryByText('Draft')).not.toBeInTheDocument();
      await waitFor(() => expect(JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}').clientRef).not.toBe('11111111-1111-4111-8111-111111111111'));
      expect(screen.queryByTestId('draft-total')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Pay\s\d/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Reset draft/ })).not.toBeInTheDocument();
      expect(screen.getByTestId('draft-line-total').closest('[inert]')).not.toBeNull();
      expect(screen.getByText('Card (terminal)')).toBeInTheDocument();
    });

    it('a failed order creation leaves the draft editable', async () => {
      const user = userEvent.setup();
      server.use(http.post('/api/v1/order-board/orders', () => HttpResponse.json({ detail: 'create_failed' }, { status: 400 })));
      seed([{ item: item(), quantity: 2, discount: '' }]);
      renderRow();
      await user.click(payBtn());
      expect(await screen.findByText(/Order not created: Zoho Books did not confirm/)).toBeInTheDocument();
      await waitFor(() => expect(payBtn()).not.toHaveAttribute('aria-disabled'));
      expect(screen.queryByTestId('counter-pay')).not.toBeInTheDocument();
      expect(lineTotal()).toBeInTheDocument();
    });

    it('Escape does nothing while a step is writing', async () => {
      const user = userEvent.setup();
      server.use(http.post('/api/v1/order-board/orders', async () => {
        await new Promise(r => setTimeout(r, 400));
        return HttpResponse.json({ board: { rows: [row], computed_at: null, stock_loaded_at: null, sync: {} }, row, salesorder_id: '9' });
      }));
      seed([{ item: item(), quantity: 2, discount: '' }]);
      const { onClose } = renderRow();
      await user.click(payBtn());
      await screen.findByTestId('counter-pay');
      await user.keyboard('{Escape}');
      await new Promise(r => setTimeout(r, 300));
      expect(onClose).not.toHaveBeenCalled();
    });

    it('Pay on an empty cart is refused with the reason and posts no order', async () => {
      const user = userEvent.setup();
      let posted = 0;
      server.use(http.post('/api/v1/order-board/orders', () => { posted += 1; return HttpResponse.json({}); }));
      renderRow();
      await user.click(screen.getByRole('button', { name: /^Pay/ }));
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(posted).toBe(0);
      expect(screen.queryByTestId('counter-pay')).not.toBeInTheDocument();
    });

    it('a second sale after New sale gets a fresh client_ref and a fresh credit cap, nothing carried over', async () => {
      const user = userEvent.setup();
      const orders: { client_ref: string; lines: unknown[] }[] = [];
      const invoices: Record<string, unknown>[] = [];
      const recorded: Record<string, unknown>[] = [];
      const rowOf = (id: string, n: string, invNo: string, total: number) =>
        ({ id, number: n, currency: 'XPF', lines: [], packages: [], payment: { invoices: [{ id: `i${id}`, number: invNo, total, balance: 0, status: 'paid', date: '2026-11-26' }] } });
      const rows: Record<string, ReturnType<typeof rowOf>> = {
        '9': rowOf('9', 'SO-9', 'FAC-9', 1000), '10': rowOf('10', 'SO-10', 'FAC-10', 2000),
      };
      const boardOf = (r: unknown) => ({ rows: [r], computed_at: null, stock_loaded_at: null, sync: {} });
      server.use(
        http.post('/api/v1/order-board/orders', async ({ request }) => {
          orders.push(await request.json() as { client_ref: string; lines: unknown[] });
          const id = orders.length === 1 ? '9' : '10';
          return HttpResponse.json({ board: boardOf(rows[id]), row: rows[id], salesorder_id: id });
        }),
        http.get('/api/v1/order-board/orders/:id/payment-target', ({ params }) =>
          HttpResponse.json({ kind: 'salesorder', document_id: params.id, number: `SO-${params.id}`, max_amount: params.id === '9' ? 1000 : 2000, left: params.id === '9' ? 1000 : 2000, link: null })),
        http.get('/api/v1/order-board/orders/:id/terminal-payment', () => HttpResponse.json(null)),
        http.post('/api/v1/order-board/orders/:id/manual-payment', async ({ request }) => {
          recorded.push(await request.json() as Record<string, unknown>);
          return HttpResponse.json({});
        }),
        http.post('/api/v1/order-board/orders/:id/invoice', async ({ request, params }) => {
          invoices.push({ id: params.id, ...(await request.json() as object) });
          const no = params.id === '9' ? 'FAC-9' : 'FAC-10';
          return HttpResponse.json({
            board: boardOf(rows[params.id as string]),
            outcome: { invoice: 'created', invoice_number: no, manual_reason: null, credit_applied: 0, failed_step: null, error: null },
          });
        }),
        http.get('/api/v1/order-board/orders/:id/picklist', () => HttpResponse.json({ lines: [] })),
      );
      renderRow();
      const search = () => screen.getByLabelText('Scan or search: name, SKU, EAN, reference…');
      const addItem = async () => {
        await user.type(search(), 'pla');
        await user.click(await screen.findByRole('button', { name: /^Bambu Lab PLA Basic Noir/ }, { timeout: 3000 }));
      };
      await addItem();
      await user.click(payBtn());
      await user.click(await screen.findByRole('button', { name: 'Cash or cheque' }, { timeout: 3000 }));
      await user.click(await screen.findByRole('button', { name: /^Record|^Save|^Confirm/i }, { timeout: 3000 }));
      await user.click(await screen.findByRole('button', { name: 'New sale' }, { timeout: 5000 }));
      expect(invoices).toEqual([{ id: '9', apply_credit: true, scope: 'whole', credit_cap: 1000 }]);
      // Second sale: a bigger cart, so a different amount; the first sale's 1000 must not come back.
      await addItem();
      await addItem();
      await user.click(payBtn());
      await user.click(await screen.findByRole('button', { name: 'Cash or cheque' }, { timeout: 3000 }));
      await user.click(await screen.findByRole('button', { name: /^Record|^Save|^Confirm/i }, { timeout: 3000 }));
      await user.click(await screen.findByRole('button', { name: 'New sale' }, { timeout: 5000 }));
      expect(orders).toHaveLength(2);
      expect(orders[1].client_ref).not.toBe(orders[0].client_ref);
      expect(orders.map((o) => o.lines)).toEqual([[{ item_id: 'A', quantity: 1 }], [{ item_id: 'A', quantity: 2 }]]);
      expect(recorded).toHaveLength(2);
      expect(invoices).toHaveLength(2);
      expect(invoices[1]).toEqual({ id: '10', apply_credit: true, scope: 'whole', credit_cap: 2000 });
      expect(recorded.map((r) => r.amount)).toEqual([1000, 2000]);
    });

    describe('leaving a sale', () => {
      const target = () => server.use(
        http.get('/api/v1/order-board/orders/9/payment-target', () =>
          HttpResponse.json({ kind: 'salesorder', document_id: '9', number: 'SO-9', max_amount: 2000, left: 2000, link: null })),
        http.get('/api/v1/order-board/orders/9/terminal-payment', () => HttpResponse.json(null)),
      );
      const sale = async () => {
        const user = userEvent.setup();
        payOrder();
        target();
        seed([{ item: item(), quantity: 2, discount: '' }]);
        const onCreated = vi.fn();
        const onClose = vi.fn();
        // The board page observes the board query; without an observer the cache entry is dropped at once.
        const Board = () => { useQuery({ queryKey: ['order-board'], queryFn: () => new Promise(() => {}) }); return null; };
        render(<><Board /><NewOrderDraftRow currency="XPF" open={[]} finished={[]} onCreated={onCreated} onClose={onClose} /></>);
        await user.click(payBtn());
        await screen.findByText('Card (terminal)');
        await waitFor(() => expect(screen.getByRole('button', { name: 'Abandon' })).toBeEnabled());
        return { user, onCreated, onClose };
      };
      const opened = (onCreated: ReturnType<typeof vi.fn>) =>
        expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ salesorder_id: '9' }));

      it('Escape and the X open the created order when nothing is writing', async () => {
        const { user, onCreated, onClose } = await sale();
        await user.keyboard('{Escape}');
        opened(onCreated);
        expect(onClose).not.toHaveBeenCalled();
        onCreated.mockClear();
        await user.click(screen.getByRole('button', { name: 'Abandon' }));
        opened(onCreated);
      });

      it('leaving a sale with no board in the cache just closes the modal', async () => {
        const user = userEvent.setup();
        payOrder();
        target();
        seed([{ item: item(), quantity: 2, discount: '' }]);
        const { onCreated, onClose } = renderRow();
        await user.click(payBtn());
        await screen.findByText('Card (terminal)');
        await waitFor(() => expect(screen.getByRole('button', { name: 'Abandon' })).toBeEnabled());
        await user.keyboard('{Escape}');
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(onCreated).not.toHaveBeenCalled();
      });

      it('Escape and the X do nothing while a payment dialog is open', async () => {
        const { user, onCreated } = await sale();
        await user.click(screen.getByRole('button', { name: 'Cash or cheque' }));
        await screen.findByRole('radio', { name: 'Cash' }, { timeout: 3000 });
        expect(screen.getByRole('button', { name: 'Abandon' })).toBeDisabled();
        await user.keyboard('{Escape}');
        await new Promise(r => setTimeout(r, 300));
        expect(onCreated).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: 'New order' })).toBeInTheDocument();
      });

      it('the X is disabled while a step is writing', async () => {
        server.use(http.post('/api/v1/order-board/orders', async () => {
          await new Promise(r => setTimeout(r, 400));
          return HttpResponse.json({ board: { rows: [row], computed_at: null, stock_loaded_at: null, sync: {} }, row, salesorder_id: '9' });
        }));
        const user = userEvent.setup();
        seed([{ item: item(), quantity: 2, discount: '' }]);
        const { onCreated } = renderRow();
        await user.click(payBtn());
        expect(screen.getByRole('button', { name: 'Abandon' })).toBeDisabled();
        await screen.findByText('Card (terminal)');
        expect(onCreated).not.toHaveBeenCalled();
      });

      it('leaving from an error opens the order too', async () => {
        const { user, onCreated } = await sale();
        server.use(
          http.post('/api/v1/order-board/orders/9/manual-payment', () => HttpResponse.json({ board: { rows: [] } })),
          http.post('/api/v1/order-board/orders/9/invoice', () => HttpResponse.json({ detail: 'zoho_down' }, { status: 502 })),
        );
        await user.click(screen.getByRole('button', { name: 'Cash or cheque' }));
        await user.click(await screen.findByRole('button', { name: /^Record|^Save|^Confirm/i }, { timeout: 3000 }));
        await screen.findByRole('button', { name: 'Retry' }, { timeout: 3000 });
        await user.keyboard('{Escape}');
        opened(onCreated);
      });
    });
  });
});
