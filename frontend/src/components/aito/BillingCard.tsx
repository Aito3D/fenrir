import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import type { AitoProject } from '../../api/client';
import { InvoiceCard } from './InvoiceCard';
import { PanelCard } from './PanelCard';
import { PaymentLinkRow } from './PaymentLinkRow';
import { QuoteDownloadButton } from './QuoteDownloadButton';
import { QuotePrintButton } from './QuotePrintButton';
import { SendQuoteButton } from './SendQuoteButton';
import { ACTION_GROUP } from './quoteActionGroup';
import { QUOTE_STATUS_TEXT_TONE_CLASSES, quoteStatusText, quoteStatusTone } from './quoteStatus';
import { deriveQuoteSync } from './quoteSync';
import { formatMoney } from '../../utils/pricing';

/** The quote and, once Books has raised one, the invoice — one card, in that
 *  order, because they are one story and the two used to sit as twin cards
 *  with the same rows, the same link-out on the number and the same
 *  Print / Download / Send row, a heading and a border apart.
 *
 *  Gated on `quote_number || hasQuoteMessage`, not just the number: a
 *  hand-made project has no quote at all and gets no empty "Billing" heading,
 *  but a sync error or a status block on a project whose number is missing
 *  must still reach someone (see quoteSync.ts). The quote is a snapshot, so
 *  the rows render with Zoho unreachable; only the link and the invoice block
 *  need Zoho.
 *
 *  Create invoice is NOT here any more. It is the panel's one irreversible
 *  commitment and lives in the footer with the other transitions, where a
 *  tab can never hide it. */
export function BillingCard({
  project,
  canUpdate,
  onRetrySync,
  retryPending,
  onForceSync,
  forcePending,
  depositPct = 0,
  currency,
}: {
  project: AitoProject;
  canUpdate: boolean;
  /** The shop currency (`useCurrency()`), for the paid-deposit row. */
  currency: string;
  /** Re-marks the project pending for the sync worker (a PATCH carrying the
   *  unchanged description — see the panel's `updateMutation`). */
  onRetrySync: () => void;
  retryPending: boolean;
  /** Queues a locked-but-not-invoiced card for one more push attempt
   *  (POST /aito/{id}/sync — see the panel's `forceSyncMutation`). */
  onForceSync: () => void;
  forcePending: boolean;
  /** `AppSettings.aito_deposit_pct`, passed through to `PaymentLinkRow` so it
   *  can tell whether a paid link still covers the current quote total. */
  depositPct?: number;
}) {
  const { t } = useTranslation();
  const { syncLabelKey, blockKey, hasQuoteMessage, canForceSync } = deriveQuoteSync(project);

  if (!project.quote_number && !hasQuoteMessage) return null;

  const statusLabel = (status: string | null): string => quoteStatusText(t, status);

  return (
    <PanelCard title={t('aito.billingLabel')}>
      {project.quote_number && (
        <>
          {/* Labelled "Quote", not "Number": the invoice rows share this list
              now, and two "Number" rows in one card would name neither.
              Status repeats the quote's Zoho status already shown as the
              header's eyebrow pill — this is the row someone scanning the
              Details tab (rather than the header) reaches for it from.
              Rendered only when there is a status to show, same omission
              rule the seller/email rows elsewhere in the panel follow. */}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm items-baseline">
            <dt className="text-bambu-gray">{t('aito.quoteSearchLabel')}</dt>
            <dd className="text-right min-w-0">
              {project.quote_url ? (
                <a
                  href={project.quote_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t('aito.quoteOpenInZoho')}
                  className="text-white hover:text-bambu-green inline-flex items-center gap-1 min-w-0 truncate"
                >
                  {project.quote_number}
                  <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
                </a>
              ) : (
                <span className="min-w-0 truncate text-white">{project.quote_number}</span>
              )}
            </dd>
            {project.quote_status && (
              <>
                <dt className="text-bambu-gray">{t('common.status')}</dt>
                <dd className={`text-right ${QUOTE_STATUS_TEXT_TONE_CLASSES[quoteStatusTone(project.quote_status)]}`}>
                  {quoteStatusText(t, project.quote_status)}
                </dd>
              </>
            )}
            {/* What the CUSTOMER still has on account across every deposit
                (`customer_credit_total`, read by the status reconcile from
                their payments' unused amounts) — not the estimate's own paid
                retainers (`retainer_paid_total`, which drives the quote-level
                auto-accept and payment link). A retainer raised by hand in
                Books references no quote and only ever shows here; a deposit
                spent on any invoice leaves here on the next tick, at once
                when this app raised the invoice. Shown only while there is
                something to spend, so the operator can see the bill will be
                partly covered before it exists. */}
            {project.customer_credit_total != null && project.customer_credit_total > 0 && (
              <>
                <dt className="text-bambu-gray">{t('aito.depositAvailable')}</dt>
                <dd className="text-right text-bambu-green">{formatMoney(project.customer_credit_total, currency)}</dd>
              </>
            )}
          </dl>

          {/* The online payment link's row — part of the same quote story as
              Number and Status above, so it sits inside this card, under
              them, before the actions. Renders itself away without a link. */}
          <PaymentLinkRow project={project} canUpdate={canUpdate} depositPct={depositPct} />

          {/* Print / download / send as one segmented control; the labels
              live on aria-label + title (see quoteActionGroup.ts for the
              measurements). "Open in Zoho" is absent on purpose: the number
              above already goes there. The invoice block's row is identical. */}
          <div className={ACTION_GROUP}>
            <QuotePrintButton project={project} />
            {/* Reads the same PDF the print button does, but saves it. */}
            <QuoteDownloadButton project={project} />
            {/* POST /{project_id}/quote-email enforces AITO_UPDATE. When it
                is absent the group is a two-cell control, which the gap-px
                dividers handle without any last-child rule. */}
            {canUpdate && <SendQuoteButton project={project} />}
          </div>
        </>
      )}

      {/* Sync facts, under the quote rows they are about. <dt>/<dd> gives
          assistive technology the label-to-value association for free; the
          colon is markup, so no locale string carries punctuation. The whole
          list renders only when there is something to say — a hairline over
          nothing, or a row reading "up to date" on every idle card, would be
          noise, not information. */}
      {hasQuoteMessage && (
        <dl className={`space-y-2 text-sm ${project.quote_number ? 'mt-2 pt-2 border-t border-bambu-dark-tertiary' : ''}`}>
          {syncLabelKey && (
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-bambu-gray flex-shrink-0">{t('aito.sync')}:</dt>
              <dd className="text-white min-w-0 text-right">
                {t(syncLabelKey)}
                {project.quote_sync_error && (
                  <span className="block text-xs text-bambu-gray">{project.quote_sync_error}</span>
                )}
                {project.quote_sync_state === 'error' && (
                  <button
                    type="button"
                    onClick={onRetrySync}
                    disabled={retryPending}
                    className="block ml-auto mt-1 text-xs text-bambu-green hover:text-bambu-green/80 disabled:opacity-50"
                  >
                    {t('aito.retrySync')}
                  </button>
                )}
                {/* The escape hatch out of a refusal-to-push lock — today
                    that means a tax-exclusive estimate, whose message sits
                    right above this button (see quoteSync.ts's
                    `canForceSync`). A lock leaves the sync sweep for good, so
                    without this the card stays stuck at the refusal even
                    after the estimate has been fixed in Books, and nothing
                    the operator can do here would ever make the app look
                    again.
                    It forces the ATTEMPT, not the write: the worker re-reads
                    the estimate and its own guard still decides, so a quote
                    that is still tax-exclusive simply re-locks with the same
                    message and no line items are pushed. Gated on
                    `canUpdate` because POST /aito/{id}/sync enforces
                    AITO_UPDATE — same rule SendQuoteButton above follows. */}
                {canForceSync && canUpdate && (
                  <button
                    type="button"
                    onClick={onForceSync}
                    disabled={forcePending}
                    title={t('aito.forceSyncHint')}
                    className="block ml-auto mt-1 text-xs text-bambu-green hover:text-bambu-green/80 disabled:opacity-50"
                  >
                    {t('aito.forceSync')}
                  </button>
                )}
              </dd>
            </div>
          )}

          {/* Independent of the sync row, and for the same reason it had to
              be moved out of it: the sync row only renders for
              pending/error/locked, and a card left declined — restored from
              the trash, or re-imported from a declined quote — is normally
              'idle', so the one sentence explaining why it is stuck rendered
              exactly never. */}
          {project.quote_status === 'declined' && (
            <div className="flex items-baseline gap-2">
              <dd className="ml-0 w-full text-xs text-bambu-gray">{t('aito.quoteDeclinedNoDraft')}</dd>
            </div>
          )}

          {/* Rendered for ANY quote_sync_state, unlike the sync row above: the
              reconciler records a block as a fact of its own, and a card can
              be perfectly 'idle' for the line-item sync while its STATUS is
              stuck against Books. No <dt>: the sentence names both sides
              itself, so it spans the row. */}
          {blockKey && (
            <div className="flex items-baseline gap-2">
              <dd className="ml-0 w-full text-status-error">
                {t(blockKey, {
                  ours: statusLabel(project.quote_status),
                  theirs: statusLabel(project.quote_status_remote),
                })}
              </dd>
            </div>
          )}
        </dl>
      )}

      {/* The quote's next chapter, under a hairline of its own. Renders
          itself away when there is no invoice — see InvoiceCard. `canUpdate`
          is passed through so it can gate its own Send button the same way
          the quote row gates SendQuoteButton above. */}
      <InvoiceCard project={project} canUpdate={canUpdate} />
    </PanelCard>
  );
}
