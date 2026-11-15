import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../api/client';
import { downloadTreeExport } from '../../../components/filament-trees/exportDownload';

describe('downloadTreeExport', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('confirms the export only after the file was saved', async () => {
    const order: string[] = [];
    vi.spyOn(api, 'exportFilamentTrees').mockResolvedValue({ blob: new Blob(['z']), token: 'tok' });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => void order.push('click'));
    const confirm = vi.spyOn(api, 'confirmFilamentTreeExport').mockImplementation(async () => {
      order.push('confirm');
      return { confirmed: 1 };
    });
    await downloadTreeExport(3, true);
    expect(confirm).toHaveBeenCalledWith('tok');
    expect(order).toEqual(['click', 'confirm']);
  });

  it('does not confirm when the export request fails', async () => {
    vi.spyOn(api, 'exportFilamentTrees').mockRejectedValue(new Error('HTTP 500'));
    const confirm = vi.spyOn(api, 'confirmFilamentTreeExport');
    await expect(downloadTreeExport()).rejects.toThrow('HTTP 500');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('surfaces a failed confirm to the caller', async () => {
    vi.spyOn(api, 'exportFilamentTrees').mockResolvedValue({ blob: new Blob(['z']), token: 'tok' });
    vi.spyOn(api, 'confirmFilamentTreeExport').mockRejectedValue(new Error('unknown export token'));
    await expect(downloadTreeExport()).rejects.toThrow('unknown export token');
  });
});
