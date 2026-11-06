import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, PackagePlus } from 'lucide-react';
import { ApiError } from '../../api/client';
import type { OrderPanelRow } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { formatQty, packableUnits, parcelLines } from './orderBoard';
import { useOrderActions } from './useOrderActions';

/** The bar under the check: what goes in the parcel, and the way out or through. */
export function OrderPackBar({ row, qty, onClose, onBusy }: { row: OrderPanelRow; qty: Record<string, number>; onClose: () => void; onBusy: (busy: boolean) => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { createParcel } = useOrderActions({
    parcel: {
      onSuccess: r => {
        showToast(t('orders.parcel.created', { number: r.package_number }));
        onClose();
      },
      onError: e => showToast(t('orders.parcel.failed', { reason: reason(e) }), 'error'),
    },
  });
  const busy = createParcel.isPending;
  useEffect(() => onBusy(busy), [busy, onBusy]);
  const lines = parcelLines(row, qty);
  const units = Math.round(lines.reduce((n, l) => n + l.quantity, 0) * 100) / 100;
  const of = packableUnits(row);
  const today = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

  // A refused answer (400, 409) means the order moved under the operator: look again. 502 carries Books' own words.
  function reason(e: unknown) {
    return e instanceof ApiError && e.status === 503 ? t('orders.busy')
      : e instanceof ApiError && (e.status === 400 || e.status === 409) ? t('orders.parcel.stale')
      : e instanceof Error ? e.message : '';
  }

  const confirm = () => {
    if (busy || units <= 0) return;
    createParcel.mutate({ id: row.id, lines });
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-bambu-green/40 bg-bambu-green/10 px-3 py-2 text-xs">
      <PackagePlus aria-hidden="true" className="h-4 w-4 text-bambu-green" />
      <span>
        <span className="text-white">{t('orders.parcel.summary', { units: formatQty(units), of: formatQty(of) })}</span>
        <span className="text-bambu-gray"> · {t('orders.parcel.meta', { date: today })}</span>
        {units < of && <span className="text-yellow-400"> · {t('orders.parcel.left', { units: formatQty(Math.round((of - units) * 100) / 100) })}</span>}
      </span>
      <span className="ml-auto flex items-center gap-2">
        <button type="button" disabled={busy} onClick={onClose} className="rounded-md px-2.5 py-1 text-bambu-gray hover:text-white disabled:opacity-50">
          {t('common.cancel')}
        </button>
        <button
          type="button"
          disabled={busy || units <= 0}
          onClick={confirm}
          className="inline-flex items-center gap-1.5 rounded-md bg-bambu-green px-3 py-1 font-semibold text-black hover:bg-bambu-green-light disabled:opacity-50"
        >
          {busy ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Check aria-hidden="true" className="h-3.5 w-3.5" />}
          {t(busy ? 'orders.parcel.creating' : 'orders.parcel.create')}
        </button>
      </span>
    </div>
  );
}
