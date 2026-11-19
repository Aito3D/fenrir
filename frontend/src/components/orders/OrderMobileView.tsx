import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, MoreHorizontal } from 'lucide-react';
import type { OrderBoardRow, OrderPanelRow } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { formatMoney } from '../../utils/pricing';
import { PanelTabs } from '../aito/PanelTabs';
import { Sheet } from '../mobile/Sheet';
import { formatQty, nextStep } from './orderBoard';
import { OrderLinesPanel } from './OrderLinesPanel';
import { OrderRefActions } from './OrderRefActions';
import type { PhoneTab } from './OrderSidePanel';
import { useHandOverPending } from './useOrderActions';
import { PaymentPill } from './PaymentPill';
import { KIND, STATUS_META, TONE } from './orderStatus';

const BAR_BTN = 'min-h-11 rounded-xl px-4 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green';

/** One order, full screen on the phone: header, summary, a tab per part of the panel, and the next step in a bar at the bottom. */
export function OrderMobileView({
  row,
  status,
  onClose,
  others,
  onGoto,
  onStart,
  start,
  startTick,
  onEdited,
}: {
  row: OrderPanelRow;
  status: OrderBoardRow['status'] | 'finished';
  onClose: () => void;
  others?: { id: string; number: string }[];
  onGoto?: (id: string) => void;
  /** Absent for a finished order: there is no next step. */
  onStart?: (target: string) => void;
  start?: string;
  startTick?: number;
  onEdited?: () => void;
}) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<PhoneTab>(params.get('sms') === '1' && params.get('order') === row.id ? 'client' : 'lines');
  const [barOpen, setBarOpen] = useState(false);
  const [more, setMore] = useState(false);
  const tabScope = `order-${row.id}-m-`;
  const handingOver = useHandOverPending(row.id);
  const root = useRef<HTMLDivElement>(null);
  // A full-screen layer: focus moves in, and back to the order's row when it closes.
  useEffect(() => {
    root.current?.focus();
    const id = row.id;
    return () => document.querySelector<HTMLElement>(`#order-${id} [data-order-row]`)?.focus();
  }, [row.id]);
  const canUpdate = hasPermission('orders:update');
  const target = canUpdate && onStart ? nextStep(row) : null;
  const collect = canUpdate && !!row.payment && row.payment.left > 0;
  const meta = status === 'finished' ? null : STATUS_META[status];
  const tone = meta && TONE[meta.tone];
  const StatusIcon = meta?.icon;
  const units = row.units;
  const kind = target ? KIND[target.split('-')[0] as keyof typeof KIND] : null;

  return (
    <div
      ref={root}
      data-testid="order-mobile"
      role="dialog"
      aria-modal="true"
      aria-label={row.number}
      tabIndex={-1}
      onKeyDown={e => {
        // Not while a bar, the ⋯ sheet or a modal inside the view owns Escape.
        if (e.key !== 'Escape' || barOpen || more || (e.target as Element).closest('[role="dialog"]') !== root.current) return;
        onClose();
      }}
      className="fixed inset-0 z-[45] flex flex-col bg-bambu-dark focus:outline-none"
    >
      <header className="flex items-center gap-1 border-b border-bambu-dark-tertiary px-2 py-2">
        <button type="button" onClick={onClose} aria-label={t('orders.mobile.back')} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-bambu-gray hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green">
          <ChevronLeft aria-hidden="true" className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-white">{row.customer || '–'}</div>
          <div className="font-mono text-xs text-bambu-gray">{row.number}</div>
        </div>
        <button type="button" onClick={() => setMore(true)} aria-label={t('orders.mobile.more')} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-bambu-gray hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green">
          <MoreHorizontal aria-hidden="true" className="h-5 w-5" />
        </button>
      </header>
      <div data-testid="order-mobile-summary" className="space-y-2 px-4 pt-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-lg font-semibold tabular-nums text-white">{row.total === null ? '–' : formatMoney(row.total, row.currency)}</span>
          {meta && tone && StatusIcon && (
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${tone.soft} ${tone.text}`}>
              <StatusIcon aria-hidden="true" className="h-3.5 w-3.5" />
              {t(meta.label)}
            </span>
          )}
        </div>
        <div className="flex justify-between gap-2 text-xs text-bambu-gray">
          <span>{t('orders.shipped', { shipped: formatQty(units.shipped), total: formatQty(units.total) })}</span>
          <span>{t('orders.readyPct', { pct: Math.round(row.ready_ratio * 100) })}</span>
        </div>
        {row.payment && <PaymentPill state={row.payment.state} pct={row.payment.pct} overdue={row.payment.overdue > 0} fill />}
      </div>
      <div className="px-4 pt-3">
        <PanelTabs
          tabs={[
            { id: 'lines', label: t('orders.mobile.tabs.lines') },
            { id: 'billing', label: t('orders.mobile.tabs.billing') },
            { id: 'client', label: t('orders.mobile.tabs.client') },
            { id: 'activity', label: t('aito.history.title') },
          ]}
          selected={tab}
          onSelect={setTab}
          attentionLabel={t('aito.panelTabAttention')}
          scope={tabScope}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <OrderLinesPanel row={row} phoneTab={tab} tabScope={tabScope} onBarOpen={setBarOpen} start={start} startTick={startTick} onGoto={onGoto} others={others} onEdited={onEdited} />
      </div>
      {!barOpen && (collect || kind) && (
        <div data-testid="order-mobile-bar" className="flex gap-2 border-t border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          {collect && (
            <button type="button" onClick={() => setTab('billing')} className={`${BAR_BTN} flex-1 bg-bambu-dark-tertiary text-white`}>
              {t('orders.mobile.collect')}
            </button>
          )}
          {kind && target && (
            <button type="button" disabled={handingOver} onClick={() => { setTab('lines'); onStart?.(target); }} className={`${BAR_BTN} flex-1 bg-bambu-green text-black disabled:opacity-50`}>
              {t(kind.label)}
            </button>
          )}
        </div>
      )}
      {more && (
        <Sheet label={t('orders.mobile.more')} onClose={() => setMore(false)}>
          {() => <OrderRefActions row={row} />}
        </Sheet>
      )}
    </div>
  );
}
