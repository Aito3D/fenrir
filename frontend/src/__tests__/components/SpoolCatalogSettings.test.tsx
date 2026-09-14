import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { SpoolCatalogSettings } from '../../components/SpoolCatalogSettings';

// The real i18next signature accepts an interpolation-options object as the
// second argument (e.g. `t('...bulkDeleted', { count })`). Some of those
// calls are rendered directly into JSX (the selection banner), so returning
// the raw object here (as a plain `fallback ?? key` would) makes React throw
// "Objects are not valid as a React child" — stringify it instead so both
// direct renders and toast-call assertions stay safe.
//
// `t` is declared once at module scope (not re-created inside
// `useTranslation()`) so it has a stable identity across renders. The
// component memoizes `loadCatalog` via `useCallback(..., [showToast, t])`
// and re-runs it from a `useEffect`; a `t` that changes identity on every
// render (e.g. an inline arrow returned fresh each call) would re-trigger
// that effect on every keystroke and silently clobber optimistic state
// updates (like handleAdd's `setCatalog`) with a fresh (empty) fetch.
const t = (key: string, fallback?: string | Record<string, unknown>) => {
  if (typeof fallback === 'string') return fallback;
  if (fallback && typeof fallback === 'object') return `${key}${JSON.stringify(fallback)}`;
  return key;
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t }),
}));

const mockShowToast = vi.fn();
vi.mock('../../contexts/ToastContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/ToastContext')>();
  return { ...actual, useToast: () => ({ showToast: mockShowToast }) };
});

vi.mock('../../api/client', () => ({
  api: {
    getSettings: vi.fn().mockResolvedValue({}),
    getSpoolCatalog: vi.fn().mockResolvedValue([]),
    addCatalogEntry: vi.fn(),
    updateCatalogEntry: vi.fn(),
    deleteCatalogEntry: vi.fn(),
    bulkDeleteCatalogEntries: vi.fn(),
    resetSpoolCatalog: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

import { api } from '../../api/client';

// jsdom 25 doesn't implement File.prototype.text(); handleImport calls
// `await file.text()`, so build files with that method stubbed per-instance
// rather than reaching for a global polyfill.
function jsonFile(name: string, contents: string): File {
  const file = new File([contents], name, { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(contents) });
  return file;
}

describe('SpoolCatalogSettings — local catalog UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getSpoolCatalog).mockResolvedValue([]);
  });

  it('shows local CRUD buttons regardless of Spoolman state', async () => {
    render(<SpoolCatalogSettings />);

    await waitFor(() => {
      expect(screen.getByText('common.add')).toBeTruthy();
    });

    expect(screen.getByText('common.export')).toBeTruthy();
    expect(screen.getByText('common.import')).toBeTruthy();
    expect(screen.getByText('common.reset')).toBeTruthy();
  });

  it('renders the local Spool Catalog header and column layout', async () => {
    render(<SpoolCatalogSettings />);

    await waitFor(() => {
      expect(screen.getByText('settings.catalog.spoolCatalog')).toBeTruthy();
    });

    expect(screen.getByText('common.name')).toBeTruthy();
    expect(screen.getByText('settings.catalog.weight')).toBeTruthy();
    expect(screen.getByText('settings.catalog.type')).toBeTruthy();

    // No Spoolman-only columns leak in
    expect(screen.queryByText('settings.catalog.material')).toBeNull();
    expect(screen.queryByText('settings.catalog.spoolWeight')).toBeNull();
    expect(screen.queryByText('settings.spoolmanFilamentCatalogTitle')).toBeNull();
  });
});

describe('SpoolCatalogSettings — add entry (handleAdd)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getSpoolCatalog).mockResolvedValue([]);
  });

  it('adds a new entry with a trimmed name and parsed integer weight, then closes the form', async () => {
    const user = userEvent.setup();
    vi.mocked(api.addCatalogEntry).mockResolvedValue({ id: 5, name: 'PLA Red', weight: 200, is_default: false });

    render(<SpoolCatalogSettings />);
    await waitFor(() => expect(screen.getByText('common.add')).toBeTruthy());

    await user.click(screen.getAllByText('common.add')[0]);
    await user.type(screen.getByPlaceholderText('settings.catalog.namePlaceholder'), '  PLA Red  ');
    await user.type(screen.getByPlaceholderText('g'), '200');
    await user.click(screen.getAllByText('common.add')[1]);

    await waitFor(() => {
      expect(api.addCatalogEntry).toHaveBeenCalledWith({ name: 'PLA Red', weight: 200 });
    });
    expect(mockShowToast).toHaveBeenCalledWith('settings.catalog.entryAdded', 'success');
    expect(await screen.findByText('PLA Red')).toBeTruthy();
    // the form closes and clears on success
    expect(screen.queryByPlaceholderText('settings.catalog.namePlaceholder')).toBeNull();
  });

  it('shows a validation toast and does not call the API when weight is blank', async () => {
    const user = userEvent.setup();

    render(<SpoolCatalogSettings />);
    await waitFor(() => expect(screen.getByText('common.add')).toBeTruthy());

    await user.click(screen.getAllByText('common.add')[0]);
    await user.type(screen.getByPlaceholderText('settings.catalog.namePlaceholder'), 'PLA Red');
    await user.click(screen.getAllByText('common.add')[1]);

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith('settings.catalog.nameWeightRequired', 'error');
    });
    expect(api.addCatalogEntry).not.toHaveBeenCalled();
    // the form stays open on a validation failure
    expect(screen.getByPlaceholderText('settings.catalog.namePlaceholder')).toBeTruthy();
  });

  it('shows an error toast and keeps the form open (uncleared) when addCatalogEntry rejects', async () => {
    const user = userEvent.setup();
    vi.mocked(api.addCatalogEntry).mockRejectedValue(new Error('boom'));

    render(<SpoolCatalogSettings />);
    await waitFor(() => expect(screen.getByText('common.add')).toBeTruthy());

    await user.click(screen.getAllByText('common.add')[0]);
    await user.type(screen.getByPlaceholderText('settings.catalog.namePlaceholder'), 'PLA Red');
    await user.type(screen.getByPlaceholderText('g'), '200');
    await user.click(screen.getAllByText('common.add')[1]);

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith('settings.catalog.addFailed', 'error');
    });
    // silent-except-toast: the form is not closed or cleared on failure
    expect(screen.getByPlaceholderText('settings.catalog.namePlaceholder')).toHaveValue('PLA Red');
  });
});

describe('SpoolCatalogSettings — update entry (handleUpdate)', () => {
  const seedEntry = { id: 1, name: 'ABS Black', weight: 250, is_default: false };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates an entry with the edited name/weight and exits edit mode', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSpoolCatalog).mockResolvedValue([seedEntry]);
    vi.mocked(api.updateCatalogEntry).mockResolvedValue({ id: 1, name: 'ABS White', weight: 300, is_default: false });

    render(<SpoolCatalogSettings />);
    const row = (await screen.findByText('ABS Black')).closest('tr') as HTMLElement;
    await user.click(within(row).getAllByRole('button')[0]); // pencil -> startEdit

    const nameInput = within(row).getByDisplayValue('ABS Black');
    const weightInput = within(row).getByDisplayValue('250');
    await user.clear(nameInput);
    await user.type(nameInput, 'ABS White');
    await user.clear(weightInput);
    await user.type(weightInput, '300');

    await user.click(within(row).getAllByRole('button')[0]); // check -> handleUpdate

    await waitFor(() => {
      expect(api.updateCatalogEntry).toHaveBeenCalledWith(1, { name: 'ABS White', weight: 300 });
    });
    expect(mockShowToast).toHaveBeenCalledWith('settings.catalog.entryUpdated', 'success');
    expect(await screen.findByText('ABS White')).toBeTruthy();
    // edit mode is exited on success — no more inline inputs for this row
    expect(screen.queryByDisplayValue('ABS White')).toBeNull();
  });

  it('shows an error toast and stays in edit mode when updateCatalogEntry rejects', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSpoolCatalog).mockResolvedValue([seedEntry]);
    vi.mocked(api.updateCatalogEntry).mockRejectedValue(new Error('boom'));

    render(<SpoolCatalogSettings />);
    const row = (await screen.findByText('ABS Black')).closest('tr') as HTMLElement;
    await user.click(within(row).getAllByRole('button')[0]);
    await user.click(within(row).getAllByRole('button')[0]);

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith('settings.catalog.updateFailed', 'error');
    });
    // silent-except-toast: edit mode is NOT exited on failure
    expect(within(row).getByDisplayValue('ABS Black')).toBeTruthy();
  });
});

describe('SpoolCatalogSettings — delete entry (handleDelete)', () => {
  const seedEntry = { id: 2, name: 'PETG Clear', weight: 220, is_default: false };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes the entry via the confirm modal and removes it from the table', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSpoolCatalog).mockResolvedValue([seedEntry]);
    vi.mocked(api.deleteCatalogEntry).mockResolvedValue({ status: 'ok' });

    render(<SpoolCatalogSettings />);
    const row = (await screen.findByText('PETG Clear')).closest('tr') as HTMLElement;
    await user.click(within(row).getAllByRole('button')[1]); // trash -> opens confirm modal

    const confirmButton = await screen.findByRole('button', { name: 'common.delete' });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(api.deleteCatalogEntry).toHaveBeenCalledWith(2);
    });
    expect(mockShowToast).toHaveBeenCalledWith('settings.catalog.entryDeleted', 'success');
    expect(screen.queryByText('PETG Clear')).toBeNull();
  });

  it('shows an error toast, closes the modal, but leaves the entry in place when deleteCatalogEntry rejects', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSpoolCatalog).mockResolvedValue([seedEntry]);
    vi.mocked(api.deleteCatalogEntry).mockRejectedValue(new Error('boom'));

    render(<SpoolCatalogSettings />);
    const row = (await screen.findByText('PETG Clear')).closest('tr') as HTMLElement;
    await user.click(within(row).getAllByRole('button')[1]);

    const confirmButton = await screen.findByRole('button', { name: 'common.delete' });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith('settings.catalog.deleteFailed', 'error');
    });
    // the `finally` block always clears deleteEntry, so the modal closes even
    // on failure — but the catalog is never filtered, so the row stays.
    expect(screen.queryByRole('button', { name: 'common.delete' })).toBeNull();
    expect(screen.getByText('PETG Clear')).toBeTruthy();
  });
});

describe('SpoolCatalogSettings — reset catalog (handleReset)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resets the catalog and reloads it from the server', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSpoolCatalog)
      .mockResolvedValueOnce([{ id: 1, name: 'Old', weight: 100, is_default: false }])
      .mockResolvedValueOnce([{ id: 9, name: 'Default PLA', weight: 250, is_default: true }]);
    vi.mocked(api.resetSpoolCatalog).mockResolvedValue({ status: 'ok' });

    render(<SpoolCatalogSettings />);
    await screen.findByText('Old');

    await user.click(screen.getByText('common.reset'));
    const confirmButtons = await screen.findAllByRole('button', { name: 'common.reset' });
    await user.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => {
      expect(api.resetSpoolCatalog).toHaveBeenCalled();
    });
    expect(api.getSpoolCatalog).toHaveBeenCalledTimes(2);
    expect(mockShowToast).toHaveBeenCalledWith('settings.catalog.resetSuccess', 'success');
    expect(await screen.findByText('Default PLA')).toBeTruthy();
  });

  it('shows an error toast and does not reload the catalog when resetSpoolCatalog rejects', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSpoolCatalog).mockResolvedValue([{ id: 1, name: 'Old', weight: 100, is_default: false }]);
    vi.mocked(api.resetSpoolCatalog).mockRejectedValue(new Error('boom'));

    render(<SpoolCatalogSettings />);
    await screen.findByText('Old');

    await user.click(screen.getByText('common.reset'));
    const confirmButtons = await screen.findAllByRole('button', { name: 'common.reset' });
    await user.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith('settings.catalog.resetFailed', 'error');
    });
    // loadCatalog() is never reached when resetSpoolCatalog rejects — only
    // the initial mount call happened.
    expect(api.getSpoolCatalog).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Old')).toBeTruthy();
  });
});

describe('SpoolCatalogSettings — bulk delete (handleBulkDelete)', () => {
  const entries = [
    { id: 1, name: 'ABS Black', weight: 250, is_default: false },
    { id: 2, name: 'PETG Clear', weight: 220, is_default: false },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bulk-deletes the selected entries via the confirm modal', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSpoolCatalog).mockResolvedValue(entries);
    vi.mocked(api.bulkDeleteCatalogEntries).mockResolvedValue({ deleted: 1 });

    render(<SpoolCatalogSettings />);
    const row = (await screen.findByText('ABS Black')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('checkbox'));

    const deleteSelected = await screen.findByText('settings.catalog.deleteSelected');
    await user.click(deleteSelected);

    const confirmButton = await screen.findByRole('button', { name: 'common.delete' });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(api.bulkDeleteCatalogEntries).toHaveBeenCalledWith([1]);
    });
    const successCall = mockShowToast.mock.calls.find(([, type]) => type === 'success');
    expect(successCall).toBeTruthy();
    expect(successCall![0]).toContain('settings.catalog.bulkDeleted');
    expect(screen.queryByText('ABS Black')).toBeNull();
    expect(screen.getByText('PETG Clear')).toBeTruthy();
  });

  it('shows an error toast and keeps the selection/rows untouched when bulkDeleteCatalogEntries rejects', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSpoolCatalog).mockResolvedValue(entries);
    vi.mocked(api.bulkDeleteCatalogEntries).mockRejectedValue(new Error('boom'));

    render(<SpoolCatalogSettings />);
    const row = (await screen.findByText('ABS Black')).closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('checkbox'));

    const deleteSelected = await screen.findByText('settings.catalog.deleteSelected');
    await user.click(deleteSelected);

    const confirmButton = await screen.findByRole('button', { name: 'common.delete' });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith('settings.catalog.bulkDeleteFailed', 'error');
    });
    // silent-except-toast: selection and rows are untouched on failure
    expect(screen.getByText('ABS Black')).toBeTruthy();
    expect((within(row).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  });
});

describe('SpoolCatalogSettings — export catalog (handleExport)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds a JSON blob URL, triggers a download, revokes the URL, and shows a success toast', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSpoolCatalog).mockResolvedValue([
      { id: 1, name: 'ABS Black', weight: 250, is_default: false },
    ]);

    const createObjectURL = vi.fn(() => 'blob:mock-url');
    const revokeObjectURL = vi.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as typeof URL.revokeObjectURL;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    try {
      render(<SpoolCatalogSettings />);
      await screen.findByText('ABS Black');

      await user.click(screen.getByText('common.export'));

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      const blobArg = createObjectURL.mock.calls[0][0] as Blob;
      expect(blobArg.type).toBe('application/json');
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
      expect(clickSpy).toHaveBeenCalledTimes(1);
      const successCall = mockShowToast.mock.calls.find(([, type]) => type === 'success');
      expect(successCall).toBeTruthy();
      expect(successCall![0]).toContain('settings.catalog.exported');
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      clickSpy.mockRestore();
    }
  });
});

describe('SpoolCatalogSettings — import catalog (handleImport)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('imports new entries, skips duplicates (case-insensitive) and invalid rows, then clears the input', async () => {
    vi.mocked(api.getSpoolCatalog).mockResolvedValue([
      { id: 1, name: 'ABS Black', weight: 250, is_default: false },
    ]);
    vi.mocked(api.addCatalogEntry).mockResolvedValue({ id: 2, name: 'PLA Red', weight: 200, is_default: false });

    const { container } = render(<SpoolCatalogSettings />);
    await screen.findByText('ABS Black');

    const payload = [
      { name: 'PLA Red', weight: 200 }, // new -> added
      { name: 'abs black', weight: 250 }, // duplicate (case-insensitive) -> skipped
      { name: '', weight: 100 }, // invalid: no name -> skipped
      { name: 'No Weight' }, // invalid: weight not a number -> skipped
    ];
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = jsonFile('catalog.json', JSON.stringify(payload));
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(api.addCatalogEntry).toHaveBeenCalledTimes(1);
    });
    expect(api.addCatalogEntry).toHaveBeenCalledWith({ name: 'PLA Red', weight: 200 });

    await waitFor(() => {
      const summaryCall = mockShowToast.mock.calls.find(
        ([msg]) => typeof msg === 'string' && msg.includes('settings.catalog.imported'),
      );
      expect(summaryCall).toBeTruthy();
      expect(summaryCall![1]).toBe('success');
      expect(summaryCall![0]).toContain('"added":1');
      expect(summaryCall![0]).toContain('"skipped":3');
    });
    expect(await screen.findByText('PLA Red')).toBeTruthy();
    // the file input is cleared after import completes
    expect(input.value).toBe('');
  });

  it('shows an import-failed toast and adds nothing when the file is not valid JSON', async () => {
    vi.mocked(api.getSpoolCatalog).mockResolvedValue([]);

    const { container } = render(<SpoolCatalogSettings />);
    await waitFor(() => expect(screen.getByText('common.add')).toBeTruthy());

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = jsonFile('bad.json', '{ not valid json');
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith('settings.catalog.importFailed', 'error');
    });
    expect(api.addCatalogEntry).not.toHaveBeenCalled();
  });

  it('counts a per-item addCatalogEntry rejection as skipped but still shows a success summary toast', async () => {
    vi.mocked(api.getSpoolCatalog).mockResolvedValue([]);
    vi.mocked(api.addCatalogEntry).mockRejectedValue(new Error('boom'));

    const { container } = render(<SpoolCatalogSettings />);
    await waitFor(() => expect(screen.getByText('common.add')).toBeTruthy());

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = jsonFile('catalog.json', JSON.stringify([{ name: 'PLA Red', weight: 200 }]));
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(api.addCatalogEntry).toHaveBeenCalledWith({ name: 'PLA Red', weight: 200 });
    });
    await waitFor(() => {
      const summaryCall = mockShowToast.mock.calls.find(
        ([msg]) => typeof msg === 'string' && msg.includes('settings.catalog.imported'),
      );
      expect(summaryCall).toBeTruthy();
      expect(summaryCall![1]).toBe('success');
      expect(summaryCall![0]).toContain('"skipped":1');
    });
  });
});
