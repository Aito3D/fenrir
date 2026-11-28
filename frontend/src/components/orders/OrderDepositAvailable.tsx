import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { formatMoney } from '../../utils/pricing';

/** "Deposit available" of the Aito Billing card: the customer's unspent credit in Books. Nothing at zero.
 *  By order, or by `customerId` where no order exists yet (the new-order dialog). */
export function OrderDepositAvailable({ orderId, customerId, currency }: { orderId?: string; customerId?: string; currency: string }) {
  const { t } = useTranslation();
  const credit = useQuery({
    queryKey: orderId ? ['order-customer', orderId, 'credit'] : ['customer-credit', customerId],
    queryFn: () => (orderId ? api.getOrderCustomerCredit(orderId) : api.getCustomerCredit(customerId ?? '')),
    enabled: !!(orderId || customerId),
    staleTime: 60_000,
    retry: false,
  }).data?.credit;
  if (!credit || credit <= 0) return null;
  return (
    <dl data-testid="customer-credit" className="fold-open grid grid-cols-[auto_1fr] items-baseline gap-x-3 text-sm">
      <dt className="text-bambu-gray">{t('aito.depositAvailable')}</dt>
      <dd className="text-right text-bambu-green">{formatMoney(credit, currency)}</dd>
    </dl>
  );
}
