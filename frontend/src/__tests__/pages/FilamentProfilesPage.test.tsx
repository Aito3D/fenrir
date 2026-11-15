/**
 * Filament Profiles page, tree edition: tree nav + node panel, migration of
 * unmanaged presets, SYNC (pull) result handling, Export for Orca and tree settings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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
};

function stub({ trees = [TREE], groups = [] as FilamentTreeMigrationGroup[] } = {}) {
  vi.spyOn(api, 'getFilamentTrees').mockResolvedValue(trees);
  vi.spyOn(api, 'getFilamentTreeTargets').mockResolvedValue(TARGETS);
  vi.spyOn(api, 'getUnmanagedFilamentGroups').mockResolvedValue(groups);
  vi.spyOn(api, 'getFilamentPresets').mockResolvedValue(PRESETS);
  vi.spyOn(api, 'getFilamentTreeNode').mockResolvedValue([
    { key: 'nozzle_temperature', value: ['240'], source: 'root', own: true },
  ]);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

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
    await userEvent.click(await screen.findByRole('button', { name: 'Not in a tree (2)' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
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

    await userEvent.click(await screen.findByRole('button', { name: 'SYNC' }));
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
      }),
    );
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'Keep Orca: 245' })).not.toBeInTheDocument());
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

    await userEvent.click(await screen.findByRole('button', { name: 'SYNC' }));
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

  it('explains how to connect Orca Cloud when SYNC gets a 401', async () => {
    stub();
    vi.spyOn(api, 'syncFilamentTrees').mockRejectedValue(new ApiError('Not logged in to Orca Cloud', 401));
    render(<FilamentProfilesPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'SYNC' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Orca Cloud is not connected.')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Profiles › Orca Cloud/ })).toHaveAttribute('href', '/profiles');
  });

  it('Export for Orca downloads the bundle', async () => {
    stub();
    const blob = new Blob(['zip']);
    const exportSpy = vi.spyOn(api, 'exportFilamentTrees').mockResolvedValue(blob);
    const createUrl = vi.fn(() => 'blob:x');
    const revokeUrl = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<FilamentProfilesPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Export for Orca' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(exportSpy).toHaveBeenCalledWith(undefined);
    expect(createUrl).toHaveBeenCalledWith(blob);
    vi.unstubAllGlobals();
  });

  it('tree settings add a colour, switch 0.2 and save the targets', async () => {
    stub();
    const addColor = vi.spyOn(api, 'addFilamentTreeColor').mockResolvedValue({ id: 12 });
    const patch = vi.spyOn(api, 'updateFilamentTree').mockResolvedValue({ success: true });
    const putTargets = vi.spyOn(api, 'setFilamentTreeTargets').mockResolvedValue(TARGETS);
    render(<FilamentProfilesPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Tree settings' }));
    await userEvent.type(await screen.findByLabelText('New colour name'), 'Blue');
    await userEvent.click(screen.getByRole('button', { name: 'Add colour' }));
    await waitFor(() => expect(addColor).toHaveBeenCalledWith(1, { name: 'Blue', hex: '#000000' }));

    await userEvent.click(screen.getByRole('switch', { name: 'Skip the 0.2 nozzle' }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(1, { skip_02: true }));

    const machines = screen.getByLabelText('Printers');
    await userEvent.clear(machines);
    await userEvent.type(machines, 'X2D, H2D');
    await userEvent.click(screen.getByRole('button', { name: 'Save targets' }));
    await waitFor(() => expect(putTargets).toHaveBeenCalledWith({ machines: ['X2D', 'H2D'], nozzles: ['0.4', '0.6'] }));
  });
});
