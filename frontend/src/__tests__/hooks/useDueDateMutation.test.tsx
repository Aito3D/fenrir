/**
 * Tests for useDueDateMutation (task T-020): the optimistic `due_date` write,
 * the server-row settle (`settleProject`), and the failure toast were
 * previously exercised only through a spy on `api.setAitoProjectDueDate`
 * whose promise always resolved immediately, so none of `transform`,
 * `onSuccess` (settleProject) or `onError` ever ran in any test.
 *
 * Mirrors useFlagMutation.test.tsx's mocks (react-i18next `t` returning the
 * key, ToastContext mocked to `showToastMock`, `flashRevert` mocked as a
 * direct binding since the wrapper imports it that way) and its
 * manually-released-promise pattern for observing the optimistic write
 * before the mocked request settles.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useDueDateMutation } from '../../hooks/useDueDateMutation';
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

function renderDueDateHook(project: AitoProject) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['aito-projects'], [project]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useDueDateMutation(project), { wrapper });
  return { client, result };
}

const project = { id: 12, due_date: null } as AitoProject;

describe('useDueDateMutation', () => {
  beforeEach(() => {
    __resetBoardSync();
    vi.restoreAllMocks();
    showToastMock.mockClear();
  });

  it('optimistically sets the due date, then adopts the server row on success', async () => {
    let release: (row: AitoProject) => void = () => {};
    vi.spyOn(api, 'setAitoProjectDueDate').mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const { client, result } = renderDueDateHook(project);

    act(() => result.current.mutate('2026-09-12'));

    await waitFor(() => {
      const row = client.getQueryData<AitoProject[]>(['aito-projects'])![0];
      expect(row.due_date).toBe('2026-09-12');
    });

    const serverRow = { ...project, due_date: '2026-09-12', version: 2 } as AitoProject;
    await act(async () => {
      release(serverRow);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    expect(client.getQueryData<AitoProject[]>(['aito-projects'])).toEqual([serverRow]);
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('optimistically clears the due date when un-setting it', async () => {
    const datedProject = { ...project, due_date: '2026-09-12' } as AitoProject;
    let release: (row: AitoProject) => void = () => {};
    vi.spyOn(api, 'setAitoProjectDueDate').mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const { client, result } = renderDueDateHook(datedProject);

    act(() => result.current.mutate(null));

    await waitFor(() => {
      const row = client.getQueryData<AitoProject[]>(['aito-projects'])![0];
      expect(row.due_date).toBeNull();
    });

    await act(async () => {
      release({ ...datedProject, due_date: null });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });
  });

  it('rolls back the optimistic due date and shows the dueDateFailed toast on failure', async () => {
    vi.spyOn(api, 'setAitoProjectDueDate').mockRejectedValue(new Error('network down'));
    const { client, result } = renderDueDateHook(project);

    await act(async () => {
      result.current.mutate('2026-09-12');
      await waitFor(() => expect(result.current.isError).toBe(true));
    });

    expect(client.getQueryData<AitoProject[]>(['aito-projects'])).toEqual([project]);
    expect(showToastMock).toHaveBeenCalledWith('aito.dueDateFailed', 'error');
    expect(vi.mocked(flashRevert)).toHaveBeenCalledWith(project.id);
  });
});
