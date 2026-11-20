import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2, Search } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { OrderItemHit } from '../../api/client';
import { errorReason } from './orderErrors';
import { formatMoney } from '../../utils/pricing';
import { formatQty } from './orderBoard';
import { TONE } from './orderStatus';
import { available, itemCodes, markWords, matchedCode } from './itemSearchText';
import { ItemSwatch } from './ItemSwatch';

/** The "add an item" field of an order: catalogue items by name, SKU or barcode, from two characters, asked once typing
 *  pauses a second, best first (the server ranks, in-stock first), the ones already on the order left out. ↑/↓ pick a
 *  result and Enter adds it. A scanner types its code and Enter faster than the search answers: that Enter asks at
 *  once, then adds the item whose SKU, UPC or EAN is the code (or the only hit), never a guess among several. */
export function OrderItemSearch({ orderItemIds, currency, disabled, onAdd, label, className = 'max-w-md', inline = false, onOpenChange }: {
  orderItemIds: Set<string>;
  currency: string;
  disabled: boolean;
  onAdd: (item: OrderItemHit) => void;
  label?: string;
  className?: string;
  /** A large field whose results sit in the flow below it, in place of what the caller hides, instead of a dropdown. */
  inline?: boolean;
  /** Two characters or more are typed: the results (or the wait for them) own the space below. */
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const placeholder = label ?? t('orders.edit.search');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 1000); // ask once typing pauses a second
    return () => clearTimeout(timer);
  }, [text]);
  const typed = text.trim();
  const asking = q.length >= 2 && typed.length >= 2;
  const { data, error, isFetching } = useQuery({
    queryKey: ['order-items', q],
    queryFn: () => api.searchOrderItems(q),
    enabled: asking,
    // A sync pass can spend the Books call budget for a few seconds (503): keep asking rather than go silent.
    retry: (n, e) => n < (e instanceof ApiError && e.status === 503 ? 5 : 1),
    retryDelay: 2000,
  });
  const hits = asking && data ? data.items.filter(i => !orderItemIds.has(i.id)).slice(0, 8) : [];
  const waiting = typed.length >= 2 && (typed !== q || isFetching);
  const open = typed.length >= 2;
  const openRef = useRef(onOpenChange);
  openRef.current = onOpenChange;
  useEffect(() => openRef.current?.(open), [open]);
  const pop = inline ? 'mt-2' : 'absolute left-0 right-0 top-full z-20 mt-1 shadow-xl';
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [data, q]);
  // The text an Enter was pressed on before its search answered.
  const [pending, setPending] = useState<string | null>(null);
  const add = (item: OrderItemHit) => {
    onAdd(item);
    setText('');
    setQ('');
  };
  const addRef = useRef(add);
  addRef.current = add;
  const exact = (code: string) => hits.find(h => itemCodes(h).includes(code));
  useEffect(() => {
    if (pending === null || q !== pending || !data) return;
    setPending(null);
    const match = exact(pending) ?? (hits.length === 1 ? hits[0] : undefined);
    if (match) addRef.current(match);
  }, [pending, q, data]); // eslint-disable-line react-hooks/exhaustive-deps -- hits and exact derive from data and q

  return (
    <div className={`relative ${className}`}>
      <div className={`flex items-center gap-2 border bg-bambu-dark/40 focus-within:border-bambu-green ${inline ? 'h-12 gap-3 rounded-lg border-bambu-dark-tertiary px-4 focus-within:ring-2 focus-within:ring-bambu-green/20' : 'rounded-md border-dashed border-bambu-dark-tertiary px-2.5 py-1.5 text-xs'}`}>
        {waiting
          ? <Loader2 data-testid="item-search-waiting" aria-hidden="true" className={`${inline ? 'h-5 w-5' : 'h-3.5 w-3.5'} animate-spin text-bambu-gray`} />
          : <Search aria-hidden="true" className={`${inline ? 'h-5 w-5' : 'h-3.5 w-3.5'} text-bambu-gray`} />}
        <input
          type="search"
          value={text}
          disabled={disabled}
          aria-label={placeholder}
          aria-busy={waiting}
          placeholder={placeholder}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && hits.length > 0) {
              e.preventDefault();
              setActive(a => (a + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length);
            } else if (e.key === 'Enter' && hits[0] && q === typed) {
              e.preventDefault();
              add(active > 0 ? hits[active] : exact(typed) ?? hits[0]);
            } else if (e.key === 'Enter' && typed.length >= 2) {
              e.preventDefault();
              setPending(typed);
              setQ(typed); // ask now rather than after the pause
            } else if (e.key === 'Escape' && text) {
              e.stopPropagation(); // the first Escape clears the field, the next one closes the edit
              setText('');
            }
          }}
          className={`w-full bg-transparent text-white placeholder:text-bambu-gray focus:outline-none disabled:opacity-50 ${inline ? 'text-base' : 'text-sm'}`}
        />
      </div>
      {hits.length > 0 ? (
        <ul className={`${pop} overflow-hidden rounded-md border border-bambu-dark-tertiary bg-bambu-dark-secondary`}>
          {hits.map((h, i) => {
            const sellable = available(h);
            return (
              <li key={h.id}>
                <button
                  type="button"
                  data-active={i === active}
                  onClick={() => add(h)}
                  onMouseEnter={() => setActive(i)}
                  className={`flex w-full items-center gap-3 px-3 text-left text-sm data-[active=true]:bg-bambu-dark-tertiary/60 ${inline ? 'min-h-12 py-2' : 'py-1.5'}`}
                >
                  <ItemSwatch item={h} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-white">
                      {markWords(h.name, q).map((p, k) => (p.hit ? <b key={k} className="font-semibold text-bambu-green">{p.text}</b> : p.text))}
                    </span>
                    <span className="flex gap-2 font-mono text-xs text-bambu-gray">
                      {h.sku && <span>{h.sku}</span>}
                      {matchedCode(h, q) && <span data-testid="matched-code" className="text-bambu-green">{matchedCode(h, q)}</span>}
                    </span>
                  </span>
                  {sellable !== null && (
                    <span className={`text-xs tabular-nums ${sellable > 0 ? TONE.success.text : TONE.warning.text}`}>
                      {t('orders.edit.availableN', { n: formatQty(sellable) })}
                    </span>
                  )}
                  <span className="text-xs tabular-nums text-bambu-gray">{formatMoney(h.rate, currency)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : asking && data && !waiting ? (
        <div className={`${pop} rounded-md border border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 py-1.5 text-xs text-bambu-gray`}>
          {t('orders.edit.noItem')}
        </div>
      ) : asking && error ? (
        <div role="alert" className={`${pop} rounded-md border border-bambu-dark-tertiary bg-bambu-dark-secondary px-3 py-1.5 text-xs ${TONE.danger.text}`}>
          {errorReason(t, error)}
        </div>
      ) : null}
    </div>
  );
}
