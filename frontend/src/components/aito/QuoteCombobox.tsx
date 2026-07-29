import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api } from '../../api/client';
import type { ZohoEstimateSummary } from '../../api/client';
import { Money } from '../calculator/shared';
import { inputCls, labelCls } from '../formStyles';

export interface QuoteComboboxProps {
  selected: ZohoEstimateSummary | null;
  onSelect: (quote: ZohoEstimateSummary) => void;
}

const DEBOUNCE_MS = 300;

/** Search over the Zoho Books quote list.
 *
 *  Unlike the client picker, this opens on the most recent quotes with an
 *  empty query: the common case is importing a quote written minutes ago, and
 *  making the user recall its number first would be busywork. */
export function QuoteCombobox({ selected, onSelect }: QuoteComboboxProps) {
  const { t, i18n } = useTranslation();
  const [rawQuery, setRawQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  // Debounce keystrokes — one request per pause, not per character.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(rawQuery.trim()), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [rawQuery]);

  useEffect(() => setHighlightedIndex(-1), [debouncedQuery]);

  const quotesQuery = useQuery({
    queryKey: ['zoho-estimates', debouncedQuery],
    queryFn: () => api.searchZohoEstimates(debouncedQuery),
    enabled: editing,
  });

  const results = quotesQuery.data ?? [];
  const label = selected ? `${selected.number} · ${selected.customer_name}` : '';
  // The debounce timer hasn't caught up to the latest keystroke yet: the
  // fetched results still belong to the previous, wider query. Treat this the
  // same as an in-flight fetch so a narrowing search doesn't flash entries
  // it's about to exclude.
  const pending = rawQuery.trim() !== debouncedQuery;
  const loading = quotesQuery.isFetching || pending;

  const stopEditing = () => {
    setEditing(false);
    setRawQuery('');
    setDebouncedQuery('');
  };

  const pick = (quote: ZohoEstimateSummary) => {
    onSelect(quote);
    stopEditing();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!editing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (results.length) setHighlightedIndex((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length) setHighlightedIndex((i) => (i <= 0 ? results.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      if (highlightedIndex >= 0 && results[highlightedIndex]) {
        e.preventDefault();
        pick(results[highlightedIndex]);
      }
    } else if (e.key === 'Escape') {
      // Close the dropdown only — the modal's own Escape handler would
      // otherwise close the whole modal.
      e.stopPropagation();
      stopEditing();
    }
  };

  return (
    <div>
      <label htmlFor="aito-quote-search" className={labelCls}>
        {t('aito.quoteSearchLabel')}
      </label>
      <div className="relative">
        <input
          id="aito-quote-search"
          role="combobox"
          type="text"
          autoComplete="new-password"
          aria-expanded={editing}
          aria-autocomplete="list"
          value={editing ? rawQuery : label}
          onFocus={(e) => {
            setEditing(true);
            setRawQuery('');
            e.target.select();
          }}
          onChange={(e) => setRawQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          // The listbox's onMouseDown calls preventDefault, so clicking an
          // option never blurs the input in the first place.
          onBlur={stopEditing}
          placeholder={t('aito.quotePlaceholder')}
          className={inputCls}
        />
        {editing && (
          <div
            role="listbox"
            onMouseDown={(e) => e.preventDefault()}
            className="absolute z-50 left-0 right-0 mt-1 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-lg max-h-72 overflow-y-auto animate-slide-up"
          >
            {!debouncedQuery && !pending && !quotesQuery.isError && (
              <p className="px-3 pt-2 text-xs uppercase tracking-wide text-bambu-gray">
                {t('aito.quoteRecent')}
              </p>
            )}
            {loading && (
              <div className="flex items-center gap-2 px-3 py-2 text-sm text-bambu-gray">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('aito.searching')}
              </div>
            )}
            {!loading && quotesQuery.isError && (
              <div className="px-3 py-2 text-sm text-status-error">{t('aito.zohoUnreachable')}</div>
            )}
            {!loading && !quotesQuery.isError && results.length === 0 && (
              <div className="px-3 py-2 text-sm text-bambu-gray">{t('aito.quoteNoResults')}</div>
            )}
            {!loading &&
              !quotesQuery.isError &&
              results.map((quote, index) => (
                <button
                  key={quote.id}
                  type="button"
                  role="option"
                  aria-selected={index === highlightedIndex}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onClick={() => pick(quote)}
                  className={`w-full px-3 py-2 text-left transition-colors ${
                    index === highlightedIndex ? 'bg-bambu-dark-tertiary' : 'hover:bg-bambu-dark-tertiary'
                  }`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-sm text-white truncate">{quote.number}</span>
                    <Money
                      currency={quote.currency_code || 'USD'}
                      value={quote.total}
                      className="text-xs text-bambu-gray flex-shrink-0"
                    />
                  </span>
                  <span className="block text-xs text-bambu-gray truncate">
                    {[
                      quote.customer_name,
                      quote.date ? new Date(quote.date + 'T00:00:00').toLocaleDateString(i18n.language) : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
