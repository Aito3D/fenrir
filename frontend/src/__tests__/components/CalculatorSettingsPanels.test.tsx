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
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useQueryClient } from '@tanstack/react-query';
import {
  CalculatorFilamentsPanel,
  CalculatorPrintersPanel,
  CalculatorDefaultsPanel,
} from '../../components/CalculatorSettingsPanels';
import { api } from '../../api/client';
import type {
  CalculatorFilament,
  CalculatorFilamentSyncResult,
  CalculatorPrinter,
  CalculatorDefaults,
  ZohoFilamentProduct,
} from '../../api/client';

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

    expect(await screen.findByRole('button', { name: '50 / 50' })).toBeInTheDocument();
    releaseLast(chunk({ processed: 3, total: 12, updated: 3 }));
    expect(await screen.findByText(/53 updated/)).toBeInTheDocument();
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

  it('labels the price column as printing cost', async () => {
    await renderFilamentsPanel();
    expect(await screen.findByRole('button', { name: /printing cost per kg/i })).toBeInTheDocument();
    expect(screen.queryByText('calculator.salePerKg')).toBeNull();
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

// Stands in for a background refetch of ['calculatorDefaults'] triggered
// elsewhere (another session's save, another tab, T-029's reality-check
// save) — invalidating the query without the DefaultsForm itself doing
// anything.
function InvalidateDefaultsButton() {
  const queryClient = useQueryClient();
  return (
    <button
      type="button"
      onClick={() => queryClient.invalidateQueries({ queryKey: ['calculatorDefaults'] })}
    >
      simulate background refetch
    </button>
  );
}

describe('CalculatorDefaultsPanel', () => {
  it('saves edited global defaults with the full payload', async () => {
    let patchBody: unknown = null;
    server.use(
      http.get('/api/v1/calculator/defaults', () => HttpResponse.json(baseDefaults)),
      http.patch('/api/v1/calculator/defaults', async ({ request }) => {
        patchBody = await request.json();
        return HttpResponse.json({ ...baseDefaults, ...(patchBody as object) });
      }),
    );
    const user = userEvent.setup();

    render(<CalculatorDefaultsPanel canUpdate />);

    const tariff = await screen.findByLabelText(/Electricity tariff/);
    expect(tariff).toHaveValue(120);
    await user.clear(tariff);
    await user.type(tariff, '150');

    await user.click(screen.getByRole('button', { name: 'Save defaults' }));

    await waitFor(() =>
      expect(patchBody).toEqual({
        electricity_tariff: 150,
        labor_rate_per_hour: 3000,
        consumables_packaging_flat: 30,
        base_fee_flat: 0,
        failure_rate_pct: 30,
        prototype_rate_pct: 30,
        ads_rate_pct: 5,
        filament_markup_pct: 5,
        global_markup_pct: 50,
        tax_pct: 13,
        stuff_markup_pct: 20,
        default_difficulty_pct: 100,
        default_margin_over_cost_pct: 50,
      }),
    );
    expect(await screen.findByText('Defaults saved')).toBeInTheDocument();
  });

  it('an untouched form follows a background refetch (T-031)', async () => {
    let current: CalculatorDefaults = baseDefaults;
    server.use(http.get('/api/v1/calculator/defaults', () => HttpResponse.json(current)));
    const user = userEvent.setup();

    render(
      <>
        <InvalidateDefaultsButton />
        <CalculatorDefaultsPanel canUpdate />
      </>,
    );

    const tariff = await screen.findByLabelText(/Electricity tariff/);
    expect(tariff).toHaveValue(120);

    // The underlying row changes elsewhere (another session's save) and
    // something invalidates the query — the operator never touched this form.
    current = { ...baseDefaults, electricity_tariff: 999, updated_at: '2026-01-02T00:00:00Z' };
    await user.click(screen.getByRole('button', { name: 'simulate background refetch' }));

    await waitFor(() => expect(tariff).toHaveValue(999));
  });

  it('a dirty form keeps the operator\'s typed values across a background refetch (T-031)', async () => {
    let current: CalculatorDefaults = baseDefaults;
    let fetchCount = 0;
    server.use(
      http.get('/api/v1/calculator/defaults', () => {
        fetchCount += 1;
        return HttpResponse.json(current);
      }),
    );
    const user = userEvent.setup();

    render(
      <>
        <InvalidateDefaultsButton />
        <CalculatorDefaultsPanel canUpdate />
      </>,
    );

    const tariff = await screen.findByLabelText(/Electricity tariff/);
    await user.clear(tariff);
    await user.type(tariff, '150');
    expect(tariff).toHaveValue(150);

    // Someone else's save changes the underlying row while this operator is
    // mid-edit. Confirm the refetch actually happened, then confirm the
    // typed value survived it instead of being clobbered.
    const fetchesBefore = fetchCount;
    current = { ...baseDefaults, electricity_tariff: 999, updated_at: '2026-01-02T00:00:00Z' };
    await user.click(screen.getByRole('button', { name: 'simulate background refetch' }));
    await waitFor(() => expect(fetchCount).toBeGreaterThan(fetchesBefore));

    expect(tariff).toHaveValue(150);
  });

  it('adopts the operator\'s own successful save and resumes following the server (T-031)', async () => {
    let current: CalculatorDefaults = baseDefaults;
    server.use(
      http.get('/api/v1/calculator/defaults', () => HttpResponse.json(current)),
      http.patch('/api/v1/calculator/defaults', async ({ request }) => {
        const body = (await request.json()) as Record<string, number>;
        current = { ...current, ...body };
        return HttpResponse.json(current);
      }),
    );
    const user = userEvent.setup();

    render(
      <>
        <InvalidateDefaultsButton />
        <CalculatorDefaultsPanel canUpdate />
      </>,
    );

    const tariff = await screen.findByLabelText(/Electricity tariff/);
    await user.clear(tariff);
    await user.type(tariff, '150');

    await user.click(screen.getByRole('button', { name: 'Save defaults' }));
    await screen.findByText('Defaults saved');

    // The form adopts its own save rather than looking perpetually dirty.
    expect(tariff).toHaveValue(150);

    // Now that it's clean again, the next background refetch (another
    // session's save) is followed just like a never-touched form.
    current = { ...current, electricity_tariff: 777, updated_at: '2026-01-02T00:00:00Z' };
    await user.click(screen.getByRole('button', { name: 'simulate background refetch' }));

    await waitFor(() => expect(tariff).toHaveValue(777));
  });
});

describe('CalculatorDefaultsPanel permission gating (T-020)', () => {
  it('hides the Save control without calculator:update, while the values stay visible', async () => {
    server.use(http.get('/api/v1/calculator/defaults', () => HttpResponse.json(baseDefaults)));

    render(<CalculatorDefaultsPanel canUpdate={false} />);

    // The read-only view of the values is unaffected...
    const tariff = await screen.findByLabelText(/Electricity tariff/);
    expect(tariff).toHaveValue(120);
    // ...only the write control is gone.
    expect(screen.queryByRole('button', { name: 'Save defaults' })).not.toBeInTheDocument();
  });

  it('does not call the update API without calculator:update, even if the form were submitted', async () => {
    let patchCalled = false;
    server.use(
      http.get('/api/v1/calculator/defaults', () => HttpResponse.json(baseDefaults)),
      http.patch('/api/v1/calculator/defaults', () => {
        patchCalled = true;
        return HttpResponse.json(baseDefaults);
      }),
    );

    const { container } = render(<CalculatorDefaultsPanel canUpdate={false} />);
    await screen.findByLabelText(/Electricity tariff/);

    // Defense in depth: submitting the underlying <form> directly (e.g. an
    // Enter keypress) must not reach the mutation when the Save control that
    // normally guards it isn't rendered.
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(patchCalled).toBe(false);
  });
});
