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

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, type CalculatorDefaults } from '../../api/client';
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

  // `useMutation`'s options (including `onSuccess`) get refreshed against
  // an in-flight mutation on every render of whichever component owns this
  // hook — see MutationObserver#setOptions in @tanstack/query-core, which
  // runs `this.#currentMutation.setOptions(this.options)` whenever the
  // mutation is still pending (and that `setOptions` call itself happens
  // every render via useMutation's own `useEffect(() => observer.setOptions
  // (options), [observer, options])`). So an `onSuccess` closing directly
  // over `editing` would run against whatever `editing` *is when the save
  // lands*, not whatever it *was when the save was issued* (T-119): cancel
  // out of an edit and open a different form while the first save is still
  // in flight, and its `onSuccess` fires against the new form instead.
  //
  // The per-call options passed as `mutate(data, options)`'s second
  // argument don't have this problem — `MutationObserver#mutate` captures
  // them once, in `#mutateOptions`, and only `setOptions` (the *base*
  // options) gets refreshed — so `save` below snapshots `editing` at
  // `mutate()`-time into a local and hands the per-call `onSuccess` that
  // snapshot, closed over normally (that part genuinely never changes for
  // this call). `editingRef` mirrors `editing` on every render so that
  // same callback can also read what's current *when the response lands*,
  // to decide whether this save's own form is still the one open.
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const saveMutation = useMutation({
    mutationFn: (data: TCreate) => (editing && editing !== 'new' ? update(editing.id, data) : create(data)),
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const save = (data: TCreate) => {
    const snapshot = editing;
    saveMutation.mutate(data, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey });
        // Names the action this save actually performed, from the
        // snapshot — not whatever form happens to be open when the
        // response lands.
        showToast(t(snapshot === 'new' ? createdMsg : updatedMsg));
        // Only close the form this save was issued for. Same entity (by
        // id) counts as the same form even if a background refetch handed
        // back a new object for it; a genuinely different form (a
        // different entity, 'new', or null after a Cancel) is left alone
        // so nothing the operator has since typed gets thrown away.
        const current = editingRef.current;
        const sameTarget =
          snapshot === current ||
          (snapshot !== null && snapshot !== 'new' && current !== null && current !== 'new' && snapshot.id === current.id);
        if (sameTarget) onSaved();
      },
    });
  };

  const deleteMutation = useMutation({
    mutationFn: (id: number) => remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      showToast(t(deletedMsg));
      onDeleted();
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  // `saveMutation.isPending`/`.mutate` are both still read by callers
  // (isPending to disable the form's Save button and show its spinner;
  // mutate to submit) — only `mutate` itself is swapped out for the
  // snapshotting wrapper above, everything else about the object is
  // untouched.
  return { saveMutation: { ...saveMutation, mutate: save }, deleteMutation };
}

/**
 * Shared dirty/refetch/save mechanics for the two calculator-defaults-shaped
 * settings forms (CalculatorDefaultsPanel, CalculatorMarginCurvePanel) — a
 * flat form of string field values PATCHed back as `CalculatorDefaultsUpdate`.
 *
 * `dirty` tracks whether the operator has touched a field since the form was
 * last seeded (either on mount or after their own save). While untouched,
 * the form keeps following the server row — e.g. a save made from another
 * session. Once dirty, a background refetch (including the invalidation
 * this same hook's own save triggers) must not blow away in-progress typing.
 *
 * `toForm` is read through a ref rather than listed as an effect dependency:
 * callers typically pass a fresh closure each render (it closes over the
 * panel's own field table), and putting it in the dependency array would
 * re-run the seeding effect — and therefore call `setForm` — on every
 * render, not just when `defaults`/`dirty` actually change.
 */
export function useDefaultsForm<K extends string>(
  {
    fields,
    toForm,
    savedMsgKey,
  }: {
    /** The subset of CalculatorDefaults keys this form owns — everything
     *  else on the row is left untouched by `save`. */
    fields: readonly K[];
    toForm: (d: CalculatorDefaults) => Record<K, string>;
    /** i18n key for the toast shown after a successful save. */
    savedMsgKey: string;
  },
  defaults: CalculatorDefaults,
): { form: Record<K, string>; setField: (key: K, v: string) => void; save: () => void; isPending: boolean } {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Record<K, string>>(() => toForm(defaults));
  const [dirty, setDirty] = useState(false);

  const toFormRef = useRef(toForm);
  toFormRef.current = toForm;

  useEffect(() => {
    if (!dirty) setForm(toFormRef.current(defaults));
  }, [defaults, dirty]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, number> = {};
      for (const key of fields) {
        const n = parseNum(form[key]);
        if (n !== null) payload[key] = n;
      }
      return api.updateCalculatorDefaults(payload);
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['calculatorDefaults'] });
      showToast(t(savedMsgKey));
      // Adopt the operator's own successful save and clear dirty —
      // otherwise the form would look perpetually dirty and ignore the very
      // refetch its own save just triggered.
      setForm(toFormRef.current(saved));
      setDirty(false);
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const setField = (key: K, v: string) => {
    setDirty(true);
    setForm((f) => ({ ...f, [key]: v }));
  };

  return { form, setField, save: () => saveMutation.mutate(), isPending: saveMutation.isPending };
}
