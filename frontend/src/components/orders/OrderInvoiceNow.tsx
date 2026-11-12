import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Check, Loader2 } from 'lucide-react';
import { api } from '../../api/client';
import type { OrderBoardRow } from '../../api/client';
import { formatMoney } from '../../utils/pricing';
import { Skeleton } from '../Skeleton';
import { TONE } from './orderStatus';

type Scope = 'packed' | 'whole';

/** The confirm panel of "Invoice now": what is packed or the whole order, the credit, and what will be left to pay. */
export function OrderInvoiceNow({ row, busy, onCreate, onClose }: { row: Pick<OrderBoardRow, 'id' | 'currency'>; busy: boolean; onCreate: (scope: Scope, applyCredit: boolean) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const money = (n: number) => formatMoney(n, row.currency);
  const [picked, setPicked] = useState<Scope | null>(null);
  const [credit, setCredit] = useState(true);
  const preview = useQuery({
    queryKey: ['order-invoice', row.id],
    queryFn: () => api.getOrderInvoicePreview(row.id),
    retry: false,
    staleTime: 0, // always what Books says now
    gcTime: 0,
  });

  if (preview.isPending) return <Skeleton className="mt-2 h-24 w-full rounded" />;
  const p = preview.data;
  const close = (
    <button type="button" disabled={busy} onClick={onClose} className="btn-press rounded-md px-2.5 py-1 text-bambu-gray hover:text-white disabled:opacity-50">
      {t('common.cancel')}
    </button>
  );
  const blocked = !p || !p.available ? t('orders.handover.previewFailed')
    : p.drafts.length ? t('orders.handover.manualDraft', { number: p.drafts[0] })
    : p.whole.units <= 0 ? t('orders.inv.nothing')
    : null;
  if (blocked || !p) {
    return (
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className={TONE.warning.text}>{blocked}</span>
        {close}
      </div>
    );
  }

  const same = p.packed.units === p.whole.units;
  const scope: Scope = picked ?? (p.packed.units > 0 ? 'packed' : 'whole');
  const chosen = p[scope];
  const offered = chosen.invoice_total !== null && p.credit > 0;
  const applied = offered && credit ? Math.min(p.credit, chosen.invoice_total ?? 0) : 0;
  const due = chosen.invoice_total !== null ? Math.round((chosen.invoice_total - applied) * 100) / 100 : 0;

  const option = (s: Scope, hint: string, off: boolean) => (
    <label className={`flex items-center gap-2.5 rounded-md border px-2.5 py-2 ${scope === s ? 'border-bambu-green/50 bg-bambu-green/5' : 'border-bambu-dark-tertiary'} ${off ? 'opacity-45' : 'cursor-pointer'}`}>
      <input type="radio" name={`invoice-scope-${row.id}`} checked={scope === s} disabled={off || busy} onChange={() => setPicked(s)} className="accent-bambu-green" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-white">{t(`orders.inv.${s}`)}</span>
        <span className="text-bambu-gray">{hint}</span>
      </span>
      <span className="font-mono tabular-nums text-white">{p[s].invoice_total === null ? '—' : money(p[s].invoice_total)}</span>
    </label>
  );

  return (
    <div className="mt-2 space-y-2.5 motion-safe:animate-rise-sm">
      <div className="text-[11px] uppercase tracking-wide text-bambu-gray">{t('orders.inv.what')}</div>
      <div role="radiogroup" aria-label={t('orders.inv.what')} className="space-y-1.5">
        {option('packed', t('orders.units', { count: p.packed.units }), p.packed.units <= 0)}
        {option('whole', same ? t('orders.inv.samePacked') : t('orders.units', { count: p.whole.units }), same)}
      </div>
      {chosen.manual_reason ? (
        <div className={TONE.warning.text}>{t('orders.handover.manual')}</div>
      ) : (
        <>
          {offered && (
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={credit} disabled={busy} onChange={e => setCredit(e.target.checked)} className="accent-blue-500" />
              {t('orders.handover.applyCredit', { amount: money(p.credit) })}
            </label>
          )}
          <div className="space-y-1 rounded-md border border-bambu-dark-tertiary bg-bambu-dark px-2.5 py-2">
            <div className="flex justify-between gap-2">
              <span className="text-bambu-gray">{t('orders.inv.total')}</span>
              <span className="font-mono tabular-nums text-white">{chosen.invoice_total === null ? t('orders.inv.noAmount') : money(chosen.invoice_total)}</span>
            </div>
            {chosen.invoice_total !== null && (
              <div className={`text-right ${due > 0 ? TONE.warning.text : TONE.success.text}`}>{due > 0 ? t('orders.handover.due', { amount: money(due) }) : t('orders.handover.settled')}</div>
            )}
          </div>
          <div className="text-bambu-gray">{t('orders.inv.after')}</div>
        </>
      )}
      <div className="flex justify-end gap-2">
        {close}
        <button
          type="button"
          disabled={busy || !!chosen.manual_reason}
          onClick={() => onCreate(scope, offered ? credit : true)}
          className="btn-press inline-flex items-center gap-1.5 rounded-md bg-bambu-green px-3 py-1 font-semibold text-black hover:bg-bambu-green-light disabled:opacity-50"
        >
          {busy ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Check aria-hidden="true" className="h-3.5 w-3.5" />}
          {t(busy ? 'orders.inv.creating' : 'orders.inv.confirm')}
        </button>
      </div>
    </div>
  );
}
