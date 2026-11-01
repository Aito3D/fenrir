/** The Printing panel's item card (layout D): the shown revision's facts, its server slice state,
 *  the icon actions (no Re-slice), Open in slicer on the source file, and the details tray. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../../../utils';
import { server } from '../../../mocks/server';
import { ItemCard } from '../../../../components/projects/files/ItemCard';
import { useFileActions } from '../../../../components/projects/files/useFileActions';
import type { ProjectItemOut } from '../../../../api/client';
import { openInSlicer } from '../../../../utils/slicer';
import { file, item, rev } from '../../../fixtures/projectTree';

vi.mock('../../../../utils/slicer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../utils/slicer')>()),
  openInSlicer: vi.fn(),
}));
vi.mock('../../../../components/projects/print/PrintRevisionFlow', () => ({
  PrintRevisionFlow: ({ file: f }: { file: { filename: string } }) => <div data-testid="print-flow">{f.filename}</div>,
}));

// null = real AuthProvider (auth disabled: every permission granted).
let granted: Set<string> | null = null;
vi.mock('../../../../contexts/AuthContext', async (importOriginal) => {
  const { withGrantedPermissions } = await import('../../../fixtures/authPermissions');
  return withGrantedPermissions(await importOriginal<typeof import('../../../../contexts/AuthContext')>(), () => granted);
});

const profile = { printer_model: 'X1C', nozzle_diameter: '0.4', layer_height: '0.2', filament_types: ['PETG'] };
const sliced = file(90, 'bracket.gcode.3mf', {
  file_type: 'gcode.3mf', print_time_seconds: 8040, filament_used_grams: 38.4, filament_type: 'PETG',
  filament_color: '#ff0000', sliced_for_model: 'X1C', total_layers: 320, layer_height: 0.2, object_count: 2,
});
const calcFilaments = [{ id: 1, name: 'PETG basique', brand: '', material: 'PETG', cost_per_kg: 3731, sale_price_per_kg: 5596.5, margin_pct: 50, difficulty_pct: 150 }];
const calcPrinters = [{ id: 1, name: 'X1C', purchase_price: 347000, lifetime_years: 2, daily_usage_hours: 5, power_watts: 400, repair_rate_pct: 30 }];
const calcDefaults = { id: 1, electricity_tariff: 120, labor_rate_per_hour: 3000, consumables_packaging_flat: 30, failure_rate_pct: 30, prototype_rate_pct: 30,
  ads_rate_pct: 5, filament_markup_pct: 5, global_markup_pct: 50, tax_pct: 13, default_difficulty_pct: 100, default_margin_over_cost_pct: 50, stuff_markup_pct: 20 };
const bracket = (r2: Partial<Parameters<typeof rev>[0]> = {}): ProjectItemOut =>
  item(20, 'impression', 'Bracket', [
    rev({
      id: 2, number: 2, status: 'valide', print_profile: profile,
      files: [file(51, 'bracket.3mf', { file_type: '3mf', file_size: 3 * 1024 * 1024 })],
      slice_status: 'sliced', sliced_file: sliced, ...r2,
    }),
    rev({ id: 1, number: 1, status: 'obsolete', used: true, print_profile: { ...profile, layer_height: '0.28' },
      files: [file(50, 'bracket-old.3mf', { file_type: '3mf', file_size: 1024 })] }),
  ]);

function Harness({ value }: { value: ProjectItemOut }) {
  const actions = useFileActions(7);
  const [open, setOpen] = useState(false);
  return (
    <ul>
      <ItemCard item={value} actions={actions} open={open} onToggleDetails={() => setOpen((o) => !o)} />
    </ul>
  );
}

let calls: string[];
beforeEach(() => {
  calls = [];
  granted = null;
  vi.mocked(openInSlicer).mockClear();
  server.use(
    http.get('/api/v1/projects/7/tree', () => HttpResponse.json({ project_id: 7, code: 'P-0007', sections: [] })),
    http.post('/api/v1/projects/revisions/:id/slice', ({ params }) => {
      calls.push(`slice:${params.id}`);
      return HttpResponse.json({ job_id: 12, slice_status: 'slicing' }, { status: 202 });
    }),
    http.post('/api/v1/library/files/:id/slicer-token', ({ params }) => {
      calls.push(`token:${params.id}`);
      return HttpResponse.json({ token: 'tok' });
    }),
  );
});

const card = () => screen.getByTestId('item-card-20');

describe('ItemCard', () => {
  it('shows the newest revision: selected chip, name, status, headline facts, profile line and a slice glyph', () => {
    render(<Harness value={bracket()} />);
    expect(within(card()).getByRole('button', { name: 'R2' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(card()).getByRole('button', { name: 'R1' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(card()).getByText('Bracket')).toBeInTheDocument();
    expect(within(card()).getByText('Approved')).toBeInTheDocument();
    expect(within(card()).getByText('3.0 MB')).toBeInTheDocument();
    expect(within(card()).getByText('2h 14m')).toBeInTheDocument();
    expect(within(card()).getByText('38.4 g')).toBeInTheDocument();
    expect(within(card()).getByText('X1C · 0.4 mm · 0.2 mm · PETG')).toBeInTheDocument();
    // The slice state is a glyph on the picture, not a line of words.
    expect(within(card()).getByLabelText('Sliced')).toHaveAttribute('data-state', 'sliced');
    expect(within(card()).queryByText('Sliced', { ignore: '[role="tooltip"]' })).not.toBeInTheDocument();
    expect(within(card()).queryByText('Older revision')).not.toBeInTheDocument();
  });

  it('shows the live percent of a slicing revision as a progress bar', async () => {
    server.use(
      http.get('/api/v1/slice-jobs/12', () =>
        HttpResponse.json({
          job_id: 12, status: 'running', kind: 'project_revision', source_id: 2, source_name: 'bracket.3mf',
          created_at: '2026-10-17T10:00:00Z', started_at: null, completed_at: null,
          progress: { stage: 'Generating G-code', total_percent: 62.2, plate_percent: 0, plate_index: 1, plate_count: 1, updated_at: 0 },
        }),
      ),
    );
    render(<Harness value={bracket({ slice_status: 'slicing', slice_job_id: 12, sliced_file: null })} />);
    const bar = within(card()).getByRole('progressbar');
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '62'));
    // Progress is a transform, not a width: no layout pass per update.
    expect((bar.firstElementChild as HTMLElement).style.transform).toBe('scaleX(0.62)');
    expect(within(card()).getByText('Slicing…')).toBeInTheDocument();
    expect(within(card()).getByText('62%')).toBeInTheDocument();
  });

  it('shows a failed slice with its error, and Retry posts the slice', async () => {
    render(<Harness value={bracket({ slice_status: 'failed', slice_error: 'Plate 2 is empty', sliced_file: null })} />);
    expect(within(card()).getByText('Slice failed: Plate 2 is empty', { ignore: '[role="tooltip"]' })).toBeInTheDocument();
    await userEvent.click(within(card()).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls).toEqual(['slice:2']));
  });

  it('a failed slice also offers "Upload sliced file", which opens the hand-slice dialog', async () => {
    render(<Harness value={bracket({ slice_status: 'failed', slice_error: 'Slicer sidecar unreachable', sliced_file: null })} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'Upload sliced file' }));
    expect(await screen.findByRole('dialog', { name: 'Upload the sliced file' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls).toEqual([]);
  });

  it('a sliced or never-sliced revision has no "Upload sliced file"', () => {
    render(<Harness value={bracket()} />);
    expect(within(card()).queryByRole('button', { name: 'Upload sliced file' })).not.toBeInTheDocument();
  });

  it("shows the sliced file's facts like the archive card: layers, objects, material, colour", () => {
    render(<Harness value={bracket()} />);
    expect(within(card()).getByTestId('print-facts-layers')).toHaveTextContent('320 layers');
    expect(within(card()).getByTestId('print-facts-objects')).toHaveTextContent('2 objects');
    // The material is named once, in the profile line; the facts add only its colours.
    expect(within(card()).getByTestId('print-facts-material').querySelector('[title="#ff0000"]')).not.toBeNull();
    // No calculator configured: no cost rows.
    expect(within(card()).queryByTestId('print-facts-price')).not.toBeInTheDocument();
  });

  it('adds the calculator machine cost and suggested price (no energy row) once the calculator is set up', async () => {
    server.use(
      http.get('/api/v1/calculator/filaments/', () => HttpResponse.json(calcFilaments)),
      http.get('/api/v1/calculator/printers/', () => HttpResponse.json(calcPrinters)),
      http.get('/api/v1/calculator/defaults', () => HttpResponse.json(calcDefaults)),
    );
    render(<Harness value={bracket()} />);
    const price = await within(card()).findByTestId('print-facts-price');
    expect(price.textContent).toMatch(/\d/);
    expect(within(card()).getByTestId('print-facts-machine-cost').textContent).toMatch(/\d/);
    expect(within(card()).queryByTestId('print-facts-energy-cost')).not.toBeInTheDocument();
  });

  it('an unsliced revision shows no facts rows', () => {
    render(<Harness value={bracket({ slice_status: null, sliced_file: null })} />);
    expect(within(card()).queryByTestId('print-facts')).not.toBeInTheDocument();
  });

  it('holding the status chip for 0.5 s opens the status picker; a pick saves it', async () => {
    server.use(
      http.patch('/api/v1/projects/revisions/:id', async ({ params, request }) => {
        calls.push(`status:${params.id}:${((await request.json()) as { status: string }).status}`);
        return HttpResponse.json({});
      }),
    );
    vi.useFakeTimers();
    try {
      render(<Harness value={bracket()} />);
      const chip = within(card()).getByRole('button', { name: 'Status' });
      expect(chip).toHaveTextContent('Approved');
      fireEvent.pointerDown(chip);
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(screen.queryByText('In progress')).not.toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(screen.getByText('In progress')).toBeInTheDocument();
      expect(screen.getByText('Obsolete')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
    fireEvent.click(screen.getByText('In progress'));
    await waitFor(() => expect(calls).toEqual(['status:2:wip']));
  });

  it('shows a slicing revision whose job already failed as failed, before the tree catches up', async () => {
    server.use(
      http.get('/api/v1/slice-jobs/12', () =>
        HttpResponse.json({
          job_id: 12, status: 'failed', kind: 'project_revision', source_id: 2, source_name: 'bracket.3mf',
          created_at: '2026-10-17T10:00:00Z', started_at: null, completed_at: null, progress: null,
        }),
      ),
    );
    render(
      <Harness value={bracket({ slice_status: 'slicing', slice_job_id: 12, slice_error: 'Plate 2 is empty', sliced_file: null })} />,
    );
    expect(await within(card()).findByText('Slice failed: Plate 2 is empty', { ignore: '[role="tooltip"]' })).toBeInTheDocument();
    expect(within(card()).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(card()).queryByRole('progressbar')).not.toBeInTheDocument();
    expect(within(card()).queryByText('Slicing…')).not.toBeInTheDocument();
  });

  it('shows an indeterminate bar for a slicing revision whose job is unknown', async () => {
    server.use(http.get('/api/v1/slice-jobs/12', () => HttpResponse.json({ detail: 'gone' }, { status: 404 })));
    render(<Harness value={bracket({ slice_status: 'slicing', slice_job_id: 12, sliced_file: null })} />);
    const bar = within(card()).getByRole('progressbar');
    expect(within(card()).getByText('Slicing…', { ignore: '[role="tooltip"]' })).toBeInTheDocument();
    // Let the job lookup settle: a 404 stays indeterminate.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(within(card()).queryByText(/%/)).not.toBeInTheDocument();
  });

  it('a legacy sliced revision (no server slice state) reads as sliced', () => {
    render(<Harness value={bracket({ slice_status: null, sliced_file: null, print_profile: { ...profile, sliced: true } })} />);
    expect(within(card()).getByLabelText('Sliced')).toHaveAttribute('data-state', 'legacy-sliced');
  });

  it('picking an older chip switches the card to that revision and dims it', async () => {
    render(<Harness value={bracket()} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'R1' }));
    expect(within(card()).getByRole('button', { name: 'R1' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(card()).getByText('Older revision')).toBeInTheDocument();
    expect(within(card()).getByText('X1C · 0.4 mm · 0.28 mm · PETG')).toBeInTheDocument();
    expect(within(card()).getByText('Obsolete')).toBeInTheDocument();
    expect(within(card()).getByText('Not sliced', { ignore: '[role="tooltip"]' })).toBeInTheDocument();
    expect(within(card()).getByLabelText('Not sliced')).toHaveAttribute('data-state', 'none');
    expect(screen.getByTestId('card-thumb-20').className).toContain('opacity-40');
  });

  it('has the icon actions with accessible names, each with a tooltip, and no Re-slice', () => {
    render(<Harness value={bracket()} />);
    const tips = within(card()).getAllByRole('tooltip').map((tip) => tip.textContent);
    for (const name of ['Print', 'Open in slicer', 'Preview', 'Download', 'More actions', 'New revision', 'R2 · Approved', 'R1 · Obsolete', 'Sliced']) {
      expect(tips).toContain(name);
    }
    for (const name of ['Print', 'Open in slicer', 'Preview', 'Download', 'More actions']) {
      const button = within(card()).getByRole('button', { name });
      expect(button).not.toHaveAttribute('title');
      // 44px touch targets below md, the panel's 32px-class icon buttons from md up.
      for (const cls of ['h-[44px]', 'min-w-[44px]', 'md:h-8', 'md:min-w-8']) expect(button.className.split(' ')).toContain(cls);
    }
    // One row: the five buttons never wrap.
    const row = within(card()).getByRole('button', { name: 'Print' }).closest('.ml-auto')!;
    expect(row.className.split(' ')).toContain('flex-nowrap');
    expect(row.className).not.toContain('flex-wrap ');
    expect(screen.queryByRole('button', { name: /Re-slice/ })).not.toBeInTheDocument();
  });

  it('Print opens the print flow with the source file', async () => {
    render(<Harness value={bracket()} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'Print' }));
    expect(screen.getByTestId('print-flow')).toHaveTextContent('bracket.3mf');
  });

  it('Open in slicer hands the source file to the desktop slicer', async () => {
    render(<Harness value={bracket()} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'Open in slicer' }));
    await waitFor(() => expect(openInSlicer).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(['token:51']);
    const [url, slicer] = vi.mocked(openInSlicer).mock.calls[0];
    expect(url).toBe(`${window.location.origin}/api/v1/library/files/51/dl/tok/bracket.3mf`);
    expect(slicer).toBe('bambu_studio');
  });

  it('Open in slicer follows the desktop slicer setting', async () => {
    server.use(http.get('/api/v1/settings/', () => HttpResponse.json({ open_in_slicer: 'orcaslicer', preferred_slicer: 'bambu_studio' })));
    render(<Harness value={bracket()} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'Open in slicer' }));
    await waitFor(() => expect(openInSlicer).toHaveBeenCalledTimes(1));
    expect(vi.mocked(openInSlicer).mock.calls[0][1]).toBe('orcaslicer');
  });

  it('Open in slicer still opens the default desktop slicer when the settings cannot be read', async () => {
    server.use(http.get('/api/v1/settings/', () => HttpResponse.json({ detail: 'down' }, { status: 500 })));
    render(<Harness value={bracket()} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'Open in slicer' }));
    await waitFor(() => expect(openInSlicer).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(['token:51']);
    const [url, slicer] = vi.mocked(openInSlicer).mock.calls[0];
    expect(url).toBe(`${window.location.origin}/api/v1/library/files/51/dl/tok/bracket.3mf`);
    expect(slicer).toBe('bambu_studio');
  });

  it('Open in slicer toasts a refused token and falls back to the plain download URL', async () => {
    server.use(http.post('/api/v1/library/files/:id/slicer-token', () => HttpResponse.json({ detail: 'no' }, { status: 403 })));
    render(<Harness value={bracket()} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'Open in slicer' }));
    expect(await screen.findByText('Could not open in slicer')).toBeInTheDocument();
    expect(vi.mocked(openInSlicer).mock.calls[0][0]).toBe(`${window.location.origin}/api/v1/library/files/51/download`);
  });

  it('a legacy sliced revision prints its own sliced file, and opens nothing in the slicer without a source', async () => {
    render(<Harness value={item(20, 'impression', 'Bracket', [rev({
      id: 2, number: 1, print_profile: { ...profile, sliced: true },
      files: [file(60, 'bracket.gcode.3mf', { file_type: 'gcode.3mf' })],
    })])} />);
    expect(within(card()).queryByRole('button', { name: 'Open in slicer' })).not.toBeInTheDocument();
    await userEvent.click(within(card()).getByRole('button', { name: 'Print' }));
    expect(screen.getByTestId('print-flow')).toHaveTextContent('bracket.gcode.3mf');
  });

  it('the ⋯ menu slices an unsliced revision', async () => {
    render(<Harness value={bracket({ slice_status: null, sliced_file: null })} />);
    // "Not sliced yet" offers Slice inline too; this is the menu's entry.
    expect(within(card()).getByRole('button', { name: 'Slice' })).toBeInTheDocument();
    await userEvent.click(within(card()).getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('button', { name: 'Download sliced file' })).not.toBeInTheDocument();
    const inMenu = screen.getAllByRole('button', { name: 'Slice' }).find((b) => !card().contains(b))!;
    await userEvent.click(inMenu);
    await waitFor(() => expect(calls).toEqual(['slice:2']));
  });

  it('the ⋯ menu offers the sliced file once sliced, and no Slice', async () => {
    render(<Harness value={bracket()} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('button', { name: 'Download sliced file' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Slice' })).not.toBeInTheDocument();
    for (const name of ['Details', 'Rename', 'Fork as new item']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('shows how many times the file was printed, and the count opens its print history', async () => {
    server.use(
      // Print sends the source .3mf, so its history is the one the count opens.
      http.get('/api/v1/library/files/51/history', () =>
        HttpResponse.json({ file_id: 51, filename: 'bracket.3mf', added_at: '2026-10-01T00:00:00Z', added_by_username: null, source_type: null,
          source_url: null, history_available: true, total_prints: 3, success_count: 3, total_filament_grams: null, last_printed_at: null, events: [] }),
      ),
    );
    render(<Harness value={bracket({ sliced_file: { ...sliced, print_count: 3 } })} />);
    const count = within(card()).getByRole('button', { name: 'View print history' });
    expect(count).toHaveTextContent('3×');
    await userEvent.click(count);
    expect(await screen.findByRole('heading', { name: 'History — bracket.3mf' })).toBeInTheDocument();
  });

  it('shows no printed line for a file never printed', () => {
    render(<Harness value={bracket()} />);
    expect(within(card()).queryByRole('button', { name: 'View print history' })).not.toBeInTheDocument();
    expect(within(card()).queryByText(/×$/)).not.toBeInTheDocument();
  });

  it('the ⋯ menu carries the File Manager entries, without Move to project, Print, Preview or Download', async () => {
    render(<Harness value={bracket()} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'More actions' }));
    for (const name of ['Open in calculator', 'History', 'Tags', 'File details', 'Delete']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /Move to project/ })).not.toBeInTheDocument();
    // Print, Preview and Download are the card's icons, once each — not menu entries too.
    for (const name of ['Print', 'Preview', 'Download']) expect(screen.getAllByRole('button', { name })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Open in calculator' }));
    expect(window.location.pathname).toBe('/calculator');
    expect(window.location.search).toContain('weight=38.4');
  });

  it('Tags opens the picker seeded with the file\'s tags', async () => {
    server.use(
      http.get('/api/v1/library/tags', () =>
        HttpResponse.json([{ id: 5, name: 'kid-safe', file_count: 2, created_at: '', updated_at: '' }, { id: 6, name: 'toys', file_count: 1, created_at: '', updated_at: '' }]),
      ),
    );
    render(<Harness value={bracket({ files: [file(51, 'bracket.3mf', { file_type: '3mf', tag_ids: [5] })] })} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('button', { name: 'Tags' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('checkbox', { name: /kid-safe/ })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /toys/ })).not.toBeChecked();
  });

  it('File details fetches the library file and opens the details modal', async () => {
    server.use(
      http.get('/api/v1/library/files/51', () =>
        HttpResponse.json({ id: 51, folder_id: null, folder_name: null, project_id: 7, project_name: null, is_external: false, filename: 'bracket.3mf',
          file_path: 'p/bracket.3mf', file_type: '3mf', file_size: 3145728, file_hash: null, thumbnail_path: null, metadata: null, print_count: 0,
          last_printed_at: null, notes: null, external_url: null, photos: [], source_url: null, duplicates: null, duplicate_count: 0, created_by_id: null,
          created_by_username: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', print_name: null, print_time_seconds: null,
          filament_used_grams: null, filament_type: null, sliced_for_model: null, filament_color: null, filament_vendor: null, total_layers: null,
          layer_height: null, object_count: null }),
      ),
    );
    render(<Harness value={bracket()} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('button', { name: 'File details' }));
    expect(await screen.findByRole('heading', { name: 'bracket.3mf' })).toBeInTheDocument();
    expect(screen.getByText('File details')).toBeInTheDocument();
  });

  it('Delete asks first, then deletes the item', async () => {
    server.use(
      http.delete('/api/v1/projects/items/20', () => {
        calls.push('delete:20');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    render(<Harness value={bracket()} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(calls).toEqual([]);
    expect(screen.getByText(/Delete “Bracket” with its revisions and files\?/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls).toEqual(['delete:20']));
  });

  it('Details opens the tray with the revision status select and hold-to-delete item', async () => {
    render(<Harness value={bracket()} />);
    expect(screen.queryByTestId('item-tray-20')).not.toBeInTheDocument();
    await userEvent.click(within(card()).getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    const tray = screen.getByTestId('item-tray-20');
    expect(tray.className).toContain('col-span-full');
    expect(within(within(tray).getByTestId('revision-2')).getByLabelText('Status')).toHaveValue('valide');
    expect(within(tray).getByRole('button', { name: 'Delete item' })).toBeInTheDocument();
    // The tray follows the picked chip.
    await userEvent.click(within(card()).getByRole('button', { name: 'R1' }));
    expect(within(tray).getByTestId('revision-1')).toBeInTheDocument();
  });
  it('after uploading a new revision from the card, shows the newest revision again', async () => {
    server.use(
      http.post('/api/v1/projects/items/20/revisions', () => {
        calls.push('upload:20');
        return HttpResponse.json(
          { revision: rev({ id: 3, number: 3, files: [file(52, 'bracket-v3.3mf', { file_type: '3mf' })] }), warnings: [] },
          { status: 201 },
        );
      }),
    );
    render(<Harness value={bracket()} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'R1' }));
    expect(within(card()).getByRole('button', { name: 'R1' })).toHaveAttribute('aria-pressed', 'true');

    await userEvent.upload(screen.getByTestId('new-revision-input-20'), new File(['x'], 'bracket-v3.3mf'));
    await waitFor(() => expect(calls).toContain('upload:20'));
    await waitFor(() => expect(within(card()).getByRole('button', { name: 'R2' })).toHaveAttribute('aria-pressed', 'true'));
    expect(within(card()).getByRole('button', { name: 'R1' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('a failed upload keeps the picked revision', async () => {
    server.use(
      http.post('/api/v1/projects/items/20/revisions', () => {
        calls.push('upload:20');
        return HttpResponse.json({ detail: 'nope' }, { status: 400 });
      }),
    );
    render(<Harness value={bracket()} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'R1' }));
    await userEvent.upload(screen.getByTestId('new-revision-input-20'), new File(['x'], 'bracket-v3.3mf'));
    await waitFor(() => expect(calls).toContain('upload:20'));
    await waitFor(() => expect(screen.queryByText('Uploading…')).not.toBeInTheDocument());
    expect(within(card()).getByRole('button', { name: 'R1' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('ItemCard motion', () => {
  it('fades the slice line in only when the state changes on screen, with one press on a fresh Sliced', async () => {
    const { rerender } = render(<Harness value={bracket({ slice_status: 'slicing', slice_job_id: null, sliced_file: null })} />);
    const slicing = await screen.findByRole('progressbar');
    expect(slicing.parentElement).not.toHaveClass('animate-fade-in');

    rerender(<Harness value={bracket()} />);
    const glyph = await screen.findByLabelText('Sliced');
    expect(glyph).toHaveClass('animate-fade-in');
    expect(glyph.querySelector('svg')).toHaveClass('animate-slice-done');
  });

  it('does not animate a card that loads already sliced', async () => {
    render(<Harness value={bracket()} />);
    const glyph = await screen.findByLabelText('Sliced');
    expect(glyph).not.toHaveClass('animate-fade-in');
    expect(glyph.querySelector('.animate-slice-done')).toBeNull();
  });

  it('rises the details tray in when opened', async () => {
    render(<Harness value={bracket()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Bracket' }));
    expect(document.querySelector('.col-span-full')).toHaveClass('animate-rise');
  });
});

describe('ItemCard: the details tray leaves the way it arrived', () => {
  it('closing keeps the tray mounted, inert and marked leaving for the exit beat, then unmounts it', async () => {
    render(<Harness value={bracket()} />);
    await userEvent.click(within(card()).getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    const tray = screen.getByTestId('item-tray-20');
    expect(tray).not.toHaveAttribute('data-leaving');
    expect(tray).toHaveClass('files-tray', 'animate-rise');
    await userEvent.click(within(tray).getByRole('button', { name: 'Close' }));
    expect(screen.getByTestId('item-tray-20')).toHaveAttribute('data-leaving');
    expect(screen.getByTestId('item-tray-20')).toHaveAttribute('inert');
    await waitFor(() => expect(screen.queryByTestId('item-tray-20')).not.toBeInTheDocument());
  });

  it('reopening within the exit beat cancels the exit: the same tray stays, no longer leaving', async () => {
    render(<Harness value={bracket()} />);
    const name = () => within(card()).getByRole('button', { name: 'Bracket' });
    await userEvent.click(name());
    const tray = screen.getByTestId('item-tray-20');
    await userEvent.click(name());
    expect(tray).toHaveAttribute('data-leaving');
    await userEvent.click(name());
    expect(tray).not.toHaveAttribute('data-leaving');
    expect(tray).not.toHaveAttribute('inert');
    // Well past the beat the tray is still there: the pending unmount was cancelled.
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.getByTestId('item-tray-20')).toBe(tray);
  });
});

describe('ItemCard permission gating', () => {
  const failed = (r: Parameters<typeof bracket>[0] = {}) =>
    bracket({ slice_status: 'failed', slice_error: 'Plate 2 is empty', sliced_file: null, ...r });

  it('read-only: a failed slice shows its error but neither Retry nor Upload sliced file, and the menu has no write entries', async () => {
    granted = new Set(['projects:read']);
    render(<Harness value={failed()} />);
    expect(within(card()).getByText('Slice failed: Plate 2 is empty', { ignore: '[role="tooltip"]' })).toBeInTheDocument();
    expect(within(card()).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(within(card()).queryByRole('button', { name: 'Upload sliced file' })).not.toBeInTheDocument();
    await userEvent.click(within(card()).getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('button', { name: 'Details' })).toBeInTheDocument();
    for (const name of ['Rename', 'Fork as new item', 'Slice', 'Delete']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(calls).toEqual([]);
  });

  it('a failed revision without a source file offers no Upload sliced file even with projects:update', () => {
    granted = new Set(['projects:read', 'projects:update']);
    render(<Harness value={failed({ files: [] })} />);
    expect(within(card()).queryByRole('button', { name: 'Upload sliced file' })).not.toBeInTheDocument();
    expect(within(card()).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('with projects:update both buttons appear and the menu offers Rename and Fork', async () => {
    granted = new Set(['projects:read', 'projects:update']);
    render(<Harness value={failed()} />);
    expect(within(card()).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(card()).getByRole('button', { name: 'Upload sliced file' })).toBeInTheDocument();
    await userEvent.click(within(card()).getByRole('button', { name: 'More actions' }));
    for (const name of ['Rename', 'Fork as new item']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });
});
