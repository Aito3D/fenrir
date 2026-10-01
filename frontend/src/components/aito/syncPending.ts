import type { TFunction } from 'i18next';
import { ApiError } from '../../api/client';

/** The code of the 503 a document or invoice route answers when it pushed
 *  the card's pending changes to Zoho and they did not land in time (see
 *  `ensure_pushed` in routes/aito.py). */
export const SYNC_PENDING_CODE = 'sync_pending';

export function isSyncPendingError(error: unknown): boolean {
  return error instanceof ApiError && error.code === SYNC_PENDING_CODE;
}

/** The toast for a failed document action: the "Zoho has not confirmed"
 *  sentence when that is what happened, the caller's own message otherwise. */
export function documentFailureMessage(error: unknown, fallback: string, t: TFunction): string {
  return isSyncPendingError(error) ? t('aito.syncNotConfirmed') : fallback;
}
