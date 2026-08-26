/**
 * Tests for the Filament Profiles page shell (Task 11): filters, grid,
 * import/export/sync flows and the two sync modals.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { FilamentProfilesPage } from '../../pages/FilamentProfilesPage';
import { readMaterialFilter, writeMaterialFilter, readGridSize } from '../../utils/filamentProfilePrefs';
import type { FilamentPreset } from '../../api/client';

function preset(overrides: Partial<FilamentPreset> = {}): FilamentPreset {
  return {
    id: 1,
    name: 'Bambu PLA Basic - Black',
    brand: 'Bambu',
    material: 'PLA',
    color: 'Black',
    color_hex: '#000000',
    filename: 'bambu_pla_basic_black.json',
    content: '{}',
    ...overrides,
  };
}

const PRESETS: FilamentPreset[] = [
  preset(),
  preset({
    id: 2,
    name: 'SUNLU PETG - White',
    brand: 'SUNLU',
    material: 'PETG',
    color: 'White',
    color_hex: '#ffffff',
    filename: 'sunlu_petg_white.json',
    content: '{}',
  }),
];

function stubBase() {
  server.use(
    http.get('*/filament-profiles', () => HttpResponse.json(PRESETS)),
    http.get('*/filament-profiles/base-presets', () => HttpResponse.json([])),
    http.get('*/filament-catalog/', () => HttpResponse.json([])),
  );
}

afterEach(() => {
  server.resetHandlers();
  localStorage.clear();
});

describe('FilamentProfilesPage', () => {
  it('renders cards after load', async () => {
    stubBase();
    render(<FilamentProfilesPage />);

    // "White"/"Black" are each preset's color label, shown only in the card
    // body (brand names like "SUNLU"/"Bambu" also appear in the brand-pill
    // row, so asserting on those would match more than one element).
    expect(await screen.findByText('White')).toBeInTheDocument();
    expect(screen.getByText('Black')).toBeInTheDocument();
  });

  it('filters the grid by brand pill and persists the choice', async () => {
    stubBase();
    render(<FilamentProfilesPage />);

    await screen.findByText('White');

    const sunluPill = screen.getByRole('button', { name: 'SUNLU' });
    await userEvent.click(sunluPill);

    await waitFor(() => expect(screen.queryByText('Black')).not.toBeInTheDocument());
    expect(screen.getByText('White')).toBeInTheDocument();
    expect(localStorage.getItem('profiles-filter-brand')).toBe('SUNLU');
  });

  it('does not clear a persisted material filter while loading or before presets arrive', async () => {
    writeMaterialFilter('PETG');
    server.use(
      http.get('*/filament-profiles', async () => {
        await delay(50);
        return HttpResponse.json(PRESETS);
      }),
      http.get('*/filament-profiles/base-presets', () => HttpResponse.json([])),
      http.get('*/filament-catalog/', () => HttpResponse.json([])),
    );

    render(<FilamentProfilesPage />);

    // Still loading — the persisted filter must survive untouched.
    expect(readMaterialFilter()).toBe('PETG');

    await screen.findByText('White');
    // After real (non-empty) data arrives, PETG is a valid material so it
    // stays selected — never auto-cleared.
    expect(readMaterialFilter()).toBe('PETG');
  });

  it('imports new files strictly sequentially, in file order, skipping ones that already exist', async () => {
    stubBase();
    const createCalls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    server.use(
      http.get('*/filament-profiles/bambu-scan', () =>
        HttpResponse.json({
          files: [
            // Already exists (matches a loaded preset's filename) — must be skipped.
            { filename: 'bambu_pla_basic_black.json', content: '{}' },
            {
              filename: 'new_one.json',
              content: JSON.stringify({
                name: 'New One',
                filament_vendor: ['Generic'],
                filament_type: ['PLA'],
                filament_colour: ['#111111'],
              }),
            },
            {
              filename: 'new_two.json',
              content: JSON.stringify({
                name: 'New Two',
                filament_vendor: ['Generic'],
                filament_type: ['PETG'],
                filament_colour: ['#222222'],
              }),
            },
            {
              filename: 'new_three.json',
              content: JSON.stringify({
                name: 'New Three',
                filament_vendor: ['Generic'],
                filament_type: ['ABS'],
                filament_colour: ['#333333'],
              }),
            },
          ],
        }),
      ),
      http.post('*/filament-profiles', async ({ request }) => {
        // Tracks concurrency: if the page ever fires the next POST before
        // this one resolves, `maxInFlight` catches it.
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const body = (await request.json()) as { filename: string };
        await delay(20);
        createCalls.push(body.filename);
        inFlight -= 1;
        return HttpResponse.json(preset({ id: 100 + createCalls.length, filename: body.filename }));
      }),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }));

    await waitFor(() =>
      expect(createCalls).toEqual(['new_one.json', 'new_two.json', 'new_three.json']),
    );
    expect(maxInFlight).toBe(1);
    expect(await screen.findByText(/Imported 3 preset/i)).toBeInTheDocument();
  });

  it('shows dry-run stats including Removed, and only executes after confirming Sync', async () => {
    stubBase();
    let dryRunCalls = 0;
    let executeCalls = 0;
    server.use(
      http.post('*/filament-profiles/bambu-sync', async ({ request }) => {
        const body = (await request.json()) as { dry_run: boolean };
        if (body.dry_run) {
          dryRunCalls += 1;
          return HttpResponse.json({ stats: { added: 1, updated: 2, removed: 3, unchanged: 4 } });
        }
        executeCalls += 1;
        return HttpResponse.json({ stats: { added: 1, updated: 2, removed: 0, unchanged: 6 } });
      }),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(screen.getByRole('button', { name: /Sync to PC/i }));

    await waitFor(() => expect(dryRunCalls).toBe(1));
    expect(executeCalls).toBe(0);

    await screen.findByRole('heading', { name: /Sync to PC/i });
    const modal = screen.getByTestId('sync-modal');
    expect(within(modal).getByText('3')).toBeInTheDocument(); // Removed count

    await userEvent.click(screen.getByRole('button', { name: /^Sync$/ }));

    await waitFor(() => expect(executeCalls).toBe(1));
    expect(await screen.findByRole('heading', { name: /Sync complete/i })).toBeInTheDocument();
  });

  it('disables Export ZIP when no preset has both filename and content, and grid-size buttons persist', async () => {
    server.use(
      http.get('*/filament-profiles', () =>
        HttpResponse.json([preset({ filename: '', content: '' })]),
      ),
      http.get('*/filament-profiles/base-presets', () => HttpResponse.json([])),
      http.get('*/filament-catalog/', () => HttpResponse.json([])),
    );
    render(<FilamentProfilesPage />);
    await screen.findByText('Black');

    expect(screen.getByRole('button', { name: /Export ZIP/i })).toBeDisabled();

    const gridButtons = screen.getAllByRole('button', { name: /grid size|small|medium|large/i });
    expect(gridButtons.length).toBeGreaterThanOrEqual(3);
    await userEvent.click(gridButtons[0]);
    expect(readGridSize()).toBe('small');
  });

  it('syncs prices from Zoho and reports what needs attention', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/zoho-sync', () =>
        HttpResponse.json({
          priced: 2,
          unchanged: 1,
          attention: [{ id: 7, name: 'eSUN PETG', reason: 'ambiguous', candidates: ['A', 'B'] }],
        }),
      ),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    await userEvent.click(await screen.findByRole('button', { name: /sync prices from zoho/i }));

    expect(await screen.findByText(/priced 2/i, {}, { timeout: 5000 })).toBeInTheDocument();
    // The needs-attention list is the safety property made visible — without it
    // auto-matching would be silently lossy.
    expect(await screen.findByText(/eSUN PETG/i, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText(/several items matched/i, {}, { timeout: 5000 })).toBeInTheDocument();
  });
});

describe('FilamentProfilesPage upload-fallback import', () => {
  /** Stub an empty server-side scan (the remote-deploy case). */
  function stubEmptyScan() {
    server.use(http.get('*/filament-profiles/bambu-scan', () => HttpResponse.json({ files: [] })));
  }

  function jsonFile(filename: string, body: Record<string, unknown>): File {
    return new File([JSON.stringify(body)], filename, { type: 'application/json' });
  }

  it('opens the file picker when the server scan finds nothing, instead of the "all imported" toast', async () => {
    stubBase();
    stubEmptyScan();
    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    const input = screen.getByTestId('fp-import-file-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');

    await userEvent.click(screen.getByRole('button', { name: /^Import$/ }));

    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    expect(screen.queryByText(/all already imported/i)).not.toBeInTheDocument();
  });

  it('imports uploaded .json files sequentially, skipping filenames that already exist', async () => {
    stubBase();
    stubEmptyScan();
    const createCalls: string[] = [];
    server.use(
      http.post('*/filament-profiles', async ({ request }) => {
        const body = (await request.json()) as { filename: string };
        createCalls.push(body.filename);
        return HttpResponse.json(preset({ id: 200 + createCalls.length, filename: body.filename }));
      }),
    );

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    const input = screen.getByTestId('fp-import-file-input') as HTMLInputElement;
    await userEvent.upload(input, [
      // Duplicate of a loaded preset's filename — must be skipped.
      jsonFile('bambu_pla_basic_black.json', { name: 'Dup' }),
      jsonFile('uploaded_new.json', {
        name: 'Uploaded New',
        filament_vendor: ['Generic'],
        filament_type: ['PLA'],
        filament_colour: ['#123456'],
      }),
    ]);

    await waitFor(() => expect(createCalls).toEqual(['uploaded_new.json']));
    expect(await screen.findByText(/Imported 1 preset/i)).toBeInTheDocument();
  });

  it('unpacks an uploaded export ZIP and imports its JSON entries', async () => {
    stubBase();
    stubEmptyScan();
    const createCalls: string[] = [];
    server.use(
      http.post('*/filament-profiles', async ({ request }) => {
        const body = (await request.json()) as { filename: string };
        createCalls.push(body.filename);
        return HttpResponse.json(preset({ id: 300 + createCalls.length, filename: body.filename }));
      }),
    );

    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file('zipped_one.json', JSON.stringify({ name: 'Zipped One', filament_vendor: ['Generic'], filament_type: ['PLA'] }));
    zip.file('zipped_two.json', JSON.stringify({ name: 'Zipped Two', filament_vendor: ['Generic'], filament_type: ['PETG'] }));
    zip.file('notes.txt', 'not a preset');
    const blob = await zip.generateAsync({ type: 'blob' });
    const zipFile = new File([blob], 'bambuddy-presets.zip', { type: 'application/zip' });

    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    const input = screen.getByTestId('fp-import-file-input') as HTMLInputElement;
    await userEvent.upload(input, zipFile);

    await waitFor(() => expect(createCalls.sort()).toEqual(['zipped_one.json', 'zipped_two.json']));
    expect(await screen.findByText(/Imported 2 preset/i)).toBeInTheDocument();
  });
});

describe('FilamentProfilesPage sync-base upload fallback', () => {
  it('opens the base file picker when sync-base reports an empty bundle (total 0)', async () => {
    stubBase();
    server.use(
      http.post('*/filament-profiles/sync-base', () =>
        HttpResponse.json({ added: 0, updated: 0, unchanged: 0, total: 0 }),
      ),
    );
    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    const input = screen.getByTestId('fp-base-file-input') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');

    await userEvent.click(screen.getByRole('button', { name: /Sync base/i }));

    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    // The result modal must NOT open for the empty case.
    expect(screen.queryByText(/Base profiles synced/i)).not.toBeInTheDocument();
  });

  it('uploads picked base preset files to base-upload and shows the result modal', async () => {
    stubBase();
    let uploaded: { filename: string; content: string }[] = [];
    server.use(
      http.post('*/filament-profiles/base-upload', async ({ request }) => {
        const body = (await request.json()) as { files: { filename: string; content: string }[] };
        uploaded = body.files;
        return HttpResponse.json({ added: 2, updated: 0, unchanged: 0, total: 2 });
      }),
    );
    render(<FilamentProfilesPage />);
    await screen.findByText('White');

    const input = screen.getByTestId('fp-base-file-input') as HTMLInputElement;
    await userEvent.upload(input, [
      new File(['{"name": "Base PLA"}'], 'base_pla.json', { type: 'application/json' }),
      new File(['{"name": "Base PETG"}'], 'base_petg.json', { type: 'application/json' }),
    ]);

    await waitFor(() =>
      expect(uploaded.map((f) => f.filename).sort()).toEqual(['base_petg.json', 'base_pla.json']),
    );
    expect(await screen.findByText(/Base profiles synced/i)).toBeInTheDocument();
  });
});
