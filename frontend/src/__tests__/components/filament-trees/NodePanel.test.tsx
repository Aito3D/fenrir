import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { NodePanel } from '../../../components/filament-trees/NodePanel';
import { api } from '../../../api/client';
import type { FilamentTreeNodeRow, FilamentTreeSummary } from '../../../api/client';

vi.mock('../../../api/client', () => ({
  api: { getFilamentTrees: vi.fn(), getFilamentTreeNode: vi.fn(), setFilamentTreeNode: vi.fn() },
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

function renderPanel(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
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
    expect(screen.getByText('own')).toBeInTheDocument();
    expect(screen.getByText('parent 0.98')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use parent: Flow ratio' }));
    await waitFor(() =>
      expect(setNode).toHaveBeenCalledWith(1, { machine: 'H2S', nozzle: '0.6', color_id: 11, clear: ['filament_flow_ratio'] }),
    );
  });

  it('labels inherited rows with their source', async () => {
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    expect(await screen.findByText('from H2S › 0.6')).toBeInTheDocument();
    expect(screen.getByText('from Red (all machines)')).toBeInTheDocument();
    expect(screen.getByText('from Bambu H2S 0.6')).toBeInTheDocument();
  });

  it('saves an edited value with set, keeping the array shape', async () => {
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    const input = await screen.findByRole('textbox', { name: 'Print' });
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
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Use parent/ })).toBeNull();
  });

  it('hides write controls without filaments:update', async () => {
    canUpdate = false;
    renderPanel(<NodePanel node={{ treeId: 1, machine: 'H2S', nozzle: '0.6', colorId: 11 }} />);
    await screen.findByText('Polymaker PETG › H2S › 0.6 › Red');
    await screen.findByText('from H2S › 0.6');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Use parent/ })).toBeNull();
  });

  it('root has no PA input and hides nozzle-bound keys', async () => {
    getNode.mockResolvedValue([
      { key: 'nozzle_temperature', value: ['230'], source: 'root', own: true },
      { key: 'filament_max_volumetric_speed', value: ['20'], source: 'root', own: true },
    ]);
    renderPanel(<NodePanel node={{ treeId: 1 }} />);
    expect(await screen.findByRole('textbox', { name: 'Print' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Pressure advance (K)' })).toBeNull();
    expect(screen.queryByText('filament_max_volumetric_speed')).toBeNull();
  });

  it('colour-wide breadcrumb, source colour-wide node is read-only', async () => {
    getNode.mockResolvedValue([{ key: 'nozzle_temperature', value: ['230'], source: 'root', own: false }]);
    renderPanel(<NodePanel node={{ treeId: 1, colorId: 10 }} />);
    expect(await screen.findByText('Polymaker PETG › White (all machines)')).toBeInTheDocument();
    expect(await screen.findByText('from Polymaker PETG')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
