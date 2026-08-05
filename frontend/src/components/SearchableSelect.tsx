import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';

export interface SearchableSelectOption {
  value: string;
  label: string;
  /** What the closed control shows when this option is selected, when that
   *  wants to be shorter than the row in the list — a dialling code picker
   *  shows `+689` in a narrow field but still lists `+689 French Polynesia`
   *  so the country is readable and searchable. Defaults to `label`. */
  shortLabel?: string;
}

interface SearchableSelectProps {
  value: string;
  onChange: (next: string) => void;
  options: SearchableSelectOption[];
  /** When true the user can also type a value not present in the option list. */
  allowCustom: boolean;
  placeholderKey?: string;
  disabled?: boolean;
  /** id for the inner text input so an external <label htmlFor> can target it. */
  id?: string;
  /** 'trigger' (default) matches the menu to the control's width. 'auto' lets
   *  it size to its rows instead, never narrower than the control — for a
   *  control deliberately too narrow for its own options (see `shortLabel`). */
  menuWidth?: 'trigger' | 'auto';
}

/** Lightweight searchable dropdown — text input + chevron + filtered list of
 *  buttons, click-outside/Escape closes. Keyboard: ArrowUp/ArrowDown move the
 *  highlight (wraps, first match auto-highlighted while typing), Enter selects
 *  it. Native `<select>` is intentionally avoided per the project's UI
 *  conventions. Extracted from BulkEditSpoolsModal so long option lists
 *  (spool fields, calculator filaments) share one implementation. */
export function SearchableSelect({
  value,
  onChange,
  options,
  allowCustom,
  placeholderKey,
  disabled,
  id,
  menuWidth = 'trigger',
}: SearchableSelectProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const reactId = useId();
  const baseId = id ?? reactId;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlight, setHighlight] = useState(-1);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
        setHighlight(-1);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // This listener is only attached while `open` is true (see the guard
        // above), so stopping propagation here can never swallow Escape for a
        // consumer with a closed dropdown. Without this, a window-level Escape
        // handler in a parent modal fires on the same event — document
        // listeners run before window listeners in the bubble phase — closing
        // the modal underneath an open dropdown and discarding whatever the
        // user had typed into it.
        e.stopPropagation();
        setOpen(false);
        setSearch('');
        setHighlight(-1);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  // The closed control shows `shortLabel` when the option defines one; the
  // list rows below always show the full `label`, and the filter matches
  // against it, so shortening the control never costs a searchable word.
  const selected = options.find((o) => o.value === value);
  const selectedLabel = selected ? (selected.shortLabel ?? selected.label) : value;
  const displayValue = open ? search : selectedLabel;
  // While the dropdown is open and nothing has been typed, keep the current
  // selection visible as a bright placeholder instead of blanking the field.
  const showSelectionPlaceholder = open && !search && !!selectedLabel;

  const filteredOptions = useMemo(() => {
    if (!open) return options;
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q));
  }, [open, search, options]);

  const noOptionMatch = open && search.trim() && !options.some((o) => o.value.toLowerCase() === search.trim().toLowerCase());
  const showCustom = Boolean(allowCustom && noOptionMatch);
  // Keyboard-navigable rows: the filtered options plus the "use custom" row.
  const itemCount = filteredOptions.length + (showCustom ? 1 : 0);

  // Keep the highlighted row visible while arrowing through a long list.
  // (Optional call: jsdom has no scrollIntoView.)
  useEffect(() => {
    if (highlight < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [highlight]);

  const close = () => {
    setOpen(false);
    setSearch('');
    setHighlight(-1);
  };

  const selectIndex = (index: number) => {
    if (index < 0 || index >= itemCount) return;
    onChange(index < filteredOptions.length ? filteredOptions[index].value : search.trim());
    close();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (itemCount > 0) setHighlight((h) => (h + 1) % itemCount);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (open && itemCount > 0) setHighlight((h) => (h <= 0 ? itemCount - 1 : h - 1));
    } else if (e.key === 'Enter') {
      if (!open) return;
      // Swallow the Enter so it selects instead of submitting the parent form.
      e.preventDefault();
      if (itemCount > 0) selectIndex(highlight >= 0 ? highlight : 0);
      else close();
    } else if (e.key === 'Tab') {
      close();
    }
  };

  return (
    <div className="relative" ref={ref}>
      <input
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open ? `${baseId}-listbox` : undefined}
        aria-activedescendant={open && highlight >= 0 ? `${baseId}-opt-${highlight}` : undefined}
        disabled={disabled}
        value={displayValue}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
          // Typing pre-highlights the first match so Enter grabs it directly.
          setHighlight(0);
          if (allowCustom) onChange(e.target.value);
        }}
        onFocus={() => {
          setOpen(true);
          setSearch('');
          setHighlight(-1);
        }}
        onKeyDown={handleKeyDown}
        placeholder={showSelectionPlaceholder ? selectedLabel : placeholderKey ? t(placeholderKey) : undefined}
        className={`w-full px-3 py-2 pr-9 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white ${
          showSelectionPlaceholder ? 'placeholder-bambu-gray-light' : 'placeholder-bambu-gray/50'
        } focus:border-bambu-green focus:outline-none`}
      />
      <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-bambu-gray/50 pointer-events-none" />
      {open && (
        <div
          ref={listRef}
          role="listbox"
          id={`${baseId}-listbox`}
          className={`absolute z-50 left-0 mt-1 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-lg max-h-64 overflow-y-auto animate-dropdown-in ${
            menuWidth === 'auto' ? 'w-max min-w-full max-w-[16rem]' : 'right-0'
          }`}
        >
          {filteredOptions.length === 0 && !allowCustom && (
            <div className="px-3 py-2 text-sm text-bambu-gray">{t('inventory.noResults')}</div>
          )}
          {filteredOptions.map((opt, index) => (
            <button
              key={opt.value}
              id={`${baseId}-opt-${index}`}
              data-index={index}
              type="button"
              role="option"
              aria-selected={value === opt.value}
              className={`w-full px-3 py-2 text-left text-sm hover:bg-bambu-dark-tertiary ${
                index === highlight ? 'bg-bambu-dark-tertiary' : ''
              } ${value === opt.value ? 'bg-bambu-green/10 text-bambu-green' : 'text-white'}`}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => selectIndex(index)}
            >
              {opt.label}
            </button>
          ))}
          {showCustom && (
            <button
              type="button"
              id={`${baseId}-opt-${filteredOptions.length}`}
              data-index={filteredOptions.length}
              role="option"
              aria-selected={false}
              className={`w-full px-3 py-2 text-left text-sm hover:bg-bambu-dark-tertiary text-bambu-green border-t border-bambu-dark-tertiary ${
                highlight === filteredOptions.length ? 'bg-bambu-dark-tertiary' : ''
              }`}
              onMouseEnter={() => setHighlight(filteredOptions.length)}
              onClick={() => selectIndex(filteredOptions.length)}
            >
              {t('inventory.bulk.useCustom', { value: search.trim() })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
