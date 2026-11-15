import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TreeSettingsPanel } from '../../../components/filament-trees/TreeSettingsPanel';
import { api } from '../../../api/client';
import type { FilamentTreeSummary } from '../../../api/client';

vi.mock('../../../api/client', () => ({ api: { updateFilamentTreeColor: vi.fn() } }));
vi.mock('../../../contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));

const tree: FilamentTreeSummary = {
  id: 1, name: 'Polymaker PETG', brand: 'Polymaker', material: 'PETG', skip_02: null, abrasive: false,
  source: { machine: 'X2D', nozzle: '0.4', color_id: 10 },
  colors: [{ id: 10, name: 'White', hex: '#ffffff' }, { id: 11, name: 'Red', hex: '#dd3333' }],
  own_counts: {},
};

const update = vi.mocked(api.updateFilamentTreeColor);

function renderPanel() {
  const client = new QueryClient();
  return render(<QueryClientProvider client={client}><TreeSettingsPanel tree={tree} /></QueryClientProvider>);
}

describe('TreeSettingsPanel delayed colour save', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    update.mockReset().mockResolvedValue({ success: true } as never);
  });
  afterEach(() => vi.useRealTimers());

  it('a lone recolour sends the unchanged name with the new hex after 400 ms', async () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('Colour of Red'), { target: { value: '#00ff00' } });
    expect(update).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(update).toHaveBeenCalledExactlyOnceWith(1, 11, { name: 'Red', hex: '#00ff00' });
  });

  it('a rename right after a recolour survives: the delayed save sends the new name', async () => {
    // First PATCH (the rename) never settles, so the tree prop still holds the old name.
    update.mockImplementationOnce(() => new Promise(() => {}));
    renderPanel();
    fireEvent.change(screen.getByLabelText('Colour of Red'), { target: { value: '#00ff00' } });
    const name = screen.getByLabelText('Name of Red');
    fireEvent.change(name, { target: { value: 'Noir' } });
    fireEvent.blur(name);
    expect(update).toHaveBeenCalledWith(1, 11, { name: 'Noir', hex: '#dd3333' });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(update).toHaveBeenLastCalledWith(1, 11, { name: 'Noir', hex: '#00ff00' });
  });

  it('flushes a pending recolour on unmount', () => {
    const { unmount } = renderPanel();
    fireEvent.change(screen.getByLabelText('Colour of Red'), { target: { value: '#00ff00' } });
    unmount();
    expect(update).toHaveBeenCalledWith(1, 11, { name: 'Red', hex: '#00ff00' });
  });
});
