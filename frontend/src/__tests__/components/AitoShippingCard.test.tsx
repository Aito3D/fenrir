import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, render as rtlRender } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { server } from '../mocks/server';
import { render } from '../utils';
import { ShippingCard } from '../../components/aito/ShippingCard';
import { ToastProvider } from '../../contexts/ToastContext';
import { api } from '../../api/client';
import type { AitoProject } from '../../api/client';

const shipped = {
  id: 7,
  shipping_island: 'rangiroa',
  shipping_service: 'tuamotu',
  shipping_service_name: 'Livraison Avion Tuamotu',
  shipping_first_name: 'Jean-Pierre',
  shipping_last_name: 'DUPONT',
  shipping_phone: '+689-89645864',
  shipping_price: 3200,
} as unknown as AitoProject;

const unshipped = { id: 7, shipping_island: null } as unknown as AitoProject;

describe('ShippingCard', () => {
  it('shows every fact about the shipment', () => {
    render(<ShippingCard project={shipped} currency="XPF" />);
    expect(screen.getByText('Rangiroa')).toBeInTheDocument();
    expect(screen.getByText('Jean-Pierre DUPONT')).toBeInTheDocument();
    expect(screen.getByText('+689-89645864')).toBeInTheDocument();
    expect(screen.getByText('Livraison Avion Tuamotu')).toBeInTheDocument();
    expect(screen.getByText(/3\s?200/)).toBeInTheDocument();
  });

  it('offers only an add button when there is no shipment', () => {
    render(<ShippingCard project={unshipped} currency="XPF" />);
    expect(screen.getByRole('button', { name: /add shipping/i })).toBeInTheDocument();
    expect(screen.queryByText(/^shipping$/i)).not.toBeInTheDocument();
  });

  it('opens the same four fields on edit', async () => {
    render(<ShippingCard project={shipped} currency="XPF" />);
    await userEvent.click(screen.getByRole('button', { name: /edit shipping/i }));
    expect(screen.getByLabelText(/destination island/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/recipient first name/i)).toHaveValue('Jean-Pierre');
  });

  // The two tests above pass on the fallback alone (a plain capitalisation of
  // 'rangiroa' already reads 'Rangiroa'), so neither one actually proves the
  // catalogue lookup is wired up — deleting the `useQuery` call entirely
  // would leave them green. This one mocks the catalogue with a label the
  // fallback could never produce on its own, so only the real lookup path
  // can satisfy it.
  it('prefers the catalogue label over the fallback once the services query resolves', async () => {
    server.use(
      http.get('/api/v1/aito/shipping/services', () =>
        HttpResponse.json({
          services: [
            {
              key: 'tuamotu',
              name: 'Livraison Avion Tuamotu',
              rate: 3200,
              islands: [{ key: 'rangiroa', label: 'Île de Rangiroa' }],
            },
          ],
          catalogue_resolved: true,
        }),
      ),
    );
    render(<ShippingCard project={shipped} currency="XPF" />);
    expect(await screen.findByText('Île de Rangiroa')).toBeInTheDocument();
    expect(screen.queryByText('Rangiroa')).not.toBeInTheDocument();
  });

  // No MSW handler configured for this test — the default 'bypass' config
  // (setup.ts) means the request never resolves in time for a synchronous
  // assertion, so this exercises the pre-catalogue degrade path. A
  // hyphenated key is the one this fallback used to mangle ('Bora-bora'
  // rather than the catalogue's own 'Bora Bora').
  it('degrades to a segment-capitalized key while the catalogue has not resolved', () => {
    render(<ShippingCard project={{ ...shipped, shipping_island: 'bora-bora' } as AitoProject} currency="XPF" />);
    expect(screen.getByText('Bora Bora')).toBeInTheDocument();
  });
});

/** Renders `ShippingCard` against a real QueryClient seeded with the board
 *  cache (so `applyShipping`'s optimistic write has something to transform)
 *  and an `['aito-events', id]` entry (so the events-invalidation fix has a
 *  query state to mark invalidated) — mirrors the pattern
 *  `AitoDetailPanelOptimistic.test.tsx` uses for the panel's own mutations. */
function renderWithBoard(project: AitoProject) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(['aito-projects'], [project]);
  client.setQueryData(['aito-events', project.id], { events: [], has_more: false });
  rtlRender(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ShippingCard project={project} currency="XPF" />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return client;
}

describe('ShippingCard — Remove', () => {
  it('sends shipping_island: null, writes the response into the board cache, and invalidates events', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const updated = { ...shipped, shipping_island: null, shipping_service: null } as AitoProject;
      const spy = vi.spyOn(api, 'updateAitoProject').mockResolvedValue(updated);
      const client = renderWithBoard(shipped);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      // Same 500ms-hold idiom AitoQuoteStatusActions.test.tsx uses for every
      // other HoldButton in this feature.
      await user.pointer({ keys: '[MouseLeft>]', target: screen.getByRole('button', { name: /remove shipping/i }) });
      vi.advanceTimersByTime(600);

      await waitFor(() => expect(spy).toHaveBeenCalledWith(7, { shipping_island: null }));
      await waitFor(() => {
        expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].shipping_island).toBeNull();
      });
      expect(client.getQueryState(['aito-events', 7])?.isInvalidated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ShippingCard — Save', () => {
  it('posts shippingPayload(draft), writes the response into the board cache, and invalidates events', async () => {
    // The rate field only renders once `services` resolves the draft's
    // island to a real service (ShippingFields gates the whole block on
    // `service &&`) — without this the edit form would render with no rate
    // input to type into at all.
    server.use(
      http.get('/api/v1/aito/shipping/services', () =>
        HttpResponse.json({
          services: [
            {
              key: 'tuamotu',
              name: 'Livraison Avion Tuamotu',
              rate: 3200,
              islands: [{ key: 'rangiroa', label: 'Rangiroa' }],
            },
          ],
          catalogue_resolved: true,
        }),
      ),
    );
    const updated = { ...shipped, shipping_price: 4100 } as AitoProject;
    const spy = vi.spyOn(api, 'updateAitoProject').mockResolvedValue(updated);
    const client = renderWithBoard(shipped);

    await userEvent.click(screen.getByRole('button', { name: /edit shipping/i }));
    await screen.findByText('Livraison Avion Tuamotu');
    const rate = screen.getByRole('spinbutton', { name: 'Rate' });
    await userEvent.clear(rate);
    await userEvent.type(rate, '4100');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(7, {
        shipping_island: 'rangiroa',
        shipping_first_name: 'Jean-Pierre',
        shipping_last_name: 'DUPONT',
        shipping_phone: '+689-89645864',
        shipping_price: 4100,
      }),
    );
    await waitFor(() => {
      expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].shipping_price).toBe(4100);
    });
    expect(client.getQueryState(['aito-events', 7])?.isInvalidated).toBe(true);
  });
});
