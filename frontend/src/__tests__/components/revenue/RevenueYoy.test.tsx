import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { RevenueYoy } from '../../../components/revenue/RevenueYoy';
import type { TaxMode, YoyYear } from '../../../components/revenue/lib/types';

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

/** A year from its monthly HT (TTC = HT × 1.1); the running total stops at the first missing month, as the server's pivot does. */
function year(y: number, ht: (number | null)[]): YoyYear {
  const months = [...ht, ...Array(12 - ht.length).fill(null)] as (number | null)[];
  const ttc = months.map((v) => (v === null ? null : Math.round(v * 1.1)));
  const run = (vals: (number | null)[]) => {
    let sum = 0;
    let open = true;
    return vals.map((v) => {
      if (v === null || !open) {
        open = false;
        return null;
      }
      sum += v;
      return sum;
    });
  };
  return { year: y, ht: months, ttc, cumulativeHt: run(months), cumulativeTtc: run(ttc) };
}

const FIVE = [
  year(2022, Array(12).fill(10_000)),
  year(2023, Array(12).fill(20_000)),
  year(2024, Array(12).fill(40_000)),
  year(2025, Array(12).fill(80_000)),
  year(2026, Array(10).fill(100_000)),
];

function stubFetch(years: YoyYear[] | Response) {
  const fetchMock = vi.fn(async () => (years instanceof Response ? years : json({ years, today: '2026-11-19' })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const renderYoy = (o: { taxMode?: TaxMode; filterParams?: string } = {}) =>
  render(<RevenueYoy filterParams={o.filterParams ?? ''} taxMode={o.taxMode ?? 'ht'} version={0} />);

const pathOf = (container: HTMLElement, stroke: string) => container.querySelector(`.recharts-line path.recharts-curve[stroke="${stroke}"]`);

afterEach(() => vi.unstubAllGlobals());

describe('RevenueYoy', () => {
  it('reads the year-over-year route with the filters', async () => {
    const fetchMock = stubFetch(FIVE);
    renderYoy({ filterParams: '&kind=goods&brand=esun' });
    await screen.findByText('Year by year');
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls.map((c) => (c as unknown[])[0])).toContain('/api/v1/revenue/yoy?kind=goods&brand=esun');
  });

  it('reads the route without a query string when no filter is set', async () => {
    const fetchMock = stubFetch(FIVE);
    renderYoy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('/api/v1/revenue/yoy');
  });

  it('draws at most four years, newest first in the legend with its running total', async () => {
    stubFetch(FIVE);
    const { container } = renderYoy();
    const legend = await screen.findByRole('list', { name: 'Legend' });
    const items = Array.from(legend.querySelectorAll('li')).map((li) => li.textContent);
    expect(items).toEqual(['2026 1.000.000 FCP', '2025 960.000 FCP', '2024 480.000 FCP', '2023 240.000 FCP']);
    await waitFor(() => expect(container.querySelectorAll('.recharts-line path.recharts-curve')).toHaveLength(4));
  });

  it('draws the newest year brightest and thickest', async () => {
    stubFetch(FIVE);
    const { container } = renderYoy();
    await waitFor(() => expect(pathOf(container, '#00ae42')).not.toBeNull());
    const widths = Array.from(container.querySelectorAll('.recharts-line path.recharts-curve')).map((p) => Number(p.getAttribute('stroke-width')));
    expect(pathOf(container, '#00ae42')).toHaveAttribute('stroke-width', '3');
    expect(Math.max(...widths)).toBe(3);
    expect(widths.filter((w) => w === 3)).toHaveLength(1);
  });

  it('tells the older years apart by stroke pattern too, in the lines and the legend', async () => {
    stubFetch(FIVE);
    const { container } = renderYoy();
    await waitFor(() => expect(pathOf(container, '#808080')).not.toBeNull());
    expect(pathOf(container, '#00ae42')).not.toHaveAttribute('stroke-dasharray');
    expect(pathOf(container, '#a0a0a0')).toHaveAttribute('stroke-dasharray', '6 4');
    expect(pathOf(container, '#808080')).toHaveAttribute('stroke-dasharray', '2 3');
    const swatches = Array.from(screen.getByRole('list', { name: 'Legend' }).querySelectorAll('[data-swatch]')) as HTMLElement[];
    expect(swatches.map((s) => s.style.borderTopStyle)).toEqual(['solid', 'solid', 'dashed', 'dotted']);
  });

  it('switches between Cumul and Mensuel', async () => {
    stubFetch(FIVE);
    renderYoy();
    const cumul = await screen.findByRole('button', { name: 'Running total' });
    const monthly = screen.getByRole('button', { name: 'Monthly' });
    expect(cumul).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('img', { name: 'Running revenue by year (HT)' })).toBeInTheDocument();
    fireEvent.click(monthly);
    expect(monthly).toHaveAttribute('aria-pressed', 'true');
    expect(cumul).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('img', { name: 'Monthly revenue by year (HT)' })).toBeInTheDocument();
  });

  it('breaks the line at a month with no data instead of bridging it', async () => {
    stubFetch([year(2025, Array(12).fill(80_000)), year(2026, [100_000, 100_000, null, 100_000, 100_000])]);
    const { container } = renderYoy();
    fireEvent.click(await screen.findByRole('button', { name: 'Monthly' }));
    await waitFor(() => expect(pathOf(container, '#00ae42')).not.toBeNull());
    const d = pathOf(container, '#00ae42')!.getAttribute('d') ?? '';
    expect(d.match(/M/g)).toHaveLength(2);
  });

  it('marks a month standing alone between gaps with a dot', async () => {
    stubFetch([year(2026, [null, 100_000, null])]);
    const { container } = renderYoy();
    fireEvent.click(await screen.findByRole('button', { name: 'Monthly' }));
    await waitFor(() => expect(container.querySelector('circle[data-lone]')).not.toBeNull());
    expect(container.querySelectorAll('circle[data-lone]')).toHaveLength(1);
  });

  it('sums up the year to date against the year before over the same months', async () => {
    stubFetch(FIVE);
    renderYoy();
    const line = await screen.findByTestId('yoy-to-date');
    expect(line).toHaveTextContent('2026 to date: 1.000.000 FCP, i.e. +25.0 % vs 2025 over the same period (Jan → Oct)');
    expect(line).toHaveClass('tabular-nums');
  });

  it('uses the TTC totals in TTC', async () => {
    stubFetch(FIVE);
    renderYoy({ taxMode: 'ttc' });
    expect(await screen.findByTestId('yoy-to-date')).toHaveTextContent('2026 to date: 1.100.000 FCP');
    expect(screen.getByRole('img', { name: 'Running revenue by year (TTC)' })).toBeInTheDocument();
  });

  it('says when there is no year before to compare with', async () => {
    stubFetch([year(2026, Array(10).fill(100_000))]);
    renderYoy();
    expect(await screen.findByTestId('yoy-to-date')).toHaveTextContent('2026 to date: 1.000.000 FCP — no comparison with 2025');
  });

  it('says so when there is no year at all', async () => {
    stubFetch([]);
    renderYoy();
    expect(await screen.findByText('No data.')).toBeInTheDocument();
  });

  it('shows the server error', async () => {
    stubFetch(json({ detail: 'Zoho indisponible' }, 503));
    renderYoy();
    expect(await screen.findByRole('alert')).toHaveTextContent('Zoho indisponible');
  });
});
