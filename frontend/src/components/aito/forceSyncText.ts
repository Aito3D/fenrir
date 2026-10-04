import type { TFunction } from 'i18next';
import type { AitoForceSyncStep } from '../../api/client';
import { formatMoney } from '../../utils/pricing';
import { quoteStatusText } from './quoteStatus';

const OUTCOME_KEY = {
  in_sync: 'aito.forceSyncInSync',
  fixed: 'aito.forceSyncFixed',
  failed: 'aito.forceSyncFailed',
  skipped: 'aito.forceSyncSkipped',
} as const;

const REASON_KEY: Record<string, string> = {
  no_quote: 'aito.forceSyncReasonNoQuote',
  unmanaged: 'aito.forceSyncReasonUnmanaged',
  not_invoiced: 'aito.forceSyncReasonNotInvoiced',
  not_configured: 'aito.forceSyncReasonNotConfigured',
  rate_limited: 'aito.forceSyncReasonRateLimited',
  worker_unavailable: 'aito.forceSyncReasonWorkerUnavailable',
  timeout: 'aito.forceSyncReasonTimeout',
  no_client: 'aito.forceSyncReasonNoClient',
  unreachable: 'aito.forceSyncReasonUnreachable',
  refused: 'aito.forceSyncReasonRefused',
  upstream: 'aito.forceSyncReasonUpstream',
  internal: 'aito.forceSyncReasonInternal',
};

/** Reasons that mean something else on one step: the payment links talk to
 *  Heimdall, not Zoho, and the invoice step's refusal is a deposit, not a push. */
const STEP_REASON_KEY: Partial<Record<AitoForceSyncStep['key'], Record<string, string>>> = {
  payment_links: {
    rate_limited: 'aito.forceSyncReasonHeimdallRateLimited',
    not_configured: 'aito.forceSyncReasonHeimdallNotConfigured',
    upstream: 'aito.forceSyncReasonHeimdallUpstream',
  },
  invoice: {
    refused: 'aito.forceSyncReasonDepositRefused',
  },
};

function reasonKey(step: AitoForceSyncStep['key'], reason: string): string | null {
  const own = STEP_REASON_KEY[step];
  if (own && Object.hasOwn(own, reason)) return own[reason];
  return Object.hasOwn(REASON_KEY, reason) ? REASON_KEY[reason] : null;
}

type Change = { before?: unknown; after?: unknown };

/** One report row's text. The server sends machine reasons; the words live
 *  here. A reason this build has never heard of is shown raw, not dropped. */
export function forceSyncStepText(
  t: TFunction,
  step: AitoForceSyncStep,
  currency: string,
): { label: string; detail: string | null } {
  const d = step.detail;
  // The invoice step names its own currency; everything else is the app's.
  const stepCurrency = typeof d.currency_code === 'string' && d.currency_code ? d.currency_code : currency;
  const money = (v: unknown) => (typeof v === 'number' ? formatMoney(v, stepCurrency) : '—');
  const status = (v: unknown) => quoteStatusText((k) => t(k), typeof v === 'string' ? v : null);
  let detail: string | null = null;
  if (typeof d.message === 'string' && d.message) {
    detail = d.message;
  } else if (typeof d.reason === 'string') {
    const key = reasonKey(step.key, d.reason);
    detail = key ? t(key) : d.reason;
  } else if (step.outcome === 'fixed' && step.key === 'credit') {
    detail = t('aito.forceSyncCreditChanged', { before: money(d.before), after: money(d.after) });
  } else if (step.outcome === 'fixed' && step.key === 'invoice') {
    detail = t('aito.forceSyncInvoiceApplied', {
      number: String(d.number ?? ''),
      before: money(d.balance_before),
      after: money(d.balance_after),
    });
  } else if (step.outcome === 'fixed' && step.key === 'quote') {
    const parts: string[] = [];
    const total = d.total as Change | undefined;
    const st = d.status as Change | undefined;
    if (total) parts.push(t('aito.forceSyncQuoteTotalChanged', { before: money(total.before), after: money(total.after) }));
    if (st) parts.push(t('aito.forceSyncStatusChanged', { before: status(st.before), after: status(st.after) }));
    if (d.error_cleared === true) parts.push(t('aito.forceSyncErrorCleared'));
    detail = parts.length ? parts.join(' · ') : null;
  }
  return { label: t(OUTCOME_KEY[step.outcome]), detail };
}
