import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Check, CheckCheck, ClipboardList, HandHelping, Package, ReceiptText } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../../api/client';
import type { OrderBoardLine, OrderPanelRow, OrderPicklist } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { usePrintBlob } from '../aito/usePrintBlob';
import { errorReason, isRefused } from './orderErrors';
import { OrderContactBlock } from './OrderContactBlock';
import { OrderHandoverBar } from './OrderHandoverBar';
import { OrderInvoicesBlock } from './OrderInvoicesBlock';
import { OrderPackBar } from './OrderPackBar';
import { OrderPaymentBlock } from './OrderPaymentBlock';
import { OrderPrepActions } from './OrderPrepActions';
import { OrderQtyStepper } from './OrderQtyStepper';
import { OrderRefChips } from './OrderRefChips';
import { boxablePicklists, canPick, formatQty, packableUnits, panelGroups, parseDay, waitingPackages } from './orderBoard';
import type { OrderCheck, PanelGroup } from './orderBoard';
import { FIT_VIEWPORT, TONE } from './orderStatus';
import type { Tone } from './orderStatus';
import { useHandOverPending, useOrderActions } from './useOrderActions';
import { useOrderOutcomeToasts } from './useOrderOutcomeToasts';

const GROUP: Record<PanelGroup['id'], { label: string; icon: LucideIcon; tone: Tone; band: string; name: string; dim: boolean }> = {
  todo: { label: 'orders.group.todo', icon: ClipboardList, tone: 'neutral', band: 'bg-bambu-green/10', name: 'text-white', dim: false },
  packed: { label: 'orders.group.packed', icon: Package, tone: 'info', band: TONE.info.soft, name: TONE.info.text, dim: false },
  shipped: { label: 'orders.group.shipped', icon: CheckCheck, tone: 'neutral', band: TONE.neutral.soft, name: 'text-bambu-gray', dim: true },
  other: { label: 'orders.group.other', icon: ReceiptText, tone: 'neutral', band: TONE.neutral.soft, name: 'text-bambu-gray', dim: true },
};

const LINE_STATE: Record<OrderBoardLine['state'], { label: string; cls: string }> = {
  ready: { label: 'orders.line.ready', cls: TONE.success.text },
  backorder: { label: 'orders.line.backorder', cls: TONE.warning.text },
  to_order: { label: 'orders.line.toOrder', cls: TONE.danger.text },
  shipped: { label: 'orders.line.shipped', cls: 'text-bambu-gray' },
  cancelled: { label: 'orders.line.cancelled', cls: 'text-bambu-gray' },
  service: { label: 'orders.line.service', cls: 'text-bambu-gray' },
};

const dash = <span className="text-bambu-gray">–</span>;

/** The expanded order: one table, split into what is left to prepare, what is
 *  boxed and waiting, what has gone, and the lines that never ship. A group
 *  header is a tinted band, so it cannot be mistaken for a product row. */
export function OrderLinesPanel({
  row,
  others = [],
  onGoto,
  start,
  startTick,
}: {
  row: OrderPanelRow;
  others?: { id: string; number: string }[];
  onGoto?: (id: string) => void;
  /** The step that opens, on mount and whenever `startTick` changes: 'pick', 'pack-<picklist id>' or 'handover-<package id>'. */
  start?: string;
  /** Changes with every click on the row icon, so a second click reopens a bar that was cancelled. */
  startTick?: number;
}) {
  const { t } = useTranslation();
  const toasts = useOrderOutcomeToasts();
  const { canUpdate, createInvoice, printSheet } = useOrderActions({ invoice: { onSuccess: r => toasts.outcome(r.outcome), onError: toasts.failed } });
  // The parcel whose hand-over bar is open.
  const [handover, setHandover] = useState<string | null>(null);
  // While a hand-over of this order is in flight, the bar on screen stays as it is.
  const handingOver = useHandOverPending(row.id);
  const pendingNow = useRef(handingOver);
  pendingNow.current = handingOver;
  // Set while the operator chooses the lines of a new picklist, or checks the parcel of one.
  const [checkState, setCheck] = useState<OrderCheck | null>(null);
  const [pending, setPending] = useState(false);
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const { print, busy: printing } = usePrintBlob({ failureMessage: t('orders.prep.printFailed'), downloadFilename: `${row.number}-prep.pdf` });
  // The check being loaded: what a picklist or its parcel may hold is asked from Zoho when the check opens.
  const [opening, setOpening] = useState<string | null>(null);
  const openCheck = async (picklist: OrderPicklist | null) => {
    setOpening(picklist?.id ?? 'pick');
    try {
      const { lines } = picklist ? await api.getOrderPicklist(row.id, picklist.id) : await api.getOrderPicklistPreview(row.id);
      const max = Object.fromEntries(lines.map(l => [l.line_id, l.quantity]));
      if (!lines.length) showToast(t(picklist ? 'orders.pick.boxed' : 'orders.pick.nothing'), 'error');
      else setCheck({ kind: picklist ? 'pack' : 'pick', picklist: picklist ?? undefined, max, qty: { ...max } });
    } catch (e) {
      showToast(t(picklist ? 'orders.parcel.failed' : 'orders.pick.failed', { reason: errorReason(t, e) }), 'error');
      if (isRefused(e)) void queryClient.invalidateQueries({ queryKey: ['order-board'], exact: true });
    } finally {
      setOpening(null);
    }
  };
  const starter = useRef({ openCheck, row });
  starter.current = { openCheck, row };
  useEffect(() => {
    if (!start || !canUpdate || pendingNow.current) return;
    const id = start.slice(start.indexOf('-') + 1);
    if (start.startsWith('handover-')) setHandover(id);
    else if (start === 'pick') void starter.current.openCheck(null);
    else {
      const picklist = (starter.current.row.picklists ?? []).find(p => p.id === id);
      if (picklist) void starter.current.openCheck(picklist);
    }
  }, [start, startTick, canUpdate]);
  const invoiceSent = useRef(false);
  const handoverOpen = !!handover && waitingPackages(row).some(p => p.id === handover);
  // A choice of what to pick only exists while the shelf holds something, the parcel check of a picklist while
  // units are left to box; a refetch that ends either closes it for good.
  const packable = checkState?.kind === 'pack' ? panelGroups(row).some(g => g.id === 'todo') : packableUnits(row) > 0;
  const check = checkState && packable ? checkState : null;
  const checkLabel = check ? (check.kind === 'pick' ? 'orders.pick.toPick' : 'orders.parcel.inParcel') : null;
  useEffect(() => {
    if (checkState && !packable) {
      setCheck(null);
      setPending(false);
    }
  }, [checkState, packable]);
  // After a bar closes, focus goes back to the button that opened it (found again by `data-opens`).
  const root = useRef<HTMLDivElement>(null);
  const refocus = useRef<string | null>(null);
  useEffect(() => {
    if (!refocus.current) return;
    root.current?.querySelector<HTMLElement>(`[data-opens="${refocus.current}"]`)?.focus();
    refocus.current = null;
  });
  const shortDay = (day: string) => parseDay(day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const chips = (group: PanelGroup['id']) =>
    row.packages
      .filter(p => (group === 'packed' ? p.status === 'not_shipped' : group === 'shipped' && p.status !== 'not_shipped'))
      .map(p => (
        <span
          key={p.number}
          className={`rounded-full border border-bambu-dark-tertiary bg-bambu-dark/40 px-2 py-0.5 text-[10px] font-normal normal-case tracking-normal ${group === 'packed' ? TONE.info.text : 'text-bambu-gray'}`}
        >
          {t(p.status === 'not_shipped' ? 'orders.pkg.packed' : p.status === 'delivered' ? 'orders.pkg.delivered' : 'orders.pkg.shipped', {
            number: p.number,
            date: shortDay(p.date),
          })}
        </span>
      ));

  return (
    <div ref={root} className="grid gap-4 border-t border-bambu-dark-tertiary bg-bambu-dark/40 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_27rem]">
      <div className="order-last min-w-0 lg:order-none">
      <OrderRefChips row={row} />
      <div
        role="region"
        tabIndex={0}
        aria-label={t('orders.col.product')}
        className="overflow-x-auto overscroll-contain lg:max-h-[70vh] lg:overflow-y-auto"
      >
        <table className="w-full min-w-[35rem] text-sm">
          <thead className="bg-bambu-dark text-left lg:sticky lg:top-0 lg:z-10 text-[11px] uppercase tracking-wide text-bambu-gray">
            <tr>
              <th className="py-1.5 font-medium">{t('orders.col.product')}</th>
              <th className="text-right font-medium">{t(checkLabel ?? 'orders.col.qty')}</th>
              <th className="pl-4 text-right font-medium">{t('orders.col.available')}</th>
              <th className="pl-4 text-right font-medium">{t('orders.col.short')}</th>
              <th className="pl-4 font-medium">{t('orders.col.state')}</th>
            </tr>
          </thead>
          {panelGroups(row).map(group => {
            const meta = GROUP[group.id];
            const Icon = meta.icon;
            return (
              <tbody key={group.id} className={meta.dim ? 'opacity-60' : ''}>
                <tr>
                  <th role="rowheader" colSpan={5} className="pt-3 pb-1 text-left font-normal">
                    <div className={`flex flex-wrap items-center gap-2 rounded-md px-3 py-1.5 text-xs ${meta.band}`}>
                      <Icon aria-hidden="true" className={`h-3.5 w-3.5 ${meta.name}`} />
                      <span className={`font-semibold uppercase tracking-wide ${meta.name}`}>{t(meta.label)}</span>
                      {group.units !== null && (
                        <span className="rounded-full bg-bambu-dark/60 px-2 py-0.5 text-[11px] tabular-nums text-bambu-gray">
                          {t('orders.units', { count: group.units })}
                        </span>
                      )}
                      {chips(group.id)}
                      {group.id === 'packed' && canUpdate && !handoverOpen && (
                        <span className={`flex basis-full flex-wrap items-center gap-2 lg:ml-auto lg:basis-auto ${FIT_VIEWPORT}`}>
                          {waitingPackages(row).map((p, _i, all) => (
                            <button
                              key={p.id}
                              type="button"
                              data-opens={`handover-${p.id}`}
                              onClick={() => setHandover(p.id)}
                              className="inline-flex items-center gap-1.5 rounded-md border border-bambu-dark-tertiary bg-bambu-dark/60 px-2.5 py-1 text-xs text-white hover:border-blue-400 hover:text-blue-400"
                            >
                              <HandHelping aria-hidden="true" className="h-3.5 w-3.5" />
                              {all.length > 1 ? t('orders.handover.openNumber', { number: p.number }) : t('orders.handover.open')}
                            </button>
                          ))}
                        </span>
                      )}
                      {group.id === 'todo' && !check && (canPick(row) || boxablePicklists(row).length > 0) && (
                        <OrderPrepActions
                          row={row}
                          opening={opening}
                          printing={printing}
                          onPick={() => void openCheck(null)}
                          onPack={p => void openCheck(p)}
                          onPrint={p => void print(printSheet(row.id, p.id))}
                        />
                      )}
                    </div>
                  </th>
                </tr>
                {group.lines.map(({ line, qty, ofQty }, index) => {
                  const todo = group.id === 'todo';
                  const short = todo && (line.state === 'backorder' || line.state === 'to_order');
                  return (
                    <tr key={line.id} className={`${index ? 'border-t border-bambu-dark-tertiary/60' : ''} ${todo && check && !(check.max[line.id] > 0) ? 'opacity-40' : ''}`}>
                      <td className={`border-l-2 py-2 pl-4 pr-3 ${TONE[meta.tone].rail}`}>
                        <div className="text-white">{line.name}</div>
                        {line.sku && <div className="font-mono text-xs text-bambu-gray">{line.sku}</div>}
                      </td>
                      <td className="whitespace-nowrap text-right tabular-nums text-white">
                        {todo && check && checkLabel && check.max[line.id] > 0 ? (
                          <OrderQtyStepper
                            id={line.id}
                            name={line.name}
                            label={t(checkLabel)}
                            value={Math.min(check.qty[line.id] ?? 0, check.max[line.id])}
                            max={check.max[line.id]}
                            disabled={pending}
                            onChange={v => setCheck({ ...check, qty: { ...check.qty, [line.id]: v } })}
                          />
                        ) : (
                          formatQty(qty)
                        )}
                        {ofQty !== null && <span className="ml-1 text-xs text-bambu-gray">{t('orders.ofOrdered', { n: formatQty(ofQty) })}</span>}
                        {todo && line.invoiced > 0 && (
                          <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] ${TONE.info.soft} ${TONE.info.text}`}>{t('orders.line.invoiced')}</span>
                        )}
                      </td>
                      <td className={`text-right tabular-nums ${todo && line.state === 'ready' ? TONE.success.text : 'text-white'}`}>
                        {todo && line.stock_available !== null ? formatQty(line.stock_available) : dash}
                      </td>
                      <td className={`text-right tabular-nums ${short ? LINE_STATE[line.state].cls : ''}`}>
                        {short ? <>−{formatQty(line.shortfall)}</> : dash}
                      </td>
                      <td className="whitespace-nowrap pl-4">
                        {group.id === 'packed' && (
                          <span className={`inline-flex items-center gap-1 ${TONE.info.text}`}>
                            <Package aria-hidden="true" className="h-3.5 w-3.5" />
                            {t('orders.line.packed')}
                          </span>
                        )}
                        {group.id === 'shipped' && (
                          <span className="inline-flex items-center gap-1 text-bambu-gray">
                            <Check aria-hidden="true" className="h-3.5 w-3.5" />
                            {t('orders.line.shipped')}
                          </span>
                        )}
                        {(todo || group.id === 'other') && <span className={LINE_STATE[line.state].cls}>{t(LINE_STATE[line.state].label)}</span>}
                        {todo && line.covered_by_po > 0 && (
                          <span className="ml-1.5 text-xs text-bambu-gray">
                            {line.po_numbers.join(', ')} · +{formatQty(line.covered_by_po)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {group.id === 'packed' && handoverOpen && handover && (
                  <tr>
                    <td colSpan={5} className="pt-2">
                      <OrderHandoverBar key={handover} row={row} packageId={handover} onClose={() => { refocus.current = `handover-${handover}`; setHandover(null); }} />
                    </td>
                  </tr>
                )}
                {group.id === 'todo' && check && (
                  <tr>
                    <td colSpan={5} className="pt-2">
                      <OrderPackBar
                        row={row}
                        check={check}
                        onClose={() => { refocus.current = check.picklist ? `pack-${check.picklist.id}` : 'pick'; setCheck(null); setPending(false); }}
                        onBusy={setPending}
                        onPicked={p => void print(printSheet(row.id, p.id))}
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            );
          })}
        </table>
      </div>
      </div>
      <div className="space-y-3 lg:self-start">
        <OrderContactBlock contact={row.contact} orderNumber={row.number} others={others} onGoto={onGoto} />
        {row.payment && <OrderPaymentBlock payment={row.payment} currency={row.currency} />}
        <OrderInvoicesBlock
          row={row}
          busy={createInvoice.isPending}
          onCreateInvoice={canUpdate ? () => {
            if (createInvoice.isPending || invoiceSent.current) return;
            invoiceSent.current = true;
            createInvoice.mutate({ id: row.id, applyCredit: (row.payment?.advance ?? 0) > 0 }, { onSettled: () => { invoiceSent.current = false; } });
          } : undefined}
        />
      </div>
    </div>
  );
}
