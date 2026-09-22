import { useEffect, useState } from 'react';
import { describe, it, expect, afterEach, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import i18n from '../../i18n';
import { screen, within, waitFor, render as rtlRender } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AitoTrackPage } from '../../pages/AitoTrackPage';
import type { AitoTracking } from '../../api/client';

// `ready` (react-i18next's bundle-loaded flag) is only ever false for a real
// instant in this suite — copied from AitoTrackEntryPage.test.tsx's same
// override, which explains why: the fr chunk this file forces via
// `beforeAll` below is fully loaded before any test runs. Pin it to exercise
// the "locale chunk never settles" case (T-018) deterministically.
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

// Copied from StreamOverlayPage.test.tsx's renderOverlayPage: a standalone
// page needs no ThemeProvider/AuthProvider/ToastProvider — it's public and
// has no app chrome — just the router and a fresh QueryClient per render.
function renderAt(token: string) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  const utils = rtlRender(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/t/${token}`]}>
        <Routes>
          <Route path="/t/:token" element={<AitoTrackPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

const FIXTURE: AitoTracking = {
  column: 'print',
  tasks: [{ title: 'Support GoPro', quantity: null }, { title: 'Pièce 2', quantity: 2 }],
  // Deliberately absurd year: this fixture is the FUTURE-due-date case.
  // `etaCopy` flips a passed date to "estimation updating" — the case
  // 'shows the missing-date and passed-date wordings...' covers with its own
  // 2000-01-01 — so a plausible near date here is a time bomb. This one was
  // 2026-09-20 and broke CI at midnight on the 21st, on a commit that had
  // nothing to do with it. A date here must outlive the repo, not the sprint.
  due_date: '2099-09-20', shipping: null, done_at: null,
  invoice: null, payment: null, reference: 'EST-000142', updated_at: '2026-09-03T21:05:00',
};

function mockTrack(body: AitoTracking | null) {
  server.use(
    http.get('/api/v1/aito/track/:token', () =>
      body ? HttpResponse.json(body) : HttpResponse.json({ detail: 'Lien introuvable' }, { status: 404 }),
    ),
  );
}

// The page speaks the app's i18n; the assertions below are French, the
// shop's language, so pin it for the file (jsdom's navigator is en-US).
beforeAll(() => i18n.changeLanguage('fr'));
afterAll(() => i18n.changeLanguage('en'));
afterEach(() => setReadyOverride(null));

describe('AitoTrackPage', () => {
  const originalTitle = document.title;
  afterEach(async () => {
    document.title = originalTitle;
    await i18n.changeLanguage('fr');
  });

  it('renders the logo, reference, rail, hero state with the date and update line, and the parts', async () => {
    mockTrack(FIXTURE);
    renderAt('tok');
    expect(await screen.findByRole('heading', { level: 2, name: 'En fabrication' })).toBeInTheDocument();
    expect(screen.getByText('Nous préparons actuellement vos pièces.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Aito3D' })).toBeInTheDocument();
    expect(screen.getByText('Devis n° EST-000142')).toBeInTheDocument();
    const state = screen.getByTestId('track-state');
    expect(within(state).getByText('Disponibilité estimée')).toBeInTheDocument();
    expect(within(state).getByText('20 septembre 2099')).toBeInTheDocument();
    expect(within(state).getByText(/^Mis à jour le 3 septembre à \d{2}:\d{2}$/)).toBeInTheDocument();
    expect(screen.getByText('Support GoPro')).toBeInTheDocument();
    expect(screen.getByText('Pièce 2')).toBeInTheDocument();
    expect(screen.getByText('×2')).toBeInTheDocument();
    expect(screen.getByTestId('track-stage-print')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByTestId('track-stage-devis')).toHaveAttribute('data-state', 'done');
    expect(screen.getByTestId('track-stage-finish')).toHaveAttribute('data-state', 'todo');
    expect(screen.getByTestId('track-stage-done')).toHaveTextContent('Récupérée');
    expect(screen.getByText('Étape 5 sur 7')).toBeInTheDocument();
    expect(screen.getByTestId('track-stage-scan')).toHaveTextContent('Scan 3D');
    expect(document.title).toBe('Suivi de commande · Aito 3D');
    expect(document.documentElement.lang).toBe('fr');
    expect(document.title).toBe('Suivi de commande · Aito 3D');
    // Contact lives in the footer only — once on the card, not under the
    // logo. (The shop panel beside the card repeats it as a contact row.)
    const card = screen.getByTestId('track-footer').closest('.track-card')!;
    expect(within(card as HTMLElement).getAllByText(/contact@aito3d\.fr/)).toHaveLength(1);
    expect(screen.queryByTestId('track-invoice')).not.toBeInTheDocument();
  });

  it('omits the reference line and the date when absent', async () => {
    mockTrack({ ...FIXTURE, column: 'devis', reference: null, due_date: null });
    renderAt('noref');
    expect(await screen.findByRole('heading', { level: 2, name: 'Devis en préparation' })).toBeInTheDocument();
    expect(screen.queryByText(/Devis n°/)).not.toBeInTheDocument();
    expect(screen.queryByText('Disponibilité estimée')).not.toBeInTheDocument();
  });

  it('shows the shipped and picked-up variants, naming the last stage accordingly', async () => {
    mockTrack({ ...FIXTURE, column: 'done', due_date: null, shipping: { island: 'Rangiroa', service: 'Livraison Avion Tuamotu', lta: null } });
    const { unmount } = renderAt('a');
    expect(await screen.findByRole('heading', { level: 2, name: 'Expédiée' })).toBeInTheDocument();
    expect(screen.getByTestId('track-stage-done')).toHaveTextContent('Expédiée');
    expect(screen.getByText('Vers Rangiroa par Livraison Avion Tuamotu.')).toBeInTheDocument();
    expect(screen.queryByText(/N° LTA/)).not.toBeInTheDocument();
    unmount();
    mockTrack({ ...FIXTURE, column: 'done', due_date: null, done_at: '2026-09-01T18:20:00' });
    renderAt('b');
    expect(await screen.findByRole('heading', { level: 2, name: 'Récupérée' })).toBeInTheDocument();
    expect(screen.getByText(/Le 1 septembre 2026/)).toBeInTheDocument();
  });

  // The waybill number is the one thing the client needs at the Air Tahiti
  // freight counter, so once it exists it is quoted verbatim in the shipped
  // line — and while the parcel is still being made it is shown nowhere.
  it('quotes the LTA number in the shipped line once it exists', async () => {
    mockTrack({
      ...FIXTURE,
      column: 'done',
      due_date: null,
      shipping: { island: 'Rangiroa', service: 'Livraison Avion Tuamotu', lta: '123-4567 8901' },
    });
    renderAt('a');
    expect(await screen.findByRole('heading', { level: 2, name: 'Expédiée' })).toBeInTheDocument();
    expect(screen.getByText('Vers Rangiroa par Livraison Avion Tuamotu. N° LTA 123-4567 8901.')).toBeInTheDocument();
  });

  it('shows the payment card without any amount, with terms behind its button', async () => {
    for (const [invoice, text, hasTerms] of [
      ['paid', 'Facture réglée', false],
      ['unpaid', 'Facture à régler', true],
      ['overdue', 'Facture en retard', true],
    ] as const) {
      mockTrack({ ...FIXTURE, invoice });
      const { unmount } = renderAt(`inv-${invoice}`);
      const box = await screen.findByTestId('track-invoice');
      expect(box).toHaveAttribute('data-state', invoice);
      expect(box).toHaveTextContent(text);
      // Never an amount: the card itself carries no digit (the payment
      // panel with the IBAN and RIB lives outside the card).
      expect(box.textContent).not.toMatch(/\d/);
      const toggle = within(box).queryByRole('button', { name: 'Voir les modalités' });
      expect(!!toggle).toBe(hasTerms);
      // The panel is mounted next to the card whenever there is something
      // to pay; closed means out of the accessibility tree and the tab
      // order, not absent.
      const panel = screen.queryByTestId('track-panel-pay');
      expect(!!panel).toBe(hasTerms);
      if (toggle && panel) {
        const terms = within(panel).getByTestId('track-payment-methods');
        expect(within(terms).getByText('FR76 1746 9000 3120 6624 2000 041')).toBeInTheDocument();
        // The quote number is the transfer reference, a row of its own.
        expect(within(terms).getByText('Motif du virement')).toBeInTheDocument();
        expect(within(terms).getByText('EST-000142')).toBeInTheDocument();
        expect(panel).toHaveAttribute('aria-hidden', 'true');
        expect(panel).toHaveAttribute('inert');
        expect(terms).not.toHaveClass('animate-rise');
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(toggle).toHaveAttribute('aria-controls', panel.id);
        await userEvent.click(toggle);
        expect(panel).toHaveAttribute('aria-hidden', 'false');
        expect(panel).not.toHaveAttribute('inert');
        expect(terms).toHaveClass('animate-rise');
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await userEvent.click(toggle);
        expect(panel).toHaveAttribute('aria-hidden', 'true');
        expect(terms).not.toHaveClass('animate-rise');
      }
      unmount();
    }
  });

  it('renders the invalid-link line on a 404, never a login screen', async () => {
    mockTrack(null);
    renderAt('gone');
    expect(await screen.findByRole('heading', { level: 1, name: "Ce lien de suivi n'est plus valide" })).toBeInTheDocument();
    expect(screen.queryByText(/Vos pièces/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/password|mot de passe/i)).not.toBeInTheDocument();
  });

  it('shows the missing-date and passed-date wordings instead of a stale or fake date', async () => {
    mockTrack({ ...FIXTURE, column: 'scan', due_date: null });
    const { unmount } = renderAt('soon');
    expect(await screen.findByText('Nous vous communiquerons une date dès que possible.')).toBeInTheDocument();
    unmount();
    mockTrack({ ...FIXTURE, column: 'print', due_date: '2000-01-01' });
    renderAt('late');
    expect(await screen.findByText('Estimation en cours de mise à jour')).toBeInTheDocument();
    expect(screen.queryByText(/2000/)).not.toBeInTheDocument();
  });

  it('collapses a long parts list behind a button', async () => {
    const tasks = Array.from({ length: 11 }, (_, i) => ({ title: `Pièce ${i + 1}`, quantity: null }));
    mockTrack({ ...FIXTURE, tasks });
    renderAt('many');
    await screen.findByText('Pièce 1');
    expect(screen.queryByText('Pièce 7')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Voir les 11 pièces' }));
    expect(screen.getByText('Pièce 11')).toBeInTheDocument();
  });

  it('does not fold a parts list at or under the fold threshold', async () => {
    const tasks = Array.from({ length: 7 }, (_, i) => ({ title: `Pièce ${i + 1}`, quantity: null }));
    mockTrack({ ...FIXTURE, tasks });
    renderAt('seven');
    await screen.findByText('Pièce 1');
    expect(screen.getByText('Pièce 7')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Voir les .* pièces/ })).not.toBeInTheDocument();
  });

  it('offers a retry on a server error and a dedicated page on 404', async () => {
    let calls = 0;
    server.use(http.get('/api/v1/aito/track/:token', () => (++calls === 1 ? HttpResponse.error() : HttpResponse.json(FIXTURE))));
    renderAt('flaky');
    expect(await screen.findByText('Impossible de charger le suivi pour le moment.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'En fabrication' })).toBeInTheDocument();

    mockTrack(null);
    const { unmount } = renderAt('gone');
    expect(await screen.findByRole('heading', { level: 1, name: "Ce lien de suivi n'est plus valide" })).toBeInTheDocument();
    expect(screen.getByText(/nous vous enverrons un nouveau lien/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Réessayer' })).not.toBeInTheDocument();
    unmount();
  });

  it('tells a throttled client to wait rather than to try again at once', async () => {
    mockTrack(null);
    server.use(http.get('/api/v1/aito/track/:token', () => HttpResponse.json({ detail: 'Trop de tentatives' }, { status: 429 })));
    renderAt('throttled');
    expect(await screen.findByText('Trop de tentatives. Patientez une minute.')).toBeInTheDocument();
    expect(screen.queryByText('Impossible de charger le suivi pour le moment.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument();
  });

  it('shows the retry being heard, and re-delivers the message when it fails again', async () => {
    let calls = 0;
    server.use(
      http.get('/api/v1/aito/track/:token', async () => {
        calls += 1;
        await delay(300); // long enough for the in-flight state to be observed
        return HttpResponse.error();
      }),
    );
    renderAt('down');
    const first = await screen.findByTestId('track-error');
    expect(first).toHaveClass('animate-track-fade');
    const retry = screen.getByRole('button', { name: 'Réessayer' });
    expect(retry).toBeEnabled();
    await userEvent.click(retry);
    // While the retry is in flight the message stays put (no skeleton
    // flash) and the button is out of action and says so.
    const busy = await screen.findByRole('button', { name: 'Nouvel essai…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveClass('disabled:opacity-60');
    expect(screen.getByTestId('track-error')).toBe(first);
    expect(document.querySelector('.motion-safe\\:animate-pulse')).toBeNull();
    // The second failure remounts the message (keyed on the failure), so the
    // same words fade in again rather than sitting frozen.
    const again = await screen.findByRole('button', { name: 'Réessayer' });
    expect(again).toBeEnabled();
    expect(calls).toBe(2);
    expect(screen.getByTestId('track-error')).not.toBe(first);
    expect(screen.getByTestId('track-error')).toHaveClass('animate-track-fade');
  });

  // T-086: a client on a flaky connection whose request is accepted but
  // never answered used to leave the skeleton pulsing forever — no error
  // text, no Réessayer, nothing but a reload. The query now aborts after
  // the same 10 s deadline AitoTrackEntryPage's identical check already
  // uses, landing on the existing retryable error branch.
  it('aborts a hung request after the deadline and lands on the retryable error state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let calls = 0;
      server.use(
        http.get('/api/v1/aito/track/:token', async () => {
          calls += 1;
          await delay('infinite');
          return HttpResponse.json(FIXTURE);
        }),
      );
      renderAt('hung');
      // Comfortably inside the deadline: still the skeleton, no error yet.
      await vi.advanceTimersByTimeAsync(9_000);
      expect(screen.queryByTestId('track-error')).not.toBeInTheDocument();
      expect(document.querySelector('.motion-safe\\:animate-pulse')).not.toBeNull();
      // Cross the deadline: the abort fires and the catch takes over.
      await vi.advanceTimersByTimeAsync(1_001);
      await waitFor(() => expect(screen.getByTestId('track-error')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument();
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // T-018: the i18n `ready` flag guarding `settled` has the same failure
  // mode as the hung request above — a stalled locale chunk that never
  // errors — but no deadline used to exist for it, so it hid data that had
  // already landed in the query cache behind a skeleton forever. It now
  // gets the same 10 s deadline as the request itself.
  it('settles past the i18n deadline even if the locale chunk never becomes ready, revealing data already in hand', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setReadyOverride(false);
      mockTrack(FIXTURE);
      renderAt('stalled-i18n');
      // The tracking data lands almost immediately, but `ready` never does:
      // still the skeleton, not the content, well inside the deadline.
      await vi.advanceTimersByTimeAsync(9_000);
      expect(screen.queryByTestId('track-content')).not.toBeInTheDocument();
      // CardSkeleton's two blocks are the only elements sharing this exact
      // class (the rail's own pulsing dot, present once content renders,
      // does not), so it stays a reliable "skeleton is up" probe even after
      // the content (which also pulses) has appeared.
      expect(document.querySelector('.bg-aito-line\\/60')).not.toBeNull();
      // Cross the deadline: `settled` flips true on its own even though
      // `ready` is still pinned false, and the already-landed data appears
      // — no error, no Réessayer, because the request itself succeeded.
      await vi.advanceTimersByTimeAsync(1_001);
      await waitFor(() => expect(screen.getByTestId('track-content')).toBeInTheDocument());
      expect(screen.getByRole('heading', { level: 2, name: 'En fabrication' })).toBeInTheDocument();
      expect(screen.queryByTestId('track-error')).not.toBeInTheDocument();
      expect(document.querySelector('.bg-aito-line\\/60')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the deadline timer on a normal success, so no stray abort follows it', async () => {
    // Timer-count assertions are unreliable here (React's own scheduler can
    // leave unrelated timers pending), so pin the exact 10 s deadline timer
    // instead: it must be armed on the request and cleared once it settles.
    const setSpy = vi.spyOn(window, 'setTimeout');
    const clearSpy = vi.spyOn(window, 'clearTimeout');
    mockTrack(FIXTURE);
    renderAt('fast');
    await screen.findByRole('heading', { level: 2, name: 'En fabrication' });
    const call = setSpy.mock.calls.find(([, ms]) => ms === 10_000);
    expect(call).toBeDefined();
    const timerId = setSpy.mock.results[setSpy.mock.calls.indexOf(call!)].value;
    expect(clearSpy.mock.calls.some(([id]) => id === timerId)).toBe(true);
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  // T-110: the deadline timer is only one of the two cancellation sources
  // the queryFn composes (see the comment above it in AitoTrackPage.tsx) —
  // TanStack's own signal, which fires when the last observer unmounts, is
  // the other. Prove it actually reaches the network request, not just the
  // page's own controller.
  it('aborts the in-flight request when the page unmounts, via TanStack\'s own signal', async () => {
    let requestSignal: AbortSignal | undefined;
    server.use(
      http.get('/api/v1/aito/track/:token', async ({ request }) => {
        requestSignal = request.signal;
        await delay('infinite');
        return HttpResponse.json(FIXTURE);
      }),
    );
    const { unmount } = renderAt('unmount-me');
    await waitFor(() => expect(requestSignal).toBeDefined());
    expect(requestSignal!.aborted).toBe(false);
    unmount();
    await waitFor(() => expect(requestSignal!.aborted).toBe(true));
  });

  // T-110: the other cancellation source — a refetch superseding a request
  // still in flight — must also abort the superseded request's signal, not
  // just leave it to resolve into a discarded update.
  it('aborts the superseded request\'s signal when a later refetch replaces it', async () => {
    let calls = 0;
    let secondRequestSignal: AbortSignal | undefined;
    server.use(
      http.get('/api/v1/aito/track/:token', async ({ request }) => {
        calls += 1;
        if (calls === 2) {
          secondRequestSignal = request.signal;
          await delay('infinite');
        }
        return HttpResponse.json(FIXTURE);
      }),
    );
    const { queryClient } = renderAt('supersede');
    // The first fetch (on mount) resolves normally, giving the query data —
    // `cancelRefetch` (the default) only cancels an in-flight fetch once
    // there is already data to fall back on (see query-core's `fetch`).
    await screen.findByRole('heading', { level: 2, name: 'En fabrication' });
    // The second fetch hangs; capture its request signal before superseding it.
    const second = queryClient.refetchQueries({ queryKey: ['aito-track', 'supersede'] });
    await waitFor(() => expect(secondRequestSignal).toBeDefined());
    expect(secondRequestSignal!.aborted).toBe(false);
    // A third refetch, triggered while the second is still hung, supersedes
    // it — the second request's signal must abort.
    const third = queryClient.refetchQueries({ queryKey: ['aito-track', 'supersede'] });
    await waitFor(() => expect(secondRequestSignal!.aborted).toBe(true));
    await Promise.all([second, third]);
  });

  it('exposes the timeline to assistive tech and lists the steps on demand', async () => {
    mockTrack(FIXTURE);
    renderAt('a11y');
    await screen.findByRole('heading', { level: 2, name: 'En fabrication' });
    expect(screen.getByText('Étape 5 sur 7 : Fabrication')).toBeInTheDocument(); // visually hidden
    // Closed: the list is mounted (for the collapse) but hidden from AT.
    expect(screen.queryByRole('list', { name: 'Détail des étapes' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Voir les étapes' }));
    const list = screen.getByRole('list', { name: 'Détail des étapes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
    expect(within(list).getAllByRole('listitem')[0]).toHaveClass('animate-rise');
    // The label follows the state: it now offers to close.
    const hide = screen.getByRole('button', { name: 'Masquer les étapes' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(hide);
    expect(screen.queryByRole('list', { name: 'Détail des étapes' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Voir les étapes' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('AitoTrackPage first-load choreography', () => {
  it('plays the entrance on the first data only, timed from the current node', async () => {
    mockTrack(FIXTURE); // column print → rail index 4
    renderAt('motion');
    await screen.findByRole('heading', { level: 2, name: 'En fabrication' });
    expect(screen.getByTestId('track-content')).toHaveClass('animate-track-fade');
    const state = screen.getByTestId('track-state');
    expect(state).toHaveClass('animate-rise');
    expect(state.style.animationDelay).toBe(`${80 + 4 * 90 + 260}ms`);
    expect(state).not.toHaveClass('animate-track-halo');
    // Done marks pop, the current node lands, todo nodes stay still.
    expect(screen.getByTestId('track-stage-devis').querySelector('.animate-track-pop')).not.toBeNull();
    expect(screen.getByTestId('track-stage-print').querySelector('.animate-track-land')).not.toBeNull();
    expect(screen.getByTestId('track-stage-finish').querySelector('[class*="animate-track"]')).toBeNull();
    // The parts cascade after the state card.
    const first = screen.getByText('Support GoPro').closest('li')!;
    expect(first).toHaveClass('animate-rise');
    expect(first.style.animationDelay).toBe(`${80 + 4 * 90 + 260 + 100}ms`);
  });

  it('draws the last check and fires the halo once the order is over', async () => {
    mockTrack({ ...FIXTURE, column: 'done', done_at: '2026-09-01T08:00:00' });
    renderAt('over');
    await screen.findByRole('heading', { level: 2, name: 'Récupérée' });
    expect(screen.getByTestId('track-check')).toHaveClass('animate-track-check');
    const state = screen.getByTestId('track-state');
    expect(state).toHaveClass('animate-track-halo');
    expect(state.style.getPropertyValue('--track-halo-delay')).toBe(`${80 + 6 * 90 + 260 + 280}ms`);
  });

  it('walks only the new ground when a refetch brings a later stage', async () => {
    let column: AitoTracking['column'] = 'print';
    server.use(http.get('/api/v1/aito/track/:token', () => HttpResponse.json({ ...FIXTURE, column })));
    const { queryClient } = renderAt('adv');
    await screen.findByRole('heading', { level: 2, name: 'En fabrication' });
    // The order advances while the tab is open: print (4) → finish (5).
    column = 'finish';
    await queryClient.refetchQueries({ queryKey: ['aito-track', 'adv'] });
    await screen.findByRole('heading', { level: 2, name: 'Votre commande est prête' });
    // Not the first entrance any more…
    expect(screen.getByTestId('track-content')).not.toHaveAttribute('data-entrance');
    // …but the rail replays from the old current node: it pops as done, the
    // new current lands one beat later, everything before stays still.
    expect(screen.getByTestId('track-stage-print').querySelector('.animate-track-pop')).not.toBeNull();
    expect(screen.getByTestId('track-stage-finish').querySelector('.animate-track-land')).not.toBeNull();
    expect(screen.getByTestId('track-stage-model').querySelector('[class*="animate-track"]')).toBeNull();
    expect(screen.getByTestId('track-stage-devis').querySelector('[class*="animate-track"]')).toBeNull();
    // The state card rises on the advance clock: origin 4, current 5.
    const state = screen.getByTestId('track-state');
    expect(state).toHaveClass('animate-rise');
    expect(state.style.animationDelay).toBe(`${80 + 1 * 90 + 260}ms`);
    // The parts did not change and do not move again.
    expect(screen.getByText('Support GoPro').closest('li')).not.toHaveClass('animate-rise');
    // A step re-opened: the column goes back, nothing is celebrated.
    column = 'model';
    await queryClient.refetchQueries({ queryKey: ['aito-track', 'adv'] });
    await screen.findByRole('heading', { level: 2, name: 'En fabrication' });
    expect(screen.getByTestId('track-state')).not.toHaveClass('animate-rise');
    expect(screen.getByTestId('track-stage-model').querySelector('[class*="animate-track"]')).toBeNull();
  });

  it('fires the halo when the advance lands on done', async () => {
    let column: AitoTracking['column'] = 'finish';
    server.use(http.get('/api/v1/aito/track/:token', () => HttpResponse.json({ ...FIXTURE, column, due_date: null })));
    const { queryClient } = renderAt('over-adv');
    await screen.findByRole('heading', { level: 2, name: 'Votre commande est prête' });
    column = 'done';
    await queryClient.refetchQueries({ queryKey: ['aito-track', 'over-adv'] });
    await screen.findByRole('heading', { level: 2, name: 'Terminée' });
    const state = screen.getByTestId('track-state');
    expect(state).toHaveClass('animate-track-halo');
    expect(state.style.getPropertyValue('--track-halo-delay')).toBe(`${80 + 1 * 90 + 260 + 280}ms`);
    expect(screen.getByTestId('track-check')).toHaveClass('animate-track-check');
  });

  it('fades and rises the invalid-link page in like every other state', async () => {
    mockTrack(null);
    renderAt('gone-motion');
    const title = await screen.findByRole('heading', { level: 1, name: "Ce lien de suivi n'est plus valide" });
    expect(screen.getByTestId('track-invalid')).toHaveClass('animate-track-fade');
    expect(title).toHaveClass('animate-rise');
    expect(title.style.animationDelay).toBe('0ms');
    expect(screen.getByText(/nous vous enverrons un nouveau lien/).style.animationDelay).toBe('60ms');
    const link = screen.getByRole('link', { name: 'Saisir un code de suivi' });
    expect(link).toHaveClass('animate-rise');
    expect(link.style.animationDelay).toBe('120ms');
  });

  it('rises only the newly revealed parts when the fold opens', async () => {
    const tasks = Array.from({ length: 11 }, (_, i) => ({ title: `Pièce ${i + 1}`, quantity: null }));
    mockTrack({ ...FIXTURE, tasks });
    renderAt('reveal');
    await screen.findByText('Pièce 1');
    await userEvent.click(screen.getByRole('button', { name: 'Voir les 11 pièces' }));
    const seventh = screen.getByText('Pièce 7').closest('li')!;
    expect(seventh).toHaveClass('animate-rise');
    expect(seventh.style.animationDelay).toBe('0ms');
    expect(screen.getByText('Pièce 9').closest('li')!.style.animationDelay).toBe('80ms');
  });
});

describe('AitoTrackPage language', () => {
  it('offers every app language in the pill and re-renders in place on a switch', async () => {
    mockTrack(FIXTURE);
    renderAt('lang');
    await screen.findByRole('heading', { level: 2, name: 'En fabrication' });
    const select = screen.getByTestId('track-language') as HTMLSelectElement;
    expect(select.value).toBe('fr');
    expect(select.options.length).toBe(14);
    expect(screen.getByRole('option', { name: 'Deutsch' })).toBeInTheDocument();
    await userEvent.selectOptions(select, 'en');
    expect(await screen.findByRole('heading', { level: 2, name: 'In production' })).toBeInTheDocument();
    expect(screen.getByText('Quote no. EST-000142')).toBeInTheDocument();
    expect(screen.getByTestId('track-stage-done')).toHaveTextContent('Collected');
    expect(screen.getByText('September 20, 2099')).toBeInTheDocument();
    expect(document.title).toBe('Order tracking · Aito 3D');
    // Same nodes, no replay: the entrance classes are still the first ones.
    expect(screen.getByTestId('track-content')).toHaveAttribute('data-entrance', 'true');
  });

  it('falls back to French when the browser asks for nothing the app ships', async () => {
    await i18n.changeLanguage('en');
    // changeLanguage above is cached by the detector as a remembered choice
    // (under Node 22's jsdom the write reaches the localStorage mock; under
    // Node 25 it does not, which is why this only ever failed on CI). A
    // first visit has no remembered choice, and that is the case under test.
    window.localStorage.removeItem('bambutrack_language');
    const languages = Object.getOwnPropertyDescriptor(Navigator.prototype, 'languages');
    Object.defineProperty(navigator, 'languages', { configurable: true, value: ['ty', 'pt-PT'] });
    try {
      mockTrack(FIXTURE);
      renderAt('tahiti');
      expect(await screen.findByRole('heading', { level: 2, name: 'En fabrication' })).toBeInTheDocument();
    } finally {
      if (languages) Object.defineProperty(Navigator.prototype, 'languages', languages);
      delete (navigator as unknown as Record<string, unknown>).languages;
    }
  });

  it('translates the expired-link page too', async () => {
    mockTrack(null);
    renderAt('gone');
    expect(await screen.findByText("Ce lien de suivi n'est plus valide")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByTestId('track-language'), 'es');
    expect(await screen.findByText('Este enlace de seguimiento ya no es válido')).toBeInTheDocument();
  });
});

describe('AitoTrackPage — online payment', () => {
  // The preceding language describe leaves i18n on whatever language its
  // last test selected — pin it back to French here too.
  beforeEach(() => i18n.changeLanguage('fr'));

  it('unpaid: a "Projet non réglé" card with a Pay online link in a new tab', async () => {
    mockTrack({ ...FIXTURE, column: 'devis', payment: { state: 'unpaid', url: 'https://secure.osb.pf/pay/abc', deposit: false } });
    renderAt('tok');
    const card = await screen.findByTestId('track-payment');
    expect(card).toHaveAttribute('data-state', 'unpaid');
    expect(within(card).getByText('Projet non réglé')).toBeInTheDocument();
    const pay = within(card).getByRole('link', { name: 'Payer en ligne' });
    expect(pay).toHaveAttribute('href', 'https://secure.osb.pf/pay/abc');
    expect(pay).toHaveAttribute('target', '_blank');
    expect(pay).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('unpaid: the terms toggle reveals the same payment-methods panel, with the quote number', async () => {
    mockTrack({ ...FIXTURE, column: 'devis', payment: { state: 'unpaid', url: 'https://secure.osb.pf/pay/abc', deposit: false } });
    renderAt('tok');
    const card = await screen.findByTestId('track-payment');
    const side = screen.getByTestId('track-panel-pay');
    const panel = within(side).getByTestId('track-payment-methods');
    expect(side).toHaveAttribute('aria-hidden', 'true');
    await userEvent.click(within(card).getByRole('button', { name: 'Voir les modalités' }));
    expect(side).toHaveAttribute('aria-hidden', 'false');
    expect(panel).toHaveClass('animate-rise');
    expect(within(panel).getByText('Motif du virement')).toBeInTheDocument();
    expect(within(panel).getByText('EST-000142')).toBeInTheDocument();
    // One method at a time: each app's tag sits behind its own tab.
    await userEvent.click(within(panel).getByRole('tab', { name: 'Deblock' }));
    expect(within(panel).getByText('@paul3482')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('tab', { name: 'Revolut' }));
    expect(within(panel).getByText('@paulteloe')).toBeInTheDocument();
  });

  it('paid: the quiet paid line, worded for a deposit when it was one', async () => {
    mockTrack({ ...FIXTURE, payment: { state: 'paid', url: 'https://secure.osb.pf/pay/abc', deposit: true } });
    renderAt('tok');
    const card = await screen.findByTestId('track-payment');
    expect(card).toHaveAttribute('data-state', 'paid');
    expect(within(card).getByText('Acompte reçu')).toBeInTheDocument();
    expect(within(card).queryByText('Paiement reçu')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Payer en ligne' })).not.toBeInTheDocument();
  });

  it('paid: the plain paid-in-full wording when it was not a deposit', async () => {
    mockTrack({ ...FIXTURE, payment: { state: 'paid', url: 'https://secure.osb.pf/pay/abc', deposit: false } });
    renderAt('tok');
    const card = await screen.findByTestId('track-payment');
    expect(card).toHaveAttribute('data-state', 'paid');
    expect(within(card).getByText('Paiement reçu')).toBeInTheDocument();
    expect(within(card).queryByText('Acompte reçu')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Payer en ligne' })).not.toBeInTheDocument();
  });

  it('unpaid: the deposit sub-line when it was a deposit invoice', async () => {
    mockTrack({ ...FIXTURE, column: 'devis', payment: { state: 'unpaid', url: 'https://secure.osb.pf/pay/abc', deposit: true } });
    renderAt('tok');
    const card = await screen.findByTestId('track-payment');
    expect(card).toHaveAttribute('data-state', 'unpaid');
    expect(
      within(card).getByText('Un acompte confirme votre commande — réglez en ligne, par virement ou en boutique.'),
    ).toBeInTheDocument();
    expect(within(card).queryByText('Réglez en ligne, par virement ou en boutique.')).not.toBeInTheDocument();
  });

  it('an invoice outranks the payment link', async () => {
    mockTrack({ ...FIXTURE, invoice: 'unpaid', payment: { state: 'unpaid', url: 'https://secure.osb.pf/pay/abc', deposit: false } });
    renderAt('tok');
    expect(await screen.findByTestId('track-invoice')).toBeInTheDocument();
    expect(screen.queryByTestId('track-payment')).not.toBeInTheDocument();
  });

  it('unpaid with no link yet renders nothing', async () => {
    mockTrack({ ...FIXTURE, column: 'devis', payment: { state: 'unpaid', url: null, deposit: false } });
    renderAt('tok');
    await screen.findByRole('heading', { level: 2, name: 'Devis en préparation' });
    expect(screen.queryByTestId('track-payment')).not.toBeInTheDocument();
  });
});

describe('AitoTrackPage — side panels', () => {
  beforeEach(() => i18n.changeLanguage('fr'));

  const UNPAID: AitoTracking = { ...FIXTURE, column: 'finish', invoice: 'unpaid' };
  const stage = () => screen.getByTestId('track-stage');
  const payPanel = () => screen.getByTestId('track-panel-pay');
  const shopPanel = () => screen.getByTestId('track-panel-shop');
  const termsButton = () => screen.getByRole('button', { name: 'Voir les modalités' });
  const shopButton = () => screen.getByRole('button', { name: 'Où nous trouver' });

  it('the terms button opens the payment panel, moves focus to its title, and the stage records which side is open', async () => {
    mockTrack(UNPAID);
    renderAt('tok');
    await screen.findByTestId('track-invoice');
    expect(stage()).not.toHaveAttribute('data-open');
    await userEvent.click(termsButton());
    expect(stage()).toHaveAttribute('data-open', 'pay');
    expect(payPanel()).toHaveAttribute('data-state', 'open');
    expect(payPanel()).toHaveAttribute('data-side', 'right');
    expect(within(payPanel()).getByRole('heading', { level: 2, name: 'Modalités de paiement' })).toHaveFocus();
    expect(within(payPanel()).getByText('Devis n° EST-000142')).toBeInTheDocument();
  });

  it('closes from its close button, and from Escape, handing focus back to the button that opened it', async () => {
    mockTrack(UNPAID);
    renderAt('tok');
    await screen.findByTestId('track-invoice');
    await userEvent.click(termsButton());
    await userEvent.click(within(payPanel()).getByRole('button', { name: 'Fermer' }));
    expect(stage()).not.toHaveAttribute('data-open');
    expect(payPanel()).toHaveAttribute('aria-hidden', 'true');
    expect(termsButton()).toHaveFocus();

    await userEvent.click(termsButton());
    expect(stage()).toHaveAttribute('data-open', 'pay');
    await userEvent.keyboard('{Escape}');
    expect(stage()).not.toHaveAttribute('data-open');
    expect(termsButton()).toHaveFocus();
  });

  it('the footer button opens the shop panel on the left: map, address, contact rows and directions', async () => {
    mockTrack(UNPAID);
    renderAt('tok');
    await screen.findByTestId('track-invoice');
    // The map is a third-party frame: not fetched until someone asks for it.
    const map = within(shopPanel()).getByTitle("Plan d'accès au magasin");
    expect(map).not.toHaveAttribute('src');
    // The map is a keyless embed, but the page URL carries the tracking code:
    // never send it to google.com as a Referer.
    expect(map).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(shopButton()).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(shopButton());
    expect(stage()).toHaveAttribute('data-open', 'shop');
    expect(shopPanel()).toHaveAttribute('data-side', 'left');
    expect(shopPanel()).toHaveAttribute('aria-hidden', 'false');
    expect(shopButton()).toHaveAttribute('aria-expanded', 'true');
    expect(within(shopPanel()).getByRole('heading', { level: 2, name: 'Nous trouver' })).toHaveFocus();
    expect(map).toHaveAttribute('src', expect.stringMatching(/^https:\/\/www\.google\.com\/maps\?q=.*output=embed/));
    expect(map.getAttribute('src')).toContain('hl=fr');
    expect(within(shopPanel()).getByText("20 Route de l'eau Royale")).toBeInTheDocument();
    expect(within(shopPanel()).getByText('Arue – Tahiti, Polynésie française')).toBeInTheDocument();
    expect(within(shopPanel()).getByRole('link', { name: /Téléphone/ })).toHaveAttribute('href', 'tel:+68989253210');
    expect(within(shopPanel()).getByRole('link', { name: /E-mail/ })).toHaveAttribute('href', 'mailto:contact@aito3d.fr');
    expect(within(shopPanel()).getByRole('link', { name: /Site/ })).toHaveAttribute('href', 'https://aito3d.fr');
    expect(within(shopPanel()).getByRole('link', { name: /Réseaux/ })).toHaveTextContent('@aito3d');
    const directions = within(shopPanel()).getByRole('link', { name: 'Itinéraire' });
    expect(directions).toHaveAttribute('href', expect.stringMatching(/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/));
    expect(directions).toHaveAttribute('target', '_blank');
    expect(within(shopPanel()).getByRole('link', { name: 'Appeler' })).toHaveAttribute('href', 'tel:+68989253210');
  });

  it('only one panel at a time: opening the other swaps sides in one move', async () => {
    mockTrack(UNPAID);
    renderAt('tok');
    await screen.findByTestId('track-invoice');
    await userEvent.click(termsButton());
    await userEvent.click(shopButton());
    expect(stage()).toHaveAttribute('data-open', 'shop');
    expect(payPanel()).toHaveAttribute('aria-hidden', 'true');
    expect(termsButton()).toHaveAttribute('aria-expanded', 'false');
    expect(shopPanel()).toHaveAttribute('aria-hidden', 'false');
    // The shop tab of the payment panel hands off to the shop panel too.
    await userEvent.click(termsButton());
    expect(stage()).toHaveAttribute('data-open', 'pay');
    expect(shopPanel()).toHaveAttribute('aria-hidden', 'true');
    await userEvent.click(within(payPanel()).getByRole('tab', { name: 'Magasin' }));
    await userEvent.click(within(payPanel()).getByRole('button', { name: 'Voir où nous trouver' }));
    expect(stage()).toHaveAttribute('data-open', 'shop');
    expect(payPanel()).toHaveAttribute('aria-hidden', 'true');
    expect(within(shopPanel()).getByRole('heading', { level: 2, name: 'Nous trouver' })).toHaveFocus();
    // Closing from there returns to the footer button, the shop panel's own trigger.
    await userEvent.keyboard('{Escape}');
    expect(shopButton()).toHaveFocus();
  });

  it('the scrim (phones: the sheet backdrop) closes whichever panel is open', async () => {
    mockTrack(UNPAID);
    renderAt('tok');
    await screen.findByTestId('track-invoice');
    await userEvent.click(shopButton());
    await userEvent.click(screen.getByTestId('track-scrim'));
    expect(stage()).not.toHaveAttribute('data-open');
    expect(shopPanel()).toHaveAttribute('aria-hidden', 'true');
  });

  it('a paid order still offers the shop panel, but no payment panel', async () => {
    mockTrack({ ...FIXTURE, invoice: 'paid' });
    renderAt('tok');
    await screen.findByTestId('track-invoice');
    expect(screen.queryByTestId('track-panel-pay')).not.toBeInTheDocument();
    expect(shopPanel()).toBeInTheDocument();
    expect(shopButton()).toBeInTheDocument();
  });
});
