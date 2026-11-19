import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '../../../contexts/ToastContext';
import { RevenueChart } from '../../../components/revenue/RevenueChart';
import type { RevenueCan, RevenueControls } from '../../../pages/RevenuePage';
import type { RevenueAnnotation, RevenueBucket, RevenueProduct, RevenueResponse } from '../../../components/revenue/lib/types';
import { bucket } from './lib/fixtures';

// jsdom has no layout, so ResponsiveContainer renders nothing; pin a size.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: (props: ComponentProps<typeof actual.ResponsiveContainer>) => (
      <actual.ResponsiveContainer {...props} width={800} height={300} />
    ),
  };
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let notes: RevenueAnnotation[] = [];
beforeEach(() => {
  notes = [];
  vi.stubGlobal('fetch', vi.fn(async () => json({ annotations: notes })));
});
afterEach(() => vi.unstubAllGlobals());

const jan = bucket({ key: '2026-01', label: 'janv. 2026', start: '2026-01-01', end: '2026-01-31', ht: 600, ttc: 678, goods: 400, services: 200,
  byNature: { Imprimantes: 300, Filaments: 200, Pièces: 100 }, cumulative: { ht: 600, ttc: 678 }, target: 700 });
const feb = bucket({ key: '2026-02', label: 'févr. 2026', start: '2026-02-01', end: '2026-02-28', ht: 900, ttc: 1017, goods: 900, services: 0,
  byNature: { Imprimantes: 500, Filaments: 300, Pièces: 100 }, cumulative: { ht: 1500, ttc: 1695 }, missingDays: 3 });
const mar = bucket({ key: '2026-03', label: 'mars 2026', start: '2026-03-01', end: '2026-03-31', ht: 200, ttc: 226, goods: 200,
  byNature: { Imprimantes: 200 }, cumulative: { ht: 1700, ttc: 1921 }, partial: true, elapsedDays: 10, projection: { ht: 620, ttc: 700 }, target: 800 });

const payload = (buckets: RevenueBucket[]): RevenueResponse => ({
  granularity: 'month', from: buckets[0].start, to: buckets[buckets.length - 1].end, items: null, brands: null, kind: null, segment: null, buckets,
  sync: { running: false, fetchedDays: 300, totalDays: 300, missingDays: 0, backfilling: false, legacyDays: 0, lastBatchAt: null, lastError: null },
  reviewCount: 0, itemsSyncedAt: '2026-03-10T00:00:00Z', fetchedAt: '2026-03-10T00:00:00Z',
});

const controls = (o: Partial<RevenueControls> = {}): RevenueControls => ({
  granularity: 'month', taxMode: 'ht', stack: 'nature', range: { preset: 'default' }, kind: null, segment: null, view: 'evolution',
  brands: new Set(), basket: [], ...o,
});
const can = (o: Partial<RevenueCan> = {}): RevenueCan => ({
  export: false, scope: false, targets: false, notes: false, sync: false, customers: true, margin: false, ...o,
});
const product: RevenueProduct = { itemId: 'p1', name: 'PLA', sku: 'PLA-1', totalHt: 1000, quantity: 3, lastDay: '2026-03-01', brand: 'esun' };

type Props = ComponentProps<typeof RevenueChart>;
function renderChart(o: Partial<Props> = {}) {
  const props: Props = {
    payload: payload([jan, feb, mar]), controls: controls(), can: can(), onStack: vi.fn(), onDrill: vi.fn(), drillDepth: 0, onBack: vi.fn(), today: '2026-03-10', ...o,
  };
  const utils = render(<ToastProvider><RevenueChart {...props} /></ToastProvider>);
  return { ...utils, props, rerenderChart: (n: Partial<Props>) => utils.rerender(<ToastProvider><RevenueChart {...props} {...n} /></ToastProvider>) };
}

const legendColor = (name: string) => {
  const legend = screen.getByRole('list', { name: 'Legend' });
  return (within(legend).getByText(name).querySelector('span') as HTMLElement).style.backgroundColor;
};

describe('RevenueChart', () => {
  it('is a labelled chart group whose columns stay reachable', () => {
    renderChart();
    expect(screen.getByText('Revenue by month')).toBeInTheDocument();
    // Not role="img": an image's children are presentational, the column buttons would go silent.
    const chart = screen.getByRole('group', { name: 'Revenue per period (HT), stacked by Nature, with the running total' });
    expect(chart).toHaveAttribute('aria-roledescription', 'chart');
    expect(within(chart).getByRole('button', { name: 'janv. 2026 – 600 FCP' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Revenue per period/ })).toBeNull();
  });

  it('lists every series and the running total in the legend', () => {
    renderChart();
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(within(legend).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Imprimantes', 'Filaments', 'Pièces', 'Running total']);
  });

  it('names « Biens », « Services » and « Autres » in the UI language', () => {
    const many = bucket({ ...jan, byNature: { A: 60, B: 50, C: 40, D: 30, E: 20, F: 10 } });
    const { unmount } = renderChart({ payload: payload([many]) });
    expect(within(screen.getByRole('list', { name: 'Legend' })).getByText('Others')).toBeInTheDocument();
    unmount();
    renderChart({ controls: controls({ stack: 'kind' }) });
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(within(legend).getByText('Goods')).toBeInTheDocument();
    expect(within(legend).getByText('Services')).toBeInTheDocument();
  });

  it('names the server fallbacks « Sans marque » and « Sans nature » in the UI language', () => {
    const b = bucket({ ...jan, byNature: { 'Sans nature': 100, Filaments: 50 }, byBrand: { 'Sans marque': 100, esun: 50 } });
    const { unmount } = renderChart({ payload: payload([b]) });
    expect(within(screen.getByRole('list', { name: 'Legend' })).getByText('No category')).toBeInTheDocument();
    unmount();
    renderChart({ payload: payload([b]), controls: controls({ stack: 'brand' }) });
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(within(legend).getByText('No brand')).toBeInTheDocument();
    expect(within(legend).getByText('esun')).toBeInTheDocument();
    expect(within(legend).queryByText('Sans marque')).toBeNull();
  });

  it('keeps a series colour when a filter empties another series', () => {
    const { rerenderChart } = renderChart();
    const before = { a: legendColor('Imprimantes'), c: legendColor('Pièces') };
    expect(legendColor('Filaments')).not.toBe(before.a);
    const drop = (b: RevenueBucket) => ({ ...b, byNature: Object.fromEntries(Object.entries(b.byNature).filter(([k]) => k !== 'Filaments')) });
    rerenderChart({ payload: payload([jan, feb, mar].map(drop)) });
    expect(legendColor('Imprimantes')).toBe(before.a);
    expect(legendColor('Pièces')).toBe(before.c);
  });

  it('makes columns focusable and drills down on Enter or click', () => {
    const { props } = renderChart();
    const col = screen.getByRole('button', { name: 'févr. 2026 – 900 FCP · missing days: 3' });
    expect(col).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(col, { key: 'Enter' });
    expect(props.onDrill).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole('button', { name: 'janv. 2026 – 600 FCP' }));
    expect(props.onDrill).toHaveBeenCalledWith(0);
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    screen.getByRole('button', { name: 'mars 2026 – 200 FCP' }).dispatchEvent(space);
    expect(props.onDrill).toHaveBeenCalledWith(2);
    expect(space.defaultPrevented).toBe(true);
  });

  it('has no operable column without a finer level', () => {
    renderChart({ onDrill: undefined });
    expect(screen.queryByRole('button', { name: /janv\. 2026/ })).toBeNull();
  });

  it('shows « ← Retour » with the depth of the drill-down stack', () => {
    const { rerenderChart, props } = renderChart();
    expect(screen.queryByRole('button', { name: /Back/ })).toBeNull();
    rerenderChart({ drillDepth: 1 });
    expect(screen.getByRole('button', { name: '← Back' })).toBeInTheDocument();
    rerenderChart({ drillDepth: 2 });
    fireEvent.click(screen.getByRole('button', { name: '← Back (levels: 2)' }));
    expect(props.onBack).toHaveBeenCalled();
  });

  it('offers the stackings effectiveStack allows', () => {
    const names = () => within(screen.getByRole('group', { name: 'Stack by' })).getAllByRole('button').map((b) => b.textContent);
    const { rerenderChart, props } = renderChart();
    expect(names()).toEqual(['Nature', 'Brand', 'Goods / Services', 'Customer']);
    fireEvent.click(screen.getByRole('button', { name: 'Brand' }));
    expect(props.onStack).toHaveBeenCalledWith('brand');
    rerenderChart({ controls: controls({ basket: [product] }) });
    expect(names()).toContain('Product');
    rerenderChart({ controls: controls({ brands: new Set(['esun']) }) });
    expect(names()).toContain('Product');
    rerenderChart({ controls: controls({ kind: 'goods', stack: 'kind' }) });
    expect(names()).not.toContain('Goods / Services');
    expect(screen.getByRole('button', { name: 'Nature' })).toHaveAttribute('aria-pressed', 'true');
    rerenderChart({ controls: controls({ segment: 'pro' }) });
    expect(names()).not.toContain('Customer');
    rerenderChart({ controls: controls({ stack: 'segment' }), can: can({ customers: false }) });
    expect(names()).not.toContain('Customer');
    expect(screen.getByRole('button', { name: 'Nature' })).toHaveAttribute('aria-pressed', 'true');
    rerenderChart({ controls: controls({ stack: 'item' }) });
    expect(names()).not.toContain('Product');
    expect(screen.getByRole('button', { name: 'Nature' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('marks a column with missing days with « ! » and a text alternative', () => {
    renderChart();
    const mark = screen.getByText('!');
    // An SVG <title> is the text alternative (getByTitle only sees titles directly under <svg>).
    expect(mark.closest('g')?.querySelector('title')).toHaveTextContent('Missing days: 3');
  });

  it('draws the projection ghost on the in-progress column and the targets in HT only', () => {
    const { container, rerenderChart } = renderChart();
    expect(container.querySelectorAll('[data-ghost]')).toHaveLength(1);
    expect(container.querySelectorAll('.recharts-bar-rectangle').length).toBeGreaterThanOrEqual(7);
    expect(container.querySelector('.recharts-line path')).toHaveAttribute('stroke-dasharray', '4 3');
    expect(container.querySelectorAll('[data-target]')).toHaveLength(2);
    rerenderChart({ controls: controls({ taxMode: 'ttc' }) });
    expect(container.querySelectorAll('[data-target]')).toHaveLength(0);
  });

  it('puts a diamond above a column that has a note', async () => {
    notes = [{ id: 1, day: '2026-02-14', label: 'Saint-Valentin' }];
    const { container } = renderChart();
    await waitFor(() => expect(container.querySelectorAll('[data-note]')).toHaveLength(1));
    expect(container.querySelector('[data-note] title')).toHaveTextContent('Note: Saint-Valentin');
  });

  it('gives the figures as text too', () => {
    renderChart();
    const summary = screen.getByRole('list', { name: 'Values per period' });
    expect(within(summary).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'janv. 2026 – 600 FCP',
      'févr. 2026 – 900 FCP · missing days: 3',
      'mars 2026 – 200 FCP',
    ]);
  });
});
