/**
 * Tests for useFlagMutation (task T-018): the optimistic write, the
 * server-row settle, and the failure toast were previously exercised only
 * through a spy on `api.setAitoProjectFlag` whose promise always resolved
 * immediately, so none of `transform`, `onSuccess` (settleProject) or
 * `onError` ever ran in any test.
 *
 * Mirrors useContactedMutation.test.tsx's mocks (react-i18next `t` returning
 * the key, ToastContext mocked to `showToastMock`, `flashRevert` mocked as a
 * direct binding since the wrapper imports it that way) and its
 * manually-released-promise pattern for observing the optimistic write
 * before the mocked request settles.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFlagMutation } from '../../hooks/useFlagMutation';
import { __resetBoardSync } from '../../hooks/useBoardSync';
import { flashRevert } from '../../hooks/useRevertFlash';
import { api, type AitoProject } from '../../api/client';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const showToastMock = vi.fn();
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

// The wrapper imports `flashRevert` as a direct binding, so vi.spyOn on the
// namespace would patch an object nobody reads. Mock the module instead, and
// spread the original so anything else re-exported stays real.
vi.mock('../../hooks/useRevertFlash', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useRevertFlash')>()),
  flashRevert: vi.fn(),
}));

function renderFlagHook(project: AitoProject) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['aito-projects'], [project]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useFlagMutation(project), { wrapper });
  return { client, result };
}

const project = { id: 7, flag: null } as AitoProject;

describe('useFlagMutation', () => {
  beforeEach(() => {
    __resetBoardSync();
    vi.restoreAllMocks();
    showToastMock.mockClear();
  });

  it('optimistically sets the flag, then adopts the server row on success', async () => {
    let release: (row: AitoProject) => void = () => {};
    vi.spyOn(api, 'setAitoProjectFlag').mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const { client, result } = renderFlagHook(project);

    act(() => result.current.mutate('urgent'));

    await waitFor(() => {
      const row = client.getQueryData<AitoProject[]>(['aito-projects'])![0];
      expect(row.flag).toBe('urgent');
    });

    const serverRow = { ...project, flag: 'urgent', version: 2 } as AitoProject;
    await act(async () => {
      release(serverRow);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    expect(client.getQueryData<AitoProject[]>(['aito-projects'])).toEqual([serverRow]);
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('optimistically switches to a different flag value', async () => {
    const flaggedProject = { ...project, flag: 'urgent' } as AitoProject;
    let release: (row: AitoProject) => void = () => {};
    vi.spyOn(api, 'setAitoProjectFlag').mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const { client, result } = renderFlagHook(flaggedProject);

    act(() => result.current.mutate('sav'));

    await waitFor(() => {
      const row = client.getQueryData<AitoProject[]>(['aito-projects'])![0];
      expect(row.flag).toBe('sav');
    });

    await act(async () => {
      release({ ...flaggedProject, flag: 'sav' });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });
  });

  it('optimistically clears the flag when un-flagging', async () => {
    const flaggedProject = { ...project, flag: 'pause' } as AitoProject;
    let release: (row: AitoProject) => void = () => {};
    vi.spyOn(api, 'setAitoProjectFlag').mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const { client, result } = renderFlagHook(flaggedProject);

    act(() => result.current.mutate(null));

    await waitFor(() => {
      const row = client.getQueryData<AitoProject[]>(['aito-projects'])![0];
      expect(row.flag).toBeNull();
    });

    await act(async () => {
      release({ ...flaggedProject, flag: null });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });
  });

  it('rolls back the optimistic flag and shows the flagFailed toast on failure', async () => {
    vi.spyOn(api, 'setAitoProjectFlag').mockRejectedValue(new Error('network down'));
    const { client, result } = renderFlagHook(project);

    await act(async () => {
      result.current.mutate('urgent');
      await waitFor(() => expect(result.current.isError).toBe(true));
    });

    expect(client.getQueryData<AitoProject[]>(['aito-projects'])).toEqual([project]);
    expect(showToastMock).toHaveBeenCalledWith('aito.flagFailed', 'error');
    expect(vi.mocked(flashRevert)).toHaveBeenCalledWith(project.id);
  });
});
