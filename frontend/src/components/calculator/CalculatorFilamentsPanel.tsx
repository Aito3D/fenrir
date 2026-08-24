// Filament profile tab of the calculator settings: a searchable, filterable,
// sortable listing plus the add/edit form (including the Zoho link/sync
// flow). Split out of the former CalculatorSettingsPanels.tsx (T-078).

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  api,
  type CalculatorFilament,
  type CalculatorFilamentCreate,
  type CalculatorFilamentSyncResult,
  type ZohoFilamentProduct,
} from '../../api/client';
import { Button } from '../Button';
import { ZohoFilamentSearch } from './ZohoFilamentSearch';
import { Card, CardContent, CardHeader } from '../Card';
import { ConfirmModal } from '../ConfirmModal';
import { NumberField } from '../NumberField';
import { SearchableSelect } from '../SearchableSelect';
import { inputCls, labelCls } from '../formStyles';
import { formatMoney, formatPct } from '../../utils/pricing';
import { getCurrencySymbol } from '../../utils/currency';
import { FILAMENT_BRANDS, FILAMENT_MATERIALS } from '../../utils/filamentOptions';
import { parseNum, settingsTdCls, useEntityCrudMutations, useSortToggle } from './calculatorSettingsShared';
import { SortHeader, SearchBox, CountBadge, NoMatches } from './CalculatorPanelParts';

/** Margin choices offered in the dropdown: 0 % to 200 % in 25 % steps. */
export const MARGIN_STEPS = [0, 25, 50, 75, 100, 125, 150, 175, 200] as const;

/** Label for one margin option.
 *
 *  Off-grid margins reach the dropdown from the backfill of a hand-typed sale
 *  price, and a float like 50.013401232913424 would otherwise be rendered at
 *  full precision. The option's *value* stays the exact stored number so
 *  re-saving such a row leaves its margin (and therefore its printing cost)
 *  untouched — only the label is trimmed.
 */
const formatMarginLabel = (margin: number): string => `${Number(margin.toFixed(2))}%`;

interface FilamentFormState {
  brand: string;
  material: string;
  cost: string;
  margin: string;
  difficulty: string;
  zohoItemId: string | null;
  zohoItemName: string | null;
  zohoSku: string | null;
  spoolWeight: string;
  /** True when the linked Zoho item name carried no weight and 1 kg was assumed. */
  weightInferred: boolean;
}

function filamentFormFrom(
  defaultDifficulty: number,
  defaultMargin: number,
  f?: CalculatorFilament,
): FilamentFormState {
  if (!f) {
    return {
      brand: '',
      material: '',
      cost: '',
      margin: String(defaultMargin),
      difficulty: String(defaultDifficulty),
      zohoItemId: null,
      zohoItemName: null,
      zohoSku: null,
      spoolWeight: '',
      weightInferred: false,
    };
  }
  return {
    brand: f.brand,
    material: f.material,
    cost: String(f.cost_per_kg),
    margin: String(f.margin_pct),
    difficulty: String(f.difficulty_pct),
    zohoItemId: f.zoho_item_id,
    zohoItemName: f.zoho_item_name,
    zohoSku: f.zoho_sku,
    spoolWeight: f.spool_weight_kg === null ? '' : String(f.spool_weight_kg),
    weightInferred: false,
  };
}

function FilamentForm({
  initial,
  defaultDifficulty,
  defaultMargin,
  currency,
  currencySymbol,
  zohoConfigured,
  existingFilaments,
  isSaving,
  onSubmit,
  onCancel,
}: {
  initial?: CalculatorFilament;
  defaultDifficulty: number;
  defaultMargin: number;
  /** ISO code (e.g. "XPF") — what `formatMoney` needs; not the symbol. */
  currency: string;
  currencySymbol: string;
  zohoConfigured: boolean;
  /** The rows already listed, for the duplicate brand+material warning. */
  existingFilaments: CalculatorFilament[];
  isSaving: boolean;
  onSubmit: (data: CalculatorFilamentCreate) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<FilamentFormState>(() =>
    filamentFormFrom(defaultDifficulty, defaultMargin, initial),
  );

  const linked = form.zohoItemId !== null;

  // Cost is Zoho-owned while linked: dealer price divided by the spool weight.
  // Editing the weight therefore re-derives the cost, which is why the raw
  // dealer price is kept in state rather than only the cost.
  //
  // A row that arrives already linked has no dealer price on it — the column
  // stores the cost, not the price — so reconstruct it from the same
  // arithmetic that produced the cost (`round(dealer_price / weight, 2)`
  // server-side), which recovers the price for any weight the cost was
  // actually divided by.
  const [dealerPrice, setDealerPrice] = useState<number | null>(() => {
    if (!initial?.zoho_item_id) return null;
    // `zoho_synced_at` is stamped only by a sync that actually applied a dealer
    // price: a `has_price: false` item (55 of the 256 real ones) is counted as
    // `skipped_no_price` and `continue`s before the stamp. A null stamp on a
    // linked row therefore means its cost is the operator's own, whatever the
    // number is — reconstructing a "dealer price" from it would make the field
    // read-only and let a weight correction silently rescale a figure Zoho
    // never supplied. Erring toward editable is the safe direction here.
    if (initial.zoho_synced_at === null) return null;
    // Belt and braces on the value itself: a zero cost or a missing/nonsensical
    // weight makes the division meaningless in either direction.
    const weight = initial.spool_weight_kg;
    if (weight === null || weight <= 0 || initial.cost_per_kg <= 0) return null;
    return initial.cost_per_kg * weight;
  });

  const setSpoolWeight = (spoolWeight: string) =>
    setForm((f) => {
      const weight = parseNum(spoolWeight);
      if (dealerPrice !== null && weight !== null && weight > 0) {
        return { ...f, spoolWeight, cost: String(Math.round((dealerPrice / weight) * 100) / 100) };
      }
      return { ...f, spoolWeight };
    });

  const selectZohoProduct = (product: ZohoFilamentProduct) => {
    setDealerPrice(product.has_price ? product.dealer_price : null);
    setForm((f) => ({
      ...f,
      brand: product.brand,
      material: product.material,
      // A dealer price of 0 must never become a cost of 0 — leave it for the
      // user to type, and keep the link so a later sync can fill it in.
      cost: product.has_price ? String(product.cost_per_kg) : '',
      zohoItemId: product.item_id,
      zohoItemName: product.name,
      zohoSku: product.sku,
      spoolWeight: String(product.spool_weight_kg),
      weightInferred: product.weight_inferred,
    }));
  };

  const unlinkZohoProduct = () => {
    setDealerPrice(null);
    setForm((f) => ({
      ...f,
      zohoItemId: null,
      zohoItemName: null,
      zohoSku: null,
      spoolWeight: '',
      weightInferred: false,
    }));
  };

  const cost = parseNum(form.cost);
  const margin = parseNum(form.margin);
  const difficulty = parseNum(form.difficulty);
  const spoolWeight = parseNum(form.spoolWeight);
  const printingCost = cost !== null && margin !== null ? Math.round(cost * (1 + margin / 100) * 100) / 100 : null;

  // An existing row may carry a margin that predates the 25 % grid; offering it
  // as an extra choice means such a row can still be saved unchanged.
  const marginChoices =
    margin !== null && !MARGIN_STEPS.includes(margin as (typeof MARGIN_STEPS)[number])
      ? [margin, ...MARGIN_STEPS]
      : [...MARGIN_STEPS];

  // A blank weight is legitimate (it posts as null, which the API accepts on a
  // linked row); a zero or non-numeric one is not — the API rejects it with a
  // field-level 422 that surfaces as raw `body.spool_weight_kg` text in a
  // toast. Mirror the server's `gt=0, nullable` rule so Save is simply
  // disabled instead.
  const spoolWeightValid =
    !linked || form.spoolWeight.trim() === '' || (spoolWeight !== null && spoolWeight > 0);

  const valid =
    form.material.trim().length > 0 &&
    cost !== null && cost > 0 &&
    margin !== null && margin >= 0 &&
    spoolWeightValid &&
    difficulty !== null && difficulty >= 100 && difficulty <= 1000;

  // Colour is not stored, so two colours of the same brand+material would
  // collapse into two identically-named rows. That is a warning, not an error:
  // duplicates already exist in production (SUNLU/ASA appears twice) and
  // blocking would stop a legitimate re-price of the same material.
  const duplicateOf = existingFilaments.find(
    (other) =>
      other.id !== initial?.id &&
      other.brand.trim().toLowerCase() === form.brand.trim().toLowerCase() &&
      other.material.trim().toLowerCase() === form.material.trim().toLowerCase(),
  );

  return (
    <form
      autoComplete="off"
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) {
          onSubmit({
            brand: form.brand.trim(),
            material: form.material.trim(),
            cost_per_kg: cost,
            margin_pct: margin,
            difficulty_pct: difficulty,
            zoho_item_id: form.zohoItemId,
            zoho_item_name: form.zohoItemName,
            zoho_sku: form.zohoSku,
            spool_weight_kg: linked ? spoolWeight : null,
          });
        }
      }}
    >
      {zohoConfigured && !linked && (
        <ZohoFilamentSearch onSelect={selectZohoProduct} currency={currency} />
      )}
      {linked && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-bambu-green/40 bg-bambu-green/10 px-3 py-2">
          <span className="text-sm text-white truncate">
            {t('calculator.zohoLinkedProduct', { name: form.zohoItemName })}
            {form.zohoSku && <span className="ml-2 text-xs text-bambu-gray">{form.zohoSku}</span>}
          </span>
          <Button type="button" variant="secondary" size="sm" onClick={unlinkZohoProduct}>
            {t('calculator.zohoUnlink')}
          </Button>
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="calc-fil-brand" className={labelCls}>{t('calculator.brand')}</label>
          <SearchableSelect
            id="calc-fil-brand"
            value={form.brand}
            onChange={(v) => setForm((f) => ({ ...f, brand: v }))}
            options={FILAMENT_BRANDS.map((b) => ({ value: b, label: b }))}
            allowCustom
            disabled={linked}
          />
        </div>
        <div>
          <label htmlFor="calc-fil-material" className={labelCls}>{t('calculator.material')}</label>
          <SearchableSelect
            id="calc-fil-material"
            value={form.material}
            onChange={(v) => setForm((f) => ({ ...f, material: v }))}
            options={FILAMENT_MATERIALS.map((m) => ({ value: m, label: m }))}
            allowCustom
            disabled={linked}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {linked && (
          <NumberField
            id="calc-fil-spool-weight"
            label={t('calculator.spoolWeightKg')}
            value={form.spoolWeight}
            onChange={setSpoolWeight}
            step="0.05"
            // NumberField defaults to min="0", which would let a 0 kg spool
            // through to an API that requires > 0 (a field-level 422 whose raw
            // body path lands in the toast). 0.05 rather than a smaller floor
            // because `min` is also the step base: with step="0.05", min="0.01"
            // would make an ordinary 1 kg spool a step mismatch and block the
            // save outright. Anchoring at 0.05 keeps exactly today's accepted
            // set of values (multiples of 50 g) minus zero.
            min="0.05"
            required
          />
        )}
        <NumberField
          id="calc-fil-cost"
          label={t('calculator.costPerKg', { currency: currencySymbol })}
          value={form.cost}
          onChange={(v) => setForm((f) => ({ ...f, cost: v }))}
          readOnly={linked && dealerPrice !== null}
          required
        />
        <NumberField
          id="calc-fil-difficulty"
          label={t('calculator.difficulty')}
          value={form.difficulty}
          onChange={(v) => setForm((f) => ({ ...f, difficulty: v }))}
          tooltip={t('calculator.difficultyTooltip')}
          min="100"
          max="1000"
          required
        />
      </div>
      {linked && form.weightInferred && (
        <p className="text-xs text-status-warning">{t('calculator.zohoWeightInferred')}</p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="calc-fil-margin" className={labelCls}>{t('calculator.marginOverCost')}</label>
          <select
            id="calc-fil-margin"
            className={inputCls}
            value={form.margin}
            onChange={(e) => setForm((f) => ({ ...f, margin: e.target.value }))}
          >
            {marginChoices.map((choice) => (
              <option key={choice} value={choice}>{formatMarginLabel(choice)}</option>
            ))}
          </select>
        </div>
        <NumberField
          id="calc-fil-printing-cost"
          label={t('calculator.printingCostPerKg', { currency: currencySymbol })}
          value={printingCost === null ? '' : String(printingCost)}
          onChange={() => {}}
          readOnly
        />
      </div>
      {duplicateOf && (
        <p className="text-xs text-status-warning">
          {t('calculator.zohoDuplicateWarning', { name: duplicateOf.name })}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={!valid || isSaving}>
          {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

type FilamentSortKey = 'name' | 'brand' | 'material' | 'cost' | 'sale' | 'margin' | 'difficulty';

/** Rows per sync request. Small enough that one chunk stays well inside the
 *  request timeout even when every row needs a Zoho lookup. */
const SYNC_CHUNK_SIZE = 25;

/** Per-chunk request budget (T-075). The backend's own Zoho calls are capped
 *  at 10 s each (see `zoho.py`'s `httpx.AsyncClient(timeout=10.0)`), and a
 *  chunk only ever triggers more than one of those when the 10-minute
 *  catalogue cache is cold, in which case `fetch_catalogue` pages it in up to
 *  `_MAX_PAGES` (20) page fetches — a real but rare worst case of a few tens
 *  of seconds. 60 s comfortably covers that case (and any ordinary slow
 *  network) while still bounding how long a chunk that will genuinely never
 *  settle can wedge the sync button. Ending on a timeout is exactly the
 *  existing failure path below — same catch, same guard release.
 */
const SYNC_CHUNK_TIMEOUT_MS = 60_000;

/** Distinguishes a `withTimeout` timeout from any other chunk failure (T-096)
 *  without matching on `message` text, which is only ever used for `instanceof`
 *  checks below — the user-facing wording lives entirely in the i18n layer. */
class SyncTimeoutError extends Error {
  constructor() {
    super('sync request timed out');
    this.name = 'SyncTimeoutError';
  }
}

/** Rejects with a `SyncTimeoutError` if `promise` has not settled within `ms`,
 *  otherwise resolves/rejects exactly as `promise` does. Never touches
 *  `promise` itself — a timeout does not cancel or abort the underlying
 *  request, it only stops the walk from waiting on it forever. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SyncTimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Where the walk's in-flight guard/progress lives. CalculatorPage
 *  mounts/unmounts this panel per tab switch, but the walk itself is a plain
 *  async loop that keeps running regardless — parking the guard in the
 *  QueryClient's cache instead of component state means a remount reattaches
 *  to whatever is already there rather than losing it, and a second mount
 *  cannot start an overlapping walk. The QueryClient itself is created once
 *  for the app's lifetime (App.tsx), so this is effectively session-scoped,
 *  not component-scoped.
 *
 *  The completed summary and any error are deliberately NOT kept here: they
 *  live in this component's own state below, exactly as before T-075, so a
 *  walk that ended while the panel was unmounted reports nothing on remount
 *  and a fresh mount always starts clean — only the live progress and the
 *  "a walk is running" guard survive a remount. */
const ZOHO_SYNC_PROGRESS_KEY = ['calculatorFilamentZohoSyncProgress'] as const;

type ZohoSyncProgress = { done: number; total: number } | null;

export function CalculatorFilamentsPanel({
  selectedFilamentId,
  canUpdate,
}: {
  selectedFilamentId: number | null;
  /** Gates the add/edit/delete controls; the searchable, sortable listing
   *  itself stays visible regardless (mirrors backend read/write split —
   *  Permission.CALCULATOR_UPDATE only guards create/update/delete). */
  canUpdate: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<CalculatorFilament | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<CalculatorFilament | null>(null);
  const [search, setSearch] = useState('');
  const [materialFilter, setMaterialFilter] = useState('');
  const [brandFilter, setBrandFilter] = useState('');
  const { sortKey, sortDir, toggleSort } = useSortToggle<FilamentSortKey>('name');

  const { data: filaments = [] } = useQuery({
    queryKey: ['calculatorFilaments'],
    queryFn: api.getCalculatorFilaments,
    staleTime: 60_000,
  });
  const { data: defaults } = useQuery({
    queryKey: ['calculatorDefaults'],
    queryFn: api.getCalculatorDefaults,
    staleTime: 60_000,
  });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const currency = settings?.currency || 'USD';
  const currencySymbol = getCurrencySymbol(currency);

  // Gates both the sync button and the form's product search. Same key and
  // shape as ZohoSettings/ImportQuoteDrawer so the three share one cache entry.
  const { data: zohoStatus } = useQuery({
    queryKey: ['zoho-status', { probe: false }],
    queryFn: () => api.getZohoStatus(),
    staleTime: 300_000,
  });
  const zohoConfigured = zohoStatus?.configured ?? false;

  // Backed by the QueryClient cache (see ZOHO_SYNC_PROGRESS_KEY above), not
  // useState, so this survives the panel unmounting mid-walk. `queryFn` only
  // matters for the very first observer in the app session — after that,
  // every update is a direct `setQueryData` push from `runSync` below, and
  // `staleTime`/`gcTime: Infinity` keep React Query from ever refetching or
  // discarding it on its own.
  const { data: syncProgress = null } = useQuery<ZohoSyncProgress>({
    queryKey: ZOHO_SYNC_PROGRESS_KEY,
    queryFn: () => queryClient.getQueryData<ZohoSyncProgress>(ZOHO_SYNC_PROGRESS_KEY) ?? null,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  // Unlike the guard/progress above, the completed summary and any error are
  // ordinary component state: a walk that finishes (or fails) while the panel
  // is unmounted has nothing listening for it, and a remount starts clean —
  // matching the panel's pre-T-075 behavior for these two.
  const [syncSummary, setSyncSummary] = useState<CalculatorFilamentSyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  // Set alongside `syncError` only when the walk ended via `withTimeout`
  // (T-096): `withTimeout` never aborts the underlying request, so a timeout
  // is not a real failure — the chunk may still commit after the walk gives
  // up on it. Gates the indeterminate wording below instead of the flat
  // "failed" one.
  const [syncTimedOut, setSyncTimedOut] = useState(false);

  // Chunking is client-driven and pages by id (keyset), not by offset: each
  // request commits its own work, so a failure partway through leaves the
  // earlier chunks applied and `next_after_id` is where a retry resumes.
  // Paging by id rather than offset means a filament deleted mid-run cannot
  // shift the remaining rows and cause one to be silently skipped.
  const runSync = async () => {
    // Belt and braces: the button is already disabled while a walk is live,
    // but this is what actually stops a second walk from starting, from any
    // mount — the button's `disabled` prop is just what makes that visible.
    if (queryClient.getQueryData<ZohoSyncProgress>(ZOHO_SYNC_PROGRESS_KEY)) return;
    setSyncSummary(null);
    setSyncError(null);
    setSyncTimedOut(false);
    // Seed the denominator from what we already know is linked, so the button
    // never sits at "0 / 0" for the seconds the first chunk takes; the server's
    // own COUNT takes over from that chunk onwards.
    queryClient.setQueryData<ZohoSyncProgress>(ZOHO_SYNC_PROGRESS_KEY, {
      done: 0,
      total: filaments.filter((f) => f.zoho_item_id).length,
    });
    const totals = { processed: 0, total: 0, updated: 0, unchanged: 0, skipped_no_price: 0, missing: 0 };
    let afterId: number | null = 0;
    try {
      while (afterId !== null) {
        // T-075: a chunk that never settles (network black hole — nothing
        // guards against that on the browser's own `fetch`) would otherwise
        // leave this loop, and therefore the guard above, stuck forever.
        const chunk: CalculatorFilamentSyncResult = await withTimeout(
          api.syncCalculatorFilamentsFromZoho(afterId, SYNC_CHUNK_SIZE),
          SYNC_CHUNK_TIMEOUT_MS,
        );
        totals.processed += chunk.processed;
        totals.updated += chunk.updated;
        totals.unchanged += chunk.unchanged;
        totals.skipped_no_price += chunk.skipped_no_price;
        totals.missing += chunk.missing;
        totals.total = chunk.total;
        // `total` is a fresh COUNT on every chunk, so rows added or deleted
        // mid-walk make it drift. Never let the denominator fall behind what
        // has already been processed — "50 / 12" would read as a bug.
        queryClient.setQueryData<ZohoSyncProgress>(ZOHO_SYNC_PROGRESS_KEY, {
          done: totals.processed,
          total: Math.max(chunk.total, totals.processed),
        });
        // A last chunk can legitimately report processed: 0 — its lookahead
        // sentinel row was deleted in between. Only next_after_id ends the walk.
        const prev = afterId;
        afterId = chunk.next_after_id;
        // The cursor must strictly increase (the backend pages WHERE id >
        // after_id), and nothing today returns otherwise. But if it ever did,
        // this loop would hammer the server with hundreds of COUNT-plus-commit
        // requests a second behind a disabled button with no way out. Throwing
        // hands it to the catch below: the operator gets a truthful stop and
        // the partial work is refetched, instead of a hung tab.
        if (afterId !== null && afterId <= prev) {
          throw new Error(`sync did not advance past id ${prev}`);
        }
      }
      setSyncSummary({ ...totals, next_after_id: null });
      queryClient.invalidateQueries({ queryKey: ['calculatorFilaments'] });
    } catch (error) {
      // The chunks that did land are already committed server-side; refetch so
      // the table shows the partial result instead of the pre-sync prices.
      const timedOut = error instanceof SyncTimeoutError;
      setSyncTimedOut(timedOut);
      setSyncError(error instanceof Error ? error.message : String(error));
      queryClient.invalidateQueries({ queryKey: ['calculatorFilaments'] });
      if (timedOut) {
        // `withTimeout` never aborts the request that timed out, so it is
        // still running server-side and may commit further prices after this
        // walk has already given up and refetched above. Re-invalidate again
        // once it has had the same worst-case window to land, so the table
        // picks those up too instead of being stuck on whatever the
        // immediate refetch caught mid-flight.
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ['calculatorFilaments'] });
        }, SYNC_CHUNK_TIMEOUT_MS);
      }
    } finally {
      // Always releases the guard — success, a reported failure, or a chunk
      // that timed out all end the walk the same way.
      queryClient.setQueryData<ZohoSyncProgress>(ZOHO_SYNC_PROGRESS_KEY, null);
    }
  };

  const { saveMutation, deleteMutation } = useEntityCrudMutations<CalculatorFilament, CalculatorFilamentCreate>({
    queryKey: ['calculatorFilaments'],
    editing,
    create: api.createCalculatorFilament,
    update: api.updateCalculatorFilament,
    remove: api.deleteCalculatorFilament,
    createdMsg: 'calculator.filamentCreated',
    updatedMsg: 'calculator.filamentUpdated',
    deletedMsg: 'calculator.filamentDeleted',
    onSaved: () => setEditing(null),
    onDeleted: () => setToDelete(null),
  });

  const materials = useMemo(
    () => [...new Set(filaments.map((f) => f.material).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [filaments],
  );
  const brands = useMemo(
    () => [...new Set(filaments.map((f) => f.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [filaments],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = filaments.filter(
      (f) =>
        (!q || f.name.toLowerCase().includes(q)) &&
        (!materialFilter || f.material === materialFilter) &&
        (!brandFilter || f.brand === brandFilter),
    );
    const dir = sortDir === 'asc' ? 1 : -1;
    return filtered.sort((a, b) => {
      switch (sortKey) {
        case 'brand':
          return dir * (a.brand.localeCompare(b.brand) || a.material.localeCompare(b.material));
        case 'material':
          return dir * (a.material.localeCompare(b.material) || a.brand.localeCompare(b.brand));
        case 'cost':
          return dir * (a.cost_per_kg - b.cost_per_kg);
        case 'sale':
          return dir * (a.sale_price_per_kg - b.sale_price_per_kg);
        case 'margin':
          return dir * (a.margin_pct - b.margin_pct);
        case 'difficulty':
          return dir * (a.difficulty_pct - b.difficulty_pct);
        default:
          return dir * a.name.localeCompare(b.name);
      }
    });
  }, [filaments, search, materialFilter, brandFilter, sortKey, sortDir]);

  return (
    <Card className="animate-calc-rise">
      <CardHeader className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-white">
          {t('calculator.tabFilaments')}
          <CountBadge visible={visible.length} total={filaments.length} />
        </h2>
        {!editing && canUpdate && (
          <div className="flex items-center gap-2">
            {zohoConfigured && (
              <Button size="sm" variant="secondary" onClick={runSync} disabled={syncProgress !== null}>
                {syncProgress !== null ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                {syncProgress !== null
                  ? t('calculator.syncProgress', { done: syncProgress.done, total: syncProgress.total })
                  : t('calculator.syncZohoPrices')}
              </Button>
            )}
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus className="w-4 h-4" />
              {t('calculator.addFilament')}
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {syncSummary && (
          <p className="mb-3 text-xs text-bambu-gray">
            {t('calculator.syncSummary', {
              updated: syncSummary.updated,
              unchanged: syncSummary.unchanged,
              skipped: syncSummary.skipped_no_price,
              missing: syncSummary.missing,
            })}
          </p>
        )}
        {syncError && (
          <p className="mb-3 text-xs text-status-error">
            {syncTimedOut ? t('calculator.syncTimedOut') : t('calculator.syncFailed', { error: syncError })}
          </p>
        )}
        {editing && canUpdate ? (
          <FilamentForm
            initial={editing === 'new' ? undefined : editing}
            defaultDifficulty={defaults?.default_difficulty_pct ?? 100}
            defaultMargin={defaults?.default_margin_over_cost_pct ?? 50}
            currency={currency}
            currencySymbol={currencySymbol}
            zohoConfigured={zohoConfigured}
            existingFilaments={filaments}
            isSaving={saveMutation.isPending}
            onSubmit={(data) => saveMutation.mutate(data)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row gap-2">
              <SearchBox value={search} onChange={setSearch} className="flex-1 min-w-[10rem]" />
              <select
                className={`${inputCls} sm:w-44`}
                value={materialFilter}
                onChange={(e) => setMaterialFilter(e.target.value)}
                aria-label={t('calculator.material')}
              >
                <option value="">{t('calculator.allMaterials')}</option>
                {materials.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <select
                className={`${inputCls} sm:w-44`}
                value={brandFilter}
                onChange={(e) => setBrandFilter(e.target.value)}
                aria-label={t('calculator.brand')}
              >
                <option value="">{t('calculator.allBrands')}</option>
                {brands.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
            {visible.length === 0 ? (
              <NoMatches />
            ) : (
              <div className="overflow-x-auto -mx-6 px-6">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-bambu-dark-tertiary">
                      <SortHeader label={t('calculator.brand')} active={sortKey === 'brand'} dir={sortDir} onClick={() => toggleSort('brand')} align="left" />
                      <SortHeader label={t('calculator.material')} active={sortKey === 'material'} dir={sortDir} onClick={() => toggleSort('material')} align="left" />
                      <SortHeader label={t('calculator.costPerKg', { currency: currencySymbol })} active={sortKey === 'cost'} dir={sortDir} onClick={() => toggleSort('cost')} />
                      <SortHeader label={t('calculator.printingCostPerKg', { currency: currencySymbol })} active={sortKey === 'sale'} dir={sortDir} onClick={() => toggleSort('sale')} />
                      <SortHeader label={t('calculator.marginOverCost')} active={sortKey === 'margin'} dir={sortDir} onClick={() => toggleSort('margin')} />
                      <SortHeader label={t('calculator.difficulty')} active={sortKey === 'difficulty'} dir={sortDir} onClick={() => toggleSort('difficulty')} />
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((f) => (
                      <tr key={f.id} className="border-b border-bambu-dark-tertiary/50 last:border-b-0 hover:bg-bambu-dark-tertiary/30 transition-colors">
                        <td className={`${settingsTdCls} text-white`}>
                          {f.brand || '—'}
                          {f.id === selectedFilamentId && (
                            <span className="ml-2 text-xs text-bambu-green" title={t('calculator.inUse')}>●</span>
                          )}
                          {f.zoho_item_id && (
                            <span
                              className="ml-2 text-[10px] uppercase tracking-wide text-bambu-green"
                              title={f.zoho_item_name ?? undefined}
                            >
                              Zoho
                            </span>
                          )}
                        </td>
                        <td className={`${settingsTdCls} text-white`}>{f.material}</td>
                        <td className={`${settingsTdCls} text-right text-bambu-gray-light tabular-nums`}>{formatMoney(f.cost_per_kg, currency, false)}</td>
                        <td className={`${settingsTdCls} text-right text-bambu-gray-light tabular-nums`}>{formatMoney(f.sale_price_per_kg, currency, false)}</td>
                        <td className={`${settingsTdCls} text-right text-bambu-gray-light tabular-nums`}>
                          {formatPct(f.margin_pct / 100, 0)}
                        </td>
                        <td className={`${settingsTdCls} text-right text-bambu-gray-light tabular-nums`} title={t('calculator.difficultyTooltip')}>{formatPct(f.difficulty_pct / 100, 0)}</td>
                        <td className={`${settingsTdCls} text-right`}>
                          {canUpdate && (
                            <div className="flex gap-1 justify-end">
                              <Button variant="ghost" size="sm" onClick={() => setEditing(f)} aria-label={t('calculator.editFilament')}>
                                <Pencil className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setToDelete(f)}
                                disabled={f.id === selectedFilamentId}
                                title={f.id === selectedFilamentId ? t('calculator.inUse') : undefined}
                                aria-label={t('calculator.deleteFilamentTitle')}
                              >
                                <Trash2 className="w-4 h-4 text-status-error" />
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </CardContent>

      {toDelete && (
        <ConfirmModal
          title={t('calculator.deleteFilamentTitle')}
          message={t('calculator.deleteFilamentMessage', { name: toDelete.name })}
          variant="danger"
          isLoading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(toDelete.id)}
          onCancel={() => setToDelete(null)}
        />
      )}
    </Card>
  );
}
