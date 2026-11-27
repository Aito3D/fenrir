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
  it('sums the three charges per month and per minute, with a tab per table', async () => {
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
    const card = (name: string) => within(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
    const overview = within(await screen.findByRole('tabpanel', { name: 'Overview' }));
    await overview.findByText('259.200 FCP');
    expect(card('Labour').getByText('1,0 FCP/min')).toBeInTheDocument();
    expect(card('Labour').getByText('17 %')).toBeInTheDocument();
    expect(card('Fixed costs').getByText('2,0 FCP/min')).toBeInTheDocument();
    expect(card('Depreciation').getByText('3,0 FCP/min')).toBeInTheDocument();
    expect(overview.getByText('Total costs · November 2026')).toBeInTheDocument();
    expect(overview.getByText('Per month · 6,0 FCP/min')).toBeInTheDocument();
    expect(card('Labour').getByText('People: 0')).toBeInTheDocument();
    expect(card('Depreciation').getByText('Assets: 0 of 0')).toBeInTheDocument();
    // Each tab names its amount; the three tables sit behind them, mounted but hidden until picked.
    expect(screen.getByRole('tab', { name: 'Labour 43.200 FCP' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Fixed costs' })).toBeNull();
    fireEvent.click(card('Fixed costs').getByText('86.400 FCP'));
    expect(screen.getByRole('tab', { name: /^Fixed costs/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Fixed costs' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /^Depreciation/ }));
    expect(screen.getByRole('heading', { name: 'Depreciation (Zoho)' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    unmount();
    expect(document.body.style.overflow).toBe('');
    expect(returnFocus).toHaveBeenCalled();
  });

  it('counts the estimated fixed costs in the summary and says how much is estimated', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 15));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/result')) return json({ fixedMonthly: 86_400, charges: { labor: 0, fixed: 43_200, fixedEstimated: 43_200, depreciation: 0 }, months: [], costsSince: null, breakEven: null });
      if (url.endsWith('/labor')) return json({ providers: [] });
      if (url.endsWith('/fixed-accounts')) return json({ month: '2026-11', readAt: null, accounts: [] });
      return json({ assets: [], selected: [], readAt: null });
    }));
    render(
      <ToastProvider>
        <RevenueCharges canManage={false} version={0} onChanged={vi.fn()} onClose={vi.fn()} returnFocus={vi.fn()} />
      </ToastProvider>,
    );
    const card = (name: string) => within(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
    await screen.findByRole('button', { name: /^Fixed costs/ });
    expect(card('Fixed costs').getByText('86.400 FCP')).toBeInTheDocument();
    expect(card('Fixed costs').getByText('2,0 FCP/min')).toBeInTheDocument();
    expect(card('Fixed costs').getByText('of which 43.200 FCP estimated')).toBeInTheDocument();
    expect(within(screen.getByRole('tabpanel', { name: 'Overview' })).getAllByText('86.400 FCP')).toHaveLength(2);
    expect(card('Labour').queryByText(/estimated/)).toBeNull();
  });
});
