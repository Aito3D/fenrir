import { describe, it, expect } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useSliceJobPercent } from '../../hooks/useSliceJobPercent';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const job = (over: Record<string, unknown>) => ({
  job_id: 5,
  status: 'running',
  kind: 'project_revision',
  source_id: 1,
  source_name: 'rev',
  created_at: '2026-10-17T10:00:00Z',
  started_at: null,
  completed_at: null,
  progress: { stage: 'Generating G-code', total_percent: 61.6, plate_percent: 0, plate_index: 1, plate_count: 1, updated_at: 0 },
  ...over,
});

describe('useSliceJobPercent', () => {
  it('returns the rounded total percent of a running job', async () => {
    server.use(http.get('/api/v1/slice-jobs/5', () => HttpResponse.json(job({}))));
    const { result } = renderHook(() => useSliceJobPercent(5), { wrapper });
    await waitFor(() => expect(result.current.percent).toBe(62));
    expect(result.current.failed).toBe(false);
  });

  it('reports a failed job', async () => {
    server.use(
      http.get('/api/v1/slice-jobs/5', () => HttpResponse.json(job({ status: 'failed', progress: null }))),
    );
    const { result } = renderHook(() => useSliceJobPercent(5), { wrapper });
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.percent).toBeNull();
  });

  it('is indeterminate when the job is gone (404) or forbidden (403)', async () => {
    server.use(http.get('/api/v1/slice-jobs/6', () => HttpResponse.json({ detail: 'nope' }, { status: 404 })));
    const { result } = renderHook(() => useSliceJobPercent(6), { wrapper });
    await new Promise((r) => setTimeout(r, 100));
    expect(result.current).toEqual({ percent: null, failed: false });
  });

  it('does not fetch without a job id', async () => {
    let calls = 0;
    server.use(http.get('/api/v1/slice-jobs/:id', () => { calls++; return HttpResponse.json(job({})); }));
    const { result } = renderHook(() => useSliceJobPercent(null), { wrapper });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(0);
    expect(result.current).toEqual({ percent: null, failed: false });
  });
});
