import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye } from 'lucide-react';
import { api } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';

/** Watch one order: its bell alerts reach the caller even for the kinds switched off in their inbox settings. */
export function OrderWatchButton({ orderId }: { orderId: string }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const key = ['order-watch', orderId];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.getOrderWatch(orderId) });
  const set = useMutation({
    mutationFn: (watching: boolean) => api.setOrderWatch(orderId, watching),
    onSuccess: r => queryClient.setQueryData(key, r),
    onError: () => showToast(t('common.error'), 'error'),
  });
  if (!data) return null; // unknown until read: a toggle must not guess its state
  return (
    <button
      type="button"
      aria-pressed={data.watching}
      title={t('orders.watch.hint')}
      disabled={set.isPending}
      onClick={() => set.mutate(!data.watching)}
      className={`btn-press inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs disabled:opacity-50 ${data.watching ? 'border-bambu-green/50 text-bambu-green' : 'border-bambu-dark-tertiary text-bambu-gray hover:text-white'}`}
    >
      <Eye aria-hidden="true" className="h-3.5 w-3.5" />
      {t(data.watching ? 'orders.watch.on' : 'orders.watch.off')}
    </button>
  );
}
