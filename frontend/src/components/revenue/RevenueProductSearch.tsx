import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { focusRingCls } from '../formStyles';
import { PICK_CLS, RevenuePopover } from './RevenueControls';
import { formatFcp } from './lib/format';
import { MAX_SHOWN_MATCHES, brandOptions, filterByBrands, pickedBrandChips, searchProducts } from './lib/products';
import type { RevenueProduct } from './lib/types';

const LINK = `text-xs text-bambu-green hover:underline ${focusRingCls}`;

/** One active filter as a removable chip (the mockup's « Marque : X ✕ »). */
export function RevenueChip(p: { label?: string; value: string; removeLabel: string; onRemove: () => void; title?: string }) {
  return (
    <span className="inline-flex max-w-xs items-center gap-1.5 rounded-full bg-bambu-dark-tertiary py-1 pl-3 pr-1 text-xs text-bambu-gray-light">
      {p.label && <span className="text-bambu-gray">{p.label}</span>}
      <span className="truncate text-white" title={p.title}>{p.value}</span>
      <button type="button" aria-label={p.removeLabel} onClick={p.onRemove}
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full hover:bg-bambu-dark-secondary hover:text-white ${focusRingCls}`}>
        <X aria-hidden className="h-3 w-3" />
      </button>
    </span>
  );
}

/**
 * The brand filter and the product search, with the chips of both. The brand options come from the
 * products list; while brands are picked the search only matches their products. Matching is done
 * in the browser over name + SKU; nothing here talks to the server.
 */
export function RevenueProductSearch(p: {
  products: RevenueProduct[] | null;
  basket: RevenueProduct[];
  onAdd: (products: RevenueProduct[]) => void;
  onRemove: (itemId: string) => void;
  onClear: () => void;
  /** The picked brands as `brandKey`s. */
  brands: ReadonlySet<string>;
  onToggleBrand: (key: string) => void;
  onClearBrands: () => void;
  /** Chips of the other active filters (kind, segment), shown first; null when none. */
  extraChips?: ReactNode;
  onClearExtra?: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const options = useMemo(() => brandOptions(p.products ?? []), [p.products]);
  const picked = pickedBrandChips(p.brands, options);
  const inBasket = useMemo(() => new Set(p.basket.map((b) => b.itemId)), [p.basket]);
  const inBrands = useMemo(() => filterByBrands(p.products, p.brands), [p.products, p.brands]);
  const { matches, shown } = useMemo(() => searchProducts(inBrands, query, inBasket), [query, inBrands, inBasket]);
  const brandLabel =
    picked.length === 0 ? t('revenue.filters.brand') : picked.length === 1 ? t('revenue.filters.brandOne', { brand: picked[0].brand }) : t('revenue.filters.brandMany', { n: picked.length });

  const add = (products: RevenueProduct[]) => {
    if (products.length === 0) return;
    p.onAdd(products);
    setQuery('');
    setOpen(false);
  };

  return (
    <>
      <RevenuePopover label={t('revenue.filters.brands')} trigger={brandLabel} haspopup="listbox" pressed={picked.length > 0} disabled={!p.products} className="w-72 p-0!">
        {() => (
          <>
            <div className="flex items-center justify-between border-b border-bambu-dark-tertiary px-3 py-1.5 text-xs text-bambu-gray">
              <span>{t('revenue.filters.brandCount', { count: options.length })}</span>
              {picked.length > 0 && (
                <button type="button" className={LINK} onClick={p.onClearBrands}>{t('revenue.filters.clearAll')}</button>
              )}
            </div>
            <ul role="listbox" aria-label={t('revenue.filters.brands')} aria-multiselectable className="max-h-72 overflow-y-auto py-1">
              {options.map((o) => {
                const on = p.brands.has(o.key);
                return (
                  <li key={o.key} role="option" aria-selected={on}>
                    <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-bambu-dark-tertiary">
                      <input type="checkbox" className="shrink-0 accent-bambu-green" checked={on} onChange={() => p.onToggleBrand(o.key)} />
                      <span className="min-w-0 flex-1 truncate text-white" title={o.brand}>
                        {o.brand}
                        <span className="ml-2 text-xs text-bambu-gray">{o.count}</span>
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-bambu-gray">{formatFcp(o.totalHt)}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </RevenuePopover>

      <div className="relative min-w-[220px] flex-1">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-bambu-gray" />
        <input
          type="search"
          aria-label={t('revenue.search.label')}
          placeholder={
            !p.products
              ? t('revenue.search.loading')
              : picked.length > 0
                ? t('revenue.search.placeholderBrands', { brands: picked.map((o) => o.brand).join(' / ') })
                : t('revenue.search.placeholder')
          }
          className={`${PICK_CLS} w-full pl-8 text-white placeholder:text-bambu-gray`}
          value={query}
          disabled={!p.products}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && shown[0]) {
              e.preventDefault();
              add([shown[0]]);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
        />
        {open && query.trim().length >= 2 && (
          // mousedown is swallowed so a click on a row does not blur the input before it fires.
          <div
            role="listbox"
            aria-label={t('revenue.search.matches')}
            onMouseDown={(e) => e.preventDefault()}
            className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-xl"
          >
            {matches.length === 0 ? (
              <p className="px-3 py-2 text-xs text-bambu-gray">{picked.length > 0 ? t('revenue.search.noneBrands') : t('revenue.search.none')}</p>
            ) : (
              <>
                <div className="flex items-center justify-between border-b border-bambu-dark-tertiary px-3 py-1.5 text-xs text-bambu-gray">
                  <span>
                    {t('revenue.search.results', { count: matches.length })}
                    {matches.length > MAX_SHOWN_MATCHES ? ` · ${t('revenue.search.shown', { n: MAX_SHOWN_MATCHES })}` : ''}
                  </span>
                  {matches.length > 1 && (
                    <button type="button" className={LINK} onClick={() => add(matches)}>{t('revenue.search.addAll', { n: matches.length })}</button>
                  )}
                </div>
                <ul className="max-h-72 overflow-y-auto">
                  {shown.map((x) => (
                    <li key={x.itemId} role="option" aria-selected={false} className="flex items-center gap-3 px-3 py-1.5 text-sm hover:bg-bambu-dark-tertiary">
                      <span className="min-w-0 flex-1 truncate text-white" title={x.name}>
                        {x.name}
                        {x.sku ? <span className="ml-2 font-mono text-xs text-bambu-gray">{x.sku}</span> : null}
                        {x.brand && p.brands.size === 0 ? <span className="ml-2 text-xs text-bambu-gray">{x.brand}</span> : null}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-bambu-gray">{formatFcp(x.totalHt)}</span>
                      <button type="button" className={`${LINK} shrink-0`} onClick={() => add([x])}>{t('revenue.search.add')}</button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      {(picked.length > 0 || p.basket.length > 0 || p.extraChips) && (
        <div role="group" aria-label={t('revenue.filters.selection')} className="flex flex-wrap items-center gap-2">
          {p.extraChips}
          {picked.map((o) => (
            <RevenueChip key={o.key} label={t('revenue.filters.brand')} value={o.brand}
              removeLabel={t('revenue.filters.removeBrand', { brand: o.brand })} onRemove={() => p.onToggleBrand(o.key)} />
          ))}
          {p.basket.length > 0 && <span className="text-xs text-bambu-gray">{t('revenue.search.products', { count: p.basket.length })}</span>}
          {p.basket.map((b) => (
            <RevenueChip key={b.itemId} value={b.name} title={b.name}
              removeLabel={t('revenue.search.remove', { name: b.name })} onRemove={() => p.onRemove(b.itemId)} />
          ))}
          <button
            type="button"
            className={`text-xs text-bambu-gray-light underline underline-offset-2 hover:text-white ${focusRingCls}`}
            onClick={() => {
              p.onClear();
              p.onClearBrands();
              p.onClearExtra?.();
            }}
          >
            {t('revenue.filters.clearAll')}
          </button>
        </div>
      )}
    </>
  );
}
