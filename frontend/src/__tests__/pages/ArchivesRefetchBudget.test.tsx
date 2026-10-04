/**
 * One archive change refetches the archive list once, not three times.
 *
 * Every archive WebSocket event invalidates ['archives'], which refetched the
 * head list, the full list and the no-3MF banner alike; returning to the tab
 * after a minute refetched the full list again. At ~6k archives each full list
 * is ~1 MB gzipped, and a print sends 3-5 such events. The head is only needed
 * until the full list arrives, the banner has its own staleness, and the
 * WebSocket keeps the full list fresh.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { AuthProvider } from '../../contexts/AuthContext';
import { FullscreenProvider } from '../../contexts/FullscreenContext';
import { ArchivesPage } from '../../pages/ArchivesPage';
import { setAuthToken } from '../../api/client';

const row = {
  id: 1, filename: 'Benchy.gcode.3mf', print_name: 'Benchy', printer_id: 1, printer_name: 'X1 Carbon',
  print_time_seconds: 3600, filament_used_grams: 10, status: 'completed',
  started_at: '2026-10-01T10:00:00Z', completed_at: '2026-10-01T10:00:00Z', thumbnail_path: null,
  notes: null, rating: null, project_id: null, project_name: null, project_color: null, print_count: 1,
  tags: '', created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z', has_f3d: false,
  duplicate_count: 0, duplicate_sequence: 0, original_archive_id: null,
};

describe('archive list refetch budget', () => {
  const calls = { head: 0, full: 0, banner: 0 };
  let client: QueryClient;

  beforeEach(() => {
    calls.head = calls.full = calls.banner = 0;
    setAuthToken(null);
    localStorage.setItem('archiveViewMode', 'grid');
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    server.use(
      http.get('/api/v1/archives/', ({ request }) => {
        const limit = new URL(request.url).searchParams.get('limit');
        if (limit === '10000') calls.full += 1;
        else calls.head += 1;
        return HttpResponse.json([row]);
      }),
      http.get('/api/v1/archives/no-3mf-warning', () => {
        calls.banner += 1;
        return HttpResponse.json({ has_fallback: false, reason: null });
      }),
      http.get('/api/v1/archives/stats', () => HttpResponse.json({ total_archives: 1 })),
      http.get('/api/v1/printers/', () => HttpResponse.json([{ id: 1, name: 'X1 Carbon' }])),
      http.get('/api/v1/projects/', () => HttpResponse.json([])),
      http.get('/api/v1/archives/tags', () => HttpResponse.json([])),
    );
  });

  // Mount-time loads (including the one the auth provider triggers as it
  // settles) are not what these tests measure; wait until they stop.
  const settle = async () => {
    let last = -1;
    while (last !== calls.full + calls.head + calls.banner) {
      last = calls.full + calls.head + calls.banner;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };

  const renderPage = () =>
    render(
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <AuthProvider>
            <ThemeProvider>
              <FullscreenProvider>
                <ToastProvider>
                  <ArchivesPage />
                </ToastProvider>
              </FullscreenProvider>
            </ThemeProvider>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>,
    );

  it('an archive event refetches only the full list', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument(), { timeout: 5000 });
    await settle();
    const before = { ...calls };

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['archives'] });
    });

    await waitFor(() => expect(calls.full).toBe(before.full + 1));
    expect(calls.head).toBe(before.head);
    expect(calls.banner).toBe(before.banner);
  });

  it('returning to the tab does not refetch the full list', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Benchy')).toBeInTheDocument(), { timeout: 5000 });
    await settle();
    const before = calls.full;

    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls.full).toBe(before);
    focusManager.setFocused(undefined);
  });
});
