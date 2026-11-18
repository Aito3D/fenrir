import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { Import3mfPanel } from '../../components/aito/Import3mfPanel';
import type { Aito3mfImportState, Aito3mfPlate } from '../../api/client';

const stamps = { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
const filament = (id: number, brand: string, material: string) => ({
  id, name: `${brand} ${material}`, brand, material, cost_per_kg: 3000, sale_price_per_kg: 6000, margin_pct: 50,
  difficulty_pct: 100, zoho_item_id: null, zoho_item_name: null, zoho_sku: null, spool_weight_kg: null,
  zoho_synced_at: null, ...stamps,
});
const FILAMENTS = [filament(10, 'SUNLU', 'PETG'), filament(11, 'Polymaker', 'PETG'), filament(12, 'Bambu Lab', 'PLA')];
const PRINTERS = [
  { id: 1, name: 'X1C', purchase_price: 300000, lifetime_years: 5, daily_usage_hours: 8, power_watts: 150, repair_rate_pct: 5, ...stamps },
];
const DEFAULTS = {
  id: 1, electricity_tariff: 30, labor_rate_per_hour: 3000, consumables_packaging_flat: 500, failure_rate_pct: 5,
  prototype_rate_pct: 5, ads_rate_pct: 3, filament_markup_pct: 50, global_markup_pct: 30, tax_pct: 0,
  default_difficulty_pct: 100, default_margin_over_cost_pct: 50, stuff_markup_pct: 20, base_fee_flat: 2000,
  updated_at: stamps.updated_at,
};

const plate = (over: Partial<Aito3mfPlate>): Aito3mfPlate => ({
  index: 1, name: 'Marteaux', print_time_seconds: 21955, weight_g: 76.62, printer_model: 'X1C',
  filaments: [{ type: 'PLA', color: '#FFFFFF', used_g: 76.62, vendor: 'Bambu Lab' }],
  objects: [{ name: 'marteau', count: 2, x_mm: 120, y_mm: 30, z_mm: 50 }], thumbnail: null, ...over,
});
const AMBIGUOUS = plate({
  index: 2, name: 'Manches',
  filaments: [
    { type: 'PETG', color: '#000000', used_g: 40, vendor: 'Generic' },
    { type: 'PLA', color: '#FFFFFF', used_g: 1.2, vendor: 'Bambu Lab' },
  ],
});
const EMPTY = plate({ index: 3, name: null, print_time_seconds: null, weight_g: null, filaments: [], objects: [] });
const done = (plates: Aito3mfPlate[]): Aito3mfImportState => ({
  status: 'completed', percent: 100, filename: 'Outils.3mf', plates, error: null,
});
const running: Aito3mfImportState = { status: 'running', percent: 40, filename: 'Outils.3mf', plates: null, error: null };

let polls = 0;
/** Serves `states` in order to successive polls, repeating the last one. */
function serve(states: Aito3mfImportState[]) {
  polls = 0;
  server.use(
    http.post('/api/v1/aito/import-3mf', () => HttpResponse.json({ job_id: 7 }, { status: 202 })),
    http.get('/api/v1/aito/import-3mf/7', () => HttpResponse.json(states[Math.min(polls++, states.length - 1)])),
  );
}

beforeEach(() => {
  server.use(
    http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(FILAMENTS)),
    http.get('/api/v1/calculator/printers/', () => HttpResponse.json(PRINTERS)),
    http.get('/api/v1/calculator/defaults', () => HttpResponse.json(DEFAULTS)),
  );
});

function mount() {
  const onAdd = vi.fn();
  const onClose = vi.fn();
  const file = new File(['x'], 'Outils.3mf');
  const view = render(<Import3mfPanel file={file} onAdd={onAdd} onClose={onClose} pollMs={20} />);
  return { ...view, onAdd, onClose };
}
const addButton = () => screen.getByRole('button', { name: /^Add \d+ tasks?$/ });

describe('Import3mfPanel', () => {
  it('shows progress while the job runs, then the plates', async () => {
    serve([running, done([plate({})])]);
    mount();
    // Indeterminate until the first poll answers.
    await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40'));
    expect(await screen.findByText('Marteaux')).toBeInTheDocument();
    expect(screen.getByText('2 x marteau [120x30x50mm]')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('ticks importable plates and disables an empty one', async () => {
    serve([done([plate({}), EMPTY])]);
    mount();
    await screen.findByText('Marteaux');
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();
    expect(boxes[1]).toBeDisabled();
    expect(screen.getByText('Plate 3')).toBeInTheDocument();
  });

  it('keeps Add disabled until an ambiguous filament is chosen, then adds priced drafts', async () => {
    serve([done([plate({}), AMBIGUOUS])]);
    const { onAdd, onClose } = mount();
    await screen.findByText('Manches');
    expect(addButton()).toBeDisabled();
    expect(screen.getByText(/\+1 other filament/)).toBeInTheDocument();
    const picker = screen.getByRole('combobox', { name: /Choose a filament/ });
    // Only the material matches are offered.
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Choose a filament', 'SUNLU PETG', 'Polymaker PETG',
    ]);
    await userEvent.selectOptions(picker, '11');
    await waitFor(() => expect(addButton()).toBeEnabled());
    await userEvent.click(addButton());
    expect(onAdd).toHaveBeenCalledTimes(1);
    const drafts = onAdd.mock.calls[0][0];
    expect(drafts.map((d: { title: string }) => d.title)).toEqual(['Marteaux', 'Manches']);
    expect(drafts[1].impression.filamentId).toBe(11);
    expect(drafts[1].impression.weightG).toBe(76.62);
    expect(drafts.every((d: { impressionCost: number | null }) => d.impressionCost !== null)).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('adds only ticked plates', async () => {
    serve([done([plate({}), plate({ index: 2, name: 'Embouts' })])]);
    const { onAdd } = mount();
    await screen.findByText('Embouts');
    await userEvent.click(screen.getAllByRole('checkbox')[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Add 1 task' }));
    expect(onAdd.mock.calls[0][0].map((d: { title: string }) => d.title)).toEqual(['Embouts']);
  });

  it('shows the server message and retries on failure', async () => {
    serve([{ status: 'failed', percent: null, filename: 'Outils.3mf', plates: null, error: 'No slicer is configured in Settings' }]);
    mount();
    expect(await screen.findByText('No slicer is configured in Settings')).toBeInTheDocument();
    serve([done([plate({})])]);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Marteaux')).toBeInTheDocument();
  });

  it('shows an error with Retry when a calculator list cannot load, and Retry reloads it without slicing again', async () => {
    serve([done([plate({})])]);
    let printerCalls = 0;
    server.use(
      http.get('/api/v1/calculator/printers/', () =>
        ++printerCalls === 1 ? HttpResponse.json({ detail: 'Printers unavailable' }, { status: 500 }) : HttpResponse.json(PRINTERS),
      ),
    );
    let uploads = 0;
    server.use(http.post('/api/v1/aito/import-3mf', () => (uploads++, HttpResponse.json({ job_id: 7 }, { status: 202 }))));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Printers unavailable');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Marteaux')).toBeInTheDocument();
    expect(uploads).toBe(1);
  });

  it('rides out a failed poll without uploading again', async () => {
    let uploads = 0;
    let calls = 0;
    server.use(
      http.post('/api/v1/aito/import-3mf', () => HttpResponse.json({ job_id: ++uploads + 6 }, { status: 202 })),
      http.get('/api/v1/aito/import-3mf/7', () =>
        ++calls === 1 ? HttpResponse.json({ detail: 'tunnel hiccup' }, { status: 502 }) : HttpResponse.json(done([plate({})])),
      ),
    );
    mount();
    expect(await screen.findByText('Marteaux')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(uploads).toBe(1);
  });

  it('Retry after lost polls asks the same job again instead of slicing twice', async () => {
    let uploads = 0;
    let down = true;
    server.use(
      http.post('/api/v1/aito/import-3mf', () => HttpResponse.json({ job_id: ++uploads + 6 }, { status: 202 })),
      http.get('/api/v1/aito/import-3mf/7', () =>
        down ? HttpResponse.json({ detail: 'tunnel down' }, { status: 502 }) : HttpResponse.json(done([plate({})])),
      ),
    );
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('tunnel down');
    down = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Marteaux')).toBeInTheDocument();
    expect(uploads).toBe(1);
  });

  it('Retry after the server forgot the job uploads and slices the file again', async () => {
    let uploads = 0;
    server.use(
      http.post('/api/v1/aito/import-3mf', () => HttpResponse.json({ job_id: ++uploads + 6 }, { status: 202 })),
      http.get('/api/v1/aito/import-3mf/7', () =>
        HttpResponse.json({ detail: 'Import not found or expired' }, { status: 404 }),
      ),
      http.get('/api/v1/aito/import-3mf/8', () => HttpResponse.json(done([plate({})]))),
    );
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Import not found or expired');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Marteaux')).toBeInTheDocument();
    expect(uploads).toBe(2);
  });

  it('shows a refusal of the upload itself', async () => {
    server.use(
      http.post('/api/v1/aito/import-3mf', () =>
        HttpResponse.json({ detail: 'This file is already sliced; import the Bambu Studio project .3mf.' }, { status: 400 }),
      ),
    );
    mount();
    expect(await screen.findByText(/already sliced/)).toBeInTheDocument();
  });

  it('stops polling and adds nothing after unmount', async () => {
    serve([running]);
    const { unmount, onAdd } = mount();
    await screen.findByRole('progressbar');
    await waitFor(() => expect(polls).toBeGreaterThan(1));
    unmount();
    const seen = polls;
    await new Promise((r) => setTimeout(r, 120));
    expect(polls).toBeLessThanOrEqual(seen + 1); // at most the request already in flight
    expect(onAdd).not.toHaveBeenCalled();
  });

  describe('cancelling an abandoned import (T-685)', () => {
    let cancelled: number[] = [];
    beforeEach(() => {
      cancelled = [];
      server.use(
        http.delete('/api/v1/aito/import-3mf/:id', ({ params }) => {
          cancelled.push(Number(params.id));
          return new HttpResponse(null, { status: 204 });
        }),
      );
    });

    it('cancels the running job on unmount', async () => {
      serve([running]);
      const { unmount } = mount();
      await screen.findByRole('progressbar');
      await waitFor(() => expect(polls).toBeGreaterThan(0));
      unmount();
      await waitFor(() => expect(cancelled).toEqual([7]));
    });

    it('cancels a job whose upload finished after the panel was closed', async () => {
      server.use(
        http.post('/api/v1/aito/import-3mf', async () => {
          await new Promise((r) => setTimeout(r, 60));
          return HttpResponse.json({ job_id: 7 }, { status: 202 });
        }),
      );
      const { unmount } = mount();
      unmount();
      await waitFor(() => expect(cancelled).toEqual([7]));
    });

    it('does not cancel a job that already finished', async () => {
      serve([done([plate({})])]);
      const { unmount } = mount();
      await screen.findByText('Marteaux');
      unmount();
      await new Promise((r) => setTimeout(r, 80));
      expect(cancelled).toEqual([]);
    });

    it('cancels the previous job when Retry uploads again, and ignores a failing cancel', async () => {
      let uploads = 0;
      server.use(
        http.post('/api/v1/aito/import-3mf', () => HttpResponse.json({ job_id: ++uploads + 6 }, { status: 202 })),
        http.get('/api/v1/aito/import-3mf/7', () =>
          HttpResponse.json({ detail: 'Import not found or expired' }, { status: 404 }),
        ),
        http.get('/api/v1/aito/import-3mf/8', () => HttpResponse.json(done([plate({})]))),
        http.delete('/api/v1/aito/import-3mf/7', () => {
          cancelled.push(7);
          return HttpResponse.json({ detail: 'Import not found or expired' }, { status: 404 });
        }),
      );
      mount();
      await screen.findByRole('alert');
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText('Marteaux')).toBeInTheDocument();
      expect(cancelled).toEqual([7]);
    });
  });
});
