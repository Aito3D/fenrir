import type { TFunction } from 'i18next';
import { ApiError } from '../../api/client';

/** The order moved under the operator (changed, gone from the board, or being written): its screen is out of date. */
export const isRefused = (e: unknown): boolean => e instanceof ApiError && (e.status === 400 || e.status === 404 || e.status === 409);

const REASON_CODES = ['version', 'below_floor', 'unknown_item', 'service_line', 'nothing_changed', 'package_shipped', 'package_changed',
  'picklist_open', 'unknown_line', 'bad_quantity', 'too_many', 'picklist_shared'];

/** The refusal code: the server sends it as the plain-string detail, which becomes the message. */
const reasonCode = (e: ApiError): string | null => {
  const code = e.code ?? e.message;
  return REASON_CODES.includes(code) ? code : null;
};

/** Zoho busy, a refusal, or the message Books answered a 502 with. */
export const errorReason = (t: TFunction, e: unknown): string =>
  e instanceof ApiError && e.status === 503 ? t('orders.busy')
  : e instanceof ApiError && e.status === 400 && reasonCode(e) ? t(`orders.err.${reasonCode(e)}`, { defaultValue: t('orders.parcel.stale') })
  : isRefused(e) ? t('orders.parcel.stale')
  : e instanceof Error ? e.message : '';
