import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '../../../contexts/ToastContext';
import { RevenueFixedAccounts } from '../../../components/revenue/RevenueFixedAccounts';
import type { FixedAccount, FixedAccountsResponse } from '../../../components/revenue/lib/types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const account = (over: Partial<FixedAccount>): FixedAccount => ({
  id: 'a', code: '6', name: 'A', active: true, flag: null, month: 0, year: 0, usual: 0, percent: 0, type: 'monthly', goodsShare: 50, ...over,
});
const rent = account({ id: 'rent', code: '61320000', name: 'Location', usual: 160000, year: 1920000, percent: 50, goodsShare: 40 });
const edf = account({ id: 'edf', code: '60612000', name: 'Electricite', flag: 'purchases', month: 24000, usual: 72000, year: 810000 });
const STATE: FixedAccountsResponse = { month: '2026-11', readAt: '2026-11-27T10:00:00+00:00', accounts: [rent, edf] };

function setup(canManage = true, state: FixedAccountsResponse = STATE) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json(state));
  vi.stubGlobal('fetch', fetchMock);
  const onChanged = vi.fn();
  render(
    <ToastProvider>
      <RevenueFixedAccounts canManage={canManage} onChanged={onChanged} />
    </ToastProvider>,
  );
  return { fetchMock, onChanged };
}
const row = (name: string) => screen.getByRole('row', { name: new RegExp(name) });
const foot = (label: string) => screen.getByText(label).parentElement!;
// Accounts without a stored share are folded away: open the fold, then find the row.
const idleRow = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Not counted (1)' }));
  return row('Electricite');
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('RevenueFixedAccounts', () => {
  it('lists each account with its amounts, and marks what is estimated', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 15)); // November: 43 200 minutes
    setup();
    const r = within(await screen.findByRole('row', { name: /Location/ }));
    expect(r.getByText('61320000')).toBeInTheDocument();
    expect(r.getByText('1.920.000 FCP')).toBeInTheDocument();
    // Nothing entered this month: half of the usual rent is projected.
    expect(r.getByText('≈ 80.000 FCP')).toBeInTheDocument();
    expect(r.getByText('of which 80.000 FCP estimated')).toBeInTheDocument();
    expect(foot('Entered')).toHaveTextContent('0 FCP');
    expect(foot('Estimated, not entered yet')).toHaveTextContent('≈ 80.000 FCP');
    expect(foot('Total per month')).toHaveTextContent('80.000 FCP');
    expect(foot('Per minute')).toHaveTextContent('1,9 FCP/min');
    expect(foot('Goods')).toHaveTextContent('32.000 FCP');
    expect(foot('Services')).toHaveTextContent('48.000 FCP');
    expect(screen.getByText(/Read from Zoho on/)).toBeInTheDocument();
  });

  it('shows the type and the split only once an account has a share', async () => {
    setup();
    const r = within(await idleRow());
    expect(r.queryByRole('combobox')).toBeNull();
    expect(r.queryByRole('slider')).toBeNull();
    fireEvent.change(r.getByRole('spinbutton', { name: '3D share · Electricite' }), { target: { value: '100' } });
    expect(r.getByRole('combobox', { name: 'Charge type · Electricite' })).toHaveValue('monthly');
    expect(r.getByRole('slider', { name: 'Goods / services split · Electricite' })).toHaveValue('50');
    // 24 000 entered, 72 000 usual: 48 000 still missing.
    expect(r.getByText('≈ 72.000 FCP')).toBeInTheDocument();
    expect(foot('Entered')).toHaveTextContent('24.000 FCP');
    fireEvent.change(r.getByRole('combobox'), { target: { value: 'one_off' } });
    expect(r.getByText('24.000 FCP', { selector: 'span' })).toBeInTheDocument();
    fireEvent.change(r.getByRole('combobox'), { target: { value: 'annual' } });
    expect(r.getByText('spread over 12 months')).toBeInTheDocument();
  });

  it('moves the split with one slider', async () => {
    setup();
    const r = within(await screen.findByRole('row', { name: /Location/ }));
    expect(r.getByText('40 / 60')).toBeInTheDocument();
    fireEvent.change(r.getByRole('slider'), { target: { value: '75' } });
    expect(r.getByText('25 / 75')).toBeInTheDocument();
    expect(foot('Goods')).toHaveTextContent('20.000 FCP');
  });

  it('folds the accounts without a share away, and searches through all of them', async () => {
    setup();
    await screen.findByRole('row', { name: /Location/ });
    expect(screen.queryByRole('row', { name: /Electricite/ })).toBeNull();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search an account…' }), { target: { value: '60612' } });
    expect(row('Electricite')).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /Location/ })).toBeNull();
    // A share typed on a found account keeps it where it is, and still counts in the total.
    fireEvent.change(within(row('Electricite')).getByRole('spinbutton'), { target: { value: '100' } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search an account…' }), { target: { value: '' } });
    expect(screen.queryByRole('row', { name: /Electricite/ })).toBeNull();
    expect(foot('Entered')).toHaveTextContent('24.000 FCP');
  });

  it('warns on an account the page already counts elsewhere', async () => {
    setup();
    await idleRow();
    expect(within(row('Electricite')).getByRole('img', { name: /already counted in the cost of the items sold/ })).toBeInTheDocument();
    expect(within(row('Location')).queryByRole('img')).toBeNull();
  });

  it('saves the shares and tells the page', async () => {
    const { fetchMock, onChanged } = setup();
    const r = within(await idleRow());
    // Nothing to save, no bar.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.change(r.getByRole('spinbutton'), { target: { value: '12.5' } });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(put[0]).toBe('/api/v1/revenue/fixed-accounts');
    expect(JSON.parse(String(put[1]!.body))).toEqual({
      accounts: { rent: { percent: 50, type: 'monthly', goodsShare: 40 }, edf: { percent: 12.5, type: 'monthly', goodsShare: 50 } },
    });
  });

  it('refuses a share outside 0 to 100 and reads an empty one as 0', async () => {
    setup();
    const share = within(await screen.findByRole('row', { name: /Location/ })).getByRole('spinbutton');
    const save = () => screen.getByRole('button', { name: 'Save' });
    for (const bad of ['150', '-5']) {
      fireEvent.change(share, { target: { value: bad } });
      expect(save()).toBeDisabled();
      expect(screen.getByRole('alert')).toHaveTextContent('Each share must be between 0 and 100 %.');
    }
    fireEvent.change(share, { target: { value: '' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(save()).toBeEnabled();
    expect(within(row('Location')).queryByRole('slider')).toBeNull();
  });

  it('discards unsaved shares by reading the stored ones again', async () => {
    const { fetchMock } = setup();
    const share = within(await screen.findByRole('row', { name: /Location/ })).getByRole('spinbutton');
    fireEvent.change(share, { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
    expect(within(row('Location')).getByRole('spinbutton')).toHaveValue(50);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it('re-reads Zoho on demand', async () => {
    const { fetchMock } = setup();
    await screen.findByRole('row', { name: /Location/ });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh from Zoho' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/v1/revenue/fixed-accounts/refresh?scope=all' && init?.method === 'POST')).toBe(true));
  });

  it('is read-only without the manage right', async () => {
    setup(false);
    expect(within(await screen.findByRole('row', { name: /Location/ })).getByRole('spinbutton')).toHaveAttribute('readonly');
    expect(within(row('Location')).getByRole('slider')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh from Zoho' })).toBeNull();
  });

  it('says so when nothing was read yet', async () => {
    setup(true, { month: '2026-11', readAt: null, accounts: [] });
    expect(await screen.findByText('Nothing read from Zoho yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh from Zoho' })).toBeEnabled();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a failed load with a retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: 'Zoho could not be read' }, 502)));
    render(<ToastProvider><RevenueFixedAccounts canManage onChanged={vi.fn()} /></ToastProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Zoho could not be read');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
