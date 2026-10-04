import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AitoProject } from '../../api/client';
import { InvoiceCard } from './InvoiceCard';
import { PanelCard } from './PanelCard';
import { DocumentRow } from './DocumentRow';
import { PaymentBlock } from './payment/PaymentBlock';
import { invoiceDocument, quoteDocument } from './payment/paymentDocument';
import { derivePaymentState, terminalFor } from './payment/paymentState';
import { QuoteDownloadButton } from './QuoteDownloadButton';
import { QuotePrintButton } from './QuotePrintButton';
import { SendQuoteButton } from './SendQuoteButton';
import { RetainerDownloadButton } from './RetainerDownloadButton';
import { RetainerPrintButton } from './RetainerPrintButton';
import { SendInvoiceButton } from './SendInvoiceButton';
import { QUOTE_STATUS_TEXT_TONE_CLASSES, quoteStatusText, quoteStatusTone } from './quoteStatus';
import { RETAINER_STATUS_TEXT_TONE_CLASSES, retainerStatusLabelKey, retainerStatusTone } from './retainerStatus';
import { deriveQuoteSync } from './quoteSync';
import { useAitoInvoice } from './useAitoInvoice';
import { useAitoRetainers } from './useAitoRetainers';
import { formatMoney } from '../../utils/pricing';

/** Every Zoho document of the project — the quote, each retainer (deposit)
 *  invoice, the invoice — as one `DocumentRow` each, in that order, then the
 *  collect section (deposit available, the quote's and the invoice's
 *  `PaymentBlock`), then the sync facts. One card because they are one
 *  story; one row shape because the previous twin cards each carried their
 *  own three-cell action bar, which read as a second copy of the collect
 *  block's bar.
 *
 *  Gated on `quote_number || hasQuoteMessage`, not just the number: a
 *  hand-made project has no quote at all and gets no empty "Billing" heading,
 *  but a sync error or a status block on a project whose number is missing
 *  must still reach someone (see quoteSync.ts). The quote is a snapshot, so
 *  its row renders with Zoho unreachable; only the retainer rows and the
 *  invoice row need Zoho.
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
  heimdallConfigured,
}: {
  project: AitoProject;
  canUpdate: boolean;
  /** The shop currency (`useCurrency()`), for the deposit-available row and
   *  for a retainer Books returns without a currency of its own. */
  currency: string;
  /** Re-marks the project pending for the sync worker (a PATCH carrying the
   *  unchanged description — see the panel's `updateMutation`). */
  onRetrySync: () => void;
  retryPending: boolean;
  /** Queues a locked-but-not-invoiced card for one more push attempt
   *  (POST /aito/{id}/sync — see the panel's `forceSyncMutation`). */
  onForceSync: () => void;
  forcePending: boolean;
  /** `AppSettings.aito_deposit_pct`, passed through to the quote's
   *  `PaymentBlock` (`quoteDocument`) to compute what is still due. */
  depositPct?: number;
  /** Whether Heimdall is configured (`AppSettings.heimdall_base_url`) —
   *  passed down to both `PaymentBlock`s so their terminal cell can disable
   *  itself with an explanation rather than starting a charge Heimdall can
   *  never process. */
  heimdallConfigured: boolean;
}) {
  const { t } = useTranslation();
  const { syncLabelKey, blockKey, hasQuoteMessage, canForceSync } = deriveQuoteSync(project);
  // Both queries are shared with the rows that render them (InvoiceCard and
  // RetainerRows call the same hooks) — one cache entry each, one request.
  const invoice = useAitoInvoice(project).data;

  // "Up to date in Zoho" is a confirmation, not a status: it is shown only
  // once this panel has watched a pending push land, and never on a card
  // that was idle all along (a row saying so on every card would be noise).
  const syncPending = project.quote_sync_state === 'pending';
  // Which card this panel has seen pending. Adjusted during render (React's
  // pattern for state derived from props) rather than in an effect, so the
  // confirmation is there on the very render the push lands.
  const [pendingSeenFor, setPendingSeenFor] = useState<number | null>(syncPending ? project.id : null);
  if (syncPending && pendingSeenFor !== project.id) setPendingSeenFor(project.id);
  const justSynced = pendingSeenFor === project.id && project.quote_sync_state === 'idle';
  // A managed card whose quote Zoho has not created yet.
  const creatingQuote = !project.quote_number && syncPending;

  if (!project.quote_number && !hasQuoteMessage && !justSynced) return null;

  const statusLabel = (status: string | null): string => quoteStatusText(t, status);
  // Once the job is billed the deposit is moot: collect on the invoice. The
  // backend cancels the link and refuses new deposit payments; the block only
  // stays while a deposit tap is still on the terminal, so a payment in
  // progress, or one a human must resolve, is never hidden mid-way.
  const quoteTerminal = terminalFor(project, 'quote');
  const depositState = derivePaymentState(project.payment_link ?? null, quoteTerminal).kind;
  const depositInFlight = depositState === 'terminal_processing' || depositState === 'terminal_attention';
  const quotePay = project.quote_invoiced && !depositInFlight ? null : quoteDocument(project, depositPct, currency);
  const hasCredit = project.customer_credit_total != null && project.customer_credit_total > 0;

  return (
    <PanelCard title={t('aito.billingLabel')}>
      {/* The quote row also renders while the quote is still being created:
          Print and Download are already useful then — their endpoint waits
          for the creation. */}
      {(project.quote_number || creatingQuote) && (
        <div className="divide-y divide-bambu-dark-tertiary -mt-1.5">
          <DocumentRow
            testId="doc-quote"
            label={t('aito.quoteSearchLabel')}
            number={project.quote_number ?? t('aito.quotePending')}
            numberTitle={project.quote_date ?? undefined}
            status={
              project.quote_status
                ? {
                    text: quoteStatusText(t, project.quote_status),
                    toneClass: QUOTE_STATUS_TEXT_TONE_CLASSES[quoteStatusTone(project.quote_status)],
                  }
                : null
            }
            booksUrl={project.quote_url}
            booksLabel={t('aito.quoteOpenInZoho')}
            print={<QuotePrintButton project={project} variant="icon" />}
            download={<QuoteDownloadButton project={project} variant="icon" />}
            send={canUpdate && project.quote_number ? <SendQuoteButton project={project} variant="icon" /> : undefined}
          />
          <RetainerRows project={project} canUpdate={canUpdate} currency={currency} />
          <InvoiceCard project={project} canUpdate={canUpdate} />
        </div>
      )}

      {/* The collect section, under a hairline: what the customer has on
          account, then what is still due on the quote's deposit and on the
          invoice's balance. Each PaymentBlock renders itself away when
          nothing is due and nothing is in flight; the hairline only appears
          when at least one part does. */}
      {project.quote_number && (hasCredit || quotePay || invoice) && (
        <CollectSection>
          {/* "Deposit available" is the CUSTOMER's unspent credit across every deposit (`customer_credit_total`,
              read from their payments' unused amounts), not the estimate's own paid retainers
              (`retainer_paid_total`, which drives the quote-level auto-accept and payment link). */}
          {hasCredit && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-sm items-baseline">
              <dt className="text-bambu-gray">{t('aito.depositAvailable')}</dt>
              <dd className="text-right text-bambu-green">
                {formatMoney(project.customer_credit_total as number, currency)}
              </dd>
            </dl>
          )}
          {quotePay && (
            <PaymentBlock
              project={project}
              document={quotePay}
              link={project.payment_link ?? null}
              terminal={quoteTerminal}
              canUpdate={canUpdate}
              heimdallConfigured={heimdallConfigured}
            />
          )}
          {invoice && (
            <PaymentBlock
              project={project}
              document={invoiceDocument(invoice)}
              link={project.invoice_payment_link ?? null}
              terminal={terminalFor(project, 'invoice')}
              canUpdate={canUpdate}
              heimdallConfigured={heimdallConfigured}
            />
          )}
        </CollectSection>
      )}

      {/* Sync facts, under the quote rows they are about. <dt>/<dd> gives
          assistive technology the label-to-value association for free; the
          colon is markup, so no locale string carries punctuation. The whole
          list renders only when there is something to say — a hairline over
          nothing, or a row reading "up to date" on every idle card, would be
          noise, not information. The one "up to date" it does show is the
          confirmation of a push this panel watched land (`justSynced`). */}
      {(hasQuoteMessage || justSynced) && (
        <dl
          className={`space-y-2 text-sm ${project.quote_number || creatingQuote ? 'mt-2 pt-2 border-t border-bambu-dark-tertiary' : ''}`}
        >
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
          {justSynced && !syncLabelKey && (
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-bambu-gray flex-shrink-0">{t('aito.sync')}:</dt>
              <dd className="text-bambu-green min-w-0 text-right">{t('aito.syncUpToDate')}</dd>
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
    </PanelCard>
  );
}

const COLLECT_SECTION_CLS =
  'empty:hidden has-[*]:mt-2 has-[*]:border-t has-[*]:border-bambu-dark-tertiary has-[*]:pt-2 space-y-2';

/** The collect section's hairline, drawn with CSS rather than a JS check:
 *  `has-[*]` matches only when the wrapper has at least one element child,
 *  and a `PaymentBlock` that renders null contributes no element. */
function CollectSection({ children }: { children: ReactNode }) {
  return <div className={COLLECT_SECTION_CLS}>{children}</div>;
}

/** One `DocumentRow` per retainer (deposit) invoice, between the quote and
 *  the invoice. Its own component so the query hook runs inside the list —
 *  nothing else in the card waits on it, and an error or an empty list
 *  simply renders no rows (same policy as `InvoiceCard`). */
function RetainerRows({
  project,
  canUpdate,
  currency,
}: {
  project: AitoProject;
  canUpdate: boolean;
  /** The shop currency — the fallback when a retainer carries no currency code. */
  currency: string;
}) {
  const { t } = useTranslation();
  const rows = useAitoRetainers(project).data ?? [];
  return (
    <>
      {rows.map((r) => {
        const key = retainerStatusLabelKey(r.status);
        return (
          <DocumentRow
            key={r.id}
            testId={`doc-retainer-${r.id}`}
            label={t('aito.retainerLabel')}
            number={r.number}
            numberTitle={r.date || undefined}
            status={
              r.status
                ? {
                    text: key ? t(key) : r.status,
                    toneClass: RETAINER_STATUS_TEXT_TONE_CLASSES[retainerStatusTone(r.status)],
                  }
                : null
            }
            amount={formatMoney(r.total, r.currency_code || currency)}
            booksUrl={r.url || null}
            booksLabel={t('aito.invoiceOpenInZoho')}
            print={<RetainerPrintButton projectId={project.id} retainerId={r.id} variant="icon" />}
            download={
              <RetainerDownloadButton
                projectId={project.id}
                retainerId={r.id}
                retainerNumber={r.number}
                variant="icon"
              />
            }
            send={
              canUpdate ? (
                <SendInvoiceButton
                  projectId={project.id}
                  document={{ kind: 'retainer', id: r.id }}
                  contactPersonId={project.client_contact_person_id}
                  variant="icon"
                />
              ) : undefined
            }
          />
        );
      })}
    </>
  );
}
