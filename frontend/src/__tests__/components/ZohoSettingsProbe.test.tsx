/**
 * The modal's passive Zoho-status query and the settings page's Test button
 * must not share a cache entry: a probed result must not satisfy the
 * unprobed query, nor an unprobed result satisfy the probed one. See
 * docs/superpowers/specs/2026-07-27-aito-card-header-and-modal-latency-design.md
 * §"Frontend" — the three-key split (`{ probe: false }` / `{ probe: true }`)
 * this test protects. `ZohoSettings` alone exercises both halves of the
 * split: its passive query is the same `{ probe: false }` key `NewProjectModal`
 * and `ClientSection` use, and its Test button is the only `{ probe: true }`
 * caller.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from '../../contexts/AuthContext';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { FullscreenProvider } from '../../contexts/FullscreenContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { ZohoSettings } from '../../components/ZohoSettings';
import { server } from '../mocks/server';

// A local render, not ../utils's, because that helper sets gcTime: 0 (each
// query is evicted the instant its last observer unmounts) and does not
// expose the QueryClient it builds — both of which this file needs to
// inspect cache entries directly rather than infer them from timing.
function renderWithClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = rtlRender(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <ThemeProvider>
            <FullscreenProvider>
              <ToastProvider>
                <ZohoSettings />
              </ToastProvider>
            </FullscreenProvider>
          </ThemeProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
  return { queryClient, ...utils };
}

describe('ZohoSettings — probe cache-key split', () => {
  let probeParams: (string | null)[];

  beforeEach(() => {
    probeParams = [];
    server.use(
      http.get('/api/v1/zoho/status', ({ request }) => {
        const probe = new URL(request.url).searchParams.get('probe');
        probeParams.push(probe);
        return HttpResponse.json({
          configured: true,
          reachable: probe === 'true' ? true : null,
          default_contact_id: '',
          default_contact_name: '',
        });
      }),
    );
  });

  it('mounts with an unprobed request', async () => {
    renderWithClient();
    await waitFor(() => expect(probeParams.length).toBeGreaterThan(0));
    expect(probeParams).toEqual([null]);
  });

  it('the Test button issues a probed request', async () => {
    const user = userEvent.setup();
    renderWithClient();
    await waitFor(() => expect(probeParams.length).toBeGreaterThan(0));

    await user.click(screen.getByRole('button', { name: /test/i }));
    await waitFor(() => expect(probeParams).toContain('true'));

    expect(probeParams).toEqual([null, 'true']);
  });

  it('a probed cache entry does not satisfy the unprobed key, or vice versa', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderWithClient();
    await waitFor(() => expect(probeParams.length).toBeGreaterThan(0));

    await user.click(screen.getByRole('button', { name: /test/i }));
    await waitFor(() => expect(probeParams).toContain('true'));

    // Two distinct cache entries must exist — one per key — each holding
    // the response for its own probe value. If the keys were collapsed to
    // a bare ['zoho-status'], only one entry would exist under that shorter
    // key and both of these structural lookups would come back `undefined`.
    const unprobed = queryClient.getQueryData(['zoho-status', { probe: false }]) as
      | { reachable: boolean | null }
      | undefined;
    const probed = queryClient.getQueryData(['zoho-status', { probe: true }]) as
      | { reachable: boolean | null }
      | undefined;

    expect(unprobed).toBeDefined();
    expect(probed).toBeDefined();
    expect(unprobed?.reachable).toBeNull();
    expect(probed?.reachable).toBe(true);
  });

  it('a fresh mount after the Test button has run still issues its own unprobed request', async () => {
    const user = userEvent.setup();
    const { unmount, queryClient } = renderWithClient();
    await waitFor(() => expect(probeParams.length).toBeGreaterThan(0));

    await user.click(screen.getByRole('button', { name: /test/i }));
    await waitFor(() => expect(probeParams).toContain('true'));
    expect(probeParams).toEqual([null, 'true']);

    unmount();
    // Same QueryClient (and therefore cache) across the remount — this is
    // what distinguishes it from the earlier tests, which each start a
    // fresh client and would pass even with a shared/collapsed key.
    rtlRender(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <ThemeProvider>
              <FullscreenProvider>
                <ToastProvider>
                  <ZohoSettings />
                </ToastProvider>
              </FullscreenProvider>
            </ThemeProvider>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(probeParams.length).toBeGreaterThan(2));
    expect(probeParams).toEqual([null, 'true', null]);
  });
});
