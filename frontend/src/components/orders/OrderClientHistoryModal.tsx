import { Fragment, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, History, UserRound, X } from 'lucide-react';
import { api } from '../../api/client';
import type { OrderBoardResponse } from '../../api/client';
import { useAitoZohoStatus } from '../../hooks/useAitoZohoStatus';
import { useDismissableDialog } from '../../hooks/useDismissableDialog';
import { formatMoney } from '../../utils/pricing';
import { AitoDialogShell } from '../aito/AitoDialogShell';
import { focusRingCls } from '../formStyles';
import { FinishedLines, Lines } from './OrderClientHistory';
import { clientOrders, formatQty, parseDay } from './orderBoard';
import type { ClientOrder } from './orderBoard';
import { STATUS_META } from './orderStatus';
import { PaymentPill } from './PaymentPill';

/** A beat past .animate-modal-out's 150ms, as in the Aito dialogs. */
const MODAL_OUT_MS = 170;
const INSET = 'px-4 sm:px-6';
const STAT = 'flex items-baseline gap-1.5 rounded-lg bg-bambu-dark-tertiary/45 px-2.5 py-1.5 text-[.78rem] text-bambu-gray';
const FIGURE = 'text-[.88rem] font-semibold tabular-nums text-white';

/** The client's orders as the page already holds them: both lists are read from the cache, never fetched here. */
function useClientOrders(customerId: string): ClientOrder[] {
  const board = useQuery<OrderBoardResponse>({ queryKey: ['order-board'], queryFn: api.getOrderBoard, enabled: false }).data;
  const finished = useQuery({ queryKey: ['order-board', 'finished'], queryFn: api.getFinishedOrders, enabled: false }).data;
  return clientOrders(customerId, board?.rows ?? [], finished?.rows ?? []);
}

/** The History pill of the contact card, and the dialog it opens. Not for the walk-in contact: its orders are everyone's. */
export function OrderClientHistoryButton({ customerId, name, currentId, onGoto, className }: { customerId: string; name: string; currentId?: string; onGoto?: (id: string) => void; className: string }) {
  const { t } = useTranslation();
  const orders = useClientOrders(customerId);
  const [open, setOpen] = useState(false);
  const defaultId = useAitoZohoStatus().data?.default_contact_id;
  if (!customerId || customerId === defaultId) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={t('aito.clientHistory')}
        aria-label={t('aito.clientHistory')}
        className={`${className} border-aito-cyan/30 bg-aito-cyan/[0.14] text-aito-cyan hover:bg-aito-cyan/25 focus-visible:ring-aito-cyan/40`}
      >
        <History aria-hidden="true" className="h-3.5 w-3.5" />
        {t('common.history')}
        {orders.length > 0 && <span className="font-medium tabular-nums opacity-80">· {orders.length}</span>}
      </button>
      {open && (
        <OrderClientHistoryModal
          name={name}
          orders={orders}
          currentId={currentId}
          onClose={() => setOpen(false)}
          onGoto={onGoto && (id => { setOpen(false); onGoto(id); })}
        />
      )}
    </>
  );
}

/** Every order of the client, newest first, on Aito's client-history rail: stat tiles, year markers, and one row per
 *  order that unfolds to its lines. An order still on the board can be jumped to; the one the dialog was opened from is tinted. */
function OrderClientHistoryModal({ name, orders, currentId, onClose, onGoto }: { name: string; orders: ClientOrder[]; currentId?: string; onClose: () => void; onGoto?: (id: string) => void }) {
  const { t } = useTranslation();
  const { closing, requestClose, dialogRef } = useDismissableDialog(onClose, { animationMs: MODAL_OUT_MS });
  const [expanded, setExpanded] = useState<string | null>(null);
  // The board behind stays put while the dialog is open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const currency = orders[0]?.currency ?? '';
  const total = orders.reduce((sum, o) => sum + (o.total ?? 0), 0);
  const left = orders.reduce((sum, o) => sum + o.left, 0);
  const since = orders.length ? parseDay(orders[orders.length - 1].date).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) : '';

  return (
    <AitoDialogShell
      label={t('aito.clientHistory')}
      testId="order-client-history-modal"
      header={
        <header className={`grid grid-cols-[36px_1fr_auto] items-center gap-x-3 ${INSET} pt-5 pb-4`}>
          <span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded-[9px] bg-bambu-dark-tertiary text-bambu-gray-light">
            <UserRound className="h-[17px] w-[17px]" strokeWidth={2.2} />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-[1.15rem] font-semibold leading-tight tracking-[-0.012em] text-white">{name}</h3>
            <p className="mt-0.5 text-[.82rem] text-bambu-gray">{t('aito.clientHistory')}</p>
          </div>
          <button type="button" onClick={requestClose} aria-label={t('common.close')} className={`self-start rounded-lg p-1.5 text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white ${focusRingCls}`}>
            <X className="h-4.5 w-4.5" aria-hidden="true" />
          </button>
        </header>
      }
      closing={closing}
      requestClose={requestClose}
      dialogRef={dialogRef}
      maxWidthCls="max-w-[620px]"
      capHeight
    >
      {orders.length > 0 && (
        <div data-testid="order-client-history-summary" className={`flex flex-wrap items-center gap-1.5 ${INSET} pb-3.5`}>
          <span className={STAT}><b className={FIGURE}>{orders.length}</b> {t('orders.title')}</span>
          <span className={STAT}><b className={FIGURE}>{formatMoney(total, currency)}</b></span>
          <span className={STAT}>
            <Trans i18nKey="aito.clientHistorySince" values={{ date: since }} components={{ b: <b className={FIGURE} /> }} />
          </span>
          {left > 0 && (
            <span className={`${STAT} !bg-status-warning/10 !text-status-warning`}>
              {t('orders.pay.left')} <b className="text-[.88rem] font-semibold tabular-nums">{formatMoney(left, currency)}</b>
            </span>
          )}
        </div>
      )}
      <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-aito-line ${INSET} pt-3.5 pb-5`}>
        {orders.length === 0 ? (
          <p className="py-8 text-sm text-bambu-gray">{t('orders.newOrder.empty')}</p>
        ) : (
          <ol className="relative pl-5 before:absolute before:left-[5px] before:top-2 before:bottom-2 before:w-0.5 before:rounded-full before:bg-bambu-dark-tertiary">
            {orders.map((o, i) => {
              const year = o.date.slice(0, 4);
              const current = o.id === currentId;
              const isOpen = expanded === o.id;
              const stage = o.status ? t(STATUS_META[o.status].label) : t('orders.finished.shipped');
              const dot = o.status ? 'border-bambu-green bg-bambu-green shadow-[0_0_0_4px_rgba(0,174,66,.18)]' : 'border-aito-cyan bg-aito-cyan-dim';
              const chip = current
                ? 'border-bambu-green/40 bg-bambu-green/[0.12] text-bambu-green-light'
                : o.status
                  ? 'border-aito-line bg-white/[0.04] text-aito-muted'
                  : 'border-aito-cyan/35 bg-aito-cyan/[0.12] text-aito-cyan';
              const day = parseDay(o.date);
              return (
                <Fragment key={o.id}>
                  {year !== orders[i - 1]?.date.slice(0, 4) && (
                    <li className="relative mt-3 mb-1.5 text-[.74rem] font-semibold leading-5 tracking-[.04em] text-bambu-gray first:mt-0 before:absolute before:-left-[18px] before:top-[7px] before:h-[7px] before:w-[7px] before:rotate-45 before:rounded-[1.5px] before:bg-bambu-gray-dark">
                      {year}
                    </li>
                  )}
                  <li data-testid="order-client-history-row" aria-current={current ? 'true' : undefined} className="relative mb-1">
                    <span aria-hidden="true" className={`absolute -left-5 top-[13px] z-[1] h-3 w-3 rounded-full border-2 ${dot}`} />
                    <div className={`rounded-[9px] border transition-[background-color,border-color] duration-150 ${current ? 'border-bambu-green/35 bg-bambu-green/[0.07]' : isOpen ? 'border-bambu-dark-tertiary bg-bambu-dark' : 'border-transparent hover:border-bambu-dark-tertiary hover:bg-bambu-dark'}`}>
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() => setExpanded(isOpen ? null : o.id)}
                        className={`grid w-full min-w-0 grid-cols-[62px_1fr_auto] items-baseline gap-x-3 gap-y-[3px] rounded-[9px] px-3 py-2.5 text-left ${focusRingCls}`}
                      >
                        <div className="row-span-2 self-start pt-px text-[.8rem] leading-tight tabular-nums text-bambu-gray-light">
                          {day.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                          <span className="block text-[.72rem] text-bambu-gray">{year}</span>
                        </div>
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[.8rem]">
                          <span className="font-mono font-semibold text-white">{o.number}</span>
                          <span className={`whitespace-nowrap rounded-full border px-2 py-px text-[.7rem] font-semibold ${chip}`}>
                            {current ? `${t('orders.contact.thisOrder')} · ${stage}` : stage}
                          </span>
                          {o.state && <PaymentPill state={o.state} />}
                        </div>
                        <div className="whitespace-nowrap text-[.95rem] font-semibold tabular-nums text-white">
                          {o.total === null ? '–' : formatMoney(o.total, o.currency || currency)}
                        </div>
                        {o.lines && o.lines.length > 0 && (
                          <div className="col-span-2 col-start-2 truncate text-[.9rem] text-white">
                            {o.lines.map(l => `${l.name} ×${formatQty(l.quantity)}`).join(' · ')}
                          </div>
                        )}
                      </button>
                      {isOpen && (
                        <div className="pb-1.5 sm:pl-[74px]">
                          {o.lines ? <Lines lines={o.lines} currency={o.currency || currency} /> : <FinishedLines id={o.id} currency={o.currency || currency} />}
                          {o.status && !current && onGoto && (
                            <button type="button" onClick={() => onGoto(o.id)} className={`mx-2.5 mb-1 mt-1 inline-flex items-center gap-1 rounded-md bg-bambu-green/10 px-2 py-1 text-xs font-semibold text-bambu-green-light hover:bg-bambu-green/20 ${focusRingCls}`}>
                              {t('orders.contact.openOrder', { number: o.number })}
                              <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                </Fragment>
              );
            })}
          </ol>
        )}
      </div>
    </AitoDialogShell>
  );
}
