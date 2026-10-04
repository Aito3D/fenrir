import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiggyBank } from 'lucide-react';
import type { AitoProject } from '../../api/client';
import { useAitoInvoice } from './useAitoInvoice';
import { useAitoInvoiceDeposits } from './useAitoInvoiceDeposits';
import { ApplyDepositModal } from './ApplyDepositModal';
import { DOC_ICON_BUTTON_CLS, LINK_ICON_CLS } from './linkActionHelpers';
import { DocumentRow } from './DocumentRow';
import { InvoiceDownloadButton } from './InvoiceDownloadButton';
import { InvoicePrintButton } from './InvoicePrintButton';
import { SendInvoiceButton } from './SendInvoiceButton';
import { INVOICE_STATUS_TEXT_TONE_CLASSES, invoiceStatusLabelKey, invoiceStatusTone } from './invoiceStatus';
import { useCurrency } from '../../hooks/useCurrency';
import { formatMoney } from '../../utils/pricing';

/** The Zoho invoice raised from this project's quote, as one `DocumentRow`
 *  of the Billing card.
 *
 *  Every quote field is a snapshot on the project row and renders with Zoho
 *  unreachable, while this is fetched live on panel open — deliberately
 *  (see `AitoInvoiceResponse`): a stored "Unpaid" is wrong the moment the
 *  client pays. Renders nothing while loading, on error and when there is
 *  no invoice: the row is additive, and a card without it is complete.
 *
 *  The invoice's collect block (`PaymentBlock`) is NOT here: `BillingCard`
 *  mounts it under all the rows, reading the same cached query, so the
 *  documents list and the collect section stay two separate things. */
export function InvoiceCard({ project, canUpdate }: { project: AitoProject; canUpdate: boolean }) {
  const { t } = useTranslation();
  const appCurrency = useCurrency();
  const invoiceQuery = useAitoInvoice(project);
  const invoice = invoiceQuery.data;
  // POST apply-deposit enforces AITO_UPDATE, so a read-only viewer never asks.
  const depositsQuery = useAitoInvoiceDeposits(project, canUpdate && !!invoice && invoice.balance > 0);
  const [applying, setApplying] = useState(false);
  const deposits = depositsQuery.data;
  const canApply = !!deposits?.invoice && deposits.deposits.some((d) => d.applicable > 0);
  if (!invoice) return null;

  const statusKey = invoiceStatusLabelKey(invoice.status);
  // The invoice's own currency, not the app's — Books states the amount in
  // the currency the client is billed in.
  const currency = invoice.currency_code || appCurrency;
  const dates = invoice.date
    ? t('aito.invoiceDatesTitle', { date: invoice.date, due: invoice.due_date || '—' })
    : undefined;

  // One element, not a fragment: BillingCard stacks the rows in a `divide-y`
  // wrapper, and a fragment would put a hairline between the row and its note.
  return (
    <div>
      <DocumentRow
        testId="invoice-block"
        label={t('aito.invoiceLabel')}
        // Falls back to the id: Books returns an unnumbered invoice before it is finalised.
        number={invoice.number || invoice.id}
        numberTitle={dates}
        status={
          invoice.status
            ? {
                text: statusKey ? t(statusKey) : invoice.status,
                toneClass: INVOICE_STATUS_TEXT_TONE_CLASSES[invoiceStatusTone(invoice.status)],
              }
            : null
        }
        amount={formatMoney(invoice.total, currency)}
        // `url` can be "" after the send route's post-send degrade (see routes/aito.py); no link then.
        booksUrl={invoice.url || null}
        booksLabel={t('aito.invoiceOpenInZoho')}
        // Neither PDF button waits on a pending quote sync here: the endpoint
        // pushes the card first (`ensure_pushed`), then returns the PDF.
        extra={
          canApply ? (
            <button
              type="button"
              onClick={() => setApplying(true)}
              aria-label={t('aito.applyDeposit')}
              title={t('aito.applyDeposit')}
              data-testid="apply-deposit"
              className={DOC_ICON_BUTTON_CLS}
            >
              <PiggyBank className={LINK_ICON_CLS} aria-hidden="true" />
            </button>
          ) : undefined
        }
        print={<InvoicePrintButton projectId={project.id} invoiceId={invoice.id} variant="icon" />}
        download={
          <InvoiceDownloadButton
            projectId={project.id}
            invoiceId={invoice.id}
            invoiceNumber={invoice.number}
            variant="icon"
          />
        }
        // POST /{project_id}/invoice-email enforces AITO_UPDATE — the same gate SendQuoteButton's call site applies.
        send={
          canUpdate ? (
            <SendInvoiceButton
              projectId={project.id}
              document={{ kind: 'invoice', id: invoice.id }}
              contactPersonId={project.client_contact_person_id}
              variant="icon"
            />
          ) : undefined
        }
      />
      {/* Books can invoice one estimate in parts; the row shows the newest and says so. */}
      {invoice.invoice_count > 1 && (
        <p className="pb-1.5 text-xs text-bambu-gray">
          {t('aito.invoiceMoreCount', { count: invoice.invoice_count - 1 })}
        </p>
      )}
      {applying && deposits && (
        <ApplyDepositModal projectId={project.id} data={deposits} onClose={() => setApplying(false)} />
      )}
    </div>
  );
}
