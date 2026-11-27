import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { focusRingCls } from '../formStyles';
import { Panel } from '../aito/stats/primitives';
import { RevenueDepreciation } from './RevenueDepreciation';
import { RevenueFixedAccounts } from './RevenueFixedAccounts';
import { RevenueLabor } from './RevenueLabor';
import { formatFcp, formatPerMinute } from './lib/format';
import type { ResultResponse } from './lib/types';
import { useRevenueResource } from './useRevenueResource';

const MODAL_OUT_MS = 170;

/** The shop's three charges in one dialog: what each costs a month and a minute, then the table that sets it. */
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
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, { animationMs: MODAL_OUT_MS });
  const restore = useRef(returnFocus);
  restore.current = returnFocus;
  // The page behind stays put while the dialog is open; focus goes back to what opened it.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
      restore.current();
    };
  }, []);
  const c = data?.charges;
  // The fixed costs of the month: entered in the books plus the usual charges still missing, the latter named apart.
  const estimated = c?.fixedEstimated ?? 0;
  const rows = c ? ([['result.colLabor', c.labor], ['result.colFixed', c.fixed + estimated], ['result.colDepreciation', c.depreciation]] as const) : [];
  const total = rows.reduce((s, [, v]) => s + v, 0);
  const panel = { canManage, onChanged };
  // Portalled: an animated ancestor would otherwise become the containing block of `fixed`.
  // No close on a backdrop click: a stray click would drop unsaved rows.
  return createPortal(
    <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 backdrop-blur-sm sm:p-4 ${closing ? 'animate-overlay-out pointer-events-none' : 'animate-overlay-in'}`}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={t('revenue.charges.title')} tabIndex={-1}
        className={`flex max-h-full w-full max-w-5xl flex-col rounded-xl border border-bambu-dark-tertiary bg-bambu-dark shadow-2xl outline-none ${closing ? 'animate-modal-out' : 'animate-modal-in'}`}>
        <header className="flex items-center justify-between gap-3 border-b border-bambu-dark-tertiary px-4 py-3">
          <h2 className="text-base font-semibold text-white">{t('revenue.charges.title')}</h2>
          <button type="button" aria-label={t('common.close')} title={t('common.close')} onClick={requestClose}
            className={`rounded-md p-1.5 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}>
            <X aria-hidden className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
      <Panel>
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
                  <th scope="row" className="py-1 text-left font-normal">
                    {t(`revenue.${key}`)}
                    {key === 'result.colFixed' && estimated > 0 && (
                      <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">{t('revenue.fixedCosts.hintEstimated', { amount: formatFcp(estimated) })}</span>
                    )}
                  </th>
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
      <RevenueFixedAccounts {...panel} />
      <RevenueDepreciation {...panel} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
