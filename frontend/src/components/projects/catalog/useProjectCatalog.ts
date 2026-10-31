import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { ProjectCatalogParams } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { failureMessage } from '../failureMessage';
import { projectKeys } from '../projectQueries';

export const catalogKeys = {
  all: () => ['project-catalog'] as const,
  catalog: (p: ProjectCatalogParams) => ['project-catalog', p.q ?? '', p.status ?? '', p.tagIds ?? [], p.tagMode ?? 'any'] as const,
  folders: () => ['project-folders'] as const,
};

/** The catalog list for the search parameters; the previous list stays while a new one loads. */
export function useProjectCatalog(params: ProjectCatalogParams) {
  return useQuery({
    queryKey: catalogKeys.catalog(params),
    queryFn: () => api.getProjectCatalog(params),
    placeholderData: keepPreviousData,
    select: (data) => data.items,
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
  const updateFolder = useMutation({
    mutationFn: (v: { id: number; name?: string; parent_id?: number | null }) =>
      run(() => api.updateProjectFolder(v.id, { name: v.name, parent_id: v.parent_id }), folderFail),
  });
  const deleteFolder = useMutation({
    mutationFn: (id: number) => run(() => api.deleteProjectFolder(id), folderFail),
  });
  const moveProject = useMutation({
    mutationFn: (v: { projectId: number; folderId: number | null }) =>
      run(() => api.moveProjectToFolder(v.projectId, v.folderId), 'projectsPdm.catalog.moveFailed'),
  });
  return { createFolder, updateFolder, deleteFolder, moveProject };
}
