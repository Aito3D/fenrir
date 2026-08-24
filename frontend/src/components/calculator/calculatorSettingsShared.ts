// Shared sort-state/parsing/CRUD-mutation helpers for the calculator settings
// panels (CalculatorFilamentsPanel, CalculatorPrintersPanel). Pulled out of
// the former single-file CalculatorSettingsPanels.tsx (T-078/T-079) so the
// toggleSort logic exists in one place instead of two byte-identical copies;
// useEntityCrudMutations (T-108) does the same for the save/delete
// useMutation pair, which the two panels had otherwise copy-pasted verbatim
// bar their query key, API calls and toast i18n keys.
//
// Non-JSX helpers live here (kept separate from ./CalculatorPanelParts.tsx
// so this file only ever exports non-components).

import { useState } from 'react';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../contexts/ToastContext';

/** Shared `<td>` class for the filament/printer profile tables (distinct
 * from the right-aligned/tabular-nums tdCls in ../shared.tsx). */
export const settingsTdCls = 'px-3 py-2 text-sm whitespace-nowrap';

export const parseNum = (s: string): number | null => {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export type SortDir = 'asc' | 'desc';

/** Sort-key/direction state plus the toggle-on-header-click behavior shared
 *  by the filaments and printers panels: clicking the already-active column
 *  flips direction, clicking a different one selects it ascending. */
export function useSortToggle<K extends string>(initialKey: K): { sortKey: K; sortDir: SortDir; toggleSort: (key: K) => void } {
  const [sortKey, setSortKey] = useState<K>(initialKey);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const toggleSort = (key: K) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  return { sortKey, sortDir, toggleSort };
}

/** The save (`create`-or-`update`, keyed off `editing`) and delete
 *  `useMutation` pair shared by CalculatorFilamentsPanel and
 *  CalculatorPrintersPanel (T-108). Both panels' blocks were structurally
 *  identical: same dispatch on `editing !== 'new'`, same
 *  invalidate-then-toast-then-clear-state order in `onSuccess`, same
 *  `showToast(error.message, 'error')` in `onError` — differing only in the
 *  query key, the three API calls, and the three toast i18n keys, all of
 *  which are parameters here.
 *
 *  `editing` is passed in (not returned by this hook) because both panels
 *  already own that piece of state themselves — it also drives which form
 *  is rendered — so mirroring it here would create a second source of
 *  truth. `onSaved`/`onDeleted` are the callers' own `setEditing(null)` /
 *  `setToDelete(null)`, invoked at exactly the same point in `onSuccess` as
 *  the pre-extraction inline code did. */
export function useEntityCrudMutations<TEntity extends { id: number }, TCreate>({
  queryKey,
  editing,
  create,
  update,
  remove,
  createdMsg,
  updatedMsg,
  deletedMsg,
  onSaved,
  onDeleted,
}: {
  queryKey: QueryKey;
  /** Same shape as each panel's own `editing` state: 'new' selects create,
   *  an entity selects update (by its id), null never matters here (the
   *  save button is unreachable without a form open). */
  editing: TEntity | 'new' | null;
  create: (data: TCreate) => Promise<TEntity>;
  update: (id: number, data: TCreate) => Promise<TEntity>;
  remove: (id: number) => Promise<unknown>;
  createdMsg: string;
  updatedMsg: string;
  deletedMsg: string;
  onSaved: () => void;
  onDeleted: () => void;
}): {
  saveMutation: ReturnType<typeof useMutation<TEntity, Error, TCreate>>;
  deleteMutation: ReturnType<typeof useMutation<unknown, Error, number>>;
} {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: (data: TCreate) => (editing && editing !== 'new' ? update(editing.id, data) : create(data)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      showToast(t(editing === 'new' ? createdMsg : updatedMsg));
      onSaved();
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      showToast(t(deletedMsg));
      onDeleted();
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  return { saveMutation, deleteMutation };
}
