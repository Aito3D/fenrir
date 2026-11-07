import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { api } from '../../api/client';
import type { OrderItemHit } from '../../api/client';
import { formatMoney } from '../../utils/pricing';
import { formatQty } from './orderBoard';
import { TONE } from './orderStatus';

/** The "add an item" field of an order edit: Books items by name or SKU, from two characters, the ones already on the order left out. */
export function OrderItemSearch({ orderItemIds, currency, disabled, onAdd }: { orderItemIds: Set<string>; currency: string; disabled: boolean; onAdd: (item: OrderItemHit) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const asking = q.length >= 2 && text.trim().length >= 2;
  const { data } = useQuery({ queryKey: ['order-items', q], queryFn: () => api.searchOrderItems(q), enabled: asking });
  const hits = asking && data ? data.items.filter(i => !orderItemIds.has(i.id)).slice(0, 5) : [];
  const add = (item: OrderItemHit) => {
    onAdd(item);
    setText('');
    setQ('');
  };

  return (
    <div className="relative max-w-md">
      <div className="flex items-center gap-2 rounded-md border border-dashed border-bambu-dark-tertiary bg-bambu-dark/40 px-2.5 py-1.5 text-xs focus-within:border-bambu-green">
        <Search aria-hidden="true" className="h-3.5 w-3.5 text-bambu-gray" />
        <input
          type="search"
          value={text}
          disabled={disabled}
          aria-label={t('orders.edit.search')}
          placeholder={t('orders.edit.search')}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && hits[0]) {
              e.preventDefault();
              add(hits[0]);
            } else if (e.key === 'Escape' && text) {
              e.stopPropagation(); // the first Escape clears the field, the next one closes the edit
              setText('');
            }
          }}
          className="w-full bg-transparent text-sm text-white placeholder:text-bambu-gray focus:outline-none disabled:opacity-50"
        />
      </div>
      {hits.length > 0 ? (
        <ul className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-xl">
          {hits.map(h => (
            <li key={h.id}>
              <button type="button" onClick={() => add(h)} className="flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm hover:bg-bambu-dark-tertiary/50">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-white">{h.name}</span>
                  {h.sku && <span className="font-mono text-xs text-bambu-gray">{h.sku}</span>}
                </span>
                {h.stock_on_hand !== null && (
                  <span className={`text-xs tabular-nums ${h.stock_on_hand > 0 ? TONE.success.text : TONE.warning.text}`}>
                    {t('orders.edit.inStock', { n: formatQty(h.stock_on_hand) })}
                  </span>
                )}
                <span className="text-xs tabular-nums text-bambu-gray">{formatMoney(h.rate, currency)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : asking && data ? (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md border border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 py-1.5 text-xs text-bambu-gray">
          {t('orders.edit.noItem')}
        </div>
      ) : null}
    </div>
  );
}
