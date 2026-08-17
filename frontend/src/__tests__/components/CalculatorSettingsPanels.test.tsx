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

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import type { CalculatorFilament, CalculatorPrinter, CalculatorDefaults } from '../../api/client';

const NOW = '2026-01-01T00:00:00Z';

const baseFilament: CalculatorFilament = {
  id: 1,
  name: 'Sunlu PLA',
  brand: 'Sunlu',
  material: 'PLA',
  cost_per_kg: 20,
  sale_price_per_kg: 30,
  difficulty_pct: 100,
  created_at: NOW,
  updated_at: NOW,
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
    // calculatorDefaults — cost auto-derives sale via the live margin sync.
    await user.type(screen.getByLabelText(/Cost per kg/), '25');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(postBody).toEqual({
        brand: 'Prusament',
        material: 'PETG',
        cost_per_kg: 25,
        // default_margin_over_cost_pct is 50% → 25 * 1.5
        sale_price_per_kg: 37.5,
        difficulty_pct: 100,
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
    // Form seeded from the existing filament: margin is pre-derived (50.0%)
    const cost = screen.getByLabelText(/Cost per kg/);
    expect(cost).toHaveValue(20);
    await user.clear(cost);
    await user.type(cost, '22');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(patchedId).toBe(1));
    expect(patchBody).toEqual({
      brand: 'Sunlu',
      material: 'PLA',
      cost_per_kg: 22,
      // Margin carried over from the existing filament (50.0%) → 22 * 1.5
      sale_price_per_kg: 33,
      difficulty_pct: 100,
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
