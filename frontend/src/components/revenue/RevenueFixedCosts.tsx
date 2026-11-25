import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { bearerAuthHeaders } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { focusRingCls } from '../formStyles';
import { RevenueClosablePanel } from './RevenueClosablePanel';
import { failureMessage, readJsonBody } from './lib/dashboard';
import { formatFcp, formatPerMinute } from './lib/format';
import type { FixedCost } from './lib/types';

const URL = '/api/v1/revenue/fixed-costs';
const INPUT = `w-full rounded-md border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1 text-sm text-white read-only:opacity-60 ${focusRingCls}`;
// The server's bounds (routes/revenue.py FixedCost).
const valid = (c: FixedCost) => c.label.trim() !== '' && c.label.length <= 80 && c.monthly >= 0 && c.monthly <= 1e9;

/** Monthly charges that do not move with sales, typed by hand (3D share only); the whole list is saved at once. */
export function RevenueFixedCosts({ canManage, onChanged, onClose, returnFocus }: {
  canManage: boolean;
  onChanged: () => void;
  onClose: () => void;
  returnFocus: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [rows, setRows] = useState<FixedCost[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(URL, { headers: bearerAuthHeaders() });
      const body = await readJsonBody(res);
      if (!res.ok) throw new Error(failureMessage(res.status, body));
      setRows((body as { costs: FixedCost[] }).costs);
      setDirty(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const edit = (i: number, patch: Partial<FixedCost>) => {
    setRows((r) => r && r.map((c, j) => (j === i ? { ...c, ...patch } : c)));
    setDirty(true);
  };

  const save = async () => {
    if (!rows || busy) return;
    setBusy(true);
    try {
      const res = await fetch(URL, {
        method: 'PUT',
        headers: { ...bearerAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ costs: rows }),
      }).catch(() => null);
      if (!res) throw new Error(t('revenue.fixedCosts.failed'));
      const body = await readJsonBody(res);
      if (!res.ok) throw new Error(failureMessage(res.status, body));
      setRows((body as { costs: FixedCost[] }).costs);
      setDirty(false);
      showToast(t('revenue.fixedCosts.saved'), 'success');
      onChanged();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const allValid = rows?.every(valid) ?? false;
  const total = rows?.reduce((s, c) => s + c.monthly, 0) ?? 0;

  return (
    <RevenueClosablePanel
      title={t('revenue.fixedCosts.title')}
      onClose={onClose}
      returnFocus={returnFocus}
      action={
        canManage && rows ? (
          <>
            <button type="button" disabled={busy} onClick={() => { setRows([...rows, { label: '', monthly: 0 }]); setDirty(true); }}
              className={`text-xs text-bambu-gray-light underline underline-offset-2 hover:text-white disabled:opacity-40 ${focusRingCls}`}>
              {t('revenue.fixedCosts.add')}
            </button>
            <button type="button" disabled={!dirty || !allValid || busy} onClick={() => void save()}
              className={`rounded-md bg-bambu-green px-3 py-1 text-sm text-white disabled:opacity-40 ${focusRingCls}`}>
              {busy ? '…' : t('revenue.fixedCosts.save')}
            </button>
          </>
        ) : null
      }
    >
      <p className="mb-2 text-xs text-bambu-gray">{t('revenue.fixedCosts.intro')}</p>
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
        <p className="text-sm text-bambu-gray">{t('revenue.fixedCosts.empty')}</p>
      ) : (
        <div className="max-w-xl space-y-1">
          {rows.map((c, i) => {
            const label = c.label || String(i + 1);
            return (
              <div key={i} className="flex items-center gap-2">
                <input aria-label={t('revenue.fixedCosts.label')} readOnly={!canManage || busy} value={c.label} maxLength={80}
                  aria-invalid={c.label.trim() === '' || undefined} className={INPUT} onChange={(e) => edit(i, { label: e.target.value })} />
                <input type="number" min={0} max={1e9} aria-label={`${t('revenue.fixedCosts.monthly')} · ${label}`} readOnly={!canManage || busy}
                  value={c.monthly} className={`${INPUT} max-w-36 text-right tabular-nums`}
                  onChange={(e) => edit(i, { monthly: e.target.value === '' ? 0 : Number(e.target.value) })} />
                {canManage && (
                  <button type="button" disabled={busy} aria-label={`${t('revenue.fixedCosts.remove')} · ${label}`} title={t('revenue.fixedCosts.remove')}
                    onClick={() => { setRows(rows.filter((_, j) => j !== i)); setDirty(true); }}
                    className={`rounded p-1 text-bambu-gray hover:text-red-400 disabled:opacity-40 ${focusRingCls}`}>
                    <Trash2 aria-hidden className="h-4 w-4" />
                  </button>
                )}
              </div>
            );
          })}
          <p className="flex justify-between pt-1 text-sm text-bambu-gray-light">
            <span>{t('revenue.fixedCosts.total')}</span>
            <span className="tabular-nums"><span>{formatFcp(total)}</span> · <span>{formatPerMinute(total)}</span></span>
          </p>
          {!allValid && <p role="alert" className="text-xs text-red-400">{t('revenue.fixedCosts.invalid')}</p>}
        </div>
      )}
    </RevenueClosablePanel>
  );
}
