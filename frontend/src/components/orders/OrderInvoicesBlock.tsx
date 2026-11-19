import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { Mail, PiggyBank } from 'lucide-react';
import { api } from '../../api/client';
import type { OrderBoardRow, OrderDocumentKind, OrderInvoice } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { formatMoney } from '../../utils/pricing';
import { DocumentRow } from '../aito/DocumentRow';
import { PanelCard } from '../aito/PanelCard';
import { INVOICE_STATUS_TEXT_TONE_CLASSES, invoiceStatusLabelKey, invoiceStatusTone } from '../aito/invoiceStatus';
import { PdfDownloadButton } from '../aito/PdfDownloadButton';
import { PdfPrintButton } from '../aito/PdfPrintButton';
import { DOC_ICON_BUTTON_CLS, LINK_ICON_CLS } from '../aito/linkActionHelpers';
import { RETAINER_STATUS_TEXT_TONE_CLASSES, retainerStatusLabelKey, retainerStatusTone } from '../aito/retainerStatus';
import { OrderDocumentEmailModal } from './OrderDocumentEmailModal';
import { OrderInvoiceEmailModal } from './OrderInvoiceEmailModal';
import { OrderInvoiceNow } from './OrderInvoiceNow';
import { TONE } from './orderStatus';
import { useOrderActions } from './useOrderActions';

/** The billing documents of one order, one entry each (its quote, its deposit invoices, its invoices), the way to
 *  invoice what was handed over without one, and `onInvoiceNow` to invoice what is packed or the whole order before
 *  the hand-over. `canEmail` (the caller's orders:update) adds the send-by-mail buttons of the Aito card and the
 *  way to spend the order's deposits and advance on an open invoice. */
export function OrderInvoicesBlock({ row, onCreateInvoice, onInvoiceNow, busy = false, canEmail = false, children }: {
  /** The collect section: the customer's credit and the payment block. */
  children?: ReactNode;
  row: Pick<OrderBoardRow, 'currency' | 'payment' | 'unbilled_units'> & Partial<Pick<OrderBoardRow, 'id' | 'lines' | 'facts' | 'retainers'>>;
  onCreateInvoice?: () => void;
  onInvoiceNow?: (scope: 'packed' | 'whole', applyCredit: boolean) => void;
  busy?: boolean;
  canEmail?: boolean;
}) {
  const { t } = useTranslation();
  const money = (n: number) => formatMoney(n, row.currency);
  const invoices = row.payment?.invoices ?? [];
  // An invoice that was not in the list on the previous render flashes once; the ones present at mount never do.
  const [seen, setSeen] = useState(() => new Set(invoices.map(i => i.id)));
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [emailing, setEmailing] = useState<OrderInvoice | null>(null);
  const [mailingDoc, setMailingDoc] = useState<{ kind: OrderDocumentKind; id: string } | null>(null);
  const { showToast } = useToast();
  const mailButton = (label: string, onClick: () => void) => (
    <button type="button" onClick={onClick} aria-label={label} title={label} className={DOC_ICON_BUTTON_CLS}>
      <Mail aria-hidden="true" className={LINK_ICON_CLS} />
    </button>
  );
  const { applyCredit } = useOrderActions();
  // What the board counts as this order's to spend: its quote's deposits, then its advance.
  const credit = (row.payment?.retainer ?? 0) + (row.payment?.advance ?? 0);
  const spend = (i: OrderInvoice) => {
    if (!row.id || applyCredit.isPending) return;
    applyCredit.mutate(
      { id: row.id, invoiceId: i.id },
      {
        onSuccess: r => showToast(t('aito.applyDepositDone', { amount: money(r.applied), invoice: i.number }), 'success'),
        onError: () => showToast(t('aito.applyDepositError'), 'error'),
      },
    );
  };
  const docButtons = (kind: OrderDocumentKind, id: string, number: string) => {
    const fetchPdf = () => api.getOrderDocumentPdf(row.id!, kind, id);
    const quote = kind === 'quote';
    return {
      print: <PdfPrintButton variant="icon" fetchPdf={fetchPdf} label={t(quote ? 'aito.printQuote' : 'aito.printRetainer')} failureMessage={t(quote ? 'aito.printFailed' : 'aito.retainerPrintFailed')} />,
      download: <PdfDownloadButton variant="icon" fetchPdf={fetchPdf} label={t(quote ? 'aito.downloadQuote' : 'aito.downloadRetainer')} filename={number} failureMessage={t(quote ? 'aito.printFailed' : 'aito.retainerPrintFailed')} />,
      send: canEmail ? mailButton(t(quote ? 'aito.sendQuote' : 'aito.sendRetainer'), () => setMailingDoc({ kind, id })) : undefined,
    };
  };
  const quoteId = row.facts?.estimate_id;
  const retainers = (row.retainers ?? []).filter(r => r.status !== 'void');
  const [now, setNow] = useState(false);
  if (invoices.some(i => !seen.has(i.id))) {
    setFresh(new Set(invoices.filter(i => !seen.has(i.id)).map(i => i.id)));
    setSeen(new Set(invoices.map(i => i.id)));
    setNow(false); // the new invoice is the answer
  }
  // Units not handed over and not invoiced: something an invoice could bill ahead of the hand-over.
  const ahead = !!onInvoiceNow && !!row.id && row.unbilled_units <= 0 && (row.lines ?? []).some(l => l.remaining > l.invoiced);

  return (
    <PanelCard title={t('aito.billingLabel')}>
      <div className="-mt-1.5 divide-y divide-bambu-dark-tertiary">
        {row.id && quoteId && (
          <DocumentRow
            testId="doc-quote"
            label={t('aito.quoteSearchLabel')}
            number={row.facts?.quote_number || quoteId}
            booksUrl={row.facts?.quote_url}
            booksLabel={t('aito.quoteOpenInZoho')}
            {...docButtons('quote', quoteId, row.facts?.quote_number || quoteId)}
          />
        )}
        {row.id && retainers.map(r => {
          const key = retainerStatusLabelKey(r.status);
          return (
            <DocumentRow
              key={r.id}
              testId="doc-retainer"
              label={t('aito.retainerLabel')}
              number={r.number}
              numberTitle={r.date || undefined}
              status={r.status ? { text: key ? t(key) : r.status, toneClass: RETAINER_STATUS_TEXT_TONE_CLASSES[retainerStatusTone(r.status)] } : null}
              amount={money(r.total)}
              booksLabel={t('aito.invoiceOpenInZoho')}
              {...docButtons('retainer', r.id, r.number)}
            />
          );
        })}
        {invoices.map(i => {
          const key = invoiceStatusLabelKey(i.status);
          const fetchPdf = () => api.getOrderInvoicePdf(i.id);
          return (
            <div key={i.id} data-fresh={fresh.has(i.id) || undefined} className={fresh.has(i.id) ? 'rounded-md bg-bambu-green/10 motion-safe:animate-[pulse_1s_ease-in-out_2]' : ''}>
              <DocumentRow
                testId="doc-invoice"
                label={t('aito.invoiceLabel')}
                number={i.number || i.id}
                numberTitle={i.date ? t('aito.invoiceDatesTitle', { date: i.date, due: i.due_date || '—' }) : undefined}
                status={i.status ? { text: key ? t(key) : i.status, toneClass: INVOICE_STATUS_TEXT_TONE_CLASSES[invoiceStatusTone(i.status)] } : null}
                amount={money(i.total)}
                booksUrl={i.url}
                booksLabel={t('aito.invoiceOpenInZoho')}
                extra={
                  canEmail && row.id && credit > 0 && i.balance > 0 && i.status !== 'draft' ? (
                    <button type="button" disabled={applyCredit.isPending} onClick={() => spend(i)} aria-label={t('aito.applyDeposit')} title={t('orders.handover.applyCredit', { amount: money(Math.min(credit, i.balance)) })} data-testid="apply-deposit" className={DOC_ICON_BUTTON_CLS}>
                      <PiggyBank aria-hidden="true" className={LINK_ICON_CLS} />
                    </button>
                  ) : undefined
                }
                print={<PdfPrintButton variant="icon" fetchPdf={fetchPdf} label={t('aito.printInvoice')} failureMessage={t('aito.invoicePrintFailed')} />}
                download={<PdfDownloadButton variant="icon" fetchPdf={fetchPdf} label={t('aito.downloadInvoice')} filename={i.number} failureMessage={t('aito.invoicePrintFailed')} />}
                send={canEmail ? mailButton(t('aito.sendInvoice'), () => setEmailing(i)) : undefined}
              />
            </div>
          );
        })}
      </div>
      {invoices.length === 0 && !ahead && !now && !(row.id && (quoteId || retainers.length)) && <p className="text-xs text-bambu-gray">{t('orders.inv.empty')}</p>}
      {row.unbilled_units > 0 && onCreateInvoice && (
        <div className={`mt-2 flex flex-wrap text-xs items-center justify-between gap-2 rounded-md px-2.5 py-1.5 ${TONE.warning.soft}`}>
          <span className={TONE.warning.text}>{t('orders.inv.unbilled', { units: t('orders.units', { count: row.unbilled_units }) })}</span>
          <button type="button" disabled={busy} onClick={onCreateInvoice} className="btn-press rounded-md bg-bambu-green px-2.5 py-1 font-semibold text-black hover:bg-bambu-green/90 disabled:opacity-50">
            {t('orders.inv.create')}
          </button>
        </div>
      )}
      {now && onInvoiceNow && row.id ? (
        <OrderInvoiceNow row={{ id: row.id, currency: row.currency }} busy={busy} onCreate={onInvoiceNow} onClose={() => setNow(false)} />
      ) : ahead && (
        <div className="mt-2 flex items-center justify-between gap-2 text-xs">
          <span className="text-bambu-gray">{invoices.length === 0 ? t('orders.inv.emptyNow') : ''}</span>
          <button type="button" disabled={busy} onClick={() => setNow(true)} className="btn-press shrink-0 rounded-md border border-bambu-green/50 px-2.5 py-1 font-semibold text-bambu-green hover:bg-bambu-green/10 disabled:opacity-50">
            {t('orders.inv.now')}
          </button>
        </div>
      )}
      {/* The collect section under a hairline, as on the Aito card; it draws nothing when it has no child. */}
      <div className="space-y-2 empty:hidden has-[*]:mt-2 has-[*]:border-t has-[*]:border-bambu-dark-tertiary has-[*]:pt-2">{children}</div>
      {emailing && <OrderInvoiceEmailModal invoice={emailing} onClose={() => setEmailing(null)} />}
      {mailingDoc && row.id && <OrderDocumentEmailModal orderId={row.id} kind={mailingDoc.kind} docId={mailingDoc.id} onClose={() => setMailingDoc(null)} />}
    </PanelCard>
  );
}
