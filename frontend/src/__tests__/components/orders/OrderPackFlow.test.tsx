/** The prep band of an opened order: choosing what to pick, the picklist's sheet, and the parcel check. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import type { OrderBoardLine, OrderPanelRow } from '../../../api/client';

const mockUseAuth = {
  user: { id: 1, username: 'operator', permissions: [] as string[] },
  authEnabled: true, requiresSetup: false, loading: false, isAdmin: false,
  login: vi.fn(), loginWithToken: vi.fn(), logout: vi.fn(), refreshUser: vi.fn(), refreshAuth: vi.fn(),
  hasPermission: vi.fn((_permission: string) => true),
  hasAnyPermission: vi.fn(() => true), hasAllPermissions: vi.fn(() => true), canModify: vi.fn(() => true),
};
vi.mock('../../../contexts/AuthContext', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => mockUseAuth };
});
const print = vi.fn((produce: () => Promise<Blob>) => produce());
vi.mock('../../../components/aito/usePrintBlob', () => ({ usePrintBlob: () => ({ print, busy: false }) }));

import { render } from '../../utils';
import { holdToConfirm } from '../../holdHelpers';
import { OrderLinesPanel } from '../../../components/orders/OrderLinesPanel';

afterEach(() => {
  server.resetHandlers();
  print.mockClear();
  mockUseAuth.hasPermission.mockImplementation(() => true);
});

const line = (o: Partial<OrderBoardLine> = {}): OrderBoardLine => ({
  id: 'l1', item_id: 'A', name: 'Bambu Lab PLA Basic Noir', sku: 'BL-PLA-BK', state: 'ready', quantity: 2, shipped: 0,
  cancelled: 0, remaining: 2, invoiced: 0, packed_waiting: 0, stock_available: 2, covered: 2, packable: 2, shortfall: 0, rate: 3400, floor: 0,
  covered_by_po: 0, po_numbers: [], ...o,
});
const panelRow = (o: Partial<OrderPanelRow> = {}, lines = [line()]): OrderPanelRow => ({
  id: 'so1', number: 'SO-00412', customer: 'Lycée de Taravao', date: '2026-09-12', total: 13600, currency: 'XPF',
  age_days: 5, is_core: true, ready_ratio: 1, packed: 0, unbilled_units: 0, prep: null, customer_id: '', payment: null, contact: null,
  facts: { channel: '', reference: '', shopify_order: '', quote_number: '', delivery_method: '', payment_terms: '', shopify_url: null, quote_url: null }, version: 'v1', estimable: true,
  units: { total: 2, shipped: 0, ready: 2, backordered: 0, to_order: 0 }, packages: [], lines,
  zoho_url: null, ...o,
});

const created = (board = {}) => ({ board: { rows: [], computed_at: null, stock_loaded_at: null, sync: {}, ...board }, package_number: 'PKG-7' });
const qty = (id = 'l1') => screen.getByTestId(`pack-qty-${id}`) as HTMLInputElement;
const BASE = '/api/v1/order-board/orders/so1';
const L1 = [{ line_id: 'l1', quantity: 2 }];
const preview = (lines = L1) => http.get(`${BASE}/picklist`, () => HttpResponse.json({ lines }));
const content = (lines = L1) => http.get(`${BASE}/picklists/pl1`, () => HttpResponse.json({ id: 'pl1', number: 'PL-00013', status: 'yet_to_start', lines }));
const picklist = (status = 'yet_to_start') => ({ id: 'pl1', number: 'PL-00013', status, date: '2026-11-06' });
/** An order whose picklist is open in Books. */
const picking = (o: Partial<OrderPanelRow> = {}) => panelRow({ picklists: [picklist()], picked: 0, ...o });
const two = [line(), line({ id: 'l2', name: 'Filament B', packable: 5, quantity: 5, remaining: 5 })];

describe('the prep band', () => {
  it('offers Prepare with orders:update while the shelf holds something and no picklist is open', () => {
    const first = render(<OrderLinesPanel row={panelRow()} />);
    expect(screen.getByRole('button', { name: 'Prepare' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Prep sheet/ })).not.toBeInTheDocument();
    first.unmount();
    mockUseAuth.hasPermission.mockImplementation(() => false);
    const second = render(<OrderLinesPanel row={panelRow()} />);
    expect(screen.queryByRole('button', { name: 'Prepare' })).not.toBeInTheDocument();
    second.unmount();
    mockUseAuth.hasPermission.mockImplementation(() => true);
    render(<OrderLinesPanel row={panelRow({}, [line({ packable: 0 })])} />);
    expect(screen.queryByRole('button', { name: 'Prepare' })).not.toBeInTheDocument();
  });

  it('an open picklist shows its number, its sheet and its parcel, and no second Prepare', () => {
    const first = render(<OrderLinesPanel row={picking()} />);
    expect(screen.getByText('PL-00013')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prep sheet · PL-00013' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create parcel · PL-00013' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepare' })).not.toBeInTheDocument();
    first.unmount();
    mockUseAuth.hasPermission.mockImplementation(() => false);
    render(<OrderLinesPanel row={picking()} />);
    expect(screen.getByRole('button', { name: 'Prep sheet · PL-00013' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create parcel/ })).not.toBeInTheDocument();
  });

  it('a completed picklist keeps its parcel button only while picked units wait for a box', () => {
    const first = render(<OrderLinesPanel row={panelRow({ picklists: [picklist('completed')], picked: 0 })} />);
    expect(screen.queryByRole('button', { name: /Create parcel/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare' })).toBeInTheDocument();
    first.unmount();
    render(<OrderLinesPanel row={panelRow({ picklists: [picklist('completed')], picked: 2 })} />);
    expect(screen.getByRole('button', { name: 'Create parcel · PL-00013' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare' })).toBeInTheDocument();
  });

  it('a printed order reads Printed at … by … and offers Reprint', () => {
    const at = '2026-11-06T18:30:00+00:00';
    const time = new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const first = render(<OrderLinesPanel row={picking({ prep: { at, by: 'Hina' } })} />);
    expect(screen.getByText(`Printed at ${time} by Hina`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reprint · PL-00013' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Prep sheet/ })).not.toBeInTheDocument();
    first.unmount();
    render(<OrderLinesPanel row={picking({ prep: { at, by: '' } })} />);
    expect(screen.getByText(`Printed at ${time}`)).toBeInTheDocument();
  });

  it('printing asks for the sheet of that picklist', async () => {
    const user = userEvent.setup();
    const asked: (string | null)[] = [];
    server.use(http.post(`${BASE}/prep-sheet`, ({ request }) => { asked.push(new URL(request.url).searchParams.get('picklist_id')); return new HttpResponse('%PDF', { headers: { 'Content-Type': 'application/pdf' } }); }));
    render(<OrderLinesPanel row={picking()} />);
    await user.click(screen.getByRole('button', { name: 'Prep sheet · PL-00013' }));
    await waitFor(() => expect(asked).toEqual(['pl1']));
    expect(print).toHaveBeenCalledTimes(1);
  });
});

describe('choosing what to pick', () => {
  it('opens on what Zoho allows, every line ticked at its maximum', async () => {
    const user = userEvent.setup();
    server.use(preview());
    render(<OrderLinesPanel row={panelRow({}, [line(), line({ id: 'l2', name: 'AMS', packable: 0, state: 'backorder', stock_available: 0 })])} />);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    await waitFor(() => expect(qty()).toHaveValue(2));
    expect(screen.getByRole('checkbox', { name: /^To pick · Bambu Lab PLA/ })).toBeChecked();
    expect(screen.getByRole('columnheader', { name: 'To pick' })).toBeInTheDocument();
    expect(screen.queryByTestId('pack-qty-l2')).not.toBeInTheDocument();
    expect(screen.getByText(/Picklist: 2 of 2 in stock/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepare' })).not.toBeInTheDocument();
  });

  it('a line can be left out, put back, and its units typed', async () => {
    const user = userEvent.setup();
    server.use(preview([...L1, { line_id: 'l2', quantity: 5 }]));
    render(<OrderLinesPanel row={panelRow({}, two)} />);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    const tick = await screen.findByRole('checkbox', { name: 'To pick · Filament B' });
    await user.click(tick);
    expect(qty('l2')).toHaveValue(0);
    expect(screen.getByText(/Picklist: 2 of 7 in stock/)).toBeInTheDocument();
    expect(screen.getByText(/5 left to prepare/)).toBeInTheDocument();
    await user.click(tick);
    expect(qty('l2')).toHaveValue(5);
    await user.clear(qty('l2'));
    await user.type(qty('l2'), '3');
    expect(screen.getByText(/Picklist: 5 of 7 in stock/)).toBeInTheDocument();
    expect(tick).toBeChecked();
    await user.clear(qty('l2'));
    await user.type(qty('l2'), '9'); // above what Zoho allows: not taken, and put right when the field is left
    expect(screen.getByText(/Picklist: 5 of 7 in stock/)).toBeInTheDocument();
    await user.tab();
    expect(qty('l2')).toHaveValue(5);
  });

  it('walks a fractional maximum by one, clamped to 0..max', async () => {
    const user = userEvent.setup();
    server.use(preview([{ line_id: 'l1', quantity: 2.5 }]));
    render(<OrderLinesPanel row={panelRow({}, [line({ packable: 2.5, quantity: 2.5, remaining: 2.5 })])} />);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    await waitFor(() => expect(qty()).toHaveValue(2.5));
    const walk = async (name: RegExp, expected: number[]) => {
      for (const v of expected) {
        await user.click(screen.getByRole('button', { name }));
        expect(qty()).toHaveValue(v);
      }
    };
    await walk(/^One less/, [1.5, 0.5, 0]);
    await walk(/^One more/, [1, 2, 2.5, 2.5]);
  });

  it('creates the picklist with the chosen lines, then prints its sheet', async () => {
    const user = userEvent.setup();
    let body: unknown;
    const sheets: (string | null)[] = [];
    server.use(
      preview([...L1, { line_id: 'l2', quantity: 5 }]),
      http.post(`${BASE}/picklists`, async ({ request }) => { body = await request.json(); return HttpResponse.json({ ...created(), picklist: { id: 'pl1', number: 'PL-00013' } }); }),
      http.post(`${BASE}/prep-sheet`, ({ request }) => { sheets.push(new URL(request.url).searchParams.get('picklist_id')); return new HttpResponse('%PDF', { headers: { 'Content-Type': 'application/pdf' } }); }),
    );
    render(<OrderLinesPanel row={panelRow({}, two)} />);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    await user.click(await screen.findByRole('checkbox', { name: 'To pick · Filament B' }));
    await user.click(screen.getAllByRole('button', { name: /^One less/ })[0]);
    await user.click(screen.getByRole('button', { name: 'Create and print' }));
    expect(await screen.findByText('Picklist PL-00013 created in Zoho Books')).toBeInTheDocument();
    expect(body).toEqual({ lines: [{ line_id: 'l1', quantity: 1 }] });
    await waitFor(() => expect(sheets).toEqual(['pl1']));
    expect(print).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('pack-qty-l1')).not.toBeInTheDocument();
  });

  it('nothing left to pick says so and opens no check', async () => {
    const user = userEvent.setup();
    server.use(preview([]));
    render(<OrderLinesPanel row={panelRow()} />);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    expect(await screen.findByText(/Nothing left to pick/)).toBeInTheDocument();
    expect(screen.queryByTestId('pack-qty-l1')).not.toBeInTheDocument();
  });

  it('a refused opening says why', async () => {
    const user = userEvent.setup();
    server.use(http.get(`${BASE}/picklist`, () => HttpResponse.json({ detail: 'picklist_open' }, { status: 400 })));
    render(<OrderLinesPanel row={panelRow()} />);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    expect(await screen.findByText('The picklist could not be created: a picklist is still open on this order, finish it first')).toBeInTheDocument();
    expect(screen.queryByTestId('pack-qty-l1')).not.toBeInTheDocument();
  });

  it('a refused picklist keeps the choice open and says why', async () => {
    const user = userEvent.setup();
    server.use(preview(), http.post(`${BASE}/picklists`, () => HttpResponse.json({ detail: 'Books said no' }, { status: 502 })));
    render(<OrderLinesPanel row={panelRow()} />);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    await user.click(await screen.findByRole('button', { name: 'Create and print' }));
    expect(await screen.findByText('The picklist could not be created: Books said no')).toBeInTheDocument();
    expect(qty()).toBeInTheDocument();
    expect(print).not.toHaveBeenCalled();
  });

  it('a second click on the row icon keeps what was typed', async () => {
    const user = userEvent.setup();
    let asked = 0;
    server.use(http.get(`${BASE}/picklist`, () => { asked++; return HttpResponse.json({ lines: L1 }); }));
    const view = render(<OrderLinesPanel row={panelRow()} start="pick" startTick={1} />);
    await waitFor(() => expect(qty()).toHaveValue(2));
    await user.click(screen.getByRole('button', { name: /^One less/ }));
    view.rerender(<OrderLinesPanel row={panelRow()} start="pick" startTick={2} />);
    await new Promise(r => setTimeout(r, 50));
    expect(qty()).toHaveValue(1);
    expect(asked).toBe(1);
  });

  it('a picklist answered without an id is created but asks for no sheet', async () => {
    const user = userEvent.setup();
    let sheets = 0;
    server.use(
      preview(),
      http.post(`${BASE}/picklists`, () => HttpResponse.json({ ...created(), picklist: { id: '', number: '' } })),
      http.post(`${BASE}/prep-sheet`, () => { sheets++; return new HttpResponse('%PDF'); }),
    );
    render(<OrderLinesPanel row={panelRow()} />);
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    await user.click(await screen.findByRole('button', { name: 'Create and print' }));
    await waitFor(() => expect(screen.queryByTestId('pack-qty-l1')).not.toBeInTheDocument());
    expect(sheets).toBe(0);
    expect(print).not.toHaveBeenCalled();
  });

  it('the row icon opens the choice, or the parcel check of a picklist', async () => {
    server.use(preview(), content());
    const first = render(<OrderLinesPanel row={panelRow()} start="pick" startTick={1} />);
    expect(await screen.findByText(/Picklist: 2 of 2 in stock/)).toBeInTheDocument();
    first.unmount();
    render(<OrderLinesPanel row={picking()} start="pack-pl1" startTick={1} />);
    expect(await screen.findByText(/Parcel: 2 of 2 on PL-00013/)).toBeInTheDocument();
  });
});

describe('the parcel check', () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'Create parcel · PL-00013' }));
    await waitFor(() => expect(qty()).toBeInTheDocument());
  };

  it('opens on what the picklist holds and sends the picklist with the lines above zero', async () => {
    const user = userEvent.setup();
    let body: unknown;
    server.use(
      content([...L1, { line_id: 'l2', quantity: 5 }]),
      http.post(`${BASE}/packages`, async ({ request }) => { body = await request.json(); return HttpResponse.json(created()); }),
    );
    render(<OrderLinesPanel row={picking({ lines: two })} />);
    await open(user);
    expect(qty()).toHaveValue(2);
    expect(screen.getByRole('columnheader', { name: 'In the parcel' })).toBeInTheDocument();
    expect(screen.getByText(/Parcel: 7 of 7 on PL-00013/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'In the parcel · Filament B' }));
    expect(screen.getByText(/5 left to prepare/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create parcel' }));
    expect(await screen.findByText('Parcel PKG-7 created in Zoho Books')).toBeInTheDocument();
    expect(body).toEqual({ picklist_id: 'pl1', lines: [{ line_id: 'l1', quantity: 2 }] });
    expect(screen.queryByTestId('pack-qty-l1')).not.toBeInTheDocument();
  });

  it('a fractional maximum is sent as is', async () => {
    const user = userEvent.setup();
    let body: unknown;
    server.use(
      content([{ line_id: 'l1', quantity: 2.5 }]),
      http.post(`${BASE}/packages`, async ({ request }) => { body = await request.json(); return HttpResponse.json(created()); }),
    );
    render(<OrderLinesPanel row={picking({ lines: [line({ packable: 2.5, quantity: 2.5, remaining: 2.5 })] })} />);
    await open(user);
    await user.click(screen.getByRole('button', { name: 'Create parcel' }));
    await waitFor(() => expect(body).toEqual({ picklist_id: 'pl1', lines: [{ line_id: 'l1', quantity: 2.5 }] }));
  });

  it('a picklist already boxed says so and opens no check', async () => {
    const user = userEvent.setup();
    server.use(content([]));
    render(<OrderLinesPanel row={picking()} />);
    await user.click(screen.getByRole('button', { name: 'Create parcel · PL-00013' }));
    expect(await screen.findByText('Everything on this picklist is already in a parcel.')).toBeInTheDocument();
    expect(screen.queryByTestId('pack-qty-l1')).not.toBeInTheDocument();
  });

  it.each([
    [400, 'too_many', 'The parcel could not be created: more units than the order still allows'],
    [409, 'busy', 'The order changed, check the quantities.'],
    [503, 'unavailable', 'Zoho is busy, try again in a moment.'],
    [502, 'Books said no', 'The parcel could not be created: Books said no'],
  ])('a refused parcel (%i) keeps the check open and says why', async (status, detail, text) => {
    const user = userEvent.setup();
    server.use(content(), http.post(`${BASE}/packages`, () => HttpResponse.json({ detail }, { status })));
    render(<OrderLinesPanel row={picking()} />);
    await open(user);
    await user.click(screen.getByRole('button', { name: 'Create parcel' }));
    const shown = await screen.findAllByText((_c, el) => (el?.textContent ?? '').includes(text) && el?.children.length === 0);
    expect(shown.length).toBeGreaterThan(0);
    expect(qty()).toBeInTheDocument();
  });

  it('cancel closes the check', async () => {
    const user = userEvent.setup();
    server.use(content());
    render(<OrderLinesPanel row={picking()} />);
    await open(user);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('pack-qty-l1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create parcel · PL-00013' })).toHaveFocus();
  });

  it('sends one request however often confirm is hit, and locks the line meanwhile', async () => {
    const user = userEvent.setup();
    let hits = 0;
    server.use(content(), http.post(`${BASE}/packages`, async () => {
      hits++;
      await new Promise(r => setTimeout(r, 150));
      return HttpResponse.json(created());
    }));
    render(<OrderLinesPanel row={picking()} />);
    await open(user);
    const confirm = screen.getByRole('button', { name: 'Create parcel' });
    await user.click(confirm);
    await user.click(confirm);
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: /^One less/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /^In the parcel/ })).toBeDisabled();
    expect(qty()).toBeDisabled();
    expect(await screen.findByText('Parcel PKG-7 created in Zoho Books')).toBeInTheDocument();
    expect(hits).toBe(1);
  });
});

describe('cancel order', () => {
  it('needs orders:update, a short tap only hints, a 1s hold posts the cancel and the board replaces the list', async () => {
    mockUseAuth.hasPermission.mockImplementation(p => p !== 'orders:update');
    const first = render(<OrderLinesPanel row={panelRow()} />);
    expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
    first.unmount();
    mockUseAuth.hasPermission.mockImplementation(() => true);
    let hits = 0;
    server.use(http.post(`${BASE}/cancel`, () => {
      hits++;
      return HttpResponse.json({ board: { rows: [], computed_at: null, stock_loaded_at: null, sync: {} } });
    }));
    render(<OrderLinesPanel row={panelRow()} />);
    const button = screen.getByRole('button', { name: 'Cancel order' });
    fireEvent.pointerDown(button);
    fireEvent.pointerUp(button);
    expect(screen.getByText('Hold 1s to cancel')).toBeInTheDocument();
    expect(hits).toBe(0);
    await holdToConfirm(button);
    await waitFor(() => expect(hits).toBe(1));
    expect(await screen.findByText('SO-00412 cancelled')).toBeInTheDocument();
  });
});

describe('scanning into a parcel', () => {
  const scan = (code: string) => [...code, 'Enter'].forEach(key => fireEvent.keyDown(document.body, { key }));

  it('with the setting on the check starts empty, a scan adds a unit, an unknown code changes nothing', async () => {
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const client = new QueryClient();
    client.setQueryData(['order-board'], { rows: [], scan: true });
    server.use(content());
    render(
      <QueryClientProvider client={client}>
        <OrderLinesPanel row={picking({ lines: [line({ codes: ['BL-PLA-BK', '6975337030001'] })] })} start="pack-pl1" startTick={1} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Parcel: 0 of 2 on PL-00013/)).toBeInTheDocument();
    scan('6975337030001');
    expect(await screen.findByText(/Parcel: 1 of 2 on PL-00013/)).toBeInTheDocument();
    scan('0000000');
    expect(await screen.findByText('Unknown barcode: 0000000')).toBeInTheDocument();
    expect(screen.getByText(/Parcel: 1 of 2 on PL-00013/)).toBeInTheDocument();
  });

  it('with the setting off the check starts full and keys are left alone', async () => {
    server.use(content());
    render(<OrderLinesPanel row={picking({ lines: [line({ codes: ['BL-PLA-BK'] })] })} start="pack-pl1" startTick={1} />);
    expect(await screen.findByText(/Parcel: 2 of 2 on PL-00013/)).toBeInTheDocument();
    scan('BL-PLA-BK');
    expect(screen.getByText(/Parcel: 2 of 2 on PL-00013/)).toBeInTheDocument();
  });
});
