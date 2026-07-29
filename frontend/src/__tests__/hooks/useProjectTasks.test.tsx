import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { ToastProvider } from '../../contexts/ToastContext';
import { useProjectTasks } from '../../hooks/useProjectTasks';

const ROW = {
  id: 7,
  project_id: 1,
  position: 0,
  title: 'a',
  description: null,
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

let updateAitoTask: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(api, 'getAitoTasks').mockResolvedValue([ROW]);
  updateAitoTask = vi.spyOn(api, 'updateAitoTask').mockImplementation(async (_id, patch) => ({
    ...ROW,
    ...patch,
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mounted() {
  const view = renderHook(() => useProjectTasks(1), { wrapper });
  await waitFor(() => expect(view.result.current.tasks).toHaveLength(1));
  return view;
}

describe('useProjectTasks', () => {
  it('sends one PATCH for a burst of keystrokes', async () => {
    const { result } = await mounted();

    for (const value of [4, 40, 400, 4000]) {
      act(() => {
        result.current.onTasksChange([{ ...result.current.tasks[0], scanCost: value }]);
      });
    }
    expect(updateAitoTask).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(updateAitoTask).toHaveBeenCalledTimes(1);
    expect(updateAitoTask).toHaveBeenCalledWith(7, { scan_cost: 4000 });
  });

  it('merges edits to different fields into one patch', async () => {
    const { result } = await mounted();

    act(() => {
      result.current.onTasksChange([{ ...result.current.tasks[0], scanCost: 500 }]);
    });
    act(() => {
      result.current.onTasksChange([{ ...result.current.tasks[0], title: 'renamed' }]);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(updateAitoTask).toHaveBeenCalledTimes(1);
    expect(updateAitoTask).toHaveBeenCalledWith(7, { scan_cost: 500, title: 'renamed' });
  });

  it('flushes early on blur, without waiting out the timer', async () => {
    const { result } = await mounted();

    act(() => {
      result.current.onTasksChange([{ ...result.current.tasks[0], scanCost: 900 }]);
    });
    act(() => {
      result.current.onRowBlur(7);
    });

    await waitFor(() => expect(updateAitoTask).toHaveBeenCalledTimes(1));
    expect(updateAitoTask).toHaveBeenCalledWith(7, { scan_cost: 900 });

    // The timer must not fire a second, duplicate PATCH.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(updateAitoTask).toHaveBeenCalledTimes(1);
  });

  it('flushes on close so an edit is never lost', async () => {
    const { result } = await mounted();

    act(() => {
      result.current.onTasksChange([{ ...result.current.tasks[0], scanCost: 1200 }]);
    });
    act(() => {
      result.current.markClosed();
    });

    await waitFor(() => expect(updateAitoTask).toHaveBeenCalledWith(7, { scan_cost: 1200 }));
  });

  it('sends nothing when a field is edited back to its saved value', async () => {
    const { result } = await mounted();

    act(() => {
      result.current.onTasksChange([{ ...result.current.tasks[0], title: 'changed' }]);
    });
    act(() => {
      result.current.onTasksChange([{ ...result.current.tasks[0], title: 'a' }]);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(updateAitoTask).not.toHaveBeenCalled();
  });
});
