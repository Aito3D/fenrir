import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { bearerAuthHeaders } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { focusRingCls } from '../formStyles';
import { CHARGES_CARD, CHARGES_LINK, CHARGES_TH, RevenueChargesSection } from './RevenueChargesSection';
import { failureMessage, readJsonBody } from './lib/dashboard';
import { rowCharge, totals } from './lib/fixedAccounts';
import { formatFcp, formatPerMinute } from './lib/format';
import type { FixedAccount, FixedAccountType, FixedAccountsResponse } from './lib/types';

const URL = '/api/v1/revenue/fixed-accounts';
const FIELD = `rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-2.5 py-1.5 text-sm text-white read-only:opacity-60 disabled:opacity-60 ${focusRingCls}`;
const TYPES: FixedAccountType[] = ['monthly', 'annual', 'one_off'];
const TYPE_KEY = { monthly: 'typeMonthly', annual: 'typeAnnual', one_off: 'typeOneOff' } as const;
const FLAG_KEY = { purchases: 'flagPurchases', staff: 'flagStaff', depreciation: 'flagDepreciation' } as const;
// The server's bounds (routes/revenue.py FixedAccountShare).
const valid = (a: FixedAccount) => a.percent >= 0 && a.percent <= 100;
const estimatedFcp = (n: number) => `≈ ${formatFcp(n)}`;

/** Zoho's expense accounts: the share of each that is 3D printing's, its type and its goods/services split. */
export function RevenueFixedAccounts({ canManage, onChanged, footer }: {
  canManage: boolean;
  onChanged: () => void;
  /** The dialog's footer, for the unsaved-changes bar. */
  footer?: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [state, setState] = useState<FixedAccountsResponse | null>(null);
  const [rows, setRows] = useState<FixedAccount[]>([]);
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState('');
  const [showIdle, setShowIdle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; retry: () => void } | null>(null);

  const call = useCallback(async (url: string, init?: RequestInit) => {
    const res = await fetch(url, { ...init, headers: { ...bearerAuthHeaders(), ...init?.headers } });
    const body = await readJsonBody(res);
    if (!res.ok) throw new Error(failureMessage(res.status, body));
    const next = body as FixedAccountsResponse;
    setState(next);
    setRows(next.accounts);
    setDirty(false);
    setError(null);
  }, []);

  const load = useCallback(async () => {
    try {
      await call(URL);
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e), retry: () => void load() });
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    setBusy(true);
    try {
      await call(`${URL}/refresh?scope=all`, { method: 'POST' });
      onChanged();
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e), retry: () => void refresh() });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const accounts = Object.fromEntries(
        rows.filter((a) => a.percent > 0).map((a) => [a.id, { percent: a.percent, type: a.type, goodsShare: a.goodsShare }]),
      );
      await call(URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accounts }) });
      showToast(t('revenue.fixedCosts.saved'), 'success');
      onChanged();
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('revenue.fixedCosts.failed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const edit = (id: string, patch: Partial<FixedAccount>) => {
    setRows((r) => r.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    setDirty(true);
  };

  const locked = !canManage || busy;
  const allValid = rows.every(valid);
  const sum = totals(rows.filter(valid));
  const total = sum.real + sum.estimated;
  // Grouped on the stored share, so a row does not jump while its share is being typed.
  const stored = new Map(state?.accounts.map((a) => [a.id, a.percent]));
  const q = query.trim().toLowerCase();
  const shown = rows.filter((a) => !q || `${a.code} ${a.name}`.toLowerCase().includes(q));
  const counted = shown.filter((a) => (stored.get(a.id) ?? 0) > 0);
  const idle = shown.filter((a) => !((stored.get(a.id) ?? 0) > 0));
  const goods = t('revenue.filters.goods');
  const services = t('revenue.filters.services');

  return (
    <RevenueChargesSection
      title={t('revenue.fixedCosts.title')}
      intro={t('revenue.fixedCosts.intro')}
      footer={footer}
      save={canManage && state ? { dirty, busy, invalid: !allValid, onSave: () => void save(), onDiscard: () => void load() } : undefined}
      action={
        <>
          {state?.readAt && <span className="text-xs text-bambu-gray">{t('revenue.depreciation.readAt', { date: new Date(state.readAt).toLocaleString() })}</span>}
          {canManage && state && (
            // A refresh replaces the shares on screen with the stored ones: unsaved edits go first.
            <button type="button" disabled={busy || dirty} onClick={() => void refresh()} className={CHARGES_LINK}>
              {t('revenue.depreciation.refresh')}
            </button>
          )}
          {rows.length > 0 && (
            <input type="search" value={query} placeholder={t('revenue.fixedCosts.search')} aria-label={t('revenue.fixedCosts.search')}
              className={`${FIELD} w-56 max-w-full`} onChange={(e) => setQuery(e.target.value)} />
          )}
        </>
      }
    >
      {error && (
        <p role="alert" className="mb-2 text-sm text-red-400">
          {error.message}{' '}
          <button type="button" className={`ml-2 underline underline-offset-2 ${focusRingCls}`} onClick={error.retry}>
            {t('revenue.sync.retry')}
          </button>
        </p>
      )}
      {!state ? (
        !error && <p className="text-sm text-bambu-gray">{t('revenue.state.loading')}</p>
      ) : rows.length === 0 ? (
        !busy && <p className="text-sm text-bambu-gray">{t('revenue.fixedCosts.empty')}</p>
      ) : (
        <>
          <div className={`${CHARGES_CARD} text-sm`}>
            <table className="w-full min-w-[60rem] tabular-nums">
              <thead>
                <tr>
                  <th scope="col" className={`${CHARGES_TH} text-left`}>{t('revenue.fixedCosts.colAccount')}</th>
                  <th scope="col" className={`${CHARGES_TH} text-right`}>{t('revenue.fixedCosts.colMonth')}</th>
                  <th scope="col" className={`${CHARGES_TH} text-right`}>{t('revenue.fixedCosts.colYear')}</th>
                  <th scope="col" className={`${CHARGES_TH} text-right`}>{t('revenue.fixedCosts.colShare')}</th>
                  <th scope="col" className={`${CHARGES_TH} text-left`}>{t('revenue.fixedCosts.colType')}</th>
                  <th scope="col" className={`${CHARGES_TH} text-left`}>{goods} / {services}</th>
                  <th scope="col" className={`${CHARGES_TH} text-right`}>{t('revenue.fixedCosts.colCharge')}</th>
                </tr>
              </thead>
              <tbody>
                {[...counted, ...(showIdle || q ? idle : [])].map((a) => {
                  const on = a.percent > 0 && valid(a);
                  const { real, estimated } = rowCharge(a);
                  return (
                    <tr key={a.id} className={`border-b border-bambu-dark-tertiary hover:bg-bambu-dark/30 ${on ? 'text-bambu-gray-light' : 'text-bambu-gray'}`}>
                      <td className="max-w-80 truncate px-3 py-2" title={a.name}>
                        <span className="mr-2.5 font-mono text-xs text-bambu-gray">{a.code}</span>
                        <span className={on ? 'text-white' : undefined}>{a.name}</span>
                        {!a.active && <span className="ml-2 text-xs">({t('revenue.depreciation.inactive')})</span>}
                        {a.flag && (
                          <span role="img" aria-label={t(`revenue.fixedCosts.${FLAG_KEY[a.flag]}`)} title={t(`revenue.fixedCosts.${FLAG_KEY[a.flag]}`)}
                            className="ml-2 cursor-help text-amber-400">⚠</span>
                        )}
                      </td>
                      <td className={`whitespace-nowrap px-3 py-2 text-right ${on ? 'text-white' : ''}`}>{formatFcp(a.month)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right text-bambu-gray">{formatFcp(a.year)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-right text-bambu-gray">
                        <input type="number" min={0} max={100} step="any" placeholder="0" readOnly={locked}
                          aria-label={`${t('revenue.fixedCosts.colShare')} · ${a.name}`} aria-invalid={!valid(a) || undefined}
                          value={a.percent || ''} className={`${FIELD} mr-1.5 w-[4.5rem] text-right`}
                          onChange={(e) => edit(a.id, { percent: e.target.value === '' ? 0 : Number(e.target.value) })} />
                        %
                      </td>
                      <td className="px-3 py-2">
                        {on && (
                          <select aria-label={`${t('revenue.fixedCosts.colType')} · ${a.name}`} disabled={locked} value={a.type} className={FIELD}
                            onChange={(e) => edit(a.id, { type: e.target.value as FixedAccountType })}>
                            {TYPES.map((type) => <option key={type} value={type}>{t(`revenue.fixedCosts.${TYPE_KEY[type]}`)}</option>)}
                          </select>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {on && (
                          <span className="inline-flex items-center gap-2.5 text-xs">
                            {/* The thumb moves towards the services: its value is their share. */}
                            <input type="range" min={0} max={100} step={5} disabled={locked} value={100 - a.goodsShare}
                              aria-label={`${t('revenue.fixedCosts.splitLabel')} · ${a.name}`}
                              aria-valuetext={`${goods} ${a.goodsShare} %, ${services} ${100 - a.goodsShare} %`}
                              className="w-28 accent-bambu-green" onChange={(e) => edit(a.id, { goodsShare: 100 - Number(e.target.value) })} />
                            <span className="w-14" title={`${goods} / ${services}`}>{a.goodsShare} / {100 - a.goodsShare}</span>
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        {on ? (
                          <>
                            <span className={`font-semibold ${estimated ? 'text-amber-400' : 'text-white'}`}>{estimated ? estimatedFcp(real + estimated) : formatFcp(real)}</span>
                            {estimated > 0 && <span className="block text-[11px] text-amber-400/80">{t('revenue.fixedCosts.hintEstimated', { amount: formatFcp(estimated) })}</span>}
                            {a.type === 'annual' && <span className="block text-[11px] text-bambu-gray">{t('revenue.fixedCosts.hintYear')}</span>}
                          </>
                        ) : '—'}
                      </td>
                    </tr>
                  );
                })}
                {idle.length > 0 && !q && (
                  <tr className="border-b border-bambu-dark-tertiary">
                    <td colSpan={7} className="px-3 py-2">
                      <button type="button" aria-expanded={showIdle} onClick={() => setShowIdle(!showIdle)}
                        className={`inline-flex items-center gap-1.5 text-[13px] text-bambu-gray hover:text-white ${focusRingCls}`}>
                        <ChevronRight aria-hidden className={`h-3.5 w-3.5 transition-transform ${showIdle ? 'rotate-90' : ''}`} />
                        {t('revenue.fixedCosts.notCounted', { n: idle.length })}
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <dl className="flex flex-wrap gap-x-8 gap-y-2 px-3 py-3">
              {([
                ['footReal', formatFcp(sum.real), ''],
                ['footEstimated', estimatedFcp(sum.estimated), 'text-amber-400'],
                ['total', formatFcp(total), ''],
                ['perMinute', formatPerMinute(total), ''],
              ] as const).map(([key, value, cls]) => (
                <div key={key}>
                  <dt className={`text-xs ${cls || 'text-bambu-gray'}`}>{t(`revenue.fixedCosts.${key}`)}</dt>
                  <dd className={`tabular-nums ${cls || 'text-white'} ${key === 'total' ? 'font-semibold' : ''}`}>{value}</dd>
                </div>
              ))}
              <div><dt className="text-xs text-bambu-gray">{goods}</dt><dd className="tabular-nums text-white">{formatFcp(sum.goods)}</dd></div>
              <div><dt className="text-xs text-bambu-gray">{services}</dt><dd className="tabular-nums text-white">{formatFcp(sum.services)}</dd></div>
            </dl>
          </div>
          {!allValid && <p role="alert" className="mt-2 text-xs text-red-400">{t('revenue.fixedCosts.invalid')}</p>}
        </>
      )}
    </RevenueChargesSection>
  );
}
