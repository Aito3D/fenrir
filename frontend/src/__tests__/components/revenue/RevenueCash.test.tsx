import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RevenueCash } from '../../../components/revenue/RevenueCash';
import type { CashResponse, PipelineResponse } from '../../../components/revenue/lib/types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const cash = (o: Partial<CashResponse> = {}): CashResponse => ({
  months: [
    { month: '2026-10', invoicedTtc: 900_000, collected: 800_000, collectedUnknown: 0 },
    { month: '2026-11', invoicedTtc: 1_000_000, collected: 600_000, collectedUnknown: 25_000 },
  ],
  outstanding: { total: 450_000, overdue: 120_000, invoices: 7, unknown: 0 },
  topOverdue: [{ number: 'INV-042', customerName: 'Alice', dueDate: '2026-10-01', daysOverdue: 50, balance: 80_000 }],
  aging: {
    buckets: { notDue: 330_000, d30: 70_000, d60: 31_000, d90: 12_000, over: 7_000 },
    byCustomer: [{ customerName: 'Bob SARL', balance: 91_000, overdue: 44_000, oldestDays: 63 }],
  },
  dso: 27,
  forecast: [{ window: 'd30', invoices: 210_000, orders: 900_000 }, { window: 'd60', invoices: 55_000, orders: 0 }, { window: 'd90', invoices: 0, orders: 0 }],
  coverage: { known: 2_000_000, unknown: 40_000 },
  syncedAt: '2026-11-20T08:00:00Z',
  error: null,
  ...o,
});

const pipeline = (o: Partial<PipelineResponse> = {}): PipelineResponse => ({
  accepted: {
    count: 4, total: 1_200_000, retainerPaid: 300_000, missingTotal: 1,
    byColumn: [{ column: 'model', count: 1, total: 200_000 }, { column: 'print', count: 3, total: 990_000 }],
  },
  awaiting: { count: 2, total: 350_000, oldestDays: 12 },
  ...o,
});

function stub(c: CashResponse | Response, p: PipelineResponse = pipeline()) {
  vi.stubGlobal('fetch', vi.fn(async (u: string) => (u.endsWith('/cash') ? (c instanceof Response ? c : json(c)) : json(p))));
}

afterEach(() => vi.unstubAllGlobals());

describe('RevenueCash', () => {
  it('renders the cash half and the order book from the payloads', async () => {
    stub(cash());
    render(<RevenueCash version={0} />);
    expect(await screen.findByText('1.000.000 FCP')).toBeInTheDocument();
    expect(screen.getByText('600.000 FCP')).toBeInTheDocument();
    expect(screen.getByText('incl. 25.000 FCP to allocate')).toBeInTheDocument();
    expect(screen.getByTestId('revenue-cash-bar').firstElementChild).toHaveStyle({ transform: 'scaleX(0.6)' });
    expect(screen.getByText('450.000 FCP')).toBeInTheDocument();
    expect(screen.getByText('7 open invoices')).toBeInTheDocument();
    expect(screen.getByText('120.000 FCP')).toHaveClass('text-amber-700');
    expect(screen.getByText('INV-042 · Alice')).toBeInTheDocument();
    expect(screen.getByText('50 d late')).toBeInTheDocument();
    expect(screen.getByText('3D share still being computed for 40.000 FCP')).toBeInTheDocument();

    expect(await screen.findByText('1.200.000 FCP')).toBeInTheDocument();
    expect(screen.getByText('Cards: 4 · No amount: 1')).toBeInTheDocument();
    expect(screen.getByText('300.000 FCP')).toBeInTheDocument();
    expect(screen.getByText('Printing & Machining')).toBeInTheDocument();
    expect(screen.getByText('Quotes awaiting an answer')).toBeInTheDocument();
    expect(screen.getByText('350.000 FCP')).toBeInTheDocument();
    expect(screen.getByText('Oldest: 12 d')).toBeInTheDocument();
  });

  it('hides the overdue list and the notes when absent, and shows a cash error muted', async () => {
    stub(cash({ topOverdue: undefined, coverage: { known: 1, unknown: 0 }, error: 'Zoho 429' }));
    render(<RevenueCash version={0} />);
    expect(await screen.findByText('Last update failed: Zoho 429')).toBeInTheDocument();
    expect(screen.queryByText('INV-042 · Alice')).toBeNull();
    expect(screen.queryByText(/3D share still being computed/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a failed request as an alert, and empty states', async () => {
    stub(json({ detail: 'boom' }, 500), pipeline({ accepted: { count: 0, total: 0, retainerPaid: 0, missingTotal: 0, byColumn: [] }, awaiting: { count: 0, total: 0, oldestDays: null } }));
    render(<RevenueCash version={0} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(await screen.findByText('No open quotes')).toBeInTheDocument();
  });

  it('shows what is owed by age, the payment delay, late customers and the expected cash', async () => {
    stub(cash());
    render(<RevenueCash version={0} />);
    const bar = await screen.findByTestId('revenue-aging-bar');
    expect([...bar.children].map((c) => (c as HTMLElement).style.flexGrow)).toEqual(['330000', '70000', '31000', '12000', '7000']);
    expect(screen.getByText('31–60 d late').closest('div')).toHaveTextContent('31.000 FCP');
    expect(screen.getByText('Average payment delay').closest('div')).toHaveTextContent('27 d');
    expect(screen.getByText('Bob SARL').closest('div')).toHaveTextContent('91.000 FCP');
    expect(screen.getByText('of which 44.000 FCP late · 63 d late')).toBeInTheDocument();
    expect(screen.getByText('Within 30 d').closest('div')!.parentElement).toHaveTextContent('1.110.000 FCP');
    expect(screen.getByText('Invoices 210.000 FCP · order book 900.000 FCP')).toBeInTheDocument();
    expect(screen.getByText('In 31–60 d').closest('div')!.parentElement).toHaveTextContent('55.000 FCP');
  });

  it('shows a dash without a payment delay and no customer rows when they are stripped', async () => {
    const c = cash({ dso: null });
    stub({ ...c, aging: { buckets: c.aging.buckets } });
    render(<RevenueCash version={0} />);
    expect((await screen.findByText('Average payment delay')).closest('div')).toHaveTextContent('—');
    expect(screen.queryByText('Bob SARL')).toBeNull();
  });

  it('says when no cash refresh has run yet', async () => {
    stub(cash({ syncedAt: null }));
    render(<RevenueCash version={0} />);
    expect(await screen.findByText('No payment data yet')).toBeInTheDocument();
  });
});
