import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Check, HandHelping, Loader2, ReceiptText, Truck } from 'lucide-react';
import { api } from '../../api/client';
import type { OrderPanelRow } from '../../api/client';
import { formatMoney } from '../../utils/pricing';
import { Skeleton } from '../Skeleton';
import { parseDay } from './orderBoard';
import { FIT_VIEWPORT, TONE } from './orderStatus';
import { useOrderActions } from './useOrderActions';
import { useOrderOutcomeToasts } from './useOrderOutcomeToasts';

/** The bar under a waiting parcel: pick-up or delivery, what the invoice will be, and the hand-over itself. */
export function OrderHandoverBar({ row, packageId, onClose }: { row: OrderPanelRow; packageId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const toasts = useOrderOutcomeToasts();
  const [mode, setMode] = useState<'pickup' | 'delivery'>('pickup');
  const [credit, setCredit] = useState(true);
  const { handOver } = useOrderActions({
    handOver: {
      // An answered outcome is the new truth of the order, so the bar closes; a thrown error leaves it open.
      onSuccess: (r, v) => {
        toasts.outcome(r.outcome, v.mode);
        onClose();
      },
      onError: toasts.failed,
    },
  });
  const busy = handOver.isPending;
  // The preview only informs: the hand-over is allowed whatever it says, or whether it came at all.
  const preview = useQuery({
    queryKey: ['order-handover', row.id, packageId],
    queryFn: () => api.getOrderHandover(row.id, packageId),
    retry: false,
    // Always what Books says now: a bar opened again must not show an earlier answer.
    staleTime: 0,
    gcTime: 0,
  });
  // A ref, so two clicks in the same tick cannot both pass before the first re-render disables the button.
  const sent = useRef(false);
  const pkg = row.packages.find(p => p.id === packageId);
  const p = preview.data;
  const money = (n: number) => formatMoney(n, row.currency);
  const invoice = !!p && p.available && p.to_invoice && !p.manual;
  const offered = invoice && p.invoice_total !== null && p.credit > 0;
  const applied = offered && credit ? p.credit : 0;
  const due = p && p.invoice_total !== null ? Math.round((p.invoice_total - applied) * 100) / 100 : 0;
  const date = pkg ? parseDay(pkg.date).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';

  const confirm = () => {
    if (busy || sent.current) return;
    sent.current = true;
    handOver.mutate({ id: row.id, packageId, mode, applyCredit: offered ? credit : true }, { onSettled: () => { sent.current = false; } });
  };

  const seg = (m: 'pickup' | 'delivery') => (
    <button
      type="button"
      aria-pressed={mode === m}
      disabled={busy}
      onClick={() => setMode(m)}
      className={`rounded px-2 py-1 disabled:opacity-60 ${mode === m ? 'bg-bambu-dark-tertiary text-white' : 'text-bambu-gray hover:text-white'}`}
    >
      {t(`orders.handover.${m}`)}
    </button>
  );

  let second;
  if (preview.isPending) second = <Skeleton className="h-4 w-56 rounded" />;
  else if (!p || !p.available) second = <span className="text-bambu-gray">{t('orders.handover.previewFailed')}</span>;
  else if (p.manual) second = <span className={TONE.warning.text}>{p.manual_reason === 'draft' ? t('orders.handover.manualDraft', { number: p.covered_by[0] ?? '' }) : t('orders.handover.manual')}</span>;
  else if (p.to_invoice) {
    second = (
      <>
        <span>{p.invoice_total === null ? t('orders.handover.invoiceNoAmount') : t('orders.handover.invoice', { amount: money(p.invoice_total) })}</span>
        {offered && (
          <label className="inline-flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={credit} disabled={busy} onChange={e => setCredit(e.target.checked)} className="accent-blue-500" />
            {t('orders.handover.applyCredit', { amount: money(p.credit) })}
          </label>
        )}
        {p.invoice_total !== null && <span className={due > 0 ? TONE.warning.text : TONE.success.text}>{due > 0 ? t('orders.handover.due', { amount: money(due) }) : t('orders.handover.settled')}</span>}
      </>
    );
  } else second = <span className="text-bambu-gray">{p.covered_by.length ? t('orders.handover.alreadyInvoiced', { numbers: p.covered_by.join(', ') }) : t('orders.handover.nothingToInvoice')}</span>;

  return (
    <div className={`space-y-2 rounded-md border border-blue-500/40 px-3 py-2 text-xs ${FIT_VIEWPORT} ${TONE.info.soft}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {mode === 'pickup' ? <HandHelping aria-hidden="true" className={`h-4 w-4 ${TONE.info.text}`} /> : <Truck aria-hidden="true" className={`h-4 w-4 ${TONE.info.text}`} />}
        <span>
          <span className="font-mono font-semibold text-white">{pkg?.number}</span>
          {p && <span className="text-bambu-gray"> · {t('orders.handover.meta', { units: t('orders.units', { count: p.units }), date })}</span>}
        </span>
        <span role="group" aria-label={t('orders.handover.modeLabel')} className="inline-flex items-center gap-0.5 rounded-md border border-bambu-dark-tertiary bg-bambu-dark p-0.5">
          {seg('pickup')}
          {seg('delivery')}
        </span>
        <span className="text-bambu-gray">{t(`orders.handover.${mode}Note`)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-blue-500/20 pt-2">
        <ReceiptText aria-hidden="true" className={`h-4 w-4 ${TONE.info.text}`} />
        {second}
        <span className="ml-auto flex items-center gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="rounded-md px-2.5 py-1 text-bambu-gray hover:text-white disabled:opacity-50">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={confirm}
            className="inline-flex items-center gap-1.5 rounded-md bg-bambu-green px-3 py-1 font-semibold text-black hover:bg-bambu-green-light disabled:opacity-50"
          >
            {busy ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Check aria-hidden="true" className="h-3.5 w-3.5" />}
            {t(busy ? 'orders.handover.sending' : mode === 'pickup' ? 'orders.handover.confirmPickup' : 'orders.handover.confirmDelivery')}
          </button>
        </span>
      </div>
    </div>
  );
}
