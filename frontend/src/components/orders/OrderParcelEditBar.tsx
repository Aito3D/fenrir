import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Check, Loader2, Pencil, Trash2 } from 'lucide-react';
import type { OrderPanelRow } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { errorReason, isRefused } from './orderErrors';
import { FIT_VIEWPORT } from './orderStatus';
import { formatQty, parcelDiff, parcelLines, parcelWas } from './orderBoard';
import type { ParcelEdit } from './orderBoard';
import { useOrderActions } from './useOrderActions';

/** The bar under a parcel edit: the units now and before, what came from the shelf and went back, what the save does in Books. */
export function OrderParcelEditBar({ row, parcel, onClose, onBusy }: { row: OrderPanelRow; parcel: ParcelEdit; onClose: () => void; onBusy: (busy: boolean) => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const d = parcelDiff(parcel);
  const { editParcel } = useOrderActions({
    parcelEdit: {
      onSuccess: () => {
        showToast(d.units > 0 ? t('orders.parcelEdit.done', { number: parcel.number, units: formatQty(d.units) }) : t('orders.parcelEdit.deleted', { number: parcel.number }));
        onClose();
      },
      onError: e => {
        showToast(t('orders.parcelEdit.failed', { reason: errorReason(t, e) }), 'error');
        if (isRefused(e)) onClose(); // the parcel shown is out of date: it is opened again from Books
      },
    },
  });
  const busy = editParcel.isPending;
  useEffect(() => onBusy(busy), [busy, onBusy]);
  const changed = d.added + d.removed > 0;
  const empty = d.units <= 0;

  const sent = useRef(false); // a ref, so two clicks in one tick send one request
  const save = () => {
    if (busy || sent.current || !changed) return;
    sent.current = true;
    editParcel.mutate(
      { id: row.id, packageId: parcel.packageId, version: parcel.version, was: parcelWas(parcel), lines: parcelLines(parcel) },
      { onSettled: () => { sent.current = false; } },
    );
  };

  return (
    <div className={`space-y-2 ${FIT_VIEWPORT} rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-xs`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Pencil aria-hidden="true" className="h-4 w-4 text-blue-400" />
        <span className="tabular-nums">
          <span className="font-semibold text-white">{t('orders.parcelEdit.summary', { number: parcel.number, units: formatQty(d.units) })}</span>
          {d.units !== d.wasUnits && <span className="text-bambu-gray"> {t('orders.parcelEdit.was', { n: formatQty(d.wasUnits) })}</span>}
          {d.added > 0 && <span className="text-green-400"> {`· ${t('orders.parcelEdit.added', { n: formatQty(d.added) })}`}</span>}
          {d.removed > 0 && <span className="text-yellow-400"> {`· ${t('orders.parcelEdit.removed', { n: formatQty(d.removed) })}`}</span>}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-blue-500/20 pt-2">
        <BookOpen aria-hidden="true" className="h-4 w-4 text-blue-400" />
        <span className="text-bambu-gray">
          {empty ? t('orders.parcelEdit.deletes', { number: parcel.number, picklist: parcel.picklist }) : t('orders.parcelEdit.writes', { picklist: parcel.picklist })}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="rounded-md px-2.5 py-1 text-bambu-gray hover:text-white disabled:opacity-50">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={busy || !changed}
            onClick={save}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 font-semibold text-white disabled:opacity-50 ${empty ? 'bg-red-500 hover:bg-red-400' : 'bg-blue-500 hover:bg-blue-400'}`}
          >
            {busy ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : empty ? <Trash2 aria-hidden="true" className="h-3.5 w-3.5" /> : <Check aria-hidden="true" className="h-3.5 w-3.5" />}
            {t(busy ? 'orders.parcelEdit.saving' : empty ? 'orders.parcelEdit.delete' : 'orders.parcelEdit.save')}
          </button>
        </span>
      </div>
    </div>
  );
}
