import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RevenueSyncBanner } from '../../../components/revenue/RevenueSyncBanner';
import type { RevenueSyncStatus } from '../../../components/revenue/lib/types';

const sync = (o: Partial<RevenueSyncStatus> = {}): RevenueSyncStatus => ({
  running: false,
  fetchedDays: 300,
  totalDays: 300,
  missingDays: 0,
  backfilling: false,
  legacyDays: 0,
  lastBatchAt: '2026-11-19T08:05:00.000Z',
  lastError: null,
  failedDays: [],
  failedCount: 0,
  ...o,
});

function renderBanner(s: RevenueSyncStatus, o: { canSync?: boolean } = {}) {
  const onRetry = vi.fn();
  render(<RevenueSyncBanner sync={s} canSync={o.canSync ?? true} onRetry={onRetry} />);
  return { onRetry };
}

describe('RevenueSyncBanner', () => {
  const failedDay = (day: string, nextRetryAt: string) => ({ day, attempts: 2, nextRetryAt, error: 'Zoho 400' });

  it('idle: names one failed day and its retry time in amber', () => {
    renderBanner(sync({ failedCount: 1, failedDays: [failedDay('2026-11-12', '2026-11-19T10:32:00.000Z')] }));
    const time = new Date('2026-11-19T10:32:00.000Z').toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
    const note = screen.getByText(`Failed day: Nov 12, retry at ${time}`);
    expect(note).toHaveClass('text-amber-700', 'dark:text-amber-400');
    expect(screen.getByText(/Cache up to date/)).toBeInTheDocument();
  });

  it('progress: gives the count and the earliest retry for several failed days', () => {
    const later = '2026-11-19T12:00:00.000Z';
    const earliest = '2026-11-19T09:15:00.000Z';
    renderBanner(
      sync({
        backfilling: true,
        fetchedDays: 150,
        failedCount: 3,
        failedDays: [failedDay('2026-11-12', later), failedDay('2026-11-10', earliest), failedDay('2026-11-02', later)],
      }),
    );
    const time = new Date(earliest).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
    expect(screen.getByText(`Failed days: 3, next retry at ${time}`)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('error: the error line wins over the failed-day note', () => {
    renderBanner(sync({ lastError: 'Zoho 500', failedCount: 1, failedDays: [failedDay('2026-11-12', '2026-11-19T10:32:00.000Z')] }));
    expect(screen.queryByText(/Failed day/)).toBeNull();
  });

  it('idle: says the cache is up to date with the day count and last sync', () => {
    renderBanner(sync());
    expect(screen.getByText(/Cache up to date · days cached: 300 · last sync \d\d:\d\d/)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('idle: shows the per-customer split progress while legacy days remain', () => {
    renderBanner(sync({ legacyDays: 100 }));
    expect(screen.getByText(/split by customer: 200 \/ 300 days/)).toBeInTheDocument();
  });

  it('progress: shows a progress bar with the percentage', () => {
    renderBanner(sync({ backfilling: true, fetchedDays: 150 }));
    expect(screen.getByText('History: 150 / 300 days loaded')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(screen.getByText('50 %')).toBeInTheDocument();
  });

  it('error: wins over progress and offers Retry', async () => {
    const { onRetry } = renderBanner(sync({ backfilling: true, lastError: 'Zoho 500' }));
    expect(screen.getByText('Last sync failed: Zoho 500')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('error: hides Retry without revenue:sync', () => {
    renderBanner(sync({ lastError: 'Zoho 500' }), { canSync: false });
    expect(screen.getByText('Last sync failed: Zoho 500')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rebuild' })).toBeNull();
  });

  it('offers no Rebuild: it lives in the page menu', () => {
    renderBanner(sync({ lastError: 'Zoho 500' }));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rebuild' })).toBeNull();
  });
});
