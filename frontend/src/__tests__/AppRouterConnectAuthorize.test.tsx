/**
 * The connected-apps consent page inside the fork's own router.
 *
 * Upstream added `/connect/authorize` to its eager `<BrowserRouter>` tree; the
 * fork builds a lazy `createBrowserRouter` tree instead, so the route was
 * hand-ported in the 2026-09-27 merge. ConnectAuthorizePage.test.tsx renders
 * the page on its own and cannot notice a missing or misplaced route. This
 * pins the three things the port had to get right: the path resolves, it sits
 * behind ProtectedRoute (a logged-out visitor is sent to /login), and it
 * renders standalone, without the app shell, so it fits in the sidebar
 * iframe of the app asking.
 *
 * App.tsx builds its router at module load from `window.location`, so each
 * case sets the URL first and then imports App fresh (see
 * AppRouterAitoGuard.test.tsx for the full rationale).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, render as rtlRender, waitFor } from '@testing-library/react';

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
  hasPermission: vi.fn(() => true),
  hasAnyPermission: vi.fn(() => true),
  hasAllPermissions: vi.fn(() => true),
  canModify: vi.fn(() => true),
};

vi.mock('../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../contexts/AuthContext')>();
  return { ...actual, useAuth: () => mockUseAuth };
});

vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => {} }));
vi.mock('../hooks/usePrintProgressTitle', () => ({ usePrintProgressTitle: () => {} }));
vi.mock('../hooks/useCameraStreamToken', () => ({ useStreamTokenSync: () => {} }));

vi.mock('../pages/ConnectAuthorizePage', () => ({
  ConnectAuthorizePage: () => <div data-testid="connect-authorize">consent</div>,
}));

const AUTHORIZE_URL = '/connect/authorize?client_id=abc&redirect_uri=https%3A%2F%2Forders.example%2Fcb';

beforeEach(() => {
  vi.resetModules();
  mockUseAuth.user = { id: 1, username: 'operator', permissions: [] };
  mockUseAuth.loading = false;
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('App router — /connect/authorize', () => {
  it('renders the consent page standalone for a signed-in user', async () => {
    window.history.pushState({}, '', AUTHORIZE_URL);

    const { default: App } = await import('../App');
    rtlRender(<App />);

    expect(await screen.findByTestId('connect-authorize')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/connect/authorize');
    expect(window.location.search).toContain('client_id=abc');
    // Standalone: the app shell's sidebar navigation is not mounted.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('sends a logged-out visitor to /login instead', async () => {
    mockUseAuth.user = null;
    window.history.pushState({}, '', AUTHORIZE_URL);

    const { default: App } = await import('../App');
    rtlRender(<App />);

    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    expect(screen.queryByTestId('connect-authorize')).not.toBeInTheDocument();
  });
});
