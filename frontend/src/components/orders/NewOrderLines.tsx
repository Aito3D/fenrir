import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import type { OrderItemHit } from '../../api/client';
import type { NewOrderDraftLine } from '../../hooks/useNewOrderDraft';
import { formatMoney } from '../../utils/pricing';
import { formatQty, lineTotal } from './orderBoard';
import { OrderItemSearch } from './OrderItemSearch';
import { OrderQtyStepper } from './OrderQtyStepper';
import { TRASH, dash } from './orderLinesShared';
import { TONE } from './orderStatus';

// Items already on the draft stay in the search: picking one again adds a unit.
const NONE = new Set<string>();

/** The counter order's lines: the product search, then one row per product with its quantity, price, discount and stock. */
export function NewOrderLines({ lines, currency, disabled, onChange }: { lines: NewOrderDraftLine[]; currency: string; disabled: boolean; onChange: (lines: NewOrderDraftLine[]) => void }) {
  const { t } = useTranslation();
  const add = (item: OrderItemHit) => {
    const i = lines.findIndex(l => l.item.id === item.id);
    onChange(i < 0 ? [...lines, { item, quantity: 1, discount: '' }] : lines.map((l, j) => (j === i ? { ...l, quantity: l.quantity + 1 } : l)));
  };
  const patch = (i: number, p: Partial<NewOrderDraftLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));

  return (
    <div className="min-w-0 space-y-2">
      <OrderItemSearch orderItemIds={NONE} currency={currency} disabled={disabled} onAdd={add} label={t('orders.newOrder.search')} />
      {lines.length > 0 && (
        <div role="region" tabIndex={0} aria-label={t('orders.col.product')} className="overflow-x-auto overscroll-contain">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-bambu-gray">
              <tr>
                <th className="py-1.5 font-medium">{t('orders.col.product')}</th>
                <th className="text-right font-medium">{t('orders.col.qty')}</th>
                <th className="pl-4 text-right font-medium">{t('orders.newOrder.rate')}</th>
                <th className="pl-4 text-right font-medium">{t('orders.newOrder.discount')}</th>
                <th className="pl-4 text-right font-medium">{t('orders.newOrder.total')}</th>
                <th className="pl-4 text-right font-medium">{t('orders.col.available')}</th>
                <th className="pl-4 font-medium">{t('orders.col.state')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const total = lineTotal(l);
                const stock = l.item.stock_on_hand;
                const short = stock === null ? 0 : Math.max(0, l.quantity - stock);
                return (
                  <tr key={l.item.id} className="border-t border-bambu-dark-tertiary/60">
                    <td className="py-2 pr-3">
                      <div className="text-white">{l.item.name}</div>
                      {l.item.sku && <div className="font-mono text-xs text-bambu-gray">{l.item.sku}</div>}
                    </td>
                    <td className="whitespace-nowrap text-right">
                      <OrderQtyStepper
                        id={`new-${l.item.id}`}
                        name={l.item.name}
                        label={t('orders.col.qty')}
                        value={l.quantity}
                        checkbox={false}
                        positive
                        disabled={disabled}
                        onChange={q => patch(i, { quantity: q })}
                      />
                    </td>
                    <td className="whitespace-nowrap pl-4 text-right tabular-nums text-bambu-gray">{formatMoney(l.item.rate, currency)}</td>
                    <td className="pl-4 text-right">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={l.discount}
                        disabled={disabled}
                        placeholder="0"
                        aria-label={`${t('orders.newOrder.discount')} · ${l.item.name}`}
                        aria-invalid={total === null}
                        title={total === null ? t('orders.newOrder.discountInvalid') : undefined}
                        onChange={e => patch(i, { discount: e.target.value })}
                        className={`h-6 w-20 rounded border bg-bambu-dark px-1.5 text-right text-sm tabular-nums text-white focus:outline-none disabled:opacity-50 ${total === null ? 'border-red-500 focus:border-red-500' : 'border-bambu-dark-tertiary focus:border-bambu-green'}`}
                      />
                    </td>
                    <td data-testid="draft-line-total" className="whitespace-nowrap pl-4 text-right font-medium tabular-nums text-white">
                      {total === null ? dash : formatMoney(total, currency)}
                    </td>
                    <td className={`pl-4 text-right tabular-nums ${short ? '' : TONE.success.text}`}>{stock === null ? dash : formatQty(stock)}</td>
                    <td className="whitespace-nowrap pl-4">
                      {short > 0
                        ? <span className={TONE.warning.text}>{t('orders.newOrder.toOrder', { n: formatQty(short) })}</span>
                        : <span className={TONE.success.text}>{t('orders.newOrder.ready')}</span>}
                    </td>
                    <td className="pl-3">
                      <button
                        type="button"
                        aria-label={`${t('orders.edit.remove')} · ${l.item.name}`}
                        title={t('orders.edit.remove')}
                        disabled={disabled}
                        onClick={() => onChange(lines.filter((_, j) => j !== i))}
                        className={TRASH}
                      >
                        <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
