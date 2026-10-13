import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Pins the project tree read both ways: the re-slice completion's fetchQuery
// (key, fetcher, staleTime 0) and useProjectTree's cached query (key, options).
vi.mock('../../../contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { api } from '../../../api/client';
import { useProjectTree } from '../../../components/projects/projectQueries';
import { useResliceJobs } from '../../../components/projects/reslice/useResliceJobs';

const tree = { project_id: 7, code: 'P-0007', sections: [] };

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

afterEach(() => vi.restoreAllMocks());

describe('project tree query pins', () => {
  it('the re-slice completion fetches ["project-tree", id] with staleTime 0', async () => {
    const getTree = vi.spyOn(api, 'getProjectTree').mockResolvedValue(tree as never);
    vi.spyOn(api, 'resliceProjectRevision').mockResolvedValue({ job_id: 5 } as never);
    vi.spyOn(api, 'getSliceJob').mockResolvedValue({
      job_id: 5,
      status: 'completed',
      result: { project_id: 7, item_id: 20, revision_id: 2, revision_number: 2, file_id: null, filename: 'a.gcode.3mf' },
    } as never);
    const { client, wrapper } = setup();
    const fetchQuery = vi.spyOn(client, 'fetchQuery');
    const { result } = renderHook(() => useResliceJobs(7), { wrapper });
    await act(() => result.current.start(20, 1, 50, 3, undefined));
    await waitFor(() => expect(fetchQuery).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const opts = fetchQuery.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(Object.keys(opts)).toEqual(['queryKey', 'queryFn', 'staleTime']);
    expect(opts.queryKey).toEqual(['project-tree', 7]);
    expect(opts.staleTime).toBe(0);
    expect(getTree.mock.calls).toEqual([[7]]);
  });

  it('useProjectTree caches under ["project-tree", id] and fetches that id', async () => {
    const getTree = vi.spyOn(api, 'getProjectTree').mockResolvedValue(tree as never);
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useProjectTree(7, { retry: false }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getTree.mock.calls).toEqual([[7]]);
    const q = client.getQueryCache().findAll();
    expect(q.map((x) => x.queryKey)).toEqual([['project-tree', 7]]);
    expect(q[0].options.retry).toBe(false);
  });

  it('useProjectTree with no project keeps ["project-tree", undefined] and the caller\'s enabled', () => {
    const getTree = vi.spyOn(api, 'getProjectTree');
    const { client, wrapper } = setup();
    renderHook(() => useProjectTree(undefined, { enabled: false }), { wrapper });
    const q = client.getQueryCache().findAll();
    expect(q.map((x) => x.queryKey)).toEqual([['project-tree', undefined]]);
    expect(q[0].options.enabled).toBe(false);
    expect(getTree).not.toHaveBeenCalled();
  });
});
