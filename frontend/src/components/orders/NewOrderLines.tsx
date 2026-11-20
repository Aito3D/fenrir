import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScanBarcode, Trash2 } from 'lucide-react';
import type { OrderItemHit } from '../../api/client';
import type { NewOrderDraftLine } from '../../hooks/useNewOrderDraft';
import { formatMoney } from '../../utils/pricing';
import { formatQty, lineTotal } from './orderBoard';
import { HoldButton } from '../aito/HoldButton';
import { focusRingCls } from '../formStyles';
import { OrderItemSearch } from './OrderItemSearch';
import { ItemSwatch } from './ItemSwatch';
import { available } from './itemSearchText';
import { OrderQtyStepper } from './OrderQtyStepper';
import { dash } from './orderLinesShared';
import { TONE } from './orderStatus';

// Items already on the draft stay in the search: picking one again adds a unit.
const NONE = new Set<string>();
// Matches .order-line-out in index.css: the row folds away, then leaves the draft.
const LEAVE_MS = 200;
// One template for the header and every row, so the columns line up (md and up).
const COLS = 'grid-cols-[1.5rem_minmax(0,1fr)_auto_auto] md:grid-cols-[1.5rem_minmax(0,1fr)_7.5rem_6.5rem_7.5rem_2rem]';

/** The counter order's lines, scanner first: a large search on top whose results take the place of the lines while
 *  something is typed, then one row per product with its quantity, discount, total and what can be sold. */
export function NewOrderLines({ lines, currency, disabled, onChange }: { lines: NewOrderDraftLine[]; currency: string; disabled: boolean; onChange: (lines: NewOrderDraftLine[]) => void }) {
  const { t } = useTranslation();
  const [searching, setSearching] = useState(false);
  // The line a scan just touched: it lands (new) or washes again (one more unit). n re-keys the wash.
  const [pulse, setPulse] = useState<{ id: string; isNew: boolean; n: number } | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  const add = (item: OrderItemHit) => {
    const i = lines.findIndex(l => l.item.id === item.id);
    setPulse({ id: item.id, isNew: i < 0, n: (pulse?.n ?? 0) + 1 });
    onChange(i < 0 ? [...lines, { item, quantity: 1, discount: '' }] : lines.map((l, j) => (j === i ? { ...l, quantity: l.quantity + 1 } : l)));
  };
  const patch = (i: number, p: Partial<NewOrderDraftLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const remove = (id: string) => {
    setLeaving(id);
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      setLeaving(null);
      onChange(lines.filter(l => l.item.id !== id));
    }, LEAVE_MS);
  };

  return (
    <div className="min-w-0">
      {/* autoFocus-free: the dialog takes focus on open; the field is one Tab away and a scanner types into it from there */}
      <OrderItemSearch orderItemIds={NONE} currency={currency} disabled={disabled} onAdd={add} label={t('orders.newOrder.search')} className="" inline onOpenChange={setSearching} />
      {searching ? null : lines.length === 0 ? (
        <div className="animate-rise grid justify-items-center gap-2 px-4 py-16 text-center">
          <ScanBarcode aria-hidden="true" className="h-8 w-8 text-bambu-gray" />
          <p className="text-base font-semibold text-white">{t('orders.newOrder.scanTitle')}</p>
          <p className="max-w-sm text-sm text-bambu-gray">{t('orders.newOrder.scanHint')}</p>
        </div>
      ) : (
        <div className="mt-4">
        <div aria-hidden="true" className={`hidden ${COLS} gap-x-4 border-b border-bambu-dark-tertiary/60 px-2 pb-2 text-[11px] font-semibold uppercase tracking-wider text-bambu-gray md:grid`}>
          <span />
          <span>{t('orders.col.product')}</span>
          <span>{t('orders.col.qty')}</span>
          <span className="text-right">{t('orders.newOrder.discount')}</span>
        </div>
        <ul aria-label={t('orders.col.product')} className="divide-y divide-bambu-dark-tertiary/60">
          {lines.map((l, i) => {
            const total = lineTotal(l);
            const stock = available(l.item);
            const short = stock === null ? 0 : Math.max(0, l.quantity - stock);
            const hit = pulse?.id === l.item.id ? pulse : null;
            const motion = leaving === l.item.id ? 'order-line-out' : hit?.isNew ? 'animate-order-line-in' : '';
            return (
              <li key={l.item.id} className={`relative grid ${COLS} items-center gap-x-4 gap-y-2 rounded-lg px-2 py-3 transition-colors hover:bg-white/[0.02] ${motion}`}>
                {hit && <span key={hit.n} aria-hidden="true" className="order-line-wash" onAnimationEnd={() => setPulse(null)} />}
                <span className="grid place-items-center"><ItemSwatch item={l.item} /></span>
                <div className="min-w-0">
                  <div className="truncate font-medium text-white" title={l.item.name}>{l.item.name}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-bambu-gray">
                    {l.item.sku && <span className="font-mono text-bambu-gray-dark">{l.item.sku}</span>}
                    <span className="tabular-nums">{formatMoney(l.item.rate, currency)}</span>
                    <span className={`inline-flex items-center gap-1.5 tabular-nums ${short > 0 ? TONE.warning.text : ''}`}>
                      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${short > 0 ? 'bg-current' : 'bg-bambu-green'}`} />
                      {t('orders.edit.availableN', { n: stock === null ? dash : formatQty(stock) })}
                    </span>
                    {short > 0 && <span className={TONE.warning.text}>{t('orders.newOrder.toOrder', { n: formatQty(short) })}</span>}
                  </div>
                </div>
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
                <input
                  type="text"
                  inputMode="decimal"
                  value={l.discount}
                  disabled={disabled}
                  placeholder={t('orders.newOrder.discount')}
                  aria-label={`${t('orders.newOrder.discount')} · ${l.item.name}`}
                  aria-invalid={total === null}
                  title={total === null ? t('orders.newOrder.discountInvalid') : undefined}
                  onChange={e => patch(i, { discount: e.target.value })}
                  className={`col-start-2 h-8 w-full rounded-md border bg-bambu-dark px-2 text-right text-sm tabular-nums text-white transition-[border-color,box-shadow] duration-150 placeholder:text-bambu-gray-dark focus:outline-none focus:ring-2 disabled:opacity-50 md:col-start-auto ${total === null ? 'border-red-500 focus:border-red-500 focus:ring-red-500/20' : l.discount ? 'border-bambu-green/50 focus:border-bambu-green focus:ring-bambu-green/20' : 'border-bambu-dark-tertiary focus:border-bambu-green focus:ring-bambu-green/20'}`}
                />
                <div data-testid="draft-line-total" className="whitespace-nowrap text-right font-semibold tabular-nums text-white">
                  {total === null ? dash : formatMoney(total, currency)}
                </div>
                <HoldButton
                  onHold={() => remove(l.item.id)}
                  durationMs={1000}
                  progress="perimeter"
                  label={`${t('orders.edit.remove')} · ${l.item.name}`}
                  hint={t('aito.holdToDelete')}
                  disabled={disabled}
                  className={`h-8 w-8 justify-center border border-bambu-dark-tertiary text-bambu-gray hover:border-red-400/45 hover:text-red-400 focus-visible:ring-red-400/40 data-[holding=true]:border-red-400 data-[holding=true]:text-red-400 ${focusRingCls}`}
                >
                  <Trash2 aria-hidden="true" className="relative h-4 w-4" />
                </HoldButton>
              </li>
            );
          })}
        </ul>
        </div>
      )}
    </div>
  );
}
