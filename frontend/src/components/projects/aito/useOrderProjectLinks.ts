import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '../../../api/client';
import type { TaskProjectLink } from '../../../api/client';

/** Every task of one Aito order with its linked project, per-section summary and
 *  delivered revision ids. One request per order, shared by all its task rows.
 *  `orderId` undefined (the create drawer, or no `projects:read`) = no request. */
export function useOrderProjectLinks(orderId: number | undefined) {
  return useQuery({
    queryKey: ['aito-project-links', orderId],
    queryFn: () => api.getOrderProjectLinks(orderId as number),
    enabled: orderId !== undefined,
    retry: false,
  });
}

/** The link of one task, or undefined while loading / for an unsaved task. */
export function useTaskProjectLink(orderId: number | undefined, taskId: number | null): TaskProjectLink | undefined {
  const { data } = useOrderProjectLinks(orderId);
  return taskId === null ? undefined : data?.tasks.find((t) => t.task_id === taskId);
}

/** What a link, delivery or drop change makes stale: the order's links, the
 *  board's code chips, the order timeline, and the tree of every project the
 *  change touched (a relink touches the old one too). */
export function useInvalidateProjectLinks() {
  const queryClient = useQueryClient();
  return useCallback(
    (orderId: number, projectIds: (number | null | undefined)[] = []) => {
      void queryClient.invalidateQueries({ queryKey: ['aito-project-links', orderId] });
      void queryClient.invalidateQueries({ queryKey: ['aito-project-codes'] });
      void queryClient.invalidateQueries({ queryKey: ['aito-events', orderId] });
      for (const id of new Set(projectIds)) {
        if (id == null) continue;
        void queryClient.invalidateQueries({ queryKey: ['project-tree', id] });
        void queryClient.invalidateQueries({ queryKey: ['project-orders', id] });
      }
    },
    [queryClient],
  );
}
