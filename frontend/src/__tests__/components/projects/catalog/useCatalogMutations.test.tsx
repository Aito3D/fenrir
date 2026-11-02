// Drives the hook directly (renderHook + msw) rather than a jsdom drag: the drag path adds nothing to
// what these cases pin, which is how each mutation settles when the server refuses.
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { delay, http, HttpResponse } from 'msw';
import { server } from '../../../mocks/server';
import { useCatalogMutations, useProjectCatalog, useProjectFolders } from '../../../../components/projects/catalog/useProjectCatalog';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../../../contexts/ToastContext', () => ({ useToast: () => ({ showToast }) }));

const row = (id: number, folder_id: number | null) => ({ id, name: `P${id}`, folder_id });
const folder = (id: number, parent_id: number | null) => ({ id, name: `F${id}`, parent_id, project_count: 0, in_production_count: 0 });

/** The server's truth: project 5 in folder 1, folder 2 under the root. Counts the refetches. */
function serve(fail?: { move?: number; folder?: number }) {
  const hits = { catalog: 0, folders: 0 };
  server.use(
    http.get('/api/v1/projects/catalog', () => {
      hits.catalog += 1;
      return HttpResponse.json({ items: [row(5, 1)], truncated: false });
    }),
    http.get('/api/v1/projects/folders', () => {
      hits.folders += 1;
      return HttpResponse.json({ folders: [folder(1, null), folder(2, null)] });
    }),
    http.patch('/api/v1/projects/5/folder', () =>
      fail?.move ? HttpResponse.json({ detail: 'Refused' }, { status: fail.move }) : HttpResponse.json({ id: 5, folder_id: 2 }),
    ),
    http.patch('/api/v1/projects/folders/2', async () => {
      await delay(100); // long enough to see the optimistic parent
      return HttpResponse.json({ detail: 'A folder cannot be moved into itself' }, { status: 409 });
    }),
    http.post('/api/v1/projects/folders', () => HttpResponse.json({ detail: 'Exists' }, { status: fail?.folder ?? 409 })),
  );
  return hits;
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(
    () => ({ m: useCatalogMutations(), cat: useProjectCatalog({}), folders: useProjectFolders() }),
    { wrapper },
  );
}

describe.each([409, 500])('a project drop the server refuses with %i', (status) => {
  it('toasts, then the row is back in its folder and both lists were refetched', async () => {
    showToast.mockClear();
    const hits = serve({ move: status });
    const { result } = mount();
    await waitFor(() => expect(result.current.cat.data?.items[0].folder_id).toBe(1));
    expect(hits).toEqual({ catalog: 1, folders: 1 });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.m.moveProject.mutateAsync({ projectId: 5, folderId: 2 });
    });

    expect(ok).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Could not move the project: Refused', 'error');
    await waitFor(() => expect(hits).toEqual({ catalog: 2, folders: 2 }));
    await waitFor(() => expect(result.current.cat.data?.items[0].folder_id).toBe(1));
  });
});

describe('folder mutations the server refuses', () => {
  it('createFolder 409 resolves false (the inline row stays open) and toasts', async () => {
    showToast.mockClear();
    serve();
    const { result } = mount();

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.m.createFolder.mutateAsync({ name: 'Car', parent_id: null });
    });

    expect(ok).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Could not save the folder change: Exists', 'error');
  });

  it('a folder moved into its own subtree is rolled back to its parent after the refusal', async () => {
    showToast.mockClear();
    serve();
    const { result } = mount();
    await waitFor(() => expect(result.current.folders.data?.find((f) => f.id === 2)?.parent_id).toBeNull());

    let ok: boolean | undefined;
    await act(async () => {
      const pending = result.current.m.updateFolder.mutateAsync({ id: 2, parent_id: 1 });
      await waitFor(() => expect(result.current.folders.data?.find((f) => f.id === 2)?.parent_id).toBe(1)); // optimistic
      ok = await pending;
    });

    expect(ok).toBe(false);
    expect(showToast).toHaveBeenCalledWith('Could not save the folder change: A folder cannot be moved into itself', 'error');
    await waitFor(() => expect(result.current.folders.data?.find((f) => f.id === 2)?.parent_id).toBeNull());
  });
});
