import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '../../../utils/pricing';
import { useCurrency } from '../../../hooks/useCurrency';

/** The two formatters every statistics block needs: money in the shop's
 *  currency and a day count as « 4.8 d ». A null day count is a dash. */
export function useStatsFormat() {
  const { t } = useTranslation();
  const currency = useCurrency();
  return useMemo(
    () => ({
      money: (v: number) => formatMoney(v, currency),
      days: (v: number | null | undefined) =>
        v === null || v === undefined ? '—' : t('aito.stats.daysShort', { days: v.toFixed(1) }),
    }),
    [t, currency],
  );
}
