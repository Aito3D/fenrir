import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AitoShippingService } from '../../api/client';
import { islandLabel } from '../../utils/shippingDraft';
import { inputCls, inputErrorCls, labelCls } from '../formStyles';

export interface IslandComboboxProps {
  /** The island KEY, '' when nothing is chosen. */
  value: string;
  services: AitoShippingService[];
  onSelect: (islandKey: string) => void;
  invalid?: boolean;
  onBlur?: () => void;
  id?: string;
}

/** Searchable island picker, grouped by air-freight service.
 *
 *  Local, not networked: the whole table arrives in one cached request, so
 *  there is nothing to debounce and no loading state to render. Filtering is
 *  accent-insensitive because half these names carry one and nobody types it.
 *
 *  The value is the island KEY throughout; the label is only ever presentation.
 *  That is what lets a label be respelled without orphaning a stored project. */
export function IslandCombobox({ value, services, onSelect, invalid, onBlur, id }: IslandComboboxProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);

  const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // Shared with the panel's read view, the header pill and the create
  // drawer (see `islandLabel`'s doc): a services query that has not resolved
  // yet must not blank a REQUIRED field while `value` is set — this surface
  // used to fall back to '', which in the panel's edit mode rendered empty
  // with no error shown even though an island IS chosen. `islandLabel`'s
  // segment-capitalised degrade keeps something readable on screen instead.
  const selectedLabel = useMemo(() => islandLabel(value, services), [services, value]);

  const groups = useMemo(() => {
    const needle = fold(query.trim());
    return services
      .map((service) => ({
        service,
        islands: needle ? service.islands.filter((i) => fold(i.label).includes(needle)) : service.islands,
      }))
      .filter((group) => group.islands.length > 0);
  }, [services, query]);

  // Flat order, so ArrowUp/ArrowDown walk the whole list rather than stopping
  // at a group boundary the user cannot see the edges of.
  const flat = useMemo(() => groups.flatMap((group) => group.islands), [groups]);

  const stopEditing = () => {
    setEditing(false);
    setQuery('');
    setHighlighted(-1);
    onBlur?.();
  };

  const pick = (islandKey: string) => {
    onSelect(islandKey);
    setEditing(false);
    setQuery('');
    setHighlighted(-1);
  };

  const inputId = id ?? 'aito-shipping-island';

  return (
    <div>
      <label htmlFor={inputId} className={labelCls}>
        {t('aito.shippingIsland')}
      </label>
      <div className="relative">
        <input
          id={inputId}
          role="combobox"
          type="text"
          autoComplete="new-password"
          aria-expanded={editing}
          aria-autocomplete="list"
          aria-invalid={invalid ? true : undefined}
          value={editing ? query : selectedLabel}
          onFocus={(e) => {
            setEditing(true);
            setQuery('');
            e.target.select();
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlighted(-1);
          }}
          onKeyDown={(e) => {
            if (!editing) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              if (flat.length) setHighlighted((i) => (i + 1) % flat.length);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              if (flat.length) setHighlighted((i) => (i <= 0 ? flat.length - 1 : i - 1));
            } else if (e.key === 'Enter' && highlighted >= 0 && flat[highlighted]) {
              e.preventDefault();
              pick(flat[highlighted].key);
            } else if (e.key === 'Escape') {
              // The drawer and the panel both close on Escape; this one is
              // only closing the dropdown.
              e.stopPropagation();
              stopEditing();
            }
          }}
          onBlur={stopEditing}
          placeholder={t('aito.shippingIslandPlaceholder')}
          className={invalid ? inputErrorCls : inputCls}
        />
        {editing && (
          <div
            role="listbox"
            onMouseDown={(e) => e.preventDefault()}
            className="absolute z-50 left-0 right-0 mt-1 max-h-64 overflow-y-auto rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary shadow-lg animate-slide-up scrollbar-hide"
          >
            {flat.length === 0 && (
              <div className="px-3 py-2 text-sm text-bambu-gray">{t('aito.shippingNoIslands')}</div>
            )}
            {groups.map((group) => (
              <div key={group.service.key}>
                <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-sky-400/80">
                  {group.service.name}
                </div>
                {group.islands.map((island) => {
                  const index = flat.indexOf(island);
                  return (
                    <button
                      key={island.key}
                      type="button"
                      role="option"
                      aria-selected={index === highlighted}
                      onMouseEnter={() => setHighlighted(index)}
                      onClick={() => pick(island.key)}
                      className={`w-full px-3 py-1.5 text-left text-sm text-white transition-colors ${
                        index === highlighted ? 'bg-bambu-dark-tertiary' : 'hover:bg-bambu-dark-tertiary'
                      }`}
                    >
                      {island.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
