/**
 * Tests for CalculatorSettingsPanels: filament/printer profile CRUD, the
 * delete-confirmation flow (confirm and cancel paths) and the global
 * defaults form. These panels render as tabs of CalculatorPage but are
 * exercised directly here — smaller surface, same behavior.
 *
 * `canUpdate` is threaded in as a prop from CalculatorPage (mirrors
 * `canUpdate` on the reality-check card — see CalculatorPage.tsx), gating
 * the add/edit/delete/Save controls (T-020). CRUD tests above pass
 * `canUpdate` explicitly; the "permission gating" describe blocks below
 * cover the `canUpdate={false}` case for each panel, and the listing
 * (search/sort/filter) staying visible either way.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useQueryClient } from '@tanstack/react-query';
import {
  CalculatorFilamentsPanel,
  CalculatorPrintersPanel,
} from '../../components/CalculatorSettingsPanels';
import { api } from '../../api/client';
import type {
  CalculatorFilament,
  CalculatorFilamentSyncResult,
  CalculatorPrinter,
  CalculatorDefaults,
  ZohoFilamentProduct,
} from '../../api/client';
// Pinned by name (not re-derived) so a wiring mistake — either panel
// importing shared.tsx's right-aligned/tabular-nums `tdCls` instead of this
// module's plain one, or vice versa — shows up as a real assertion failure
// below rather than a test that trivially agrees with whatever the panel
// happens to import (T-097).
import { settingsTdCls } from '../../components/calculator/calculatorSettingsShared';

const NOW = '2026-01-01T00:00:00Z';

const baseFilament: CalculatorFilament = {
  id: 1,
  name: 'Sunlu PLA',
  brand: 'Sunlu',
  material: 'PLA',
  cost_per_kg: 20,
  // Server-derived from cost * (1 + margin/100); never sent on write.
  sale_price_per_kg: 30,
  margin_pct: 50,
  difficulty_pct: 100,
  zoho_item_id: null,
  zoho_item_name: null,
  zoho_sku: null,
  spool_weight_kg: null,
  zoho_synced_at: null,
  created_at: NOW,
  updated_at: NOW,
};

/** A second row so the duplicate-link warning has something to collide with. */
const bambuAbsGf: CalculatorFilament = {
  ...baseFilament,
  id: 2,
  name: 'Bambu Lab ABS-GF',
  brand: 'Bambu Lab',
  material: 'ABS-GF',
  cost_per_kg: 1866,
  sale_price_per_kg: 2799,
};

/** An already-linked row, as it comes back from the server: the stored cost is
 *  round(dealer_price / spool_weight_kg, 2), so 1866 at 1 kg reconstructs a
 *  1866 dealer price exactly. */
const linkedFilament: CalculatorFilament = {
  ...bambuAbsGf,
  id: 3,
  zoho_item_id: '66407000008022673',
  zoho_item_name: 'Bambu Lab - ABS-GF - Bleu (Blue) - 1.75mm - 1kg',
  zoho_sku: 'B50-B0-1.75-1000-SPL',
  spool_weight_kg: 1,
  zoho_synced_at: NOW,
};

const ZOHO_BLUE: ZohoFilamentProduct = {
  item_id: '66407000008022673',
  name: 'Bambu Lab - ABS-GF - Bleu (Blue) - 1.75mm - 1kg',
  sku: 'B50-B0-1.75-1000-SPL',
  brand: 'Bambu Lab',
  material: 'ABS-GF',
  colour: 'Bleu (Blue)',
  spool_weight_kg: 1,
  weight_inferred: false,
  dealer_price: 1866,
  cost_per_kg: 1866,
  has_price: true,
};
const ZOHO_WHITE_NO_PRICE: ZohoFilamentProduct = {
  ...ZOHO_BLUE,
  item_id: '66407000008023724',
  colour: 'Blanc (White)',
  dealer_price: 0,
  cost_per_kg: 0,
  has_price: false,
};

const basePrinter: CalculatorPrinter = {
  id: 1,
  name: 'H2S',
  purchase_price: 3000,
  lifetime_years: 2,
  daily_usage_hours: 5,
  power_watts: 400,
  repair_rate_pct: 30,
  created_at: NOW,
  updated_at: NOW,
};

const baseDefaults: CalculatorDefaults = {
  id: 1,
  electricity_tariff: 120,
  labor_rate_per_hour: 3000,
  consumables_packaging_flat: 30,
  base_fee_flat: 0,
  margin_min_mult: 1.15,
  margin_max_mult: 1.6,
  margin_k: 33,
  qty_min_factor: 0.4,
  qty_k: 5,
  min_task_price: 12,
  failure_rate_pct: 30,
  prototype_rate_pct: 30,
  ads_rate_pct: 5,
  filament_markup_pct: 5,
  global_markup_pct: 50,
  tax_pct: 13,
  default_difficulty_pct: 100,
  default_margin_over_cost_pct: 50,
  stuff_markup_pct: 20,
  updated_at: NOW,
};

function mockDefaultsHandler(defaults: CalculatorDefaults = baseDefaults) {
  server.use(http.get('/api/v1/calculator/defaults', () => HttpResponse.json(defaults)));
}

/** Render CalculatorFilamentsPanel with canUpdate, seeded with `filaments`.
 *
 *  Zoho reports itself configured by default. The panel's /zoho/status query
 *  gates both the sync button and the form's product search, so the helper
 *  waits for it to settle — otherwise every caller races a second render.
 *  The seed array is read on each request, so a test can mutate it in place
 *  and assert that a refetch picked the change up. */
async function renderFilamentsPanel(
  filaments: CalculatorFilament[] = [baseFilament, bambuAbsGf],
  zohoConfigured = true,
): Promise<void> {
  server.use(
    http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(filaments)),
    http.get('/api/v1/zoho/status', () =>
      HttpResponse.json({
        configured: zohoConfigured,
        reachable: null,
        default_contact_id: '',
        default_contact_name: '',
      }),
    ),
  );
  render(<CalculatorFilamentsPanel selectedFilamentId={null} canUpdate />);
  await screen.findByRole('button', { name: 'Add filament' });
  if (zohoConfigured) await screen.findByRole('button', { name: 'Sync prices' });
}

/** The form's Zoho search box. The add/edit form holds four comboboxes (Zoho
 *  search, brand, material and the margin <select>), so it has to be named. */
const zohoSearchBox = () => screen.getByRole('combobox', { name: /zoho product/i });

/** Render the panel, click "Add filament" and return the spy standing in for
 *  the form's onSubmit — the panel routes it straight to this API call. */
async function openTheAddFilamentForm() {
  const create = vi.spyOn(api, 'createCalculatorFilament').mockResolvedValue({ ...baseFilament, id: 99 });
  await renderFilamentsPanel();
  await userEvent.click(screen.getByRole('button', { name: 'Add filament' }));
  return create;
}

/** Render the panel seeded with `filament`, click its edit (pencil) button and
 *  return the spy standing in for the form's onSubmit. */
async function openTheEditFormFor(filament: CalculatorFilament) {
  const update = vi.spyOn(api, 'updateCalculatorFilament').mockResolvedValue(filament);
  await renderFilamentsPanel([filament]);
  await userEvent.click(await screen.findByRole('button', { name: 'Edit filament' }));
  return update;
}

// Stands in for a background refetch of ['calculatorFilaments'] triggered
// elsewhere (another tab's edit, a Zoho price sync) — invalidating the
// query without the form itself doing anything. Used to hand back a
// freshly-deserialized (so reference-distinct) row object for the same id,
// the way a real refetch would.
function InvalidateFilamentsButton() {
  const queryClient = useQueryClient();
  return (
    <button type="button" onClick={() => queryClient.invalidateQueries({ queryKey: ['calculatorFilaments'] })}>
      simulate background refetch
    </button>
  );
}

describe('CalculatorFilamentsPanel', () => {
  beforeEach(() => {
    mockDefaultsHandler();
  });

  it('creates a new filament via the form and posts the derived payload', async () => {
    let filaments: CalculatorFilament[] = [baseFilament];
    let postBody: unknown = null;
    server.use(
      http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(filaments)),
      http.post('/api/v1/calculator/filaments/', async ({ request }) => {
        postBody = await request.json();
        const body = postBody as CalculatorFilament;
        const created: CalculatorFilament = {
          id: 2,
          name: `${body.brand} ${body.material}`.trim(),
          ...body,
          created_at: NOW,
          updated_at: NOW,
        };
        filaments = [...filaments, created];
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    const user = userEvent.setup();

    render(<CalculatorFilamentsPanel selectedFilamentId={null} canUpdate />);

    await user.click(await screen.findByRole('button', { name: 'Add filament' }));
    // Brand/material use the searchable-select combobox; typing with
    // allowCustom commits the raw text directly, no option needs picking.
    await user.type(screen.getByLabelText('Brand'), 'Prusament');
    await user.type(screen.getByLabelText('Material'), 'PETG');
    // Leave margin/difficulty at their (prefilled) defaults from
    // calculatorDefaults. "Cost per kg" is anchored because "Printing cost
    // per kg" (the derived field) would otherwise match the same regex.
    await user.type(screen.getByLabelText(/^Cost per kg/), '25');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(postBody).toEqual({
        brand: 'Prusament',
        material: 'PETG',
        cost_per_kg: 25,
        // default_margin_over_cost_pct is 50%; the server derives the sale
        // price from it, so the payload carries the margin, not the price.
        margin_pct: 50,
        difficulty_pct: 100,
        zoho_item_id: null,
        zoho_item_name: null,
        zoho_sku: null,
        spool_weight_kg: null,
      }),
    );

    // Positive evidence: the created filament now shows in the list...
    expect(await screen.findByRole('cell', { name: 'PETG' })).toBeInTheDocument();
    expect(screen.getByText('Filament added')).toBeInTheDocument();
    // ...and the create form is gone, replaced by the list view (Add button back).
    expect(screen.getByRole('button', { name: 'Add filament' })).toBeInTheDocument();
  });

  it('edits an existing filament and patches only the recomputed fields', async () => {
    let filaments: CalculatorFilament[] = [baseFilament];
    let patchedId: number | null = null;
    let patchBody: unknown = null;
    server.use(
      http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(filaments)),
      http.patch('/api/v1/calculator/filaments/:id', async ({ request, params }) => {
        patchedId = Number(params.id);
        patchBody = await request.json();
        const body = patchBody as CalculatorFilament;
        filaments = filaments.map((f) =>
          f.id === patchedId ? { ...f, ...body, name: `${body.brand} ${body.material}`.trim() } : f,
        );
        return HttpResponse.json(filaments.find((f) => f.id === patchedId));
      }),
    );
    const user = userEvent.setup();

    render(<CalculatorFilamentsPanel selectedFilamentId={null} canUpdate />);

    await user.click(await screen.findByRole('button', { name: 'Edit filament' }));
    // Form seeded from the existing filament: margin comes from its column.
    const cost = screen.getByLabelText(/^Cost per kg/);
    expect(cost).toHaveValue(20);
    await user.clear(cost);
    await user.type(cost, '22');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patchedId).toBe(1));
    expect(patchBody).toEqual({
      brand: 'Sunlu',
      material: 'PLA',
      cost_per_kg: 22,
      // Margin carried over from the existing filament; the server re-derives
      // the sale price (22 * 1.5) from it.
      margin_pct: 50,
      difficulty_pct: 100,
      zoho_item_id: null,
      zoho_item_name: null,
      zoho_sku: null,
      spool_weight_kg: null,
    });
    expect(await screen.findByText('Filament updated')).toBeInTheDocument();
  });

  it('deletes a filament through the confirm modal', async () => {
    let filaments: CalculatorFilament[] = [baseFilament];
    let deletedId: number | null = null;
    server.use(
      http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(filaments)),
      http.delete('/api/v1/calculator/filaments/:id', ({ params }) => {
        deletedId = Number(params.id);
        filaments = filaments.filter((f) => f.id !== deletedId);
        return HttpResponse.json({ message: 'deleted' });
      }),
    );
    const user = userEvent.setup();

    render(<CalculatorFilamentsPanel selectedFilamentId={null} canUpdate />);

    await user.click(await screen.findByRole('button', { name: 'Delete filament' }));
    expect(await screen.findByText('Delete filament')).toBeInTheDocument();
    expect(screen.getByText('Delete "Sunlu PLA"? This cannot be undone.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(deletedId).toBe(1));
    expect(await screen.findByText('Filament deleted')).toBeInTheDocument();
    expect(screen.getByText('No matches found')).toBeInTheDocument();
  });

  it('cancels the delete confirmation without calling the API', async () => {
    const filaments: CalculatorFilament[] = [baseFilament];
    const deleteSpy = vi.fn();
    server.use(
      http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(filaments)),
      http.delete('/api/v1/calculator/filaments/:id', () => {
        deleteSpy();
        return HttpResponse.json({ message: 'deleted' });
      }),
    );
    const user = userEvent.setup();

    render(<CalculatorFilamentsPanel selectedFilamentId={null} canUpdate />);

    await user.click(await screen.findByRole('button', { name: 'Delete filament' }));
    expect(await screen.findByText('Delete filament')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Delete filament')).not.toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'PLA' })).toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  // T-124: useEntityCrudMutations' onError handlers (create/update/delete)
  // were previously untested for both panels — a save or delete that starts
  // failing could silently lose its error toast with nothing to catch it.
  // These pin today's actual behavior (form/modal stay open, nothing is
  // removed from the list) rather than any "should" behavior.
  it('shows an error toast and keeps the add form open when the create request fails', async () => {
    const filaments: CalculatorFilament[] = [baseFilament];
    server.use(
      http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(filaments)),
      http.post('/api/v1/calculator/filaments/', () =>
        HttpResponse.json({ detail: 'Save failed' }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();

    render(<CalculatorFilamentsPanel selectedFilamentId={null} canUpdate />);

    await user.click(await screen.findByRole('button', { name: 'Add filament' }));
    await user.type(screen.getByLabelText('Brand'), 'Prusament');
    await user.type(screen.getByLabelText('Material'), 'PETG');
    await user.type(screen.getByLabelText(/^Cost per kg/), '25');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Save failed')).toBeInTheDocument();
    // Form stays open with the typed values intact — onSaved (which would
    // clear `editing` and return to the list) never ran.
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Cost per kg/)).toHaveValue(25);
    expect(screen.queryByRole('button', { name: 'Add filament' })).not.toBeInTheDocument();
  });

  it('shows an error toast and keeps the edit form open when the update request fails', async () => {
    const filaments: CalculatorFilament[] = [baseFilament];
    server.use(
      http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(filaments)),
      http.patch('/api/v1/calculator/filaments/:id', () =>
        HttpResponse.json({ detail: 'Update failed' }, { status: 422 }),
      ),
    );
    const user = userEvent.setup();

    render(<CalculatorFilamentsPanel selectedFilamentId={null} canUpdate />);

    await user.click(await screen.findByRole('button', { name: 'Edit filament' }));
    const cost = screen.getByLabelText(/^Cost per kg/);
    await user.clear(cost);
    await user.type(cost, '22');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Update failed')).toBeInTheDocument();
    // Still the edit form, still holding the edited (unsaved) value.
    expect(screen.getByLabelText(/^Cost per kg/)).toHaveValue(22);
    expect(screen.getByLabelText('Brand')).toHaveValue('Sunlu');
    expect(screen.queryByRole('button', { name: 'Add filament' })).not.toBeInTheDocument();
  });

  it('shows an error toast and keeps the confirm modal open when the delete request fails', async () => {
    const filaments: CalculatorFilament[] = [baseFilament];
    server.use(
      http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(filaments)),
      http.delete('/api/v1/calculator/filaments/:id', () =>
        HttpResponse.json({ detail: 'Delete failed' }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();

    render(<CalculatorFilamentsPanel selectedFilamentId={null} canUpdate />);

    await user.click(await screen.findByRole('button', { name: 'Delete filament' }));
    expect(await screen.findByText('Delete filament')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('Delete failed')).toBeInTheDocument();
    // Confirm modal recovers rather than closing: title still shown, the
    // Confirm button is no longer stuck in its loading/disabled state.
    expect(screen.getByText('Delete filament')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
    // The row is still there — onDeleted (which clears toDelete) never ran,
    // and the failed delete never invalidated the listing query.
    expect(screen.getByRole('cell', { name: 'PLA' })).toBeInTheDocument();
  });

  // T-119: useEntityCrudMutations must not resolve a save against whatever
  // `editing` happens to be *when the response lands* — only against the
  // form it was actually issued for. Reproduces the exact sequence from the
  // audit: edit X, hit Save (slow), Cancel before it resolves, open a
  // different (new) form and type into it, then let X's stale save land.
  it('does not close a newly opened form or misname the toast when a cancelled save resolves late', async () => {
    const filaments: CalculatorFilament[] = [baseFilament];
    let releaseUpdate: (f: CalculatorFilament) => void = () => {};
    const deferredUpdate = new Promise<CalculatorFilament>((resolve) => {
      releaseUpdate = resolve;
    });
    vi.spyOn(api, 'updateCalculatorFilament').mockReturnValue(deferredUpdate);

    await renderFilamentsPanel(filaments);

    // Edit the only row (Sunlu PLA) and hit Save — the request never
    // resolves until releaseUpdate() is called below.
    await userEvent.click(await screen.findByRole('button', { name: 'Edit filament' }));
    const cost = screen.getByLabelText(/^Cost per kg/);
    await userEvent.clear(cost);
    await userEvent.type(cost, '22');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Cancel is not gated on the in-flight save, so this succeeds while the
    // PATCH above is still pending.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText(/^Cost per kg/)).not.toBeInTheDocument();

    // Open a brand new form (a different `editing`) and start typing.
    await userEvent.click(screen.getByRole('button', { name: 'Add filament' }));
    await userEvent.type(screen.getByLabelText('Brand'), 'Prusament');

    // The stale edit-of-X save now lands.
    releaseUpdate({ ...baseFilament, cost_per_kg: 22 });

    // The toast names what actually happened (an update), not whatever
    // `editing` moved on to.
    expect(await screen.findByText('Filament updated', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText('Filament added')).not.toBeInTheDocument();

    // The newly opened Add form is untouched — still open, typed value intact.
    expect(screen.getByLabelText('Brand')).toHaveValue('Prusament');
    expect(screen.queryByRole('button', { name: 'Add filament' })).not.toBeInTheDocument();
  });

  // Companion to the test above: reopening the *same* row (same id) while
  // its own save is still in flight — rather than a different form — must
  // still close it once the save lands. This is the `snapshot.id ===
  // current.id` half of useEntityCrudMutations' `sameTarget` check
  // (calculatorSettingsShared.ts); the test above never reaches it, since
  // there `current` is `'new'` and short-circuits on `snapshot === current`
  // being false without ever comparing ids. A background refetch between
  // Cancel and reopening is folded in deliberately (see the source
  // comment's own "even if a background refetch handed back a new object
  // for it"): without it, `editing` would just be re-set to the exact same
  // cached row object both times, so `snapshot === current` alone would
  // already be true and the id comparison would never actually run.
  it('closes the form when its own save resolves after the same row was reopened for editing via a refetched object', async () => {
    const filaments: CalculatorFilament[] = [baseFilament];
    server.use(
      http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(filaments)),
      http.get('/api/v1/zoho/status', () =>
        HttpResponse.json({ configured: true, reachable: null, default_contact_id: '', default_contact_name: '' }),
      ),
    );
    let releaseUpdate: (f: CalculatorFilament) => void = () => {};
    const deferredUpdate = new Promise<CalculatorFilament>((resolve) => {
      releaseUpdate = resolve;
    });
    vi.spyOn(api, 'updateCalculatorFilament').mockReturnValue(deferredUpdate);

    render(
      <>
        <InvalidateFilamentsButton />
        <CalculatorFilamentsPanel selectedFilamentId={null} canUpdate />
      </>,
    );
    await screen.findByRole('button', { name: 'Add filament' });
    await screen.findByRole('button', { name: 'Sync prices' });

    // Edit the only row (Sunlu PLA) and hit Save — the request never
    // resolves until releaseUpdate() is called below.
    await userEvent.click(await screen.findByRole('button', { name: 'Edit filament' }));
    const cost = screen.getByLabelText(/^Cost per kg/);
    await userEvent.clear(cost);
    await userEvent.type(cost, '22');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Cancel is not gated on the in-flight save, so this succeeds while the
    // PATCH above is still pending.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText(/^Cost per kg/)).not.toBeInTheDocument();

    // Something else (another tab) refetches the list after touching an
    // unrelated field (`updated_at`) — React Query's default structural
    // sharing would otherwise silently reuse the exact same object
    // reference for an unchanged row, which would make `snapshot ===
    // current` true on its own and never actually exercise the id
    // comparison this test targets.
    filaments[0] = { ...filaments[0], updated_at: '2026-01-02T00:00:00Z' };
    await userEvent.click(screen.getByRole('button', { name: 'simulate background refetch' }));

    // Reopen the SAME row (same id, now a different object). The reopened
    // form shows the unedited value — Cancel discarded the '22' typed
    // earlier, and the still-pending save hasn't landed yet.
    await userEvent.click(await screen.findByRole('button', { name: 'Edit filament' }));
    expect(screen.getByLabelText(/^Cost per kg/)).toHaveValue(20);

    // The stale save for that same row now lands.
    releaseUpdate({ ...baseFilament, cost_per_kg: 22 });

    expect(await screen.findByText('Filament updated', {}, { timeout: 5000 })).toBeInTheDocument();

    // Same entity by id (even though not the same object reference): the
    // reopened form closes, back to the listing.
    expect(await screen.findByRole('button', { name: 'Add filament' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Cost per kg/)).not.toBeInTheDocument();
  });

  // T-125: the Save button's `isSaving` (saveMutation.isPending) guard and
  // the delete confirm's `isLoading` (deleteMutation.isPending) guard were
  // never exercised — dropping either from its JSX left the whole suite
  // green. These hold the mutation open on a controlled promise and assert
  // the control is actually disabled mid-flight, then pin what happens once
  // it resolves (the form/modal closes — onSaved/onDeleted, same as every
  // other successful-save/-delete test in this file; there is no
  // "re-enabled" state to observe on the success path since the control
  // that was disabled unmounts with it).
  it('disables the Save button while the create mutation is pending, then closes the form on success', async () => {
    let releaseCreate: (f: CalculatorFilament) => void = () => {};
    const deferredCreate = new Promise<CalculatorFilament>((resolve) => {
      releaseCreate = resolve;
    });
    const createSpy = vi.spyOn(api, 'createCalculatorFilament').mockReturnValue(deferredCreate);

    await renderFilamentsPanel([baseFilament]);

    await userEvent.click(screen.getByRole('button', { name: 'Add filament' }));
    await userEvent.type(screen.getByLabelText('Brand'), 'Prusament');
    await userEvent.type(screen.getByLabelText('Material'), 'PETG');
    await userEvent.type(screen.getByLabelText(/^Cost per kg/), '25');

    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect(saveButton).toBeEnabled();
    await userEvent.click(saveButton);

    // Mid-flight: the create request is pending and unresolved.
    await waitFor(() => expect(saveButton).toBeDisabled(), { timeout: 5000 });

    releaseCreate({ ...baseFilament, id: 99, brand: 'Prusament', material: 'PETG', cost_per_kg: 25 });

    // onSaved() closes the form back to the listing once the create lands.
    expect(await screen.findByRole('button', { name: 'Add filament' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Cost per kg/)).not.toBeInTheDocument();

    createSpy.mockRestore();
  });

  it('disables the Save button while the update mutation is pending, then closes the form on success', async () => {
    let releaseUpdate: (f: CalculatorFilament) => void = () => {};
    const deferredUpdate = new Promise<CalculatorFilament>((resolve) => {
      releaseUpdate = resolve;
    });
    const updateSpy = vi.spyOn(api, 'updateCalculatorFilament').mockReturnValue(deferredUpdate);

    await renderFilamentsPanel([baseFilament]);

    await userEvent.click(await screen.findByRole('button', { name: 'Edit filament' }));
    const cost = screen.getByLabelText(/^Cost per kg/);
    await userEvent.clear(cost);
    await userEvent.type(cost, '22');

    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect(saveButton).toBeEnabled();
    await userEvent.click(saveButton);

    // Mid-flight: the update request is pending and unresolved.
    await waitFor(() => expect(saveButton).toBeDisabled(), { timeout: 5000 });

    releaseUpdate({ ...baseFilament, cost_per_kg: 22 });

    // onSaved() closes the form back to the listing once the update lands.
    expect(await screen.findByRole('button', { name: 'Add filament' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Cost per kg/)).not.toBeInTheDocument();

    updateSpy.mockRestore();
  });

  it('disables the delete Confirm button while the delete mutation is pending, then closes the modal on success', async () => {
    let releaseDelete: (v: unknown) => void = () => {};
    const deferredDelete = new Promise<unknown>((resolve) => {
      releaseDelete = resolve;
    });
    const deleteSpy = vi.spyOn(api, 'deleteCalculatorFilament').mockReturnValue(deferredDelete);

    await renderFilamentsPanel([baseFilament]);

    await userEvent.click(await screen.findByRole('button', { name: 'Delete filament' }));
    expect(await screen.findByText('Delete filament')).toBeInTheDocument();

    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmButton).toBeEnabled();
    await userEvent.click(confirmButton);

    // Mid-flight: the delete request is pending and unresolved. The same
    // element's accessible name changes ("Confirm" -> the loading label)
    // once isLoading flips, so this asserts on the captured node, not a
    // fresh name-based query.
    await waitFor(() => expect(confirmButton).toBeDisabled(), { timeout: 5000 });

    releaseDelete({ message: 'deleted' });

    // onDeleted() closes the modal once the delete lands.
    await waitFor(() => expect(screen.queryByText('Delete filament')).not.toBeInTheDocument(), { timeout: 5000 });

    deleteSpy.mockRestore();
  });
});

describe('CalculatorFilamentsPanel filament form (Zoho link)', () => {
  beforeEach(() => {
    mockDefaultsHandler();
  });
  // The helpers above replace api methods on the shared module object;
  // restore them so later tests in this file talk to MSW again.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers margin in 25% steps from 0 to 200', async () => {
    await openTheAddFilamentForm();
    const margin = screen.getByLabelText(/margin/i) as HTMLSelectElement;
    const values = Array.from(margin.options).map((o) => Number(o.value));
    expect(values).toEqual([0, 25, 50, 75, 100, 125, 150, 175, 200]);
  });

  it('keeps an off-grid margin selectable so an existing row can be saved unchanged', async () => {
    await openTheEditFormFor({ ...baseFilament, margin_pct: 47.3 });
    const margin = screen.getByLabelText(/margin/i) as HTMLSelectElement;
    expect(Array.from(margin.options).map((o) => Number(o.value))).toContain(47.3);
    expect(margin.value).toBe('47.3');
  });

  it('renders an off-grid margin label at money precision, keeping the exact value', async () => {
    // What the migration's backfill produces for the real row 1 of the user's
    // database (cost 3731, sale 5597) before it was rounded: rendering the raw
    // float would put "50.013401232913424%" in the dropdown.
    await openTheEditFormFor({ ...baseFilament, margin_pct: 50.013401232913424 });
    const margin = screen.getByLabelText(/margin/i) as HTMLSelectElement;
    const offGrid = Array.from(margin.options)[0];
    expect(offGrid.textContent).toBe('50.01%');
    // The value stays exact so re-saving the row does not move its margin.
    expect(offGrid.value).toBe('50.013401232913424');
    expect(margin.value).toBe('50.013401232913424');
  });

  it('does not pad a whole-number margin with decimals', async () => {
    await openTheAddFilamentForm();
    const margin = screen.getByLabelText(/margin/i) as HTMLSelectElement;
    expect(Array.from(margin.options).map((o) => o.textContent)).toEqual([
      '0%', '25%', '50%', '75%', '100%', '125%', '150%', '175%', '200%',
    ]);
  });

  it('shows printing cost per kg as a read-only derived field', async () => {
    await openTheAddFilamentForm();
    await userEvent.type(screen.getByLabelText(/^cost per kg/i), '1000');
    await userEvent.selectOptions(screen.getByLabelText(/margin/i), '75');
    const printing = screen.getByLabelText(/printing cost per kg/i) as HTMLInputElement;
    expect(printing).toHaveAttribute('readonly');
    expect(printing.value).toBe('1750');
  });

  it('fills brand, material, weight and cost when a Zoho product is chosen', async () => {
    vi.spyOn(api, 'searchZohoFilaments').mockResolvedValue([ZOHO_BLUE]);
    await openTheAddFilamentForm();
    await userEvent.type(zohoSearchBox(), 'abs-gf');
    await userEvent.click(await screen.findByText(/Bleu \(Blue\)/));

    expect(screen.getByText(/Linked to/)).toBeInTheDocument();
    expect((screen.getByLabelText(/^cost per kg/i) as HTMLInputElement).value).toBe('1866');
    expect(screen.getByLabelText(/^cost per kg/i)).toHaveAttribute('readonly');
    expect((screen.getByLabelText(/spool weight/i) as HTMLInputElement).value).toBe('1');
  });

  it('leaves cost blank when the chosen product has no dealer price', async () => {
    vi.spyOn(api, 'searchZohoFilaments').mockResolvedValue([ZOHO_WHITE_NO_PRICE]);
    await openTheAddFilamentForm();
    await userEvent.type(zohoSearchBox(), 'blanc');
    await userEvent.click(await screen.findByText(/Blanc \(White\)/));
    expect((screen.getByLabelText(/^cost per kg/i) as HTMLInputElement).value).toBe('');
    expect(screen.getByLabelText(/^cost per kg/i)).not.toHaveAttribute('readonly');
  });

  it('unlinking restores manual editing and clears the Zoho fields on save', async () => {
    vi.spyOn(api, 'searchZohoFilaments').mockResolvedValue([ZOHO_BLUE]);
    const onSubmit = await openTheAddFilamentForm();
    await userEvent.type(zohoSearchBox(), 'abs-gf');
    await userEvent.click(await screen.findByText(/Bleu \(Blue\)/));
    await userEvent.click(screen.getByRole('button', { name: /unlink/i }));

    expect(screen.getByLabelText(/^cost per kg/i)).not.toHaveAttribute('readonly');
    await userEvent.clear(screen.getByLabelText(/^cost per kg/i));
    await userEvent.type(screen.getByLabelText(/^cost per kg/i), '900');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ cost_per_kg: 900 }));
    // Exactly these four keys carry an explicit null — no more, no fewer. They
    // are the only fields the backend clears on a null; leaving zoho_sku or
    // zoho_item_name populated would orphan them on a row the sync no longer
    // visits (it selects on zoho_item_id.is_not(None)).
    const payload = onSubmit.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(payload).filter((key) => payload[key] === null).sort()).toEqual([
      'spool_weight_kg',
      'zoho_item_id',
      'zoho_item_name',
      'zoho_sku',
    ]);
  });

  it('recomputes cost per kg when the spool weight is corrected', async () => {
    vi.spyOn(api, 'searchZohoFilaments').mockResolvedValue([ZOHO_BLUE]);
    await openTheAddFilamentForm();
    await userEvent.type(zohoSearchBox(), 'abs-gf');
    await userEvent.click(await screen.findByText(/Bleu \(Blue\)/));
    await userEvent.clear(screen.getByLabelText(/spool weight/i));
    await userEvent.type(screen.getByLabelText(/spool weight/i), '0.5');
    expect((screen.getByLabelText(/^cost per kg/i) as HTMLInputElement).value).toBe('3732');
  });

  it('cannot submit a zero spool weight', async () => {
    // The API rejects spool_weight_kg <= 0 with a field-level 422 whose raw
    // `body.spool_weight_kg: Input should be greater than 0` reaches the toast,
    // and clearing the weight leaves `cost` at its previous value so nothing
    // else would disable Save.
    const onSubmit = await openTheEditFormFor(linkedFilament);
    const weight = screen.getByLabelText(/spool weight/i) as HTMLInputElement;
    await userEvent.clear(weight);
    await userEvent.type(weight, '0');

    // `min` is also the step base, so it has to stay on the 0.05 grid the
    // step uses — otherwise an ordinary 1 kg spool becomes a step mismatch.
    expect(weight).toHaveAttribute('min', '0.05');
    expect(weight).toHaveAttribute('step', '0.05');
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('still saves an ordinary 1 kg spool weight', async () => {
    // Pin against the step-base trap: a `min` off the step grid would make the
    // commonest weight of all unsubmittable.
    const onSubmit = await openTheEditFormFor(linkedFilament);
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSubmit).toHaveBeenCalledWith(
      linkedFilament.id,
      expect.objectContaining({ spool_weight_kg: 1 }),
    );
  });

  it('keeps a hand-typed cost editable after unlinking and re-linking to an unpriced product', async () => {
    // The corruption path commit 3e8693544 exists to prevent: link to a priced
    // product and sync, unlink, re-link to one of the zero-dealer-price items,
    // type a cost by hand. If anything still treated that cost as Zoho-owned,
    // it would go read-only and a spool-weight correction would rescale it
    // (1234 at 1 kg -> 1645.33 at 0.75 kg). The server half is clearing
    // zoho_synced_at on unlink; this is the client half, within one session.
    vi.spyOn(api, 'searchZohoFilaments').mockResolvedValue([ZOHO_WHITE_NO_PRICE]);
    const onSubmit = await openTheEditFormFor(linkedFilament);
    expect(screen.getByLabelText(/^cost per kg/i)).toHaveAttribute('readonly');

    await userEvent.click(screen.getByRole('button', { name: /unlink/i }));
    await userEvent.type(zohoSearchBox(), 'blanc');
    await userEvent.click(await screen.findByText(/Blanc \(White\)/));

    const cost = screen.getByLabelText(/^cost per kg/i) as HTMLInputElement;
    expect(cost).not.toHaveAttribute('readonly');
    await userEvent.clear(cost);
    await userEvent.type(cost, '1234');
    await userEvent.clear(screen.getByLabelText(/spool weight/i));
    await userEvent.type(screen.getByLabelText(/spool weight/i), '0.75');
    expect(cost.value).toBe('1234');

    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSubmit).toHaveBeenCalledWith(
      linkedFilament.id,
      expect.objectContaining({
        cost_per_kg: 1234,
        spool_weight_kg: 0.75,
        zoho_item_id: ZOHO_WHITE_NO_PRICE.item_id,
      }),
    );
  });

  it('warns but does not block when the link duplicates an existing filament', async () => {
    vi.spyOn(api, 'searchZohoFilaments').mockResolvedValue([ZOHO_BLUE]);
    // The panel already lists a Bambu Lab ABS-GF filament.
    const onSubmit = await openTheAddFilamentForm();
    await userEvent.type(zohoSearchBox(), 'abs-gf');
    await userEvent.click(await screen.findByText(/Bleu \(Blue\)/));

    expect(screen.getByText(/already exists/i)).toBeInTheDocument();
    // Warning only — saving still works.
    expect(screen.getByRole('button', { name: /save/i })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSubmit).toHaveBeenCalled();
  });

  it('keeps cost Zoho-owned when editing an already-linked filament', async () => {
    await openTheEditFormFor(linkedFilament);
    expect(screen.getByLabelText(/^cost per kg/i)).toHaveAttribute('readonly');
  });

  it('re-derives the cost when the spool weight of a linked filament is corrected', async () => {
    await openTheEditFormFor(linkedFilament);
    await userEvent.clear(screen.getByLabelText(/spool weight/i));
    await userEvent.type(screen.getByLabelText(/spool weight/i), '0.5');
    // Stored 1866 at 1 kg reconstructs an 1866 dealer price; half a spool costs
    // the same, so the per-kg cost doubles.
    expect((screen.getByLabelText(/^cost per kg/i) as HTMLInputElement).value).toBe('3732');
  });

  it('leaves a hand-typed cost editable on a linked row Zoho never priced', async () => {
    // The row is linked and carries a real cost, but the cost is the
    // operator's: the sync stamps zoho_synced_at only when it applied a dealer
    // price, and a has_price:false item is skipped before that stamp. So a null
    // stamp means no Zoho price ever landed here, whatever the cost says.
    const handPriced = { ...linkedFilament, cost_per_kg: 500, zoho_synced_at: null };
    await openTheEditFormFor(handPriced);
    const cost = screen.getByLabelText(/^cost per kg/i);
    expect(cost).not.toHaveAttribute('readonly');

    await userEvent.clear(screen.getByLabelText(/spool weight/i));
    await userEvent.type(screen.getByLabelText(/spool weight/i), '0.5');
    // A weight correction must not rescale a number Zoho never supplied.
    expect((cost as HTMLInputElement).value).toBe('500');
  });

  it('leaves cost editable for a linked filament that has no dealer price', async () => {
    // has_price was false at sync time, so the operator typed the cost by hand
    // (here: never got round to it). There is no dealer price to reconstruct.
    await openTheEditFormFor({ ...linkedFilament, cost_per_kg: 0 });
    const cost = screen.getByLabelText(/^cost per kg/i);
    expect(cost).not.toHaveAttribute('readonly');
    await userEvent.clear(cost);
    await userEvent.type(cost, '500');
    await userEvent.clear(screen.getByLabelText(/spool weight/i));
    await userEvent.type(screen.getByLabelText(/spool weight/i), '0.5');
    expect((cost as HTMLInputElement).value).toBe('500');
  });

  it('submits margin_pct and never sale_price_per_kg', async () => {
    const onSubmit = await openTheAddFilamentForm();
    await userEvent.type(screen.getByLabelText(/material/i), 'PETG');
    await userEvent.type(screen.getByLabelText(/^cost per kg/i), '1000');
    await userEvent.selectOptions(screen.getByLabelText(/margin/i), '25');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ margin_pct: 25 }));
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('sale_price_per_kg');
  });
});

describe('CalculatorFilamentsPanel Zoho price sync', () => {
  beforeEach(() => {
    mockDefaultsHandler();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A sync chunk with the boring fields filled in. */
  const chunk = (over: Partial<CalculatorFilamentSyncResult>): CalculatorFilamentSyncResult => ({
    processed: 0,
    total: 0,
    updated: 0,
    unchanged: 0,
    skipped_no_price: 0,
    missing: 0,
    next_after_id: null,
    ...over,
  });

  it('loops sync chunks until next_after_id is null and shows the summary', async () => {
    const sync = vi
      .spyOn(api, 'syncCalculatorFilamentsFromZoho')
      .mockResolvedValueOnce(chunk({ processed: 25, total: 30, updated: 20, unchanged: 5, next_after_id: 187 }))
      .mockResolvedValueOnce(chunk({ processed: 5, total: 30, updated: 3, unchanged: 1, skipped_no_price: 1 }));

    await renderFilamentsPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Sync prices' }));

    await waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
    // Chunk 2 resumes from the id chunk 1 reported, NOT from a running offset.
    expect(sync).toHaveBeenNthCalledWith(1, 0, 25);
    expect(sync).toHaveBeenNthCalledWith(2, 187, 25);
    // Counts are accumulated across chunks, not taken from the last one.
    expect(await screen.findByText(/23 updated/)).toBeInTheDocument();
    expect(screen.getByText(/6 unchanged/)).toBeInTheDocument();
    expect(screen.getByText(/1 without a dealer price/)).toBeInTheDocument();
    // The button goes back to offering a sync once the walk is done.
    expect(screen.getByRole('button', { name: 'Sync prices' })).toBeEnabled();
  });

  it('hides the sync button and the product search when Zoho is not configured', async () => {
    // Spied as well as stubbed in MSW so the absence is asserted after the
    // status query has actually answered, not merely before it started.
    const status = vi.spyOn(api, 'getZohoStatus').mockResolvedValue({
      configured: false,
      reachable: null,
      default_contact_id: '',
      default_contact_name: '',
    });
    await renderFilamentsPanel([baseFilament], false);
    await waitFor(() => expect(status).toHaveBeenCalled());

    // Positive evidence the panel itself rendered before asserting absences.
    expect(await screen.findByRole('cell', { name: 'PLA' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync prices' })).toBeNull();
    // The same gate hides the form's Zoho product search.
    await userEvent.click(screen.getByRole('button', { name: 'Add filament' }));
    expect(screen.queryByRole('combobox', { name: /zoho product/i })).toBeNull();
  });

  it('stops and reports when a chunk fails, keeping earlier chunks', async () => {
    const rows = [{ ...baseFilament }];
    const sync = vi
      .spyOn(api, 'syncCalculatorFilamentsFromZoho')
      .mockResolvedValueOnce(chunk({ processed: 25, total: 30, updated: 25, next_after_id: 187 }))
      .mockRejectedValueOnce(new Error('502'));

    await renderFilamentsPanel(rows);
    // Chunk 1 committed server-side before chunk 2 blew up; the refetch after
    // the failure must still show that work.
    rows[0] = { ...baseFilament, material: 'PETG' };
    await userEvent.click(screen.getByRole('button', { name: 'Sync prices' }));

    expect(await screen.findByText(/sync stopped: 502/i)).toBeInTheDocument();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('cell', { name: 'PETG' })).toBeInTheDocument();
    // No summary is claimed for a run that never finished.
    expect(screen.queryByText(/updated ·/)).toBeNull();
  });

  it('keeps the progress readable when the row count drifts mid-walk', async () => {
    // `total` is a fresh COUNT on every chunk, so deletions mid-walk can push
    // it below what has already been processed. "50 / 12" would be nonsense.
    let releaseLast: (result: CalculatorFilamentSyncResult) => void = () => {};
    const lastChunk = new Promise<CalculatorFilamentSyncResult>((resolve) => {
      releaseLast = resolve;
    });
    vi.spyOn(api, 'syncCalculatorFilamentsFromZoho')
      .mockResolvedValueOnce(chunk({ processed: 25, total: 30, updated: 25, next_after_id: 187 }))
      .mockResolvedValueOnce(chunk({ processed: 25, total: 12, updated: 25, next_after_id: 210 }))
      .mockReturnValueOnce(lastChunk);

    await renderFilamentsPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Sync prices' }));

    const progress = await screen.findByRole('button', { name: '50 / 50' });
    expect(progress).toBeInTheDocument();
    // A second run started on top of the first would double-commit every
    // remaining row, so the button stays shut until the walk finishes.
    expect(progress).toBeDisabled();
    releaseLast(chunk({ processed: 3, total: 12, updated: 3 }));
    expect(await screen.findByText(/53 updated/)).toBeInTheDocument();
  });

  it('seeds the progress denominator from the linked rows on screen', async () => {
    // Until the first chunk answers — seconds on a real catalogue — the only
    // count available is the one already in the table. "0 / 0" reads as broken.
    let releaseFirst: (result: CalculatorFilamentSyncResult) => void = () => {};
    const firstChunk = new Promise<CalculatorFilamentSyncResult>((resolve) => {
      releaseFirst = resolve;
    });
    vi.spyOn(api, 'syncCalculatorFilamentsFromZoho').mockReturnValueOnce(firstChunk);

    // Two rows listed, one of them linked to Zoho — only the linked one syncs.
    await renderFilamentsPanel([baseFilament, linkedFilament]);
    await userEvent.click(screen.getByRole('button', { name: 'Sync prices' }));

    expect(await screen.findByRole('button', { name: '0 / 1' })).toBeInTheDocument();
    // The server's own COUNT takes over from the first chunk onwards.
    releaseFirst(chunk({ processed: 1, total: 9, updated: 1 }));
    expect(await screen.findByText(/1 updated/)).toBeInTheDocument();
  });

  it('stops instead of looping when a chunk does not advance the cursor', async () => {
    // Nothing today returns a non-advancing cursor (the backend pages
    // WHERE id > after_id), but an unguarded loop would fire hundreds of
    // COUNT-plus-commit requests behind a disabled button with no way out.
    const sync = vi
      .spyOn(api, 'syncCalculatorFilamentsFromZoho')
      .mockResolvedValue(chunk({ processed: 3, total: 3, updated: 3, next_after_id: 5 }));

    await renderFilamentsPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Sync prices' }));

    expect(await screen.findByText(/sync stopped: sync did not advance past id 5/i)).toBeInTheDocument();
    // Bounded: the first chunk sets the cursor to 5, the second returns 5 again
    // and is rejected. Never a third.
    expect(sync).toHaveBeenCalledTimes(2);
    // And the operator can act again rather than staring at a stuck spinner.
    expect(await screen.findByRole('button', { name: 'Sync prices' })).toBeEnabled();
  });

  it('accepts a final chunk that processed nothing', async () => {
    // The lookahead sentinel row was deleted between chunks, so the last
    // request finds nothing left to do. That is a clean finish, not an error.
    const sync = vi
      .spyOn(api, 'syncCalculatorFilamentsFromZoho')
      .mockResolvedValueOnce(chunk({ processed: 25, total: 25, updated: 25, next_after_id: 187 }))
      .mockResolvedValueOnce(chunk({ processed: 0, total: 25 }));

    await renderFilamentsPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Sync prices' }));

    expect(await screen.findByText(/25 updated/)).toBeInTheDocument();
    expect(screen.queryByText(/sync stopped/i)).toBeNull();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  // T-075: the walk is a plain async loop with no AbortController, so it
  // keeps running (and keeps issuing chunk requests) even after the panel
  // that started it unmounts — CalculatorPage unmounts this panel on every
  // tab switch. The in-flight guard and live progress must survive that, or
  // the operator can start a second overlapping walk. (Its completed summary
  // is a separate, narrower story — see "does not show a completed sync
  // summary after an unmount/remount" below: the walk keeps running and
  // keeps committing chunks either way, but only the guard/progress are
  // shared across mounts, so a completion the original mount is no longer
  // around to hear about is not reported on this later, different mount.)
  it('keeps the guard and progress alive across an unmount/remount and blocks a second overlapping walk', async () => {
    server.use(
      http.get('/api/v1/calculator/filaments/', () => HttpResponse.json([baseFilament, linkedFilament])),
      http.get('/api/v1/zoho/status', () =>
        HttpResponse.json({ configured: true, reachable: null, default_contact_id: '', default_contact_name: '' }),
      ),
    );
    // Chunk 1 is held open under our control so the panel can be unmounted
    // while it is still in flight; chunk 2 resolves immediately once asked
    // for and finishes the walk.
    let releaseChunk1: (result: CalculatorFilamentSyncResult) => void = () => {};
    const chunk1 = new Promise<CalculatorFilamentSyncResult>((resolve) => {
      releaseChunk1 = resolve;
    });
    const sync = vi
      .spyOn(api, 'syncCalculatorFilamentsFromZoho')
      .mockReturnValueOnce(chunk1)
      .mockResolvedValueOnce(chunk({ processed: 1, total: 9, updated: 1 }));

    const { rerender } = render(<CalculatorFilamentsPanel selectedFilamentId={null} canUpdate />);
    await screen.findByRole('button', { name: 'Add filament' });

    await userEvent.click(await screen.findByRole('button', { name: 'Sync prices' }));
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));

    // Switch away — mirrors CalculatorPage unmounting this panel on a tab
    // change — while chunk 1 is still pending.
    rerender(<div />);
    // ...and back, before the walk has finished.
    rerender(<CalculatorFilamentsPanel selectedFilamentId={null} canUpdate />);
    await screen.findByRole('button', { name: 'Add filament' });

    // Attempt to start a second walk from the remount, via a selector that
    // matches the sync button under either label (idle "Sync prices" or a
    // live "N / M") so this step runs identically whether or not the guard
    // survived. This is the actual reported failure, checked first and on
    // the request count, not the UI: a second walk would immediately issue
    // its own first chunk request (afterId 0), so if the guard had been
    // lost, the call count would grow past 1 right here — before either of
    // the UI assertions below even run.
    const button = screen.getByRole('button', { name: /sync prices|\d+\s*\/\s*\d+/i });
    await userEvent.click(button);
    expect(sync).toHaveBeenCalledTimes(1);

    // (a) The guard survived the remount, visibly too: the button still
    // reads as in-progress and is disabled, not a fresh idle "Sync prices".
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleName(/^\d+\s*\/\s*\d+$/);

    // Let the walk finish: chunk 1 resolves and the loop fetches chunk 2 (the
    // only second call this test allows) — the walk that started on the
    // first mount runs to completion exactly as it would have if nothing had
    // been unmounted; nothing here aborts it. The completed summary itself
    // belongs to the (now gone) first mount's own state and is not this
    // test's concern (see the narrowed summary test below) — what this test
    // guards is that the shared guard/progress correctly release once that
    // walk is done, re-enabling the button on the panel that is actually on
    // screen.
    releaseChunk1(chunk({ processed: 0, total: 9, next_after_id: 187 }));
    expect(await screen.findByRole('button', { name: 'Sync prices' })).toBeEnabled();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenNthCalledWith(2, 187, 25);
  });

  // T-075 fix-up: the walk had no AbortController and no request timeout, so
  // a chunk request that never settles (a real network black hole, not a
  // server error) left the session-scoped guard stuck forever — the button
  // stayed disabled for the rest of the page session. A per-chunk timeout
  // ends the walk and releases the guard instead.
  // Driven entirely with vitest fake timers — never a wall-clock sleep, never
  // msw's `delay()`.
  //
  // T-096 fix-up: `withTimeout` never aborts the chunk request it gave up
  // on — the request the test never resolves is still "running" server-side
  // for the rest of this test, standing in for the real request that is
  // still in flight past the client-side timeout. A timeout is therefore
  // reported as indeterminate, not a flat failure, and the table is
  // refetched a second time — after the abandoned request would have had the
  // same worst-case window to land — so prices it committed after the first,
  // immediate refetch are not left hidden.
  it('reports a timed-out chunk as indeterminate, re-enables the button, and refetches again to pick up what the abandoned request commits', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const rows = [{ ...baseFilament }];
      // Spied before the panel mounts so the initial listing fetch is
      // counted too — every call after it must be an `invalidateQueries`
      // refetch, not a coincidence of render timing.
      const getFilaments = vi.spyOn(api, 'getCalculatorFilaments');
      // Gated on nothing the test ever resolves: this promise simply never
      // settles, standing in for a request that hangs indefinitely — and,
      // per the never-abort contract above, is still pending at the end of
      // this test too.
      const sync = vi
        .spyOn(api, 'syncCalculatorFilamentsFromZoho')
        .mockReturnValueOnce(new Promise<CalculatorFilamentSyncResult>(() => {}));

      await renderFilamentsPanel(rows);
      const fetchesBeforeSync = getFilaments.mock.calls.length;
      await user.click(screen.getByRole('button', { name: 'Sync prices' }));
      await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));

      // Comfortably inside the timeout budget: still in flight, no error yet.
      await vi.advanceTimersByTimeAsync(59_000);
      expect(screen.queryByText(/timed out/i)).toBeNull();
      expect(screen.getByRole('button', { name: /\d+\s*\/\s*\d+/ })).toBeDisabled();

      // Cross the per-chunk timeout.
      await vi.advanceTimersByTimeAsync(2_000);

      // (b) Indeterminate wording — not the flat "sync stopped: <error>"
      // failure message a genuine chunk error (tested above) still gets.
      expect(await screen.findByText(/timed out; some chunks may have applied/i)).toBeInTheDocument();
      expect(screen.queryByText(/^sync stopped/i)).toBeNull();
      expect(await screen.findByRole('button', { name: 'Sync prices' })).toBeEnabled();
      // The immediate refetch on timeout has already landed, and only it —
      // the abandoned request has not committed anything yet in this test.
      expect(await screen.findByRole('cell', { name: 'PLA' })).toBeInTheDocument();
      expect(getFilaments.mock.calls.length).toBe(fetchesBeforeSync + 1);

      // The abandoned chunk request now finally commits, server-side, well
      // after the client gave up on it — exactly the scenario `withTimeout`
      // documents as possible.
      rows[0] = { ...baseFilament, material: 'PETG' };

      // (a) The second, later invalidation picks up that late commit.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await screen.findByRole('cell', { name: 'PETG' })).toBeInTheDocument();
      expect(getFilaments.mock.calls.length).toBe(fetchesBeforeSync + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  // T-075 fix-up: the first attempt kept summary/error in the same
  // session-scoped cache as the guard, so an error from a walk that failed
  // entirely off-screen would still appear on the next mount, for the rest
  // of the page session, with no way to dismiss it. The user narrowed this
  // back to BASE semantics: only the in-flight guard/progress survive an
  // unmount — a walk's terminal outcome (summary or error) does not outlive
  // the mount that was watching it.
  it('does not surface a sync error that happened while the panel was unmounted (narrowed to BASE semantics)', async () => {
    server.use(
      http.get('/api/v1/calculator/filaments/', () => HttpResponse.json([linkedFilament])),
      http.get('/api/v1/zoho/status', () =>
        HttpResponse.json({ configured: true, reachable: null, default_contact_id: '', default_contact_name: '' }),
      ),
    );
    let rejectChunk: (error: Error) => void = () => {};
    const chunk1 = new Promise<CalculatorFilamentSyncResult>((_resolve, reject) => {
      rejectChunk = reject;
    });
    const sync = vi.spyOn(api, 'syncCalculatorFilamentsFromZoho').mockReturnValueOnce(chunk1);

    const { rerender } = render(<CalculatorFilamentsPanel selectedFilamentId={null} canUpdate />);
    await screen.findByRole('button', { name: 'Add filament' });

    await userEvent.click(await screen.findByRole('button', { name: 'Sync prices' }));
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));

    // Unmount, then the walk fails while nothing is listening.
    rerender(<div />);
    rejectChunk(new Error('502'));
    // Come back — the failure happened entirely off-screen. BASE semantics
    // say a remount after the walk has ended shows a clean panel.
    rerender(<CalculatorFilamentsPanel selectedFilamentId={null} canUpdate />);

    // Positive evidence the panel actually remounted, the walk's rejection
    // was processed, and the guard was released — before asserting the
    // error is absent (never assert only an absence).
    expect(await screen.findByRole('button', { name: 'Sync prices' })).toBeEnabled();
    expect(screen.queryByText(/sync stopped/i)).toBeNull();
  });

  // The completed-summary half of the same narrowing.
  it('does not show a completed sync summary after an unmount/remount', async () => {
    server.use(
      http.get('/api/v1/calculator/filaments/', () => HttpResponse.json([linkedFilament])),
      http.get('/api/v1/zoho/status', () =>
        HttpResponse.json({ configured: true, reachable: null, default_contact_id: '', default_contact_name: '' }),
      ),
    );
    const sync = vi
      .spyOn(api, 'syncCalculatorFilamentsFromZoho')
      .mockResolvedValueOnce(chunk({ processed: 9, total: 9, updated: 9 }));

    const { rerender } = render(<CalculatorFilamentsPanel selectedFilamentId={null} canUpdate />);
    await screen.findByRole('button', { name: 'Add filament' });

    await userEvent.click(await screen.findByRole('button', { name: 'Sync prices' }));
    // Let the walk complete while still mounted, so the summary is proven to
    // exist before it is unmounted away.
    expect(await screen.findByText(/9 updated/)).toBeInTheDocument();
    expect(sync).toHaveBeenCalledTimes(1);

    // Unmount after the walk has already ended, then come back.
    rerender(<div />);
    rerender(<CalculatorFilamentsPanel selectedFilamentId={null} canUpdate />);

    // Positive evidence the panel re-rendered cleanly (button present and
    // enabled, i.e. no guard/progress state bled through either) before
    // asserting the summary is gone.
    expect(await screen.findByRole('button', { name: 'Sync prices' })).toBeEnabled();
    expect(screen.queryByText(/9 updated/)).toBeNull();
    // No second walk was ever started by the remount.
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('labels the price column as printing cost', async () => {
    await renderFilamentsPanel();
    expect(await screen.findByRole('button', { name: /printing cost per kg/i })).toBeInTheDocument();
    expect(screen.queryByText('calculator.salePerKg')).toBeNull();
  });

  it('renders profile-table cells with calculatorSettingsShared\'s tdCls, not shared.tsx\'s (T-097)', async () => {
    await renderFilamentsPanel([baseFilament]);
    const materialCell = await screen.findByRole('cell', { name: 'PLA' });
    // shared.tsx's tdCls adds "text-right ... tabular-nums" which this
    // left-aligned material column never carries under either wiring, so an
    // exact match (not just a substring) is what actually pins the source
    // module — a mis-wire would append the extra classes to "text-white".
    expect(materialCell.className).toBe(`${settingsTdCls} text-white`);
  });

  it('marks the rows that are linked to a Zoho product', async () => {
    await renderFilamentsPanel([baseFilament, linkedFilament]);
    const badges = await screen.findAllByTitle(linkedFilament.zoho_item_name!);
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('Zoho');
  });
});

describe('CalculatorFilamentsPanel permission gating (T-020)', () => {
  beforeEach(() => {
    mockDefaultsHandler();
  });

  it('hides the add-filament control without calculator:update', async () => {
    server.use(http.get('/api/v1/calculator/filaments/', () => HttpResponse.json([baseFilament])));

    render(<CalculatorFilamentsPanel selectedFilamentId={null} canUpdate={false} />);

    // Positive evidence the panel actually rendered (list visible)...
    expect(await screen.findByRole('cell', { name: 'PLA' })).toBeInTheDocument();
    // ...before asserting the write control is gone.
    expect(screen.queryByRole('button', { name: 'Add filament' })).not.toBeInTheDocument();
  });

  it('hides the edit and delete controls without calculator:update', async () => {
    server.use(http.get('/api/v1/calculator/filaments/', () => HttpResponse.json([baseFilament])));

    render(<CalculatorFilamentsPanel selectedFilamentId={null} canUpdate={false} />);

    await screen.findByRole('cell', { name: 'PLA' });
    expect(screen.queryByRole('button', { name: 'Edit filament' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete filament' })).not.toBeInTheDocument();
  });

  it('keeps search, filter and sort usable without calculator:update', async () => {
    const other: CalculatorFilament = { ...baseFilament, id: 2, name: 'Prusa PETG', brand: 'Prusa', material: 'PETG' };
    server.use(http.get('/api/v1/calculator/filaments/', () => HttpResponse.json([baseFilament, other])));
    const user = userEvent.setup();

    render(<CalculatorFilamentsPanel selectedFilamentId={null} canUpdate={false} />);

    await screen.findByRole('cell', { name: 'PLA' });
    await user.type(screen.getByLabelText('Search'), 'Prusa');

    expect(screen.getByRole('cell', { name: 'PETG' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'PLA' })).not.toBeInTheDocument();
  });

  it('toggles sort direction on repeated header clicks (useSortToggle)', async () => {
    server.use(http.get('/api/v1/calculator/filaments/', () => HttpResponse.json([baseFilament, bambuAbsGf])));
    const user = userEvent.setup();

    render(<CalculatorFilamentsPanel selectedFilamentId={null} canUpdate={false} />);

    await screen.findByRole('cell', { name: 'PLA' });

    const materialColumnInOrder = () =>
      screen
        .getAllByRole('row')
        .slice(1) // drop the header row
        .map((row) => within(row).getAllByRole('cell')[1].textContent);

    // Default sort is by name ascending: "Bambu Lab ABS-GF" sorts before
    // "Sunlu PLA".
    expect(materialColumnInOrder()).toEqual(['ABS-GF', 'PLA']);

    // Selecting a different column (Material) starts it ascending — same
    // order here, since ABS-GF < PLA too.
    await user.click(screen.getByRole('button', { name: 'Material' }));
    expect(materialColumnInOrder()).toEqual(['ABS-GF', 'PLA']);

    // Clicking the now-active Material column again flips the direction.
    await user.click(screen.getByRole('button', { name: 'Material' }));
    expect(materialColumnInOrder()).toEqual(['PLA', 'ABS-GF']);
  });
});

describe('CalculatorPrintersPanel', () => {
  it('creates a new printer via the form and posts the payload', async () => {
    let printers: CalculatorPrinter[] = [basePrinter];
    let postBody: unknown = null;
    server.use(
      http.get('/api/v1/calculator/printers/', () => HttpResponse.json(printers)),
      http.post('/api/v1/calculator/printers/', async ({ request }) => {
        postBody = await request.json();
        const body = postBody as CalculatorPrinter;
        const created: CalculatorPrinter = { id: 2, ...body, created_at: NOW, updated_at: NOW };
        printers = [...printers, created];
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    const user = userEvent.setup();

    render(<CalculatorPrintersPanel selectedPrinterId={null} canUpdate />);

    await user.click(await screen.findByRole('button', { name: 'Add printer' }));
    await user.type(screen.getByLabelText('Name'), 'A1 Mini');
    await user.type(screen.getByLabelText(/Purchase price/), '1000');
    await user.type(screen.getByLabelText(/Lifetime \(years\)/), '2');
    await user.type(screen.getByLabelText(/Daily usage/), '5');
    await user.type(screen.getByLabelText(/Power \(W\)/), '200');
    await user.type(screen.getByLabelText(/Repairs over lifetime/), '10');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(postBody).toEqual({
        name: 'A1 Mini',
        purchase_price: 1000,
        lifetime_years: 2,
        daily_usage_hours: 5,
        power_watts: 200,
        repair_rate_pct: 10,
      }),
    );
    expect(await screen.findByRole('cell', { name: /A1 Mini/ })).toBeInTheDocument();
    expect(screen.getByText('Printer added')).toBeInTheDocument();
  });

  it('edits an existing printer and patches the updated field', async () => {
    let printers: CalculatorPrinter[] = [basePrinter];
    let patchedId: number | null = null;
    let patchBody: unknown = null;
    server.use(
      http.get('/api/v1/calculator/printers/', () => HttpResponse.json(printers)),
      http.patch('/api/v1/calculator/printers/:id', async ({ request, params }) => {
        patchedId = Number(params.id);
        patchBody = await request.json();
        printers = printers.map((p) => (p.id === patchedId ? { ...p, ...(patchBody as CalculatorPrinter) } : p));
        return HttpResponse.json(printers.find((p) => p.id === patchedId));
      }),
    );
    const user = userEvent.setup();

    render(<CalculatorPrintersPanel selectedPrinterId={null} canUpdate />);

    await user.click(await screen.findByRole('button', { name: 'Edit printer' }));
    const name = screen.getByLabelText('Name');
    expect(name).toHaveValue('H2S');
    await user.clear(name);
    await user.type(name, 'H2S Pro');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patchedId).toBe(1));
    expect(patchBody).toEqual({
      name: 'H2S Pro',
      purchase_price: 3000,
      lifetime_years: 2,
      daily_usage_hours: 5,
      power_watts: 400,
      repair_rate_pct: 30,
    });
    expect(await screen.findByText('Printer updated')).toBeInTheDocument();
  });

  it('deletes a printer through the confirm modal', async () => {
    let printers: CalculatorPrinter[] = [basePrinter];
    let deletedId: number | null = null;
    server.use(
      http.get('/api/v1/calculator/printers/', () => HttpResponse.json(printers)),
      http.delete('/api/v1/calculator/printers/:id', ({ params }) => {
        deletedId = Number(params.id);
        printers = printers.filter((p) => p.id !== deletedId);
        return HttpResponse.json({ message: 'deleted' });
      }),
    );
    const user = userEvent.setup();

    render(<CalculatorPrintersPanel selectedPrinterId={null} canUpdate />);

    await user.click(await screen.findByRole('button', { name: 'Delete printer' }));
    expect(await screen.findByText('Delete printer')).toBeInTheDocument();
    expect(screen.getByText('Delete "H2S"? This cannot be undone.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(deletedId).toBe(1));
    expect(await screen.findByText('Printer deleted')).toBeInTheDocument();
    expect(screen.getByText('No matches found')).toBeInTheDocument();
  });

  it('cancels the delete confirmation without calling the API', async () => {
    const printers: CalculatorPrinter[] = [basePrinter];
    const deleteSpy = vi.fn();
    server.use(
      http.get('/api/v1/calculator/printers/', () => HttpResponse.json(printers)),
      http.delete('/api/v1/calculator/printers/:id', () => {
        deleteSpy();
        return HttpResponse.json({ message: 'deleted' });
      }),
    );
    const user = userEvent.setup();

    render(<CalculatorPrintersPanel selectedPrinterId={null} canUpdate />);

    await user.click(await screen.findByRole('button', { name: 'Delete printer' }));
    expect(await screen.findByText('Delete printer')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Delete printer')).not.toBeInTheDocument();
    expect(screen.getByRole('cell', { name: /H2S/ })).toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  // T-124: same coverage gap as CalculatorFilamentsPanel's onError tests
  // above — useEntityCrudMutations is shared, but each panel's tests are
  // independent, so both need their own pin.
  it('shows an error toast and keeps the add form open when the create request fails', async () => {
    const printers: CalculatorPrinter[] = [basePrinter];
    server.use(
      http.get('/api/v1/calculator/printers/', () => HttpResponse.json(printers)),
      http.post('/api/v1/calculator/printers/', () =>
        HttpResponse.json({ detail: 'Save failed' }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();

    render(<CalculatorPrintersPanel selectedPrinterId={null} canUpdate />);

    await user.click(await screen.findByRole('button', { name: 'Add printer' }));
    await user.type(screen.getByLabelText('Name'), 'A1 Mini');
    await user.type(screen.getByLabelText(/Purchase price/), '1000');
    await user.type(screen.getByLabelText(/Lifetime \(years\)/), '2');
    await user.type(screen.getByLabelText(/Daily usage/), '5');
    await user.type(screen.getByLabelText(/Power \(W\)/), '200');
    await user.type(screen.getByLabelText(/Repairs over lifetime/), '10');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Save failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('A1 Mini');
    expect(screen.queryByRole('button', { name: 'Add printer' })).not.toBeInTheDocument();
  });

  it('shows an error toast and keeps the edit form open when the update request fails', async () => {
    const printers: CalculatorPrinter[] = [basePrinter];
    server.use(
      http.get('/api/v1/calculator/printers/', () => HttpResponse.json(printers)),
      http.patch('/api/v1/calculator/printers/:id', () =>
        HttpResponse.json({ detail: 'Update failed' }, { status: 422 }),
      ),
    );
    const user = userEvent.setup();

    render(<CalculatorPrintersPanel selectedPrinterId={null} canUpdate />);

    await user.click(await screen.findByRole('button', { name: 'Edit printer' }));
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'H2S Pro');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Update failed')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('H2S Pro');
    expect(screen.queryByRole('button', { name: 'Add printer' })).not.toBeInTheDocument();
  });

  it('shows an error toast and keeps the confirm modal open when the delete request fails', async () => {
    const printers: CalculatorPrinter[] = [basePrinter];
    server.use(
      http.get('/api/v1/calculator/printers/', () => HttpResponse.json(printers)),
      http.delete('/api/v1/calculator/printers/:id', () =>
        HttpResponse.json({ detail: 'Delete failed' }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();

    render(<CalculatorPrintersPanel selectedPrinterId={null} canUpdate />);

    await user.click(await screen.findByRole('button', { name: 'Delete printer' }));
    expect(await screen.findByText('Delete printer')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('Delete failed')).toBeInTheDocument();
    expect(screen.getByText('Delete printer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
    expect(screen.getByRole('cell', { name: /H2S/ })).toBeInTheDocument();
  });

  it('renders profile-table cells with calculatorSettingsShared\'s tdCls, not shared.tsx\'s (T-097)', async () => {
    server.use(http.get('/api/v1/calculator/printers/', () => HttpResponse.json([basePrinter])));

    render(<CalculatorPrintersPanel selectedPrinterId={null} canUpdate />);

    const nameCell = await screen.findByRole('cell', { name: 'H2S' });
    // Exact match (not substring) so a mis-wire to shared.tsx's
    // right-aligned/tabular-nums tdCls — which this left-aligned name
    // column never legitimately carries — is caught.
    expect(nameCell.className).toBe(`${settingsTdCls} text-white`);
  });

  // T-125: same coverage gap as CalculatorFilamentsPanel's pending-state
  // tests above — useEntityCrudMutations is shared, but each panel's tests
  // are independent, so both need their own pin.
  it('disables the Save button while the create mutation is pending, then closes the form on success', async () => {
    let releaseCreate: (p: CalculatorPrinter) => void = () => {};
    const deferredCreate = new Promise<CalculatorPrinter>((resolve) => {
      releaseCreate = resolve;
    });
    const createSpy = vi.spyOn(api, 'createCalculatorPrinter').mockReturnValue(deferredCreate);
    server.use(http.get('/api/v1/calculator/printers/', () => HttpResponse.json([basePrinter])));

    render(<CalculatorPrintersPanel selectedPrinterId={null} canUpdate />);

    await userEvent.click(await screen.findByRole('button', { name: 'Add printer' }));
    await userEvent.type(screen.getByLabelText('Name'), 'A1 Mini');
    await userEvent.type(screen.getByLabelText(/Purchase price/), '1000');
    await userEvent.type(screen.getByLabelText(/Lifetime \(years\)/), '2');
    await userEvent.type(screen.getByLabelText(/Daily usage/), '5');
    await userEvent.type(screen.getByLabelText(/Power \(W\)/), '200');
    await userEvent.type(screen.getByLabelText(/Repairs over lifetime/), '10');

    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect(saveButton).toBeEnabled();
    await userEvent.click(saveButton);

    // Mid-flight: the create request is pending and unresolved.
    await waitFor(() => expect(saveButton).toBeDisabled(), { timeout: 5000 });

    releaseCreate({
      id: 2,
      name: 'A1 Mini',
      purchase_price: 1000,
      lifetime_years: 2,
      daily_usage_hours: 5,
      power_watts: 200,
      repair_rate_pct: 10,
      created_at: NOW,
      updated_at: NOW,
    });

    // onSaved() closes the form back to the listing once the create lands.
    expect(await screen.findByRole('button', { name: 'Add printer' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();

    createSpy.mockRestore();
  });

  it('disables the Save button while the update mutation is pending, then closes the form on success', async () => {
    let releaseUpdate: (p: CalculatorPrinter) => void = () => {};
    const deferredUpdate = new Promise<CalculatorPrinter>((resolve) => {
      releaseUpdate = resolve;
    });
    const updateSpy = vi.spyOn(api, 'updateCalculatorPrinter').mockReturnValue(deferredUpdate);
    server.use(http.get('/api/v1/calculator/printers/', () => HttpResponse.json([basePrinter])));

    render(<CalculatorPrintersPanel selectedPrinterId={null} canUpdate />);

    await userEvent.click(await screen.findByRole('button', { name: 'Edit printer' }));
    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'H2S Pro');

    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect(saveButton).toBeEnabled();
    await userEvent.click(saveButton);

    // Mid-flight: the update request is pending and unresolved.
    await waitFor(() => expect(saveButton).toBeDisabled(), { timeout: 5000 });

    releaseUpdate({ ...basePrinter, name: 'H2S Pro' });

    // onSaved() closes the form back to the listing once the update lands.
    expect(await screen.findByRole('button', { name: 'Add printer' }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();

    updateSpy.mockRestore();
  });

  it('disables the delete Confirm button while the delete mutation is pending, then closes the modal on success', async () => {
    let releaseDelete: (v: unknown) => void = () => {};
    const deferredDelete = new Promise<unknown>((resolve) => {
      releaseDelete = resolve;
    });
    const deleteSpy = vi.spyOn(api, 'deleteCalculatorPrinter').mockReturnValue(deferredDelete);
    server.use(http.get('/api/v1/calculator/printers/', () => HttpResponse.json([basePrinter])));

    render(<CalculatorPrintersPanel selectedPrinterId={null} canUpdate />);

    await userEvent.click(await screen.findByRole('button', { name: 'Delete printer' }));
    expect(await screen.findByText('Delete printer')).toBeInTheDocument();

    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmButton).toBeEnabled();
    await userEvent.click(confirmButton);

    // Mid-flight: the delete request is pending and unresolved. The same
    // element's accessible name changes ("Confirm" -> the loading label)
    // once isLoading flips, so this asserts on the captured node, not a
    // fresh name-based query.
    await waitFor(() => expect(confirmButton).toBeDisabled(), { timeout: 5000 });

    releaseDelete({ message: 'deleted' });

    // onDeleted() closes the modal once the delete lands.
    await waitFor(() => expect(screen.queryByText('Delete printer')).not.toBeInTheDocument(), { timeout: 5000 });

    deleteSpy.mockRestore();
  });
});

describe('CalculatorPrintersPanel permission gating (T-020)', () => {
  it('hides the add-printer control without calculator:update', async () => {
    server.use(http.get('/api/v1/calculator/printers/', () => HttpResponse.json([basePrinter])));

    render(<CalculatorPrintersPanel selectedPrinterId={null} canUpdate={false} />);

    expect(await screen.findByRole('cell', { name: /H2S/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add printer' })).not.toBeInTheDocument();
  });

  it('hides the edit and delete controls without calculator:update', async () => {
    server.use(http.get('/api/v1/calculator/printers/', () => HttpResponse.json([basePrinter])));

    render(<CalculatorPrintersPanel selectedPrinterId={null} canUpdate={false} />);

    await screen.findByRole('cell', { name: /H2S/ });
    expect(screen.queryByRole('button', { name: 'Edit printer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete printer' })).not.toBeInTheDocument();
  });

  it('keeps search still usable without calculator:update', async () => {
    const other: CalculatorPrinter = { ...basePrinter, id: 2, name: 'A1 Mini' };
    server.use(http.get('/api/v1/calculator/printers/', () => HttpResponse.json([basePrinter, other])));
    const user = userEvent.setup();

    render(<CalculatorPrintersPanel selectedPrinterId={null} canUpdate={false} />);

    await screen.findByRole('cell', { name: /H2S/ });
    await user.type(screen.getByLabelText('Search'), 'A1');

    expect(screen.getByRole('cell', { name: /A1 Mini/ })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: /H2S/ })).not.toBeInTheDocument();
  });
});
