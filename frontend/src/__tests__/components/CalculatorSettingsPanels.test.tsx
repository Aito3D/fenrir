/**
 * Tests for CalculatorSettingsPanels: filament/printer profile CRUD, the
 * delete-confirmation flow (confirm and cancel paths) and the global
 * defaults form. These panels render as tabs of CalculatorPage but are
 * exercised directly here — smaller surface, same behavior.
 *
 * Rendered with the default test auth context (auth disabled → effectively
 * full permissions), so these tests keep passing once T-020 gates the
 * add/edit/delete buttons behind calculator:update.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
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

    render(<CalculatorFilamentsPanel selectedFilamentId={null} />);

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

    render(<CalculatorFilamentsPanel selectedFilamentId={null} />);

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

    render(<CalculatorFilamentsPanel selectedFilamentId={null} />);

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

    render(<CalculatorFilamentsPanel selectedFilamentId={null} />);

    await user.click(await screen.findByRole('button', { name: 'Delete filament' }));
    expect(await screen.findByText('Delete filament')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Delete filament')).not.toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'PLA' })).toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();
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

    render(<CalculatorPrintersPanel selectedPrinterId={null} />);

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

    render(<CalculatorPrintersPanel selectedPrinterId={null} />);

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

    render(<CalculatorPrintersPanel selectedPrinterId={null} />);

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

    render(<CalculatorPrintersPanel selectedPrinterId={null} />);

    await user.click(await screen.findByRole('button', { name: 'Delete printer' }));
    expect(await screen.findByText('Delete printer')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Delete printer')).not.toBeInTheDocument();
    expect(screen.getByRole('cell', { name: /H2S/ })).toBeInTheDocument();
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

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

    render(<CalculatorDefaultsPanel />);

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
});
