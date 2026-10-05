import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Plus, ShoppingCart } from 'lucide-react';
import { api } from '../../../api/client';
import type { ProjectOrderTask } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { ALL_COLUMNS } from '../../aito/columns';
import { Card, CardContent } from '../../Card';
import { formatDateOnly } from '../../../utils/date';

interface OrderGroup {
  orderId: number;
  first: ProjectOrderTask;
  tasks: ProjectOrderTask[];
}

/** Every Aito order with a task linked to this project, one row per order and
 *  its linked tasks under it (title + delivered revisions). Each order opens
 *  its board card through the board's `?card=` deep link; "New order" opens
 *  the board's create drawer seeded from the project (`?newFromProject=`).
 *  Needs `projects:read` + `aito:read` (the orders route's own gate). */
export function ProjectOrdersCard({ projectId }: { projectId: number }) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canRead = hasPermission('projects:read') && hasPermission('aito:read');
  const canCreate = hasPermission('aito:create');

  // Same key the link/delivery mutations invalidate (useInvalidateProjectLinks).
  const { data, isError } = useQuery({
    queryKey: ['project-orders', projectId],
    queryFn: () => api.getProjectOrders(projectId),
    enabled: canRead && projectId > 0,
    retry: false,
  });

  const groups = useMemo<OrderGroup[]>(() => {
    const byOrder = new Map<number, OrderGroup>();
    for (const row of data?.orders ?? []) {
      const group = byOrder.get(row.order_id);
      if (group) group.tasks.push(row);
      else byOrder.set(row.order_id, { orderId: row.order_id, first: row, tasks: [row] });
    }
    return [...byOrder.values()];
  }, [data]);

  if (!canRead || isError) return null;

  const columnLabel = (id: string) => {
    const column = ALL_COLUMNS.find((c) => c.id === id);
    return column ? t(column.labelKey) : id;
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
            <ShoppingCart className="h-4 w-4 text-bambu-gray" aria-hidden="true" />
            {t('projectsPdm.aito.ordersTitle')}
          </h2>
          {canCreate && (
            <Link
              to={`/aito?newFromProject=${projectId}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-bambu-dark-tertiary px-2.5 py-1 text-xs font-medium text-white hover:border-bambu-green/50 hover:bg-white/5"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {t('projectsPdm.aito.newOrder')}
            </Link>
          )}
        </div>
        {data && groups.length === 0 && <p className="text-sm text-bambu-gray">{t('projectsPdm.aito.ordersEmpty')}</p>}
        {groups.length > 0 && (
          <ul className="divide-y divide-bambu-dark-tertiary">
            {groups.map(({ orderId, first, tasks }) => (
              <li key={orderId} data-order-id={orderId} className="py-2.5 first:pt-0 last:pb-0">
                <Link
                  to={`/aito?card=${orderId}`}
                  className="group flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
                >
                  <span className="font-medium text-white group-hover:text-bambu-green">
                    {t('projectsPdm.aito.orderLabel', { id: orderId })}
                  </span>
                  {first.client_name && <span className="text-bambu-gray-light">{first.client_name}</span>}
                  <span className="rounded-full bg-bambu-dark-tertiary px-2 py-0.5 text-xs text-bambu-gray-light">
                    {columnLabel(first.board_column)}
                  </span>
                  {first.created_at && (
                    <span className="text-xs text-bambu-gray">
                      {formatDateOnly(first.created_at, { year: 'numeric', month: 'short', day: 'numeric' })}
                    </span>
                  )}
                  <ChevronRight className="ml-auto h-4 w-4 text-bambu-gray" aria-hidden="true" />
                </Link>
                <ul className="mt-1 space-y-1 pl-3">
                  {tasks.map((task) => (
                    <li key={task.task_id} className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="text-bambu-gray-light">{task.task_title || task.order_description}</span>
                      {task.deliveries.map((rev) => (
                        <span
                          key={rev.id}
                          className="rounded bg-bambu-green/10 px-1.5 py-0.5 text-[11px] text-bambu-green-light"
                        >
                          {`${rev.item_name} R${rev.number}`}
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
