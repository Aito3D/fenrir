import { useTranslation } from 'react-i18next';
import { ExternalLink, ReceiptText } from 'lucide-react';
import { api } from '../../api/client';
import type { OrderBoardRow, OrderInvoice } from '../../api/client';
import { formatMoney } from '../../utils/pricing';
import { Card } from '../Card';
import { PdfDownloadButton } from '../aito/PdfDownloadButton';
import { PdfPrintButton } from '../aito/PdfPrintButton';
import { DOC_ICON_BUTTON_CLS, LINK_ICON_CLS } from '../aito/linkActionHelpers';
import { daysPastDue, parseDay } from './orderBoard';
import { TONE } from './orderStatus';

/** The invoices of one order, one entry each, and the way to invoice what was handed over without one. */
export function OrderInvoicesBlock({ row, onCreateInvoice, busy = false }: { row: Pick<OrderBoardRow, 'currency' | 'payment' | 'unbilled_units'>; onCreateInvoice?: () => void; busy?: boolean }) {
  const { t } = useTranslation();
  const money = (n: number) => formatMoney(n, row.currency);
  const shortDay = (day: string) => parseDay(day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const invoices = row.payment?.invoices ?? [];

  const state = (i: OrderInvoice) => {
    if (i.status === 'draft') return <span className="text-bambu-gray">{t('orders.inv.draft')}</span>;
    const part = i.balance < i.total ? ` · ${t('orders.pay.invLeft', { amount: money(i.balance) })}` : '';
    if (i.balance <= 0) return <span className={TONE.success.text}>{t('orders.pay.paid')}</span>;
    if (!/^\d{4}-\d{2}-\d{2}/.test(i.due_date ?? '')) return <span className={TONE.warning.text}>{t('orders.pay.legendDue')}{part}</span>;
    const late = daysPastDue(i.due_date);
    return late > 0 ? (
      <span className={TONE.danger.text}>{t('orders.pay.invOverdue', { n: late })}{part}</span>
    ) : (
      <span className={TONE.warning.text}>{t('orders.pay.invDue', { date: shortDay(i.due_date) })}{part}</span>
    );
  };

  return (
    <Card className="p-3 text-xs">
      <div className="flex items-center gap-2">
        <ReceiptText aria-hidden="true" className="h-3.5 w-3.5 text-bambu-gray" />
        <span className="font-semibold uppercase tracking-wide text-white">{t('orders.inv.title')}</span>
      </div>
      {row.unbilled_units > 0 && onCreateInvoice && (
        <div className={`mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md px-2.5 py-1.5 ${TONE.warning.soft}`}>
          <span className={TONE.warning.text}>{t('orders.inv.unbilled', { units: t('orders.units', { count: row.unbilled_units }) })}</span>
          <button type="button" disabled={busy} onClick={onCreateInvoice} className="rounded-md bg-bambu-green px-2.5 py-1 font-semibold text-black hover:bg-bambu-green/90 disabled:opacity-50">
            {t('orders.inv.create')}
          </button>
        </div>
      )}
      <div className="mt-1.5 divide-y divide-bambu-dark-tertiary/60">
        {invoices.length === 0 ? (
          <div className="py-1.5 text-bambu-gray">{t('orders.inv.empty')}</div>
        ) : (
          invoices.map(i => (
            <div key={i.id} className="px-1 py-1.5">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-mono text-white">{i.number}</span>
                <span className="font-semibold tabular-nums text-white">{money(i.total)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  <span className="text-bambu-gray">{i.date ? `${shortDay(i.date)} · ` : ""}</span>
                  {state(i)}
                </span>
                <span className="-mr-1 inline-flex shrink-0 items-center">
                  <PdfDownloadButton variant="icon" fetchPdf={() => api.getOrderInvoicePdf(i.id)} label={t('orders.inv.download')} filename={i.number} failureMessage={t('orders.inv.pdfFailed')} />
                  <PdfPrintButton variant="icon" fetchPdf={() => api.getOrderInvoicePdf(i.id)} label={t('orders.inv.print')} failureMessage={t('orders.inv.pdfFailed')} />
                  {i.url && (
                    <a href={i.url} target="_blank" rel="noopener noreferrer" aria-label={t('orders.inv.open')} title={t('orders.inv.open')} className={DOC_ICON_BUTTON_CLS}>
                      <ExternalLink aria-hidden="true" className={LINK_ICON_CLS} />
                    </a>
                  )}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
