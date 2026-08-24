// Printer profile tab of the calculator settings: a searchable, sortable
// listing plus the add/edit form. Split out of the former
// CalculatorSettingsPanels.tsx (T-078).

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, type CalculatorPrinter, type CalculatorPrinterCreate } from '../../api/client';
import { Button } from '../Button';
import { Card, CardContent, CardHeader } from '../Card';
import { ConfirmModal } from '../ConfirmModal';
import { NumberField } from '../NumberField';
import { inputCls, labelCls } from '../formStyles';
import {
  formatMoney,
  printerDepreciationPerHour,
  printerLifetimeHours,
  printerRepairsPerHour,
} from '../../utils/pricing';
import { getCurrencySymbol } from '../../utils/currency';
import { parseNum, settingsTdCls, useEntityCrudMutations, useSortToggle } from './calculatorSettingsShared';
import { SortHeader, SearchBox, CountBadge, NoMatches } from './CalculatorPanelParts';

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

export function CalculatorPrintersPanel({
  selectedPrinterId,
  canUpdate,
}: {
  selectedPrinterId: number | null;
  /** Gates the add/edit/delete controls; the searchable, sortable listing
   *  itself stays visible regardless (mirrors backend read/write split —
   *  Permission.CALCULATOR_UPDATE only guards create/update/delete). */
  canUpdate: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<CalculatorPrinter | 'new' | null>(null);
  const [toDelete, setToDelete] = useState<CalculatorPrinter | null>(null);
  const [search, setSearch] = useState('');
  const { sortKey, sortDir, toggleSort } = useSortToggle<PrinterSortKey>('name');

  const { data: printers = [] } = useQuery({
    queryKey: ['calculatorPrinters'],
    queryFn: api.getCalculatorPrinters,
    staleTime: 60_000,
  });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const currency = settings?.currency || 'USD';
  const currencySymbol = getCurrencySymbol(currency);

  const { saveMutation, deleteMutation } = useEntityCrudMutations<CalculatorPrinter, CalculatorPrinterCreate>({
    queryKey: ['calculatorPrinters'],
    editing,
    create: api.createCalculatorPrinter,
    update: api.updateCalculatorPrinter,
    remove: api.deleteCalculatorPrinter,
    createdMsg: 'calculator.printerCreated',
    updatedMsg: 'calculator.printerUpdated',
    deletedMsg: 'calculator.printerDeleted',
    onSaved: () => setEditing(null),
    onDeleted: () => setToDelete(null),
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

  return (
    <Card className="animate-calc-rise">
      <CardHeader className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-white">
          {t('calculator.tabPrinters')}
          <CountBadge visible={visible.length} total={printers.length} />
        </h2>
        {!editing && canUpdate && (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="w-4 h-4" />
            {t('calculator.addPrinter')}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {editing && canUpdate ? (
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
              <NoMatches />
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
                        <td className={`${settingsTdCls} text-white`}>
                          {p.name}
                          {p.id === selectedPrinterId && (
                            <span className="ml-2 text-xs text-bambu-green" title={t('calculator.inUse')}>●</span>
                          )}
                        </td>
                        <td className={`${settingsTdCls} text-right text-bambu-gray-light tabular-nums`}>{formatMoney(p.purchase_price, currency, false)}</td>
                        <td className={`${settingsTdCls} text-right text-bambu-gray-light tabular-nums`}>{p.power_watts.toLocaleString()}</td>
                        <td className={`${settingsTdCls} text-right text-bambu-gray-light tabular-nums`}>{p.daily_usage_hours.toLocaleString()}</td>
                        <td className={`${settingsTdCls} text-right text-bambu-gray-light tabular-nums`}>{Math.round(printerLifetimeHours(p)).toLocaleString()}</td>
                        <td className={`${settingsTdCls} text-right text-bambu-gray-light tabular-nums`}>{printerDepreciationPerHour(p).toFixed(2)}</td>
                        <td className={`${settingsTdCls} text-right text-bambu-gray-light tabular-nums`}>{printerRepairsPerHour(p).toFixed(2)}</td>
                        <td className={`${settingsTdCls} text-right`}>
                          {canUpdate && (
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
