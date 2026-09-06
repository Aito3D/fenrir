/**
 * T-035: pins the REAL /aito route guard wired inside App.tsx's own router,
 * as opposed to the T-012 block in AitoPageAitoPermissions.test.tsx, which
 * deliberately rebuilds `PermissionRoute` and the `<Route path="aito" ...>`
 * element by hand (App.tsx exports neither its router nor that helper) — see
 * that file's own comment on why it can't import App.tsx's tree. The golden
 * router snapshot (snapshots/fe-router.golden) only records element *types*
 * for that route, not the `permission` prop's value, so neither the golden
 * nor the T-012 mirror would fail if App.tsx's real "aito" route were
 * changed to a different permission string, or had its guard removed
 * entirely. This test imports App.tsx itself and renders it.
 *
 * App.tsx builds its `createBrowserRouter` tree once, at module load, from
 * whatever `window.location` is at that moment — so each case here sets the
 * URL with `window.history.pushState` and THEN dynamically imports App.tsx
 * fresh (`vi.resetModules()` first) rather than importing it statically.
 *
 * Mocked at the module boundary, none of it bearing on the permission
 * contract under test:
 *  - `useAuth` (AuthContext) — same canned object pattern as
 *    AitoPageAitoPermissions.test.tsx, so `hasPermission('aito:read')` is
 *    fully controlled by the test instead of a real permission set.
 *  - `useWebSocket` / `usePrintProgressTitle` / `useStreamTokenSync` — App.tsx
 *    calls these unconditionally for every authenticated route (including
 *    the redirect target `/`), and a real socket needs an unstubbed
 *    `POST /auth/ws-token` plus a live connection lifecycle that has nothing
 *    to do with which permission gates `/aito`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, render as rtlRender, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from './mocks/server';

const mockUseAuth = {
  user: { id: 1, username: 'operator', permissions: [] as string[] },
  authEnabled: true,
  requiresSetup: false,
  loading: false,
  isAdmin: false,
  login: vi.fn(),
  loginWithToken: vi.fn(),
  logout: vi.fn(),
  refreshUser: vi.fn(),
  refreshAuth: vi.fn(),
  hasPermission: vi.fn((_permission: string) => true),
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

// Endpoints the shell (Layout) and the two candidate leaf routes (AitoPage,
// and PrintersPage at "/" — the redirect target) need to mount without
// throwing, none of which bear on the permission contract under test.
function stubAppShellEndpoints() {
  server.use(
    http.get('/api/v1/printers/', () => HttpResponse.json([])),
    http.get('/api/v1/printers/:id/status', () => HttpResponse.json({ connected: false, state: 'IDLE' })),
    http.get('/api/v1/queue/', () => HttpResponse.json([])),
    http.get('/api/v1/pending-uploads/', () => HttpResponse.json([])),
    http.get('/api/v1/pending-uploads/count', () => HttpResponse.json({ count: 0 })),
    http.get('/api/v1/support/debug-logging', () => HttpResponse.json({ enabled: false })),
    http.get('/api/v1/printers/developer-mode-warnings', () => HttpResponse.json([])),
    http.get('/api/v1/settings/ui-preferences', () =>
      HttpResponse.json({
        ams_humidity_good: 40,
        ams_humidity_fair: 60,
        ams_temp_good: 30,
        ams_temp_fair: 35,
        require_plate_clear: true,
      }),
    ),
    http.get('/api/v1/aito/', () => HttpResponse.json([])),
  );
}

beforeEach(() => {
  vi.resetModules();
  stubAppShellEndpoints();
  mockUseAuth.authEnabled = true;
  mockUseAuth.hasPermission.mockReset();
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('App router — /aito route guard (T-035)', () => {
  it('without aito:read: redirects to / and never mounts the Aito board', async () => {
    mockUseAuth.hasPermission.mockImplementation((permission: string) => permission !== 'aito:read');
    window.history.pushState({}, '', '/aito');

    const { default: App } = await import('../App');
    rtlRender(<App />);

    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument();
    expect(screen.queryByText(/UI Crash/i)).not.toBeInTheDocument();
  });

  it('with aito:read: mounts the Aito board at /aito', async () => {
    mockUseAuth.hasPermission.mockImplementation((permission: string) => permission === 'aito:read');
    window.history.pushState({}, '', '/aito');

    const { default: App } = await import('../App');
    rtlRender(<App />);

    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/aito');
    expect(screen.queryByText(/UI Crash/i)).not.toBeInTheDocument();
  });
});
