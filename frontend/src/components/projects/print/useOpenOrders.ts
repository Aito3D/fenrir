import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';

/** The project's open orders (not `done`) for "pour quelle commande ?". `failed` keeps the
 *  picker up with "None" only, so printing without a task stays a conscious choice. */
export function useOpenOrders(projectId: number) {
  const { hasPermission } = useAuth();
  const canReadOrders = hasPermission('projects:read') && hasPermission('aito:read');
  // Same key the link/delivery mutations invalidate.
  const { data, isPending, isError } = useQuery({
    queryKey: ['project-orders', projectId],
    queryFn: () => api.getProjectOrders(projectId),
    enabled: canReadOrders,
    retry: false,
  });
  return {
    openOrders: (data?.orders ?? []).filter((o) => o.board_column !== 'done'),
    loading: canReadOrders && isPending,
    failed: canReadOrders && isError,
  };
}
