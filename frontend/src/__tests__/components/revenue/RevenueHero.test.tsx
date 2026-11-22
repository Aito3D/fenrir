import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RevenueFinding, RevenueHero } from '../../../components/revenue/RevenueHero';
import type { RevenueBucket, RevenueGranularity, RevenueResponse, TaxMode } from '../../../components/revenue/lib/types';
import { bucket } from './lib/fixtures';

const payload = (buckets: RevenueBucket[], granularity: RevenueGranularity = 'month'): RevenueResponse => ({
  granularity,
  from: buckets[0].start,
  to: buckets[buckets.length - 1].end,
  items: null,
  brands: null,
  kind: null,
  segment: null,
  buckets,
  sync: { running: false, fetchedDays: 300, totalDays: 300, missingDays: 0, backfilling: false, legacyDays: 0, lastBatchAt: null, lastError: null, failedDays: [], failedCount: 0 },
  reviewCount: 0,
  itemsSyncedAt: '2026-11-19T08:00:00Z',
  fetchedAt: '2026-11-19T08:00:00Z',
});

const sept = bucket({ key: '2026-09', label: 'sept. 2026', start: '2026-09-01', end: '2026-09-30', ht: 500_000, ttc: 565_000 });
// October in progress, day 15 of 31.
const oct = (o: Partial<RevenueBucket> = {}) =>
  bucket({ ht: 620_000, ttc: 700_600, partial: true, elapsedDays: 15, evolution: { ht: 0.08, ttc: 0.08 }, cumulative: { ht: 1_120_000, ttc: 1_265_600 }, ...o });

function renderHero(buckets: RevenueBucket[], o: { granularity?: RevenueGranularity; taxMode?: TaxMode; canMargin?: boolean } = {}) {
  return render(<RevenueHero payload={payload(buckets, o.granularity)} taxMode={o.taxMode ?? 'ht'} canMargin={o.canMargin ?? true} />);
}

describe('RevenueHero', () => {
  it('renders from the payload granularity', () => {
    const w46 = bucket({ key: '2026-W46', label: 'S46 · 9–15 nov. 2026', start: '2026-11-09', end: '2026-11-15', ht: 100 });
    const w47 = bucket({ key: '2026-W47', label: 'S47 · 16–22 nov. 2026', start: '2026-11-16', end: '2026-11-22', ht: 200, partial: true, elapsedDays: 4 });
    renderHero([w46, w47], { granularity: 'week' });
    expect(screen.getByText('S47 · 16–22 nov. 2026 · in progress, day 4 of 7')).toBeInTheDocument();
    expect(screen.getByText('Previous week')).toBeInTheDocument();
    expect(screen.queryByText('Previous month')).toBeNull();
  });

  it('shows the figure with the tax mode and the delta chips with ▲/▼ and the to-date comparison', () => {
    renderHero([sept, oct({ yearAgo: { ht: 640_000, ttc: 723_200 } })]);
    expect(screen.getByText('620.000 FCP')).toBeInTheDocument();
    expect(screen.getByText('▲ 8%')).toBeInTheDocument();
    expect(screen.getByText('vs 1–15 sept. (to date)')).toBeInTheDocument();
    expect(screen.getByText('▼ 3%')).toBeInTheDocument();
    expect(screen.getByText('vs 1–15 oct. 2025 (to date)')).toBeInTheDocument();
  });

  it('draws the target ring only when a target is set, else the sparkline', () => {
    const { unmount } = renderHero([sept, oct()]);
    expect(screen.queryByRole('img', { name: /of the target/ })).toBeNull();
    expect(screen.getByTestId('revenue-sparkline')).toBeInTheDocument();
    unmount();
    renderHero([sept, oct({ target: 1_000_000 })]);
    expect(screen.getByRole('img', { name: '62 % of the target reached' })).toBeInTheDocument();
    expect(screen.queryByTestId('revenue-sparkline')).toBeNull();
  });

  it('paints the ring green at or above 100 %, amber below', () => {
    const { container, unmount } = renderHero([sept, oct({ target: 1_000_000 })]);
    expect(container.querySelector('[data-arc="share"]')).toHaveAttribute('stroke', '#f59e0b');
    unmount();
    const done = renderHero([sept, oct({ ht: 1_000_000, target: 1_000_000 })]);
    expect(done.container.querySelector('[data-arc="share"]')).toHaveAttribute('stroke', '#00ae42');
  });

  it('draws the projection as the lighter arc and names it', () => {
    const { container } = renderHero([sept, oct({ target: 1_000_000, projection: { ht: 970_000, ttc: 1_096_100 }, projectionMethod: 'linear' })]);
    expect(screen.getByRole('img', { name: '62 % of the target reached, projection 97 %' })).toBeInTheDocument();
    expect(container.querySelector('[data-arc="projection"]')).not.toBeNull();
    // The projection lives in its own tile; the corner keeps the target only.
    expect(screen.getByText('Target HT 1.000.000 FCP')).toBeInTheDocument();
    expect(screen.queryByText(/Projection ≈/)).toBeNull();
  });

  it('offers to set a target on a month or year without one, never on a week', () => {
    let opened = 0;
    const { unmount } = render(<RevenueHero payload={payload([sept, oct()])} taxMode="ht" canMargin onSetTarget={() => { opened += 1; }} />);
    screen.getByRole('button', { name: 'Set a target' }).click();
    expect(opened).toBe(1);
    unmount();
    const w = bucket({ key: '2026-W47', label: 'S47', start: '2026-11-16', end: '2026-11-22' });
    render(<RevenueHero payload={payload([w], 'week')} taxMode="ht" canMargin onSetTarget={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Set a target' })).toBeNull();
  });

  it('shows one year-over-year badge and the previous year from the server on a one-column year', () => {
    const y = bucket({
      key: '2026', label: '2026', start: '2026-01-01', end: '2026-12-31', ht: 4_000_000, ttc: 4_520_000, partial: true, elapsedDays: 324,
      evolution: { ht: 3.02, ttc: 3.02 }, yearAgo: { ht: 995_000, ttc: 1_124_350 }, previousTotal: { ht: 1_200_000, ttc: 1_356_000 },
    });
    renderHero([y], { granularity: 'year' });
    const badges = screen.getAllByText(/^vs /);
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('2025'); // the year-ago label names the year
    expect(screen.getByText('1.200.000 FCP')).toBeInTheDocument();
    expect(screen.getByText('2025')).toBeInTheDocument();
  });

  it('hides the margin tile without revenue:view_margin or without cost fields', () => {
    const costed = oct({ costedHt: 600_000, cost: 420_000 });
    const { unmount } = renderHero([sept, costed]);
    expect(screen.getByText('Gross margin HT')).toBeInTheDocument();
    expect(screen.getByText('180.000 FCP')).toBeInTheDocument();
    expect(screen.getByText('30 % · cost known on 97 % of revenue')).toBeInTheDocument();
    unmount();
    const hidden = renderHero([sept, costed], { canMargin: false });
    expect(screen.queryByText(/Gross margin/)).toBeNull();
    hidden.unmount();
    renderHero([sept, oct({ costedHt: undefined, cost: undefined })]);
    expect(screen.queryByText(/Gross margin/)).toBeNull();
    expect(screen.getByText('Previous month')).toBeInTheDocument();
    // The running total repeated the hero figure: it is no longer a tile.
    expect(screen.queryByText('Running total')).toBeNull();
  });

  it('names the services per machine hour tile and formats its hours', () => {
    renderHero([sept, oct({ services: 300_000, printHours: 1315.9 })]);
    expect(screen.getByText('Services / machine h')).toBeInTheDocument();
    expect(screen.getByText('1,315.9 h')).toBeInTheDocument();
    expect(screen.getAllByText('Previous month')).toHaveLength(1);
  });

  it('shows the tile hints the helpers return', () => {
    renderHero([sept, oct({ projection: { ht: 1_240_000, ttc: 1_401_200 }, projectionMethod: 'linear' })]);
    expect(screen.getByText('sept. 2026')).toBeInTheDocument();
    expect(screen.getByText('Projection to end of month')).toBeInTheDocument();
    expect(screen.getByText('at the current pace')).toBeInTheDocument();
  });

  it('says a seasonal projection runs at last year\'s pace', () => {
    renderHero([sept, oct({ projection: { ht: 1_240_000, ttc: 1_401_200 }, projectionMethod: 'seasonal' })]);
    expect(screen.getByText("at last year's pace")).toBeInTheDocument();
  });

  it('clamps the ring arc above 100 % and below 0 %', () => {
    const c = 2 * Math.PI * 50;
    const { container, unmount } = renderHero([sept, oct({ ht: 1_500_000, target: 1_000_000 })]);
    expect(container.querySelector('[data-arc="share"]')).toHaveAttribute('stroke-dasharray', `${c} ${c}`);
    unmount();
    const neg = renderHero([sept, oct({ ht: -200_000, target: 1_000_000 })]);
    expect(neg.container.querySelector('[data-arc="share"]')).toHaveAttribute('stroke-dasharray', `0 ${c}`);
  });

  it('shows a change under half a percent as flat', () => {
    renderHero([sept, oct({ evolution: { ht: 0.004, ttc: 0.004 } })]);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('vs 1–15 sept. (to date)')).toBeInTheDocument();
  });

  it('reads TTC figures in TTC', () => {
    renderHero([sept, oct()], { taxMode: 'ttc' });
    expect(screen.getByText('700.600 FCP')).toBeInTheDocument();
    expect(screen.getByText('TTC')).toBeInTheDocument();
  });
});

describe('RevenueFinding', () => {
  const renderFinding = (buckets: RevenueBucket[]) => render(<RevenueFinding payload={payload(buckets)} taxMode="ht" />);

  it('says the target share and the change, lead clause first', () => {
    renderFinding([sept, oct({ target: 1_000_000 })]);
    const h = screen.getByTestId('revenue-finding');
    expect(h).toHaveTextContent('Oct. 2026 is at 62 % of the target, 8 % ahead of 1–15 sept. (to date).');
    expect(h.querySelector('span')).toHaveTextContent('8 % ahead of 1–15 sept. (to date).');
  });

  it('says behind for a fall, and the change alone without a target', () => {
    renderFinding([sept, oct({ evolution: { ht: -0.03, ttc: -0.03 } })]);
    expect(screen.getByTestId('revenue-finding')).toHaveTextContent('Oct. 2026 is 3 % behind 1–15 sept. (to date).');
  });

  it('says the share alone without a change', () => {
    renderFinding([oct({ evolution: { ht: null, ttc: null }, target: 500_000 })]);
    expect(screen.getByTestId('revenue-finding')).toHaveTextContent('Oct. 2026 is at 124 % of the target.');
  });

  it('says level for a change under half a percent, with and without a target', () => {
    const { unmount } = renderFinding([sept, oct({ target: 1_000_000, evolution: { ht: 0.004, ttc: 0.004 } })]);
    expect(screen.getByTestId('revenue-finding')).toHaveTextContent('Oct. 2026 is at 62 % of the target, level with 1–15 sept. (to date).');
    unmount();
    renderFinding([sept, oct({ evolution: { ht: -0.004, ttc: -0.004 } })]);
    expect(screen.getByTestId('revenue-finding')).toHaveTextContent('Oct. 2026 is level with 1–15 sept. (to date).');
  });

  it('reads the change in the tax mode shown', () => {
    render(<RevenueFinding payload={payload([sept, oct({ evolution: { ht: 0.08, ttc: -0.03 } })])} taxMode="ttc" />);
    expect(screen.getByTestId('revenue-finding')).toHaveTextContent('Oct. 2026 is 3 % behind 1–15 sept. (to date).');
  });

  it('is omitted when neither figure exists', () => {
    const { container } = renderFinding([oct({ evolution: { ht: null, ttc: null } })]);
    expect(container).toBeEmptyDOMElement();
  });
});
