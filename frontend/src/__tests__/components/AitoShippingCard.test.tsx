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
  version: 4,
  shipping_island: 'rangiroa',
  shipping_service: 'tuamotu',
  shipping_service_name: 'Livraison Avion Tuamotu',
  shipping_first_name: 'Jean-Pierre',
  shipping_last_name: 'DUPONT',
  shipping_phone: '+689-89645864',
  shipping_price: 3200,
} as unknown as AitoProject;

const unshipped = { id: 7, version: 4, shipping_island: null } as unknown as AitoProject;

describe('ShippingCard', () => {
  it('shows every fact about the shipment', () => {
    render(<ShippingCard project={shipped} currency="XPF" />);
    expect(screen.getByText('Rangiroa')).toBeInTheDocument();
    expect(screen.getByText('Jean-Pierre DUPONT')).toBeInTheDocument();
    // Displayed in the dotted reading format, same as the client phone above it.
    expect(screen.getByText('(+689) 89.64.58.64')).toBeInTheDocument();
    expect(screen.getByText('Livraison Avion Tuamotu')).toBeInTheDocument();
    expect(screen.getByText(/3\s?200/)).toBeInTheDocument();
  });

  it('offers only an add button when there is no shipment', () => {
    render(<ShippingCard project={unshipped} currency="XPF" />);
    expect(screen.getByRole('button', { name: /add shipping/i })).toBeInTheDocument();
    expect(screen.queryByText(/^shipping$/i)).not.toBeInTheDocument();
  });

  // Add seeds the recipient from the project's client, exactly as the create
  // drawer seeds itself from its client draft — the panel used to open this
  // form blank and make the operator retype a name and a number the panel
  // header is already showing.
  it('prefills the recipient from the client when adding a shipment', async () => {
    const withClient = {
      ...unshipped,
      client_name: 'Jean-Pierre DUPONT',
      client_phone: '+689-89645864',
      client_is_company: false,
      client_social_network: null,
      client_social_handle: null,
    } as unknown as AitoProject;
    render(<ShippingCard project={withClient} currency="XPF" />);
    await userEvent.click(screen.getByRole('button', { name: /add shipping/i }));
    expect(screen.getByLabelText(/recipient first name/i)).toHaveValue('Jean-Pierre');
    expect(screen.getByLabelText(/recipient last name/i)).toHaveValue('DUPONT');
    expect(screen.getByLabelText(/country code/i)).toHaveValue('+689');
    expect(screen.getByLabelText(/recipient phone/i)).toHaveValue('89645864');
  });

  // A company has no person to split, so only the phone carries over — same
  // rule `emptyShippingDraft` applies for the drawer.
  it('seeds only the phone when the client is a company', async () => {
    const company = {
      ...unshipped,
      client_name: 'AITO 3D SARL',
      client_phone: '+689-40123456',
      client_is_company: true,
      client_social_network: null,
      client_social_handle: null,
    } as unknown as AitoProject;
    render(<ShippingCard project={company} currency="XPF" />);
    await userEvent.click(screen.getByRole('button', { name: /add shipping/i }));
    expect(screen.getByLabelText(/recipient first name/i)).toHaveValue('');
    expect(screen.getByLabelText(/recipient last name/i)).toHaveValue('');
    expect(screen.getByLabelText(/recipient phone/i)).toHaveValue('40123456');
  });

  // The card is the last thing in the panel's left column, so the editor opens
  // below the fold and its Save button reads as cut off. jsdom has no layout,
  // so what is pinned here is the CONTRACT — that the reveal is asked for on
  // open and again when the form grows — not the resulting geometry.
  describe('reveals the editor when it opens or grows', () => {
    const withScrollSpy = async (run: (spy: ReturnType<typeof vi.fn>) => Promise<void>) => {
      const spy = vi.fn();
      const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
      Element.prototype.scrollIntoView = spy;
      try {
        await run(spy);
      } finally {
        if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
        else delete (Element.prototype as Partial<Element>).scrollIntoView;
      }
    };

    it('scrolls the form into view when Add opens it', async () => {
      await withScrollSpy(async (spy) => {
        render(<ShippingCard project={unshipped} currency="XPF" />);
        await userEvent.click(screen.getByRole('button', { name: /add shipping/i }));
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ block: 'nearest' }));
      });
    });

    // The case the deps list exists for, and the reason an island is picked
    // FIRST: Save on an incomplete draft reveals the missing-name errors and
    // makes the form taller, pushing the button that was just clicked back
    // under the footer. Picking the island has already set `blurred.island`,
    // so watching that one flag would see no change here and never re-reveal —
    // which is why the effect watches the whole `blurred` object. Without the
    // island step this test passes either way and pins nothing.
    it('scrolls again when a failed Save reveals the error lines', async () => {
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
      await withScrollSpy(async (spy) => {
        render(<ShippingCard project={unshipped} currency="XPF" />);
        await userEvent.click(screen.getByRole('button', { name: /add shipping/i }));

        const island = await screen.findByLabelText(/destination island/i);
        await userEvent.type(island, 'Rangiroa');
        await userEvent.click(await screen.findByRole('option', { name: 'Rangiroa' }));
        // The island is in and its flag is set; anything after this is the
        // failed-Save growth alone.
        spy.mockClear();

        // The recipient is still empty, so this reveals errors instead of saving.
        await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

        expect(screen.getByLabelText(/recipient first name/i)).toHaveAttribute('aria-invalid', 'true');
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ block: 'nearest' }));
      });
    });
  });

  it('opens the same four fields on edit', async () => {
    render(<ShippingCard project={shipped} currency="XPF" />);
    await userEvent.click(screen.getByRole('button', { name: /edit shipping/i }));
    expect(screen.getByLabelText(/destination island/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/recipient first name/i)).toHaveValue('Jean-Pierre');
  });

  // ALSO FIX 5: a bespoke price (the expected case for air freight, billed
  // by weight) must not be silently reset to the catalogue rate just because
  // the operator reopened Edit and corrected the island within the same
  // service. Seeding `priceEdited` from a price/rate mismatch is what
  // protects it — this pins that the reset control (only shown once
  // `priceEdited` is true) appears on open, not only after a fresh keystroke.
  it('seeds priceEdited from a stored price that differs from the catalogue rate', async () => {
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
    const bespoke = { ...shipped, shipping_price: 5000 } as AitoProject;
    render(<ShippingCard project={bespoke} currency="XPF" />);
    await userEvent.click(screen.getByRole('button', { name: /edit shipping/i }));
    await screen.findByText('Livraison Avion Tuamotu');
    expect(screen.getByRole('spinbutton', { name: 'Rate' })).toHaveValue(5000);
    expect(screen.getByRole('button', { name: /back to the zoho rate/i })).toBeInTheDocument();
  });

  // The guard half: a price that already matches the catalogue rate must NOT
  // be treated as an override, or the create-drawer contract (island change
  // reseeds the price) would silently break for the common case.
  it('does not seed priceEdited when the stored price matches the catalogue rate', async () => {
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
    render(<ShippingCard project={shipped} currency="XPF" />);
    await userEvent.click(screen.getByRole('button', { name: /edit shipping/i }));
    await screen.findByText('Livraison Avion Tuamotu');
    expect(screen.queryByRole('button', { name: /back to the zoho rate/i })).not.toBeInTheDocument();
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

  // None of the 13 add/edit/save/priceEdited/PATCH-failure tests in this
  // file ever click Cancel — the one interaction that discards an
  // in-progress edit without sending anything. `cancel()` clears both
  // `editing` and `draft`, so this asserts the POSITIVE evidence that the
  // read view is back on screen (with the pre-edit stored values still
  // showing, not the typed-but-discarded ones) before checking the negative
  // (no PATCH). `updateAitoProject` is only ever reached from `save()`, so
  // there is exactly one layer standing between Cancel and a PATCH — cancel()
  // itself never calling `mutate`.
  it('discards an in-progress edit and sends nothing when Cancel is clicked', async () => {
    const spy = vi.spyOn(api, 'updateAitoProject');
    render(<ShippingCard project={shipped} currency="XPF" />);

    await userEvent.click(screen.getByRole('button', { name: /edit shipping/i }));
    const firstName = screen.getByLabelText(/recipient first name/i);
    await userEvent.clear(firstName);
    await userEvent.type(firstName, 'Someone Else');
    expect(firstName).toHaveValue('Someone Else');

    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    // Positive evidence first: the read view is back (Edit control visible
    // again, the edit form's fields gone) before trusting any absence.
    expect(await screen.findByRole('button', { name: /edit shipping/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/recipient first name/i)).not.toBeInTheDocument();
    // The stored, pre-edit recipient is what the read view shows — not the
    // discarded 'Someone Else' typed into the form.
    expect(screen.getByText('Jean-Pierre DUPONT')).toBeInTheDocument();
    expect(screen.queryByText(/Someone Else/)).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
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

      await waitFor(() =>
        expect(spy).toHaveBeenCalledWith(7, { shipping_island: null, expected_version: 4 }),
      );
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
        expected_version: 4,
      }),
    );
    await waitFor(() => {
      expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].shipping_price).toBe(4100);
    });
    expect(client.getQueryState(['aito-events', 7])?.isInvalidated).toBe(true);
  });

  it('shows the aito.saveFailed toast and stays in edit mode when the PATCH rejects', async () => {
    // No services handler needed: the stored shipment already carries a
    // price, so `draftFromProject` yields a complete draft and Save reaches
    // the mutation without touching the rate row. `setEditing(false)` lives
    // in the per-mutate onSuccess alone, so a rejection must leave the form
    // open with the operator's draft intact — closing it would throw away
    // the very edit the toast says was not saved.
    const spy = vi.spyOn(api, 'updateAitoProject').mockRejectedValue(new Error('nope'));
    renderWithBoard(shipped);

    await userEvent.click(screen.getByRole('button', { name: /edit shipping/i }));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(await screen.findByText(/could not save your changes/i)).toBeInTheDocument();
    // Still editing: the form's fields and its Save are on screen, and the
    // read view's Edit control is not.
    expect(screen.getByLabelText(/recipient first name/i)).toHaveValue('Jean-Pierre');
    expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit shipping/i })).not.toBeInTheDocument();
  });

  it('posts the full draft from the Add path — island pick seeds the rate, blur normalizes the names', async () => {
    // The Edit test above starts from a stored shipment; this one starts
    // from nothing at all, so every field the payload carries comes from the
    // form itself: the island pick (which seeds price and service), the two
    // hand-typed names (normalized by their blur handlers as focus moves on),
    // and the phone joined back into the house +CC-XXXXXXXX format.
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
    const spy = vi.spyOn(api, 'updateAitoProject').mockResolvedValue(shipped);
    renderWithBoard(unshipped);

    await userEvent.click(screen.getByRole('button', { name: /add shipping/i }));
    const island = await screen.findByLabelText(/destination island/i);
    await userEvent.type(island, 'Rangiroa');
    await userEvent.click(await screen.findByRole('option', { name: 'Rangiroa' }));
    await userEvent.type(screen.getByLabelText(/recipient first name/i), 'jean-pierre');
    await userEvent.type(screen.getByLabelText(/recipient last name/i), 'dupont');
    await userEvent.type(screen.getByLabelText(/recipient phone/i), '89645864');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith(7, {
        shipping_island: 'rangiroa',
        shipping_first_name: 'Jean-Pierre',
        shipping_last_name: 'DUPONT',
        shipping_phone: '+689-89645864',
        shipping_price: 3200,
        expected_version: 4,
      }),
    );
  });
});
