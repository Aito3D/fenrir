import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useQuotePendingPoll } from '../../hooks/useQuotePendingPoll';
import type { useBoardSync } from '../../hooks/useBoardSync';
import type { AitoProject } from '../../api/client';

// The hook's constants aren't exported (see useQuotePendingPoll.ts), so these
// mirror the literal values it defines internally.
const QUOTE_POLL_INTERVAL_MS = 10_000;
const QUOTE_POLL_MAX_MS = 5 * 60 * 1000;

/** Minimal stand-in for `useBoardSync()`'s return value — the poll only ever
 *  reads `isIdle()`, but the hook's parameter type is `ReturnType<typeof
 *  useBoardSync>`, so the stub must satisfy that full shape. */
function makeBoardSync(idle: boolean): ReturnType<typeof useBoardSync> {
  return {
    generation: 0,
    begin: vi.fn(),
    settle: vi.fn(),
    resyncIfIdle: vi.fn(),
    isIdle: () => idle,
    beginMove: vi.fn(),
    settleMove: vi.fn(),
    isDragIdle: () => true,
  };
}

// Only the fields the poll reads (`id`, `quote_number`, `quote_sync_state`)
// matter for these tests; the rest of `AitoProject` is irrelevant to this
// state machine, so — mirroring the `makeProject` helper in
// __tests__/utils/aitoBoard.test.ts — it is cast rather than filled in
// field-by-field.
function project(id: number, quote_number: string | null, quote_sync_state: string): AitoProject {
  return { id, quote_number, quote_sync_state } as unknown as AitoProject;
}

function queryWith(data: AitoProject[] | undefined) {
  return { state: { data } };
}

describe('useQuotePendingPoll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false when boardSync is not idle, regardless of matching data', () => {
    const boardSync = makeBoardSync(false);
    const { result } = renderHook(() => useQuotePendingPoll(boardSync));
    const pendingProject = project(1, null, 'pending');

    expect(result.current(queryWith([pendingProject]))).toBe(false);
  });

  it('returns the poll interval while a pending, no-quote-number card exists', () => {
    const boardSync = makeBoardSync(true);
    const { result } = renderHook(() => useQuotePendingPoll(boardSync));
    const pendingProject = project(1, null, 'pending');

    expect(result.current(queryWith([pendingProject]))).toBe(QUOTE_POLL_INTERVAL_MS);
  });

  it('returns false once the current match has already been given a quote number', () => {
    const boardSync = makeBoardSync(true);
    const { result } = renderHook(() => useQuotePendingPoll(boardSync));
    const resolvedProject = project(1, 'Q-1', 'pending');

    expect(result.current(queryWith([resolvedProject]))).toBe(false);
  });

  it('resets the deadline (returns false) when there are zero matches, even after a prior match', () => {
    const boardSync = makeBoardSync(true);
    const { result } = renderHook(() => useQuotePendingPoll(boardSync));
    const pendingProject = project(1, null, 'pending');

    expect(result.current(queryWith([pendingProject]))).toBe(QUOTE_POLL_INTERVAL_MS);
    // The card resolved (or vanished) — no more matches.
    expect(result.current(queryWith([]))).toBe(false);
    // A subsequent poll of the SAME data set (`undefined`) also has no
    // matches, and must also fall through to the zero-matches branch.
    expect(result.current(queryWith(undefined))).toBe(false);
  });

  it('returns false once QUOTE_POLL_MAX_MS has elapsed with no new match', () => {
    const boardSync = makeBoardSync(true);
    const { result } = renderHook(() => useQuotePendingPoll(boardSync));
    const pendingProject = project(1, null, 'pending');

    // Start the deadline.
    expect(result.current(queryWith([pendingProject]))).toBe(QUOTE_POLL_INTERVAL_MS);

    // Just before the deadline: still polling.
    vi.setSystemTime(QUOTE_POLL_MAX_MS - 1);
    expect(result.current(queryWith([pendingProject]))).toBe(QUOTE_POLL_INTERVAL_MS);

    // At/after the deadline with the same id still matching: budget spent.
    vi.setSystemTime(QUOTE_POLL_MAX_MS);
    expect(result.current(queryWith([pendingProject]))).toBe(false);
  });

  it('a newly-appearing matching id resets the deadline past where it would otherwise have expired', () => {
    const boardSync = makeBoardSync(true);
    const { result } = renderHook(() => useQuotePendingPoll(boardSync));
    const first = project(1, null, 'pending');
    const second = project(2, null, 'pending');

    // Start the deadline with only `first` matching.
    expect(result.current(queryWith([first]))).toBe(QUOTE_POLL_INTERVAL_MS);

    // Right at the original deadline, `second` newly starts matching too —
    // this must reset the shared deadline instead of expiring it.
    vi.setSystemTime(QUOTE_POLL_MAX_MS);
    expect(result.current(queryWith([first, second]))).toBe(QUOTE_POLL_INTERVAL_MS);

    // Without the reset, the poll would already have expired here; with it,
    // the poll keeps running almost a full budget past the original deadline.
    vi.setSystemTime(QUOTE_POLL_MAX_MS + QUOTE_POLL_MAX_MS - 1);
    expect(result.current(queryWith([first, second]))).toBe(QUOTE_POLL_INTERVAL_MS);

    // And it does eventually expire again, relative to the NEW deadline.
    vi.setSystemTime(QUOTE_POLL_MAX_MS + QUOTE_POLL_MAX_MS);
    expect(result.current(queryWith([first, second]))).toBe(false);
  });
});
