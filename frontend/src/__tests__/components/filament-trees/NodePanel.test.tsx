import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { NodePanel } from '../../../components/filament-trees/NodePanel';
import { api } from '../../../api/client';
import type { FilamentTreeNodeRow, FilamentTreeSummary } from '../../../api/client';

vi.mock('../../../api/client', () => ({
  api: { getFilamentTrees: vi.fn(), getFilamentTreeNode: vi.fn(), setFilamentTreeNode: vi.fn(), getFilamentPresets: vi.fn() },
}));

const mockShowToast = vi.fn();
vi.mock('../../../contexts/ToastContext', () => ({ useToast: () => ({ showToast: mockShowToast }) }));

let canUpdate = true;
vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({ hasPermission: (p: string) => p !== 'filaments:update' || canUpdate }),
}));

const tree: FilamentTreeSummary = {
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

const leafRows: FilamentTreeNodeRow[] = [
  { key: 'filament_flow_ratio', value: ['0.97'], source: 'color', own: true, inherited_value: ['0.98'], inherited_source: 'nozzle' },
  { key: 'nozzle_temperature', value: ['220'], source: 'nozzle', own: false },
  { key: 'hot_plate_temp', value: ['70'], source: 'colorwide', own: false },
  { key: 'filament_start_gcode', value: ['M900 L1000 M10\nM900 K0.035'], source: 'machine', own: false },
  { key: 'filament_density', value: ['1.27'], source: 'bambu', own: false, source_label: 'Bambu PETG Basic @BBL H2S 0.6 nozzle' },
];

const getTrees = vi.mocked(api.getFilamentTrees);
const getNode = vi.mocked(api.getFilamentTreeNode);
const setNode = vi.mocked(api.setFilamentTreeNode);

const expectAllDisabled = () => {
  for (const el of [...screen.getAllByRole('textbox'), ...screen.queryAllByRole('checkbox'), ...screen.queryAllByRole('combobox')]) {
    expect(el).toBeDisabled();
  }
  expect(screen.queryByRole('button', { name: /Use parent/ })).toBeNull();
};

function renderPanel(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  canUpdate = true;
  mockShowToast.mockReset();
  getTrees.mockReset().mockResolvedValue([tree]);
  getNode.mockReset().mockResolvedValue(leafRows);
  setNode.mockReset().mockResolvedValue({ success: true });
});

describe('NodePanel', () => {
  it('shows the breadcrumb and own row with the parent value; Use parent sends clear', async () => {
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    expect(await screen.findByText('Polymaker PETG › H2S › 0.6 › Red')).toBeInTheDocument();
    expect(getNode).toHaveBeenCalledWith(1, { machine: 'H2S', nozzle: '0.6', colorId: 11 });
    expect(screen.getByText('1 modified')).toBeInTheDocument();
    const resetBtn = screen.getByRole('button', { name: 'Use parent: Flow ratio' });
    expect(resetBtn).toHaveAttribute('title', 'Use parent value 0.98 (H2S › 0.6)');
    expect(screen.getByText('Flow ratio')).toHaveClass('text-orange-400');
    fireEvent.click(resetBtn);
    await waitFor(() =>
      expect(setNode).toHaveBeenCalledWith(1, { machine: 'H2S', nozzle: '0.6', color_id: 11, clear: ['filament_flow_ratio'] }),
    );
  });

  it('shows the parent value in grey beside an own value', async () => {
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    expect(await screen.findByText('parent 0.98')).toBeInTheDocument();
  });

  it('JSON tab shows the generated Orca profile for a leaf, and the own values', async () => {
    vi.mocked(api.getFilamentPresets).mockResolvedValue([
      { id: 9, name: 'Polymaker PETG - Red @H2S 0.6', brand: '', material: '', color: '', color_hex: '', filename: '', content: '{"inherits": "Bambu PETG Basic @BBL H2S 0.6 nozzle"}' },
    ]);
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    await screen.findByText('Polymaker PETG › H2S › 0.6 › Red');
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    expect(await screen.findByText(/Bambu PETG Basic @BBL H2S 0\.6 nozzle/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set at this level' }));
    expect(screen.getByLabelText('Set at this level')).toHaveTextContent('"filament_flow_ratio"');
    expect(screen.getByLabelText('Set at this level')).not.toHaveTextContent('nozzle_temperature');
  });

  it('labels inherited rows with their source', async () => {
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    const lock = await screen.findByRole('img', { name: 'from H2S › 0.6' });
    expect(lock).toHaveAttribute('title', 'from H2S › 0.6');
    expect(screen.getAllByRole('img', { name: 'from Red (all machines)' })).toHaveLength(1);
    expect(screen.getByRole('img', { name: 'from Bambu PETG Basic @BBL H2S 0.6 nozzle' })).toBeInTheDocument();
    expect(screen.getByText('Nozzle')).not.toHaveClass('text-orange-400');
  });

  it('saves an edited value with set, keeping the array shape', async () => {
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    const input = await screen.findByRole('textbox', { name: 'Nozzle (Other layers)' });
    fireEvent.change(input, { target: { value: '225' } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(setNode).toHaveBeenCalledWith(1, { machine: 'H2S', nozzle: '0.6', color_id: 11, set: { nozzle_temperature: ['225'] } }),
    );
  });

  it('edits pressure advance inside the start G-code', async () => {
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    const pa = await screen.findByRole('textbox', { name: 'Pressure advance (K)' });
    expect(pa).toHaveValue('0.035');
    fireEvent.change(pa, { target: { value: '0.028' } });
    fireEvent.blur(pa);
    await waitFor(() =>
      expect(setNode).toHaveBeenCalledWith(1, {
        machine: 'H2S',
        nozzle: '0.6',
        color_id: 11,
        set: { filament_start_gcode: ['M900 L1000 M10\nM900 K0.028'] },
      }),
    );
  });

  it('toasts the backend message when a save is refused', async () => {
    setNode.mockRejectedValue(new Error('nozzle-bound key'));
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use parent: Flow ratio' }));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('nozzle-bound key', 'error'));
  });

  it('makes the calibration-source leaf read-only', async () => {
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'X2D', nozzle: '0.4', colorId: 10 }} />);
    expect(await screen.findByText('Edit the root to change the calibrated profile')).toBeInTheDocument();
    await screen.findByRole('textbox', { name: 'Flow ratio' });
    expectAllDisabled();
    expect(screen.queryByRole('button', { name: /Use parent/ })).toBeNull();
  });

  it('hides write controls without filaments:update', async () => {
    canUpdate = false;
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    await screen.findByText('Polymaker PETG › H2S › 0.6 › Red');
    await screen.findByRole('img', { name: 'from H2S › 0.6' });
    expectAllDisabled();
    expect(screen.queryByRole('button', { name: /Use parent/ })).toBeNull();
  });

  it('root has no PA input and hides nozzle-bound keys', async () => {
    getNode.mockResolvedValue([
      { key: 'nozzle_temperature', value: ['230'], source: 'root', own: true },
      { key: 'filament_max_volumetric_speed', value: ['20'], source: 'root', own: true },
    ]);
    renderPanel(<NodePanel node={{ treeId: 1 }} />);
    expect(await screen.findByRole('textbox', { name: 'Nozzle (Other layers)' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Pressure advance (K)' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Max volumetric speed' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Max volumetric speed' })).toHaveValue('20');
    expect(screen.getAllByText('Set per machine/nozzle').length).toBeGreaterThan(0);
  });

  it('colour-wide breadcrumb, source colour-wide node is read-only', async () => {
    getNode.mockResolvedValue([{ key: 'nozzle_temperature', value: ['230'], source: 'root', own: false }]);
    renderPanel(<NodePanel node={{ treeId: 1, colorId: 10 }} />);
    expect(await screen.findByText('Polymaker PETG › White (all machines)')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'from Polymaker PETG' })).toBeInTheDocument();
    expectAllDisabled();
  });

  it('accepts a comma decimal for pressure advance', async () => {
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    const pa = await screen.findByRole('textbox', { name: 'Pressure advance (K)' });
    fireEvent.change(pa, { target: { value: '0,028' } });
    fireEvent.blur(pa);
    await waitFor(() =>
      expect(setNode).toHaveBeenCalledWith(1, {
        machine: 'H2S',
        nozzle: '0.6',
        color_id: 11,
        set: { filament_start_gcode: ['M900 L1000 M10\nM900 K0.028'] },
      }),
    );
  });

  it('refuses a non-numeric pressure advance and resets the input', async () => {
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    const pa = await screen.findByRole('textbox', { name: 'Pressure advance (K)' });
    fireEvent.change(pa, { target: { value: 'abc' } });
    fireEvent.blur(pa);
    expect(mockShowToast).toHaveBeenCalledWith('Pressure advance must be a number, like 0.028', 'error');
    expect(setNode).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Pressure advance (K)' })).toHaveValue('0.035');
  });

  it('labels each entry of a per-variant value with its extruder variant', async () => {
    getNode.mockResolvedValue([
      {
        key: 'filament_flow_ratio',
        value: ['0.95', '0.98'],
        source: 'bambu',
        own: false,
        variants: ['Direct Drive Standard', 'Direct Drive High Flow'],
      },
    ]);
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    expect(await screen.findByRole('textbox', { name: 'Flow ratio 2' })).toHaveValue('0.98');
    expect(screen.getByText('Direct Drive Standard')).toBeInTheDocument();
    expect(screen.getByText('Direct Drive High Flow')).toBeInTheDocument();
  });

  it('edits one element of a multi-element value and keeps the others verbatim', async () => {
    const both = ['G1 X1, Y2\nM900 K0.03', 'a, b'];
    getNode.mockResolvedValue([{ key: 'filament_end_gcode', value: both, source: 'machine', own: false }]);
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Advanced' }));
    const first = await screen.findByRole('textbox', { name: 'Filament end G-code 1' });
    expect(first.tagName).toBe('TEXTAREA');
    expect(first).toHaveValue(both[0]);
    const second = screen.getByRole('textbox', { name: 'Filament end G-code 2' });
    fireEvent.change(second, { target: { value: 'a, c' } });
    fireEvent.blur(second);
    await waitFor(() =>
      expect(setNode).toHaveBeenCalledWith(1, {
        machine: 'H2S',
        nozzle: '0.6',
        color_id: 11,
        set: { filament_end_gcode: [both[0], 'a, c'] },
      }),
    );
  });

  it('non-source colour-wide node has value inputs but no PA input', async () => {
    getNode.mockResolvedValue([{ key: 'nozzle_temperature', value: ['230'], source: 'root', own: false }]);
    renderPanel(<NodePanel node={{ treeId: 1, colorId: 11 }} />);
    expect(await screen.findByText('Polymaker PETG › Red (all machines)')).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: 'Nozzle (Other layers)' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Nozzle (Other layers)' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Pressure advance (K)' })).toBeDisabled();
  });

  it('a failed save resets only the failing row and keeps other drafts', async () => {
    setNode.mockRejectedValue(new Error('refused'));
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    const temp = await screen.findByRole('textbox', { name: 'Nozzle (Other layers)' });
    const flow = screen.getByRole('textbox', { name: 'Flow ratio' });
    fireEvent.change(flow, { target: { value: '0.95' } }); // draft, not committed
    fireEvent.change(temp, { target: { value: '999' } });
    fireEvent.blur(temp);
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('refused', 'error'));
    expect(screen.getByRole('textbox', { name: 'Nozzle (Other layers)' })).toHaveValue('220');
    expect(screen.getByRole('textbox', { name: 'Flow ratio' })).toHaveValue('0.95');
  });
  it('switches tabs and remembers the last one', async () => {
    const { unmount } = renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    expect(await screen.findByRole('tab', { name: 'Filament' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Cooling' }));
    expect(screen.getByRole('tab', { name: 'Cooling' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Part cooling fan')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Flow ratio' })).toBeNull();
    unmount();
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    expect(await screen.findByRole('tab', { name: 'Cooling' })).toHaveAttribute('aria-selected', 'true');
  });

  it('the bed temperature grid writes the first-layer key, as a new array value', async () => {
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    const cell = await screen.findByRole('textbox', { name: 'Smooth PEI Plate / High Temp Plate (First layer)' });
    expect(cell).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Smooth PEI Plate / High Temp Plate (Other layers)' })).toHaveValue('70');
    fireEvent.change(cell, { target: { value: '75' } });
    fireEvent.blur(cell);
    await waitFor(() =>
      expect(setNode).toHaveBeenCalledWith(1, {
        machine: 'H2S',
        nozzle: '0.6',
        color_id: 11,
        set: { hot_plate_temp_initial_layer: ['75'] },
      }),
    );
  });

  it('a flag renders as a checkbox writing "1"/"0" in the stored shape', async () => {
    getNode.mockResolvedValue([
      { key: 'enable_pressure_advance', value: ['0'], source: 'nozzle', own: false },
      { key: 'filament_soluble', value: '1', source: 'root', own: false },
    ]);
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    const pa = await screen.findByRole('checkbox', { name: 'Enable pressure advance' });
    expect(pa).not.toBeChecked();
    fireEvent.click(pa);
    await waitFor(() =>
      expect(setNode).toHaveBeenCalledWith(1, expect.objectContaining({ set: { enable_pressure_advance: ['1'] } })),
    );
    const soluble = screen.getByRole('checkbox', { name: 'Soluble material' });
    expect(soluble).toBeChecked();
    fireEvent.click(soluble);
    await waitFor(() => expect(setNode).toHaveBeenCalledWith(1, expect.objectContaining({ set: { filament_soluble: '0' } })));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Support material' }));
    await waitFor(() => expect(setNode).toHaveBeenCalledWith(1, expect.objectContaining({ set: { filament_is_support: ['1'] } })));
  });

  it('lists unmapped keys under Advanced › Other by their raw key', async () => {
    getNode.mockResolvedValue([
      ...leafRows,
      { key: 'filament_flush_temp', value: ['240'], source: 'machine', own: false },
    ]);
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Advanced' }));
    expect(screen.getByText('Other')).toBeInTheDocument();
    const other = screen.getByRole('textbox', { name: 'filament_flush_temp' });
    expect(other).toHaveValue('240');
    fireEvent.change(other, { target: { value: '250' } });
    fireEvent.blur(other);
    await waitFor(() => expect(setNode).toHaveBeenCalledWith(1, expect.objectContaining({ set: { filament_flush_temp: ['250'] } })));
    expect(screen.queryByRole('textbox', { name: 'filament_density' })).toBeNull();
  });

  it('setting overrides: tick opens an empty row, untick clears an own value, inherited ones stay ticked', async () => {
    getNode.mockResolvedValue([
      { key: 'filament_retraction_length', value: ['0.4'], source: 'color', own: true, inherited_value: ['0.8'], inherited_source: 'root' },
      { key: 'filament_wipe_distance', value: ['2'], source: 'machine', own: false },
    ]);
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Setting Overrides' }));
    const zHop = screen.getByRole('textbox', { name: 'Z-hop height' });
    expect(zHop).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Override Z-hop height' }));
    expect(zHop).toBeEnabled();
    fireEvent.change(zHop, { target: { value: '0.6' } });
    fireEvent.blur(zHop);
    await waitFor(() => expect(setNode).toHaveBeenCalledWith(1, expect.objectContaining({ set: { filament_z_hop: ['0.6'] } })));
    const wipe = screen.getByRole('checkbox', { name: 'Override Wipe distance' });
    expect(wipe).toBeChecked();
    expect(wipe).toBeDisabled();
    expect(wipe).toHaveAttribute('title', 'from H2S');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Override Length' }));
    await waitFor(() =>
      expect(setNode).toHaveBeenCalledWith(1, expect.objectContaining({ clear: ['filament_retraction_length'] })),
    );
  });

  it('shows the compatible printer and Bambu base on Dependencies', async () => {
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Dependencies' }));
    expect(await screen.findByText('Bambu PETG Basic @BBL H2S 0.6 nozzle')).toBeInTheDocument();
    expect(screen.getByText('Bambu Lab H2S 0.6 nozzle')).toBeInTheDocument();
  });
});
