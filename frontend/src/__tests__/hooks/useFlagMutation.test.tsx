/**
 * Tests for useFlagMutation (task T-018): the optimistic write, the
 * server-row settle, and the failure toast were previously exercised only
 * through a spy on `api.setAitoProjectFlag` whose promise always resolved
 * immediately, so none of `transform`, `onSuccess` (settleProject) or
 * `onError` ever ran in any test.
 *
 * Shares its mocks and render helper with useContactedMutation.test.tsx,
 * useColumnMoveMutation.test.tsx and useDueDateMutation.test.tsx via
 * boardMutationHarness.tsx (react-i18next `t` returning the key,
 * ToastContext mocked to `showToastMock`, and `../../hooks/useRevertFlash`
 * mocked since the wrapper imports `flashRevert` as a direct binding), and
 * its manually-released-promise pattern for observing the optimistic write
 * before the mocked request settles.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { useFlagMutation } from '../../hooks/useFlagMutation';
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

function renderFlagHook(project: AitoProject) {
  return renderBoardMutationHook(() => useFlagMutation(project), project);
}

const project = { id: 7, flag: null } as AitoProject;

describe('useFlagMutation', () => {
  beforeEach(() => {
    resetBoardMutationHarness();
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
