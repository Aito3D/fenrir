import { useEffect, useState } from 'react';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import i18n from '../../i18n';
import { screen, render as rtlRender, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { server } from '../mocks/server';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AitoTrackEntryPage } from '../../pages/AitoTrackEntryPage';
import { normalizeCode } from '../../utils/trackingCode';
import type { AitoTracking } from '../../api/client';

// `ready` (react-i18next's bundle-loaded flag) is only ever false for a real
// instant — the fr chunk this file already forces via `beforeAll` below is
// fully loaded before any test runs. To exercise the not-ready render (and
// its flip to ready) deterministically, wrap the real hook and let a test
// pin `ready` to a fixed value; every other test leaves the override unset
// and gets the real hook untouched.
let readyOverride: boolean | null = null;
const readyOverrideListeners = new Set<() => void>();
function setReadyOverride(value: boolean | null) {
  readyOverride = value;
  readyOverrideListeners.forEach((listener) => listener());
}
vi.mock('../../hooks/useTrackingLanguage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/useTrackingLanguage')>();
  return {
    ...actual,
    useTrackingLanguage: (...args: Parameters<typeof actual.useTrackingLanguage>) => {
      const real = actual.useTrackingLanguage(...args);
      const [, forceRender] = useState(0);
      useEffect(() => {
        const listener = () => forceRender((n) => n + 1);
        readyOverrideListeners.add(listener);
        return () => {
          readyOverrideListeners.delete(listener);
        };
      }, []);
      return readyOverride === null ? real : { ...real, ready: readyOverride };
    },
  };
});

const FIXTURE: AitoTracking = {
  column: 'print',
  tasks: [{ title: 'Support GoPro', quantity: null }],
  due_date: '2026-09-20', shipping: null, done_at: null,
  invoice: null, reference: 'EST-000142', updated_at: '2026-09-03T21:05:00',
};

function Landed() {
  const { token } = useParams();
  return <p>landed on {token}</p>;
}

function renderEntry() {
  // gcTime kept: a seeded query has no observer until the next page mounts,
  // and the app's own client holds it for five minutes.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
  const view = rtlRender(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/t']}>
        <Routes>
          <Route path="/t" element={<AitoTrackEntryPage />} />
          <Route path="/t/:token" element={<Landed />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

/** What the server saw, per request, so a test can pin the exact code sent. */
function mockTrack(status: 200 | 404 | 429 | 500) {
  const seen: string[] = [];
  server.use(
    http.get('/api/v1/aito/track/:token', ({ params }) => {
      seen.push(String(params.token));
      if (status === 200) return HttpResponse.json(FIXTURE);
      return HttpResponse.json({ detail: 'x' }, { status });
    }),
  );
  return seen;
}

/** Stands in for a request the server accepted but never answered — never
 *  resolves on its own, so only the client-side abort timeout (T-072) ends
 *  it. */
function mockTrackHung() {
  const seen: string[] = [];
  server.use(
    http.get('/api/v1/aito/track/:token', async ({ params }) => {
      seen.push(String(params.token));
      await delay('infinite');
      return HttpResponse.json(FIXTURE);
    }),
  );
  return seen;
}

const input = () => screen.getByLabelText('Code de suivi');
const row = () => screen.getByTestId('track-code');
const status = () => screen.getByTestId('track-code-status');

beforeAll(() => i18n.changeLanguage('fr'));
afterAll(() => i18n.changeLanguage('en'));
afterEach(async () => {
  setReadyOverride(null);
  await i18n.changeLanguage('fr');
});

describe('normalizeCode', () => {
  it('uppercases, folds the look-alikes, drops separators and stops at six', () => {
    expect(normalizeCode('k7f3xq')).toBe('K7F3XQ');
    expect(normalizeCode('kof3lq')).toBe('K0F31Q');
    expect(normalizeCode('KIF3XQ')).toBe('K1F3XQ');
    expect(normalizeCode(' k7f-3xq 9w')).toBe('K7F3XQ');
    expect(normalizeCode('k7u!')).toBe('K7');
    expect(normalizeCode('')).toBe('');
  });
});

describe('AitoTrackEntryPage', () => {
  it('shows six squares, a focused field and the hint, in French', async () => {
    renderEntry();
    expect(await screen.findByRole('heading', { name: 'Suivre ma commande' })).toBeInTheDocument();
    expect(row().querySelectorAll('.code-cell')).toHaveLength(6);
    expect(row()).toHaveAttribute('data-state', 'idle');
    expect(input()).toHaveFocus();
    expect(input()).toHaveAttribute('autocomplete', 'one-time-code');
    expect(screen.queryByRole('button', { name: /suivre|ok|valider/i })).not.toBeInTheDocument();
  });

  it('draws each typed character into its square, normalised as it is typed', async () => {
    renderEntry();
    await screen.findByRole('heading', { name: 'Suivre ma commande' });
    await userEvent.type(input(), 'ko');
    expect(input()).toHaveValue('K0');
    const cells = row().querySelectorAll('.code-cell');
    expect(cells[0]).toHaveTextContent('K');
    expect(cells[0]).toHaveAttribute('data-filled');
    expect(cells[1]).toHaveTextContent('0');
    expect(cells[2]).not.toHaveAttribute('data-filled');
    // The caret frame glides to the next empty square; its translate is on
    // the wrapper, where no animation fill can override it.
    const caret = row().querySelector('.code-caret-wrap') as HTMLElement;
    expect(caret).toHaveAttribute('data-index', '2');
    expect(caret.style.transform).toContain('calc(2 *');
  });

  it('checks the code on the sixth character, seeds the cache and opens the page', async () => {
    const seen = mockTrack(200);
    const { queryClient } = renderEntry();
    await screen.findByRole('heading', { name: 'Suivre ma commande' });
    await userEvent.type(input(), 'k7f3xq');
    await waitFor(() => expect(row()).toHaveAttribute('data-state', 'found'));
    expect(seen).toEqual(['K7F3XQ']);
    expect(status()).toHaveTextContent('Code reconnu');
    expect(input()).toHaveAttribute('readonly');
    // Same key the tracking page reads: it paints from this, no second fetch.
    expect(queryClient.getQueryData(['aito-track', 'K7F3XQ'])).toEqual(FIXTURE);
    expect(await screen.findByText('landed on K7F3XQ', {}, { timeout: 2500 })).toBeInTheDocument();
  });

  it('shakes and says so on an unknown code, keeping what was typed for correction', async () => {
    mockTrack(404);
    renderEntry();
    await screen.findByRole('heading', { name: 'Suivre ma commande' });
    await userEvent.type(input(), 'ZZZZZZ');
    await waitFor(() => expect(row()).toHaveAttribute('data-state', 'error'));
    expect(status()).toHaveTextContent('Code introuvable');
    expect(input()).toHaveValue('ZZZZZZ');
    expect(input()).toHaveAttribute('aria-invalid', 'true');
    // The next keystroke clears the verdict.
    await userEvent.type(input(), '{backspace}');
    expect(row()).toHaveAttribute('data-state', 'idle');
    expect(status()).toHaveTextContent('');
    expect(input()).toHaveValue('ZZZZZ');
  });

  it('tells a throttled client to wait, and offers Enter to retry a failed check', async () => {
    mockTrack(429);
    renderEntry();
    await screen.findByRole('heading', { name: 'Suivre ma commande' });
    await userEvent.type(input(), 'K7F3XQ');
    await waitFor(() => expect(status()).toHaveTextContent('Trop de tentatives'));
    const seen = mockTrack(500);
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(status()).toHaveTextContent('Impossible de vérifier le code'));
    expect(seen).toEqual(['K7F3XQ']);
  });

  it('accepts a pasted code with separators and sends only the six characters', async () => {
    const seen = mockTrack(200);
    renderEntry();
    await screen.findByRole('heading', { name: 'Suivre ma commande' });
    await userEvent.click(input());
    await userEvent.paste('k7f3-xq 9w');
    expect(input()).toHaveValue('K7F3XQ');
    await waitFor(() => expect(seen).toEqual(['K7F3XQ']));
  });

  // T-072: a client on a flaky connection whose request is accepted but
  // never answered was left with six frozen squares forever — no retry, no
  // way out but a reload. An AbortController armed with a timeout now ends
  // the check and lands on the same retryable error a network failure
  // already shows.
  it('aborts a check that hangs past the timeout, lands on the retryable error state, and accepts a fresh retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const seen = mockTrackHung();
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderEntry();
      await screen.findByRole('heading', { name: 'Suivre ma commande' });
      await user.type(input(), 'k7f3xq');
      await waitFor(() => expect(row()).toHaveAttribute('data-state', 'checking'));
      expect(seen).toEqual(['K7F3XQ']);
      expect(input()).toHaveAttribute('readonly');

      // Comfortably inside the deadline: still checking, no error yet.
      await vi.advanceTimersByTimeAsync(9_000);
      expect(row()).toHaveAttribute('data-state', 'checking');

      // Cross the deadline: the abort fires and the catch takes over.
      await vi.advanceTimersByTimeAsync(1_001);
      await waitFor(() => expect(row()).toHaveAttribute('data-state', 'error'));
      expect(status()).toHaveTextContent('Impossible de vérifier le code');
      expect(input()).not.toHaveAttribute('readonly');

      // Retryable: a fresh submit issues a new request and can still succeed.
      const retried = mockTrack(200);
      fireEvent.keyDown(input(), { key: 'Enter' });
      await waitFor(() => expect(row()).toHaveAttribute('data-state', 'found'));
      expect(retried).toEqual(['K7F3XQ']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the card and logo with a pulsing skeleton, not the code entry, while the locale chunk is loading', async () => {
    setReadyOverride(false);
    renderEntry();
    expect(await screen.findByAltText('Aito3D')).toBeInTheDocument();
    expect(document.querySelector('.motion-safe\\:animate-pulse')).toBeInTheDocument();
    expect(screen.queryByTestId('track-code')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('swaps the skeleton for the code entry once ready, leaving no skeleton behind', async () => {
    setReadyOverride(false);
    renderEntry();
    await screen.findByAltText('Aito3D');
    expect(screen.queryByTestId('track-code')).not.toBeInTheDocument();
    act(() => setReadyOverride(true));
    expect(await screen.findByRole('heading', { name: 'Suivre ma commande' })).toBeInTheDocument();
    expect(screen.getByTestId('track-code')).toBeInTheDocument();
    expect(document.querySelector('.motion-safe\\:animate-pulse')).not.toBeInTheDocument();
  });
});
