/**
 * Tests for useDueDateMutation (task T-020): the optimistic `due_date` write,
 * the server-row settle (`settleProject`), and the failure toast were
 * previously exercised only through a spy on `api.setAitoProjectDueDate`
 * whose promise always resolved immediately, so none of `transform`,
 * `onSuccess` (settleProject) or `onError` ever ran in any test.
 *
 * Shares its mocks and render helper with useContactedMutation.test.tsx,
 * useFlagMutation.test.tsx and useColumnMoveMutation.test.tsx via
 * boardMutationHarness.tsx (react-i18next `t` returning the key,
 * ToastContext mocked to `showToastMock`, and `../../hooks/useRevertFlash`
 * mocked since the wrapper imports `flashRevert` as a direct binding), and
 * its manually-released-promise pattern for observing the optimistic write
 * before the mocked request settles.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { useDueDateMutation } from '../../hooks/useDueDateMutation';
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

function renderDueDateHook(project: AitoProject) {
  return renderBoardMutationHook(() => useDueDateMutation(project), project);
}

const project = { id: 12, due_date: null } as AitoProject;

describe('useDueDateMutation', () => {
  beforeEach(() => {
    resetBoardMutationHarness();
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

  it('leaves a sibling project on the board untouched when only one card gets a due date', async () => {
    const sibling = { id: 9, due_date: null } as AitoProject;
    let release: (row: AitoProject) => void = () => {};
    vi.spyOn(api, 'setAitoProjectDueDate').mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const { client, result } = renderBoardMutationHook(() => useDueDateMutation(project), project, {
      seedCache: false,
    });
    // Override the harness's single-project seed: `transform`'s ternary only
    // rewrites the row matching `project.id` and must leave every other row
    // in the array exactly as it was.
    client.setQueryData(['aito-projects'], [project, sibling]);

    act(() => result.current.mutate('2026-09-12'));

    await waitFor(() => {
      const row = client.getQueryData<AitoProject[]>(['aito-projects'])!.find((p) => p.id === project.id)!;
      expect(row.due_date).toBe('2026-09-12');
    });
    expect(client.getQueryData<AitoProject[]>(['aito-projects'])!.find((p) => p.id === sibling.id)).toBe(sibling);

    const serverRow = { ...project, due_date: '2026-09-12', version: 2 } as AitoProject;
    await act(async () => {
      release(serverRow);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    expect(client.getQueryData<AitoProject[]>(['aito-projects'])).toEqual([serverRow, sibling]);
  });

  it('leaves the cache untouched when the board query has never been seeded (cache miss)', async () => {
    let release: (row: AitoProject) => void = () => {};
    vi.spyOn(api, 'setAitoProjectDueDate').mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const { client, result } = renderBoardMutationHook(() => useDueDateMutation(project), project, {
      seedCache: false,
    });

    act(() => result.current.mutate('2026-09-12'));

    // `transform`'s `previous?.map(...)` short-circuits to `undefined` on a
    // cache miss, and `setQueryData` treats an `undefined` updater result as
    // a no-op — so the optimistic write never creates a `['aito-projects']`
    // entry out of thin air.
    await waitFor(() => expect(api.setAitoProjectDueDate).toHaveBeenCalled());
    expect(client.getQueryData(['aito-projects'])).toBeUndefined();

    await act(async () => {
      release({ ...project, due_date: '2026-09-12', version: 2 } as AitoProject);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    // `settleProject`'s `replaceProject(undefined, row)` also falls through
    // to `undefined` on an empty cache, so the settle is a no-op too.
    expect(client.getQueryData(['aito-projects'])).toBeUndefined();
    expect(showToastMock).not.toHaveBeenCalled();
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
