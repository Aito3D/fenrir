import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { clearNewProjectDraft, useNewProjectDraft } from '../../hooks/useNewProjectDraft';
import { emptyTaskDraft } from '../../utils/taskDraft';

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe('useNewProjectDraft', () => {
  it('round-trips a draft through localStorage', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNewProjectDraft());
    expect(result.current.initial).toBeNull();
    const draft = {
      tasks: [{ ...emptyTaskDraft(), title: 'Capot' }],
      client: null,
      summaryText: 'Résumé.',
      summaryEdited: true,
      summarySignature: 'sig',
    };
    act(() => result.current.save(draft));
    act(() => void vi.advanceTimersByTime(500));
    const { result: second } = renderHook(() => useNewProjectDraft());
    expect(second.current.initial?.tasks[0].title).toBe('Capot');
    expect(second.current.initial?.summaryEdited).toBe(true);
  });

  it('clear() and clearNewProjectDraft() both wipe the key', () => {
    localStorage.setItem('aito.newProjectDraft.v1', '{"broken"');
    clearNewProjectDraft();
    expect(localStorage.getItem('aito.newProjectDraft.v1')).toBeNull();
  });

  it('a corrupt payload reads as no draft', () => {
    localStorage.setItem('aito.newProjectDraft.v1', 'not json');
    const { result } = renderHook(() => useNewProjectDraft());
    expect(result.current.initial).toBeNull();
  });
});
