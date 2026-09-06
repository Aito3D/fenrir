import { describe, it, expect, afterEach } from 'vitest';
import { screen, within, render as rtlRender } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AitoTrackPage } from '../../pages/AitoTrackPage';
import type { AitoTracking } from '../../api/client';

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

  return rtlRender(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/track/${token}`]}>
        <Routes>
          <Route path="/track/:token" element={<AitoTrackPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const FIXTURE: AitoTracking = {
  column: 'print',
  tasks: [{ title: 'Support GoPro', quantity: null }, { title: 'Pièce 2', quantity: 2 }],
  due_date: '2026-09-20', shipping: null, done_at: null,
  invoice: null, reference: 'EST-000142', updated_at: '2026-09-03T21:05:00',
};

function mockTrack(body: AitoTracking | null) {
  server.use(
    http.get('/api/v1/aito/track/:token', () =>
      body ? HttpResponse.json(body) : HttpResponse.json({ detail: 'Lien introuvable' }, { status: 404 }),
    ),
  );
}

describe('AitoTrackPage', () => {
  const originalTitle = document.title;
  afterEach(() => { document.title = originalTitle; });

  it('renders the logo, reference, rail, hero state with the date and update line, and the parts', async () => {
    mockTrack(FIXTURE);
    renderAt('tok');
    expect(await screen.findByRole('heading', { level: 2, name: 'En fabrication' })).toBeInTheDocument();
    expect(screen.getByText('Nous préparons actuellement vos pièces.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Aito3D' })).toBeInTheDocument();
    expect(screen.getByText('Devis n° EST-000142')).toBeInTheDocument();
    const state = screen.getByTestId('track-state');
    expect(within(state).getByText('Disponibilité estimée')).toBeInTheDocument();
    expect(within(state).getByText('20 septembre 2026')).toBeInTheDocument();
    expect(within(state).getByText(/^Mis à jour le 3 septembre à \d{2}:\d{2}$/)).toBeInTheDocument();
    expect(screen.getByText('Support GoPro')).toBeInTheDocument();
    expect(screen.getByText('Pièce 2')).toBeInTheDocument();
    expect(screen.getByText('×2')).toBeInTheDocument();
    expect(screen.getByTestId('track-stage-print')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByTestId('track-stage-devis')).toHaveAttribute('data-state', 'done');
    expect(screen.getByTestId('track-stage-finish')).toHaveAttribute('data-state', 'todo');
    expect(screen.getByTestId('track-stage-done')).toHaveTextContent('Récupérée');
    expect(screen.getByText('Étape 5 sur 7')).toBeInTheDocument();
    expect(document.title).toBe('Suivi de commande · Aito 3D');
    // Contact lives in the footer only — once on the page, not under the logo.
    expect(screen.getAllByText(/contact@aito3d\.fr/)).toHaveLength(1);
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
    mockTrack({ ...FIXTURE, column: 'done', due_date: null, shipping: { island: 'Rangiroa', service: 'Livraison Avion Tuamotu' } });
    const { unmount } = renderAt('a');
    expect(await screen.findByRole('heading', { level: 2, name: 'Expédiée' })).toBeInTheDocument();
    expect(screen.getByTestId('track-stage-done')).toHaveTextContent('Expédiée');
    unmount();
    mockTrack({ ...FIXTURE, column: 'done', due_date: null, done_at: '2026-09-01T18:20:00' });
    renderAt('b');
    expect(await screen.findByRole('heading', { level: 2, name: 'Récupérée' })).toBeInTheDocument();
    expect(screen.getByText(/Le 1 septembre 2026/)).toBeInTheDocument();
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
      expect(box.textContent).not.toMatch(/\d/);
      const toggle = within(box).queryByRole('button', { name: 'Voir les modalités' });
      expect(!!toggle).toBe(hasTerms);
      if (toggle) {
        expect(screen.queryByText(/Règlement par virement/)).not.toBeInTheDocument();
        await userEvent.click(toggle);
        expect(screen.getByText(/Règlement par virement/)).toBeInTheDocument();
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
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

  it('exposes the timeline to assistive tech and lists the steps on demand', async () => {
    mockTrack(FIXTURE);
    renderAt('a11y');
    await screen.findByRole('heading', { level: 2, name: 'En fabrication' });
    expect(screen.getByText('Étape 5 sur 7 : Fabrication')).toBeInTheDocument(); // visually hidden
    await userEvent.click(screen.getByRole('button', { name: 'Voir les étapes' }));
    const list = screen.getByRole('list', { name: 'Détail des étapes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
  });
});
