/** T-528: a file action, a hand-sliced upload and a slice landing refresh the catalog row
 *  (files count, recommended file, thumbnail) beside the project tree; never the folder counts,
 *  which no file action changes. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../../contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { api } from '../../../../api/client';
import type { ProjectTreeResponse } from '../../../../api/client';
import { createTestQueryClient } from '../../../utils';
import { AuthProvider } from '../../../../contexts/AuthContext';
import { useFileActions } from '../../../../components/projects/files/useFileActions';
import { ProjectFilesPanel } from '../../../../components/projects/files/ProjectFilesPanel';
import { catalogKeys } from '../../../../components/projects/catalog/useProjectCatalog';
import { projectKeys } from '../../../../components/projects/projectQueries';
import { file, item, projectTree, rev } from '../../../fixtures/projectTree';

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>
    <MemoryRouter>
      <AuthProvider>{children}</AuthProvider>
    </MemoryRouter>
  </QueryClientProvider>
);
const invalidated = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.map(([filters]) => JSON.stringify((filters as { queryKey: unknown }).queryKey));
const TREE = JSON.stringify(projectKeys.tree(7));
const CATALOG = JSON.stringify(catalogKeys.all());
const FOLDERS = JSON.stringify(catalogKeys.folders());

beforeEach(() => {
  client = createTestQueryClient();
  vi.spyOn(api, 'getProjectTree').mockResolvedValue(projectTree() as never);
});
afterEach(() => vi.restoreAllMocks());

describe('file actions refresh the catalog, not the folders (T-528)', () => {
  it('a successful action invalidates the tree and the catalog, not the folders', async () => {
    vi.spyOn(api, 'updateProjectRevision').mockResolvedValue({} as never);
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useFileActions(7), { wrapper });
    await act(() => result.current.setStatus(2, 'valide'));
    expect(invalidated(spy).sort()).toEqual([CATALOG, TREE].sort());
    expect(invalidated(spy)).not.toContain(FOLDERS);
  });

  it('a failed action refreshes them too', async () => {
    vi.spyOn(api, 'deleteProjectItem').mockRejectedValue(new Error('nope'));
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useFileActions(7), { wrapper });
    await act(() => result.current.deleteItem(20));
    expect(invalidated(spy).sort()).toEqual([CATALOG, TREE].sort());
    expect(invalidated(spy)).not.toContain(FOLDERS);
  });

  it('the hand-sliced upload refreshes them, refused or not', async () => {
    vi.spyOn(api, 'uploadProjectSlicedFile').mockRejectedValue(new Error('refused'));
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useFileActions(7), { wrapper });
    await act(() => expect(result.current.uploadSlicedFile(3, new File(['x'], 'a.gcode.3mf'))).rejects.toThrow('refused'));
    expect(invalidated(spy).sort()).toEqual([CATALOG, TREE].sort());
    expect(invalidated(spy)).not.toContain(FOLDERS);
  });

  it('the panel refreshes the catalog when a polled slice lands, not while it runs', async () => {
    const tree = (slice_status: 'slicing' | 'sliced'): ProjectTreeResponse =>
      projectTree({ impression: [item(20, 'impression', 'Support', [rev({ id: 2, slice_status, files: [file(50, 'support.3mf')] })])] });
    const getTree = vi.spyOn(api, 'getProjectTree').mockResolvedValue(tree('slicing') as never);
    const spy = vi.spyOn(client, 'invalidateQueries');
    render(<ProjectFilesPanel projectId={7} />, { wrapper });
    await screen.findByTestId('item-card-20');
    await act(() => client.refetchQueries({ queryKey: projectKeys.tree(7) }));
    expect(invalidated(spy)).not.toContain(CATALOG);
    getTree.mockResolvedValue(tree('sliced') as never);
    await act(() => client.refetchQueries({ queryKey: projectKeys.tree(7) }));
    await waitFor(() => expect(invalidated(spy)).toEqual([CATALOG]));
  });
});
