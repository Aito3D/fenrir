/**
 * Direct test of useZohoFilamentSync's internal overlapping-walk guard
 * (T-031). CalculatorSettingsPanels.test.tsx's "keeps the guard and progress
 * alive across an unmount/remount and blocks a second overlapping walk" test
 * only ever drives the second attempt via `userEvent.click` on a button that
 * is already `disabled` — Testing Library never dispatches a click on a
 * disabled element, so `runSync` is never actually re-entered there and the
 * guard's own early-return (`if (queryClient.getQueryData(...)) return;`)
 * never runs; that test would still pass with the guard deleted.
 *
 * This test calls the hook's `runSync` directly, twice back-to-back without
 * awaiting the first, bypassing the button (and its `disabled` prop)
 * entirely so the guard itself is what's being pinned.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useZohoFilamentSync } from '../../../components/calculator/useZohoFilamentSync';
import { api } from '../../../api/client';
import type { CalculatorFilamentSyncResult } from '../../../api/client';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useZohoFilamentSync overlapping-walk guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ignores a second runSync() call started before the first has finished its first chunk', async () => {
    // Never resolves during this test: the guard, not a completed walk, must
    // be what stops the second call from issuing its own chunk request.
    const sync = vi
      .spyOn(api, 'syncCalculatorFilamentsFromZoho')
      .mockReturnValue(new Promise<CalculatorFilamentSyncResult>(() => {}));

    const { result } = renderHook(() => useZohoFilamentSync([]), { wrapper: createWrapper() });

    await act(async () => {
      // Deliberately not awaited: the first call must still be inside its
      // guard window (progress already written to the QueryClient, first
      // chunk request in flight) when the second call runs its own guard
      // check, synchronously, in the same tick.
      void result.current.runSync();
      void result.current.runSync();
    });

    expect(sync).toHaveBeenCalledTimes(1);
  });
});
