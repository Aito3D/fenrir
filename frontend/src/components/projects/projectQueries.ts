import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseQueryOptions } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { ProjectOrdersResponse, ProjectTreeResponse } from '../../api/client';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';

/** The project query keys shared by every read and invalidation of the files tree
 *  and the linked orders. `projectId` is undefined while a picker has no project yet
 *  (those reads are disabled). `projectsSearch(...params)` appends each search's own
 *  parameters; with none it is the prefix every search shares. */
export const projectKeys = {
  tree: (projectId: number | undefined) => ['project-tree', projectId] as const,
  orders: (projectId: number | undefined) => ['project-orders', projectId] as const,
  project: (projectId: number) => ['project', projectId] as const,
  projects: () => ['projects'] as const,
  projectsSearch: <P extends readonly unknown[]>(...params: P) => ['projects-search', ...params] as const,
  projectTags: () => ['project-tags'] as const,
  /** One Aito order's task links (useOrderProjectLinks); `allProjectLinks` is every order's. */
  projectLinks: (orderId: number | undefined) => ['aito-project-links', orderId] as const,
  allProjectLinks: () => ['aito-project-links'] as const,
  /** The project codes of every Aito order (the board's code chips). */
  projectCodes: () => ['aito-project-codes'] as const,
};

type ExtraOptions<T> = Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'>;

/** The project tree's key and fetcher, for useProjectTree and a one-off `fetchQuery`. */
export function projectTreeQuery(projectId: number) {
  return {
    queryKey: projectKeys.tree(projectId),
    queryFn: () => api.getProjectTree(projectId),
  };
}

/** The project's files tree. Callers pass their own `enabled` / `retry` / …;
 *  disable the read while `projectId` is undefined. */
export function useProjectTree(projectId: number | undefined, opts?: ExtraOptions<ProjectTreeResponse>) {
  return useQuery({
    ...projectTreeQuery(projectId as number),
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

/** A picker's free project search: the typed text (`q` / `setQ`), its debounced
 *  trimmed form, and the first 10 matches minus the ids the picker already
 *  suggests (none until something is typed). `scope` keeps each picker's search
 *  in its own cache entry (projectKeys.projectsSearch(scope, debounced)). */
export function useProjectSearch(scope: string, suggestedIds: Iterable<number>) {
  const [q, setQ] = useState('');
  const debounced = useDebouncedValue(q, 250).trim();
  const { data: search, isFetching } = useQuery({
    queryKey: projectKeys.projectsSearch(scope, debounced),
    queryFn: () => api.searchProjects({ q: debounced, limit: 10 }),
    enabled: debounced !== '',
    retry: false,
  });
  const suggested = new Set(suggestedIds);
  const results = debounced ? (search?.items ?? []).filter((p) => !suggested.has(p.id)) : [];
  return { q, setQ, debounced, results, isFetching };
}
