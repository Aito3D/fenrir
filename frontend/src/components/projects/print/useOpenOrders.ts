import { useAuth } from '../../../contexts/AuthContext';
import { useProjectOrders } from '../projectQueries';

/** The project's open orders (not `done`) for "pour quelle commande ?". `failed` keeps the
 *  picker up with "None" only, so printing without a task stays a conscious choice. */
export function useOpenOrders(projectId: number) {
  const { hasPermission } = useAuth();
  const canReadOrders = hasPermission('projects:read') && hasPermission('aito:read');
  // Same key the link/delivery mutations invalidate.
  const { data, isPending, isError } = useProjectOrders(projectId, { enabled: canReadOrders, retry: false });
  const openOrders = (data?.orders ?? []).filter((o) => o.board_column !== 'done');
  const loading = canReadOrders && isPending;
  const failed = canReadOrders && isError;
  return {
    openOrders,
    loading,
    failed,
    /** No open order and the orders loaded fine: no task, so the order picker is skipped. */
    noOrderNeeded: openOrders.length === 0 && !failed && !loading,
  };
}
