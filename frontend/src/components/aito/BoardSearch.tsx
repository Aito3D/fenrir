import { useId, type ChangeEvent } from 'react';
import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAitoSearch } from './search/AitoSearchContext';
import { SearchResults } from './search/SearchResults';
import { useSearchCombobox } from './search/useSearchCombobox';

/** The board's search box. The query lives in `AitoPage`, which filters the
 *  board with it. Under an `AitoSearchContext` it is also a combobox whose
 *  dropdown ranks matches across board, Done and Trash; without one it is
 *  the plain input it always was. */
export function BoardSearch({
  value,
  onChange,
  className = '',
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const search = useAitoSearch();
  const listboxId = useId();
  const pick = (index: number) => {
    const hit = search?.hits[index];
    if (hit) search?.onSelect(hit.project.id);
  };
  const combobox = useSearchCombobox({
    value,
    onChange,
    hitCount: search?.hits.length ?? 0,
    onSelectIndex: pick,
    listboxId,
  });
  const inputProps = search
    ? combobox.inputProps
    : { value, onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value) };

  return (
    <div className={`relative ${className}`}>
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-bambu-gray pointer-events-none" />
      <input
        type="search"
        data-aito-search-input=""
        {...inputProps}
        placeholder={t('aito.searchPlaceholder')}
        aria-label={t('aito.searchPlaceholder')}
        // The native clear affordance is suppressed in favour of the button
        // below: WebKit's renders as an unlabelled glyph no screen reader
        // announces, and it cannot be styled to match the rest of the toolbar.
        className="w-full pl-9 pr-9 py-2 rounded-lg bg-bambu-dark-secondary border border-bambu-dark-tertiary text-sm text-white placeholder:text-bambu-gray transition-colors focus:outline-none focus:border-bambu-green/50 [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={t('aito.clearSearch')}
          // Fades and settles in over 120ms on the first character (Tailwind's
          // `starting:` is @starting-style); leaving on the last is instant.
          // Anything slower would fight typing.
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-[color,background-color,opacity,scale] duration-[120ms] ease-(--ease-signature) starting:opacity-0 starting:scale-90 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
        >
          <X className="w-4 h-4" />
        </button>
      )}
      {search && combobox.open && (
        <SearchResults
          listboxId={listboxId}
          hits={search.hits}
          active={combobox.active}
          optionId={combobox.optionId}
          onPick={(index) => {
            pick(index);
            combobox.dismiss();
          }}
          onHover={combobox.setActive}
          trash={search.trash}
          // Right-aligned: the box sits at the toolbar's right edge, and a
          // 190px tablet box needs a wider list than itself.
          className="absolute right-0 top-full mt-1.5 z-40 w-full min-w-[min(26rem,calc(100vw-2rem))]"
        />
      )}
    </div>
  );
}
