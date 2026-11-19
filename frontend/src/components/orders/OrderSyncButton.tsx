import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import type { OrderSyncChange } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { formatMoney } from '../../utils/pricing';
import { errorReason } from './orderErrors';
import { useOrderActions } from './useOrderActions';

// Explicit map: the i18n gate scans for literal keys.
const FIELD_KEY: Record<OrderSyncChange['field'], string> = {
  total: 'orders.sync.total',
  paid: 'orders.sync.paid',
  left: 'orders.sync.left',
  state: 'orders.sync.state',
  invoices: 'orders.sync.invoices',
  retainers: 'orders.sync.retainers',
  packages: 'orders.sync.packages',
};

/** Re-read this one order from Zoho Books now (the Aito card's force sync), then say what changed. */
export function OrderSyncButton({ orderId, currency }: { orderId: string; currency: string }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { syncOrder } = useOrderActions();
  const value = (field: OrderSyncChange['field'], v: unknown) =>
    Array.isArray(v) ? v.join(', ') || '–' : typeof v === 'number' && field !== 'state' ? formatMoney(v, currency) : String(v ?? '–');
  const run = () =>
    syncOrder.mutate(orderId, {
      onSuccess: ({ changes }) =>
        showToast(
          changes.length
            ? t('orders.sync.updated', { changes: changes.map(c => `${t(FIELD_KEY[c.field])} ${value(c.field, c.to)}`).join(' · ') })
            : t('aito.syncUpToDate'),
          'success',
        ),
      onError: e => showToast(errorReason(t, e), 'error'),
    });
  return (
    <button
      type="button"
      onClick={run}
      disabled={syncOrder.isPending}
      title={t('orders.sync.hint')}
      className="btn-press inline-flex items-center gap-1.5 rounded-md border border-bambu-dark-tertiary px-2.5 py-1 text-xs text-bambu-gray hover:border-bambu-green hover:text-bambu-green disabled:opacity-50"
    >
      <RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${syncOrder.isPending ? 'animate-spin' : ''}`} />
      {t('aito.sync')}
    </button>
  );
}
