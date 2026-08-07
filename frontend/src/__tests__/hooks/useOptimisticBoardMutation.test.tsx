import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useOptimisticBoardMutation } from '../../hooks/useOptimisticBoardMutation';
import { __resetBoardSync } from '../../hooks/useBoardSync';
import { flashRevert } from '../../hooks/useRevertFlash';
import { ApiError } from '../../api/client';

// The wrapper imports `flashRevert` as a direct binding, so vi.spyOn on the
// namespace would patch an object nobody reads. Mock the module instead, and
// spread the original so `useIsReverting` stays real.
vi.mock('../../hooks/useRevertFlash', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useRevertFlash')>()),
  flashRevert: vi.fn(),
}));
import type { AitoProject } from '../../api/client';

const card = (id: number, description: string): AitoProject =>
  ({ id, description, column: 'devis', position: 0 }) as AitoProject;

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['aito-projects'], [card(1, 'before')]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe('useOptimisticBoardMutation', () => {
  beforeEach(() => {
    __resetBoardSync();
    vi.restoreAllMocks();
  });

  it('writes the transform to the cache before the request resolves', async () => {
    const { client, wrapper } = harness();
    let release: (v: unknown) => void = () => {};
    const { result } = renderHook(
      () =>
        useOptimisticBoardMutation<unknown, string>({
          mutationFn: () => new Promise((resolve) => { release = resolve; }),
          transform: (previous, text) => (previous ?? []).map((p) => ({ ...p, description: text })),
        }),
      { wrapper },
    );

    act(() => result.current.mutate('after'));
    await waitFor(() => {
      expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].description).toBe('after');
    });
    act(() => release(null));
  });

  it('restores the snapshot and flashes when the request fails', async () => {
    const { client, wrapper } = harness();
    const flash = vi.mocked(flashRevert); // see Task 7 Step 7 for the required vi.mock
    const { result } = renderHook(
      () =>
        useOptimisticBoardMutation<unknown, string>({
          mutationFn: () => Promise.reject(new Error('nope')),
          transform: (previous, text) => (previous ?? []).map((p) => ({ ...p, description: text })),
          flashId: () => 1,
        }),
      { wrapper },
    );

    act(() => result.current.mutate('after'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData<AitoProject[]>(['aito-projects'])![0].description).toBe('before');
    expect(flash).toHaveBeenCalledWith(1);
  });

  it('invalidates once the last write settles', async () => {
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockImplementation(() => Promise.resolve());
    const { result } = renderHook(
      () =>
        useOptimisticBoardMutation<unknown, string>({
          mutationFn: () => Promise.resolve(null),
          transform: (previous) => previous ?? [],
        }),
      { wrapper },
    );

    act(() => result.current.mutate('x'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['aito-projects'] });
  });

  it('invalidates exactly once for two overlapping writes, only after both have settled', async () => {
    // The single-mutation test above never exercises "last": with only one
    // write there is nothing else that could still be pending, so a
    // regression that dropped the shared `scope` (letting two writes' cache
    // snapshots race) or moved `begin()` above the `cancelQueries` await
    // (undercounting how many writes are actually in flight) would slip
    // through it unnoticed.
    const { client, wrapper } = harness();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockImplementation(() => Promise.resolve());
    let aStarted = false;
    let releaseA: (v: unknown) => void = () => {};
    let bStarted = false;
    let releaseB: (v: unknown) => void = () => {};
    const { result } = renderHook(
      () =>
        useOptimisticBoardMutation<unknown, string>({
          mutationFn: (text) =>
            new Promise((resolve) => {
              if (text === 'a') {
                aStarted = true;
                releaseA = resolve;
              } else {
                bStarted = true;
                releaseB = resolve;
              }
            }),
          transform: (previous, text) => (previous ?? []).map((p) => ({ ...p, description: text })),
        }),
      { wrapper },
    );

    // Both writes' `onMutate` (cancel, snapshot, optimistic write, `begin()`)
    // run as soon as `mutate` is called, regardless of the shared scope —
    // only the underlying network call is scope-serialised (see
    // useOptimisticBoardMutation's own doc), so B's `mutationFn` genuinely
    // does not start until A's has settled. Waiting on `aStarted` (rather
    // than asserting synchronously) accounts for `onMutate`'s own
    // `await cancelQueries(...)` before `begin()` runs.
    act(() => {
      result.current.mutate('a');
      result.current.mutate('b');
    });
    await waitFor(() => expect(aStarted).toBe(true));
    expect(bStarted).toBe(false);

    act(() => releaseA(null));
    // Write A alone settling must not invalidate — write B is still pending,
    // and only starts its own network call once A has vacated the scope.
    await waitFor(() => expect(bStarted).toBe(true));
    expect(invalidate).not.toHaveBeenCalled();

    act(() => releaseB(null));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['aito-projects'] });
  });

  it('runs the caller onSuccess with the server data', async () => {
    const { wrapper } = harness();
    const onSuccess = vi.fn();
    const { result } = renderHook(
      () =>
        useOptimisticBoardMutation<string, string>({
          mutationFn: () => Promise.resolve('server said this'),
          transform: (previous) => previous ?? [],
          onSuccess,
        }),
      { wrapper },
    );

    act(() => result.current.mutate('x'));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('server said this', 'x'));
  });

  it('refetches the board when the server reports a 409 conflict', async () => {
    const { client, wrapper } = harness();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(
      () =>
        useOptimisticBoardMutation<unknown, void>({
          mutationFn: () =>
            Promise.reject(new ApiError('conflict', 409, 'version_conflict', { code: 'version_conflict' })),
          transform: (previous) => previous,
        }),
      { wrapper },
    );

    await act(async () => {
      result.current.mutate();
      await waitFor(() => expect(result.current.isError).toBe(true));
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['aito-projects'] });
  });
});
