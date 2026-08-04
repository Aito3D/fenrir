import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../api/client';
import { ToastProvider } from '../../contexts/ToastContext';
import { useProjectTasks } from '../../hooks/useProjectTasks';

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
    // Driven through the hook's own unmount cleanup (see the deliberately
    // empty-deps effect at the bottom of useProjectTasks.ts) rather than a
    // `markClosed` escape hatch: nothing in production calls `markClosed`
    // any more (ProjectDetailPanel relies solely on unmounting to close),
    // so exercising it here would no longer cover the real close path.
    const { result, unmount } = await mounted();

    act(() => {
      result.current.onTasksChange([{ ...result.current.tasks[0], scanCost: 1200 }]);
    });
    unmount();

    await waitFor(() => expect(updateAitoTask).toHaveBeenCalledWith(7, { scan_cost: 1200 }));
  });

  it('does not clobber a pending draft on a mid-debounce tasks refetch, and does not reapply that stale snapshot once the patch settles', async () => {
    // Regression for the unconditional resync effect: a refetch landing while
    // an edit is still debounced (refetchOnWindowFocus, or another row's
    // add/delete invalidating ['aito-tasks', id]) used to overwrite the
    // in-progress draft AND reset the diff baseline to the pre-edit row.
    //
    // The guard that SKIPS the resync while the edit is pending is correct
    // (asserted right after the mid-debounce refetch below) — but the
    // RECOVERY was not: once the debounce flushes and the PATCH settles, the
    // generation bump re-runs this effect, and it used to apply that exact
    // stale, pre-edit snapshot — still sitting in the cache from the
    // mid-debounce refetch — straight over the value that had just saved.
    // That is observed directly below with no re-mocking in between, which
    // is the point: a version of this test that re-mocks a *third*,
    // already-correct fetch before checking anything is blind to the bug,
    // since the apply happens and un-happens between those two lines
    // without either being observed.
    //
    // The mock is stateful (mirrors a real backend) rather than a queue of
    // canned responses: the fix's own recovery path issues a genuine GET
    // when it detects a stale snapshot, and that GET must return realistic
    // data for the assertions on it to mean anything.
    let capturedClient: QueryClient | undefined;
    function isolatedWrapper({ children }: { children: ReactNode }) {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      capturedClient = client;
      return (
        <QueryClientProvider client={client}>
          <ToastProvider>{children}</ToastProvider>
        </QueryClientProvider>
      );
    }

    let serverTitle = ROW.title;
    let serverDescription: string | null = ROW.scan_description;
    vi.mocked(api.getAitoTasks).mockImplementation(async () => [
      { ...ROW, title: serverTitle, scan_description: serverDescription },
    ]);
    updateAitoTask.mockImplementation(async (_id, patch: Record<string, unknown>) => {
      if ('title' in patch) serverTitle = patch.title as string;
      if ('scan_description' in patch) serverDescription = patch.scan_description as string | null;
      return { ...ROW, title: serverTitle, scan_description: serverDescription };
    });

    const view = renderHook(() => useProjectTasks(1), { wrapper: isolatedWrapper });
    await waitFor(() => expect(view.result.current.tasks).toHaveLength(1));

    act(() => {
      view.result.current.onTasksChange([{ ...view.result.current.tasks[0], title: 'draft' }]);
    });
    expect(view.result.current.tasks[0].title).toBe('draft');

    // The refetch lands before the debounce has flushed, so the server still
    // reports the pre-edit row (plus some unrelated field the guard must not
    // let through either, since it replaces the whole row).
    serverDescription = 'server changed elsewhere';
    await act(async () => {
      await capturedClient!.refetchQueries({ queryKey: ['aito-tasks', 1] });
    });
    expect(view.result.current.tasks[0].title).toBe('draft');
    expect(updateAitoTask).not.toHaveBeenCalled();

    // Flush the debounced patch. It succeeds...
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(updateAitoTask).toHaveBeenCalledWith(7, { title: 'draft' });

    // ...but the resync effect's generation bump fires right after, and the
    // cached `tasksQuery.data` it would apply is still the stale mid-debounce
    // snapshot fetched above (title 'a') — older than this save. This is the
    // exact regression: it must not reappear on screen.
    expect(view.result.current.tasks[0].title).toBe('draft');

    // A later, genuine refetch (post-settle) is still allowed through and
    // picks up whatever else changed server-side meanwhile.
    serverDescription = 'synced';
    await act(async () => {
      await capturedClient!.refetchQueries({ queryKey: ['aito-tasks', 1] });
    });
    await waitFor(() => expect(view.result.current.tasks[0].scanDescription).toBe('synced'));
    expect(view.result.current.tasks[0].title).toBe('draft');
  });

  it('caps the stale-snapshot recovery at one invalidate per save, even if the clock steps backwards', async () => {
    // Regression for the missing attempt cap on the invalidate-instead-of-
    // apply path: if Date.now() moves backwards after a save stamps
    // `lastSaveAtRef` (an NTP correction, or a user changing the system
    // clock), EVERY subsequent fetch lands with `dataUpdatedAt` reading
    // before that stamp. Each landing changes `dataUpdatedAt`, which is an
    // effect dependency, so an uncapped recovery invalidates on every single
    // one of them -- an unthrottled GET loop with no backoff. The fix caps
    // recovery to one invalidate per save stamp; a second stale landing for
    // the same stamp falls through and applies the snapshot instead.
    //
    // `invalidateQueries` is replaced (not just spied on) so the two fetches
    // below are the only ones in play -- letting the real implementation
    // through would also trigger its own active-query refetch, which is the
    // production loop this bug describes and is exactly what the cap exists
    // to prevent, but is not what this test is trying to observe.
    let capturedClient: QueryClient | undefined;
    function isolatedWrapper({ children }: { children: ReactNode }) {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      capturedClient = client;
      return (
        <QueryClientProvider client={client}>
          <ToastProvider>{children}</ToastProvider>
        </QueryClientProvider>
      );
    }

    // Distinct content on every call: `mockResolvedValue` would hand back the
    // exact same reference every time, and even a fresh-but-identical object
    // gets collapsed back to the previous reference by React Query's default
    // structural sharing -- both would satisfy the resync effect's
    // `appliedDataRef.current === tasksQuery.data` guard on the very first
    // refetch below and short-circuit before the staleness check under test
    // is ever reached.
    let fetchCount = 0;
    vi.mocked(api.getAitoTasks).mockImplementation(async () => {
      fetchCount += 1;
      return [{ ...ROW, scan_description: `fetch-${fetchCount}` }];
    });

    const view = renderHook(() => useProjectTasks(1), { wrapper: isolatedWrapper });
    await waitFor(() => expect(view.result.current.tasks).toHaveLength(1));

    // Save a field so `lastSaveAtRef` is stamped at the current (fake) time.
    act(() => {
      view.result.current.onTasksChange([{ ...view.result.current.tasks[0], title: 'saved' }]);
    });
    act(() => {
      view.result.current.onRowBlur(7);
    });
    await waitFor(() => expect(updateAitoTask).toHaveBeenCalledWith(7, { title: 'saved' }));
    // `waitFor` above only confirms the mutation *started* -- `updateAitoTask`
    // is called synchronously by `mutate()`, before its promise resolves.
    // Flush microtasks so `onSuccess` actually runs and stamps
    // `lastSaveAtRef` before the clock is stepped back below; otherwise the
    // stamp would still be its initial 0 and the staleness check under test
    // would never trip, in either the buggy or the fixed code.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Step the clock backwards, as an NTP correction would. Every fetch from
    // here on stamps `dataUpdatedAt` before the save that just landed.
    vi.setSystemTime(Date.now() - 10_000);

    const invalidateSpy = vi.spyOn(capturedClient!, 'invalidateQueries').mockResolvedValue(undefined);

    // Two consecutive fetches, both landing "before" the save under the
    // stepped-back clock -- the exact scenario the uncapped effect used to
    // invalidate on every single time.
    await act(async () => {
      await capturedClient!.refetchQueries({ queryKey: ['aito-tasks', 1] });
      // React Query's notifyManager batches observer notifications via a
      // microtask separate from the fetch promise itself; under fake timers
      // that microtask needs an explicit flush or the hook's effect never
      // re-runs to observe this landing.
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await capturedClient!.refetchQueries({ queryKey: ['aito-tasks', 1] });
      await vi.advanceTimersByTimeAsync(0);
    });

    const tasksInvalidateCalls = invalidateSpy.mock.calls.filter(
      ([filters]) => JSON.stringify(filters) === JSON.stringify({ queryKey: ['aito-tasks', 1] }),
    );
    expect(tasksInvalidateCalls.length).toBeLessThanOrEqual(1);
  });

  it('still reaches the server for a later edit to a task whose earlier flush overlapped a different task\'s flush', async () => {
    // Regression for CRITICAL 1 (the reverted per-task promise chain): all
    // tasks share one `updateTaskMutation` MutationObserver. Calling
    // `mutate()` for task B while task A's PATCH is still open overwrites
    // the observer's single `#mutateOptions` slot and detaches the observer
    // from A's in-flight Mutation (see @tanstack/query-core's
    // `MutationObserver.mutate()`), so a chain built on a per-call
    // `onSettled` resolving that link would leave A's resolver orphaned —
    // its chain link never settles, and every subsequent edit to A is
    // silently dropped for the rest of the panel's lifetime.
    const ROW_B = { ...ROW, id: 8, title: 'b' };
    vi.mocked(api.getAitoTasks).mockResolvedValueOnce([ROW, ROW_B]);

    let resolveA: (task: typeof ROW) => void = () => {};
    const pendingA = new Promise<typeof ROW>((resolve) => {
      resolveA = resolve;
    });
    updateAitoTask.mockImplementation(async (id: number, patch: Record<string, unknown>) => {
      if (id === 7) return pendingA.then((task) => ({ ...task, ...patch }));
      return { ...ROW_B, ...patch };
    });

    const view = renderHook(() => useProjectTasks(1), { wrapper });
    await waitFor(() => expect(view.result.current.tasks).toHaveLength(2));

    // Task A: edit, flush -- PATCH fires and hangs (never resolved yet).
    act(() => {
      view.result.current.onTasksChange([
        { ...view.result.current.tasks[0], title: 'a-edit-1' },
        view.result.current.tasks[1],
      ]);
    });
    act(() => {
      view.result.current.onRowBlur(7);
    });
    await waitFor(() => expect(updateAitoTask).toHaveBeenCalledWith(7, { title: 'a-edit-1' }));

    // Task B: edit, flush -- PATCH fires and resolves immediately, while
    // A's is still open.
    act(() => {
      view.result.current.onTasksChange([
        view.result.current.tasks[0],
        { ...view.result.current.tasks[1], title: 'b-edit' },
      ]);
    });
    act(() => {
      view.result.current.onRowBlur(8);
    });
    await waitFor(() => expect(updateAitoTask).toHaveBeenCalledWith(8, { title: 'b-edit' }));

    // Now release A's PATCH.
    await act(async () => {
      resolveA({ ...ROW, title: 'a-edit-1' });
      await pendingA;
    });

    // Edit A again -- this must reach the server, not be silently dropped.
    act(() => {
      view.result.current.onTasksChange([
        { ...view.result.current.tasks[0], title: 'a-edit-2' },
        view.result.current.tasks[1],
      ]);
    });
    act(() => {
      view.result.current.onRowBlur(7);
    });

    await waitFor(() => expect(updateAitoTask).toHaveBeenCalledWith(7, { title: 'a-edit-2' }));
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

  it('un-ticks a step the server refused with a 422', async () => {
    // The backend's quote-acceptance guard rejects a tick on a project whose
    // quote is not accepted. The checkbox is optimistic, so a toast alone
    // would leave the row rendering as DONE work the server never recorded.
    updateAitoTask.mockRejectedValue(new ApiError('Quote not accepted', 422));
    const { result } = await mounted();

    act(() => {
      result.current.onTasksChange([
        { ...result.current.tasks[0], done: { ...result.current.tasks[0].done, impression: true } },
      ]);
    });
    expect(result.current.tasks[0].done.impression).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(updateAitoTask).toHaveBeenCalledWith(7, { impression_done: true });
    await waitFor(() => expect(result.current.tasks[0].done.impression).toBe(false));
  });

  it('restores a failed delete before its correct neighbour, even when another delete overlaps it', async () => {
    // Regression for IMPORTANT 2: `deleteTaskMutation.onError` used to splice
    // the removed row back in at the numeric INDEX captured at click time.
    // With [A, B, C]: deleting B captures index 1 and leaves [A, C]; deleting
    // A while B's DELETE is still open then leaves [C]. A succeeds, B fails
    // — restoring B at its captured index 1 into [C] produces [C, B],
    // swapping B and C relative to the true original order [B, C]. The fix
    // anchors the restore to the STABLE uid of whichever row followed B at
    // delete time (C), inserting B back in before it wherever it now sits.
    const ROW_A = { ...ROW, id: 7, title: 'a' };
    const ROW_B = { ...ROW, id: 8, title: 'b' };
    const ROW_C = { ...ROW, id: 9, title: 'c' };
    vi.mocked(api.getAitoTasks)
      .mockResolvedValueOnce([ROW_A, ROW_B, ROW_C])
      // A's successful DELETE invalidates ['aito-tasks', 1], and this hook's
      // query is active, so it refetches in the background. A resolved
      // refetch here would resync `tasks` from a (mocked, static) server
      // snapshot mid-race, which is a separate concern from the one under
      // test — left permanently pending so it cannot land during this test.
      .mockImplementation(() => new Promise(() => {}));

    let rejectB: (error: unknown) => void = () => {};
    const pendingB = new Promise<void>((_resolve, reject) => {
      rejectB = reject;
    });
    const deleteAitoTask = vi.spyOn(api, 'deleteAitoTask').mockImplementation((id: number) =>
      id === 8 ? pendingB : Promise.resolve(undefined),
    );

    const view = renderHook(() => useProjectTasks(1), { wrapper });
    await waitFor(() => expect(view.result.current.tasks).toHaveLength(3));

    // Delete B (index 1). Its DELETE hangs.
    act(() => {
      view.result.current.onRemoveTask(1);
    });
    await waitFor(() => expect(deleteAitoTask).toHaveBeenCalledWith(8));
    expect(view.result.current.tasks.map((task) => task.id)).toEqual([7, 9]);

    // Delete A (now at index 0) while B's DELETE is still open. A's own
    // DELETE resolves right away.
    act(() => {
      view.result.current.onRemoveTask(0);
    });
    await waitFor(() => expect(deleteAitoTask).toHaveBeenCalledWith(7));
    await waitFor(() => expect(view.result.current.tasks.map((task) => task.id)).toEqual([9]));

    // Now B's DELETE fails. It must land back before C, not after it.
    await act(async () => {
      rejectB(new Error('nope'));
      await pendingB.catch(() => {});
    });

    await waitFor(() => expect(view.result.current.tasks.map((task) => task.id)).toEqual([8, 9]));
  });

  it('leaves an optimistic edit alone when the failure is not the tick guard', async () => {
    // Only a 422 is the guard. A 500 or an offline PATCH is a transient
    // failure the user should be able to retry from what is still on screen.
    updateAitoTask.mockRejectedValue(new ApiError('boom', 500));
    const { result } = await mounted();

    act(() => {
      result.current.onTasksChange([{ ...result.current.tasks[0], title: 'changed' }]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(result.current.tasks[0].title).toBe('changed');
  });
});
