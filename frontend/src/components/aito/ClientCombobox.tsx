import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Loader2, X } from 'lucide-react';
import { api } from '../../api/client';
import type { ZohoContact } from '../../api/client';
import { inputCls, labelCls } from '../formStyles';

export interface SelectedClient {
  id: string;
  name: string;
  phone: string | null;
}

interface ClientComboboxProps {
  value: SelectedClient | null;
  onChange: (client: SelectedClient | null) => void;
}

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

/** Required-client picker for the Aito "New project" modal. Debounced search
 *  against the Zoho Books contact directory (Task 7's `api.searchZohoContacts`),
 *  with a not-configured notice when Zoho integration isn't set up and a chip
 *  summary once a contact is chosen. Modeled on LdapUserPicker's debounce
 *  pattern and SearchableSelect's listbox/keyboard semantics. */
export function ClientCombobox({ value, onChange }: ClientComboboxProps) {
  const { t } = useTranslation();
  const [rawQuery, setRawQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [dropdownClosed, setDropdownClosed] = useState(false);

  const statusQuery = useQuery({
    queryKey: ['zoho-status'],
    queryFn: api.getZohoStatus,
    staleTime: 60_000,
  });

  // Debounce keystrokes — one request per pause, not per character. Typing
  // also un-suppresses a dropdown the user closed with Escape, so the next
  // search still shows results.
  useEffect(() => {
    setDropdownClosed(false);
    const trimmed = rawQuery.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setDebouncedQuery('');
      return;
    }
    const id = setTimeout(() => setDebouncedQuery(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [rawQuery]);

  useEffect(() => {
    setHighlightedIndex(-1);
  }, [debouncedQuery]);

  const contactsQuery = useQuery({
    queryKey: ['zoho-contacts', debouncedQuery],
    queryFn: () => api.searchZohoContacts(debouncedQuery),
    enabled: debouncedQuery.length >= MIN_QUERY_LENGTH && !value,
  });

  const dropdownOpen = !value && !dropdownClosed && debouncedQuery.length >= MIN_QUERY_LENGTH;
  const results = contactsQuery.data ?? [];

  const selectContact = (contact: ZohoContact) => {
    onChange({ id: contact.id, name: contact.name, phone: contact.mobile || contact.phone || null });
    setRawQuery('');
    setDebouncedQuery('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!dropdownOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (results.length > 0) setHighlightedIndex((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length > 0) setHighlightedIndex((i) => (i <= 0 ? results.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      if (highlightedIndex >= 0 && results[highlightedIndex]) {
        e.preventDefault();
        selectContact(results[highlightedIndex]);
      }
    } else if (e.key === 'Escape') {
      // Close only the dropdown — stop the native keydown from reaching the
      // modal's own Escape handler, which would otherwise close the whole
      // modal while the user just meant to dismiss the results list.
      e.stopPropagation();
      setDropdownClosed(true);
    }
  };

  if (statusQuery.data?.configured === false) {
    return (
      <div>
        <label className={labelCls}>{t('aito.client')}</label>
        <div className="p-3 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-sm text-bambu-gray">
          {t('aito.zohoNotConfigured')}{' '}
          <Link to="/settings?tab=zoho" className="text-bambu-green hover:underline">
            {t('aito.zohoConfigureLink')}
          </Link>
        </div>
      </div>
    );
  }

  if (value) {
    return (
      <div>
        <label className={labelCls}>{t('aito.client')}</label>
        <div className="flex items-center justify-between gap-3 px-3 py-2 bg-bambu-dark border border-bambu-green/40 rounded-lg">
          <div className="min-w-0">
            <p className="text-sm font-medium text-white truncate">{value.name}</p>
            {value.phone && <p className="text-xs text-bambu-gray truncate">{value.phone}</p>}
          </div>
          <button
            type="button"
            aria-label={t('aito.clearClient')}
            onClick={() => onChange(null)}
            className="p-1 -m-1 rounded-md text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green/40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <label htmlFor="aito-client-search" className={labelCls}>
        {t('aito.client')}
      </label>
      <input
        id="aito-client-search"
        type="text"
        autoComplete="off"
        aria-expanded={dropdownOpen}
        aria-autocomplete="list"
        value={rawQuery}
        onChange={(e) => setRawQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('aito.clientPlaceholder')}
        className={inputCls}
      />
      {dropdownOpen && (
        <div
          role="listbox"
          className="absolute z-50 left-0 right-0 mt-1 bg-bambu-dark-secondary border border-bambu-dark-tertiary rounded-lg shadow-lg max-h-64 overflow-y-auto animate-slide-up"
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
                onClick={() => selectContact(contact)}
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
        </div>
      )}
    </div>
  );
}
