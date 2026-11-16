/**
 * Filament Profiles page, tree edition: material cards + node panel, migration of
 * unmanaged presets, SYNC (pull) result handling, Export for Orca and tree settings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { FilamentProfilesPage } from '../../pages/FilamentProfilesPage';
import { api, ApiError } from '../../api/client';
import type {
  FilamentPreset,
  FilamentTreeMigrationGroup,
  FilamentTreePullResult,
  FilamentTreeSummary,
} from '../../api/client';

const TREE: FilamentTreeSummary = {
  id: 1,
  name: 'Polymaker PETG',
  brand: 'Polymaker',
  material: 'PETG',
  skip_02: null,
  abrasive: false,
  source: { machine: 'X2D', nozzle: '0.4', color_id: 10 },
  colors: [
    { id: 10, name: 'White', hex: '#ffffff' },
    { id: 11, name: 'Red', hex: '#dd3333' },
  ],
  own_counts: {},
};

const TARGETS = { machines: ['X2D', 'H2S'], nozzles: ['0.4', '0.6'] };

const GROUP: FilamentTreeMigrationGroup = {
  prefix: 'SUNLU PA6-GF',
  preset_ids: [5, 6],
  proposed_source_preset_id: 5,
  proposed_machine: 'X2D',
  proposed_nozzle: '0.4',
  warnings: ['SUNLU PA6-GF - Natural has no nozzle in its name'],
};

function preset(id: number, name: string, color: string): FilamentPreset {
  return { id, name, brand: 'SUNLU', material: 'PA6-GF', color, color_hex: '', filename: `${id}.json`, content: '{}' };
}
const PRESETS = [preset(5, 'SUNLU PA6-GF - Black', 'Black'), preset(6, 'SUNLU PA6-GF - Natural', 'Natural')];

const EMPTY_PULL: FilamentTreePullResult = {
  applied: [],
  conflicts: [],
  candidates: [],
  legacy: 0,
  missing: [],
  ignored: 0,
  refresh: [],
  push: { pushed: 0, failed: [], remaining: 0, needs_write_scope: false, snapshot: null, held: [], removed: { deleted: 0, failed: 0, snapshot: null } },
};

function stub({ trees = [TREE], groups = [] as FilamentTreeMigrationGroup[] } = {}) {
  vi.spyOn(api, 'getFilamentTrees').mockResolvedValue(trees);
  vi.spyOn(api, 'getFilamentTreeTargets').mockResolvedValue(TARGETS);
  vi.spyOn(api, 'getUnmanagedFilamentGroups').mockResolvedValue(groups);
  vi.spyOn(api, 'getFilamentPresets').mockResolvedValue(PRESETS);
  vi.spyOn(api, 'previewFilamentTreeSync').mockResolvedValue({ pull: [], push: [], remove: [], conflicts: [], writable: true, fingerprint: 'f0' });
  vi.spyOn(api, 'getFilamentTreeSyncProgress').mockResolvedValue({ running: false, done: 0, total: 0 });
  vi.spyOn(api, 'getFilamentTreeSyncLast').mockResolvedValue(null);
  vi.spyOn(api, 'getFilamentTreeNode').mockResolvedValue([
    { key: 'nozzle_temperature', value: ['240'], source: 'root', own: true },
  ]);
}

beforeEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/'); // the open node lives in the URL
});

/** Clicks SYNC, then confirms the preview. */
async function sync() {
  await userEvent.click(await screen.findByRole('button', { name: 'SYNC' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
}

/** Opens the header's "Sync & export" menu and clicks one entry. */
async function menu(name: string) {
  await userEvent.click(await screen.findByRole('button', { name: /Sync & export/ }));
  await userEvent.click(await screen.findByRole('button', { name }));
}

/** The node panel's Colours tab: the filament's colours, 0.2 switch, export, duplicate and delete. */
const openColours = async () => userEvent.click(await screen.findByRole('tab', { name: 'Colours' }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FilamentProfilesPage (trees)', () => {
  it('shows the tree and the first tree root in the settings panel', async () => {
    stub();
    render(<FilamentProfilesPage />);
    expect(await screen.findByRole('navigation', { name: 'Filament profile trees' })).toBeInTheDocument();
    expect(await screen.findByRole('navigation', { name: 'Profile path' })).toHaveTextContent('Polymaker PETG');
    expect(screen.getByRole('button', { name: 'Polymaker PETG' })).toHaveAttribute('aria-current', 'true');
  });

  it('empty state opens the migration modal and posts the chosen group', async () => {
    stub({ trees: [], groups: [GROUP] });
    const migrate = vi.spyOn(api, 'migrateFilamentPresets').mockResolvedValue({ tree_ids: [3] });
    render(<FilamentProfilesPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Organise into trees' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('SUNLU PA6-GF')).toBeInTheDocument();
    expect(within(dialog).getByText(GROUP.warnings[0])).toBeInTheDocument();

    await userEvent.selectOptions(within(dialog).getByLabelText('Calibrated colour: SUNLU PA6-GF'), '6');
    await userEvent.selectOptions(within(dialog).getByLabelText('Printer: SUNLU PA6-GF'), 'H2S');
    await userEvent.selectOptions(within(dialog).getByLabelText('Nozzle: SUNLU PA6-GF'), '0.6');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create trees' }));

    await waitFor(() =>
      expect(migrate).toHaveBeenCalledWith([{ prefix: 'SUNLU PA6-GF', source_preset_id: 6, machine: 'H2S', nozzle: '0.6' }]),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows a refused group its own error and keeps the modal open', async () => {
    stub({ trees: [], groups: [GROUP] });
    vi.spyOn(api, 'migrateFilamentPresets').mockRejectedValue(
      new ApiError('SUNLU PA6-GF: colours inherit from different Bambu families', 400),
    );
    render(<FilamentProfilesPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Organise into trees' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create trees' }));
    expect(await within(dialog).findByText(/different Bambu families/)).toBeInTheDocument();
  });

  it('offers unmanaged presets beside existing trees', async () => {
    stub({ groups: [GROUP] });
    render(<FilamentProfilesPage />);
    expect(await screen.findByText('Not in a tree (2)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Organise into trees' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('shows a SYNC already running on the server, e.g. after leaving the page and coming back', async () => {
    stub();
    vi.spyOn(api, 'getFilamentTreeSyncProgress').mockResolvedValue({ running: true, done: 10, total: 400, phase: 'push', name: 'Polymaker PETG - Red @H2S 0.4' });
    const stop = vi.spyOn(api, 'stopFilamentTreeSync').mockResolvedValue({ running: true, done: 10, total: 400, phase: 'push', stop: true });
    render(<FilamentProfilesPage />);
    // the phase, the count and the profile on its way
    expect(await screen.findByText('Sending to Orca Cloud 10/400 · Polymaker PETG - Red @H2S 0.4')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '10');
    expect(screen.getByRole('button', { name: 'SYNC' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(stop).toHaveBeenCalledOnce();
  });

  it('shows the result of a SYNC that finished without this page holding its response', async () => {
    stub();
    vi.spyOn(api, 'getFilamentTreeSyncProgress')
      .mockResolvedValueOnce({ running: true, done: 0, total: 0, phase: 'read' })
      .mockResolvedValue({ running: false, done: 4, total: 5, phase: 'push' });
    vi.spyOn(api, 'getFilamentTreeSyncLast').mockResolvedValue({
      ...EMPTY_PULL,
      push: { ...EMPTY_PULL.push, pushed: 4, stopped: true, remaining: 1 },
    });
    render(<FilamentProfilesPage />);
    expect(await screen.findByText('Reading Orca Cloud')).toBeInTheDocument();
    // the next poll (1 s) sees the run over
    const dialog = await screen.findByRole('dialog', { name: 'Sync result' }, { timeout: 3000 });
    expect(within(dialog).getByText(/Stopped: 1 not sent yet/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('SYNC lists what it would do and syncs only once confirmed', async () => {
    stub();
    vi.spyOn(api, 'previewFilamentTreeSync').mockResolvedValue({
      pull: [{ name: 'Polymaker PETG - Red @H2S 0.4', changes: { nozzle_temperature: [['240'], ['255']] } }],
      push: [{ name: 'Polymaker PETG - Red @H2D 0.6', new: true }], remove: [],
      conflicts: [], writable: true,
      fingerprint: 'abc123',
    });
    const run = vi.spyOn(api, 'syncFilamentTrees').mockResolvedValue(EMPTY_PULL);
    render(<FilamentProfilesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'SYNC' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sync with Orca Cloud' });
    // one row per filament in each direction; the printer/nozzle preset sits inside it
    expect(within(dialog).getAllByText('Polymaker PETG - Red')).toHaveLength(2);
    expect(within(dialog).getByText('H2S 0.4')).toBeInTheDocument();
    expect(within(dialog).getByText('nozzle_temperature')).toBeInTheDocument();
    expect(within(dialog).getByText('H2D 0.6')).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(run.mock.calls[0][1]).toBe('abc123');
    expect(await screen.findByRole('dialog', { name: 'Sync result' })).toBeInTheDocument();
  });

  it('a SYNC whose plan changed since the preview (409) shows a fresh preview instead of syncing', async () => {
    stub();
    const preview = vi
      .spyOn(api, 'previewFilamentTreeSync')
      .mockResolvedValueOnce({ pull: [], push: [{ name: 'Old leaf', new: false }], remove: [], conflicts: [], writable: true, fingerprint: 'old' })
      .mockResolvedValue({ pull: [], push: [{ name: 'New leaf', new: false }], remove: [], conflicts: [], writable: true, fingerprint: 'new' });
    const run = vi.spyOn(api, 'syncFilamentTrees').mockRejectedValue(new ApiError('changed', 409));
    render(<FilamentProfilesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'SYNC' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sync with Orca Cloud' });
    await userEvent.click(within(dialog).getByRole('button', { name: /Confirm/ }));
    expect(await screen.findByText('New leaf')).toBeInTheDocument();
    expect(preview).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith(expect.anything(), 'old', true);
    expect(screen.queryByRole('dialog', { name: 'Sync result' })).not.toBeInTheDocument();
    expect(screen.queryByText('Old leaf')).not.toBeInTheDocument();
  });

  it('SYNC shows conflicts and resolving one sends the chosen value', async () => {
    stub();
    vi.spyOn(api, 'syncFilamentTrees').mockResolvedValue({
      ...EMPTY_PULL,
      legacy: 2,
      conflicts: [
        {
          tree_id: 1,
          machine: 'H2S',
          nozzle: '0.6',
          color_id: 11,
          key: 'nozzle_temperature',
          fenrir_value: ['240'],
          orca_value: ['245'],
        },
      ],
    });
    const resolve = vi.spyOn(api, 'resolveFilamentTreeConflict').mockResolvedValue({ success: true });
    render(<FilamentProfilesPage />);

    await sync();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Polymaker PETG - Red @H2S 0.6')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep Orca: 245' }));

    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith({
        tree_id: 1,
        machine: 'H2S',
        nozzle: '0.6',
        color_id: 11,
        key: 'nozzle_temperature',
        value: ['245'],
        orca_value: ['245'],
      }),
    );
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'Keep Orca: 245' })).not.toBeInTheDocument());
  });

  it('SYNC tells a read-only pairing to reconnect before anything can be pushed', async () => {
    stub();
    vi.spyOn(api, 'syncFilamentTrees').mockResolvedValue({
      ...EMPTY_PULL,
      push: { ...EMPTY_PULL.push, needs_write_scope: true, remaining: 7 },
    });
    render(<FilamentProfilesPage />);
    await sync();
    expect(await within(await screen.findByRole('dialog')).findByText(/read-only.*7 waiting/)).toBeInTheDocument();
  });

  it('SYNC lists the leaves held back by a refused Orca edit', async () => {
    stub();
    vi.spyOn(api, 'syncFilamentTrees').mockResolvedValue({
      ...EMPTY_PULL,
      push: { ...EMPTY_PULL.push, held: [{ name: 'Polymaker PETG - Red @H2S 0.4', keys: ['nozzle_temperature', 'fan_max_speed'] }] },
    });
    render(<FilamentProfilesPage />);
    await sync();
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/Not sent: an Orca edit/)).toBeInTheDocument();
    expect(within(dialog).getByText('Polymaker PETG - Red @H2S 0.4: nozzle_temperature, fan_max_speed')).toBeInTheDocument();
  });

  it('candidate form posts the brand, material and colour parsed from the name', async () => {
    stub();
    vi.spyOn(api, 'syncFilamentTrees').mockResolvedValue({
      ...EMPTY_PULL,
      candidates: [
        {
          orca_id: 'abc',
          name: 'eSUN PLA+ - Fire Red @BBL H2S',
          content: { default_filament_colour: ['#C12E1F'] },
        },
      ],
    });
    const create = vi.spyOn(api, 'createFilamentTreeFromCandidate').mockResolvedValue({ tree_id: 9 });
    render(<FilamentProfilesPage />);

    await sync();
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create tree' }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        orca_id: 'abc',
        name: 'eSUN PLA+ - Fire Red @BBL H2S',
        brand: 'eSUN',
        material: 'PLA+',
        color_name: 'Fire Red',
        color_hex: '#C12E1F',
        machine: 'X2D',
        nozzle: '0.4',
      }),
    );
  });

  it('aborts a hung SYNC at the 10 minute deadline, re-enables the button and reports an unknown outcome', async () => {
    stub();
    let signal: AbortSignal | undefined;
    vi.spyOn(api, 'syncFilamentTrees').mockImplementation(
      (s) =>
        new Promise((_, reject) => {
          signal = s;
          s?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    render(<FilamentProfilesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'SYNC' }));
    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    vi.useFakeTimers();
    try {
      fireEvent.click(confirm);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(599_999);
      });
      expect(signal?.aborted).toBe(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(await screen.findByText(/Sync result unknown/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'SYNC' })).toBeEnabled();
  });

  it('shows a definite SYNC error from the server as it is', async () => {
    stub();
    vi.spyOn(api, 'syncFilamentTrees').mockRejectedValue(new ApiError('Orca is down', 502));
    render(<FilamentProfilesPage />);
    await sync();
    expect(await screen.findByText('Orca is down')).toBeInTheDocument();
  });

  it('explains how to connect Orca Cloud when SYNC gets a 401', async () => {
    stub();
    vi.spyOn(api, 'previewFilamentTreeSync').mockRejectedValue(new ApiError('Not logged in to Orca Cloud', 401));
    render(<FilamentProfilesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'SYNC' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Orca Cloud is not connected.')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Profiles › Orca Cloud/ })).toHaveAttribute('href', '/profiles');
  });

  it('Clean Orca Cloud deletes only after the count is confirmed', async () => {
    stub();
    vi.spyOn(api, 'getOrcaCleanupPreview').mockResolvedValue({ count: 2, names: ['A', 'B'], writable: true });
    const clean = vi.spyOn(api, 'cleanOrcaCloud').mockResolvedValue({ deleted: 2, failed: 0, snapshot: 's.json' });
    render(<FilamentProfilesPage />);
    await menu('Clean Orca Cloud…');
    expect(await screen.findByText(/2 filament presets in Orca Cloud/)).toBeInTheDocument();
    const names = within(screen.getByTestId('clean-orca-names')).getAllByRole('listitem');
    expect(names.map((li) => li.textContent)).toEqual(['A', 'B']);
    expect(clean).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(clean).toHaveBeenCalledWith(['A', 'B']));
  });

  it('Clean Orca Cloud with an unknown count names the snapshot instead of a number', async () => {
    stub();
    vi.spyOn(api, 'getOrcaCleanupPreview').mockResolvedValue({ count: 2, names: ['A', 'B'], writable: true });
    vi.spyOn(api, 'cleanOrcaCloud').mockResolvedValue({ deleted: null, failed: null, snapshot: 'cleanup-1.json' });
    render(<FilamentProfilesPage />);
    await menu('Clean Orca Cloud…');
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    const toast = await screen.findByText(/deleted count is unknown/);
    expect(toast).toHaveTextContent('Snapshot: cleanup-1.json');
    expect(toast).not.toHaveTextContent(/null|NaN/);
  });

  it('Export for Orca downloads the bundle', async () => {
    stub();
    const blob = new Blob(['zip']);
    const exportSpy = vi.spyOn(api, 'exportFilamentTrees').mockResolvedValue({ blob, token: 'tok' });
    const confirmSpy = vi.spyOn(api, 'confirmFilamentTreeExport').mockResolvedValue({ confirmed: 1 });
    const createUrl = vi.fn(() => 'blob:x');
    const revokeUrl = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<FilamentProfilesPage />);

    await menu('Export for Orca');
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(exportSpy).toHaveBeenCalledWith(undefined, false);
    expect(createUrl).toHaveBeenCalledWith(blob);
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledWith('tok'));
    vi.unstubAllGlobals();
  });

  it('the Colours tab adds a colour and switches 0.2; the menu edits the targets as chips', async () => {
    stub();
    const addColor = vi.spyOn(api, 'addFilamentTreeColor').mockResolvedValue({ id: 12 });
    const patch = vi.spyOn(api, 'updateFilamentTree').mockResolvedValue({ success: true });
    const putTargets = vi.spyOn(api, 'setFilamentTreeTargets').mockResolvedValue(TARGETS);
    render(<FilamentProfilesPage />);

    await openColours();
    await userEvent.type(await screen.findByLabelText('New colour name'), 'Blue');
    await userEvent.click(screen.getByRole('button', { name: 'Add colour' }));
    await waitFor(() => expect(addColor).toHaveBeenCalledWith(1, { name: 'Blue', hex: '#000000' }));

    const skip = screen.getByLabelText('Skip the 0.2 nozzle');
    expect(skip).toHaveValue('auto');
    await userEvent.selectOptions(skip, 'skip');
    await waitFor(() => expect(patch).toHaveBeenCalledWith(1, { skip_02: true }));
    await userEvent.selectOptions(skip, 'include');
    await waitFor(() => expect(patch).toHaveBeenCalledWith(1, { skip_02: false }));
    await userEvent.selectOptions(skip, 'auto');
    await waitFor(() => expect(patch).toHaveBeenCalledWith(1, { skip_02: null }));

    await menu('Printers and nozzles (all trees)');
    const printers = within(await screen.findByRole('group', { name: 'Printers' }));
    await userEvent.click(printers.getByRole('button', { name: 'Remove H2S' }));
    await userEvent.type(printers.getByLabelText('Add printer'), 'H2D{Enter}');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Merge nozzles with identical settings into one profile' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save targets' }));
    await waitFor(() => expect(putTargets).toHaveBeenCalledWith({ machines: ['X2D', 'H2D'], nozzles: ['0.4', '0.6'], merge_nozzles: true }));
  });

  it('deletes a whole filament only after confirming', async () => {
    stub();
    const del = vi.spyOn(api, 'deleteFilamentTree').mockResolvedValue({ success: true });
    render(<FilamentProfilesPage />);

    await openColours();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Polymaker PETG' }));
    expect(del).not.toHaveBeenCalled();
    expect(await screen.findByText(/cannot be undone/)).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Delete Polymaker PETG' });
    await userEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(del).toHaveBeenCalledWith(1));
  });

  it('saves a recoloured colour once, 400ms after the last change', async () => {
    stub();
    const update = vi.spyOn(api, 'updateFilamentTreeColor').mockResolvedValue({ success: true });
    render(<FilamentProfilesPage />);
    await openColours();
    const picker = await screen.findByLabelText('Colour of Red');
    fireEvent.change(picker, { target: { value: '#112233' } });
    fireEvent.change(picker, { target: { value: '#445566' } });
    expect(update).not.toHaveBeenCalled();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith(1, 11, { name: 'Red', hex: '#445566' });
  });

  it('keeping the Fenrir value still sends what Orca holds', async () => {
    stub();
    const conflict = {
      tree_id: 1, machine: 'H2S', nozzle: '0.6', color_id: 11, key: 'nozzle_temperature',
      fenrir_value: ['240'], orca_value: ['245'],
    };
    vi.spyOn(api, 'syncFilamentTrees').mockResolvedValue({ ...EMPTY_PULL, conflicts: [conflict] });
    const resolve = vi.spyOn(api, 'resolveFilamentTreeConflict').mockResolvedValue({ success: true });
    render(<FilamentProfilesPage />);
    await sync();
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep Fenrir: 240' }));
    await waitFor(() =>
      expect(resolve).toHaveBeenCalledWith({
        tree_id: 1, machine: 'H2S', nozzle: '0.6', color_id: 11, key: 'nozzle_temperature',
        value: ['240'], orca_value: ['245'],
      }),
    );
  });

  it('saves a pending recolour when the panel unmounts', async () => {
    stub();
    const update = vi.spyOn(api, 'updateFilamentTreeColor').mockResolvedValue({ success: true });
    const { unmount } = render(<FilamentProfilesPage />);
    await openColours();
    fireEvent.change(await screen.findByLabelText('Colour of Red'), { target: { value: '#445566' } });
    unmount();
    expect(update).toHaveBeenCalledWith(1, 11, { name: 'Red', hex: '#445566' });
  });

  it('empty state waits for the unmanaged groups and shows their error', async () => {
    stub({ trees: [] });
    vi.spyOn(api, 'getUnmanagedFilamentGroups').mockRejectedValue(new ApiError('unmanaged scan failed', 500));
    render(<FilamentProfilesPage />);
    expect(await screen.findByText('unmanaged scan failed')).toBeInTheDocument();
    expect(screen.queryByText(/Run SYNC/)).not.toBeInTheDocument();
  });

  it('Sync base indexes the server bundle and shows the result', async () => {
    stub();
    const syncBase = vi
      .spyOn(api, 'syncBaseFilamentPresets')
      .mockResolvedValue({ total: 12, added: 2, updated: 1, unchanged: 9 } as Awaited<ReturnType<typeof api.syncBaseFilamentPresets>>);
    render(<FilamentProfilesPage />);
    await menu('Sync base');
    await waitFor(() => expect(syncBase).toHaveBeenCalled());
    expect(await screen.findByText('Base profiles synced')).toBeInTheDocument();
  });

  it('Sync base falls back to uploading picked files when the server has no bundle', async () => {
    stub();
    vi.spyOn(api, 'syncBaseFilamentPresets').mockResolvedValue(
      { total: 0, added: 0, updated: 0, unchanged: 0 } as Awaited<ReturnType<typeof api.syncBaseFilamentPresets>>,
    );
    const upload = vi
      .spyOn(api, 'uploadBaseFilamentPresets')
      .mockResolvedValue({ total: 1, added: 1, updated: 0, unchanged: 0 } as Awaited<ReturnType<typeof api.uploadBaseFilamentPresets>>);
    render(<FilamentProfilesPage />);
    const input = screen.getByTestId('fp-base-file-input') as HTMLInputElement;
    const pickerClick = vi.spyOn(input, 'click').mockImplementation(() => {});
    await menu('Sync base');
    expect(await screen.findByText(/No BambuStudio bundle on the server/)).toBeInTheDocument();
    expect(pickerClick).not.toHaveBeenCalled(); // only the operator's own click may open the picker
    await userEvent.click(screen.getByRole('button', { name: 'Choose files' }));
    expect(pickerClick).toHaveBeenCalledOnce();

    const file = new File(['{"name":"Bambu PLA Basic @BBL H2S"}'], 'base.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(upload).toHaveBeenCalledWith([{ filename: 'base.json', content: '{"name":"Bambu PLA Basic @BBL H2S"}' }]),
    );
  });

  it('an upload that finds no presets reports 0 results, and Choose files is disabled while it runs', async () => {
    stub();
    vi.spyOn(api, 'syncBaseFilamentPresets').mockResolvedValue(
      { total: 0, added: 0, updated: 0, unchanged: 0 } as Awaited<ReturnType<typeof api.syncBaseFilamentPresets>>,
    );
    let finish: (r: Awaited<ReturnType<typeof api.uploadBaseFilamentPresets>>) => void = () => {};
    vi.spyOn(api, 'uploadBaseFilamentPresets').mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<FilamentProfilesPage />);
    const input = screen.getByTestId('fp-base-file-input') as HTMLInputElement;
    vi.spyOn(input, 'click').mockImplementation(() => {});
    await menu('Sync base');
    await screen.findByText(/No BambuStudio bundle on the server/);

    const file = new File(['{"name":"x"}'], 'base.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose files' })).toBeDisabled());
    finish({ total: 0, added: 0, updated: 0, unchanged: 0 } as Awaited<ReturnType<typeof api.uploadBaseFilamentPresets>>);
    expect(await screen.findByText('Base profiles synced')).toBeInTheDocument();
    expect(screen.queryByText(/No BambuStudio bundle on the server/)).not.toBeInTheDocument();
  });

  it('Sync to PC previews with a dry run, then writes the generated rows on confirm', async () => {
    stub();
    const stats = { added: 1, updated: 0, removed: 0, unchanged: 1 };
    const bambuSync = vi
      .spyOn(api, 'syncFilamentPresetsToBambu')
      .mockResolvedValue({ stats } as Awaited<ReturnType<typeof api.syncFilamentPresetsToBambu>>);
    render(<FilamentProfilesPage />);
    await waitFor(() => expect(api.getFilamentPresets).toHaveBeenCalled());
    await screen.findByRole('navigation', { name: 'Profile path' });
    await menu('Sync to PC');
    const rows = PRESETS.map((p) => ({ filename: p.filename, content: p.content }));
    await waitFor(() => expect(bambuSync).toHaveBeenCalledWith(rows, true));
    await userEvent.click(await screen.findByRole('button', { name: 'Sync' }));
    await waitFor(() => expect(bambuSync).toHaveBeenCalledWith(rows, false));
  });

  it('restores the open node from the URL and writes clicks back to it', async () => {
    stub();
    window.history.replaceState({}, '', '/?tree=1&color=11&m=H2S&n=0.6');
    render(<FilamentProfilesPage />);
    expect(await screen.findByRole('navigation', { name: 'Profile path' })).toHaveTextContent('Polymaker PETG › H2S › 0.6 › Red');
    await userEvent.click(within(screen.getByRole('group', { name: 'Printer' })).getByRole('button', { name: 'All machines' }));
    expect(window.location.search).toBe('?tree=1&color=11');
    expect(await screen.findByRole('navigation', { name: 'Profile path' })).toHaveTextContent('Red (all machines)');
  });

  it('shows beside SYNC how many changed profiles it will send, and nothing when none changed', async () => {
    stub({ trees: [{ ...TREE, export_pending: 3 }] });
    const { unmount } = render(<FilamentProfilesPage />);
    await screen.findByRole('button', { name: 'SYNC' });
    expect(await screen.findByTestId('sync-pending-count')).toHaveTextContent('3');
    unmount();
    stub();
    render(<FilamentProfilesPage />);
    await screen.findByRole('button', { name: 'SYNC' });
    expect(screen.queryByTestId('sync-pending-count')).not.toBeInTheDocument();
  });

  it('exports only the changed profiles and creates a filament from scratch', async () => {
    stub({ trees: [{ ...TREE, export_pending: 3 }] });
    vi.spyOn(api, 'getBaseFilamentPresets').mockResolvedValue([]);
    const exportSpy = vi.spyOn(api, 'exportFilamentTrees').mockResolvedValue({ blob: new Blob(['zip']), token: 'tok' });
    vi.spyOn(api, 'confirmFilamentTreeExport').mockResolvedValue({ confirmed: 3 });
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const create = vi.spyOn(api, 'createFilamentTree').mockResolvedValue({ tree_id: 7 });
    render(<FilamentProfilesPage />);

    await menu('Export changed only (3)');
    await waitFor(() => expect(exportSpy).toHaveBeenCalledWith(undefined, true));
    vi.unstubAllGlobals();

    await userEvent.click(screen.getByRole('button', { name: 'New filament' }));
    const dialog = within(await screen.findByRole('dialog'));
    await userEvent.type(dialog.getByLabelText('Brand'), 'eSun');
    await userEvent.type(dialog.getByLabelText('Material type'), 'PLA');
    await userEvent.type(dialog.getByLabelText('Bambu base preset'), 'Generic PLA');
    await userEvent.type(dialog.getByLabelText('Colour name'), 'Black');
    await userEvent.click(dialog.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        brand: 'eSun', material: 'PLA', base_family: 'Generic PLA', color_name: 'Black', color_hex: '#000000', machine: 'X2D', nozzle: '0.4',
      }),
    );
    await waitFor(() => expect(window.location.search).toBe('?tree=7'));
  });

  it('History lists changes and reverts one; own values copy to other filaments', async () => {
    const other = { ...TREE, id: 2, name: 'SUNLU PETG', brand: 'SUNLU', colors: [] };
    stub({ trees: [TREE, other] });
    vi.spyOn(api, 'getFilamentTreeHistory').mockResolvedValue([
      { id: 9, machine: 'H2S', nozzle: '', color_id: 0, key: 'nozzle_temperature', old_value: ['240'], new_value: ['250'], actor: 'paul', created_at: '2026-11-14T10:00:00' },
    ]);
    const revert = vi.spyOn(api, 'revertFilamentTreeChange').mockResolvedValue({ success: true });
    const bulk = vi.spyOn(api, 'bulkSetFilamentTreeNode').mockResolvedValue({ success: true });
    render(<FilamentProfilesPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Apply to other filaments' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByRole('checkbox', { name: 'SUNLU PETG' })).toBeChecked(); // same material
    await userEvent.click(dialog.getByRole('button', { name: 'Apply to 1' }));
    await waitFor(() => expect(bulk).toHaveBeenCalledWith({ tree_ids: [2], set: { nozzle_temperature: ['240'] } }));

    await userEvent.click(await screen.findByRole('tab', { name: 'History' }));
    expect(await screen.findByText('240 → 250')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Revert/ }));
    await waitFor(() => expect(revert).toHaveBeenCalledWith(1, 9));
  });
});
