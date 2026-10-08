import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { server } from '../../../mocks/server';
import { wrapper } from '../../../utils';
import { useResliceJobs } from '../../../../components/projects/reslice/useResliceJobs';

let jobState: Record<string, unknown>;
const newFile = { id: 91, filename: 'support.gcode.3mf', file_type: 'gcode.3mf', file_size: 10, file_hash: 'n', has_thumbnail: false, created_at: '' };
const completed = (fileId: number | null) => ({
  ...jobState,
  status: 'completed',
  result: { project_id: 7, item_id: 20, revision_id: 2, revision_number: 2, file_id: fileId, filename: 'support.gcode.3mf' },
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  jobState = { job_id: 5, status: 'running', kind: 'project_revision', source_id: 1, source_name: 'support.3mf', created_at: '', started_at: '', completed_at: null, progress: { stage: 'x', total_percent: 40, plate_percent: 40, plate_index: 1, plate_count: 1, updated_at: 0 } };
  server.use(
    http.post('/api/v1/projects/revisions/1/reslice', () => HttpResponse.json({ job_id: 5, status: 'pending', status_url: '/api/v1/slice-jobs/5' }, { status: 202 })),
    http.get('/api/v1/slice-jobs/5', () => HttpResponse.json(jobState)),
    http.get('/api/v1/projects/7/tree', () => HttpResponse.json({ project_id: 7, code: 'P-0007', sections: [{ section: 'impression', items: [{ id: 20, section: 'impression', name: 'Support', name_key: 'support', forked_from: null, revisions: [{ id: 2, number: 2, files: [newFile] }] }] }] })),
  );
});
afterEach(() => vi.useRealTimers());

describe('useResliceJobs', () => {
  it('tracks progress on the item, then finishes without queueing', async () => {
    const { result } = renderHook(() => useResliceJobs(7), { wrapper });
    await act(() => result.current.start(20, 1, 50, 3, undefined));
    expect(result.current.runFor(20)).toMatchObject({ itemId: 20, jobId: 5, percent: null, error: null });
    await act(() => vi.advanceTimersByTimeAsync(1600));
    await waitFor(() => expect(result.current.runFor(20)?.percent).toBe(40));
    jobState = completed(91);
    await act(() => vi.advanceTimersByTimeAsync(1600));
    await waitFor(() => expect(result.current.runFor(20)).toBeUndefined());
    expect(result.current.printNext).toBeNull();
  });

  it('hands the new file to the print flow for "Trancher + file"', async () => {
    const { result } = renderHook(() => useResliceJobs(7), { wrapper });
    await act(() => result.current.start(20, 1, 50, 3, 31));
    jobState = completed(91);
    await act(() => vi.advanceTimersByTimeAsync(1600));
    await waitFor(() => expect(result.current.printNext).toEqual({ file: newFile, taskId: 31 }));
    act(() => result.current.clearPrintNext());
    expect(result.current.printNext).toBeNull();
  });

  it('does not open the print flow when the new file cannot be found', async () => {
    const { result } = renderHook(() => useResliceJobs(7), { wrapper });
    await act(() => result.current.start(20, 1, 50, 3, null));
    jobState = completed(null);
    await act(() => vi.advanceTimersByTimeAsync(1600));
    await waitFor(() => expect(result.current.runFor(20)).toBeUndefined());
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(result.current.printNext).toBeNull();
  });

  it('keeps the error on the item until dismissed', async () => {
    const { result } = renderHook(() => useResliceJobs(7), { wrapper });
    await act(() => result.current.start(20, 1, 50, 3, undefined));
    jobState = { ...jobState, status: 'failed', error_status: 502, error_detail: 'Sidecar unreachable' };
    await act(() => vi.advanceTimersByTimeAsync(1600));
    await waitFor(() => expect(result.current.runFor(20)?.error).toBe('Sidecar unreachable'));
    act(() => result.current.dismiss(20));
    expect(result.current.runFor(20)).toBeUndefined();
  });

  it('records no run when the start request fails', async () => {
    server.use(http.post('/api/v1/projects/revisions/1/reslice', () => HttpResponse.json({ detail: 'nope' }, { status: 403 })));
    const { result } = renderHook(() => useResliceJobs(7), { wrapper });
    await act(() => result.current.start(20, 1, 50, 3, undefined));
    expect(result.current.runFor(20)).toBeUndefined();
  });

  it('forgets runs on unmount without breaking the tree', async () => {
    let polls = 0;
    server.use(http.get('/api/v1/slice-jobs/5', () => { polls += 1; return HttpResponse.json(jobState); }));
    const { result, unmount } = renderHook(() => useResliceJobs(7), { wrapper });
    await act(() => result.current.start(20, 1, 50, 3, 31));
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(3200)); // no poll after unmount, no throw
    expect(polls).toBe(0);
  });
});

// Real timers and a slow tree response: the completion must survive the poll effect
// restarting (its run leaves `pending`, or another item starts a run) while the tree loads.
describe('useResliceJobs with real timers', () => {
  const slowTree = () =>
    server.use(
      http.get('/api/v1/projects/7/tree', async () => {
        await delay(80);
        return HttpResponse.json({ project_id: 7, code: 'P-0007', sections: [{ section: 'impression', items: [{ id: 20, section: 'impression', name: 'Support', name_key: 'support', forked_from: null, revisions: [{ id: 2, number: 2, files: [newFile] }] }] }] });
      }),
    );

  beforeEach(() => {
    vi.useRealTimers();
    slowTree();
  });

  it('opens the print flow for a queued run when the tree loads slowly', async () => {
    const { result } = renderHook(() => useResliceJobs(7), { wrapper });
    jobState = completed(91);
    await act(() => result.current.start(20, 1, 50, 3, 31));
    await waitFor(() => expect(result.current.printNext).toEqual({ file: newFile, taskId: 31 }), { timeout: 4000 });
    expect(result.current.runFor(20)).toBeUndefined();
  });

  it('lands a completion even when another item starts a run meanwhile', async () => {
    let otherJob: Record<string, unknown> = { ...jobState, job_id: 6 };
    let treeRequested = false;
    let releaseTree!: () => void;
    const treeGate = new Promise<void>((r) => { releaseTree = r; });
    server.use(
      http.post('/api/v1/projects/revisions/11/reslice', () => HttpResponse.json({ job_id: 6, status: 'pending', status_url: '/api/v1/slice-jobs/6' }, { status: 202 })),
      http.get('/api/v1/slice-jobs/6', () => HttpResponse.json(otherJob)),
      http.get('/api/v1/projects/7/tree', async () => {
        treeRequested = true;
        await treeGate;
        return HttpResponse.json({ project_id: 7, code: 'P-0007', sections: [{ section: 'impression', items: [{ id: 20, section: 'impression', name: 'Support', name_key: 'support', forked_from: null, revisions: [{ id: 2, number: 2, files: [newFile] }] }] }] });
      }),
    );
    const { result } = renderHook(() => useResliceJobs(7), { wrapper });
    jobState = completed(91);
    await act(() => result.current.start(20, 1, 50, 3, 31));
    // Item 20's completion is waiting on the tree: start item 21 now (pending 0 → 1).
    await waitFor(() => expect(treeRequested).toBe(true), { timeout: 4000 });
    expect(result.current.runFor(20)).toBeUndefined();
    await act(() => result.current.start(21, 11, 60, 3, undefined));
    expect(result.current.runFor(21)).toMatchObject({ jobId: 6, error: null });
    releaseTree();
    await waitFor(() => expect(result.current.printNext).toEqual({ file: newFile, taskId: 31 }), { timeout: 4000 });
    // The other run is still polled.
    otherJob = { ...otherJob, status: 'failed', error_detail: 'boom' };
    await waitFor(() => expect(result.current.runFor(21)?.error).toBe('boom'), { timeout: 4000 });
  });

  it('does nothing after unmount while the tree loads', async () => {
    const { result, unmount } = renderHook(() => useResliceJobs(7), { wrapper });
    jobState = completed(91);
    await act(() => result.current.start(20, 1, 50, 3, 31));
    await waitFor(() => expect(result.current.runFor(20)).toBeUndefined(), { timeout: 4000 });
    unmount();
    await new Promise((r) => setTimeout(r, 200)); // the tree resolves after unmount: no throw
    expect(result.current.printNext).toBeNull();
  });
});

