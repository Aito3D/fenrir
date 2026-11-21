import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { OrderPanelRow } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { HoldButton } from '../aito/HoldButton';
import { OrderRefChips } from './OrderRefChips';
import { OrderSyncButton } from './OrderSyncButton';
import { OrderWatchButton } from './OrderWatchButton';
import { useOrderActions } from './useOrderActions';
import { useOrderOutcomeToasts } from './useOrderOutcomeToasts';

/** The reference chips of an opened order with its actions at the right end: watch, sync, cancel. */
export function OrderRefActions({ row }: { row: OrderPanelRow & { status?: string } }) {
  const { t } = useTranslation();
  const toasts = useOrderOutcomeToasts();
  const { showToast } = useToast();
  const { authEnabled } = useAuth();
  const { canUpdate, cancelOrder } = useOrderActions({
    cancel: { onSuccess: () => showToast(t('orders.cancel.done', { number: row.number })), onError: toasts.failed },
  });
  return (
    <OrderRefChips row={row}>
      {/* A finished order rings no bell: nothing to watch for. */}
      {authEnabled && row.status !== 'finished' && <OrderWatchButton orderId={row.id} />}
      {canUpdate && <OrderSyncButton orderId={row.id} currency={row.currency} />}
      {canUpdate && (
        <HoldButton
          onHold={() => cancelOrder.mutate(row.id)}
          disabled={cancelOrder.isPending}
          durationMs={1000}
          label={t('orders.cancel.label')}
          hint={t('orders.cancel.hint')}
          progress="bar"
          className="border border-bambu-dark-tertiary px-2.5 py-1 text-xs text-bambu-gray hover:border-red-400/45 hover:text-red-400 focus-visible:ring-red-400/40 data-[holding=true]:border-red-400 data-[holding=true]:text-red-400"
        >
          <Trash2 aria-hidden="true" className="relative h-3.5 w-3.5 text-red-400" />
          <span className="relative">{t('orders.cancel.label')}</span>
        </HoldButton>
      )}
    </OrderRefChips>
  );
}
