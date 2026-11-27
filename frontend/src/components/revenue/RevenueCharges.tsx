import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowRight, X } from 'lucide-react';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { focusRingCls } from '../formStyles';
import { Panel } from '../aito/stats/primitives';
import { RevenueDepreciation } from './RevenueDepreciation';
import { RevenueFixedAccounts } from './RevenueFixedAccounts';
import { RevenueLabor, type LaborProvider } from './RevenueLabor';
import { RevenueSegmented } from './RevenueSegmented';
import { segmentPanelId, segmentTabId } from './lib/dashboard';
import { formatFcp, formatPerMinute } from './lib/format';
import type { DepreciationState, ResultResponse } from './lib/types';
import { useRevenueResource } from './useRevenueResource';

const MODAL_OUT_MS = 170;
const PREFIX = 'revenue-charges';
const PARTS = [
  { id: 'labor', label: 'revenue.result.colLabor', color: 'bg-bambu-green', cta: 'revenue.charges.editRates' },
  { id: 'fixed', label: 'revenue.result.colFixed', color: 'bg-sky-400', cta: 'revenue.charges.editShares' },
  { id: 'depreciation', label: 'revenue.result.colDepreciation', color: 'bg-violet-400', cta: 'revenue.charges.chooseAssets' },
] as const;
type Tab = 'overview' | (typeof PARTS)[number]['id'];

/** The shop's three charges in one dialog: an overview of what each costs a month and a minute, then a tab per table that sets it. */
export function RevenueCharges({ canManage, version, onChanged, onClose, returnFocus }: {
  canManage: boolean;
  /** Moves when the page's data does, so the summary follows a saved table. */
  version: unknown;
  onChanged: () => void;
  onClose: () => void;
  returnFocus: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<Tab>('overview');
  // The open tab's actions (save, refresh…) render here, so they stay in view under a long table.
  const [foot, setFoot] = useState<HTMLElement | null>(null);
  const { data } = useRevenueResource<ResultResponse>('/api/v1/revenue/result', version);
  // Only for the overview's counts; each table reads its own copy.
  const { data: labor } = useRevenueResource<{ providers: LaborProvider[] }>('/api/v1/revenue/labor', version);
  const { data: assets } = useRevenueResource<DepreciationState>('/api/v1/revenue/depreciation', version);
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
  const amount = c ? { labor: c.labor, fixed: c.fixed + estimated, depreciation: c.depreciation } : null;
  const total = amount ? amount.labor + amount.fixed + amount.depreciation : 0;
  // Only the fixed costs are split; labour and depreciation are the services'.
  const goods = c?.fixedGoods ?? 0;
  const share = (v: number) => (total > 0 ? `${Math.round((100 * v) / total)} %` : '');
  // Every tab stays mounted, only hidden: switching must not drop unsaved rows.
  const pane = (id: Tab) => ({ role: 'tabpanel', id: segmentPanelId(PREFIX, id), 'aria-labelledby': segmentTabId(PREFIX, id), hidden: tab !== id });
  const panel = (id: Tab) => ({ canManage, onChanged, footer: tab === id ? foot : null });
  const note = {
    labor: labor && t('revenue.charges.people', { n: labor.providers.length }),
    fixed: estimated > 0 && <span className="text-amber-700 dark:text-amber-400">{t('revenue.fixedCosts.hintEstimated', { amount: formatFcp(estimated) })}</span>,
    depreciation: assets && t('revenue.charges.assets', { on: assets.selected.length, n: assets.assets.length }),
  };
  // Portalled: an animated ancestor would otherwise become the containing block of `fixed`.
  // No close on a backdrop click: a stray click would drop unsaved rows.
  return createPortal(
    <div className={`fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 backdrop-blur-sm sm:p-4 ${closing ? 'animate-overlay-out pointer-events-none' : 'animate-overlay-in'}`}>
      {/* Full height whatever the tab: the tab bar must not move when the content changes. */}
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={t('revenue.charges.title')} tabIndex={-1}
        className={`flex h-full w-full max-w-[1280px] flex-col rounded-xl border border-bambu-dark-tertiary bg-bambu-dark shadow-2xl outline-none ${closing ? 'animate-modal-out' : 'animate-modal-in'}`}>
        <header className="flex items-center gap-3 border-b border-bambu-dark-tertiary px-4 py-3">
          <h2 className="text-base font-semibold text-white">{t('revenue.charges.title')}</h2>
          {amount && (
            <p className="ml-auto hidden items-baseline gap-2 text-sm tabular-nums sm:flex">
              <span className="text-bambu-gray">{t('revenue.charges.total')}</span>
              <span className="font-semibold text-white">{formatFcp(total)}</span>
              <span className="text-bambu-gray">{formatPerMinute(total)}</span>
            </p>
          )}
          <button type="button" aria-label={t('common.close')} title={t('common.close')} onClick={requestClose}
            className={`rounded-md p-1.5 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white ${amount ? 'ml-auto sm:ml-0' : 'ml-auto'} ${focusRingCls}`}>
            <X aria-hidden className="h-4 w-4" />
          </button>
        </header>
        <div className="overflow-x-auto overflow-y-hidden border-b border-bambu-dark-tertiary px-2">
          <RevenueSegmented tabs underline idPrefix={PREFIX} label={t('revenue.charges.title')} value={tab} onChange={setTab}
            options={[
              { id: 'overview' as Tab, label: t('stats.overview') },
              ...PARTS.map((p) => ({ id: p.id as Tab, label: t(p.label), hint: amount ? formatFcp(amount[p.id]) : undefined })),
            ]} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          <div {...pane('overview')} className="space-y-3">
            {amount && (
              <>
                <Panel className="!p-5">
                  <p className="text-[13px] text-bambu-gray">
                    {t('revenue.charges.total')} · {new Date().toLocaleDateString(i18n.language, { month: 'long', year: 'numeric' })}
                  </p>
                  <p className="mt-1 flex flex-wrap items-baseline gap-x-3 tabular-nums">
                    <span className="text-3xl font-semibold tracking-tight text-white">{formatFcp(total)}</span>
                    <span className="text-sm text-bambu-gray">{t('revenue.fixedCosts.monthly')} · {formatPerMinute(total)}</span>
                  </p>
                  {total > 0 && (
                    <>
                      <div aria-hidden className="mt-4 flex h-2.5 gap-0.5 overflow-hidden rounded-full">
                        {PARTS.map((p) => <span key={p.id} className={p.color} style={{ flexGrow: amount[p.id], flexBasis: 0 }} />)}
                      </div>
                      <ul className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-xs text-bambu-gray-light">
                        {PARTS.map((p) => (
                          <li key={p.id} className="flex items-center gap-2">
                            <span aria-hidden className={`h-2 w-2 rounded-sm ${p.color}`} />
                            {t(p.label)} {share(amount[p.id])}
                          </li>
                        ))}
                      </ul>
                      <p className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-bambu-dark-tertiary pt-3 text-sm tabular-nums text-bambu-gray-light">
                        {([['goods', goods], ['services', total - goods]] as const).map(([k, v]) => (
                          <span key={k}>{t(`revenue.filters.${k}`)} <span className="font-semibold text-white">{formatFcp(v)}</span> {share(v)}</span>
                        ))}
                      </p>
                    </>
                  )}
                </Panel>
                <div className="grid gap-3 md:grid-cols-3">
                  {PARTS.map((p) => (
                    <button key={p.id} type="button" onClick={() => setTab(p.id)}
                      className={`flex flex-col rounded-[.6rem] border border-bambu-dark-tertiary bg-bambu-dark-secondary p-4 text-left transition hover:-translate-y-px hover:border-bambu-gray-dark ${focusRingCls}`}>
                      <span className="flex items-center gap-2 text-[13px] text-bambu-gray-light">
                        <span aria-hidden className={`h-2 w-2 rounded-sm ${p.color}`} />
                        {t(p.label)}
                        <span className="ml-auto tabular-nums text-bambu-gray">{share(amount[p.id])}</span>
                      </span>
                      <span className="mt-2 block text-[22px] font-semibold tabular-nums text-white">{formatFcp(amount[p.id])}</span>
                      <span className="block text-sm tabular-nums text-bambu-gray">{formatPerMinute(amount[p.id])}</span>
                      <span className="mt-3 flex items-center justify-between gap-3 border-t border-bambu-dark-tertiary pt-2.5 text-xs text-bambu-gray">
                        <span>{note[p.id]}</span>
                        <span className="inline-flex items-center gap-1">{t(p.cta)}<ArrowRight aria-hidden className="h-3.5 w-3.5" /></span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <div {...pane('labor')}><RevenueLabor {...panel('labor')} /></div>
          <div {...pane('fixed')}><RevenueFixedAccounts {...panel('fixed')} /></div>
          <div {...pane('depreciation')}><RevenueDepreciation {...panel('depreciation')} /></div>
        </div>
        <footer ref={setFoot} className="border-t border-bambu-dark-tertiary px-4 py-2.5 empty:hidden" />
      </div>
    </div>,
    document.body,
  );
}
