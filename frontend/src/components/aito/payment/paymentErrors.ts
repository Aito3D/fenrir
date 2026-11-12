import type { TFunction } from 'i18next';
import { ApiError } from '../../../api/client';

/** A refused payment in the viewer's language. The payment routes answer
 *  `{code, message}`; a code with an `aito.payment.err.*` string is
 *  translated, and any other (an upstream message from Books or Heimdall,
 *  a refusal naming a retainer or a payment id) keeps the server's own
 *  sentence, which carries detail a fixed string cannot. */
export function paymentErrorText(t: TFunction, e: unknown): string {
  const message = e instanceof Error && e.message ? e.message : t('common.errorLoading');
  return e instanceof ApiError && e.code ? t(`aito.payment.err.${e.code}`, { defaultValue: message }) : message;
}
