import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Panel } from '../aito/stats/primitives';
import { RevenueDepreciation } from './RevenueDepreciation';
import { RevenueFixedCosts } from './RevenueFixedCosts';
import { RevenueLabor } from './RevenueLabor';
import { formatFcp, formatPerMinute } from './lib/format';
import type { ResultResponse } from './lib/types';
import { useRevenueResource } from './useRevenueResource';

/** The shop's three charges in one place: what each costs a month and a minute, then the table that sets it. */
export function RevenueCharges({ canManage, version, onChanged, onClose, returnFocus }: {
  canManage: boolean;
  /** Moves when the page's data does, so the summary follows a saved table. */
  version: unknown;
  onChanged: () => void;
  onClose: () => void;
  returnFocus: () => void;
}) {
  const { t } = useTranslation();
  const { data } = useRevenueResource<ResultResponse>('/api/v1/revenue/result', version);
  const top = useRef<HTMLDivElement>(null);
  // Each table takes focus as it mounts; the reader starts at the top, and this effect runs after theirs.
  useEffect(() => top.current?.focus(), []);
  const c = data?.charges;
  const rows = c ? ([['result.colLabor', c.labor], ['result.colFixed', c.fixed], ['result.colDepreciation', c.depreciation]] as const) : [];
  const total = rows.reduce((s, [, v]) => s + v, 0);
  const panel = { canManage, onChanged, onClose, returnFocus };
  return (
    <div ref={top} tabIndex={-1} className="space-y-3 outline-none">
      <Panel title={t('revenue.charges.title')}>
        {c && (
          <table aria-label={t('revenue.charges.title')} className="w-full max-w-xl text-sm tabular-nums">
            <thead className="text-xs text-bambu-gray">
              <tr>
                <td />
                <th scope="col" className="px-2 py-1 text-right font-normal">{t('revenue.fixedCosts.monthly')}</th>
                <th scope="col" className="px-2 py-1 text-right font-normal">{t('revenue.charges.perMinute')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([key, value]) => (
                <tr key={key} className="border-t border-bambu-dark-tertiary text-bambu-gray-light">
                  <th scope="row" className="py-1 text-left font-normal">{t(`revenue.${key}`)}</th>
                  <td className="px-2 py-1 text-right">{formatFcp(value)}</td>
                  <td className="px-2 py-1 text-right">{formatPerMinute(value)}</td>
                </tr>
              ))}
              <tr className="border-t border-bambu-dark-tertiary font-medium text-white">
                <th scope="row" className="py-1 text-left font-medium">{t('revenue.charges.total')}</th>
                <td className="px-2 py-1 text-right">{formatFcp(total)}</td>
                <td className="px-2 py-1 text-right">{formatPerMinute(total)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
      <RevenueLabor {...panel} />
      <RevenueFixedCosts {...panel} />
      <RevenueDepreciation {...panel} />
    </div>
  );
}
