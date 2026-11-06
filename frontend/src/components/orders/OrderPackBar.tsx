import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ClipboardList, Loader2, PackagePlus } from 'lucide-react';
import type { OrderPanelRow } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { errorReason } from './orderErrors';
import { FIT_VIEWPORT } from './orderStatus';
import { checkLines, formatQty } from './orderBoard';
import type { OrderCheck } from './orderBoard';
import { useOrderActions } from './useOrderActions';

/** The bar under a check: what goes on the new picklist, or in the parcel of one, and the way out or through. */
export function OrderPackBar({
  row,
  check,
  onClose,
  onBusy,
  onPicked,
}: {
  row: OrderPanelRow;
  check: OrderCheck;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
  /** A picklist was created: its sheet is printed next. */
  onPicked: (picklist: { id: string; number: string }) => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { createParcel, createPicklist } = useOrderActions({
    parcel: {
      onSuccess: r => {
        showToast(t('orders.parcel.created', { number: r.package_number }));
        onClose();
      },
      onError: e => showToast(t('orders.parcel.failed', { reason: errorReason(t, e) }), 'error'),
    },
    picklist: {
      onSuccess: r => {
        showToast(t('orders.pick.created', { number: r.picklist.number }));
        onClose();
        if (r.picklist.id) onPicked(r.picklist); // without an id there is no sheet to ask for: the band offers it after the next refresh
      },
      onError: e => showToast(t('orders.pick.failed', { reason: errorReason(t, e) }), 'error'),
    },
  });
  const pick = check.kind === 'pick';
  const busy = createParcel.isPending || createPicklist.isPending;
  useEffect(() => onBusy(busy), [busy, onBusy]);
  const lines = checkLines(check);
  const sum = (ns: number[]) => Math.round(ns.reduce((n, q) => n + q, 0) * 100) / 100;
  const units = sum(lines.map(l => l.quantity));
  const of = sum(Object.values(check.max));
  const today = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  const Icon = pick ? ClipboardList : PackagePlus;

  const sent = useRef(false); // a ref, so two clicks in one tick send one request
  const confirm = () => {
    if (busy || sent.current || units <= 0) return;
    sent.current = true;
    const onSettled = () => { sent.current = false; };
    if (pick) createPicklist.mutate({ id: row.id, lines }, { onSettled });
    else createParcel.mutate({ id: row.id, picklistId: check.picklist?.id ?? '', lines }, { onSettled });
  };

  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 ${FIT_VIEWPORT} rounded-md border border-bambu-green/40 bg-bambu-green/10 px-3 py-2 text-xs`}>
      <Icon aria-hidden="true" className="h-4 w-4 text-bambu-green" />
      <span>
        <span className="text-white">
          {pick
            ? t('orders.pick.summary', { units: formatQty(units), of: formatQty(of) })
            : t('orders.parcel.fromPick', { units: formatQty(units), of: formatQty(of), number: check.picklist?.number ?? '' })}
        </span>
        <span className="text-bambu-gray"> · {pick ? t('orders.pick.meta') : t('orders.parcel.meta', { date: today })}</span>
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
          {t(busy ? 'orders.parcel.creating' : pick ? 'orders.pick.create' : 'orders.parcel.create')}
        </button>
      </span>
    </div>
  );
}
