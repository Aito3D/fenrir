import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Check, Loader2, Pencil } from 'lucide-react';
import type { OrderPanelRow } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { formatMoney } from '../../utils/pricing';
import { errorReason } from './orderErrors';
import { FIT_VIEWPORT } from './orderStatus';
import { editChanges, editPayload, editTotal, formatQty } from './orderBoard';
import type { OrderEdit } from './orderBoard';
import { useOrderActions } from './useOrderActions';

/** The bar under an order edit: the changes in words, the new total, what the save does, and the way out or through. */
export function OrderEditBar({ row, edit, onClose, onBusy }: { row: OrderPanelRow; edit: OrderEdit; onClose: () => void; onBusy: (busy: boolean) => void }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const changes = editChanges(row, edit);
  const { editLines } = useOrderActions({
    edit: {
      onSuccess: () => {
        showToast(t('orders.edit.done', { number: row.number, count: changes.length }));
        onClose();
      },
      onError: e => showToast(t('orders.edit.failed', { reason: errorReason(t, e) }), 'error'),
    },
  });
  const busy = editLines.isPending;
  useEffect(() => onBusy(busy), [busy, onBusy]);
  const money = (n: number) => formatMoney(n, row.currency);
  const total = editTotal(row, edit);
  const paid = row.payment?.paid ?? 0;
  const shopify = !!(row.facts.shopify_order || row.facts.shopify_url); // the same test as the Shopify chip

  const sent = useRef(false); // a ref, so two clicks in one tick send one request
  const save = () => {
    if (busy || sent.current || !changes.length) return;
    sent.current = true;
    editLines.mutate({ id: row.id, version: edit.version, lines: editPayload(row, edit) }, { onSettled: () => { sent.current = false; } });
  };
  const words = changes.map(c =>
    c.kind === 'qty' ? t('orders.edit.qtyChange', { name: c.line?.name, from: formatQty(c.from ?? 0), to: formatQty(c.to ?? 0) })
    : c.kind === 'gone' ? t('orders.edit.removes', { name: c.line?.name })
    : t('orders.edit.adds', { name: c.item?.name, n: formatQty(c.to ?? 0) }));

  return (
    <div className={`space-y-2 ${FIT_VIEWPORT} rounded-md border border-bambu-green/40 bg-bambu-green/10 px-3 py-2 text-xs`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Pencil aria-hidden="true" className="h-4 w-4 text-bambu-green" />
        {changes.length ? (
          <span>
            <span className="font-semibold text-white">{t('orders.edit.changes', { count: changes.length })}</span>
            <span className="text-bambu-gray"> · {words.join(' · ')}</span>
          </span>
        ) : (
          <span className="text-bambu-gray">{t('orders.edit.hint')}</span>
        )}
        {total !== null ? (
          <span data-testid="edit-total" className="ml-auto whitespace-nowrap tabular-nums">
            {t('orders.edit.total')} <span className="font-semibold text-white">{money(total)}</span>
            {row.total !== null && total !== row.total && <span className="text-bambu-gray"> {t('orders.edit.was', { amount: money(row.total) })}</span>}
          </span>
        ) : (
          <span className="ml-auto text-bambu-gray">{t('orders.edit.booksTotal')}</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-bambu-green/20 pt-2">
        <BookOpen aria-hidden="true" className="h-4 w-4 text-bambu-green" />
        <span className="text-bambu-gray">
          {t('orders.edit.saves')}
          {shopify && <span className="text-yellow-400"> {t('orders.edit.shopify')}</span>}
          {row.payment && total !== null && paid > total && (
            <span className="text-yellow-400"> {t('orders.edit.overpaid', { amount: money(Math.round((paid - total) * 100) / 100) })}</span>
          )}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button type="button" disabled={busy} onClick={onClose} className="btn-press rounded-md px-2.5 py-1 text-bambu-gray hover:text-white disabled:opacity-50">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={busy || !changes.length}
            onClick={save}
            className="btn-press inline-flex items-center gap-1.5 rounded-md bg-bambu-green px-3 py-1 font-semibold text-black hover:bg-bambu-green-light disabled:opacity-50"
          >
            {busy ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Check aria-hidden="true" className="h-3.5 w-3.5" />}
            {t(busy ? 'orders.edit.saving' : 'orders.edit.save')}
          </button>
        </span>
      </div>
    </div>
  );
}
