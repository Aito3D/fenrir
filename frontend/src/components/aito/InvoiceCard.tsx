import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api, type AitoProject } from '../../api/client';
import { PanelCard } from './PanelCard';
import { InvoicePrintButton } from './InvoicePrintButton';
import { SendInvoiceButton } from './SendInvoiceButton';
import { INVOICE_STATUS_TEXT_TONE_CLASSES, invoiceStatusLabelKey, invoiceStatusTone } from './invoiceStatus';
import { Money } from '../calculator/shared';
import { useCurrency } from '../../hooks/useCurrency';

/** How long an invoice stays fresh before the panel re-asks Books.
 *
 *  Five minutes, not the hour `aito-shipping-services` uses: that is a rate
 *  card that changes twice a year, this is a payment status that changes the
 *  afternoon the client pays. Long enough that reopening the same panel a few
 *  times costs one request, short enough that "Unpaid" does not outlive the
 *  payment by a working day. */
const INVOICE_STALE_MS = 5 * 60_000;

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

  // Gated twice over, and the second half is not redundant. `quote_invoiced`
  // is the cheap, reliable signal — but it is written ONLY by the quote sync
  // sweep, and a project left 'unmanaged' (legacy or imported cards the sync
  // must never touch) never enters that sweep, so its flag stays false
  // forever even when Books has invoiced it. Without the second clause those
  // cards could never show an invoice at all. Managed projects therefore cost
  // no request until they are actually billed; unmanaged ones pay one cached
  // lookup per panel open, which is the only way they can ever be right.
  const mayHaveInvoice =
    Boolean(project.quote_id) && (project.quote_invoiced || project.quote_sync_state === 'unmanaged');

  const invoiceQuery = useQuery({
    queryKey: ['aito-invoice', project.id],
    queryFn: () => api.getAitoInvoice(project.id),
    enabled: mayHaveInvoice,
    staleTime: INVOICE_STALE_MS,
    // The app default is `retry: 1` (App.tsx). Overridden because the failure
    // this endpoint actually produces is a 502 — Zoho unreachable or
    // unconfigured — and neither self-heals within one retry. All a retry buys
    // is a second request against a failing upstream and another wait on its
    // 10s timeout, for a card that hides itself either way.
    retry: false,
  });

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
      <div className="flex gap-2 mt-3">
        <InvoicePrintButton projectId={project.id} invoiceId={invoice.id} className="flex-1 justify-center" />
        {/* POST /{project_id}/invoice-email enforces AITO_UPDATE — same gate,
            same call site pattern, as SendQuoteButton one card up. */}
        {canUpdate && (
          <SendInvoiceButton projectId={project.id} invoiceId={invoice.id} className="flex-1 justify-center" />
        )}
      </div>
    </PanelCard>
  );
}
