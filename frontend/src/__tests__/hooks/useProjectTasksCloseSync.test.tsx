import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { ToastProvider } from '../../contexts/ToastContext';
import { useProjectTasks } from '../../hooks/useProjectTasks';

/** The close-of-panel Zoho sync.
 *
 *  The backend's edit window is FIXED — a task PATCH made while one is
 *  already open does not extend it — so the push a card owes Books routinely
 *  fires while the operator is still filling the task in, and the one that
 *  would carry the finished content waits out the full 300s poll. The panel
 *  closing is the moment the card is known to be done, so that is when it
 *  asks for the push.
 *
 *  It must fire on the LAST of (panel closed, every write settled), and only
 *  when something was actually written — which is exactly the arbitration the
 *  hook already runs for its board refresh, reused rather than rebuilt. */

const ROW = {
  id: 7,
  project_id: 1,
  position: 0,
  title: 'a',
  scan_description: null,
  scan_cost: null,
  modelisation_cost: null,
  usinage_cost: null,
  impression_printer_id: null,
  impression_filament_id: null,
  impression_weight_g: null,
  impression_time_min: null,
  impression_quantity: 1,
  impression_color: null,
  impression_cost: null,
  scan_done: false,
  modelisation_done: false,
  impression_done: false,
  usinage_done: false,
  created_at: '2026-07-29T00:00:00',
  updated_at: '2026-07-29T00:00:00',
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

let onDirtyClose: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  onDirtyClose = vi.fn();
  vi.spyOn(api, 'getAitoTasks').mockResolvedValue([ROW]);
  vi.spyOn(api, 'updateAitoTask').mockImplementation(async (_id, patch) => ({ ...ROW, ...patch }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mounted() {
  const view = renderHook(() => useProjectTasks(1, { onDirtyClose }), { wrapper });
  await waitFor(() => expect(view.result.current.tasks).toHaveLength(1));
  return view;
}

describe('useProjectTasks close sync', () => {
  it('asks for a sync when a card that was edited closes', async () => {
    const { result, unmount } = await mounted();

    act(() => {
      result.current.onTasksChange([{ ...result.current.tasks[0], scanCost: 1200 }]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    unmount();

    await waitFor(() => expect(onDirtyClose).toHaveBeenCalledTimes(1));
  });

  it('costs nothing when a card is opened and closed without an edit', async () => {
    // The whole reason this is gated on the dirty flag rather than fired
    // unconditionally: a push spends a Books call, and the 300s poll interval
    // exists because that quota is small. Looking at a card must be free.
    const { unmount } = await mounted();

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onDirtyClose).not.toHaveBeenCalled();
  });

  it('waits for an in-flight patch to land before asking, and asks exactly once', async () => {
    // "Closed" and "the last PATCH settled" are independent events in either
    // order. Asking before the write lands would queue a push that cannot
    // include it; asking on both events would spend two.
    let settle: (row: typeof ROW) => void = () => {};
    vi.spyOn(api, 'updateAitoTask').mockImplementation(
      () => new Promise((resolve) => (settle = resolve as (row: typeof ROW) => void)),
    );
    const { result, unmount } = await mounted();

    act(() => {
      result.current.onTasksChange([{ ...result.current.tasks[0], scanCost: 1200 }]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    unmount();
    expect(onDirtyClose).not.toHaveBeenCalled();

    await act(async () => {
      settle({ ...ROW, scan_cost: 1200 });
    });
    await waitFor(() => expect(onDirtyClose).toHaveBeenCalledTimes(1));
  });
});
