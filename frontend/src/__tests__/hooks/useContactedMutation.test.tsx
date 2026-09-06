/**
 * Tests for useContactedMutation (task T-017): the optimistic write, the
 * server-row settle, and the failure toast were previously exercised only
 * through a spy on the API call whose promise never resolved, so none of
 * `transform`, `onSuccess` (settleProject) or `onError` ever ran in any test.
 *
 * Mirrors useQuoteStatusMutation.test.tsx's mocks (react-i18next `t`
 * returning the key, ToastContext mocked to `showToastMock`) and
 * useOptimisticBoardMutation.test.tsx's pattern for asserting `flashId`
 * (mocking `../../hooks/useRevertFlash` since the wrapper imports
 * `flashRevert` as a direct binding).
 */
import type { ReactNode } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useContactedMutation } from '../../hooks/useContactedMutation';
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

function renderContactedHook(project: AitoProject) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(['aito-projects'], [project]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useContactedMutation(project), { wrapper });
  return { client, result };
}

const project = { id: 12, client_contacted_at: null } as AitoProject;

describe('useContactedMutation', () => {
  beforeEach(() => {
    __resetBoardSync();
    vi.restoreAllMocks();
    showToastMock.mockClear();
  });

  it('optimistically stamps client_contacted_at, then adopts the server row on success', async () => {
    let release: (row: AitoProject) => void = () => {};
    vi.spyOn(api, 'setAitoProjectContacted').mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const { client, result } = renderContactedHook(project);

    act(() => result.current.mutate(true));

    await waitFor(() => {
      const row = client.getQueryData<AitoProject[]>(['aito-projects'])![0];
      expect(row.client_contacted_at).not.toBeNull();
    });

    const serverRow = { ...project, client_contacted_at: '2026-09-05T10:00:00Z', version: 2 } as AitoProject;
    await act(async () => {
      release(serverRow);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    expect(client.getQueryData<AitoProject[]>(['aito-projects'])).toEqual([serverRow]);
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('optimistically clears client_contacted_at when un-marking as contacted', async () => {
    const contactedProject = { ...project, client_contacted_at: '2026-09-01T00:00:00Z' } as AitoProject;
    let release: (row: AitoProject) => void = () => {};
    vi.spyOn(api, 'setAitoProjectContacted').mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const { client, result } = renderContactedHook(contactedProject);

    act(() => result.current.mutate(false));

    await waitFor(() => {
      const row = client.getQueryData<AitoProject[]>(['aito-projects'])![0];
      expect(row.client_contacted_at).toBeNull();
    });

    await act(async () => {
      release({ ...contactedProject, client_contacted_at: null });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });
  });

  it('rolls back the optimistic write and shows the contactedFailed toast on failure', async () => {
    vi.spyOn(api, 'setAitoProjectContacted').mockRejectedValue(new Error('network down'));
    const { client, result } = renderContactedHook(project);

    await act(async () => {
      result.current.mutate(true);
      await waitFor(() => expect(result.current.isError).toBe(true));
    });

    expect(client.getQueryData<AitoProject[]>(['aito-projects'])).toEqual([project]);
    expect(showToastMock).toHaveBeenCalledWith('aito.contactedFailed', 'error');
    expect(vi.mocked(flashRevert)).toHaveBeenCalledWith(project.id);
  });
});
