import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api } from '../../api/client';
import type { ZohoEstimateSummary } from '../../api/client';
import { Money } from '../calculator/shared';
import { focusRingCls, inputCls, labelCls } from '../formStyles';

export interface QuoteResultListProps {
  selected: ZohoEstimateSummary | null;
  onSelect: (quote: ZohoEstimateSummary) => void;
  onClear: () => void;
}

const DEBOUNCE_MS = 250;

// Hover-intent style dwell: only a row the pointer or the keyboard cursor
// actually rests on gets its preview warmed. 200ms is squarely in the usual
// hover-intent range (150-250ms) — long enough that a pointer sweeping
// across a 20-row list, or a held ArrowDown, settles on nothing and fires no
// prefetch at all, short enough that a genuine pause still feels instant by
// the time the user reaches for Enter or a click.
const PREFETCH_DWELL_MS = 200;

/** Browse-first Zoho quote picker for the import drawer.
 *
 *  Replaces QuoteCombobox's popover with an always-visible list: the common
 *  case is importing a quote written minutes ago, so recents show before a
 *  single keystroke (the backend lists most-recent on an empty q). Selection
 *  collapses the list into a compact card with Change — the component stays
 *  mounted in both modes so the search text survives a round trip.
 *
 *  Already-imported quotes are BLOCKED, not just marked: a quote may back at
 *  most one active project (the backend 409s the create), so the row is
 *  aria-disabled and unselectable — the chip says which project holds it.
 *  Trashing a project frees its quote, and the board query below is
 *  active-only, so a trashed project's quote stays importable. The drawer's
 *  own checklist gate (`alreadyImported` in ImportQuoteDrawer) is the
 *  backstop for a stale board cache. */
export function QuoteResultList({ selected, onSelect, onClear }: QuoteResultListProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [rawQuery, setRawQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [highlighted, setHighlighted] = useState(-1);
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Clears any dwell timer left pending when the component goes away —
    // the leaked-timer-after-unmount class of bug this gate exists to avoid.
    return () => {
      if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(rawQuery.trim()), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [rawQuery]);

  useEffect(() => setHighlighted(-1), [debouncedQuery]);

  const quotesQuery = useQuery({
    queryKey: ['zoho-estimates', debouncedQuery],
    queryFn: () => api.searchZohoEstimates(debouncedQuery),
    // Previous results stay rendered while the next term loads, so typing
    // never blanks the list.
    placeholderData: keepPreviousData,
  });

  // Same key/staleTime QuoteCombobox used: rides AitoPage's board cache when
  // fresh, one extra GET otherwise. Active-only by construction — the
  // endpoint excludes trashed rows, which is the rule: trashing a project
  // frees its quote.
  const boardQuery = useQuery({
    queryKey: ['aito-projects'],
    queryFn: api.getAitoProjects,
    staleTime: 60_000,
  });
  const importedBy = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of boardQuery.data ?? []) if (p.quote_id) map.set(p.quote_id, p.id);
    return map;
  }, [boardQuery.data]);

  const results = quotesQuery.data ?? [];
  const pending = rawQuery.trim() !== debouncedQuery;
  const loading = (quotesQuery.isFetching || pending) && results.length === 0;

  const prefetch = (id: string) =>
    queryClient.prefetchQuery({
      queryKey: ['zoho-quote-preview', id],
      queryFn: () => api.getZohoQuotePreview(id),
      staleTime: 30_000,
    });

  const highlight = (index: number) => {
    setHighlighted(index);
    if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current);
    const quote = results[index];
    if (quote) {
      prefetchTimerRef.current = setTimeout(() => {
        prefetchTimerRef.current = null;
        prefetch(quote.id);
      }, PREFETCH_DWELL_MS);
    }
  };

  if (selected) {
    return (
      <div className="animate-rise flex items-center gap-3 rounded-[.6rem] border border-bambu-dark-tertiary bg-bambu-dark p-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">
            {selected.number} · {selected.customer_name}
          </p>
          <p className="text-xs text-bambu-gray">
            {[selected.date ? new Date(selected.date + 'T00:00:00').toLocaleDateString(i18n.language) : '', selected.status]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <Money currency={selected.currency_code || 'USD'} value={selected.total} className="flex-shrink-0 text-sm text-white" />
        <button
          type="button"
          onClick={onClear}
          className={`flex-shrink-0 rounded-md border border-bambu-dark-tertiary px-2.5 py-1 text-xs text-bambu-gray transition-colors hover:border-bambu-green/40 hover:text-bambu-green ${focusRingCls}`}
        >
          {t('aito.changeQuote')}
        </button>
      </div>
    );
  }

  return (
    <div>
      <label htmlFor="aito-quote-search" className={labelCls}>
        {t('aito.quoteSearchLabel')}
      </label>
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray" />
        <input
          id="aito-quote-search"
          type="search"
          autoFocus
          autoComplete="off"
          value={rawQuery}
          onChange={(e) => setRawQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              if (results.length) highlight((highlighted + 1) % results.length);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              if (results.length) highlight(highlighted <= 0 ? results.length - 1 : highlighted - 1);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const quote = results[highlighted];
              // Same gate as the row's onClick: an imported quote cannot be
              // selected from the keyboard either.
              if (quote && !importedBy.has(quote.id)) onSelect(quote);
            }
          }}
          placeholder={t('aito.quotePlaceholder')}
          className={`${inputCls} pl-8`}
        />
      </div>

      {!debouncedQuery && !quotesQuery.isError && (
        <p className="mt-3 text-xs uppercase tracking-wide text-bambu-gray">{t('aito.quoteRecent')}</p>
      )}

      {/* The listbox role only wraps actual option rows — a screen reader's
          listbox navigation should never land on a skeleton, an error line,
          or "no results". Those states render as siblings instead, and the
          skeleton trio collapses under one status wrapper rather than three,
          so it announces once, not three times over. */}
      {loading && (
        <div role="status" aria-label={t('common.loading')} className="mt-2 space-y-1.5">
          {[0, 1, 2].map((n) => (
            <div key={n} className="animate-pulse rounded-[.6rem] border border-bambu-dark-tertiary bg-bambu-dark p-3">
              <div className="h-3.5 w-40 rounded bg-bambu-dark-tertiary" />
              <div className="mt-2 h-3 w-56 rounded bg-bambu-dark-tertiary/60" />
            </div>
          ))}
        </div>
      )}
      {!loading && quotesQuery.isError && <p className="mt-2 p-3 text-sm text-status-error">{t('aito.zohoUnreachable')}</p>}
      {!loading && !quotesQuery.isError && results.length === 0 && (
        <p className="mt-2 p-3 text-sm text-bambu-gray">{t('aito.quoteNoResults')}</p>
      )}
      {!loading && !quotesQuery.isError && results.length > 0 && (
        <div role="listbox" aria-label={t('aito.quoteSearchLabel')} className="mt-2 space-y-1.5">
          {results.map((quote, index) => {
            const importedId = importedBy.get(quote.id);
            const blocked = importedId !== undefined;
            return (
              <button
                key={quote.id}
                type="button"
                role="option"
                aria-selected={index === highlighted}
                // aria-disabled rather than disabled: the row stays readable
                // and focusable so the chip explains WHY it cannot be picked,
                // instead of a dead row that swallows the click silently.
                aria-disabled={blocked}
                onMouseEnter={() => highlight(index)}
                onClick={() => {
                  if (!blocked) onSelect(quote);
                }}
                className={`w-full rounded-[.6rem] border p-3 text-left transition-colors motion-reduce:transition-none ${focusRingCls} ${
                  blocked
                    ? 'cursor-not-allowed border-bambu-dark-tertiary bg-bambu-dark opacity-60'
                    : index === highlighted
                      ? 'border-bambu-green/50 bg-bambu-dark-tertiary/60'
                      : 'border-bambu-dark-tertiary bg-bambu-dark hover:border-bambu-dark-tertiary hover:bg-bambu-dark-tertiary/40'
                }`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-white">{quote.number}</span>
                  <Money currency={quote.currency_code || 'USD'} value={quote.total} className="flex-shrink-0 text-xs text-bambu-gray-light" />
                </span>
                <span className="mt-0.5 flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-xs text-bambu-gray">
                    {[
                      quote.customer_name,
                      quote.date ? new Date(quote.date + 'T00:00:00').toLocaleDateString(i18n.language) : '',
                      quote.status,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {importedId !== undefined && (
                    <span className="flex-shrink-0 text-xs text-amber-400">{t('aito.quoteRowImported', { id: importedId })}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
