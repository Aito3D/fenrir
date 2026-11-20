import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render as rtlRender, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ToastProvider } from '../../contexts/ToastContext';
import { RevenuePage } from '../../pages/RevenuePage';
import { Layout } from '../../components/Layout';
import { setAuthToken } from '../../api/client';
import type { RevenueResponse, RevenueSyncStatus } from '../../components/revenue/lib/types';

let granted = new Set<string>();
const mockUseAuth = {
  user: { id: 1, username: 'operator', permissions: [] as string[] } as { id: number; username: string; permissions: string[] } | null,
  authEnabled: true,
  requiresSetup: false,
  loading: false,
  isAdmin: false,
  login: vi.fn(),
  loginWithToken: vi.fn(),
  logout: vi.fn(),
  refreshUser: vi.fn(),
  refreshAuth: vi.fn(),
  hasPermission: vi.fn((p: string) => granted.has(p)),
  hasAnyPermission: vi.fn(() => true),
  hasAllPermissions: vi.fn(() => true),
  canModify: vi.fn(() => true),
};

vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => mockUseAuth };
});
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
vi.mock('../../hooks/useWebSocket', () => ({ useWebSocket: () => {} }));
vi.mock('../../hooks/usePrintProgressTitle', () => ({ usePrintProgressTitle: () => {} }));
vi.mock('../../hooks/useCameraStreamToken', () => ({ useStreamTokenSync: () => {} }));

const ALL = ['revenue:read', 'revenue:sync', 'revenue:view_customers'];

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

const payload = (o: Partial<RevenueResponse> = {}): RevenueResponse => ({
  granularity: 'month',
  from: '2025-12-01',
  to: '2026-11-19',
  items: null,
  brands: null,
  kind: null,
  segment: null,
  buckets: [],
  sync: sync(),
  reviewCount: 0,
  itemsSyncedAt: '2026-11-19T08:00:00.000Z',
  fetchedAt: '2026-11-19T08:06:00.000Z',
  ...o,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
const seriesCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/v1/revenue?'));

function stubFetch(series: RevenueResponse, onSync?: (url: string) => Promise<Response>) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/v1/revenue/sync') && init?.method === 'POST') return onSync ? onSync(url) : json({ sync: series.sync });
    if (url.startsWith('/api/v1/revenue?')) return json(series);
    return json({ detail: 'not stubbed' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
}

const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const renderPage = () =>
  rtlRender(
    <ToastProvider>
      <RevenuePage />
    </ToastProvider>,
  );

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
}

beforeEach(() => {
  granted = new Set(ALL);
  mockUseAuth.authEnabled = true;
  mockUseAuth.loading = false;
  mockUseAuth.user = { id: 1, username: 'operator', permissions: [] };
  mockUseAuth.hasPermission.mockImplementation((p: string) => granted.has(p));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setHidden(false);
  setAuthToken(null);
  window.history.replaceState(null, '', '/');
});

describe('RevenuePage — waiting states', () => {
  beforeEach(() => vi.useFakeTimers());

  it('waits for the item catalogue while itemsSyncedAt is null, never printing 0 FCP', async () => {
    stubFetch(payload({ itemsSyncedAt: null }));
    renderPage();
    await flush();
    expect(screen.getByText('Waiting for the item catalogue…')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/FCP/);
    expect(screen.queryByRole('tabpanel')).toBeNull();
  });

  it('shows the history loading state while no day is fetched, never printing 0 FCP', async () => {
    stubFetch(payload({ sync: sync({ fetchedDays: 0, backfilling: true }) }));
    renderPage();
    await flush();
    expect(screen.getByText('Loading the history…')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/FCP/);
  });

  it('renders the view slot once ready, sending the auth header', async () => {
    setAuthToken('tok');
    stubFetch(payload());
    renderPage();
    await flush();
    expect(screen.getByRole('heading', { name: 'Revenue' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('data-slot', 'revenue-view-evolution');
    const [, init] = seriesCalls()[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('opens Évolution with the finding, the hero and the pace of the last bucket, filters included', async () => {
    window.history.replaceState(null, '', '/revenue?kind=goods');
    const nov = {
      key: '2026-11', label: 'nov. 2026', start: '2026-11-01', end: '2026-11-30', ht: 620_000, ttc: 700_600, goods: 620_000, services: 0,
      byNature: {}, byBrand: {}, goodsTtc: 700_600, servicesTtc: 0, byNatureTtc: {}, byBrandTtc: {}, projection: null, projectionMethod: null,
      target: 1_000_000, quantity: 3, evolution: { ht: 0.08, ttc: 0.08 }, yearAgo: null, elapsedDays: 19, cumulative: { ht: 620_000, ttc: 700_600 },
      partial: true, missingDays: 0, ttcApprox: false,
    };
    stubFetch(payload({ buckets: [nov] }));
    renderPage();
    await flush();
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByTestId('revenue-finding')).toHaveTextContent('Nov. 2026 is at 62 % of the target, 8 % ahead of 1–19 oct. (to date).');
    expect(within(panel).getByRole('img', { name: '62 % of the target reached' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain('/api/v1/revenue/daily?from=2026-11-01&to=2026-11-30&kind=goods');
    expect(within(panel).getByRole('table', { name: 'Detail by period' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain('/api/v1/revenue/movers?granularity=month&key=2026-11&kind=goods');
  });

  it('shows the error with a retry that reloads', async () => {
    fetchMock = vi.fn(async () => json({ detail: 'Zoho is down' }, 502));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    await flush();
    expect(screen.getByText('Zoho is down')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await flush();
    expect(seriesCalls()).toHaveLength(2);
  });
});

describe('RevenuePage — view tabs and tax switch', () => {
  beforeEach(() => vi.useFakeTimers());

  it('switches views and hides Clients without revenue:view_customers', async () => {
    stubFetch(payload());
    const { unmount } = renderPage();
    await flush();
    const tabs = screen.getByRole('tablist', { name: 'View' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Evolution', 'Customers', 'Products', 'Seasonality']);
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Products' }));
    expect(screen.getByRole('tabpanel')).toHaveAttribute('data-slot', 'revenue-view-produits');
    expect(localStorage.getItem('revenue-view')).toBe('produits');
    unmount();
    window.history.replaceState(null, '', '/');

    granted.delete('revenue:view_customers');
    localStorage.setItem('revenue-view', 'clients');
    renderPage();
    await flush();
    expect(within(screen.getByRole('tablist', { name: 'View' })).queryByRole('tab', { name: 'Customers' })).toBeNull();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('data-slot', 'revenue-view-evolution');
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/api/v1/revenue/customers'))).toBe(false);
  });

  it('opens Clients on the page range and filters, and its segment rows drive the page segment filter', async () => {
    window.history.replaceState(null, '', '/revenue?kind=goods');
    localStorage.setItem('revenue-view', 'clients');
    stubFetch(payload());
    const series = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url.startsWith('/api/v1/revenue/customers')
        ? json({
            from: '2025-12-01', to: '2026-11-19', customerCount: 0, customers: [], unsplitHt: 0,
            segments: [{ segment: 'pro', ht: 100, ttc: 113, goods: 100, services: 0, goodsTtc: 113, servicesTtc: 0, customers: 1 }],
            acquisition: { newCount: 1, newHt: 100, returningCount: 0, returningHt: 0, customerDays: 1, avgBasketHt: 100 },
            retention: [],
          })
        : series(url, init),
    );
    renderPage();
    await flush();
    await flush();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('data-slot', 'revenue-view-clients');
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain('/api/v1/revenue/customers?from=2025-12-01&to=2026-11-19&granularity=month&kind=goods');
    fireEvent.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: /^Business.+FCP/ }));
    await flush();
    expect(String(seriesCalls()[seriesCalls().length - 1][0])).toContain('&segment=pro');
    expect(localStorage.getItem('revenue-segment')).toBe('pro');
  });

  it('opens Products on the page range and filters', async () => {
    window.history.replaceState(null, '', '/revenue?kind=goods');
    localStorage.setItem('revenue-view', 'produits');
    stubFetch(payload());
    const series = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url.startsWith('/api/v1/revenue/analysis')
        ? json({
            from: '2025-12-01', to: '2026-11-19', dormant: [],
            abc: { rows: [], total: 0, classes: { A: { count: 0, ht: 0 }, B: { count: 0, ht: 0 }, C: { count: 0, ht: 0 } } },
          })
        : series(url, init),
    );
    renderPage();
    await flush();
    await flush();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('data-slot', 'revenue-view-produits');
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain('/api/v1/revenue/analysis?from=2025-12-01&to=2026-11-19&kind=goods');
    expect(within(screen.getByRole('tabpanel')).getByText('Nothing to rank.')).toBeInTheDocument();
  });

  it('opens Seasonality with the filters', async () => {
    window.history.replaceState(null, '', '/revenue?kind=goods');
    localStorage.setItem('revenue-view', 'saison');
    stubFetch(payload());
    const series = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url.startsWith('/api/v1/revenue/yoy')
        ? json({ years: [], today: '2026-11-19' })
        : url.startsWith('/api/v1/revenue/daily')
          ? json({ from: '2026-01-01', to: '2026-01-01', days: [] })
          : series(url, init),
    );
    renderPage();
    await flush();
    await flush();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('data-slot', 'revenue-view-saison');
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls).toContain('/api/v1/revenue/yoy?kind=goods');
    expect(urls).toContain('/api/v1/revenue/daily?kind=goods');
    expect(within(screen.getByRole('tabpanel')).getByText('Year by year')).toBeInTheDocument();
    expect(within(screen.getByRole('tabpanel')).getByText('Sales calendar')).toBeInTheDocument();
  });

  it('switches HT / TTC and remembers it', async () => {
    stubFetch(payload());
    renderPage();
    await flush();
    const amounts = screen.getByRole('group', { name: 'Amounts' });
    fireEvent.click(within(amounts).getByRole('button', { name: 'TTC' }));
    expect(within(amounts).getByRole('button', { name: 'TTC' })).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('revenue-tax-mode')).toBe('ttc');
  });
});

describe('RevenuePage — stored segment and customer permission', () => {
  beforeEach(() => vi.useFakeTimers());

  it('drops a stored segment from the request without revenue:view_customers', async () => {
    granted.delete('revenue:view_customers');
    localStorage.setItem('revenue-segment', 'pro');
    stubFetch(payload());
    renderPage();
    await flush();
    expect(String(seriesCalls()[0][0])).not.toContain('segment=');
  });

  it('sends a stored segment with revenue:view_customers', async () => {
    localStorage.setItem('revenue-segment', 'pro');
    stubFetch(payload());
    renderPage();
    await flush();
    expect(String(seriesCalls()[0][0])).toContain('&segment=pro');
  });
});

describe('RevenuePage — view tabs keyboard', () => {
  beforeEach(() => vi.useFakeTimers());

  it('arrow keys, Home and End move the selection and focus; only the selected tab is tabbable', async () => {
    stubFetch(payload());
    renderPage();
    await flush();
    const tabs = () => within(screen.getByRole('tablist', { name: 'View' })).getAllByRole('tab');
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
    const panel = screen.getByRole('tabpanel');
    expect(tabs()[0]).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', tabs()[0].id);

    fireEvent.keyDown(tabs()[0], { key: 'ArrowRight' });
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs()[1]).toHaveFocus();
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1, -1]);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', tabs()[1].id);

    fireEvent.keyDown(tabs()[1], { key: 'End' });
    expect(tabs()[3]).toHaveAttribute('aria-selected', 'true');
    expect(tabs()[3]).toHaveFocus();
    fireEvent.keyDown(tabs()[3], { key: 'ArrowRight' });
    expect(tabs()[0]).toHaveFocus();
    fireEvent.keyDown(tabs()[0], { key: 'ArrowLeft' });
    expect(tabs()[3]).toHaveFocus();
    fireEvent.keyDown(tabs()[3], { key: 'Home' });
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs()[0]).toHaveFocus();
  });
});

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
const menuItem = (name: string) => within(screen.getByRole('menu')).getByRole('menuitem', { name });

describe('RevenuePage — rebuild', () => {
  beforeEach(() => vi.useFakeTimers());

  it('posts ?full=1 after confirmation and disables Rebuild while in flight', async () => {
    let answer: (r: Response) => void = () => {};
    stubFetch(payload(), () => new Promise<Response>((resolve) => (answer = resolve)));
    renderPage();
    await flush();
    openMenu();
    fireEvent.click(menuItem('Rebuild'));
    expect(screen.getByText(/Reload every day from Zoho/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
    fireEvent.click(menuItem('Yes, rebuild'));
    await flush();
    expect(screen.queryByRole('menu')).toBeNull();
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(post?.[0]).toBe('/api/v1/revenue/sync?full=1');
    openMenu();
    expect(menuItem('Rebuild')).toBeDisabled();
    const before = seriesCalls().length;
    await act(async () => answer(json({ sync: sync({ backfilling: true }) })));
    await flush();
    expect(menuItem('Rebuild')).toBeEnabled();
    expect(seriesCalls().length).toBe(before + 1);
  });

  const confirmRebuild = async () => {
    renderPage();
    await flush();
    const before = seriesCalls().length;
    openMenu();
    fireEvent.click(menuItem('Rebuild'));
    fireEvent.click(menuItem('Yes, rebuild'));
    await flush();
    await flush();
    return before;
  };

  it('treats a 504 on a rebuild as started: refreshes, no error toast', async () => {
    stubFetch(payload(), async () => json({ detail: 'Upstream request timed out' }, 504));
    const before = await confirmRebuild();
    expect(screen.queryByText('Upstream request timed out')).toBeNull();
    expect(screen.getByText(/Rebuild started/)).toBeInTheDocument();
    expect(seriesCalls().length).toBe(before + 1);
  });

  it('says why a refused rebuild (503) did not start and that nothing was deleted', async () => {
    stubFetch(payload(), async () => json({ detail: 'Zoho credentials are not configured' }, 503));
    await confirmRebuild();
    expect(screen.getByText(/Rebuild not started.*Nothing was deleted/)).toBeInTheDocument();
    expect(screen.queryByText(/Rebuild started/)).toBeNull();
  });

  it('cancels the rebuild confirmation', async () => {
    stubFetch(payload());
    renderPage();
    await flush();
    openMenu();
    fireEvent.click(menuItem('Rebuild'));
    fireEvent.click(menuItem('Cancel'));
    expect(screen.queryByText(/Reload every day from Zoho/)).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  it('hides Rebuild without revenue:sync, and the banner never offers it', async () => {
    granted.delete('revenue:sync');
    stubFetch(payload());
    renderPage();
    await flush();
    expect(screen.queryByRole('button', { name: 'Rebuild' })).toBeNull();
    openMenu();
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'Rebuild' })).toBeNull();
  });
});

describe('RevenuePage — menu', () => {
  beforeEach(() => vi.useFakeTimers());

  it('opens a keyboard menu that Escape closes, focus back on ⋯', async () => {
    stubFetch(payload());
    renderPage();
    await flush();
    const trigger = screen.getByRole('button', { name: 'More actions' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Monthly targets…', 'Items to classify', 'Rebuild']);
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1], { key: 'ArrowUp' });
    fireEvent.keyDown(items[0], { key: 'ArrowUp' });
    expect(items[2]).toHaveFocus();
    fireEvent.keyDown(items[2], { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('disables copy and export until the dashboard is ready', async () => {
    granted.add('revenue:export');
    stubFetch(payload({ itemsSyncedAt: null }));
    renderPage();
    await flush();
    openMenu();
    expect(menuItem('Copy summary')).toBeDisabled();
    expect(menuItem('Export as CSV')).toBeDisabled();
  });

  it('offers no copy or export without revenue:export', async () => {
    stubFetch(payload());
    renderPage();
    await flush();
    openMenu();
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'Copy summary' })).toBeNull();
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'Export as CSV' })).toBeNull();
  });

  it('exports the CSV named from the payload and revokes its URL', async () => {
    granted.add('revenue:export');
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    stubFetch(payload({ kind: 'goods', brands: ['acme'] }));
    renderPage();
    await flush();
    openMenu();
    fireEvent.click(menuItem('Export as CSV'));
    expect(names).toEqual(['aito3d-ca-month-2025-12-01-2026-11-19-biens-marques.csv']);
    expect(create).toHaveBeenCalledTimes(1);
    await flush();
    expect(revoke).toHaveBeenCalledWith('blob:x');
    expect(screen.queryByRole('menu')).toBeNull();
    click.mockRestore();
    create.mockRestore();
    revoke.mockRestore();
  });

  it('copies the French summary and says so', async () => {
    granted.add('revenue:export');
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const nov = {
      key: '2026-11', label: 'nov. 2026', start: '2026-11-01', end: '2026-11-30', ht: 620_000, ttc: 700_600, goods: 620_000, services: 0,
      byNature: {}, byBrand: {}, goodsTtc: 700_600, servicesTtc: 0, byNatureTtc: {}, byBrandTtc: {}, projection: null, projectionMethod: null,
      target: null, quantity: 3, evolution: { ht: null, ttc: null }, yearAgo: null, elapsedDays: 19, cumulative: { ht: 620_000, ttc: 700_600 },
      partial: true, missingDays: 0, ttcApprox: false,
    };
    window.history.replaceState(null, '', '/revenue?kind=goods');
    stubFetch(payload({ buckets: [nov], kind: 'goods' }));
    renderPage();
    await flush();
    openMenu();
    fireEvent.click(menuItem('Copy summary'));
    await flush();
    expect(writeText).toHaveBeenCalledWith('CA nov. 2026 (en cours, 19 j) — Biens : 620.000 FCP HT');
    expect(screen.getByText('Summary copied — ready to paste.')).toBeInTheDocument();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  });

  it('says so when the clipboard is unavailable', async () => {
    granted.add('revenue:export');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    stubFetch(payload());
    renderPage();
    await flush();
    openMenu();
    fireEvent.click(menuItem('Copy summary'));
    await flush();
    expect(screen.getByText('The clipboard is unavailable.')).toBeInTheDocument();
  });

  it('opens the targets editor from the menu and gives focus back to ⋯ when it closes', async () => {
    stubFetch(payload());
    renderPage();
    await flush();
    openMenu();
    fireEvent.click(menuItem('Monthly targets…'));
    await flush();
    const panel = screen.getByRole('region', { name: 'Monthly HT targets' });
    expect(within(panel).getByRole('heading', { name: 'Monthly HT targets' })).toHaveFocus();
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain('/api/v1/revenue/targets');
    openMenu();
    expect(menuItem('Hide targets')).toBeInTheDocument();
    fireEvent.keyDown(menuItem('Hide targets'), { key: 'Escape' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Monthly HT targets' })).toBeNull();
    expect(screen.getByRole('button', { name: 'More actions' })).toHaveFocus();
  });
});

describe('RevenuePage — items to classify', () => {
  beforeEach(() => vi.useFakeTimers());

  it('shows the amber pill when items wait, opening the review panel', async () => {
    stubFetch(payload({ reviewCount: 3 }));
    renderPage();
    await flush();
    const pill = screen.getByRole('button', { name: 'To classify 3' });
    expect(pill).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(pill);
    await flush();
    expect(pill).toHaveAttribute('aria-pressed', 'true');
    const panel = screen.getByRole('region', { name: 'To classify' });
    expect(within(panel).getByRole('heading', { name: 'To classify' })).toHaveFocus();
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain('/api/v1/revenue/review');
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(pill).toHaveFocus();
  });

  it('puts focus on ⋯ when the pill that opened the panel is gone', async () => {
    let decided = false;
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/v1/revenue/scope/') && init?.method === 'PUT') {
        decided = true;
        return json({ decision: {} });
      }
      if (url === '/api/v1/revenue/review') {
        const row = { itemId: 'x1', name: 'Mystère', sku: '', totalHt: 100, quantity: 1, lastDay: '2026-10-01', brand: null, nature: null };
        return json({ unclassified: decided ? [] : [row], decided: [] });
      }
      if (url.startsWith('/api/v1/revenue?')) return json(payload({ reviewCount: decided ? 0 : 1 }));
      return json({ detail: 'not stubbed' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    granted.add('revenue:manage_scope');
    renderPage();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'To classify 1' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Include' }));
    await flush();
    await flush();
    expect(screen.queryByRole('button', { name: /To classify/ })).toBeNull();
    fireEvent.click(within(screen.getByRole('region', { name: 'To classify' })).getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: 'More actions' })).toHaveFocus();
  });

  it('has no pill when nothing waits; the menu still opens the panel', async () => {
    stubFetch(payload());
    renderPage();
    await flush();
    expect(screen.queryByRole('button', { name: /To classify/ })).toBeNull();
    openMenu();
    fireEvent.click(menuItem('Items to classify'));
    await flush();
    expect(screen.getByRole('region', { name: 'To classify' })).toBeInTheDocument();
  });
});

describe('RevenuePage — polling', () => {
  beforeEach(() => vi.useFakeTimers());

  it('polls every 4 s while backfilling', async () => {
    stubFetch(payload({ sync: sync({ backfilling: true, fetchedDays: 100 }) }));
    renderPage();
    await flush();
    expect(seriesCalls()).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(3999));
    expect(seriesCalls()).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(seriesCalls()).toHaveLength(2);
  });

  it('polls every 60 s when idle', async () => {
    stubFetch(payload());
    renderPage();
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(59_999));
    expect(seriesCalls()).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(seriesCalls()).toHaveLength(2);
  });

  it('arms no poll while hidden and reloads when the tab is shown again', async () => {
    setHidden(true);
    stubFetch(payload({ sync: sync({ backfilling: true }) }));
    renderPage();
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(seriesCalls()).toHaveLength(1);
    setHidden(false);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    expect(seriesCalls()).toHaveLength(2);
  });
});

const PRODUCTS = [
  { itemId: 'p1', name: 'Support Mini starlink', sku: 'SM-1', totalHt: 5000, quantity: 1, lastDay: '2026-11-01', brand: 'Aito' },
  { itemId: 'p2', name: 'eSUN PETG', sku: 'ES-2', totalHt: 4000, quantity: 1, lastDay: '2026-11-01', brand: 'eSUN' },
];

function stubWithProducts(series: RevenueResponse) {
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith('/api/v1/revenue/products')) return json({ products: PRODUCTS, fetchedAt: '2026-11-19T08:00:00.000Z' });
    if (url.startsWith('/api/v1/revenue?')) return json(series);
    return json({ detail: 'not stubbed' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
}
const lastSeries = () => String(seriesCalls().at(-1)?.[0]);
const productCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith('/api/v1/revenue/products'));

describe('RevenuePage — controls, URL and persistence', () => {
  beforeEach(() => vi.useFakeTimers());

  it('restores the URL over localStorage before the first request', async () => {
    localStorage.setItem('revenue-granularity', 'week');
    localStorage.setItem('revenue-kind', 'goods');
    window.history.replaceState(null, '', '/revenue?g=year&kind=services');
    stubWithProducts(payload());
    renderPage();
    await flush();
    expect(seriesCalls()).toHaveLength(1);
    expect(lastSeries()).toContain('granularity=year');
    expect(lastSeries()).toContain('kind=services');
    expect(localStorage.getItem('revenue-granularity')).toBe('week');
  });

  it('writes nothing to the URL before the controls are restored', async () => {
    localStorage.setItem('revenue-granularity', 'week');
    window.history.replaceState(null, '', '/revenue');
    const spy = vi.spyOn(window.history, 'replaceState');
    stubWithProducts(payload());
    renderPage();
    await flush();
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    for (const call of spy.mock.calls) expect(String(call[2])).toContain('g=week');
    expect(window.location.search).toBe('?g=week');
    spy.mockRestore();
  });

  it('keeps a stored segment out of the URL without revenue:view_customers, never erasing it', async () => {
    granted.delete('revenue:view_customers');
    localStorage.setItem('revenue-segment', 'pro');
    stubWithProducts(payload());
    renderPage();
    await flush();
    expect(window.location.search).not.toContain('segment');
    expect(screen.queryByRole('button', { name: /All customers/ })).toBeNull();
    expect(localStorage.getItem('revenue-segment')).toBe('pro');
  });

  it('persists granularity, range, kind and segment with the stored-control rules', async () => {
    stubWithProducts(payload());
    renderPage();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Week' }));
    expect(localStorage.getItem('revenue-granularity')).toBe('week');
    fireEvent.click(screen.getByRole('button', { name: /Auto/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Since 2024' }));
    expect(localStorage.getItem('revenue-range')).toBe('all');
    fireEvent.click(screen.getByRole('button', { name: /Since 2024/ }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2025-01-01' } });
    expect(localStorage.getItem('revenue-range')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Goods' }));
    expect(localStorage.getItem('revenue-kind')).toBe('goods');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(localStorage.getItem('revenue-kind')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /All customers/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Business' }));
    expect(localStorage.getItem('revenue-segment')).toBe('pro');
    await flush();
    expect(lastSeries()).toContain('segment=pro');
  });

  it('steps the period inside the history: ‹ disabled at its start', async () => {
    stubWithProducts(payload({ from: '2024-01-01', to: '2024-01-31' }));
    renderPage();
    await flush();
    expect(screen.getByRole('button', { name: 'Previous period (←)' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next period (→)' }));
    await flush();
    expect(lastSeries()).toContain('from=2024-02-01&to=2024-02-29');
  });

  it('adds a product: the series follows the basket, the stack switches to item, nothing persisted', async () => {
    stubWithProducts(payload());
    renderPage();
    await flush();
    expect(productCalls()).toHaveLength(1);
    const box = screen.getByRole('searchbox', { name: 'Search for a product' });
    fireEvent.change(box, { target: { value: 'starlink' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await flush();
    expect(lastSeries()).toContain('items=p1');
    expect(window.location.search).toContain('stack=item');
    expect(window.location.search).toContain('items=p1');
    const stored = vi.mocked(localStorage.setItem).mock.calls.map((c) => c[0]);
    expect(stored.filter((k) => !k.startsWith('revenue-') || /brand|basket|items/.test(k))).toEqual([]);
    expect(localStorage.getItem('revenue-stack')).toBeNull();
  });

  it('turns a linked basket and brand into chips once the products load', async () => {
    window.history.replaceState(null, '', '/revenue?items=p2,zz&brand=eSUN');
    stubWithProducts(payload());
    renderPage();
    await flush();
    await flush();
    const chips = screen.getByLabelText('Selection');
    expect(within(chips).getByText('eSUN PETG')).toBeInTheDocument();
    expect(within(chips).getByRole('button', { name: 'Remove brand eSUN' })).toBeInTheDocument();
    expect(lastSeries()).toContain('items=p2');
    expect(lastSeries()).toContain('brand=esun');
  });

  it('never puts a malformed URL value into a request', async () => {
    window.history.replaceState(null, '', '/revenue?granularity=hour&g=hour&from=2026-13-40&to=2026-01-01&items=a%20b&kind=x');
    stubWithProducts(payload());
    renderPage();
    await flush();
    await flush();
    for (const [u] of fetchMock.mock.calls) {
      expect(String(u)).not.toMatch(/hour|2026-13-40|a%20b|a b|kind=x/);
    }
    expect(lastSeries()).toBe('/api/v1/revenue?granularity=month');
  });

  it('sends no request for an out-of-bounds custom pair', async () => {
    stubWithProducts(payload());
    renderPage();
    await flush();
    const before = seriesCalls().length;
    fireEvent.click(screen.getByRole('button', { name: /Auto/ }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2023-06-01' } });
    await flush();
    expect(screen.getByLabelText('From')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2025-01-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2099-01-01' } });
    await flush();
    expect(screen.getByLabelText('To')).toHaveAttribute('aria-invalid', 'true');
    expect(seriesCalls().length).toBe(before + 1);
    expect(lastSeries()).toContain('from=2025-01-01&to=2026-11-19');
    expect(window.location.search).not.toMatch(/2023-06-01|2099/);
  });

  it('toggling a brand leaves localStorage untouched', async () => {
    stubWithProducts(payload());
    renderPage();
    await flush();
    vi.mocked(localStorage.setItem).mockClear();
    vi.mocked(localStorage.removeItem).mockClear();
    // The chart's « Stack by » has a Brand button too.
    fireEvent.click(within(document.querySelector<HTMLElement>('[data-slot="revenue-controls"]')!).getByRole('button', { name: 'Brand' }));
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Brands' })).getAllByRole('checkbox')[1]);
    await flush();
    expect(lastSeries()).toContain('brand=esun');
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(localStorage.removeItem).not.toHaveBeenCalled();
  });

  it('clears the filters but keeps a stored segment it may not see', async () => {
    granted.delete('revenue:view_customers');
    localStorage.setItem('revenue-segment', 'pro');
    localStorage.setItem('revenue-kind', 'goods');
    stubWithProducts(payload());
    renderPage();
    await flush();
    const chips = screen.getByLabelText('Selection');
    fireEvent.click(within(chips).getByRole('button', { name: 'Clear all' }));
    expect(localStorage.getItem('revenue-kind')).toBeNull();
    expect(localStorage.getItem('revenue-segment')).toBe('pro');
  });
});

describe('Revenue nav item and route', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/version', () => HttpResponse.json({ version: '0.1.6', build: 'test' })),
      http.get('/api/v1/settings/ui-flags', () => HttpResponse.json({ check_updates: false, billing_enabled: false })),
      http.get('/api/v1/inbox', () => HttpResponse.json({ items: [], unread: 0 })),
    );
  });

  it('hides the nav item without revenue:read', async () => {
    granted = new Set();
    render(<Layout />);
    await waitFor(() => expect(document.querySelector('aside')).toBeInTheDocument());
    expect(document.querySelector('a[href="/revenue"]')).toBeNull();
  });

  it('shows the nav item with revenue:read', async () => {
    granted = new Set(['revenue:read']);
    render(<Layout />);
    await waitFor(() => expect(document.querySelector('a[href="/revenue"]')).toBeInTheDocument());
  });

  it('redirects /revenue to the home screen without revenue:read', async () => {
    granted = new Set(['printers:read']);
    vi.resetModules();
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json([])),
      http.get('/api/v1/queue/', () => HttpResponse.json([])),
      http.get('/api/v1/pending-uploads/', () => HttpResponse.json([])),
      http.get('/api/v1/pending-uploads/count', () => HttpResponse.json({ count: 0 })),
      http.get('/api/v1/support/debug-logging', () => HttpResponse.json({ enabled: false })),
      http.get('/api/v1/printers/developer-mode-warnings', () => HttpResponse.json([])),
    );
    window.history.pushState({}, '', '/revenue');
    const { default: App } = await import('../../App');
    rtlRender(<App />);
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(await screen.findByText('No printers configured yet', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Revenue' })).toBeNull();
    window.history.replaceState(null, '', '/');
  });
});

describe('RevenuePage — chart drill-down', () => {
  beforeEach(() => vi.useFakeTimers());

  const month = (key: string, label: string, start: string, end: string, ht: number) => ({
    key, label, start, end, ht, ttc: ht, goods: ht, services: 0, byNature: { Filaments: ht }, byBrand: {}, goodsTtc: ht, servicesTtc: 0,
    byNatureTtc: { Filaments: ht }, byBrandTtc: {}, projection: null, projectionMethod: null, target: null, quantity: 1,
    evolution: { ht: null, ttc: null }, yearAgo: null, elapsedDays: null, cumulative: { ht, ttc: ht }, partial: false, missingDays: 0, ttcApprox: false,
  });
  const lastSeries = () => String(seriesCalls().at(-1)?.[0]);

  it('drills into a column for this visit only; Retour and a manual granularity change undo it', async () => {
    stubFetch(payload({ buckets: [month('2026-10', 'oct. 2026', '2026-10-01', '2026-10-31', 500_000), month('2026-11', 'nov. 2026', '2026-11-01', '2026-11-30', 600_000)] }));
    renderPage();
    await flush();
    const first = lastSeries();
    const search = window.location.search;
    vi.mocked(localStorage.setItem).mockClear();
    vi.mocked(localStorage.removeItem).mockClear();

    fireEvent.keyDown(screen.getByRole('button', { name: 'oct. 2026 – 500.000 FCP' }), { key: 'Enter' });
    await flush();
    expect(lastSeries()).toBe('/api/v1/revenue?granularity=day&from=2026-10-01&to=2026-10-31');
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(localStorage.removeItem).not.toHaveBeenCalled();
    expect(window.location.search).toBe(search);

    fireEvent.keyDown(screen.getByRole('button', { name: 'nov. 2026 – 600.000 FCP' }), { key: 'Enter' });
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '← Back (levels: 2)' }));
    await flush();
    expect(lastSeries()).toBe('/api/v1/revenue?granularity=day&from=2026-10-01&to=2026-10-31');
    fireEvent.click(screen.getByRole('button', { name: '← Back' }));
    await flush();
    expect(lastSeries()).toBe(first);
    expect(screen.queryByRole('button', { name: /← Back/ })).toBeNull();

    fireEvent.keyDown(screen.getByRole('button', { name: 'oct. 2026 – 500.000 FCP' }), { key: 'Enter' });
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Week' }));
    await flush();
    expect(lastSeries()).toBe('/api/v1/revenue?granularity=week');
    expect(screen.queryByRole('button', { name: /← Back/ })).toBeNull();
  });

  it('stacks the chart by the chosen dimension and persists it', async () => {
    stubFetch(payload({ buckets: [month('2026-11', 'nov. 2026', '2026-11-01', '2026-11-30', 600_000)] }));
    renderPage();
    await flush();
    const stackBy = screen.getByRole('group', { name: 'Stack by' });
    fireEvent.click(within(stackBy).getByRole('button', { name: 'Goods / Services' }));
    expect(within(stackBy).getByRole('button', { name: 'Goods / Services' })).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('revenue-stack')).toBe('kind');
  });
});
