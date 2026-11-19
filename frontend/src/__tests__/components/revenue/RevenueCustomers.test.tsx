import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RevenueCustomers } from '../../../components/revenue/RevenueCustomers';
import type { CustomerRow, CustomerSegment, CustomersResponse, SegmentRow } from '../../../components/revenue/lib/types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const seg = (segment: CustomerSegment, ht: number, goods: number, customers: number): SegmentRow => ({
  segment,
  ht,
  ttc: Math.round(ht * 1.13),
  goods,
  services: ht - goods,
  goodsTtc: Math.round(goods * 1.13),
  servicesTtc: Math.round((ht - goods) * 1.13),
  customers,
});

const customer = (customerId: string, name: string, segment: CustomerSegment, ht: number, o: Partial<CustomerRow> = {}): CustomerRow => ({
  customerId,
  name,
  segment,
  ht,
  ttc: Math.round(ht * 1.13),
  goods: ht,
  services: 0,
  quantity: 3,
  activeDays: 2,
  lastDay: '2026-11-12',
  ...o,
});

const payload = (o: Partial<CustomersResponse> = {}): CustomersResponse => ({
  from: '2026-01-01',
  to: '2026-11-19',
  segments: [seg('pro', 600_000, 400_000, 12), seg('particulier', 300_000, 300_000, 40), seg('inconnu', 100_000, 0, 0)],
  customers: [customer('c1', 'Atelier Moana', 'pro', 400_000, { services: 50_000, activeDays: 5 }), customer('c2', 'Teva R.', 'particulier', 100_000)],
  customerCount: 2,
  unsplitHt: 0,
  acquisition: { newCount: 47, newHt: 300_000, returningCount: 112, returningHt: 700_000, customerDays: 180, avgBasketHt: 21_400 },
  ...o,
});

function stub(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => json(body, status));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const view = (o: { taxMode?: 'ht' | 'ttc'; segment?: CustomerSegment | null; onSegment?: (s: CustomerSegment | null) => void; from?: string } = {}) => (
  <RevenueCustomers from={o.from ?? '2026-01-01'} to="2026-11-19" filterParams="&kind=goods" taxMode={o.taxMode ?? 'ht'} segment={o.segment ?? null} onSegment={o.onSegment ?? (() => {})} version={0} />
);

const tile = (label: string) => screen.getByText(label).closest('.rounded-lg') as HTMLElement;

afterEach(() => vi.unstubAllGlobals());

describe('RevenueCustomers', () => {
  it('requests the customers of the page range with the page filters', async () => {
    const fetchMock = stub(payload());
    render(view());
    expect(await screen.findByText('Atelier Moana')).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/revenue/customers?from=2026-01-01&to=2026-11-19&kind=goods');
  });

  it('shows the acquisition tiles on a range that starts after the history start', async () => {
    stub(payload());
    render(view());
    expect(await screen.findByText('New customers')).toBeInTheDocument();
    expect(screen.getByText('47')).toBeInTheDocument();
    expect(screen.getByText('Returning customers')).toBeInTheDocument();
    expect(screen.getByText('112')).toBeInTheDocument();
    expect(tile('Share of new customers')).toHaveTextContent('30 %');
    expect(screen.getByText('21.400 FCP')).toBeInTheDocument();
    expect(screen.getByText('300.000 FCP HT · first purchase in the period')).toBeInTheDocument();
    expect(screen.getByText("HT per customer and purchase day · visits: 180")).toBeInTheDocument();
    expect(screen.queryByText(/choose a period that starts after/)).toBeNull();
  });

  it('explains instead of showing the acquisition tiles when the range starts at the history start', async () => {
    stub(payload({ from: '2024-01-01' }));
    render(view({ from: '2024-01-01' }));
    expect(await screen.findByText(/New vs returning: choose a period that starts after 1 January 2024/)).toBeInTheDocument();
    expect(screen.queryByText('New customers')).toBeNull();
  });

  it('shows « — » for an average basket that cannot be computed', async () => {
    stub(payload({ acquisition: { newCount: 0, newHt: 0, returningCount: 0, returningHt: 0, customerDays: 0, avgBasketHt: null } }));
    render(view());
    await screen.findByText('Average basket ≈');
    expect(tile('Average basket ≈')).toHaveTextContent('—');
    expect(tile('Share of new customers')).toHaveTextContent('0 %');
  });

  it('toggles the page segment filter from a segment row, by click and by Enter', async () => {
    stub(payload());
    const onSegment = vi.fn();
    const { rerender } = render(view({ onSegment }));
    const pro = await screen.findByRole('button', { name: /^Business.+FCP/ });
    expect(pro).toHaveAttribute('aria-pressed', 'false');
    expect(pro).toHaveTextContent('600.000 FCP');
    expect(pro).toHaveTextContent('60 %');
    expect(pro).toHaveTextContent('Customers: 12');
    fireEvent.click(pro);
    expect(onSegment).toHaveBeenLastCalledWith('pro');

    rerender(view({ onSegment, segment: 'pro' }));
    const active = screen.getByRole('button', { name: /^Business.+FCP/ });
    expect(active).toHaveAttribute('aria-pressed', 'true');
    expect(within(active).getByText('active filter')).toBeInTheDocument();
    active.focus();
    await userEvent.keyboard('{Enter}');
    expect(onSegment).toHaveBeenLastCalledWith(null);
  });

  it('sets the segment from the segmented control at the top', async () => {
    stub(payload());
    const onSegment = vi.fn();
    render(view({ onSegment, segment: 'pro' }));
    await screen.findByText('Atelier Moana');
    const group = screen.getByRole('group', { name: 'Customer segment' });
    expect(within(group).getByRole('button', { name: 'Business' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(group).getByRole('button', { name: 'Individuals' }));
    expect(onSegment).toHaveBeenLastCalledWith('particulier');
    fireEvent.click(within(group).getByRole('button', { name: 'All customers' }));
    expect(onSegment).toHaveBeenLastCalledWith(null);
  });

  it('splits goods and services by segment with their takeaway', async () => {
    stub(payload());
    render(view());
    expect(await screen.findByText('Goods: 57 % come from Business')).toBeInTheDocument();
    expect(screen.getByText('Services: 67 % come from Business')).toBeInTheDocument();
  });

  it('shows the amber note only when part of the sales is not split by customer yet', async () => {
    stub(payload({ unsplitHt: 25_000 }));
    const { unmount } = render(view());
    expect(await screen.findByText('25.000 FCP not yet split by customer — the history reloads in the background.')).toBeInTheDocument();
    unmount();
    stub(payload());
    render(view());
    await screen.findByText('Atelier Moana');
    expect(screen.queryByText(/not yet split by customer/)).toBeNull();
  });

  it('lists the best customers with their figures and counts the shown ones only when some are left out', async () => {
    stub(payload({ customerCount: 120 }));
    const { unmount } = render(view());
    expect(await screen.findByText('Customers in total: 120 · shown: 2')).toBeInTheDocument();
    const rows = within(screen.getByRole('list', { name: 'Best customers' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Atelier Moana');
    expect(rows[0]).toHaveTextContent('Business');
    expect(rows[0]).toHaveTextContent('400.000 FCP · 40 %');
    expect(rows[0]).toHaveTextContent('Goods HT 400.000 FCP');
    expect(rows[0]).toHaveTextContent('Services HT 50.000 FCP');
    expect(rows[0]).toHaveTextContent('Active days: 5');
    expect(rows[0]).toHaveTextContent('Last purchase: Nov 12, 2026');
    unmount();
    stub(payload());
    render(view());
    expect(await screen.findByText('Customers in total: 2')).toBeInTheDocument();
  });

  it('names the goods and services bars with their total while keeping label and total readable as text', async () => {
    stub(payload());
    render(view());
    const img = await screen.findByRole('img', { name: 'Goods by customer type: 700.000 FCP' });
    expect(img).not.toHaveTextContent('700.000 FCP');
    expect(img).not.toHaveTextContent('Goods');
    expect(screen.getByText('700.000 FCP')).toBeVisible();
  });

  it('states the tax mode of the best customers amount', async () => {
    stub(payload());
    const { unmount } = render(view());
    await screen.findByText('Atelier Moana');
    expect(screen.getByText('Revenue HT')).toBeInTheDocument();
    unmount();
    stub(payload());
    render(view({ taxMode: 'ttc' }));
    await screen.findByText('Atelier Moana');
    expect(screen.getByText('Revenue TTC')).toBeInTheDocument();
    const rows = within(screen.getByRole('list', { name: 'Best customers' })).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('452.000 FCP · 40 %');
  });

  it('draws no bar for a customer at or below zero', async () => {
    stub(payload({ customers: [customer('c1', 'Atelier Moana', 'pro', 400_000), customer('c2', 'Refunded', 'particulier', 0), customer('c3', 'Credit', 'pro', -20_000)] }));
    render(view());
    await screen.findByText('Refunded');
    const rows = within(screen.getByRole('list', { name: 'Best customers' })).getAllByRole('listitem');
    expect(rows[0].querySelector('[data-bar]')).not.toBeNull();
    expect(rows[1].querySelector('[data-bar]')).toBeNull();
    expect(rows[2].querySelector('[data-bar]')).toBeNull();
  });

  it('says so when no customer is identified', async () => {
    stub(payload({ customers: [], customerCount: 0 }));
    render(view());
    expect(await screen.findByText('No customer identified in this period.')).toBeInTheDocument();
  });

  it('shows the server error when the first load fails', async () => {
    stub({ detail: 'customers unavailable' }, 500);
    render(view());
    expect(await screen.findByRole('alert')).toHaveTextContent('customers unavailable');
  });

  it('refetches when the page version moves', async () => {
    const fetchMock = stub(payload());
    const { rerender } = render(view());
    await screen.findByText('Atelier Moana');
    rerender(<RevenueCustomers from="2026-01-01" to="2026-11-19" filterParams="&kind=goods" taxMode="ht" segment={null} onSegment={() => {}} version={1} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
