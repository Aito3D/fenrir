import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { bearerAuthHeaders } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { focusRingCls } from '../formStyles';
import { RevenueClosablePanel } from './RevenueClosablePanel';
import { failureMessage, readJsonBody } from './lib/dashboard';
import { formatFcp } from './lib/format';
import type { RevenueTarget, TargetsResponse } from './lib/types';

// The server's bounds (insights.parse_target_amount): whole francs, 0 to 10^12.
const MAX_AMOUNT = 1e12;
const GROUPED = new Intl.NumberFormat('fr-FR');
const INPUT = `w-full rounded-md border bg-bambu-dark px-2 py-1 text-right text-sm tabular-nums text-white read-only:opacity-60 ${focusRingCls}`;
const NAV = `rounded p-1 text-bambu-gray hover:text-white disabled:opacity-30 ${focusRingCls}`;

/** « 1 500 000 », « 1500000 FCP » → "1500000" (no leading zeros); "" when no digit. */
const digitsOnly = (s: string) => {
  const d = s.replace(/\D/g, '');
  return d === '' ? '' : BigInt(d).toString();
};
// BigInt: a pasted run of digits past 2^53 still groups as typed instead of rounding.
const grouped = (digits: string) => (digits === '' ? '' : GROUPED.format(BigInt(digits)));
const monthKey = (year: number, i: number) => `${year}-${String(i + 1).padStart(2, '0')}`;

/**
 * Monthly HT targets for the whole Aito3D book. Inputs are drafts until saved — per row (Enter or
 * « Enregistrer »), or every changed row with « Tout enregistrer » (sent one after the other). An
 * emptied input deletes that month's target. `actualByMonth` is null off the unfiltered month view.
 */
export function RevenueTargets({ canManage, onChanged, onClose, today, actualByMonth }: {
  canManage: boolean;
  onChanged: () => void;
  onClose: () => void;
  today: string;
  actualByMonth: Record<string, number> | null;
}) {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const thisYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [saved, setSaved] = useState<Record<string, number> | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // State lags a render behind: two Enters in one tick would both see busy=null.
  const inFlight = useRef(false);
  const invalidId = useId();

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/revenue/targets', { headers: bearerAuthHeaders() });
      const body = await readJsonBody(res);
      if (!res.ok) throw new Error(failureMessage(res.status, body));
      setSaved(Object.fromEntries((body as TargetsResponse).targets.map((x) => [x.month, x.amountHt])));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const monthName = new Intl.DateTimeFormat(i18n.language, { month: 'long', timeZone: 'UTC' });
  const months = Array.from({ length: 12 }, (_, i) => ({
    key: monthKey(year, i),
    name: monthName.format(Date.UTC(2000, i, 1)).replace(/^./, (c) => c.toUpperCase()),
  }));
  const savedText = (m: string) => (saved?.[m] != null ? String(saved[m]) : '');
  const valueOf = (m: string) => drafts[m] ?? savedText(m);
  const changed = (m: string) => drafts[m] !== undefined && drafts[m] !== savedText(m);
  const invalid = (m: string) => valueOf(m) !== '' && Number(valueOf(m)) > MAX_AMOUNT;

  /** Saves one month and takes the server's answer as the saved value; throws the server's message. */
  const saveMonth = async (m: string) => {
    const digits = valueOf(m);
    const url = `/api/v1/revenue/targets/${m}`;
    const res = await fetch(
      url,
      digits
        ? { method: 'PUT', headers: { ...bearerAuthHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ amountHt: Number(digits) }) }
        : { method: 'DELETE', headers: bearerAuthHeaders() },
    ).catch(() => null);
    // No response at all (network down): the browser's own message is not for the user.
    if (!res) throw new Error(t('revenue.targets.failed'));
    const body = await readJsonBody(res);
    if (!res.ok) throw new Error(failureMessage(res.status, body));
    const target = (body as { target?: RevenueTarget } | null)?.target;
    setSaved((s) => {
      const next = { ...s };
      if (digits) next[m] = target?.amountHt ?? Number(digits);
      else delete next[m];
      return next;
    });
    setDrafts((d) => {
      const next = { ...d };
      delete next[m];
      return next;
    });
  };

  const run = async (key: string, work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(key);
    try {
      await work();
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const saveOne = (m: string) =>
    run(m, async () => {
      try {
        await saveMonth(m);
        showToast(t('revenue.targets.saved', { month: m }), 'success');
        onChanged();
      } catch (e) {
        showToast(t('revenue.targets.failedOne', { month: m, error: e instanceof Error ? e.message : String(e) }), 'error');
      }
    });

  const saveAll = (todo: string[]) =>
    run('all', async () => {
      let done = 0;
      try {
        for (const m of todo) {
          await saveMonth(m);
          done++;
        }
        showToast(t('revenue.targets.savedAll', { n: done }), 'success');
      } catch (e) {
        showToast(t('revenue.targets.partial', { done, total: todo.length, error: e instanceof Error ? e.message : String(e) }), 'error');
      } finally {
        if (done > 0) onChanged();
      }
    });

  /** Fills this year's empty months with the first filled one (drafts only, filled months untouched). */
  const copyAcross = () => {
    const source = months.map((m) => valueOf(m.key)).find((v) => v !== '');
    if (!source) return;
    setDrafts((d) => {
      const next = { ...d };
      for (const m of months) if (valueOf(m.key) === '') next[m.key] = source;
      return next;
    });
  };

  const pending = months.filter((m) => changed(m.key)).map((m) => m.key);
  const anyInvalid = months.some((m) => invalid(m.key));
  const showActual = actualByMonth !== null;
  const yearTarget = months.reduce((s, m) => s + Number(valueOf(m.key) || 0), 0);
  const yearActual = months.reduce((s, m) => s + (actualByMonth?.[m.key] ?? 0), 0);
  const share = (target: number, actual: number | undefined) => (target > 0 && actual != null ? actual / target : null);
  const yearShare = share(yearTarget, yearActual);

  return (
    <RevenueClosablePanel
      title={t('revenue.targets.title')}
      onClose={onClose}
      action={
        <>
          <div className="flex items-center gap-1">
            <button type="button" aria-label={t('revenue.targets.prevYear')} title={t('revenue.targets.prevYear')} className={NAV}
              disabled={year <= thisYear - 1} onClick={() => setYear((y) => y - 1)}>
              <ChevronLeft aria-hidden className="h-4 w-4" />
            </button>
            <span className="tabular-nums text-sm text-white">{year}</span>
            <button type="button" aria-label={t('revenue.targets.nextYear')} title={t('revenue.targets.nextYear')} className={NAV}
              disabled={year >= thisYear + 1} onClick={() => setYear((y) => y + 1)}>
              <ChevronRight aria-hidden className="h-4 w-4" />
            </button>
          </div>
          {canManage && (
            <>
              <button type="button" className={`text-xs text-bambu-gray-light underline underline-offset-2 hover:text-white ${focusRingCls}`} onClick={copyAcross}>
                {t('revenue.targets.copyAcross')}
              </button>
              <button type="button" disabled={pending.length === 0 || anyInvalid || busy !== null} onClick={() => void saveAll(pending)}
                className={`rounded-md bg-bambu-green px-3 py-1 text-sm text-white disabled:opacity-40 ${focusRingCls}`}>
                {t('revenue.targets.saveAll')}{pending.length > 0 ? ` (${pending.length})` : ''}
              </button>
            </>
          )}
        </>
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
      {!saved ? (
        !error && <p className="text-sm text-bambu-gray">{t('revenue.state.loading')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-y-1 text-sm">
            <thead className="text-xs uppercase tracking-wide text-bambu-gray">
              <tr>
                <th className="px-3 py-1 text-left font-normal">{t('revenue.targets.month')}</th>
                <th className="px-3 py-1 text-right font-normal">{t('revenue.targets.target')}</th>
                {showActual && <th className="hidden px-3 py-1 text-right font-normal sm:table-cell">{t('revenue.targets.actual')}</th>}
                {showActual && <th className="px-3 py-1 text-right font-normal">{t('revenue.targets.reached')}</th>}
                {canManage && <th className="px-3 py-1"><span className="sr-only">{t('revenue.targets.save')}</span></th>}
              </tr>
            </thead>
            <tbody>
              {months.map(({ key: m, name }) => {
                const s = share(Number(valueOf(m) || 0), actualByMonth?.[m]);
                const bad = invalid(m);
                return (
                  <tr key={m} className="bg-bambu-dark">
                    <td className="whitespace-nowrap rounded-l-lg px-3 py-1.5 text-bambu-gray-light">{name}</td>
                    <td className={`w-44 px-3 py-1.5 text-right tabular-nums text-white ${canManage || showActual ? '' : 'rounded-r-lg'}`}>
                      {canManage ? (
                        <input type="text" inputMode="numeric" aria-label={t('revenue.targets.input', { month: name, year })} placeholder="—"
                          aria-invalid={bad || undefined} aria-describedby={bad ? invalidId : undefined} readOnly={busy !== null}
                          className={`${INPUT} ${bad ? 'border-red-500' : 'border-bambu-dark-tertiary'}`}
                          value={grouped(valueOf(m))}
                          onChange={(e) => setDrafts((d) => ({ ...d, [m]: digitsOnly(e.target.value) }))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && changed(m) && !bad) void saveOne(m);
                          }} />
                      ) : (
                        grouped(valueOf(m)) || '—'
                      )}
                    </td>
                    {showActual && (
                      <td className="hidden px-3 py-1.5 text-right tabular-nums text-bambu-gray-light sm:table-cell">
                        {actualByMonth[m] != null ? formatFcp(actualByMonth[m]) : '—'}
                      </td>
                    )}
                    {showActual && (
                      <td className={`px-3 py-1.5 text-right tabular-nums ${canManage ? '' : 'rounded-r-lg'} ${s == null ? 'text-bambu-gray' : s >= 1 ? 'text-status-ok' : 'text-bambu-gray-light'}`}>
                        {s == null ? '—' : `${Math.round(s * 100)} %`}
                      </td>
                    )}
                    {canManage && (
                      <td className="rounded-r-lg px-3 py-1.5 text-right">
                        <button type="button" disabled={!changed(m) || bad || busy !== null} onClick={() => void saveOne(m)}
                          className={`text-xs text-bambu-green underline underline-offset-2 disabled:invisible ${focusRingCls}`}>
                          {busy === m ? '…' : t('revenue.targets.save')}
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="text-bambu-gray-light">
              <tr>
                <td className="px-3 py-1.5">{t('revenue.targets.year')}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{yearTarget > 0 ? formatFcp(yearTarget) : '—'}</td>
                {showActual && <td className="hidden px-3 py-1.5 text-right tabular-nums sm:table-cell">{formatFcp(yearActual)}</td>}
                {showActual && <td className="px-3 py-1.5 text-right tabular-nums">{yearShare == null ? '—' : `${Math.round(yearShare * 100)} %`}</td>}
                {canManage && <td />}
              </tr>
            </tfoot>
          </table>
          {anyInvalid && <p id={invalidId} role="alert" className="mt-2 text-xs text-red-400">{t('revenue.targets.invalid')}</p>}
        </div>
      )}
    </RevenueClosablePanel>
  );
}
