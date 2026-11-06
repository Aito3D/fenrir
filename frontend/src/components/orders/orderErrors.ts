import type { TFunction } from 'i18next';
import { ApiError } from '../../api/client';

/** The order moved under the operator (changed, gone from the board, or being written): its screen is out of date. */
export const isRefused = (e: unknown): boolean => e instanceof ApiError && (e.status === 400 || e.status === 404 || e.status === 409);

/** Zoho busy, a refusal, or the message Books answered a 502 with. */
export const errorReason = (t: TFunction, e: unknown): string =>
  e instanceof ApiError && e.status === 503 ? t('orders.busy')
  : isRefused(e) ? t('orders.parcel.stale')
  : e instanceof Error ? e.message : '';
