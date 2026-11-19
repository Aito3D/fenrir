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

  it('shows the error with a retry that reloads', async () => {
    fetchMock = vi.fn(async () => json({ detail: 'Zoho is down' }, 502));
    vi.stubGlobal('fetch', fetchMock);
    renderPage();
    await flush();
    expect(screen.getByText('Zoho is down')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

    granted.delete('revenue:view_customers');
    localStorage.setItem('revenue-view', 'clients');
    renderPage();
    await flush();
    expect(within(screen.getByRole('tablist', { name: 'View' })).queryByRole('tab', { name: 'Customers' })).toBeNull();
    expect(screen.getByRole('tabpanel')).toHaveAttribute('data-slot', 'revenue-view-evolution');
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

describe('RevenuePage — rebuild', () => {
  beforeEach(() => vi.useFakeTimers());

  it('posts ?full=1 after confirmation and disables Rebuild while in flight', async () => {
    let answer: (r: Response) => void = () => {};
    stubFetch(payload(), () => new Promise<Response>((resolve) => (answer = resolve)));
    renderPage();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, rebuild' }));
    await flush();
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(post?.[0]).toBe('/api/v1/revenue/sync?full=1');
    expect(screen.getByRole('button', { name: 'Rebuild' })).toBeDisabled();
    const before = seriesCalls().length;
    await act(async () => answer(json({ sync: sync({ backfilling: true }) })));
    await flush();
    expect(screen.getByRole('button', { name: 'Rebuild' })).toBeEnabled();
    expect(seriesCalls().length).toBe(before + 1);
  });

  it('hides Rebuild without revenue:sync', async () => {
    granted.delete('revenue:sync');
    stubFetch(payload());
    renderPage();
    await flush();
    expect(screen.queryByRole('button', { name: 'Rebuild' })).toBeNull();
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
