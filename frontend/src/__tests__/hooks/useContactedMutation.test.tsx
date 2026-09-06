/**
 * Tests for useContactedMutation (task T-017): the optimistic write, the
 * server-row settle, and the failure toast were previously exercised only
 * through a spy on the API call whose promise never resolved, so none of
 * `transform`, `onSuccess` (settleProject) or `onError` ever ran in any test.
 *
 * Shares its mocks and render helper with useFlagMutation.test.tsx,
 * useColumnMoveMutation.test.tsx and useDueDateMutation.test.tsx via
 * boardMutationHarness.tsx (react-i18next `t` returning the key,
 * ToastContext mocked to `showToastMock`, and `../../hooks/useRevertFlash`
 * mocked since the wrapper imports `flashRevert` as a direct binding).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { useContactedMutation } from '../../hooks/useContactedMutation';
import { flashRevert } from '../../hooks/useRevertFlash';
import { api, type AitoProject } from '../../api/client';
import { showToastMock, resetBoardMutationHarness, renderBoardMutationHook } from './boardMutationHarness';

// `vi.mock(...)` factories are hoisted above this file's own imports, so the
// harness's factories cannot be referenced directly here (that trips a
// temporal-dead-zone ReferenceError) — a dynamic import inside the factory
// sidesteps the hoisting order instead.
vi.mock('react-i18next', async () => (await import('./boardMutationHarness')).i18nKeyTranslationFactory());
vi.mock('../../contexts/ToastContext', async () => (await import('./boardMutationHarness')).toastContextMockFactory());
vi.mock('../../hooks/useRevertFlash', async () => (await import('./boardMutationHarness')).revertFlashMockFactory());

function renderContactedHook(project: AitoProject) {
  return renderBoardMutationHook(() => useContactedMutation(project), project);
}

const project = { id: 12, client_contacted_at: null } as AitoProject;

describe('useContactedMutation', () => {
  beforeEach(() => {
    resetBoardMutationHarness();
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
