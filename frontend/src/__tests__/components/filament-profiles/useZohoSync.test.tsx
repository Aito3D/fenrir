import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, ApiError } from '../../../api/client';
import type { FilamentPresetZohoSyncResponse } from '../../../api/client';
import { useZohoSync } from '../../../components/filament-profiles/useZohoSync';

const showToast = vi.fn();
vi.mock('../../../contexts/ToastContext', () => ({ useToast: () => ({ showToast }) }));

const result = (over: Partial<FilamentPresetZohoSyncResponse> = {}): FilamentPresetZohoSyncResponse => ({
  priced: 3,
  unchanged: 2,
  attention: [],
  attention_total: 0,
  catalogue_stale_since: null,
  ...over,
});

function setup() {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { invalidate, ...renderHook(() => useZohoSync(), { wrapper }) };
}

function expectInvalidatedBoth(invalidate: ReturnType<typeof setup>['invalidate']) {
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['filamentPresets'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['filament-trees'] });
}

describe('useZohoSync.handleZohoSync', () => {
  beforeEach(() => showToast.mockClear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('shows a success toast and keeps the result on a clean sync', async () => {
    vi.spyOn(api, 'syncFilamentPresetsFromZoho').mockResolvedValue(result());
    const { result: hook, invalidate } = setup();
    await act(() => hook.current.handleZohoSync());
    expect(showToast).toHaveBeenCalledWith('Priced 3, unchanged 2', 'success');
    expect(hook.current.zohoResult).toEqual(result());
    expect(hook.current.zohoSyncing).toBe(false);
    expectInvalidatedBoth(invalidate);
  });

  it('downgrades to a warning and reports the count when profiles need attention', async () => {
    vi.spyOn(api, 'syncFilamentPresetsFromZoho').mockResolvedValue(result({ attention_total: 4 }));
    const { result: hook } = setup();
    await act(() => hook.current.handleZohoSync());
    expect(showToast).toHaveBeenCalledWith('Priced 3, unchanged 2 — 4 need attention', 'warning');
  });

  it('warns when nothing was priced or unchanged', async () => {
    vi.spyOn(api, 'syncFilamentPresetsFromZoho').mockResolvedValue(result({ priced: 0, unchanged: 0 }));
    const { result: hook } = setup();
    await act(() => hook.current.handleZohoSync());
    expect(showToast).toHaveBeenCalledWith('Priced 0, unchanged 0', 'warning');
  });

  it('discloses a stale catalogue in the warning toast', async () => {
    const since = '2026-01-02T03:04:05Z';
    vi.spyOn(api, 'syncFilamentPresetsFromZoho').mockResolvedValue(result({ catalogue_stale_since: since }));
    const { result: hook } = setup();
    await act(() => hook.current.handleZohoSync());
    const [message, severity] = showToast.mock.calls[0];
    expect(severity).toBe('warning');
    expect(message).toContain(new Date(since).toLocaleString());
    expect(message).toContain('Zoho was unreachable');
  });

  it('shows the server message for an ApiError and clears the result', async () => {
    vi.spyOn(api, 'syncFilamentPresetsFromZoho').mockRejectedValue(new ApiError('Zoho down', 502));
    const { result: hook, invalidate } = setup();
    await act(() => hook.current.handleZohoSync());
    expect(showToast).toHaveBeenCalledWith('Zoho down', 'error');
    expect(hook.current.zohoResult).toBeNull();
    expectInvalidatedBoth(invalidate);
  });

  it('shows the unknown-outcome toast on a lost response', async () => {
    vi.spyOn(api, 'syncFilamentPresetsFromZoho').mockRejectedValue(new TypeError('Failed to fetch'));
    const { result: hook, invalidate } = setup();
    await act(() => hook.current.handleZohoSync());
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Sync result unknown'), 'error');
    expectInvalidatedBoth(invalidate);
  });

  it('aborts the request at the 600 s deadline and reports an unknown outcome', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.spyOn(api, 'syncFilamentPresetsFromZoho').mockImplementation(
      (s) =>
        new Promise((_, reject) => {
          signal = s;
          s?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const { result: hook, invalidate } = setup();
    let pending!: Promise<void>;
    act(() => {
      pending = hook.current.handleZohoSync();
    });
    expect(hook.current.zohoSyncing).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(599_999);
    });
    expect(signal?.aborted).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await pending;
    });
    expect(signal?.aborted).toBe(true);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Sync result unknown'), 'error');
    expect(hook.current.zohoSyncing).toBe(false);
    expectInvalidatedBoth(invalidate);
  });
});
