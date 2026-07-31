import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useOptimisticBoardMutation } from '../../hooks/useOptimisticBoardMutation';
import { __resetBoardSync } from '../../hooks/useBoardSync';
import { flashRevert } from '../../hooks/useRevertFlash';

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
});
