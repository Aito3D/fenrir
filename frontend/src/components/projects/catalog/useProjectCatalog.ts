import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { ProjectCatalogItem, ProjectCatalogParams, ProjectFolder } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { failureMessage } from '../failureMessage';
import { projectKeys } from '../projectQueries';

export const catalogKeys = {
  all: () => ['project-catalog'] as const,
  catalog: (p: ProjectCatalogParams) => ['project-catalog', p.q ?? '', p.status ?? '', p.tagIds ?? [], p.tagMode ?? 'any'] as const,
  folders: () => ['project-folders'] as const,
};

/** The catalog list for the search parameters (`truncated` when more projects matched than the
 *  server lists); the previous list stays while a new one loads. */
export function useProjectCatalog(params: ProjectCatalogParams) {
  return useQuery({
    queryKey: catalogKeys.catalog(params),
    queryFn: () => api.getProjectCatalog(params),
    placeholderData: keepPreviousData,
  });
}

export function useProjectFolders() {
  return useQuery({
    queryKey: catalogKeys.folders(),
    queryFn: api.getProjectFolders,
    select: (data) => data.folders,
  });
}

/** Folder and filing mutations. Each refetches the folders, the catalog and the project search;
 *  a failure toasts and resolves `false` so a caller can keep its inline form open. */
export function useCatalogMutations() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const settle = () => {
    queryClient.invalidateQueries({ queryKey: catalogKeys.folders() });
    queryClient.invalidateQueries({ queryKey: projectKeys.allLinkedFolders() });
    queryClient.invalidateQueries({ queryKey: catalogKeys.all() });
    queryClient.invalidateQueries({ queryKey: projectKeys.projectsSearch() });
  };
  const run = async <T,>(fn: () => Promise<T>, failKey: string): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (e) {
      showToast(failureMessage(t, failKey, e), 'error');
      return false;
    } finally {
      settle();
    }
  };
  const folderFail = 'projectsPdm.catalog.saveFailed';
  const createFolder = useMutation({
    mutationFn: (body: { name: string; parent_id: number | null }) => run(() => api.createProjectFolder(body), folderFail),
  });
  // A move shows at once: the row is already in its folder when the ghost settles on it, and
  // the refetch in `settle` (success or failure) brings the list back to what the server holds.
  const updateFolder = useMutation({
    mutationFn: (v: { id: number; name?: string; parent_id?: number | null }) =>
      run(() => api.updateProjectFolder(v.id, { name: v.name, parent_id: v.parent_id }), folderFail),
    onMutate: async (v) => {
      if (v.parent_id === undefined) return;
      // The linked-folders family shared the folders key until T-573; it is still cancelled here.
      await Promise.all([
        queryClient.cancelQueries({ queryKey: catalogKeys.folders() }),
        queryClient.cancelQueries({ queryKey: projectKeys.allLinkedFolders() }),
      ]);
      queryClient.setQueryData<{ folders: ProjectFolder[] }>(catalogKeys.folders(), (old) =>
        old && { ...old, folders: old.folders.map((f) => (f.id === v.id ? { ...f, parent_id: v.parent_id ?? null } : f)) },
      );
    },
  });
  const deleteFolder = useMutation({
    mutationFn: (id: number) => run(() => api.deleteProjectFolder(id), folderFail),
  });
  const moveProject = useMutation({
    mutationFn: (v: { projectId: number; folderId: number | null }) =>
      run(() => api.moveProjectToFolder(v.projectId, v.folderId), 'projectsPdm.catalog.moveFailed'),
    onMutate: async (v) => {
      await queryClient.cancelQueries({ queryKey: catalogKeys.all() });
      queryClient.setQueriesData<{ items: ProjectCatalogItem[] }>({ queryKey: catalogKeys.all() }, (old) =>
        old && { ...old, items: old.items.map((i) => (i.id === v.projectId ? { ...i, folder_id: v.folderId } : i)) },
      );
    },
  });
  const deleteProject = useMutation({
    mutationFn: async (id: number) => {
      const ok = await run(() => api.deleteProject(id), 'projectsPdm.catalog.deleteFailed');
      if (ok) showToast(t('projectsPdm.catalog.projectDeleted'), 'success');
      return ok;
    },
  });
  return { createFolder, updateFolder, deleteFolder, moveProject, deleteProject };
}
