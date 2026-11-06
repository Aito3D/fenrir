import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CheckCheck, ClipboardList, Package, ReceiptText } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { OrderBoardLine, OrderPanelRow } from '../../api/client';
import { OrderContactBlock } from './OrderContactBlock';
import { OrderInvoicesBlock } from './OrderInvoicesBlock';
import { OrderPackBar } from './OrderPackBar';
import { OrderPaymentBlock } from './OrderPaymentBlock';
import { OrderPrepActions } from './OrderPrepActions';
import { OrderQtyStepper } from './OrderQtyStepper';
import { OrderRefChips } from './OrderRefChips';
import { formatQty, packableUnits, panelGroups, parseDay } from './orderBoard';
import type { PanelGroup } from './orderBoard';
import { TONE } from './orderStatus';
import type { Tone } from './orderStatus';

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
}: {
  row: OrderPanelRow;
  others?: { id: string; number: string }[];
  onGoto?: (id: string) => void;
  /** A parcel whose hand-over bar opens on mount (Task 8 reads it). */
  startHandover?: string;
}) {
  const { t } = useTranslation();
  // Set while the operator is checking quantities for a new parcel: line id -> units.
  const [check, setCheck] = useState<Record<string, number> | null>(null);
  const [pending, setPending] = useState(false);
  const packable = packableUnits(row) > 0;
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
    <div className="grid gap-4 border-t border-bambu-dark-tertiary bg-bambu-dark/40 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_27rem]">
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
              <th className="text-right font-medium">{t(check ? 'orders.parcel.inParcel' : 'orders.col.qty')}</th>
              <th className="text-right font-medium">{t('orders.col.available')}</th>
              <th className="text-right font-medium">{t('orders.col.short')}</th>
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
                      {group.id === 'todo' && packable && !check && (
                        <OrderPrepActions row={row} onCreate={() => setCheck(Object.fromEntries(row.lines.filter(l => l.packable > 0).map(l => [l.id, l.packable])))} />
                      )}
                    </div>
                  </th>
                </tr>
                {group.lines.map(({ line, qty, ofQty }, index) => {
                  const todo = group.id === 'todo';
                  const short = todo && (line.state === 'backorder' || line.state === 'to_order');
                  return (
                    <tr key={line.id} className={`${index ? 'border-t border-bambu-dark-tertiary/60' : ''} ${todo && check && line.packable <= 0 ? 'opacity-40' : ''}`}>
                      <td className={`border-l-2 py-2 pl-4 pr-3 ${TONE[meta.tone].rail}`}>
                        <div className="text-white">{line.name}</div>
                        {line.sku && <div className="font-mono text-xs text-bambu-gray">{line.sku}</div>}
                      </td>
                      <td className="whitespace-nowrap text-right tabular-nums text-white">
                        {todo && check && line.packable > 0 ? (
                          <OrderQtyStepper id={line.id} value={Math.min(check[line.id] ?? 0, line.packable)} max={line.packable} disabled={pending} onChange={v => setCheck({ ...check, [line.id]: v })} />
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
                {group.id === 'todo' && check && (
                  <tr>
                    <td colSpan={5} className="pt-2">
                      <OrderPackBar row={row} qty={check} onClose={() => { setCheck(null); setPending(false); }} onBusy={setPending} />
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
        <OrderInvoicesBlock row={row} />
      </div>
    </div>
  );
}
