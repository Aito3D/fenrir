import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { screen, within, waitFor, render as rtlRender } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '../../i18n';
import { server } from '../mocks/server';
import { OrderTrackPage } from '../../pages/OrderTrackPage';
import { resetI18nDeadlineForTests } from '../../hooks/useTrackingLanguage';
import type { OrderTracking } from '../../api/client';

type Line = OrderTracking['lines'][number];
const line = (name: string, status: Line['status'], quantity = 1, handed_on: string | null = null): Line => ({ name, quantity, status, handed_on });

const BASE: OrderTracking = {
  reference: '#1079',
  date: '2026-10-01',
  state: 'partly_ready',
  stage: 'ready',
  lines: [line('PETG Blanc', 'ready'), line('PETG Rouge', 'ready'), line('PETG Vert', 'waiting')],
  counts: { open: 3, ready: 2, waiting: 1 },
  pickup: true,
  payment: { currency: 'XPF', total: 5345, paid: 2295, left: 3050 },
  pay_url: 'https://pay.example/p/abc',
  updated_at: '2026-11-12T08:00:00',
};

function mockTrack(body: Partial<OrderTracking> | number) {
  server.use(
    http.get('/api/v1/order-board/track/:token', () =>
      typeof body === 'number' ? HttpResponse.json({ detail: 'x' }, { status: body }) : HttpResponse.json({ ...BASE, ...body }),
    ),
  );
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return rtlRender(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/t/o/K7F3XQ']}>
        <Routes>
          <Route path="/t/o/:token" element={<OrderTrackPage />} />
          <Route path="/t" element={<p>code entry</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const flat = (el: HTMLElement) => (el.textContent ?? '').replace(/\s/g, ' ');
const h2 = (name: string) => screen.findByRole('heading', { level: 2, name });

// French is the shop's language and the mockup's (jsdom's navigator is en-US).
beforeAll(() => i18n.changeLanguage('fr'));
afterAll(() => i18n.changeLanguage('en'));
afterEach(() => resetI18nDeadlineForTests());

describe('OrderTrackPage', () => {
  it('partly ready: header, rail on the third step, counts sentence, pickup address and sorted lines', async () => {
    mockTrack({});
    renderPage();
    expect(await h2('Une partie de ta commande est prête')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Suivi de ta commande' })).toBeInTheDocument();
    expect(screen.getByTestId('track-reference')).toHaveTextContent('Commande #1079 · passée le 1 octobre 2026');
    expect(screen.getByText('Tu peux déjà venir chercher 2 articles sur 3. Le reste arrive prochainement.')).toBeInTheDocument();
    expect(screen.getByTestId('track-stage-received')).toHaveAttribute('data-state', 'done');
    expect(screen.getByTestId('track-stage-preparing')).toHaveTextContent('En préparation');
    expect(screen.getByTestId('track-stage-ready')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByTestId('track-stage-handed_over')).toHaveAttribute('data-state', 'todo');
    expect(screen.queryByText('Voir les étapes')).not.toBeInTheDocument(); // four stages keep the row on a phone
    expect(within(screen.getByTestId('track-pickup')).getByText("Aito3D — 20 Route de l'eau Royale, Arue")).toBeInTheDocument();
    const rows = within(screen.getByTestId('track-lines')).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['ready', 'ready', 'waiting']);
    expect(rows[0]).toHaveTextContent('PETG BlancPrêt à retirer×1');
    expect(rows[2]).toHaveTextContent('En attente de stock');
    expect(screen.queryByTestId('track-tally')).not.toBeInTheDocument();
    expect(screen.getByText('Une question sur ta commande ?')).toBeInTheDocument();
  });

  it.each([
    ['received', 'received', { open: 2, ready: 0, waiting: 0 }, 'Nous avons bien reçu ta commande', 'Elle sera préparée dès que possible. Tu recevras un SMS quand elle sera prête.'],
    ['preparing', 'preparing', { open: 3, ready: 0, waiting: 0 }, 'Ta commande est en préparation', 'Nous préparons tes articles. Tu recevras un SMS quand ta commande sera prête.'],
    ['preparing', 'preparing', { open: 3, ready: 0, waiting: 1 }, 'Ta commande est en préparation', 'Un article est en attente de réapprovisionnement. Le reste est en cours de préparation.'],
    ['preparing', 'preparing', { open: 4, ready: 0, waiting: 2 }, 'Ta commande est en préparation', '2 articles sont en attente de réapprovisionnement. Le reste est en cours de préparation.'],
    ['preparing', 'preparing', { open: 2, ready: 0, waiting: 2 }, 'Ta commande est en préparation', 'Les articles restants sont en attente de réapprovisionnement. Tu recevras un SMS dès leur arrivée.'],
    ['partly_ready', 'ready', { open: 3, ready: 1, waiting: 0 }, 'Une partie de ta commande est prête', 'Tu peux déjà venir chercher 1 article sur 3. Le reste arrive prochainement.'],
    ['ready', 'ready', { open: 3, ready: 3, waiting: 0 }, 'Ta commande est prête', 'Tu peux venir la retirer à la boutique.'],
    ['handed_over', 'handed_over', { open: 0, ready: 0, waiting: 0 }, 'Commande remise', 'Merci pour ta confiance. À bientôt !'],
  ] as const)('state %s on stage %s with %o', async (state, stage, counts, title, sub) => {
    mockTrack({ state, stage, counts });
    renderPage();
    expect(await h2(title)).toBeInTheDocument();
    expect(screen.getByText(sub)).toBeInTheDocument();
    expect(screen.getByTestId(`track-stage-${stage}`)).toHaveAttribute('aria-current', 'step');
    // The pickup address is for an order that can be collected, in part or in full.
    expect(screen.queryByTestId('track-pickup') !== null).toBe(stage === 'ready');
  });

  it('a delivery order shows no pickup address and says the shop will call', async () => {
    mockTrack({ state: 'ready', pickup: false });
    renderPage();
    expect(await h2('Ta commande est prête')).toBeInTheDocument();
    expect(screen.getByText('Nous te contactons pour organiser la livraison.')).toBeInTheDocument();
    expect(screen.queryByTestId('track-pickup')).not.toBeInTheDocument();
  });

  it('names each line status, with the hand-over day only when the server gives one', async () => {
    mockTrack({
      state: 'preparing',
      stage: 'preparing',
      lines: [line('A', 'preparing'), line('B', 'to_prepare', 2.5), line('C', 'handed_over', 1, '2026-11-12'), line('D', 'handed_over')],
    });
    renderPage();
    await h2('Ta commande est en préparation');
    const rows = within(screen.getByTestId('track-lines')).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['AEn préparation×1', 'BÀ préparer×2.5', 'CRemis le 12 novembre×1', 'DRemis×1']);
  });

  it('folds a long order to six lines behind a button, with a tally when the statuses differ', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => line(`Article ${i}`, i < 16 ? 'ready' : 'waiting'));
    mockTrack({ lines });
    renderPage();
    await h2('Une partie de ta commande est prête');
    const list = screen.getByTestId('track-lines');
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getByTestId('track-tally')).toHaveTextContent('16 · prêt à retirer4 · en attente de stock');
    await userEvent.click(screen.getByRole('button', { name: 'Voir les 20 articles' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(20);
    expect(screen.queryByRole('button', { name: 'Voir les 20 articles' })).not.toBeInTheDocument();
  });

  it('a long order with one status has no tally, and eight lines are not folded', async () => {
    mockTrack({ state: 'ready', lines: Array.from({ length: 9 }, (_, i) => line(`Article ${i}`, 'ready')) });
    const view = renderPage();
    await h2('Ta commande est prête');
    expect(screen.getByRole('button', { name: 'Voir les 9 articles' })).toBeInTheDocument();
    expect(screen.queryByTestId('track-tally')).not.toBeInTheDocument();
    view.unmount();
    mockTrack({ lines: Array.from({ length: 8 }, (_, i) => line(`Article ${i}`, i ? 'ready' : 'waiting')) });
    renderPage();
    await h2('Une partie de ta commande est prête');
    expect(within(screen.getByTestId('track-lines')).getAllByRole('listitem')).toHaveLength(8);
    expect(screen.queryByTestId('track-tally')).not.toBeInTheDocument();
  });

  it('payment: left to pay, paid and total, with the online button only while a link is open', async () => {
    mockTrack({});
    const view = renderPage();
    await h2('Une partie de ta commande est prête');
    const pay = screen.getByTestId('track-payment');
    expect(pay).toHaveAttribute('data-state', 'unpaid');
    expect(flat(pay)).toMatch(/Reste à régler3.050.F.*Déjà réglé 2.295.F.* · total 5.345.F/);
    const link = within(pay).getByRole('link', { name: 'Payer en ligne' });
    expect(link).toHaveAttribute('href', 'https://pay.example/p/abc');
    expect(link).toHaveAttribute('target', '_blank');
    expect(within(pay).getByRole('button', { name: 'Moyens de paiement' })).toBeInTheDocument();
    view.unmount();

    mockTrack({ pay_url: null, payment: { currency: 'XPF', total: 5345, paid: 0, left: 5345 } });
    renderPage();
    await h2('Une partie de ta commande est prête');
    const unpaid = screen.getByTestId('track-payment');
    expect(within(unpaid).queryByRole('link', { name: 'Payer en ligne' })).not.toBeInTheDocument();
    expect(within(unpaid).getByRole('button', { name: 'Moyens de paiement' })).toBeInTheDocument();
    expect(flat(unpaid)).toMatch(/Total 5.345/);
    expect(flat(unpaid)).not.toMatch(/Déjà réglé/);
  });

  it('a settled order says so and offers nothing to pay; no payment data, no block', async () => {
    mockTrack({ payment: { currency: 'XPF', total: 5345, paid: 5345, left: 0 }, pay_url: null });
    const view = renderPage();
    await h2('Une partie de ta commande est prête');
    const pay = screen.getByTestId('track-payment');
    expect(pay).toHaveAttribute('data-state', 'paid');
    expect(flat(pay)).toMatch(/PaiementCommande régléeTotal 5.345/);
    expect(within(pay).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('track-panel-pay')).not.toBeInTheDocument();
    view.unmount();
    mockTrack({ payment: null, pay_url: null });
    renderPage();
    await h2('Une partie de ta commande est prête');
    expect(screen.queryByTestId('track-payment')).not.toBeInTheDocument();
  });

  it('the payment methods open on the right with the order reference, the shop on the left; one at a time', async () => {
    mockTrack({});
    renderPage();
    await h2('Une partie de ta commande est prête');
    const stage = screen.getByTestId('track-stage');
    const pay = screen.getByTestId('track-panel-pay');
    const shop = screen.getByTestId('track-panel-shop');
    expect(pay).toHaveAttribute('data-side', 'right');
    expect(shop).toHaveAttribute('data-side', 'left');
    expect(stage).not.toHaveAttribute('data-open');

    const methods = screen.getByRole('button', { name: 'Moyens de paiement' });
    await userEvent.click(methods);
    expect(stage).toHaveAttribute('data-open', 'pay');
    expect(methods).toHaveAttribute('aria-expanded', 'true');
    expect(within(pay).getByRole('heading', { name: 'Moyens de paiement' })).toHaveFocus();
    expect(flat(pay)).toMatch(/Commande #1079 · reste à régler 3.050/);
    expect(within(pay).getByRole('button', { name: 'Copier le motif' })).toHaveTextContent('#1079');

    await userEvent.click(within(screen.getByTestId('track-pickup')).getByRole('button', { name: "Voir la boutique et l'itinéraire" }));
    expect(stage).toHaveAttribute('data-open', 'shop');
    expect(within(shop).getByRole('heading', { name: 'Nous trouver' })).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    expect(stage).not.toHaveAttribute('data-open');
    await userEvent.click(within(screen.getByTestId('track-footer')).getByRole('button', { name: 'Où nous trouver' }));
    expect(stage).toHaveAttribute('data-open', 'shop');
    await userEvent.click(within(shop).getByRole('button', { name: 'Fermer' }));
    expect(stage).not.toHaveAttribute('data-open');
  });

  it('an unknown, cancelled or expired link gets the invalid page and the way to type a code', async () => {
    mockTrack(404);
    renderPage();
    expect(await screen.findByTestId('track-invalid')).toHaveTextContent("Ce lien de suivi n'est plus valide");
    expect(screen.getByText("Il a peut-être expiré. Contacte-nous et nous t'en enverrons un nouveau.")).toBeInTheDocument();
    expect(screen.queryByTestId('track-stage')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Saisir un code de suivi' }));
    expect(screen.getByText('code entry')).toBeInTheDocument();
  });

  it('a failure offers a retry that loads the page; the rate limit says to wait', async () => {
    mockTrack(500);
    const view = renderPage();
    expect(await screen.findByTestId('track-error')).toHaveTextContent('Impossible de charger le suivi pour le moment.');
    mockTrack({});
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await h2('Une partie de ta commande est prête')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('track-error')).not.toBeInTheDocument());
    view.unmount();
    mockTrack(429);
    renderPage();
    expect(await screen.findByTestId('track-error')).toHaveTextContent('Trop de tentatives. Patientez une minute.');
  });
});
