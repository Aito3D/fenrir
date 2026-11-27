import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { bearerAuthHeaders } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { focusRingCls } from '../formStyles';
import { CHARGES_CARD, CHARGES_TH, RevenueChargesSection } from './RevenueChargesSection';
import { failureMessage, readJsonBody } from './lib/dashboard';
import { formatFcp } from './lib/format';

export interface LaborProvider {
  name: string;
  hourlyRate: number;
  hoursPerDay: number;
  daysPerWeek: number;
  since: string | null;
}

const INPUT = `w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2.5 py-1.5 text-sm text-white read-only:opacity-60 ${focusRingCls}`;
const BLANK: LaborProvider = { name: '', hourlyRate: 0, hoursPerDay: 8, daysPerWeek: 5, since: null };
// The server's bounds (routes/revenue.py LaborProvider).
const valid = (p: LaborProvider) =>
  p.name.trim() !== '' && p.name.length <= 100 && p.hourlyRate >= 0 && p.hourlyRate <= 1e7 &&
  p.hoursPerDay >= 0 && p.hoursPerDay <= 24 && Number.isInteger(p.daysPerWeek) && p.daysPerWeek >= 1 && p.daysPerWeek <= 7;
const daily = (p: LaborProvider) => p.hourlyRate * p.hoursPerDay;
// 52 weeks / 12 months.
const monthly = (p: LaborProvider) => (daily(p) * p.daysPerWeek * 52) / 12;

/**
 * Staff and contractors whose time (modelling, 3D scans, finishing…) the services' margin deducts:
 * each costs rate × hours on its first « days per week » weekdays, from its start date (or from when
 * print costs begin). The whole list is saved at once.
 */
export function RevenueLabor({ canManage, onChanged, footer }: {
  canManage: boolean;
  onChanged: () => void;
  /** The dialog's footer, for the unsaved-changes bar. */
  footer?: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [rows, setRows] = useState<LaborProvider[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/revenue/labor', { headers: bearerAuthHeaders() });
      const body = await readJsonBody(res);
      if (!res.ok) throw new Error(failureMessage(res.status, body));
      setRows((body as { providers: LaborProvider[] }).providers);
      setDirty(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const edit = (i: number, patch: Partial<LaborProvider>) => {
    setRows((r) => r && r.map((p, j) => (j === i ? { ...p, ...patch } : p)));
    setDirty(true);
  };
  const num = (v: string) => (v === '' ? 0 : Number(v));

  const save = async () => {
    if (!rows || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/v1/revenue/labor', {
        method: 'PUT',
        headers: { ...bearerAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: rows }),
      }).catch(() => null);
      if (!res) throw new Error(t('revenue.labor.failed'));
      const body = await readJsonBody(res);
      if (!res.ok) throw new Error(failureMessage(res.status, body));
      setRows((body as { providers: LaborProvider[] }).providers);
      setDirty(false);
      showToast(t('revenue.labor.saved'), 'success');
      onChanged();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const allValid = rows?.every(valid) ?? false;
  const totalMonthly = rows?.reduce((s, p) => s + monthly(p), 0) ?? 0;

  return (
    <RevenueChargesSection
      title={t('revenue.labor.title')}
      intro={t('revenue.labor.intro')}
      footer={footer}
      save={canManage && rows ? { dirty, busy, invalid: !allValid, onSave: () => void save(), onDiscard: () => void load() } : undefined}
      action={
        canManage && rows ? (
          <button type="button" disabled={busy} onClick={() => { setRows([...rows, BLANK]); setDirty(true); }}
            className={`inline-flex items-center gap-1.5 rounded-lg border border-bambu-dark-tertiary px-3 py-1.5 text-sm font-medium text-bambu-gray-light hover:text-white disabled:opacity-40 ${focusRingCls}`}>
            <Plus aria-hidden className="h-4 w-4" />
            {t('revenue.labor.add')}
          </button>
        ) : null
      }
    >
      {error && (
        <p role="alert" className="mb-2 text-sm text-red-400">
          {error}{' '}
          <button type="button" className={`ml-2 underline underline-offset-2 ${focusRingCls}`} onClick={() => void load()}>
            {t('revenue.sync.retry')}
          </button>
        </p>
      )}
      {!rows ? (
        !error && <p className="text-sm text-bambu-gray">{t('revenue.state.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-bambu-gray">{t('revenue.labor.empty')}</p>
      ) : (
        <>
        <div className={CHARGES_CARD}>
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr>
                <th scope="col" className={`${CHARGES_TH} text-left`}>{t('revenue.labor.name')}</th>
                <th scope="col" className={`${CHARGES_TH} text-right`}>{t('revenue.labor.hourlyRate')}</th>
                <th scope="col" className={`${CHARGES_TH} text-right`}>{t('revenue.labor.hoursPerDay')}</th>
                <th scope="col" className={`${CHARGES_TH} text-right`}>{t('revenue.labor.daysPerWeek')}</th>
                <th scope="col" className={`${CHARGES_TH} text-left`}>{t('revenue.labor.since')}</th>
                <th scope="col" className={`${CHARGES_TH} text-right`}>{t('revenue.labor.monthly')}</th>
                {canManage && <th scope="col" className={CHARGES_TH}><span className="sr-only">{t('revenue.labor.remove')}</span></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => {
                const label = p.name || String(i + 1);
                return (
                  <tr key={i} className="border-b border-bambu-dark-tertiary">
                    <td className="px-3 py-2">
                      <input aria-label={t('revenue.labor.name')} readOnly={!canManage || busy} value={p.name} maxLength={100}
                        aria-invalid={p.name.trim() === '' || undefined}
                        className={INPUT} onChange={(e) => edit(i, { name: e.target.value })} />
                    </td>
                    <td className="w-32 px-3 py-2">
                      <input type="number" min={0} max={1e7} aria-label={`${t('revenue.labor.hourlyRate')} · ${label}`} readOnly={!canManage || busy}
                        value={p.hourlyRate} className={`${INPUT} text-right tabular-nums`} onChange={(e) => edit(i, { hourlyRate: num(e.target.value) })} />
                    </td>
                    <td className="w-24 px-3 py-2">
                      <input type="number" min={0} max={24} step={0.5} aria-label={`${t('revenue.labor.hoursPerDay')} · ${label}`} readOnly={!canManage || busy}
                        value={p.hoursPerDay} className={`${INPUT} text-right tabular-nums`} onChange={(e) => edit(i, { hoursPerDay: num(e.target.value) })} />
                    </td>
                    <td className="w-24 px-3 py-2">
                      <input type="number" min={1} max={7} step={1} aria-label={`${t('revenue.labor.daysPerWeek')} · ${label}`} readOnly={!canManage || busy}
                        value={p.daysPerWeek} className={`${INPUT} text-right tabular-nums`} onChange={(e) => edit(i, { daysPerWeek: num(e.target.value) })} />
                    </td>
                    <td className="w-40 px-3 py-2">
                      <input type="date" aria-label={`${t('revenue.labor.since')} · ${label}`} readOnly={!canManage || busy}
                        value={p.since ?? ''} className={INPUT} onChange={(e) => edit(i, { since: e.target.value || null })} />
                    </td>
                    <td className={`whitespace-nowrap px-3 py-2 text-right tabular-nums text-white`}>
                      {formatFcp(monthly(p))}
                    </td>
                    {canManage && (
                      <td className="px-3 py-2 text-right">
                        <button type="button" disabled={busy} aria-label={`${t('revenue.labor.remove')} · ${label}`} title={t('revenue.labor.remove')}
                          onClick={() => { setRows(rows.filter((_, j) => j !== i)); setDirty(true); }}
                          className={`rounded p-1 text-bambu-gray hover:text-red-400 disabled:opacity-40 ${focusRingCls}`}>
                          <Trash2 aria-hidden className="h-4 w-4" />
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="font-semibold text-white">
              <tr>
                <td className="px-3 py-3" colSpan={5}>{t('revenue.labor.total')}</td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{formatFcp(totalMonthly)}</td>
                {canManage && <td />}
              </tr>
            </tfoot>
          </table>
        </div>
        {!allValid && <p role="alert" className="mt-2 text-xs text-red-400">{t('revenue.labor.invalid')}</p>}
        </>
      )}
    </RevenueChargesSection>
  );
}
