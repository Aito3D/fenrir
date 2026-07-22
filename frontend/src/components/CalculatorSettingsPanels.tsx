// Calculator configuration panels rendered as tabs of the calculator page:
// filament profiles, printer profiles and global defaults. The filament and
// printer lists are searchable, filterable and sortable so they stay usable
// with hundreds of entries.

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Loader2, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import {
  api,
  type CalculatorDefaults,
  type CalculatorFilament,
  type CalculatorFilamentCreate,
  type CalculatorPrinter,
  type CalculatorPrinterCreate,
} from '../api/client';
import { Button } from './Button';
import { Card, CardContent, CardHeader } from './Card';
import { ConfirmModal } from './ConfirmModal';
import { NumberField } from './NumberField';
import { SearchableSelect } from './SearchableSelect';
import { inputCls, labelCls } from './formStyles';
import {
  formatMoney,
  formatPct,
  printerDepreciationPerHour,
  printerLifetimeHours,
  printerRepairsPerHour,
} from '../utils/pricing';
import { getCurrencySymbol } from '../utils/currency';
import { FILAMENT_BRANDS, FILAMENT_MATERIALS } from '../utils/filamentOptions';
import { useToast } from '../contexts/ToastContext';

const thBtnCls =
  'flex items-center gap-1 text-[11px] uppercase tracking-wide font-medium text-bambu-gray hover:text-white transition-colors whitespace-nowrap';
const tdCls = 'px-3 py-2 text-sm whitespace-nowrap';

const parseNum = (s: string): number | null => {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

type SortDir = 'asc' | 'desc';

function SortHeader({
  label,
  active,
  dir,
  onClick,
  align = 'right',
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  align?: 'left' | 'right';
}) {
  return (
    <th className={`px-3 py-2 ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button type="button" onClick={onClick} className={`${thBtnCls} ${align === 'right' ? 'ml-auto' : ''}`}>
        {label}
        {active &&
          (dir === 'asc' ? (
            <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
          ))}
      </button>
    </th>
  );
}

function SearchBox({ value, onChange, className = '' }: { value: string; onChange: (v: string) => void; className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={`relative ${className}`}>
      <Search className="w-4 h-4 text-bambu-gray absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
      <input
        type="search"
        className={`${inputCls} !pl-9`}
        placeholder={t('common.search')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={t('common.search')}
      />
    </div>
  );
}

interface FilamentFormState {
  brand: string;
  material: string;
  cost: string;
  sale: string;
  margin: string;
  difficulty: string;
}

function filamentFormFrom(defaultDifficulty: number, defaultMargin: number, f?: CalculatorFilament): FilamentFormState {
  if (!f) {
    return {
      brand: '',
      material: '',
      cost: '',
      sale: '',
      margin: String(defaultMargin),
      difficulty: String(defaultDifficulty),
    };
  }
  const margin = f.cost_per_kg > 0 ? ((f.sale_price_per_kg / f.cost_per_kg - 1) * 100).toFixed(1) : '';
  return {
    brand: f.brand,
    material: f.material,
    cost: String(f.cost_per_kg),
    sale: String(f.sale_price_per_kg),
    margin,
    difficulty: String(f.difficulty_pct),
  };
}

function FilamentForm({
  initial,
  defaultDifficulty,
  defaultMargin,
  currencySymbol,
  isSaving,
  onSubmit,
  onCancel,
}: {
  initial?: CalculatorFilament;
  defaultDifficulty: number;
  defaultMargin: number;
  currencySymbol: string;
  isSaving: boolean;
  onSubmit: (data: CalculatorFilamentCreate) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<FilamentFormState>(() =>
    filamentFormFrom(defaultDifficulty, defaultMargin, initial),
  );

  // Sale price and margin % are live-synced: editing either keeps the other consistent.
  const setCost = (cost: string) =>
    setForm((f) => {
      const c = parseNum(cost);
      const m = parseNum(f.margin);
      if (c !== null && m !== null) return { ...f, cost, sale: String(Math.round(c * (1 + m / 100) * 100) / 100) };
      return { ...f, cost };
    });
  const setSale = (sale: string) =>
    setForm((f) => {
      const c = parseNum(f.cost);
      const s = parseNum(sale);
      const margin = c !== null && c > 0 && s !== null ? ((s / c - 1) * 100).toFixed(1) : f.margin;
      return { ...f, sale, margin };
    });
  const setMargin = (margin: string) =>
    setForm((f) => {
      const c = parseNum(f.cost);
      const m = parseNum(margin);
      const sale = c !== null && m !== null ? String(Math.round(c * (1 + m / 100) * 100) / 100) : f.sale;
      return { ...f, margin, sale };
    });

  const cost = parseNum(form.cost);
  const sale = parseNum(form.sale);
  const difficulty = parseNum(form.difficulty);
  const valid =
    form.material.trim().length > 0 &&
    cost !== null && cost > 0 &&
    sale !== null && sale > 0 &&
    difficulty !== null && difficulty >= 100 && difficulty <= 1000;

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
            sale_price_per_kg: sale,
            difficulty_pct: difficulty,
          });
        }
      }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="calc-fil-brand" className={labelCls}>{t('calculator.brand')}</label>
          <SearchableSelect
            id="calc-fil-brand"
            value={form.brand}
            onChange={(v) => setForm((f) => ({ ...f, brand: v }))}
            options={FILAMENT_BRANDS.map((b) => ({ value: b, label: b }))}
            allowCustom
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
          />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <NumberField
          id="calc-fil-cost"
          label={t('calculator.costPerKg', { currency: currencySymbol })}
          value={form.cost}
          onChange={setCost}
          required
        />
        <NumberField
          id="calc-fil-sale"
          label={t('calculator.salePerKg', { currency: currencySymbol })}
          value={form.sale}
          onChange={setSale}
          required
        />
        <NumberField
          id="calc-fil-margin"
          label={t('calculator.marginOverCost')}
          value={form.margin}
          onChange={setMargin}
          min="-100"
        />
      </div>
      <div>
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
        <p className="text-xs text-bambu-gray mt-1">{t('calculator.difficultyTooltip')}</p>
      </div>
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

/** Margin over purchase cost as a fraction; null when there is no cost yet. */
const filamentMarginOverCost = (f: CalculatorFilament): number | null =>
  f.cost_per_kg > 0 ? (f.sale_price_per_kg - f.cost_per_kg) / f.cost_per_kg : null;

export function CalculatorFilamentsPanel({ selectedFilamentId }: { selectedFilamentId: number | null }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<CalculatorFilament | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<CalculatorFilament | null>(null);
  const [search, setSearch] = useState('');
  const [materialFilter, setMaterialFilter] = useState('');
  const [brandFilter, setBrandFilter] = useState('');
  const [sortKey, setSortKey] = useState<FilamentSortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

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

  const saveMutation = useMutation({
    mutationFn: (data: CalculatorFilamentCreate) =>
      editing && editing !== 'new' ? api.updateCalculatorFilament(editing.id, data) : api.createCalculatorFilament(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calculatorFilaments'] });
      showToast(t(editing === 'new' ? 'calculator.filamentCreated' : 'calculator.filamentUpdated'));
      setEditing(null);
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteCalculatorFilament(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calculatorFilaments'] });
      showToast(t('calculator.filamentDeleted'));
      setToDelete(null);
    },
    onError: (error: Error) => showToast(error.message, 'error'),
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
          return dir * ((filamentMarginOverCost(a) ?? -1) - (filamentMarginOverCost(b) ?? -1));
        case 'difficulty':
          return dir * (a.difficulty_pct - b.difficulty_pct);
        default:
          return dir * a.name.localeCompare(b.name);
      }
    });
  }, [filaments, search, materialFilter, brandFilter, sortKey, sortDir]);

  const toggleSort = (key: FilamentSortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  return (
    <Card className="animate-calc-rise">
      <CardHeader className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-white">
          {t('calculator.tabFilaments')}
          <span className="ml-2 text-sm font-normal text-bambu-gray tabular-nums">
            {visible.length === filaments.length ? filaments.length : `${visible.length} / ${filaments.length}`}
          </span>
        </h2>
        {!editing && (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="w-4 h-4" />
            {t('calculator.addFilament')}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {editing ? (
          <FilamentForm
            initial={editing === 'new' ? undefined : editing}
            defaultDifficulty={defaults?.default_difficulty_pct ?? 100}
            defaultMargin={defaults?.default_margin_over_cost_pct ?? 50}
            currencySymbol={currencySymbol}
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
              <p className="text-sm text-bambu-gray text-center py-6">{t('calculator.noMatches')}</p>
            ) : (
              <div className="overflow-x-auto -mx-6 px-6">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-bambu-dark-tertiary">
                      <SortHeader label={t('calculator.brand')} active={sortKey === 'brand'} dir={sortDir} onClick={() => toggleSort('brand')} align="left" />
                      <SortHeader label={t('calculator.material')} active={sortKey === 'material'} dir={sortDir} onClick={() => toggleSort('material')} align="left" />
                      <SortHeader label={t('calculator.costPerKg', { currency: currencySymbol })} active={sortKey === 'cost'} dir={sortDir} onClick={() => toggleSort('cost')} />
                      <SortHeader label={t('calculator.salePerKg', { currency: currencySymbol })} active={sortKey === 'sale'} dir={sortDir} onClick={() => toggleSort('sale')} />
                      <SortHeader label={t('calculator.marginOverCost')} active={sortKey === 'margin'} dir={sortDir} onClick={() => toggleSort('margin')} />
                      <SortHeader label={t('calculator.difficulty')} active={sortKey === 'difficulty'} dir={sortDir} onClick={() => toggleSort('difficulty')} />
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((f) => (
                      <tr key={f.id} className="border-b border-bambu-dark-tertiary/50 last:border-b-0 hover:bg-bambu-dark-tertiary/30 transition-colors">
                        <td className={`${tdCls} text-white`}>
                          {f.brand || '—'}
                          {f.id === selectedFilamentId && (
                            <span className="ml-2 text-xs text-bambu-green" title={t('calculator.inUse')}>●</span>
                          )}
                        </td>
                        <td className={`${tdCls} text-white`}>{f.material}</td>
                        <td className={`${tdCls} text-right text-bambu-gray-light tabular-nums`}>{formatMoney(f.cost_per_kg, currency, false)}</td>
                        <td className={`${tdCls} text-right text-bambu-gray-light tabular-nums`}>{formatMoney(f.sale_price_per_kg, currency, false)}</td>
                        <td className={`${tdCls} text-right text-bambu-gray-light tabular-nums`}>
                          {filamentMarginOverCost(f) !== null ? formatPct(filamentMarginOverCost(f)!, 0) : '—'}
                        </td>
                        <td className={`${tdCls} text-right text-bambu-gray-light tabular-nums`} title={t('calculator.difficultyTooltip')}>{formatPct(f.difficulty_pct / 100, 0)}</td>
                        <td className={`${tdCls} text-right`}>
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

interface PrinterFormState {
  name: string;
  purchase: string;
  years: string;
  daily: string;
  watts: string;
  repair: string;
}

function printerFormFrom(p?: CalculatorPrinter): PrinterFormState {
  if (!p) return { name: '', purchase: '', years: '', daily: '', watts: '', repair: '' };
  return {
    name: p.name,
    purchase: String(p.purchase_price),
    years: String(p.lifetime_years),
    daily: String(p.daily_usage_hours),
    watts: String(p.power_watts),
    repair: String(p.repair_rate_pct),
  };
}

function PrinterForm({
  initial,
  currencySymbol,
  isSaving,
  onSubmit,
  onCancel,
}: {
  initial?: CalculatorPrinter;
  currencySymbol: string;
  isSaving: boolean;
  onSubmit: (data: CalculatorPrinterCreate) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<PrinterFormState>(() => printerFormFrom(initial));

  const purchase = parseNum(form.purchase);
  const years = parseNum(form.years);
  const daily = parseNum(form.daily);
  const watts = parseNum(form.watts);
  const repair = parseNum(form.repair);
  const valid =
    form.name.trim().length > 0 &&
    purchase !== null && purchase > 0 &&
    years !== null && years > 0 &&
    daily !== null && daily > 0 && daily <= 24 &&
    watts !== null && watts > 0 &&
    repair !== null && repair >= 0 && repair <= 100;

  const lifetimeHours = years !== null && daily !== null ? years * 365 * daily : null;
  const depPerHour = purchase !== null && lifetimeHours ? purchase / lifetimeHours : null;
  const repPerHour =
    purchase !== null && repair !== null && lifetimeHours ? (purchase * repair) / 100 / lifetimeHours : null;

  const field = (id: string, label: string, key: keyof PrinterFormState, max?: string) => (
    <NumberField
      id={id}
      label={label}
      value={form[key]}
      onChange={(v) => setForm((f) => ({ ...f, [key]: v }))}
      max={max}
      required
    />
  );

  return (
    <form
      autoComplete="off"
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) {
          onSubmit({
            name: form.name.trim(),
            purchase_price: purchase,
            lifetime_years: years,
            daily_usage_hours: daily,
            power_watts: watts,
            repair_rate_pct: repair,
          });
        }
      }}
    >
      <div>
        <label htmlFor="calc-prn-name" className={labelCls}>{t('calculator.name')}</label>
        <input
          id="calc-prn-name"
          className={inputCls}
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          required
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {field('calc-prn-price', t('calculator.purchasePrice', { currency: currencySymbol }), 'purchase')}
        {field('calc-prn-years', t('calculator.lifetimeYears'), 'years')}
        {field('calc-prn-daily', t('calculator.dailyUsage'), 'daily', '24')}
        {field('calc-prn-watts', t('calculator.powerWatts'), 'watts')}
        {field('calc-prn-repair', t('calculator.repairRate'), 'repair', '100')}
      </div>
      {lifetimeHours !== null && depPerHour !== null && repPerHour !== null && (
        <div className="text-xs text-bambu-gray flex flex-wrap gap-x-4 gap-y-1">
          <span>{t('calculator.lifetimeHours')}: {Math.round(lifetimeHours).toLocaleString()} h</span>
          <span>{t('calculator.depreciationPerHour')}: {depPerHour.toFixed(2)}</span>
          <span>{t('calculator.repairsPerHour')}: {repPerHour.toFixed(2)}</span>
        </div>
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

type PrinterSortKey = 'name' | 'purchase' | 'power' | 'daily' | 'lifetime' | 'depreciation' | 'repairs';

export function CalculatorPrintersPanel({ selectedPrinterId }: { selectedPrinterId: number | null }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<CalculatorPrinter | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<CalculatorPrinter | null>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<PrinterSortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const { data: printers = [] } = useQuery({
    queryKey: ['calculatorPrinters'],
    queryFn: api.getCalculatorPrinters,
    staleTime: 60_000,
  });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const currency = settings?.currency || 'USD';
  const currencySymbol = getCurrencySymbol(currency);

  const saveMutation = useMutation({
    mutationFn: (data: CalculatorPrinterCreate) =>
      editing && editing !== 'new' ? api.updateCalculatorPrinter(editing.id, data) : api.createCalculatorPrinter(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calculatorPrinters'] });
      showToast(t(editing === 'new' ? 'calculator.printerCreated' : 'calculator.printerUpdated'));
      setEditing(null);
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteCalculatorPrinter(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calculatorPrinters'] });
      showToast(t('calculator.printerDeleted'));
      setToDelete(null);
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = printers.filter((p) => !q || p.name.toLowerCase().includes(q));
    const dir = sortDir === 'asc' ? 1 : -1;
    return filtered.sort((a, b) => {
      switch (sortKey) {
        case 'purchase':
          return dir * (a.purchase_price - b.purchase_price);
        case 'power':
          return dir * (a.power_watts - b.power_watts);
        case 'daily':
          return dir * (a.daily_usage_hours - b.daily_usage_hours);
        case 'lifetime':
          return dir * (printerLifetimeHours(a) - printerLifetimeHours(b));
        case 'depreciation':
          return dir * (printerDepreciationPerHour(a) - printerDepreciationPerHour(b));
        case 'repairs':
          return dir * (printerRepairsPerHour(a) - printerRepairsPerHour(b));
        default:
          return dir * a.name.localeCompare(b.name);
      }
    });
  }, [printers, search, sortKey, sortDir]);

  const toggleSort = (key: PrinterSortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  return (
    <Card className="animate-calc-rise">
      <CardHeader className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-white">
          {t('calculator.tabPrinters')}
          <span className="ml-2 text-sm font-normal text-bambu-gray tabular-nums">
            {visible.length === printers.length ? printers.length : `${visible.length} / ${printers.length}`}
          </span>
        </h2>
        {!editing && (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="w-4 h-4" />
            {t('calculator.addPrinter')}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {editing ? (
          <PrinterForm
            initial={editing === 'new' ? undefined : editing}
            currencySymbol={currencySymbol}
            isSaving={saveMutation.isPending}
            onSubmit={(data) => saveMutation.mutate(data)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div className="space-y-3">
            <SearchBox value={search} onChange={setSearch} className="sm:max-w-xs" />
            {visible.length === 0 ? (
              <p className="text-sm text-bambu-gray text-center py-6">{t('calculator.noMatches')}</p>
            ) : (
              <div className="overflow-x-auto -mx-6 px-6">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-bambu-dark-tertiary">
                      <SortHeader label={t('calculator.name')} active={sortKey === 'name'} dir={sortDir} onClick={() => toggleSort('name')} align="left" />
                      <SortHeader label={t('calculator.purchasePrice', { currency: currencySymbol })} active={sortKey === 'purchase'} dir={sortDir} onClick={() => toggleSort('purchase')} />
                      <SortHeader label={t('calculator.powerWatts')} active={sortKey === 'power'} dir={sortDir} onClick={() => toggleSort('power')} />
                      <SortHeader label={t('calculator.dailyUsage')} active={sortKey === 'daily'} dir={sortDir} onClick={() => toggleSort('daily')} />
                      <SortHeader label={t('calculator.lifetimeHours')} active={sortKey === 'lifetime'} dir={sortDir} onClick={() => toggleSort('lifetime')} />
                      <SortHeader label={t('calculator.depreciationPerHour')} active={sortKey === 'depreciation'} dir={sortDir} onClick={() => toggleSort('depreciation')} />
                      <SortHeader label={t('calculator.repairsPerHour')} active={sortKey === 'repairs'} dir={sortDir} onClick={() => toggleSort('repairs')} />
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((p) => (
                      <tr key={p.id} className="border-b border-bambu-dark-tertiary/50 last:border-b-0 hover:bg-bambu-dark-tertiary/30 transition-colors">
                        <td className={`${tdCls} text-white`}>
                          {p.name}
                          {p.id === selectedPrinterId && (
                            <span className="ml-2 text-xs text-bambu-green" title={t('calculator.inUse')}>●</span>
                          )}
                        </td>
                        <td className={`${tdCls} text-right text-bambu-gray-light tabular-nums`}>{formatMoney(p.purchase_price, currency, false)}</td>
                        <td className={`${tdCls} text-right text-bambu-gray-light tabular-nums`}>{p.power_watts.toLocaleString()}</td>
                        <td className={`${tdCls} text-right text-bambu-gray-light tabular-nums`}>{p.daily_usage_hours.toLocaleString()}</td>
                        <td className={`${tdCls} text-right text-bambu-gray-light tabular-nums`}>{Math.round(printerLifetimeHours(p)).toLocaleString()}</td>
                        <td className={`${tdCls} text-right text-bambu-gray-light tabular-nums`}>{printerDepreciationPerHour(p).toFixed(2)}</td>
                        <td className={`${tdCls} text-right text-bambu-gray-light tabular-nums`}>{printerRepairsPerHour(p).toFixed(2)}</td>
                        <td className={`${tdCls} text-right`}>
                          <div className="flex gap-1 justify-end">
                            <Button variant="ghost" size="sm" onClick={() => setEditing(p)} aria-label={t('calculator.editPrinter')}>
                              <Pencil className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setToDelete(p)}
                              disabled={p.id === selectedPrinterId}
                              title={p.id === selectedPrinterId ? t('calculator.inUse') : undefined}
                              aria-label={t('calculator.deletePrinterTitle')}
                            >
                              <Trash2 className="w-4 h-4 text-status-error" />
                            </Button>
                          </div>
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
          title={t('calculator.deletePrinterTitle')}
          message={t('calculator.deletePrinterMessage', { name: toDelete.name })}
          variant="danger"
          isLoading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(toDelete.id)}
          onCancel={() => setToDelete(null)}
        />
      )}
    </Card>
  );
}

type DefaultsField = { key: keyof Omit<CalculatorDefaults, 'id' | 'updated_at'>; labelKey: string };

const DEFAULTS_FIELDS_GENERAL: DefaultsField[] = [
  { key: 'electricity_tariff', labelKey: 'calculator.electricityTariff' },
  { key: 'labor_rate_per_hour', labelKey: 'calculator.laborRate' },
  { key: 'consumables_packaging_flat', labelKey: 'calculator.consumablesFlat' },
  { key: 'base_fee_flat', labelKey: 'calculator.baseFee' },
  { key: 'failure_rate_pct', labelKey: 'calculator.failureRate' },
  { key: 'prototype_rate_pct', labelKey: 'calculator.prototypeRate' },
  { key: 'ads_rate_pct', labelKey: 'calculator.adsRate' },
  { key: 'filament_markup_pct', labelKey: 'calculator.filamentMarkup' },
  { key: 'global_markup_pct', labelKey: 'calculator.globalMarkup' },
  { key: 'tax_pct', labelKey: 'calculator.taxPct' },
  { key: 'stuff_markup_pct', labelKey: 'calculator.stuffMarkup' },
];

// Prefill values for new filament profiles — shown in their own card.
const DEFAULTS_FIELDS_FILAMENT: DefaultsField[] = [
  { key: 'default_difficulty_pct', labelKey: 'calculator.defaultDifficulty' },
  { key: 'default_margin_over_cost_pct', labelKey: 'calculator.defaultMargin' },
];

const DEFAULTS_FIELDS: DefaultsField[] = [...DEFAULTS_FIELDS_GENERAL, ...DEFAULTS_FIELDS_FILAMENT];

function DefaultsForm({ defaults, currencySymbol }: { defaults: CalculatorDefaults; currencySymbol: string }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries(DEFAULTS_FIELDS.map(({ key }) => [key, String(defaults[key])])),
  );

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, number> = {};
      for (const { key } of DEFAULTS_FIELDS) {
        const n = parseNum(form[key]);
        if (n !== null) payload[key] = n;
      }
      return api.updateCalculatorDefaults(payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calculatorDefaults'] });
      showToast(t('calculator.defaultsSaved'));
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  const allValid = DEFAULTS_FIELDS.every(({ key }) => {
    const n = parseNum(form[key]);
    return n !== null && n >= 0;
  });

  const renderFields = (fields: DefaultsField[]) => (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {fields.map(({ key, labelKey }) => (
        <NumberField
          key={key}
          id={`calc-def-${key}`}
          label={t(labelKey, { currency: currencySymbol })}
          value={form[key]}
          onChange={(v) => setForm((f) => ({ ...f, [key]: v }))}
          required
        />
      ))}
    </div>
  );

  return (
    <form
      autoComplete="off"
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (allValid) saveMutation.mutate();
      }}
    >
      <Card className="animate-calc-rise">
        <CardHeader>
          <h2 className="font-semibold text-white">{t('calculator.tabDefaults')}</h2>
          <p className="text-sm text-bambu-gray mt-1">{t('calculator.defaultsHint')}</p>
        </CardHeader>
        <CardContent>{renderFields(DEFAULTS_FIELDS_GENERAL)}</CardContent>
      </Card>
      <Card className="animate-calc-rise" style={{ animationDelay: '50ms' }}>
        <CardHeader>
          <h2 className="font-semibold text-white">{t('calculator.filamentSettings')}</h2>
          <p className="text-sm text-bambu-gray mt-1">{t('calculator.filamentSettingsHint')}</p>
        </CardHeader>
        <CardContent>{renderFields(DEFAULTS_FIELDS_FILAMENT)}</CardContent>
      </Card>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!allValid || saveMutation.isPending}>
          {saveMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          {t('calculator.saveDefaults')}
        </Button>
      </div>
    </form>
  );
}

export function CalculatorDefaultsPanel() {
  const { data: defaults } = useQuery({
    queryKey: ['calculatorDefaults'],
    queryFn: api.getCalculatorDefaults,
    staleTime: 60_000,
  });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const currencySymbol = getCurrencySymbol(settings?.currency || 'USD');

  return (
    <div className="max-w-4xl">
      {defaults ? (
        <DefaultsForm key={defaults.updated_at} defaults={defaults} currencySymbol={currencySymbol} />
      ) : (
        <Card className="animate-calc-rise">
          <CardContent>
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 text-bambu-green animate-spin" />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
