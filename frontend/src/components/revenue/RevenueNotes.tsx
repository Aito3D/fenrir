import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { bearerAuthHeaders } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { focusRingCls } from '../formStyles';
import { RevenuePopover } from './RevenueControls';
import { failureMessage, readJsonBody, ROW_LEAVE_MS } from './lib/dashboard';
import { isValidDay, REVENUE_HISTORY_START } from './lib/dates';
import type { RevenueAnnotation } from './lib/types';

const MAX_LABEL = 80;
const INPUT = `rounded-md border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1 text-sm text-white ${focusRingCls}`;

/** The chart's notes: a promo, a holiday, a closure, pinned to a day and drawn as a diamond on its column. */
export function RevenueNotes({ annotations, onChanged, today, canManage }: { annotations: RevenueAnnotation[]; onChanged: () => void; today: string; canManage: boolean }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [day, setDay] = useState(today);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState<number | null>(null);
  // State lags a render behind: two Enters in one tick would both see busy=false.
  const inFlight = useRef(false);
  const trimmed = label.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= MAX_LABEL && isValidDay(day) && day >= REVENUE_HISTORY_START && day <= today;

  /** `leavingId`: the note being deleted, folded away before the refresh drops it. */
  const call = async (url: string, method: 'POST' | 'DELETE', body?: unknown, leavingId?: number) => {
    inFlight.current = true;
    setBusy(true);
    try {
      const headers = body === undefined ? bearerAuthHeaders() : { ...bearerAuthHeaders(), 'Content-Type': 'application/json' };
      const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
      // No response at all (network down): the browser's own message is not for the user.
      if (!res) throw new Error(t('revenue.notes.failed'));
      if (!res.ok) throw new Error(failureMessage(res.status, await readJsonBody(res)));
      if (leavingId !== undefined) {
        setLeaving(leavingId);
        await new Promise((resolve) => setTimeout(resolve, ROW_LEAVE_MS));
      }
      onChanged();
      return true;
    } catch (e) {
      showToast(e instanceof Error && e.message ? e.message : t('revenue.notes.failed'), 'error');
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
      setLeaving(null);
    }
  };

  const add = async () => {
    if (!valid || inFlight.current) return;
    const ok = await call('/api/v1/revenue/annotations', 'POST', { day, label: trimmed });
    if (ok) setLabel('');
  };

  return (
    <RevenuePopover label={t('revenue.notes.title')} align="end" className="w-80 space-y-3"
      trigger={`${t('revenue.notes.button')}${annotations.length > 0 ? ` (${annotations.length})` : ''}`}>
      {() => (
        <>
          {canManage && (
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
              <p className="text-xs uppercase tracking-wide text-bambu-gray">{t('revenue.notes.new')}</p>
              <div className="flex gap-2">
                <input type="date" aria-label={t('revenue.notes.day')} className={INPUT} min={REVENUE_HISTORY_START} max={today} value={day} onChange={(e) => setDay(e.target.value)} />
                <button type="submit" disabled={busy || !valid}
                  className={`btn-press rounded-md bg-bambu-green px-3 text-sm text-white disabled:opacity-40 ${focusRingCls}`}>
                  {t('revenue.notes.add')}
                </button>
              </div>
              <input type="text" aria-label={t('revenue.notes.label')} placeholder={t('revenue.notes.placeholder')} maxLength={MAX_LABEL}
                className={`${INPUT} w-full`} value={label} onChange={(e) => setLabel(e.target.value)} />
            </form>
          )}
          {annotations.length > 0 && (
            <ul className="max-h-56 space-y-1 overflow-y-auto">
              {[...annotations].reverse().map((a) => (
                <li key={a.id} className="row-collapse" data-leaving={leaving === a.id || undefined}>
                  <div className="flex items-center gap-2 rounded-lg bg-bambu-dark px-3 py-1.5 text-sm">
                    <span className="shrink-0 text-xs tabular-nums text-bambu-gray">{a.day}</span>
                    <span className="min-w-0 flex-1 truncate text-white" title={a.label}>{a.label}</span>
                    {canManage && (
                      <button type="button" aria-label={t('revenue.notes.remove', { label: a.label })} disabled={busy}
                        className={`btn-press h-6 w-6 rounded text-bambu-gray hover:text-red-400 ${focusRingCls}`}
                        onClick={() => void call(`/api/v1/revenue/annotations/${a.id}`, 'DELETE', undefined, a.id)}>
                        ×
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </RevenuePopover>
  );
}
