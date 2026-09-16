/**
 * Tests for the colour catalog admin (ColorCatalogSettings).
 *
 * Pin the #1154 wiring contract:
 * - The Add form sends `extra_colors` + `effect_type` alongside the legacy
 *   manufacturer / color_name / hex_color / material fields.
 * - Inline-edit hydrates the new fields from the existing entry and sends
 *   them back through `updateColorEntry`.
 * - Effect dropdown lists the full unified vocabulary (surface effects
 *   + sheen variants + structural variants), not just the original 5.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { render } from '../utils';
import { api } from '../../api/client';
import type { ColorCatalogEntry } from '../../api/client';
import { ColorCatalogSettings } from '../../components/ColorCatalogSettings';

// jsdom 25 doesn't implement File.prototype.text(); handleImport calls
// `await file.text()`, so build files with that method stubbed per-instance
// rather than reaching for a global polyfill (mirrors
// SpoolCatalogSettings.test.tsx's jsonFile helper).
function jsonFile(name: string, contents: string): File {
  const file = new File([contents], name, { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(contents) });
  return file;
}

// Builds a fake fetch Response whose body streams the given SSE `data: `
// events one read() at a time, terminating with `{ done: true }` — enough
// to drive handleSync's `reader.read()` loop without a real network call.
function sseResponse(events: Array<Record<string, unknown>>, ok = true) {
  const encoder = new TextEncoder();
  const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`);
  let index = 0;
  return {
    ok,
    body: {
      getReader: () => ({
        read: () => {
          if (index < lines.length) {
            const chunk = encoder.encode(lines[index]);
            index += 1;
            return Promise.resolve({ done: false, value: chunk });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    },
  } as unknown as Response;
}

vi.mock('../../api/client', async () => {
  // Preserve every other method on `api` (ThemeContext / AuthContext call
  // some on mount) and override only the catalog ones the component touches.
  const actual: typeof import('../../api/client') = await vi.importActual('../../api/client');
  return {
    ...actual,
    api: {
      ...actual.api,
      getColorCatalog: vi.fn(),
      addColorEntry: vi.fn(),
      updateColorEntry: vi.fn(),
      deleteColorEntry: vi.fn(),
      bulkDeleteColorEntries: vi.fn(),
      resetColorCatalog: vi.fn(),
    },
    getAuthToken: vi.fn(() => null),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ColorCatalogSettings — Add form (#1154)', () => {
  it('sends extra_colors and effect_type when adding an entry', async () => {
    vi.mocked(api.getColorCatalog).mockResolvedValueOnce([]);
    vi.mocked(api.addColorEntry).mockResolvedValueOnce({
      id: 1,
      manufacturer: 'Test',
      color_name: 'Aurora',
      hex_color: '#EC984C',
      material: null,
      is_default: false,
      extra_colors: 'ec984c,6cd4bc,a66eb9,d87694',
      effect_type: 'sparkle',
    });

    render(<ColorCatalogSettings />);
    // Wait for initial load to settle so the Add button is rendered.
    await waitFor(() => expect(api.getColorCatalog).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument(),
    );

    // Open the Add form via the toolbar's "Add" button — there's only one
    // before the form opens, so this is unambiguous.
    fireEvent.click(screen.getByRole('button', { name: /Add$/i }));

    // The form now renders with manufacturer, color name, hex, material,
    // extra_colors, and effect_type inputs.
    fireEvent.change(screen.getByPlaceholderText('Manufacturer'), {
      target: { value: 'Test' },
    });
    fireEvent.change(screen.getByPlaceholderText('Color Name'), {
      target: { value: 'Aurora' },
    });
    // Hex has both a <input type="color"> and a <input type="text"
    // placeholder="#FFFFFF">. Pick the text variant by placeholder.
    fireEvent.change(screen.getByPlaceholderText('#FFFFFF'), {
      target: { value: '#EC984C' },
    });
    fireEvent.change(screen.getByPlaceholderText('EC984C,#6CD4BC,A66EB9,D87694'), {
      target: { value: 'EC984C,#6CD4BC,A66EB9,D87694' },
    });
    // Pick "Sparkle" from the effect-type combobox (the manufacturer filter
    // is also a <select>, so disambiguate by looking for the one whose
    // options include 'sparkle').
    const effectSelectAdd = (
      screen.getAllByRole('combobox') as HTMLSelectElement[]
    ).find((s) => Array.from(s.options).some((o) => o.value === 'sparkle'));
    expect(effectSelectAdd).toBeDefined();
    fireEvent.change(effectSelectAdd!, { target: { value: 'sparkle' } });

    // Submit. The form's submit "Add" button is now the second button with
    // that label (toolbar Add still exists), so query inside the form
    // container by clicking the last matching button.
    const allAddButtons = screen.getAllByRole('button', { name: /Add$/i });
    fireEvent.click(allAddButtons[allAddButtons.length - 1]);

    await waitFor(() => expect(api.addColorEntry).toHaveBeenCalledTimes(1));
    expect(api.addColorEntry).toHaveBeenCalledWith({
      manufacturer: 'Test',
      color_name: 'Aurora',
      hex_color: '#EC984C',
      material: null,
      extra_colors: 'EC984C,#6CD4BC,A66EB9,D87694',
      effect_type: 'sparkle',
    });
  });

  it('lists every variant in the effect dropdown (not just the original 5)', async () => {
    vi.mocked(api.getColorCatalog).mockResolvedValueOnce([]);
    render(<ColorCatalogSettings />);
    await waitFor(() => expect(api.getColorCatalog).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByText(/loading/i)).not.toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /Add$/i }));
    // Disambiguate from the toolbar's manufacturer-filter <select>.
    const effectSelect = (
      screen.getAllByRole('combobox') as HTMLSelectElement[]
    ).find((s) => Array.from(s.options).some((o) => o.value === 'sparkle'));
    expect(effectSelect).toBeDefined();
    const options = Array.from(effectSelect!.options).map((o) => o.value);

    // Surface effects (V1).
    expect(options).toContain('sparkle');
    expect(options).toContain('wood');
    expect(options).toContain('marble');
    expect(options).toContain('glow');
    expect(options).toContain('matte');
    // Structural variants added in #1154 follow-up.
    expect(options).toContain('gradient');
    expect(options).toContain('dual-color');
    expect(options).toContain('tri-color');
    expect(options).toContain('multicolor');
    // Sheen / finish variants.
    expect(options).toContain('silk');
    expect(options).toContain('galaxy');
    expect(options).toContain('rainbow');
    expect(options).toContain('metal');
    expect(options).toContain('translucent');
    // None / no-effect option.
    expect(options).toContain('');
  });
});

describe('ColorCatalogSettings — inline edit (#1154)', () => {
  it('hydrates extra_colors and effect_type when entering edit mode', async () => {
    const seed = {
      id: 42,
      manufacturer: 'Bambu Lab',
      color_name: 'Galaxy',
      hex_color: '#1A2B3C',
      material: 'PLA',
      is_default: true,
      extra_colors: 'aabbcc,ddeeff',
      effect_type: 'galaxy',
    };
    vi.mocked(api.getColorCatalog).mockResolvedValueOnce([seed]);

    render(<ColorCatalogSettings />);
    await waitFor(() => expect(screen.getByText('Galaxy')).toBeInTheDocument());

    // Click the Edit button on the seeded row.
    // The row's edit button has no accessible label so query by SVG-bearing
    // button containing the Pencil icon — there's only one in the rendered tree.
    const buttons = screen.getAllByRole('button');
    const editButton = buttons.find((b) => b.querySelector('svg.lucide-pencil'));
    expect(editButton).toBeDefined();
    fireEvent.click(editButton!);

    // The extra-colors input should now be populated with the seeded value.
    const extraColorsInputs = screen.getAllByPlaceholderText(
      'EC984C,#6CD4BC,A66EB9,D87694',
    ) as HTMLInputElement[];
    expect(extraColorsInputs[0].value).toBe('aabbcc,ddeeff');

    // The effect dropdown reflects the seeded effect. The manufacturer
    // filter is also a <select> at the toolbar level, so query all and
    // pick the one whose value matches what we expect — the last one,
    // since the filter never has 'galaxy' in its options.
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    const effectSelect = selects.find((s) => s.value === 'galaxy');
    expect(effectSelect).toBeDefined();
  });
});

describe('ColorCatalogSettings — inline edit submit (handleUpdate)', () => {
  const seed: ColorCatalogEntry = {
    id: 7,
    manufacturer: 'Bambu Lab',
    color_name: 'Galaxy',
    hex_color: '#1A2B3C',
    material: 'PLA',
    is_default: false,
    extra_colors: null,
    effect_type: null,
  };

  it('submits the edited fields via updateColorEntry and exits edit mode', async () => {
    vi.mocked(api.getColorCatalog).mockResolvedValueOnce([seed]);
    vi.mocked(api.updateColorEntry).mockResolvedValueOnce({ ...seed, color_name: 'Nova' });

    render(<ColorCatalogSettings />);
    const row = (await screen.findByText('Galaxy')).closest('tr') as HTMLElement;

    const editButton = within(row).getAllByRole('button').find((b) => b.querySelector('svg.lucide-pencil'));
    expect(editButton).toBeDefined();
    fireEvent.click(editButton!);

    const nameInput = within(row).getByDisplayValue('Galaxy');
    fireEvent.change(nameInput, { target: { value: 'Nova' } });

    const submitButton = within(row).getAllByRole('button').find((b) => b.querySelector('svg.lucide-check'));
    expect(submitButton).toBeDefined();
    fireEvent.click(submitButton!);

    await waitFor(() => expect(api.updateColorEntry).toHaveBeenCalledTimes(1));
    expect(api.updateColorEntry).toHaveBeenCalledWith(7, {
      manufacturer: 'Bambu Lab',
      color_name: 'Nova',
      hex_color: '#1A2B3C',
      material: 'PLA',
      extra_colors: null,
      effect_type: null,
    });
    expect(await screen.findByText('Color updated')).toBeInTheDocument();
    expect(screen.getByText('Nova')).toBeInTheDocument();
    // edit mode is exited on success — no more inline input for the row.
    expect(screen.queryByDisplayValue('Nova')).not.toBeInTheDocument();
  });

  it('shows an error toast and stays in edit mode when updateColorEntry rejects', async () => {
    vi.mocked(api.getColorCatalog).mockResolvedValueOnce([seed]);
    vi.mocked(api.updateColorEntry).mockRejectedValueOnce(new Error('boom'));

    render(<ColorCatalogSettings />);
    const row = (await screen.findByText('Galaxy')).closest('tr') as HTMLElement;

    const editButton = within(row).getAllByRole('button').find((b) => b.querySelector('svg.lucide-pencil'));
    fireEvent.click(editButton!);

    const submitButton = within(row).getAllByRole('button').find((b) => b.querySelector('svg.lucide-check'));
    fireEvent.click(submitButton!);

    expect(await screen.findByText('Failed to update color')).toBeInTheDocument();
    // silent-except-toast: edit mode is NOT exited on failure.
    expect(within(row).getByDisplayValue('Bambu Lab')).toBeInTheDocument();
  });
});

describe('ColorCatalogSettings — delete (handleDelete)', () => {
  const seed: ColorCatalogEntry = {
    id: 9,
    manufacturer: 'Overture',
    color_name: 'Cobalt',
    hex_color: '#123456',
    material: 'PETG',
    is_default: false,
    extra_colors: null,
    effect_type: null,
  };

  it('deletes the entry via the confirm modal and removes it from the table', async () => {
    vi.mocked(api.getColorCatalog).mockResolvedValueOnce([seed]);
    vi.mocked(api.deleteColorEntry).mockResolvedValueOnce({ status: 'ok' });

    render(<ColorCatalogSettings />);
    const row = (await screen.findByText('Cobalt')).closest('tr') as HTMLElement;
    const trashButton = within(row).getAllByRole('button').find((b) => b.querySelector('svg.lucide-trash-2'));
    expect(trashButton).toBeDefined();
    fireEvent.click(trashButton!);

    const confirmButton = await screen.findByRole('button', { name: 'Delete' });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(api.deleteColorEntry).toHaveBeenCalledWith(9));
    expect(await screen.findByText('Color deleted')).toBeInTheDocument();
    expect(screen.queryByText('Cobalt')).not.toBeInTheDocument();
  });

  it('shows an error toast, closes the modal, but leaves the entry in place when deleteColorEntry rejects', async () => {
    vi.mocked(api.getColorCatalog).mockResolvedValueOnce([seed]);
    vi.mocked(api.deleteColorEntry).mockRejectedValueOnce(new Error('boom'));

    render(<ColorCatalogSettings />);
    const row = (await screen.findByText('Cobalt')).closest('tr') as HTMLElement;
    const trashButton = within(row).getAllByRole('button').find((b) => b.querySelector('svg.lucide-trash-2'));
    fireEvent.click(trashButton!);

    const confirmButton = await screen.findByRole('button', { name: 'Delete' });
    fireEvent.click(confirmButton);

    expect(await screen.findByText('Failed to delete color')).toBeInTheDocument();
    // the `finally` block always clears deleteEntry, so the modal closes even
    // on failure — but the catalog is never filtered, so the row stays.
    expect(screen.queryByText('Delete Color')).not.toBeInTheDocument();
    expect(screen.getByText('Cobalt')).toBeInTheDocument();
  });
});

describe('ColorCatalogSettings — reset (handleReset)', () => {
  const oldEntry: ColorCatalogEntry = {
    id: 1,
    manufacturer: 'Old',
    color_name: 'Grey',
    hex_color: '#AAAAAA',
    material: null,
    is_default: false,
    extra_colors: null,
    effect_type: null,
  };
  const defaultEntry: ColorCatalogEntry = {
    id: 2,
    manufacturer: 'Bambu Lab',
    color_name: 'Jade White',
    hex_color: '#FFFFFF',
    material: 'PLA',
    is_default: true,
    extra_colors: null,
    effect_type: null,
  };

  it('resets the catalog and reloads it from the server', async () => {
    vi.mocked(api.getColorCatalog)
      .mockResolvedValueOnce([oldEntry])
      .mockResolvedValueOnce([defaultEntry]);
    vi.mocked(api.resetColorCatalog).mockResolvedValueOnce({ status: 'ok' });

    render(<ColorCatalogSettings />);
    await screen.findByText('Grey');

    fireEvent.click(screen.getByRole('button', { name: /Reset$/i }));
    const confirmButtons = await screen.findAllByRole('button', { name: 'Reset' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => expect(api.resetColorCatalog).toHaveBeenCalledTimes(1));
    expect(api.getColorCatalog).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Color catalog reset to defaults')).toBeInTheDocument();
    expect(await screen.findByText('Jade White')).toBeInTheDocument();
  });

  it('shows an error toast and does not reload the catalog when resetColorCatalog rejects', async () => {
    vi.mocked(api.getColorCatalog).mockResolvedValueOnce([oldEntry]);
    vi.mocked(api.resetColorCatalog).mockRejectedValueOnce(new Error('boom'));

    render(<ColorCatalogSettings />);
    await screen.findByText('Grey');

    fireEvent.click(screen.getByRole('button', { name: /Reset$/i }));
    const confirmButtons = await screen.findAllByRole('button', { name: 'Reset' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    expect(await screen.findByText('Failed to reset catalog')).toBeInTheDocument();
    // loadCatalog() is only reached on success — a rejection leaves the
    // initial mount call as the only getColorCatalog call.
    expect(api.getColorCatalog).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Grey')).toBeInTheDocument();
  });
});

describe('ColorCatalogSettings — sync (handleSync)', () => {
  let originalFetch: typeof fetch;

  const SYNC_URL = '/api/v1/inventory/colors/sync';

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // The api client's unmocked methods (e.g. ThemeContext's getSettings on
  // mount) call through to the real `fetch`, and AllProviders mounts those
  // contexts alongside this component. A blanket `global.fetch = vi.fn()...`
  // intercepts those calls too and starves handleSync's own fetch of its
  // queued response, so only the sync URL is stubbed here — everything else
  // still reaches the real fetch, exactly as it does in every other test in
  // this file that never touches `global.fetch` at all.
  function stubSyncFetch(handler: (init?: RequestInit) => Promise<unknown>) {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url === SYNC_URL) return handler(init);
      return originalFetch(input, init);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('streams progress, reports the added/skipped summary, and reloads the catalog', async () => {
    const synced: ColorCatalogEntry = {
      id: 3,
      manufacturer: 'Polymaker',
      color_name: 'Jade',
      hex_color: '#00FF00',
      material: 'PLA',
      is_default: false,
      extra_colors: null,
      effect_type: null,
    };
    vi.mocked(api.getColorCatalog)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([synced]);

    const fetchMock = stubSyncFetch(() =>
      Promise.resolve(
        sseResponse([
          { type: 'progress', total_fetched: 50, total_available: 100 },
          { type: 'complete', added: 1, skipped: 0 },
        ]),
      ),
    );

    render(<ColorCatalogSettings />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Sync$/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(SYNC_URL, { method: 'POST', headers: {} }),
    );
    expect(await screen.findByText('Added 1 new colors (0 already existed)')).toBeInTheDocument();
    expect(api.getColorCatalog).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Jade')).toBeInTheDocument();
  });

  it('shows a sync-failed toast and re-enables the button when the request rejects', async () => {
    vi.mocked(api.getColorCatalog).mockResolvedValueOnce([]);
    stubSyncFetch(() => Promise.reject(new Error('network down')));

    render(<ColorCatalogSettings />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Sync$/i }));

    expect(await screen.findByText('Failed to sync from FilamentColors.xyz')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sync$/i })).not.toBeDisabled();
  });
});

describe('ColorCatalogSettings — bulk delete (handleBulkDelete)', () => {
  const entries: ColorCatalogEntry[] = [
    { id: 11, manufacturer: 'Anycubic', color_name: 'Black', hex_color: '#000000', material: 'PLA', is_default: false, extra_colors: null, effect_type: null },
    { id: 12, manufacturer: 'Anycubic', color_name: 'White', hex_color: '#FFFFFF', material: 'PLA', is_default: false, extra_colors: null, effect_type: null },
  ];

  it('bulk-deletes the selected entries via the confirm modal', async () => {
    vi.mocked(api.getColorCatalog).mockResolvedValueOnce(entries);
    vi.mocked(api.bulkDeleteColorEntries).mockResolvedValueOnce({ deleted: 1 });

    render(<ColorCatalogSettings />);
    const row = (await screen.findByText('Black')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));

    fireEvent.click(await screen.findByText('Delete Selected'));
    const confirmButton = await screen.findByRole('button', { name: 'Delete' });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(api.bulkDeleteColorEntries).toHaveBeenCalledWith([11]));
    expect(await screen.findByText('Deleted 1 colors')).toBeInTheDocument();
    expect(screen.queryByText('Black')).not.toBeInTheDocument();
    expect(screen.getByText('White')).toBeInTheDocument();
  });

  it('shows an error toast and keeps the selection/rows untouched when bulkDeleteColorEntries rejects', async () => {
    vi.mocked(api.getColorCatalog).mockResolvedValueOnce(entries);
    vi.mocked(api.bulkDeleteColorEntries).mockRejectedValueOnce(new Error('boom'));

    render(<ColorCatalogSettings />);
    const row = (await screen.findByText('Black')).closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));

    fireEvent.click(await screen.findByText('Delete Selected'));
    const confirmButton = await screen.findByRole('button', { name: 'Delete' });
    fireEvent.click(confirmButton);

    expect(await screen.findByText('Failed to delete colors')).toBeInTheDocument();
    // silent-except-toast: selection and rows are untouched on failure.
    expect(screen.getByText('Black')).toBeInTheDocument();
    expect((within(row).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  });
});

describe('ColorCatalogSettings — export (handleExport)', () => {
  it('builds a JSON blob, triggers a download, revokes the URL, and shows a success toast', async () => {
    vi.mocked(api.getColorCatalog).mockResolvedValueOnce([
      { id: 21, manufacturer: 'eSun', color_name: 'Red', hex_color: '#FF0000', material: 'PLA', is_default: false, extra_colors: null, effect_type: null },
    ]);

    const createObjectURL = vi.fn(() => 'blob:mock-url');
    const revokeObjectURL = vi.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as typeof URL.revokeObjectURL;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    try {
      render(<ColorCatalogSettings />);
      await screen.findByText('Red');

      fireEvent.click(screen.getByRole('button', { name: /Export$/i }));

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const blobArg = createObjectURL.mock.calls[0][0] as Blob;
      expect(blobArg.type).toBe('application/json');
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(await screen.findByText('Exported 1 colors')).toBeInTheDocument();
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      clickSpy.mockRestore();
    }
  });
});

describe('ColorCatalogSettings — import (handleImport)', () => {
  it('imports new entries, skips duplicates (case-insensitive) and invalid rows, then clears the input', async () => {
    vi.mocked(api.getColorCatalog).mockResolvedValueOnce([
      { id: 1, manufacturer: 'Bambu Lab', color_name: 'Black', hex_color: '#000000', material: 'PLA', is_default: false, extra_colors: null, effect_type: null },
    ]);
    vi.mocked(api.addColorEntry).mockResolvedValueOnce({
      id: 2, manufacturer: 'Polymaker', color_name: 'Teal', hex_color: '#008080', material: 'PLA', is_default: false, extra_colors: null, effect_type: null,
    });

    const { container } = render(<ColorCatalogSettings />);
    await screen.findByText('Black');

    const payload = [
      { manufacturer: 'Polymaker', color_name: 'Teal', hex_color: '#008080', material: 'PLA' }, // new -> added
      { manufacturer: 'bambu lab', color_name: 'black', hex_color: '#000000', material: 'pla' }, // duplicate (case-insensitive) -> skipped
      { manufacturer: '', color_name: 'Nameless', hex_color: '#111111' }, // invalid: no manufacturer -> skipped
    ];
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = jsonFile('colors.json', JSON.stringify(payload));
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(api.addColorEntry).toHaveBeenCalledTimes(1));
    expect(api.addColorEntry).toHaveBeenCalledWith({
      manufacturer: 'Polymaker',
      color_name: 'Teal',
      hex_color: '#008080',
      material: 'PLA',
      extra_colors: null,
      effect_type: null,
    });
    expect(await screen.findByText('Imported 1 colors (2 skipped)')).toBeInTheDocument();
    expect(await screen.findByText('Teal')).toBeInTheDocument();
    expect(input.value).toBe('');
  });

  it('shows an import-failed toast and adds nothing when the file is not valid JSON', async () => {
    vi.mocked(api.getColorCatalog).mockResolvedValueOnce([]);

    const { container } = render(<ColorCatalogSettings />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = jsonFile('bad.json', '{ not valid json');
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText('Failed to import: invalid JSON format')).toBeInTheDocument();
    expect(api.addColorEntry).not.toHaveBeenCalled();
  });
});
