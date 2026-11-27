import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '../../../contexts/ToastContext';
import { RevenueCharges } from '../../../components/revenue/RevenueCharges';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('RevenueCharges', () => {
  it('sums the three charges per month and per minute, above the three tables', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 15)); // November: 30 days, 43 200 minutes
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/result')) return json({ fixedMonthly: 86_400, charges: { labor: 43_200, fixed: 86_400, depreciation: 129_600 }, months: [], costsSince: null, breakEven: null });
      if (url.endsWith('/labor')) return json({ providers: [] });
      if (url.endsWith('/fixed-accounts')) return json({ month: '2026-11', readAt: null, accounts: [] });
      return json({ assets: [], selected: [], readAt: '2026-11-25T10:00:00+00:00' });
    }));
    const onClose = vi.fn();
    const returnFocus = vi.fn();
    const { unmount } = render(
      <ToastProvider>
        <RevenueCharges canManage={false} version={0} onChanged={vi.fn()} onClose={onClose} returnFocus={returnFocus} />
      </ToastProvider>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Costs' });
    expect(document.body.style.overflow).toBe('hidden');
    // One × for the dialog, none on the tables inside.
    expect(within(dialog).getAllByRole('button', { name: /close/i })).toHaveLength(1);
    const summary = await screen.findByRole('table', { name: 'Costs' });
    const row = (name: string) => within(summary).getByRole('row', { name: new RegExp(`^${name}`) });
    expect(within(row('Labour')).getByText('1,0 FCP/min')).toBeInTheDocument();
    expect(within(row('Fixed costs')).getByText('2,0 FCP/min')).toBeInTheDocument();
    expect(within(row('Depreciation')).getByText('3,0 FCP/min')).toBeInTheDocument();
    expect(within(row('Total')).getByText('259.200 FCP')).toBeInTheDocument();
    expect(within(row('Total')).getByText('6,0 FCP/min')).toBeInTheDocument();
    // The three tables follow.
    expect(screen.getByRole('heading', { name: 'Fixed costs' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Depreciation (Zoho)' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    unmount();
    expect(document.body.style.overflow).toBe('');
    expect(returnFocus).toHaveBeenCalled();
  });
});
