import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Plus, RotateCcw } from 'lucide-react';
import { api } from '../../api/client';
import type { ZohoContact } from '../../api/client';
import { focusRingCls, inputCls, labelCls } from '../formStyles';

export interface ClientComboboxProps {
  clientName: string;
  onSelect: (contact: ZohoContact) => void;
  onCreateNew: () => void;
  onReset: () => void;
  showReset: boolean;
}

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

/** Editable combobox over the Zoho Books contact directory. The input always
 *  shows the currently attached client; typing turns it into a search query and
 *  blurring without a pick puts the name back. A client is always attached (the
 *  default walk-in contact if nothing else), so there is no "empty" state and no
 *  chip to clear — the reset control returns to the default instead. */
export function ClientCombobox({ clientName, onSelect, onCreateNew, onReset, showReset }: ClientComboboxProps) {
  const { t } = useTranslation();
  const [rawQuery, setRawQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  // Debounce keystrokes — one request per pause, not per character.
  useEffect(() => {
    const trimmed = rawQuery.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setDebouncedQuery('');
      return;
    }
    const id = setTimeout(() => setDebouncedQuery(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [rawQuery]);

  useEffect(() => setHighlightedIndex(-1), [debouncedQuery]);

  const contactsQuery = useQuery({
    queryKey: ['zoho-contacts', debouncedQuery],
    queryFn: () => api.searchZohoContacts(debouncedQuery),
    enabled: editing && debouncedQuery.length >= MIN_QUERY_LENGTH,
  });

  const results = contactsQuery.data ?? [];
  const open = editing && rawQuery.trim().length >= MIN_QUERY_LENGTH;

  const stopEditing = () => {
    setEditing(false);
    setRawQuery('');
    setDebouncedQuery('');
  };

  const pick = (contact: ZohoContact) => {
    onSelect(contact);
    stopEditing();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
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
      <label htmlFor="aito-client-search" className={labelCls}>
        {t('aito.client')}
      </label>
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <input
            id="aito-client-search"
            role="combobox"
            type="text"
            autoComplete="new-password"
            aria-expanded={open}
            aria-autocomplete="list"
            value={editing ? rawQuery : clientName}
            onFocus={(e) => {
              setEditing(true);
              setRawQuery(clientName);
              e.target.select();
            }}
            onChange={(e) => setRawQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            // The listbox's onMouseDown already calls preventDefault, so
            // clicking an option never blurs the input in the first place —
            // no need to defer the revert here.
            onBlur={stopEditing}
            placeholder={t('aito.clientPlaceholder')}
            className={inputCls}
          />
          {open && (
            <div
              role="listbox"
              onMouseDown={(e) => e.preventDefault()}
              className="absolute z-50 left-0 right-0 mt-1 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-lg max-h-64 overflow-y-auto animate-slide-up scrollbar-hide"
            >
              {contactsQuery.isFetching && (
                <div className="flex items-center gap-2 px-3 py-2 text-sm text-bambu-gray">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('aito.searching')}
                </div>
              )}
              {!contactsQuery.isFetching && contactsQuery.isError && (
                <div className="px-3 py-2 text-sm text-status-error">{t('aito.zohoUnreachable')}</div>
              )}
              {!contactsQuery.isFetching && !contactsQuery.isError && results.length === 0 && (
                <div className="px-3 py-2 text-sm text-bambu-gray">{t('aito.noResults')}</div>
              )}
              {!contactsQuery.isFetching &&
                !contactsQuery.isError &&
                results.map((contact, index) => (
                  <button
                    key={contact.id}
                    type="button"
                    role="option"
                    aria-selected={index === highlightedIndex}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => pick(contact)}
                    className={`w-full px-3 py-2 text-left transition-colors ${
                      index === highlightedIndex ? 'bg-bambu-dark-tertiary' : 'hover:bg-bambu-dark-tertiary'
                    }`}
                  >
                    <p className="text-sm text-white truncate">{contact.name}</p>
                    {(contact.company_name || contact.phone || contact.mobile) && (
                      <p className="text-xs text-bambu-gray truncate">
                        {[contact.company_name, contact.mobile || contact.phone].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </button>
                ))}
              <button
                type="button"
                onClick={() => {
                  onCreateNew();
                  stopEditing();
                }}
                className={`w-full px-3 py-2 text-left text-sm text-bambu-green border-t border-bambu-dark-tertiary hover:bg-bambu-dark-tertiary transition-colors flex items-center gap-2 ${focusRingCls}`}
              >
                <Plus className="w-4 h-4" />
                {t('aito.createClient')}
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label={t('aito.resetToDefaultClient')}
          title={t('aito.resetToDefaultClient')}
          onClick={onReset}
          // Space is reserved at all times so revealing the control never
          // shifts the row.
          className={`p-2 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-opacity ${focusRingCls} ${
            showReset ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
