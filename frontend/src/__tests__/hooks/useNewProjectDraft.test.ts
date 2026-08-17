import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { clearNewProjectDraft, useNewProjectDraft } from '../../hooks/useNewProjectDraft';
import { emptyTaskDraft } from '../../utils/taskDraft';
import { defaultClientDraft } from '../../utils/clientDraft';
import { emptyShippingDraft } from '../../utils/shippingDraft';

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

  // The storage key was never bumped when the four per-service description
  // fields were added to TaskDraft (2026-08-03), so a blob written by any
  // build between the hook landing (2026-08-01) and that commit restores tasks
  // with `scanDescription === undefined`. TaskStepList reads
  // `task[DESCRIPTION_FIELD[service]].trim()` on every render, so the drawer
  // threw "Cannot read properties of undefined (reading 'trim')" straight up
  // to the router error boundary the moment it opened.
  it('fills fields a legacy blob predates, keeping what the operator typed', () => {
    localStorage.setItem(
      'aito.newProjectDraft.v1',
      JSON.stringify({
        tasks: [{ id: null, title: 'Capot', scanCost: 4000, done: { scan: true } }],
        client: null,
        summaryText: '',
        summaryEdited: false,
        summarySignature: '',
      }),
    );
    const { result } = renderHook(() => useNewProjectDraft());
    const task = result.current.initial?.tasks[0];

    expect(task?.title).toBe('Capot');
    expect(task?.scanCost).toBe(4000);
    expect(task?.done).toEqual({ scan: true, modelisation: false, impression: false, usinage: false });
    expect(task?.scanDescription).toBe('');
    expect(task?.modelisationDescription).toBe('');
    expect(task?.impressionDescription).toBe('');
    expect(task?.usinageDescription).toBe('');
    expect(task?.impression.quantity).toBe(1);
    expect(typeof task?.uid).toBe('string');
  });

  it('gives each uid-less legacy task its own uid', () => {
    localStorage.setItem(
      'aito.newProjectDraft.v1',
      JSON.stringify({
        tasks: [{ title: 'A' }, { title: 'B' }],
        client: null,
        summaryText: '',
        summaryEdited: false,
        summarySignature: '',
      }),
    );
    const { result } = renderHook(() => useNewProjectDraft());
    const [a, b] = result.current.initial?.tasks ?? [];
    // rowKey()s off uid for unsaved rows: a shared uid would key two rows the
    // same and hand one row's mounted inputs to the other.
    expect(a.uid).not.toBe(b.uid);
  });

  it('drops a client or shipping half that predates its current shape', () => {
    localStorage.setItem(
      'aito.newProjectDraft.v1',
      JSON.stringify({
        tasks: [],
        // No `email`, no `blurred` — NewProjectDrawer reads `draft.email.trim()`
        // during render, so a half-shaped client is the same crash as above.
        client: { id: 'z1', name: 'ACME' },
        shipping: { island: 'tahiti' },
        summaryText: '',
        summaryEdited: false,
        summarySignature: '',
      }),
    );
    const { result } = renderHook(() => useNewProjectDraft());
    expect(result.current.initial?.client).toBeNull();
    expect(result.current.initial?.shipping).toBeNull();
  });

  it('keeps a complete client and shipping half', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNewProjectDraft());
    act(() =>
      result.current.save({
        tasks: [],
        client: defaultClientDraft('z1', 'ACME'),
        shipping: emptyShippingDraft(null),
        summaryText: '',
        summaryEdited: false,
        summarySignature: '',
      }),
    );
    act(() => void vi.advanceTimersByTime(500));
    const { result: second } = renderHook(() => useNewProjectDraft());
    expect(second.current.initial?.client?.id).toBe('z1');
    expect(second.current.initial?.shipping?.island).toBe('');
  });

  it('flushes a pending save synchronously on unmount, without advancing timers', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useNewProjectDraft());
    const draft = {
      tasks: [{ ...emptyTaskDraft(), title: 'Capot' }],
      client: null,
      summaryText: 'Résumé.',
      summaryEdited: true,
      summarySignature: 'sig',
    };
    act(() => result.current.save(draft));
    // No vi.advanceTimersByTime — the debounce has not fired yet.
    unmount();
    const stored = JSON.parse(localStorage.getItem('aito.newProjectDraft.v1') ?? 'null');
    expect(stored?.tasks[0].title).toBe('Capot');
  });

  it('clear() then unmount does not resurrect a pending save', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useNewProjectDraft());
    const draft = {
      tasks: [{ ...emptyTaskDraft(), title: 'Capot' }],
      client: null,
      summaryText: 'Résumé.',
      summaryEdited: true,
      summarySignature: 'sig',
    };
    act(() => result.current.save(draft));
    act(() => result.current.clear());
    unmount();
    expect(localStorage.getItem('aito.newProjectDraft.v1')).toBeNull();
  });

  // T-045: clearNewProjectDraft() is the module-level function AuthContext's
  // logout() (and useAitoPageMutations' create-success handler) calls. It has
  // no handle on a live hook instance's pendingRef/timerRef, so a save()
  // queued just before the external clear must not be resurrected by either
  // of the hook's own writers that fire after it: the unmount flush, and the
  // debounce timer.
  it('external clearNewProjectDraft() then unmount does not resurrect a pending save (logout purge)', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useNewProjectDraft());
    const draftWithClientPII = {
      tasks: [],
      client: defaultClientDraft('c1', 'Moana'),
      summaryText: '',
      summaryEdited: false,
      summarySignature: '',
    };
    act(() => result.current.save(draftWithClientPII));
    // No vi.advanceTimersByTime — the debounce has not fired yet.
    clearNewProjectDraft();
    unmount();
    expect(localStorage.getItem('aito.newProjectDraft.v1')).toBeNull();
  });

  it('external clearNewProjectDraft() then the debounce timer firing does not resurrect a pending save', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNewProjectDraft());
    const draftWithClientPII = {
      tasks: [],
      client: defaultClientDraft('c1', 'Moana'),
      summaryText: '',
      summaryEdited: false,
      summarySignature: '',
    };
    act(() => result.current.save(draftWithClientPII));
    clearNewProjectDraft();
    act(() => void vi.advanceTimersByTime(500));
    expect(localStorage.getItem('aito.newProjectDraft.v1')).toBeNull();
  });

  it('restores a stored client written before the social fields existed', () => {
    const client = {
      id: 'c1',
      name: 'Moana',
      isDefault: false,
      isCompany: false,
      countryCode: '+689',
      nationalNumber: '87123456',
      email: '',
      touched: { phone: false, email: false },
      blurred: { phone: false, email: false },
      original: { phone: '+689-87123456', email: '', phoneField: 'mobile' },
    };
    localStorage.setItem(
      'aito.newProjectDraft.v1',
      JSON.stringify({ tasks: [], client, summaryText: '', summaryEdited: false, summarySignature: '' }),
    );

    const { result } = renderHook(() => useNewProjectDraft());

    // The client half survives — the two new keys are filled, not treated as a
    // missing half that drops the whole contact.
    expect(result.current.initial?.client?.name).toBe('Moana');
    expect(result.current.initial?.client?.socialNetwork).toBeNull();
    expect(result.current.initial?.client?.socialHandle).toBe('');
  });
});
