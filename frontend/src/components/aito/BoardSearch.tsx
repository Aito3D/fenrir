import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** The board's search box. Presentational — the query lives in `AitoPage`,
 *  which is what filters with it, because both the board and the done grid
 *  read the same one. */
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

  return (
    <div className={`relative ${className}`}>
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-bambu-gray pointer-events-none" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
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
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
