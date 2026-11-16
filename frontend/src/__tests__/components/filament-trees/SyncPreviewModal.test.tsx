import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { api } from '../../../api/client';
import { render } from '../../utils';
import { SyncPreviewModal } from '../../../components/filament-trees/SyncPreviewModal';

describe('SyncPreviewModal', () => {
  const preview = {
    pull: [{ name: 'SUNLU PA - Black @H2D 0.4', changes: { nozzle_temperature: [['240'], ['255']] as [unknown, unknown] } }],
    push: [
      { name: 'Inslogic ASA - Black @H2C 0.2', new: true },
      { name: 'Inslogic ASA - Black @H2C 0.4', new: false },
      { name: 'Loose preset', new: true },
    ],
    remove: ['Ghost PLA - Red @H2D 0.4'],
    conflicts: [
      { name: 'SUNLU PA - Black @H2S 0.4', tree_id: 1, machine: 'H2S', nozzle: '0.4', color_id: 2, key: 'fan_max_speed', fenrir_value: ['80'], orca_value: ['90'] },
    ],
    writable: true,
    fingerprint: 'f',
  };

  it('shows one row per filament with its presets, the pulled values and what is new in Orca', () => {
    render(<SyncPreviewModal preview={preview} onConfirm={vi.fn()} onResolved={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByText('Inslogic ASA - Black')).toHaveLength(1);
    expect(screen.getByText('Loose preset')).toBeInTheDocument();
    expect(screen.getByText('H2C 0.4')).toBeInTheDocument();
    // Orca filaments that are no Fenrir leaf are announced as deletions
    expect(screen.getByText('Ghost PLA - Red')).toBeInTheDocument();
    expect(screen.getByText(/1 filament presets in Orca Cloud .* will be deleted/)).toBeInTheDocument();
    // old value → new value
    expect(screen.getByText('nozzle_temperature')).toBeInTheDocument();
    expect(screen.getByText('240')).toBeInTheDocument();
    expect(screen.getByText('255')).toBeInTheDocument();
    // "Loose preset" is all new; of the two ASA presets only the 0.2 is
    expect(screen.getAllByText('New')).toHaveLength(2);
    expect(screen.queryByText(/read-only/)).not.toBeInTheDocument();
  });

  it('settles a conflict before the run and asks for a fresh plan', async () => {
    const resolve = vi.spyOn(api, 'resolveFilamentTreeConflict').mockResolvedValue({ success: true });
    const onResolved = vi.fn();
    render(<SyncPreviewModal preview={preview} onConfirm={vi.fn()} onResolved={onResolved} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Keep Orca: 90' }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledOnce());
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ key: 'fan_max_speed', value: ['90'], orca_value: ['90'] }));
  });

  it('unticking the deletion confirms a sync that keeps the Orca strays; a read-only pairing is flagged up front', async () => {
    const onConfirm = vi.fn();
    render(<SyncPreviewModal preview={{ ...preview, writable: false }} onConfirm={onConfirm} onResolved={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/read-only, so nothing can be sent or deleted/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });
});
