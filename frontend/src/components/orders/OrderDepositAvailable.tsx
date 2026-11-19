import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { formatMoney } from '../../utils/pricing';

/** "Deposit available" of the Aito Billing card: the customer's unspent credit in Books. Nothing at zero. */
export function OrderDepositAvailable({ orderId, currency }: { orderId: string; currency: string }) {
  const { t } = useTranslation();
  const credit = useQuery({
    queryKey: ['order-customer', orderId, 'credit'],
    queryFn: () => api.getOrderCustomerCredit(orderId),
    staleTime: 60_000,
    retry: false,
  }).data?.credit;
  if (!credit || credit <= 0) return null;
  return (
    <dl data-testid="customer-credit" className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 text-sm">
      <dt className="text-bambu-gray">{t('aito.depositAvailable')}</dt>
      <dd className="text-right text-bambu-green">{formatMoney(credit, currency)}</dd>
    </dl>
  );
}
