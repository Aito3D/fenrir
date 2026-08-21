// Search field for linking a calculator filament to a Zoho product.
//
// Results are listed per Zoho item, colour included: dealer prices differ
// between colours of the same material (Bambu ABS-GF is 1866 in Blue and 3208
// in Black), so the colour the user picks decides the price even though colour
// itself is not stored on the filament.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Search } from 'lucide-react';
import { api, type ZohoFilamentProduct } from '../../api/client';
import { inputCls, labelCls } from '../formStyles';
import { formatMoney } from '../../utils/pricing';

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

export function ZohoFilamentSearch({
  onSelect,
  currency,
  disabled = false,
}: {
  onSelect: (product: ZohoFilamentProduct) => void;
  /** ISO currency code (e.g. "USD", "XPF") — passed straight through to
   * `formatMoney`, which keys its zero-decimal-currency detection off the
   * code, not a display symbol. Passing a symbol here would silently print
   * spurious decimals for zero-decimal currencies like XPF/JPY/KRW. */
  currency: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const enabled = !disabled && debounced.length >= MIN_QUERY_LENGTH;
  const { data: results = [], isFetching, isError } = useQuery({
    queryKey: ['zoho-filaments', debounced],
    queryFn: () => api.searchZohoFilaments(debounced),
    enabled,
    staleTime: 60_000,
    retry: false,
  });

  return (
    <div>
      <label htmlFor="calc-fil-zoho" className={labelCls}>
        {t('calculator.zohoProductSearch')}
      </label>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-bambu-gray" aria-hidden="true" />
        <input
          id="calc-fil-zoho"
          role="combobox"
          aria-expanded={enabled}
          aria-controls="calc-fil-zoho-results"
          autoComplete="off"
          className={`${inputCls} pl-9`}
          placeholder={t('calculator.zohoProductSearchPlaceholder')}
          value={query}
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
        />
        {isFetching && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-bambu-gray" />
        )}
      </div>

      {enabled && (
        <ul
          id="calc-fil-zoho-results"
          className="mt-1 max-h-64 overflow-y-auto rounded-lg border border-bambu-dark-tertiary bg-bambu-dark divide-y divide-bambu-dark-tertiary"
        >
          {isError && <li className="px-3 py-2 text-sm text-status-error">{t('calculator.zohoSearchError')}</li>}
          {!isError && !isFetching && results.length === 0 && (
            <li className="px-3 py-2 text-sm text-bambu-gray">{t('calculator.zohoNoResults')}</li>
          )}
          {results.map((product) => (
            <li key={product.item_id}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left hover:bg-bambu-dark-tertiary transition-colors"
                onClick={() => onSelect(product)}
              >
                <span className="block text-sm text-white">
                  {product.brand} · {product.material}
                  {product.colour ? ` · ${product.colour}` : ''}
                </span>
                <span className="block text-xs text-bambu-gray tabular-nums">
                  {product.has_price ? (
                    <>
                      {formatMoney(product.cost_per_kg, currency, false)} / kg · {product.spool_weight_kg} kg
                    </>
                  ) : (
                    <span className="text-status-warning">{t('calculator.zohoNoDealerPrice')}</span>
                  )}
                  {product.sku ? ` · ${product.sku}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
