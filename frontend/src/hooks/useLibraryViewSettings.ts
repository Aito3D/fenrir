// The File Manager's remembered view: every toolbar filter, the sort, the
// internal/external top-level view and the selected folder, kept per browser
// so the page reopens the way it was left. One versioned blob rather than a
// key per field so a future shape change is a single migration; the two
// legacy sort keys are still written because they predate this hook and
// nothing else should have to learn the new key to read them.
import { useCallback, useEffect, useState } from 'react';

export type LibrarySortField = 'name' | 'date' | 'size' | 'type' | 'prints';
export type LibrarySortDirection = 'asc' | 'desc';
export type LibraryTopLevelView = 'internal' | 'external';

export interface LibraryViewSettings {
  search: string;
  filterType: string;
  filterUsername: string;
  topLevelView: LibraryTopLevelView;
  selectedFolderId: number | null;
  sortField: LibrarySortField;
  sortDirection: LibrarySortDirection;
}

export const LIBRARY_VIEW_SETTINGS_KEY = 'library-view-settings';
const LEGACY_SORT_FIELD_KEY = 'library-sort-field';
const LEGACY_SORT_DIRECTION_KEY = 'library-sort-direction';
const VERSION = 1;

const SORT_FIELDS: readonly LibrarySortField[] = ['name', 'date', 'size', 'type', 'prints'];

export const DEFAULT_LIBRARY_VIEW_SETTINGS: LibraryViewSettings = {
  search: '',
  filterType: 'all',
  filterUsername: '',
  topLevelView: 'internal',
  selectedFolderId: null,
  sortField: 'name',
  sortDirection: 'asc',
};

function isSortField(value: unknown): value is LibrarySortField {
  return typeof value === 'string' && (SORT_FIELDS as readonly string[]).includes(value);
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota / private mode: the page still works, it just won't remember */
  }
}

/** Reads the saved settings, repairing each field independently so one bad
 * value (a hand-edited blob, an older build) never discards the rest. */
export function readLibraryViewSettings(): LibraryViewSettings {
  const raw = safeGet(LIBRARY_VIEW_SETTINGS_KEY);
  if (raw === null) {
    // First run with this hook: carry over the sort the old per-key code saved.
    const legacyField = safeGet(LEGACY_SORT_FIELD_KEY);
    const legacyDirection = safeGet(LEGACY_SORT_DIRECTION_KEY);
    return {
      ...DEFAULT_LIBRARY_VIEW_SETTINGS,
      sortField: isSortField(legacyField) ? legacyField : DEFAULT_LIBRARY_VIEW_SETTINGS.sortField,
      sortDirection: legacyDirection === 'desc' ? 'desc' : 'asc',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_LIBRARY_VIEW_SETTINGS };
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { v?: unknown }).v !== VERSION) {
    return { ...DEFAULT_LIBRARY_VIEW_SETTINGS };
  }
  const b = parsed as Record<string, unknown>;
  return {
    search: typeof b.search === 'string' ? b.search : DEFAULT_LIBRARY_VIEW_SETTINGS.search,
    filterType: typeof b.filterType === 'string' && b.filterType ? b.filterType : DEFAULT_LIBRARY_VIEW_SETTINGS.filterType,
    filterUsername: typeof b.filterUsername === 'string' ? b.filterUsername : DEFAULT_LIBRARY_VIEW_SETTINGS.filterUsername,
    topLevelView: b.topLevelView === 'external' ? 'external' : 'internal',
    selectedFolderId: typeof b.selectedFolderId === 'number' && Number.isInteger(b.selectedFolderId) ? b.selectedFolderId : null,
    sortField: isSortField(b.sortField) ? b.sortField : DEFAULT_LIBRARY_VIEW_SETTINGS.sortField,
    sortDirection: b.sortDirection === 'desc' ? 'desc' : 'asc',
  };
}

export function useLibraryViewSettings(): {
  settings: LibraryViewSettings;
  update: (patch: Partial<LibraryViewSettings>) => void;
} {
  const [settings, setSettings] = useState<LibraryViewSettings>(readLibraryViewSettings);

  useEffect(() => {
    safeSet(LIBRARY_VIEW_SETTINGS_KEY, JSON.stringify({ v: VERSION, ...settings }));
    safeSet(LEGACY_SORT_FIELD_KEY, settings.sortField);
    safeSet(LEGACY_SORT_DIRECTION_KEY, settings.sortDirection);
  }, [settings]);

  const update = useCallback((patch: Partial<LibraryViewSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  return { settings, update };
}
