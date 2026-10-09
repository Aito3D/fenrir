import { useQuery } from '@tanstack/react-query';
import type { UseQueryOptions } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { ProjectOrdersResponse, ProjectTreeResponse } from '../../api/client';

/** The project query keys shared by every read and invalidation of the files tree
 *  and the linked orders. `projectId` is undefined while a picker has no project yet
 *  (those reads are disabled). */
export const projectKeys = {
  tree: (projectId: number | undefined) => ['project-tree', projectId] as const,
  orders: (projectId: number | undefined) => ['project-orders', projectId] as const,
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
