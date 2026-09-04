import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import type { AitoProject } from '../../api/client';
import { useAitoInvoice } from './useAitoInvoice';
import { PanelCard } from './PanelCard';
import { InvoiceDownloadButton } from './InvoiceDownloadButton';
import { InvoicePrintButton } from './InvoicePrintButton';
import { SendInvoiceButton } from './SendInvoiceButton';
import { INVOICE_STATUS_TEXT_TONE_CLASSES, invoiceStatusLabelKey, invoiceStatusTone } from './invoiceStatus';
import { Money } from '../calculator/shared';
import { useCurrency } from '../../hooks/useCurrency';
import { ACTION_GROUP } from './quoteActionGroup';

/** The Zoho invoice raised from this project's quote.
 *
 *  The Quote card's twin, one card lower — same PanelCard shell, same
 *  definition-list rows, same link-out affordance on the number. The
 *  difference that matters is where the data comes from: every quote field is
 *  a snapshot on the project row and renders with Zoho unreachable, while
 *  this is fetched live on panel open. That is deliberate (see
 *  `AitoInvoiceResponse`) — a stored "Unpaid" is wrong the moment the client
 *  pays, and a stale payment status is worse than an absent card.
 *
 *  Renders nothing at all while loading, on error, and when there is no
 *  invoice. An empty "Invoice" heading over a spinner would be exactly the
 *  noise the Quote card's own gating comment argues against, and the card is
 *  additive information: a panel without it is still complete.
 */
export function InvoiceCard({ project, canUpdate }: { project: AitoProject; canUpdate: boolean }) {
  const { t } = useTranslation();
  const appCurrency = useCurrency();

  // The gating (can this project have an invoice at all?) and the fetch both
  // live in `useAitoInvoice`, shared with the shipping label so the panel
  // never asks Books twice for one project.
  const invoiceQuery = useAitoInvoice(project);

  const invoice = invoiceQuery.data;
  if (!invoice) return null;

  const statusKey = invoiceStatusLabelKey(invoice.status);
  // The invoice's own currency, not the app's: Books states the amount in the
  // currency the client is billed in, and relabelling that with the board's
  // display currency would put the wrong symbol on a real number. The app
  // currency is only the fallback for an invoice that arrived without one.
  const currency = invoice.currency_code || appCurrency;

  return (
    <PanelCard title={t('aito.invoiceLabel')}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm items-baseline">
        <dt className="text-bambu-gray">{t('aito.invoiceNumberLabel')}</dt>
        <dd className="text-right min-w-0">
          {/* `url` is normally never empty — GET /invoice 502s rather than
              returning one. The one path that produces `""` is the send
              route's own post-send degrade (see routes/aito.py), and
              `useSendInvoiceMutation` writes that response straight into this
              card's cache. An `<a href="">` self-navigates: it reloads the
              whole SPA and drops the panel, which reads as far worse than a
              plain-text row the next 5-minute refetch quietly upgrades back
              into a link. */}
          {invoice.url ? (
            <a
              href={invoice.url}
              target="_blank"
              rel="noopener noreferrer"
              title={t('aito.invoiceOpenInZoho')}
              className="text-white hover:text-bambu-green inline-flex items-center gap-1 min-w-0 truncate"
            >
              {/* Falls back to the id: Books has returned an invoice with no
                  number before it is finalised, and a link whose only visible
                  content is an external-link icon is unclickable-looking and
                  says nothing about where it goes. */}
              {invoice.number || invoice.id}
              <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
            </a>
          ) : (
            <span className="text-white inline-block min-w-0 truncate">{invoice.number || invoice.id}</span>
          )}
        </dd>

        {/* `common.date`, not a new aito key: it is the same word, already
            translated in all 13 locales and already carrying the parity
            allowlist entries a bare "Date" needs. */}
        {invoice.date && (
          <>
            <dt className="text-bambu-gray">{t('common.date')}</dt>
            <dd className="text-right text-white">{invoice.date}</dd>
          </>
        )}

        <dt className="text-bambu-gray">{t('aito.invoiceTotalLabel')}</dt>
        <dd className="text-right text-white">
          <Money value={invoice.total} currency={currency} />
        </dd>

        {/* Only when something is still owed. On a paid invoice this row would
            read "0" under a Status already saying "Paid" — the same fact
            twice, which is what the omitted rows elsewhere in this panel
            exist to avoid. */}
        {invoice.balance > 0 && (
          <>
            <dt className="text-bambu-gray">{t('aito.invoiceBalanceLabel')}</dt>
            <dd className="text-right text-status-warning">
              <Money value={invoice.balance} currency={currency} />
            </dd>
          </>
        )}

        {invoice.status && (
          <>
            <dt className="text-bambu-gray">{t('common.status')}</dt>
            <dd className={`text-right ${INVOICE_STATUS_TEXT_TONE_CLASSES[invoiceStatusTone(invoice.status)]}`}>
              {statusKey ? t(statusKey) : invoice.status}
            </dd>
          </>
        )}
      </dl>

      {/* Books can invoice one estimate in parts. The card shows the newest,
          and says so rather than letting it look like the only one — an
          operator who prints "the" invoice on a part-billed job would
          otherwise never learn there were others. */}
      {invoice.invoice_count > 1 && (
        <p className="mt-2 text-xs text-bambu-gray">
          {t('aito.invoiceMoreCount', { count: invoice.invoice_count - 1 })}
        </p>
      )}

      {/* Print and Send, both flex-1: the pair mirrors the Quote card's own
          row so the two cards read as one family. "Open in Zoho" is still
          absent for the same reason it always was — the number above already
          goes there. */}
      {/* The same segmented control as the Quote card's row, deliberately: the
          two cards share that 230.4px column and are meant to read as one
          family. See quoteActionGroup.ts. */}
      {/* Both PDF buttons sit out a pending quote sync: the invoice has no
          sync state of its own, so the project's is the only signal that an
          edit is still on its way to Zoho — and until it lands, the PDF
          Books returns may not match what the operator sees here. */}
      <div className={ACTION_GROUP}>
        <InvoicePrintButton
          projectId={project.id}
          invoiceId={invoice.id}
          disabled={project.quote_sync_state === 'pending'}
        />
        {/* Saves the same PDF the print button fetches, named after the
            invoice number. */}
        <InvoiceDownloadButton
          projectId={project.id}
          invoiceId={invoice.id}
          invoiceNumber={invoice.number}
          disabled={project.quote_sync_state === 'pending'}
        />
        {/* POST /{project_id}/invoice-email enforces AITO_UPDATE — same gate,
            same call site pattern, as SendQuoteButton one card up. */}
        {canUpdate && <SendInvoiceButton projectId={project.id} invoiceId={invoice.id} />}
      </div>
    </PanelCard>
  );
}
