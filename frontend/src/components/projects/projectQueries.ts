import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseQueryOptions } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { ProjectOrdersResponse, ProjectTreeResponse } from '../../api/client';

/** The project query keys shared by every read and invalidation of the files tree
 *  and the linked orders. `projectId` is undefined while a picker has no project yet
 *  (those reads are disabled). */
export const projectKeys = {
  tree: (projectId: number | undefined) => ['project-tree', projectId] as const,
  orders: (projectId: number | undefined) => ['project-orders', projectId] as const,
  project: (projectId: number) => ['project', projectId] as const,
  projects: () => ['projects'] as const,
  projectsSearch: () => ['projects-search'] as const,
  projectTags: () => ['project-tags'] as const,
};

type ExtraOptions<T> = Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'>;

/** The project's files tree. Callers pass their own `enabled` / `retry` / …;
 *  disable the read while `projectId` is undefined. */
export function useProjectTree(projectId: number | undefined, opts?: ExtraOptions<ProjectTreeResponse>) {
  return useQuery({
    queryKey: projectKeys.tree(projectId),
    queryFn: () => api.getProjectTree(projectId as number),
    ...opts,
  });
}

/** The Aito orders linked to the project. Same options contract as useProjectTree. */
export function useProjectOrders(projectId: number | undefined, opts?: ExtraOptions<ProjectOrdersResponse>) {
  return useQuery({
    queryKey: projectKeys.orders(projectId),
    queryFn: () => api.getProjectOrders(projectId as number),
    ...opts,
  });
}

/** Invalidates the project lists, search and tag catalogue after a project is
 *  created or edited (fire-and-forget). Given a `projectId`, that project's own
 *  query is invalidated first. */
export function useInvalidateProjects() {
  const queryClient = useQueryClient();
  return (projectId?: number) => {
    if (projectId !== undefined) queryClient.invalidateQueries({ queryKey: projectKeys.project(projectId) });
    queryClient.invalidateQueries({ queryKey: projectKeys.projects() });
    queryClient.invalidateQueries({ queryKey: projectKeys.projectsSearch() });
    queryClient.invalidateQueries({ queryKey: projectKeys.projectTags() });
  };
}
