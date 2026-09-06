/**
 * Tests for useColumnMoveMutation (task T-019): the optimistic column move
 * (`applyColumnMove`), the Done celebration gate, and the failure toast were
 * previously exercised only through specs that resolved `api.moveAitoProject`
 * immediately or left it pending forever, so none of `transform`, `onError`
 * or a rejection's rollback ever ran in any test. (The celebration gate
 * itself IS covered, by AitoDoneCelebration.test.tsx — this file leaves that
 * one alone and does not duplicate it beyond a light happy-path check.)
 *
 * Shares its mocks and render helper with useContactedMutation.test.tsx,
 * useFlagMutation.test.tsx and useDueDateMutation.test.tsx via
 * boardMutationHarness.tsx (react-i18next `t` returning the key,
 * ToastContext mocked to `showToastMock`, and `../../hooks/useRevertFlash`
 * mocked since the wrapper imports `flashRevert` as a direct binding), and
 * its manually-released-promise pattern for observing the optimistic write
 * before the mocked request settles. The celebration mock is
 * AitoDoneCelebration.test.tsx's lighter approach: stub `useCelebration` to
 * return a spy rather than mounting the real canvas provider.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { useColumnMoveMutation } from '../../hooks/useColumnMoveMutation';
import { flashRevert } from '../../hooks/useRevertFlash';
import { applyColumnMove } from '../../utils/aitoOptimistic';
import { api, type AitoProject } from '../../api/client';
import { showToastMock, resetBoardMutationHarness, renderBoardMutationHook } from './boardMutationHarness';

// `vi.mock(...)` factories are hoisted above this file's own imports, so the
// harness's factories cannot be referenced directly here (that trips a
// temporal-dead-zone ReferenceError) — a dynamic import inside the factory
// sidesteps the hoisting order instead.
vi.mock('react-i18next', async () => (await import('./boardMutationHarness')).i18nKeyTranslationFactory());
vi.mock('../../contexts/ToastContext', async () => (await import('./boardMutationHarness')).toastContextMockFactory());
vi.mock('../../hooks/useRevertFlash', async () => (await import('./boardMutationHarness')).revertFlashMockFactory());

// AitoDoneCelebration.test.tsx's lighter approach: stub the hook rather than
// mounting the real canvas provider, which jsdom cannot draw into anyway.
const celebrateSpy = vi.fn();
vi.mock('../../components/aito/celebration/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/aito/celebration/context')>();
  return { ...actual, useCelebration: () => celebrateSpy };
});

const CARD_RECT = { left: 100, top: 200, width: 300, height: 120 } as DOMRect;

function renderMoveHook(project: AitoProject, column: 'done' | 'finish', origin?: () => DOMRect | null) {
  return renderBoardMutationHook(() => useColumnMoveMutation(project, column, origin), project);
}

const project = { id: 7, column: 'finish', move_lock: null, version: 1 } as AitoProject;

describe('useColumnMoveMutation', () => {
  beforeEach(() => {
    resetBoardMutationHarness();
    celebrateSpy.mockClear();
  });

  it('optimistically moves the card via applyColumnMove, then adopts the server row on success', async () => {
    let release: (row: AitoProject) => void = () => {};
    vi.spyOn(api, 'moveAitoProject').mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const { client, result } = renderMoveHook(project, 'done');

    act(() => result.current.mutate());

    // The optimistic write must be exactly what a direct call to
    // applyColumnMove on the seeded array would produce — not just "moved
    // somewhere" but the same shape, position included.
    const expected = applyColumnMove([project], project.id, 'done');
    await waitFor(() => {
      expect(client.getQueryData<AitoProject[]>(['aito-projects'])).toEqual(expected);
    });

    const serverRow = { ...project, column: 'done', position: 0, version: 2 } as AitoProject;
    await act(async () => {
      release(serverRow);
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    expect(client.getQueryData<AitoProject[]>(['aito-projects'])).toEqual([serverRow]);
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('celebrates a move into done when a rect is available', async () => {
    vi.spyOn(api, 'moveAitoProject').mockResolvedValue({ ...project, column: 'done' } as AitoProject);
    const { result } = renderMoveHook(project, 'done', () => CARD_RECT);

    await act(async () => {
      result.current.mutate();
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    expect(celebrateSpy).toHaveBeenCalledTimes(1);
    expect(celebrateSpy).toHaveBeenCalledWith(CARD_RECT);
  });

  it('does not celebrate a move back out of done', async () => {
    const doneProject = { ...project, column: 'done' } as AitoProject;
    vi.spyOn(api, 'moveAitoProject').mockResolvedValue({ ...doneProject, column: 'finish' } as AitoProject);
    const { result } = renderMoveHook(doneProject, 'finish', () => CARD_RECT);

    await act(async () => {
      result.current.mutate();
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });

    expect(celebrateSpy).not.toHaveBeenCalled();
  });

  it('rolls back the optimistic move and shows the moveFailed toast on failure', async () => {
    vi.spyOn(api, 'moveAitoProject').mockRejectedValue(new Error('network down'));
    const { client, result } = renderMoveHook(project, 'done');

    await act(async () => {
      result.current.mutate();
      await waitFor(() => expect(result.current.isError).toBe(true));
    });

    expect(client.getQueryData<AitoProject[]>(['aito-projects'])).toEqual([project]);
    expect(showToastMock).toHaveBeenCalledWith('aito.moveFailed', 'error');
    expect(vi.mocked(flashRevert)).toHaveBeenCalledWith(project.id);
  });
});
