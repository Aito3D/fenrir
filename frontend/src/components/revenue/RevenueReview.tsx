import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { bearerAuthHeaders } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { focusRingCls } from '../formStyles';
import { RevenueClosablePanel } from './RevenueClosablePanel';
import { failureMessage, readJsonBody, withId, withoutId } from './lib/dashboard';
import { formatFcp } from './lib/format';
import type { ReviewResponse } from './lib/types';

const BTN = `rounded-md border border-bambu-dark-tertiary px-2 py-0.5 text-xs hover:bg-bambu-dark-tertiary disabled:opacity-40 ${focusRingCls}`;

/** Items sold that match neither a 3D nature nor a 3D brand: include or exclude them from the revenue, or undo a decision. */
export function RevenueReview({ canManage, onChanged, onClose }: { canManage: boolean; onChanged: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [data, setData] = useState<ReviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [showDecided, setShowDecided] = useState(false);
  // State lags a render behind: a double click would see the item idle twice.
  const inFlight = useRef(new Set<string>());
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mySeq = ++seq.current;
    try {
      const res = await fetch('/api/v1/revenue/review', { headers: bearerAuthHeaders() });
      const body = await readJsonBody(res);
      if (mySeq !== seq.current) return;
      if (!res.ok) throw new Error(failureMessage(res.status, body));
      setData(body as ReviewResponse);
      setError(null);
    } catch (e) {
      if (mySeq === seq.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (itemId: string, included: boolean | null) => {
    if (inFlight.current.has(itemId)) return;
    inFlight.current.add(itemId);
    setBusy(withId(itemId));
    try {
      const url = `/api/v1/revenue/scope/${encodeURIComponent(itemId)}`;
      const init: RequestInit =
        included === null
          ? { method: 'DELETE', headers: bearerAuthHeaders() }
          : { method: 'PUT', headers: { ...bearerAuthHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ included }) };
      const res = await fetch(url, init).catch(() => null);
      // No response at all (network down): the browser's own message is not for the user.
      if (!res) throw new Error(t('revenue.review.failed'));
      if (!res.ok) throw new Error(failureMessage(res.status, await readJsonBody(res)));
      await load();
      onChanged();
    } catch (e) {
      showToast(e instanceof Error && e.message ? e.message : t('revenue.review.failed'), 'error');
    } finally {
      inFlight.current.delete(itemId);
      setBusy(withoutId(itemId));
    }
  };

  return (
    <RevenueClosablePanel
      title={t('revenue.review.title')}
      onClose={onClose}
      action={
        <button type="button" className={`text-xs text-bambu-gray-light underline underline-offset-2 hover:text-white ${focusRingCls}`} onClick={() => setShowDecided((s) => !s)}>
          {showDecided ? t('revenue.review.hideDecisions') : t('revenue.review.decisions', { n: data?.decided.length ?? 0 })}
        </button>
      }
    >
      <p className="mb-2 text-xs text-bambu-gray">{t('revenue.review.hint')}</p>
      {error && <p role="alert" className="mb-2 text-sm text-red-400">{error}</p>}
      {!data ? (
        !error && <p className="text-sm text-bambu-gray">{t('revenue.state.loading')}</p>
      ) : data.unclassified.length === 0 ? (
        <p className="text-sm text-bambu-gray">{t('revenue.review.empty')}</p>
      ) : (
        <ul className="space-y-1">
          {data.unclassified.map((r) => (
            <li key={r.itemId} className="flex items-center gap-3 rounded-lg bg-bambu-dark px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-white" title={r.name}>{r.name}</span>
              <span className="hidden text-xs text-bambu-gray md:inline">
                {r.brand ?? '—'} · {r.nature ?? '—'} · {t('revenue.review.last', { day: r.lastDay || '—' })}
              </span>
              <span className="w-32 text-right tabular-nums text-bambu-gray-light">{formatFcp(r.totalHt)}</span>
              {canManage && (
                <>
                  <button type="button" className={`${BTN} text-bambu-green`} disabled={busy.has(r.itemId)} onClick={() => void decide(r.itemId, true)}>
                    {t('revenue.review.include')}
                  </button>
                  <button type="button" className={`${BTN} text-bambu-gray-light`} disabled={busy.has(r.itemId)} onClick={() => void decide(r.itemId, false)}>
                    {t('revenue.review.exclude')}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {showDecided && data && data.decided.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-bambu-dark-tertiary pt-3">
          {data.decided.map((r) => (
            <li key={r.itemId} className="flex items-center gap-3 rounded-lg bg-bambu-dark px-3 py-1.5 text-xs">
              <span className={`w-16 ${r.included ? 'text-bambu-green' : 'text-bambu-gray'}`}>
                {r.included ? t('revenue.review.included') : t('revenue.review.excluded')}
              </span>
              <span className="min-w-0 flex-1 truncate text-bambu-gray-light" title={r.name}>{r.name}</span>
              <span className="w-32 text-right tabular-nums text-bambu-gray">{formatFcp(r.totalHt)}</span>
              {canManage && (
                <button type="button" className={BTN} disabled={busy.has(r.itemId)} onClick={() => void decide(r.itemId, null)}>
                  {t('revenue.review.undo')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </RevenueClosablePanel>
  );
}
