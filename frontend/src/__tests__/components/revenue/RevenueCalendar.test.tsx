import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { RevenueCalendar } from '../../../components/revenue/RevenueCalendar';
import type { CalendarDay, TaxMode } from '../../../components/revenue/lib/types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const day = (d: string, ht: number, fetched = true): CalendarDay => ({ day: d, ht, ttc: Math.round(ht * 1.1), fetched });

// Monday 5 January 2026 to Monday 12 January 2026.
const DAYS = [
  day('2026-01-05', 100_000),
  day('2026-01-06', 0),
  day('2026-01-07', -5_000),
  day('2026-01-08', 0, false),
  day('2026-01-09', 25_000),
  day('2026-01-10', 0),
  day('2026-01-11', 0),
  day('2026-01-12', 50_000),
];

function stubFetch(days: CalendarDay[] | (() => Response) = DAYS) {
  const fetchMock = vi.fn(async (u: string) => {
    if (typeof days === 'function') return days();
    const y = /from=(\d{4})/.exec(u)?.[1] ?? '2026';
    return json({ from: `${y}-01-05`, to: `${y}-01-12`, days });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const renderCal = (o: { taxMode?: TaxMode; filterParams?: string; today?: string } = {}) =>
  render(<RevenueCalendar filterParams={o.filterParams ?? ''} taxMode={o.taxMode ?? 'ht'} version={0} today={o.today ?? '2026-11-19'} />);

const cell = (d: string) => document.querySelector(`[data-day="${d}"]`) as HTMLElement;
const urls = (m: ReturnType<typeof stubFetch>) => m.mock.calls.map((c) => c[0]);

afterEach(() => vi.unstubAllGlobals());

describe('RevenueCalendar', () => {
  it('opens on the rolling twelve months with the filters', async () => {
    const fetchMock = stubFetch();
    renderCal({ filterParams: '&kind=goods' });
    await screen.findByRole('grid', { name: 'Revenue by day' });
    expect(urls(fetchMock)).toEqual(['/api/v1/revenue/daily?kind=goods']);
    expect(screen.getByText('Sales calendar')).toBeInTheDocument();
    expect(screen.getByText('Last 12 months')).toBeInTheDocument();
    expect(screen.getByText('Jan 5, 2026 → Jan 12, 2026 · HT')).toBeInTheDocument();
  });

  it('reads the rolling window without a query string when no filter is set', async () => {
    const fetchMock = stubFetch();
    renderCal();
    await screen.findByRole('grid');
    expect(urls(fetchMock)).toEqual(['/api/v1/revenue/daily']);
  });

  it('steps from the rolling window to the current year, back to the history start, and forward again', async () => {
    const fetchMock = stubFetch();
    renderCal();
    await screen.findByRole('grid');
    const prev = screen.getByRole('button', { name: 'Previous year' });
    const next = screen.getByRole('button', { name: 'Next year' });
    expect(next).toBeDisabled();
    fireEvent.click(prev);
    await waitFor(() => expect(urls(fetchMock)).toContain('/api/v1/revenue/daily?from=2026-01-01&to=2026-12-31'));
    expect(screen.getByText('2026')).toBeInTheDocument();
    expect(next).toBeEnabled();
    fireEvent.click(prev);
    await waitFor(() => expect(urls(fetchMock)).toContain('/api/v1/revenue/daily?from=2025-01-01&to=2025-12-31'));
    fireEvent.click(prev);
    await waitFor(() => expect(urls(fetchMock)).toContain('/api/v1/revenue/daily?from=2024-01-01&to=2024-12-31'));
    expect(prev).toBeDisabled();
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByText('2026')).toBeInTheDocument();
    fireEvent.click(next);
    expect(screen.getByText('Last 12 months')).toBeInTheDocument();
    expect(next).toBeDisabled();
  });

  it('moves focus to the other stepper button when a step disables the focused one', async () => {
    stubFetch();
    renderCal();
    await screen.findByRole('grid');
    const prev = screen.getByRole('button', { name: 'Previous year' });
    const next = screen.getByRole('button', { name: 'Next year' });
    prev.focus();
    fireEvent.click(prev);
    fireEvent.click(prev);
    expect(prev).toHaveFocus();
    fireEvent.click(prev);
    expect(prev).toBeDisabled();
    expect(next).toHaveFocus();
    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent.click(next);
    expect(next).toBeDisabled();
    expect(prev).toHaveFocus();
  });

  it('lays the grid on a fixed 54 week columns whatever the window holds', async () => {
    stubFetch();
    renderCal();
    const grid = await screen.findByRole('grid');
    const rows = within(grid).getAllByRole('row');
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.style.gridTemplateColumns).toContain('repeat(54,');
      expect(row.children).toHaveLength(55);
    }
    const pads = Array.from(rows[0].children).slice(1).filter((c) => c.getAttribute('role') !== 'gridcell');
    expect(pads).toHaveLength(52);
    for (const pad of pads) {
      expect(pad).toHaveAttribute('aria-hidden', 'true');
      expect(pad).not.toHaveAttribute('tabindex');
    }
  });

  it('shows the loading state, not the previous window, while a step loads', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (calls++ === 0 ? json({ from: '2026-01-05', to: '2026-01-12', days: DAYS }) : new Promise<Response>(() => {}))));
    renderCal();
    await screen.findByRole('grid');
    fireEvent.click(screen.getByRole('button', { name: 'Previous year' }));
    expect(screen.getByText('2026')).toBeInTheDocument();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(cell('2026-01-05')).toBeNull();
    expect(screen.queryByText('Jan 5, 2026 → Jan 12, 2026 · HT')).toBeNull();
    expect(screen.queryByTestId('weekday-means')).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('shows the error of a step that fails instead of the previous window', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (calls++ === 0 ? json({ from: '2026-01-05', to: '2026-01-12', days: DAYS }) : json({ detail: 'Zoho indisponible' }, 503))));
    renderCal();
    await screen.findByRole('grid');
    fireEvent.click(screen.getByRole('button', { name: 'Previous year' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Zoho indisponible');
    expect(screen.queryByRole('grid')).toBeNull();
    expect(screen.queryByTestId('weekday-means')).toBeNull();
  });

  it('draws a day not fetched with a dashed outline, never in the zero colour', async () => {
    stubFetch();
    renderCal();
    await screen.findByRole('grid');
    const unknown = cell('2026-01-08');
    const zero = cell('2026-01-06');
    expect(unknown).toHaveClass('border-dashed');
    expect(unknown).not.toHaveClass('bg-bambu-dark-tertiary');
    expect(zero).toHaveClass('bg-bambu-dark-tertiary');
    expect(zero).not.toHaveClass('border-dashed');
  });

  it('paints a credit-note day in its own colour', async () => {
    stubFetch();
    renderCal();
    await screen.findByRole('grid');
    expect(cell('2026-01-07')).toHaveClass('bg-status-error');
    expect(cell('2026-01-07')).not.toHaveClass('bg-bambu-dark-tertiary');
  });

  it('shades sales on a square-root scale of the accent green', async () => {
    stubFetch();
    renderCal();
    await screen.findByRole('grid');
    expect(cell('2026-01-05').style.backgroundColor).toBe('rgb(0, 174, 66)');
    // 50 000 of a 100 000 maximum: 0.15 + 0.85 × √0.5 ≈ 0.75.
    expect(cell('2026-01-12').style.backgroundColor).toBe('rgba(0, 174, 66, 0.75)');
  });

  it('names every state in the legend', async () => {
    stubFetch();
    renderCal();
    const legend = await screen.findByRole('list', { name: 'Legend' });
    for (const label of ['less', 'more', 'credit note', 'not loaded']) expect(within(legend).getByText(label)).toBeInTheDocument();
  });

  it('gives each cell the same text on focus as on hover', async () => {
    stubFetch();
    renderCal();
    await screen.findByRole('grid');
    const readout = screen.getByTestId('calendar-readout');
    fireEvent.pointerEnter(cell('2026-01-05'));
    expect(readout).toHaveTextContent('Monday, January 5, 2026 · 100.000 FCP');
    fireEvent.pointerLeave(cell('2026-01-05'));
    expect(readout).toHaveTextContent('');
    fireEvent.focus(cell('2026-01-05'));
    expect(readout).toHaveTextContent('Monday, January 5, 2026 · 100.000 FCP');
    expect(cell('2026-01-05')).toHaveAccessibleName('Monday, January 5, 2026 · 100.000 FCP');
    expect(cell('2026-01-08')).toHaveAccessibleName('Thursday, January 8, 2026 · not loaded');
    expect(cell('2026-01-07')).toHaveAccessibleName('Wednesday, January 7, 2026 · −5.000 FCP');
  });

  it('is one tab stop, moved with the arrow keys', async () => {
    stubFetch();
    renderCal();
    const grid = await screen.findByRole('grid');
    const stops = within(grid).getAllByRole('gridcell').filter((c) => c.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(cell('2026-01-12'));
    fireEvent.keyDown(cell('2026-01-12'), { key: 'ArrowLeft' });
    expect(cell('2026-01-05')).toHaveFocus();
    expect(cell('2026-01-05').tabIndex).toBe(0);
    expect(cell('2026-01-12').tabIndex).toBe(-1);
    fireEvent.keyDown(cell('2026-01-05'), { key: 'ArrowDown' });
    expect(cell('2026-01-06')).toHaveFocus();
    fireEvent.keyDown(cell('2026-01-06'), { key: 'ArrowUp' });
    expect(cell('2026-01-05')).toHaveFocus();
    fireEvent.keyDown(cell('2026-01-05'), { key: 'ArrowLeft' });
    expect(cell('2026-01-05')).toHaveFocus();
    fireEvent.keyDown(cell('2026-01-05'), { key: 'End' });
    expect(cell('2026-01-12')).toHaveFocus();
    fireEvent.keyDown(cell('2026-01-12'), { key: 'Home' });
    expect(cell('2026-01-05')).toHaveFocus();
  });

  it('averages each weekday over its fetched days', async () => {
    stubFetch();
    renderCal();
    const list = await screen.findByTestId('weekday-means');
    const rows = Array.from(list.querySelectorAll('li')).map((li) => li.textContent);
    expect(rows).toEqual([
      'Monday75.000 FCP',
      'Tuesday0 FCP',
      'Wednesday−5.000 FCP',
      'Thursday0 FCP',
      'Friday25.000 FCP',
      'Saturday0 FCP',
      'Sunday0 FCP',
    ]);
    expect(screen.getByText('Average by weekday')).toBeInTheDocument();
  });

  it('averages the TTC amounts in TTC', async () => {
    stubFetch();
    renderCal({ taxMode: 'ttc' });
    const list = await screen.findByTestId('weekday-means');
    expect(list.querySelector('li')).toHaveTextContent('Monday82.500 FCP');
  });

  it('shows the server error', async () => {
    stubFetch(() => json({ detail: 'Zoho indisponible' }, 503));
    renderCal();
    expect(await screen.findByRole('alert')).toHaveTextContent('Zoho indisponible');
  });
});
